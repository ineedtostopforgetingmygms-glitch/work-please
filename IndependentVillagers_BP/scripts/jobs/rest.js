// Home life: when night falls every villager finds the nearest free bed and sleeps in it, and
// when somebody rings the village bell they all drop what they're doing and get indoors until
// it's over - like the vanilla villagers do.
//
// Beds are claimed one villager per bed (and remembered on the villager, so he keeps his own).
// Getting there is our own pathfinding, and so is climbing in: the game's own sleep behaviour
// only works for vanilla villagers, so we lay him on the mattress ourselves (iv:sleeping drives
// the lying-down pose in the resource pack) and set the bed's occupied bit like a real sleeper.
import { system, world } from "@minecraft/server";
import { CFG, PROP_SLEEPING, VILLAGER_ID } from "../config.js";
import { getBrain, setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { holdItem } from "../actions.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { center, dist, findStandableNear, floorPos, getBlock, isPassable, isStandable, isValid, offset, posKey, ringOffsets } from "../util.js";
import { walkTo } from "./common.js";
import { goToMarket } from "./market.js";

const DP_BED = "iv:bed"; // {d,x,y,z} - the bed he sleeps in
const BED = /(:|_)bed$/; // Bedrock has one "minecraft:bed" block for every colour
const claims = new Map(); // "dim|x|y|z" -> villager id

/** Late enough that he'd rather be in bed. */
export function isNight() {
  const t = world.getTimeOfDay();
  return t >= CFG.NIGHT.START && t < CFG.NIGHT.END;
}

// ---------------------------------------------------------------- beds

function bedFree(dim, p, villagerId) {
  const owner = claims.get(posKey(dim.id, p));
  if (owner && owner !== villagerId) {
    const other = world.getEntity(owner);
    if (other && isValid(other)) return false;
    claims.delete(posKey(dim.id, p)); // whoever had it is gone
  }
  const b = getBlock(dim, p);
  if (!b || !BED.test(b.typeId)) return false;
  try {
    if (b.permutation.getState("occupied_bit")) return false; // somebody's in it
  } catch {}
  return true;
}

/** The bed he's claimed before, if it's still there and still his. */
function myBed(villager, dim) {
  let b;
  try {
    b = JSON.parse(villager.getDynamicProperty(DP_BED) ?? "null");
  } catch {}
  if (!b || b.d !== dim.id) return undefined;
  const p = { x: b.x, y: b.y, z: b.z };
  const block = getBlock(dim, p);
  if (!block) return p; // chunk not loaded - assume it's still there
  if (!BED.test(block.typeId)) {
    forgetBed(villager, dim, p);
    return undefined;
  }
  claims.set(posKey(dim.id, p), villager.id);
  return p;
}

function forgetBed(villager, dim, p) {
  if (p) claims.delete(posKey(dim.id, p));
  try {
    villager.setDynamicProperty(DP_BED, undefined);
  } catch {}
}

// closest first, so he really does take the nearest free bed
const BED_OFFSETS = ringOffsets(0, CFG.BED.RADIUS, [0, -1, 1, -2, 2, -3, 3, -4, 4]);

/** Looks for a bed a few hundred blocks at a time. Returns a position, "none", or undefined (still looking). */
function stepBedScan(villager, dim, brain, origin) {
  const s = (brain.bedScan ??= { i: 0 });
  const end = Math.min(BED_OFFSETS.length, s.i + CFG.BED.SCAN_PER_THINK);
  for (; s.i < end; s.i++) {
    const o = BED_OFFSETS[s.i];
    const p = { x: origin.x + o.x, y: origin.y + o.y, z: origin.z + o.z };
    const b = getBlock(dim, p);
    if (!b || !BED.test(b.typeId) || !bedFree(dim, p, villager.id)) continue;
    brain.bedScan = null;
    return p;
  }
  if (s.i >= BED_OFFSETS.length) {
    brain.bedScan = null;
    return "none";
  }
  return undefined;
}

/**
 * Walks him to his bed (claiming one first if he hasn't got one).
 * @returns "walking" | "there" | "nobed" | "looking"
 */
function headForBed(villager, dim, brain, now, ws) {
  let bed = brain.bed ?? myBed(villager, dim);
  if (!bed) {
    if ((brain.noBedUntil ?? 0) > now) return "nobed";
    const found = stepBedScan(villager, dim, brain, floorPos(ws ?? villager.location));
    if (found === undefined) return "looking";
    if (found === "none") {
      brain.noBedUntil = now + CFG.BED.RETRY;
      debugLog(villager, "no free bed anywhere near");
      return "nobed";
    }
    bed = found;
    claims.set(posKey(dim.id, bed), villager.id);
    try {
      villager.setDynamicProperty(DP_BED, JSON.stringify({ d: dim.id, x: bed.x, y: bed.y, z: bed.z }));
    } catch {}
    debugLog(villager, `his bed is the one at ${bed.x} ${bed.y} ${bed.z}`);
  }
  brain.bed = bed;

  if (dist(villager.location, center(bed)) <= 2.2) {
    navStop(villager, brain);
    return "there";
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return "walking";
  }
  if (!brain.nav) {
    // beside the bed, not on top of it (you can stand on a mattress, but you can't get into one
    // you're standing on)
    const onBed = (q) => BED.test(getBlock(dim, q)?.typeId ?? "") || BED.test(getBlock(dim, offset(q, 0, -1, 0))?.typeId ?? "");
    const spot = findStandableNear(dim, bed, 2, 2, onBed);
    if (!spot || !navTo(villager, brain, spot, { radius: 1.2 })) {
      brain.tries++;
      if (brain.tries > 6) {
        debugLog(villager, "can't get to his bed - somebody else can have it");
        forgetBed(villager, dim, bed);
        brain.bed = null;
        brain.noBedUntil = now + CFG.BED.RETRY;
      }
      return "walking";
    }
  }
  return "walking";
}

// ---------------------------------------------------------------- shelter

// No bed for him (somebody's in it, or the village is short of beds): he still gets indoors. A
// house is easy to spot from outside - a door with a roof over the floor on one side of it - so he
// walks in there and waits out the night instead of standing in the dark by his job block.
const DOOR = /(_door|fence_gate)$/;
const SHELTER_SPOTS = ringOffsets(1, CFG.SHELTER.RADIUS, [0, 1, -1, 2, -2]);

/** Is this spot under a roof? (Something solid overhead within a house's worth of blocks.) */
function roofed(dim, p) {
  for (let h = 1; h <= 5; h++) {
    const b = getBlock(dim, offset(p, 0, h, 0));
    if (!b) return false;
    if (!isPassable(b) && !b.isLiquid) return true;
  }
  return false;
}

/** The inside of the nearest house: a standable, roofed spot just inside a door. */
function findShelter(dim, origin) {
  for (const o of SHELTER_SPOTS) {
    const d = { x: origin.x + o.x, y: origin.y + o.y, z: origin.z + o.z };
    const b = getBlock(dim, d);
    if (!b || !DOOR.test(b.typeId)) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const inside = offset(d, dx, 0, dz);
      if (!isStandable(dim, inside) || !roofed(dim, inside)) continue;
      // one more step in, if there's room - out of the doorway itself
      const deeper = offset(inside, dx, 0, dz);
      return isStandable(dim, deeper) && roofed(dim, deeper) ? deeper : inside;
    }
  }
  return undefined;
}

