// Unemployed villagers wander and look for a free workstation block to claim - and if the village
// hasn't got one going spare, they make their own: a villager who's been out of work for a while
// goes and cuts four logs, finds a crafting table (or makes one) and puts up a Woodcutter's Bench.
import { world } from "@minecraft/server";
import { CFG, LOGS, PROFESSION_INFO, Profession } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { claimOwner } from "../registry.js";
import { vCount, vTake } from "../inventory.js";
import { canSee, center, floorPos, getBlock, getInventory, isValid, offset, particle, playSound, ringOffsets } from "../util.js";
import { employ, getWorkstation } from "./employment.js";
import { goIndoors, goToBed, hideState, sleepState } from "./rest.js";
import { putDown, useBench } from "./workshop.js";
import { fetchWood, woodState } from "./wood.js";

// workstation block id -> profession
const WORKSTATIONS = {};
for (const [prof, info] of Object.entries(PROFESSION_INFO)) {
  for (const block of info.workstation ?? []) WORKSTATIONS[block] = Number(prof);
}

const BENCH = PROFESSION_INFO[Profession.LUMBERJACK].workstation[0];
const isLog = (id) => LOGS.has(id);

export function unemployedThink(villager, dim, brain, now) {
  // no job, but he still goes to bed at night and indoors when the bell rings
  if (brain.state === "sleep") return sleepState(villager, dim, brain, now, undefined, "jobless");
  if (brain.state === "hide") return hideState(villager, dim, brain, now, undefined, "jobless");
  if (goIndoors(villager, dim, brain, now) || goToBed(villager, dim, brain, now)) return;
  if (brain.state === "wood") return woodState(villager, dim, brain, now, undefined);
  if (brain.state === "bench") return buildBench(villager, dim, brain, now);
  if (brain.state !== "jobless") setState(villager, brain, "jobless");
  setMode(villager, brain, "wander");
  setWorking(villager, false);
  sleep(brain, CFG.THINK_IDLE);

  if (now < brain.nextJobScan) return;
  brain.nextJobScan = now + CFG.JOB_SCAN_EVERY + Math.floor(Math.random() * 20);

  const found = findFreeWorkstation(dim, villager, villager.location);
  if (found) return employ(villager, dim, brain, found.pos, found.profession);
  brain.joblessSince ??= now;
  selfEmploy(villager, dim, brain, now);
}

/** The nearest free job block he can actually see - not one through the wall of a house. */
function findFreeWorkstation(dim, villager, location) {
  const o = floorPos(location);
  const r = CFG.JOB_SCAN_RADIUS;
  let best;
  let bestD = Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const d = dx * dx + dz * dz + dy * dy;
        if (d >= bestD) continue;
        const pos = { x: o.x + dx, y: o.y + dy, z: o.z + dz };
        const block = getBlock(dim, pos);
        if (!block) continue;
        const profession = WORKSTATIONS[block.typeId];
        if (profession === undefined || !isFree(dim, pos)) continue;
        if (!canSee(dim, villager, pos)) continue; // he has to be able to see it from here
        best = { pos, profession };
        bestD = d;
      }
    }
  }
  return best;
}

function isFree(dim, pos) {
  const owner = claimOwner(dim.id, pos);
  if (!owner) return true;
  const entity = world.getEntity(owner);
  if (!entity || !isValid(entity)) return false; // owner may just be in an unloaded chunk
  const ws = getWorkstation(entity);
  // stale claim: the owner has since moved on to another workstation
  return !ws || ws.d !== dim.id || ws.x !== pos.x || ws.y !== pos.y || ws.z !== pos.z;
}

// ---------------------------------------------------------------- making his own job

const BENCH_LOOK = ringOffsets(0, 8, [0, 1, -1, 2, -2]);

/** Somebody's Woodcutter's Bench already standing about here - one per corner of the village is plenty. */
function benchNearby(dim, from) {
  for (const o of BENCH_LOOK) {
    if (getBlock(dim, offset(from, o.x, o.y, o.z))?.typeId === BENCH) return true;
  }
  return false;
}

/** Nobody's hiring: he sets himself up as a lumberjack. */
function selfEmploy(villager, dim, brain, now) {
  if (!CFG.SELF_EMPLOY) return;
  if (now - brain.joblessSince < CFG.SELF_EMPLOY_AFTER) return;
  if ((brain.noBenchUntil ?? 0) > now) return;
  const here = floorPos(villager.location);
  if (benchNearby(dim, here)) {
    brain.noBenchUntil = now + CFG.SELF_EMPLOY_RETRY; // there's one here already, just not free
    return;
  }
  const inv = getInventory(villager);
  if (vCount(inv, isLog) < CFG.BENCH_COST_LOGS + 1) {
    // +1 log in case he has to make the crafting table as well
    // nobody sells work to the unemployed: no waiting on the market for this one
    if (!fetchWood(villager, brain, CFG.BENCH_COST_LOGS + 1, "bench", now, 0)) brain.noBenchUntil = now + CFG.SELF_EMPLOY_RETRY;
    return;
  }
  debugLog(villager, "no job going anywhere - he'll set up his own woodcutter's bench");
  setState(villager, brain, "bench");
}

function buildBench(villager, dim, brain, now) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  const giveUp = (why) => {
    debugLog(villager, `couldn't set up his own bench: ${why}`);
    brain.noBenchUntil = now + CFG.SELF_EMPLOY_RETRY;
    brain.joblessSince = now;
    setState(villager, brain, "jobless");
  };
  if (vCount(inv, isLog) < CFG.BENCH_COST_LOGS) return giveUp("not enough wood");

  // he needs a crafting table for it (4 logs into a bench) - the village's, or one of his own
  const here = floorPos(villager.location);
  const table = useBench(villager, dim, brain, now, here, () => vTake(inv, isLog, 1).length === 1);
  if (table === "busy") return sleep(brain, 6);
  if (!table) return giveUp("no crafting table and no room for one");
  if (vCount(inv, isLog) < CFG.BENCH_COST_LOGS) return giveUp("the crafting table took his last logs");

  const spot = putDown(villager, dim, brain, now, table, BENCH, "use.wood");
  if (spot === "busy") return sleep(brain, 4);
  if (!spot) return giveUp("nowhere to stand it");
  vTake(inv, isLog, CFG.BENCH_COST_LOGS);
  playSound(dim, "dig.wood", center(spot), 1.4);
  particle(dim, "minecraft:villager_happy", offset(center(spot), 0, 0.8, 0));
  debugLog(villager, `made himself a woodcutter's bench at ${spot.x} ${spot.y} ${spot.z}`);
  employ(villager, dim, brain, spot, Profession.LUMBERJACK);
}
