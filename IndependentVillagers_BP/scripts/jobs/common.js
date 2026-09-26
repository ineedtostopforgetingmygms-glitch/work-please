// Helpers shared by every job: walking home and finding the chests that belong to a job block.
// (Crafting tables, chest spots and making room for them live in workshop.js.)
import { CFG } from "../config.js";
import { setMode, setState, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { navTo, navUpdate } from "../nav.js";
import { findStockpiles, removeStockpile } from "../registry.js";
import { center, dist, getBlock, horizDist, isStandable, offset, ringOffsets } from "../util.js";

export function isNearHome(villager, pos, radius = 2.5) {
  return horizDist(villager.location, center(pos)) <= radius && Math.abs(villager.location.y - pos.y) <= 1.5;
}

/** A standable spot next to a block (closest to the villager). */
export function spotNextTo(dim, pos, villager, maxR = 2) {
  const spots = [];
  for (const o of ringOffsets(1, maxR, [0, -1, 1])) {
    const p = offset(pos, o.x, o.y, o.z);
    if (isStandable(dim, p)) spots.push(p);
    if (spots.length >= 8) break;
  }
  spots.sort((a, b) => dist(center(a), villager.location) - dist(center(b), villager.location));
  return spots[0];
}

/**
 * Walks to a spot next to `pos`. Returns "arrived" | "moving" | "failed".
 * Teleports as a last resort after two failed attempts so a villager never gets stranded.
 */
export function walkTo(villager, dim, brain, now, pos, { radius = 0.9, teleport = true } = {}) {
  if (!brain.nav) {
    if (isNearHome(villager, pos)) return "arrived";
    const spot = spotNextTo(dim, pos, villager);
    if (!spot) return "failed";
    brain.walkSpot = spot;
    if (!navTo(villager, brain, spot, { radius })) {
      if (!teleport) return "failed";
      return teleportTo(villager, brain, spot);
    }
  }
  const r = navUpdate(villager, brain, now);
  if (r === "moving") return "moving";
  if (r === "arrived") return "arrived";
  brain.tries++;
  if (teleport && brain.tries >= 2 && brain.walkSpot) return teleportTo(villager, brain, brain.walkSpot);
  return teleport ? "moving" : "failed";
}

function teleportTo(villager, brain, spot) {
  debugLog(villager, "couldn't walk there - teleporting");
  villager.teleport({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 });
  setMode(villager, brain, "rest");
  return "arrived";
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