/**
 * Gets him under a roof: the inside of the nearest house, or his job block if there's no house
 * about. Returns "walking" | "there" | "nowhere".
 */
function headForShelter(villager, dim, brain, now, ws) {
  if (brain.shelter && !roofed(dim, brain.shelter)) brain.shelter = null;
  if (!brain.shelter && (brain.noShelterUntil ?? 0) <= now) {
    brain.shelter = findShelter(dim, floorPos(ws ?? villager.location));
    if (!brain.shelter) brain.noShelterUntil = now + CFG.SHELTER.RETRY;
    else debugLog(villager, `no bed for him - sheltering in the house at ${brain.shelter.x} ${brain.shelter.y} ${brain.shelter.z}`);
  }
  const spot = brain.shelter;
  if (!spot) return "nowhere";
  if (dist(villager.location, center(spot)) <= 1.4) {
    navStop(villager, brain);
    brain.shelterFails = 0;
    return "there";
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return "walking";
    brain.shelterFails = (brain.shelterFails ?? 0) + 1;
  }
  // can't get in there: close enough counts (in the doorway), otherwise another house next time
  if ((brain.shelterFails ?? 0) >= 3) {
    brain.shelterFails = 0;
    if (dist(villager.location, center(spot)) <= 2.5) return "there";
    brain.shelter = null;
    brain.noShelterUntil = now + CFG.SHELTER.RETRY;
    return "nowhere";
  }
  if (!navTo(villager, brain, spot, { radius: 1.0 })) brain.shelterFails = (brain.shelterFails ?? 0) + 1;
  return "walking";
}

