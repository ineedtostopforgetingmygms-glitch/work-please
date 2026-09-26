// Remembers every log a player places, so villagers know it isn't part of a natural tree.
// Stored per 16x16 chunk in world dynamic properties so lookups stay cheap.
import { world } from "@minecraft/server";
import { LOGS, WORLD_DP_PLACED_PREFIX } from "./config.js";

const cache = new Map(); // property key -> Set("x,y,z")

function propKey(dimId, p) {
  const d = dimId.replace("minecraft:", "");
  return `${WORLD_DP_PLACED_PREFIX}${d}:${p.x >> 4}:${p.z >> 4}`;
}

function load(key) {
  let set = cache.get(key);
  if (!set) {
    let raw;
    try {
      raw = world.getDynamicProperty(key);
    } catch {}
    set = new Set(typeof raw === "string" && raw ? raw.split(";") : []);
    cache.set(key, set);
  }
  return set;
}

function save(key, set) {
  world.setDynamicProperty(key, set.size ? [...set].join(";") : undefined);
}

export function markPlaced(dimId, p) {
  const key = propKey(dimId, p);
  const set = load(key);
  const entry = `${p.x},${p.y},${p.z}`;
  if (set.has(entry)) return;
  set.add(entry);
  save(key, set);
}

export function unmarkPlaced(dimId, p) {
  const key = propKey(dimId, p);
  const set = load(key);
  if (set.delete(`${p.x},${p.y},${p.z}`)) save(key, set);
}

export function isPlayerPlaced(dimId, p) {
  return load(propKey(dimId, p)).has(`${p.x},${p.y},${p.z}`);
}

export function registerPlacedTracking() {
  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    const b = ev.block;
    if (LOGS.has(b.typeId)) markPlaced(b.dimension.id, b.location);
  });
  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    if (LOGS.has(ev.brokenBlockPermutation.type.id)) unmarkPlaced(ev.block.dimension.id, ev.block.location);
  });
}
