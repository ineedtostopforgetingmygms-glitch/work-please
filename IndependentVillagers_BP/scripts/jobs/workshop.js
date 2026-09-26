// The workshop a villager builds around his job block: the crafting table he works at, his chests
// and his furnace.
//
// Two things a real person does that villagers didn't:
//   * if the village already has a crafting table, he walks over and uses that one instead of
//     nailing another one together (one bench per village corner, not one per villager)
//   * village houses are cramped, so he looks well beyond arm's reach for a clear spot, walks to it
//     and squashes the grass or flowers standing there - rather than giving up and standing idle
import { system } from "@minecraft/server";
import { CFG, KEEP_CLEAR } from "../config.js";
import { debugLog } from "../debug.js";
import { placeBlock } from "../actions.js";
import { canUse, center, floorPos, getBlock, isPassable, isSolidGround, offset, playSound, posKey, ringOffsets, samePos } from "../util.js";
import { walkTo } from "./common.js";

const TABLE = "minecraft:crafting_table";
const DOORISH = /(_door|fence_gate)$/;

/** Rings around the job block, nearest first, at his own level and a step up or down. */
const SPOTS = ringOffsets(1, CFG.WORK.PLACE_RADIUS, [0, 1, -1]);
const BENCH_SPOTS = ringOffsets(0, CFG.WORK.BENCH_RADIUS, [0, 1, -1, 2, -2]);

// Looking 10 blocks in every direction for a table is a few thousand blocks, and a villager asks
// several times a second whether he has one - so remember the answer for a few seconds.
const benchCache = new Map();
const BENCH_TTL = 100;

/** The nearest crafting table around `pos` - his own or one the village already had. */
export function benchNear(dim, pos, radius = CFG.WORK.BENCH_RADIUS) {
  const key = `${posKey(dim.id, pos)}|${radius}`;
  const now = system.currentTick;
  const seen = benchCache.get(key);
  if (seen && now - seen.at < BENCH_TTL && (!seen.pos || getBlock(dim, seen.pos)?.typeId === TABLE)) return seen.pos;

  let found;
  for (const o of BENCH_SPOTS) {
    if (Math.max(Math.abs(o.x), Math.abs(o.z)) > radius) continue;
    const p = offset(pos, o.x, o.y, o.z);
    if (getBlock(dim, p)?.typeId === TABLE) {
      found = p;
      break;
    }
  }
  if (benchCache.size > 256) benchCache.clear();
  benchCache.set(key, { at: now, pos: found });
  return found;
}

/**
 * Room for a block he wants to put down near `anchor` - not just within arm's reach, so he can
 * make space in a tight village house by walking round the back of it.
 * `forChest` also keeps him from merging into somebody's double chest.
 */
export function placeSpotNear(dim, anchor, villager, { radius = CFG.WORK.PLACE_RADIUS, forChest = false } = {}) {
  const feet = floorPos(villager.location);
  for (const o of SPOTS) {
    if (Math.max(Math.abs(o.x), Math.abs(o.z)) > radius) continue;
    const p = offset(anchor, o.x, o.y, o.z);
    if (samePos(p, feet) || samePos(p, offset(feet, 0, 1, 0))) continue;
    const block = getBlock(dim, p);
    if (!block) continue;
    // air, or something he doesn't mind squashing (grass, a flower, a snow layer)
    if (!block.isAir && (!isPassable(block) || block.isLiquid || KEEP_CLEAR.test(block.typeId))) continue;
    const below = getBlock(dim, offset(p, 0, -1, 0));
    if (!isSolidGround(below) || KEEP_CLEAR.test(below.typeId) || below.typeId === "minecraft:farmland") continue;
    const above = getBlock(dim, offset(p, 0, 1, 0));
    if (!above || (!above.isAir && !isPassable(above))) continue; // chests and tables need headroom
    // never wall up a doorway - that's how a villager locks himself out of his own house
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => getBlock(dim, offset(p, dx, 0, dz)));
    if (sides.some((b) => DOORISH.test(b?.typeId ?? ""))) continue;
    if (forChest && sides.some((b) => b?.typeId === "minecraft:chest")) continue;
    if (dim.getEntities({ location: center(p), maxDistance: 1.2, excludeTypes: ["minecraft:item"] }).length) continue;
    return p;
  }
  return undefined;
}

/**
 * Puts a block down near `anchor`, walking over to the spot first if it's out of reach.
 * @returns "busy" (on his way / just placed it), the position, or undefined (nowhere to put it)
 */
export function putDown(villager, dim, brain, now, anchor, typeId, sound = "use.wood") {
  const key = `${typeId}|${anchor.x},${anchor.y},${anchor.z}`;
  const forChest = typeId === "minecraft:chest";
  if (brain.placeAt?.key !== key) {
    // a chest has to end up close enough to the job block to still count as its stockpile
    const radius = forChest ? CFG.STOCKPILE_RADIUS - 1 : CFG.WORK.PLACE_RADIUS;
    brain.placeAt = { key, spot: placeSpotNear(dim, anchor, villager, { radius, forChest }) };
  }
  const spot = brain.placeAt.spot;
  if (!spot) {
    brain.placeAt = null;
    return undefined;
  }
  if (!canUse(dim, villager, spot)) {
    const r = walkTo(villager, dim, brain, now, spot);
    if (r === "moving") return "busy";
    if (r === "failed") {
      brain.placeAt = null;
      return undefined;
    }
  }
  brain.placeAt = null;
  if (!placeBlock(villager, dim, spot, typeId, sound)) return undefined;
  return spot;
}

/**
 * The crafting table he's going to work at: one that's already there (walking over to it), or a
 * new one he knocks together from a log and stands next to his job block.
 * @returns the table position, "busy" (walking there / just built it), or undefined (can't)
 */
export function useBench(villager, dim, brain, now, ws, takeOneLog) {
  // one within reach of his job block is the one he'd use; failing that, the village's nearest
  const table = benchNear(dim, ws, 3) ?? benchNear(dim, ws) ?? benchNear(dim, floorPos(villager.location), 6);
  if (table) {
    if (canUse(dim, villager, table)) return table;
    const r = walkTo(villager, dim, brain, now, table);
    if (r === "moving") return "busy";
    if (r === "arrived" && canUse(dim, villager, table)) return table;
    return r === "arrived" ? undefined : "busy";
  }

  const spot = placeSpotNear(dim, ws, villager);
  if (!spot) {
    debugLog(villager, "no room anywhere near his job block for a crafting table");
    return undefined;
  }
  if (!canUse(dim, villager, spot)) {
    const r = walkTo(villager, dim, brain, now, spot);
    return r === "moving" || r === "arrived" ? "busy" : undefined;
  }
  if (!takeOneLog()) return undefined;
  if (!placeBlock(villager, dim, spot, TABLE, "use.wood")) return undefined;
  playSound(dim, "dig.wood", center(spot), 1.4);
  debugLog(villager, `made a crafting table and put it at ${spot.x} ${spot.y} ${spot.z}`);
  return "busy";
}

/** Is there a crafting table he can work at without building one? (Whether a log is needed.) */
export function haveBench(dim, ws) {
  return !!benchNear(dim, ws);
}