// ---------------------------------------------------------------- climbing in

/** The two halves of a bed: the pillow end and the foot end. */
function bedPair(dim, p) {
  const b = getBlock(dim, p);
  let isHead = false;
  try {
    isHead = b?.permutation.getState("head_piece_bit") === true;
  } catch {}
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const q = offset(p, dx, 0, dz);
    const nb = getBlock(dim, q);
    if (!nb || !BED.test(nb.typeId)) continue;
    let nHead = false;
    try {
      nHead = nb.permutation.getState("head_piece_bit") === true;
    } catch {}
    if (nHead === isHead) continue; // two separate beds next to each other
    return isHead ? { head: p, foot: q } : { head: q, foot: p };
  }
  return { head: p, foot: p };
}

function setOccupied(dim, pair, on) {
  for (const q of [pair.head, pair.foot]) {
    const b = getBlock(dim, q);
    if (!b || !BED.test(b.typeId)) continue;
    try {
      if (b.permutation.getState("occupied_bit") !== on) b.setPermutation(b.permutation.withState("occupied_bit", on));
    } catch {}
  }
}

function setSleeping(villager, on) {
  try {
    if (villager.getProperty(PROP_SLEEPING) !== on) villager.setProperty(PROP_SLEEPING, on);
  } catch {}
}

/** Lies him down on the mattress, head on the pillow, and marks the bed taken. */
function lieDown(villager, dim, brain, bed) {
  const pair = bedPair(dim, bed);
  const spot = {
    x: (pair.head.x + pair.foot.x) / 2 + 0.5,
    y: bed.y + 0.5625, // the height of a mattress
    z: (pair.head.z + pair.foot.z) / 2 + 0.5,
  };
  try {
    villager.teleport(spot, { facingLocation: center(pair.head) });
  } catch {}
  brain.bedPair = pair;
  brain.bedSpot = spot;
  setOccupied(dim, pair, true);
  setSleeping(villager, true);
}

/** Out of bed - whatever got him up (morning, the bell, a zombie). */
export function wakeUp(villager, dim, brain) {
  if (!brain.asleep) {
    setSleeping(villager, false);
    return;
  }
  brain.asleep = false;
  setSleeping(villager, false);
  if (brain.bedPair) setOccupied(dim, brain.bedPair, false);
  const bed = brain.bed ?? brain.bedPair?.foot;
  if (bed) {
    const onBed = (q) => BED.test(getBlock(dim, q)?.typeId ?? "") || BED.test(getBlock(dim, offset(q, 0, -1, 0))?.typeId ?? "");
    const out = findStandableNear(dim, bed, 2, 2, onBed);
    if (out) {
      try {
        villager.teleport(center(out));
      } catch {}
    }
  }
  brain.bedPair = null;
  brain.bedSpot = null;
  brain.mode = null; // he was standing perfectly still - let the next mode take hold
}

/** Called from the main loop: anything that pulled him out of the sleep state gets him up. */
export function wakeIfNeeded(villager, dim, brain) {
  if ((brain.asleep || brain.fresh) && brain.state !== "sleep") wakeUp(villager, dim, brain);
}

// ---------------------------------------------------------------- sleeping

/** Night has fallen: off to bed, whatever he was in the middle of (bar the block he's breaking). */
export function goToBed(villager, dim, brain, now) {
  // ...bar the block he's breaking, or the furnace he's already paid for and is carrying to its spot
  if (brain.state === "sleep" || brain.action || brain.job?.place) return false;
  if (!isNight()) return false;
  navStop(villager, brain);
  brain.job = null;
  setState(villager, brain, "sleep");
  debugLog(villager, "night - off to bed");
  return true;
}

