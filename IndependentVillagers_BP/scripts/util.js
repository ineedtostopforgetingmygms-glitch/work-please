// Small helpers shared by every job.
import { CFG, PASSABLE } from "./config.js";

export function getBlock(dim, pos) {
  try {
    return dim.getBlock(pos);
  } catch {
    return undefined; // unloaded chunk / out of bounds
  }
}

export function posKey(dimId, p) {
  return `${dimId}|${p.x}|${p.y}|${p.z}`;
}

export function samePos(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function floorPos(loc) {
  return { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
}

export function center(p) {
  return { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
}

export function offset(p, dx, dy, dz) {
  return { x: p.x + dx, y: p.y + dy, z: p.z + dz };
}

export function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function horizDist(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function isValid(entity) {
  try {
    return typeof entity.isValid === "function" ? entity.isValid() : !!entity.isValid;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- terrain

export function isPassable(block) {
  return !!block && (block.isAir || PASSABLE.test(block.typeId));
}

export function isSolidGround(block) {
  return !!block && !block.isAir && !block.isLiquid && !PASSABLE.test(block.typeId);
}

/** Feet + head free (feet may be in shallow water) and something solid underneath. */
export function isStandable(dim, p) {
  const feet = getBlock(dim, p);
  if (!feet) return false;
  const wading = feet.isLiquid && !feet.typeId.includes("lava");
  if (!wading && (!isPassable(feet) || feet.isLiquid)) return false;
  if (wading) {
    // swimming at the surface of deeper water counts too (mangrove swamps, rivers)
    const below = getBlock(dim, offset(p, 0, -1, 0));
    const head = getBlock(dim, offset(p, 0, 1, 0));
    if (below?.isLiquid && !below.typeId.includes("lava")) return isPassable(head) && !head.isLiquid;
  }
  if (!isPassable(getBlock(dim, offset(p, 0, 1, 0)))) return false;
  return isSolidGround(getBlock(dim, offset(p, 0, -1, 0)));
}

/** Nearest standable spot to `p`, searching a small box around it. */
export function findStandableNear(dim, p, radius = 2, dyRange = 3, exclude = undefined) {
  let best;
  let bestD = Infinity;
  for (let dy = -dyRange; dy <= dyRange; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const d = dx * dx + dz * dz + dy * dy * 2;
        if (d >= bestD) continue;
        const q = offset(p, dx, dy, dz);
        if (exclude && exclude(q)) continue;
        if (!isStandable(dim, q)) continue;
        best = q;
        bestD = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- entity pose

export function eyePos(entity) {
  const l = entity.location;
  return { x: l.x, y: l.y + CFG.EYE_HEIGHT, z: l.z };
}

/** Turn body + head to look at a point, like a player aiming at a block. */
export function lookAt(entity, point) {
  const eye = eyePos(entity);
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
  const pitch = (-Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI;
  try {
    entity.setRotation({ x: pitch, y: yaw });
  } catch {}
}

/**
 * What does the villager actually see when looking at point `target` (a block centre or any point)?
 * Returns the first solid block on the line from his eyes, or undefined if nothing is hit / unknown.
 * Line of sight is strict: no hit means he can't see it.
 */
export function firstBlockOnLine(dim, entity, target) {
  return raycast(dim, eyePos(entity), target);
}

/**
 * Exact voxel ray walk (Amanatides & Woo) from `a` to `b`: returns the first block on the segment
 * that you can't see through (anything but air/grass/flowers/water...), or undefined if the line is clear.
 * (The built-in getBlockFromRay turned out to miss blocks on angled rays.)
 */
export function raycast(dim, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-6) return undefined;
  let x = Math.floor(a.x);
  let y = Math.floor(a.y);
  let z = Math.floor(a.z);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const sz = Math.sign(dz);
  const tdx = sx ? Math.abs(1 / dx) : Infinity;
  const tdy = sy ? Math.abs(1 / dy) : Infinity;
  const tdz = sz ? Math.abs(1 / dz) : Infinity;
  let tx = sx > 0 ? (x + 1 - a.x) / dx : sx < 0 ? (a.x - x) / -dx : Infinity;
  let ty = sy > 0 ? (y + 1 - a.y) / dy : sy < 0 ? (a.y - y) / -dy : Infinity;
  let tz = sz > 0 ? (z + 1 - a.z) / dz : sz < 0 ? (a.z - z) / -dz : Infinity;
  for (let i = 0; i < 96; i++) {
    let t;
    if (tx <= ty && tx <= tz) {
      t = tx;
      x += sx;
      tx += tdx;
    } else if (ty <= tz) {
      t = ty;
      y += sy;
      ty += tdy;
    } else {
      t = tz;
      z += sz;
      tz += tdz;
    }
    if (t > 1) return undefined; // reached the end point without hitting anything
    const block = getBlock(dim, { x, y, z });
    if (!block) return undefined;
    if (!isPassable(block) && !block.isLiquid) return block;
  }
  return undefined;
}

export function firstBlockInSight(dim, entity, p) {
  return firstBlockOnLine(dim, entity, center(p));
}

/**
 * Can he actually see the block at `p` from where he stands? (Nothing solid in the way - so no
 * using a chest, a workbench or a job block through a wall.) A ray to the middle of a block is
 * easily blocked by its own neighbours, so the faces count as seen too.
 */
export function canSee(dim, entity, p) {
  const hit = firstBlockInSight(dim, entity, p);
  if (!hit || samePos(hit, p)) return true;
  const eye = eyePos(entity);
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
    const face = { x: p.x + 0.5 + dx * 0.48, y: p.y + 0.5 + dy * 0.48, z: p.z + 0.5 + dz * 0.48 };
    const h = raycast(dim, eye, face);
    if (!h || samePos(h, p)) return true;
  }
  return false;
}

/** Close enough to touch it, and able to see it - what a player needs to use a block. */
export function canUse(dim, entity, p, reach = CFG.REACH) {
  return dist(eyePos(entity), center(p)) <= reach && canSee(dim, entity, p);
}

// ---------------------------------------------------------------- containers

export function getInventory(entity) {
  return entity.getComponent("minecraft:inventory")?.container;
}

export function isEmpty(container) {
  return container.emptySlotsCount === container.size;
}

export function countItems(container, predicate, from = 0, to = container.size) {
  let total = 0;
  for (let i = from; i < Math.min(to, container.size); i++) {
    const item = container.getItem(i);
    if (item && predicate(item.typeId)) total += item.amount;
  }
  return total;
}

/**
 * Adds a stack to slots [from, to) only (merging first, then empty slots).
 * Returns the leftover ItemStack, or undefined if everything fit.
 */
export function addToSlots(container, stack, from, to) {
  let left = stack.amount;
  const max = stack.maxAmount;
  for (let pass = 0; pass < 2 && left > 0; pass++) {
    for (let i = from; i < Math.min(to, container.size) && left > 0; i++) {
      const cur = container.getItem(i);
      if (pass === 0) {
        if (!cur || !cur.isStackableWith(stack) || cur.amount >= max) continue;
        const n = Math.min(left, max - cur.amount);
        cur.amount += n;
        container.setItem(i, cur);
        left -= n;
      } else if (!cur) {
        const put = stack.clone();
        put.amount = Math.min(left, max);
        container.setItem(i, put);
        left -= put.amount;
      }
    }
  }
  if (left <= 0) return undefined;
  const rest = stack.clone();
  rest.amount = left;
  return rest;
}

/** Removes up to `amount` matching items. Returns the typeIds removed (one entry per item). */
export function takeItems(container, predicate, amount, from = 0, to = container.size) {
  const taken = [];
  for (let i = from; i < Math.min(to, container.size) && taken.length < amount; i++) {
    const item = container.getItem(i);
    if (!item || !predicate(item.typeId)) continue;
    const take = Math.min(item.amount, amount - taken.length);
    for (let n = 0; n < take; n++) taken.push(item.typeId);
    if (take === item.amount) {
      container.setItem(i);
    } else {
      item.amount -= take;
      container.setItem(i, item);
    }
  }
  return taken;
}

/** Moves matching items from one container to another. Returns true if nothing matching is left. */
export function moveItems(from, to, predicate = () => true) {
  let left = false;
  for (let i = 0; i < from.size; i++) {
    const item = from.getItem(i);
    if (!item || !predicate(item.typeId)) continue;
    const rest = to.addItem(item);
    from.setItem(i, rest);
    if (rest) left = true;
  }
  return !left;
}

export function summarizeItems(container) {
  const totals = new Map();
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (item) totals.set(item.typeId, (totals.get(item.typeId) ?? 0) + item.amount);
  }
  return totals;
}

export function prettyName(typeId) {
  return typeId
    .replace(/^.*:/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------- effects

export function playSound(dim, id, location, pitch = 1) {
  try {
    dim.playSound(id, location, { pitch });
  } catch {}
}

export function particle(dim, id, location) {
  try {
    dim.spawnParticle(id, location);
  } catch {}
}

/** Positions around an origin in rings (closest first). */
export function ringOffsets(minR, maxR, dys) {
  const out = [];
  for (const dy of dys) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      for (let dz = -maxR; dz <= maxR; dz++) {
        const r = Math.max(Math.abs(dx), Math.abs(dz));
        if (r < minR) continue;
        out.push({ x: dx, y: dy, z: dz, d: dx * dx + dz * dz + Math.abs(dy) * 4 });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
