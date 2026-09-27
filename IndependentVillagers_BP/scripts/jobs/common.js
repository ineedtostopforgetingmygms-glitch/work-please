// Helpers shared by every job: walking home and finding the chests that belong to a job block.
// (Crafting tables, chest spots and making room for them live in workshop.js.)
import { ItemStack } from "@minecraft/server";
import { CFG, LOGS } from "../config.js";
import { setState, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { navTo, navUpdate } from "../nav.js";
import { findStockpiles, removeStockpile } from "../registry.js";
import { followRoute, startExit } from "./mineroute.js";
import { center, dist, floorPos, getBlock, getInventory, horizDist, isPassable, isStandable, offset, ringOffsets } from "../util.js";
import { pillarUp } from "../actions.js";
import { vAdd, vCount, vTake } from "../inventory.js";

export function isNearHome(villager, pos, radius = 2.5) {
  return horizDist(villager.location, center(pos)) <= radius && Math.abs(villager.location.y - pos.y) <= 1.5;
}

/** A standable spot next to a block (closest to the villager), skipping any in `bad` ("x,y,z"). */
export function spotNextTo(dim, pos, villager, maxR = 2, bad = undefined) {
  const spots = [];
  for (const o of ringOffsets(1, maxR, [0, -1, 1])) {
    const p = offset(pos, o.x, o.y, o.z);
    if (bad?.has(`${p.x},${p.y},${p.z}`)) continue;
    if (isStandable(dim, p)) spots.push(p);
    if (spots.length >= 8) break;
  }
  spots.sort((a, b) => dist(center(a), villager.location) - dist(center(b), villager.location));
  return spots[0];
}

/**
 * Walks to a spot next to `pos`. Returns "arrived" | "moving" | "failed".
 * He always walks: when there's no way to one spot beside it he tries another, and when he can't
 * get right up to it he goes as close as he can and has another go from there. Only after all of
 * that does it come back "failed" (and the caller carries on from wherever he's got to).
 */
export function walkTo(villager, dim, brain, now, pos, { radius = 0.9 } = {}) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  if (brain.walk?.key !== key) brain.walk = { key, bad: new Set(), fails: 0 };
  const w = brain.walk;
  // down a mine and heading up top: out by the stairs first
  if (brain.route?.exit) {
    const r = followRoute(villager, dim, brain, now);
    if (r === "moving") return "moving";
    brain.route = null;
  } else if (!brain.nav && !w.exitChecked) {
    w.exitChecked = true;
    if (startExit(villager, dim, brain, pos)) return "moving";
  }
  if (!brain.nav) {
    if (isNearHome(villager, pos)) {
      brain.walk = null;
      return "arrived";
    }
    // stuck down a hole with no way out on foot: climb out the way a player would
    if (w.fails >= 2 && climbOut(villager, dim)) {
      w.fails--;
      return "moving";
    }
    if (w.fails >= WALK_TRIES) {
      debugLog(villager, `can't find a way to ${pos.x} ${pos.y} ${pos.z} - giving up for now`);
      brain.walk = null;
      return "failed";
    }
    const spot = spotNextTo(dim, pos, villager, 2, w.bad);
    if (!spot) {
      w.fails = WALK_TRIES;
      return "moving";
    }
    brain.walkSpot = spot;
    if (!navTo(villager, brain, spot, { radius, partial: true })) {
      w.bad.add(`${spot.x},${spot.y},${spot.z}`);
      w.fails++;
      return "moving";
    }
  }
  const r = navUpdate(villager, brain, now);
  if (r === "moving") return "moving";
  if (r === "failed") {
    const s = brain.walkSpot;
    if (s) w.bad.add(`${s.x},${s.y},${s.z}`);
    w.fails++;
    return "moving";
  }
  // at the end of the route - but that may only have been as close as he could get
  if (isNearHome(villager, pos)) {
    brain.walk = null;
    return "arrived";
  }
  w.fails++;
  return "moving";
}

const WALK_TRIES = 5;

// what he'll put under his feet to climb out of a hole
const CLIMB_BLOCKS = ["minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:dirt", "minecraft:andesite", "minecraft:diorite", "minecraft:granite", ...LOGS];

/**
 * Down a pit (no spot round him he can step or hop to): jumps and puts a block under himself.
 * True if he did.
 */
function climbOut(villager, dim) {
  const f = floorPos(villager.location);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [1, 0, -1, -2]) if (isStandable(dim, offset(f, dx, dy, dz))) return false;
  }
  const inv = getInventory(villager);
  const id = CLIMB_BLOCKS.find((b) => vCount(inv, (x) => x === b) > 0);
  if (!id || !isPassable(getBlock(dim, offset(f, 0, 2, 0)))) return false;
  vTake(inv, (x) => x === id, 1);
  debugLog(villager, `stuck in a hole at ${f.x} ${f.y} ${f.z} - climbing out`);
  pillarUp(villager, dim, id, () => vAdd(inv, new ItemStack(id, 1)));
  return true;
}

/** Registered chests of `kind` near `pos`: [{block, container, entry}] (drops entries whose chest is gone). */
export function stockpileChests(dim, pos, kind, radius = CFG.STOCKPILE_RADIUS) {
  const out = [];
  for (const s of findStockpiles(dim.id, pos, radius, kind)) {
    const block = getBlock(dim, s);
    if (!block) continue;
    if (block.typeId !== "minecraft:chest") {
      removeStockpile(dim.id, s);
      continue;
    }
    const container = block.getComponent("minecraft:inventory")?.container;
    if (container) out.push({ block, container, entry: s });
  }
  return out;
}

export { setState, sleep };