export function sleepState(villager, dim, brain, now, ws, backTo) {
  setWorking(villager, false);
  if (!isNight()) {
    wakeUp(villager, dim, brain);
    setMode(villager, brain, "rest");
    brain.bedScan = null;
    brain.shelter = null;
    debugLog(villager, "morning - back to work");
    return setState(villager, brain, backTo);
  }
  holdItem(villager, undefined);

  // already tucked in: stay put (something pushed him about? back on the mattress)
  if (brain.asleep) {
    const still = brain.bed && getBlock(dim, brain.bed);
    if (still && !BED.test(still.typeId)) {
      // somebody took the bed out from under him
      wakeUp(villager, dim, brain);
      forgetBed(villager, dim, brain.bed);
      brain.bed = null;
      return sleep(brain, 10);
    }
    if (brain.bedSpot && dist(villager.location, brain.bedSpot) > 0.6) {
      try {
        villager.teleport(brain.bedSpot, { facingLocation: center(brain.bedPair.head) });
      } catch {}
    }
    return sleep(brain, 40);
  }

  const r = headForBed(villager, dim, brain, now, ws);
  if (r === "looking") return sleep(brain, 2);
  if (r === "walking") return sleep(brain, 4);
  if (r === "there") {
    setMode(villager, brain, "sleep"); // no AI goals at all now - he lies where we put him
    lieDown(villager, dim, brain, brain.bed);
    brain.asleep = true;
    debugLog(villager, `in bed at ${brain.bed.x} ${brain.bed.y} ${brain.bed.z} - goodnight`);
    return sleep(brain, 40);
  }
  // no bed for him: then at least indoors, out of the dark - failing that, by his job block
  const s = headForShelter(villager, dim, brain, now, ws);
  if (s === "walking") return sleep(brain, 4);
  if (s === "nowhere" && ws) {
    const w = walkTo(villager, dim, brain, now, ws);
    if (w === "moving") return sleep(brain, 10);
  }
  setMode(villager, brain, "rest");
  sleep(brain, 40);
}

// ---------------------------------------------------------------- the bell

/** Somebody rang the bell: everyone nearby gets indoors for a while. */
export function bellRung(dim, pos) {
  const now = system.currentTick;
  let n = 0;
  for (const v of dim.getEntities({ type: VILLAGER_ID, location: pos, maxDistance: CFG.BELL.RADIUS })) {
    const brain = getBrain(v);
    brain.hideUntil = now + CFG.BELL.HIDE;
    brain.wake = 0; // think again right away
    n++;
  }
  if (n) console.warn(`[Independent Villagers] bell at ${pos.x} ${pos.y} ${pos.z}: ${n} villager(s) heading indoors`);
}

world.afterEvents.playerInteractWithBlock?.subscribe((ev) => {
  const block = ev.block;
  if (block?.typeId !== "minecraft:bell") return;
  try {
    bellRung(block.dimension, { x: block.location.x, y: block.location.y, z: block.location.z });
  } catch {}
});

/** The bell is ringing: everything else stops. */
export function goIndoors(villager, dim, brain, now) {
  if (brain.state === "hide" || brain.action || brain.job?.place) return false;
  if ((brain.hideUntil ?? 0) <= now) return false;
  navStop(villager, brain);
  brain.job = null;
  setState(villager, brain, "hide");
  debugLog(villager, "the bell - getting indoors");
  return true;
}

export function hideState(villager, dim, brain, now, ws, backTo) {
  setWorking(villager, false);
  if ((brain.hideUntil ?? 0) <= now) {
    brain.bedScan = null;
    brain.shelter = null;
    debugLog(villager, "all clear - back to work");
    return setState(villager, brain, backTo);
  }
  holdItem(villager, undefined);

  // indoors means his own bed; failing that the nearest house, or his job block
  const r = headForBed(villager, dim, brain, now, ws);
  if (r === "looking") return sleep(brain, 2);
  if (r === "walking") return sleep(brain, 4);
  if (r === "nobed") {
    const s = headForShelter(villager, dim, brain, now, ws);
    if (s === "walking") return sleep(brain, 4);
    if (s === "nowhere" && ws) {
      const w = walkTo(villager, dim, brain, now, ws);
      if (w === "moving") return sleep(brain, 4);
    }
  }
  setMode(villager, brain, "rest");
  sleep(brain, 20);
}

// ---------------------------------------------------------------- what every job calls

/**
 * Everything that comes before the job itself, in order: the bell, bedtime, then his trading
 * hours. True if he's stopped work for one of them.
 */
export function offDuty(villager, dim, brain, now, ws, opts) {
  return (
    goIndoors(villager, dim, brain, now) ||
    goToBed(villager, dim, brain, now) ||
    goToMarket(villager, dim, brain, now, ws, opts)
  );
}
