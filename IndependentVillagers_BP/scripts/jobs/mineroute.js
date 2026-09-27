// Getting about a mine: down the stairs, along the corridors and into a branch - and back up and
// out again - one junction at a time, so every hop is a short, easy walk. On the way he looks after
// the place: a hole in the stairs (a creeper, a floor block he dug for ore, a cave-in) gets filled
// with cobblestone, and anything that's fallen into the tunnel (gravel, sand) gets dug out again,
// so the way back up is always there.
import { CFG } from "../config.js";
import { setWorking } from "../brain.js";
import { debugLog } from "../debug.js";
import { ItemStack } from "@minecraft/server";
import { getTool, pillarUp, placeBlock, startBreak, updateBreak, wearTool } from "../actions.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { vAdd, vTake } from "../inventory.js";
import { canUse, center, dist, getBlock, getInventory, horizDist, isPassable } from "../util.js";
import { floorCells, locate, mineById, minesNear, route, sliceCells } from "./mines.js";

// what he patches holes with, best first
const FILLERS = ["minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:andesite", "minecraft:diorite", "minecraft:granite", "minecraft:tuff", "minecraft:dirt", "minecraft:stone"];
const isFiller = (id) => FILLERS.includes(id);
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;

/**
 * Plans a walk through `mine` to slice `bi` of segment `b` (-1: the entrance), from wherever he is
 * (in the mine, or outside it). Returns false if there's nothing to walk.
 */
export function planRoute(villager, brain, mine, b, bi, { exit = false } = {}) {
  const here = locate(mine, villager.location);
  const stops = here ? route(mine, here.n, here.i, b, bi) : route(mine, -1, 0, b, bi);
  if (!stops.length) return false;
  brain.route = { mine: mine.id, stops, k: 0, fails: 0, exit, checked: new Set(), to: `${b}:${bi}` };
  return true;
}

/** Is the route he's on already heading there? */
export function routeTo(brain, b, bi) {
  return brain.route?.to === `${b}:${bi}`;
}

/**
 * One step of the walk. "moving" while he's on his way (or fixing the way), "arrived" at the end,
 * "failed" if he can't get through.
 */
export function followRoute(villager, dim, brain, now) {
  const R = brain.route;
  if (!R) return "arrived";
  const mine = mineById(R.mine);
  if (!mine) {
    brain.route = null;
    return "failed";
  }
  // a block he's digging out of the way
  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return "moving";
    if (r === "done") wearTool(villager, "pickaxe");
    setWorking(villager, false);
    return "moving";
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return "moving";
    if (r === "failed") {
      R.fails++;
      R.checked.clear(); // look for what's in the way
    }
  }
  const loc = villager.location;
  while (R.k < R.stops.length) {
    const s = R.stops[R.k].p;
    if (horizDist(loc, center(s)) <= 1.1 && Math.abs(loc.y - s.y) < 0.9) {
      R.k++;
      R.fails = 0;
    } else break;
  }
  if (R.k >= R.stops.length) {
    brain.route = null;
    return "arrived";
  }
  if (R.fails >= 4) {
    debugLog(villager, `can't get through the mine to ${fmt(R.stops[R.k].p)}`);
    brain.route = null;
    return "failed";
  }
  const stop = R.stops[R.k];
  const prev = R.k > 0 ? R.stops[R.k - 1] : undefined;
  if (repairStep(villager, dim, brain, mine, prev, stop)) return "moving";
  if (!navTo(villager, brain, stop.p, { radius: 0.7, partial: true })) R.fails++;
  return "moving";
}

/**
 * If he's in a mine and `dest` is up top, starts the walk out (so he takes the stairs, not a
 * search through solid rock). True if he's now walking out.
 */
export function startExit(villager, dim, brain, dest) {
  if (villager.location.y > dest.y - 3) return false;
  for (const mine of minesNear(dim.id, villager.location)) {
    const here = locate(mine, villager.location);
    if (!here) continue;
    brain.route = { mine: mine.id, stops: route(mine, here.n, here.i, 0, -1), k: 0, fails: 0, exit: true, checked: new Set(), to: "0:-1" };
    debugLog(villager, "heading up out of the mine");
    return true;
  }
  return false;
}

/** The slices between two stops, in the order he walks them. */
function slicesBetween(mine, a, b) {
  const out = [];
  const bi = Math.max(0, b.i); // (-1 is the top of the stairs: slice 0 is the last one to check)
  if (a && a.n === b.n) {
    const ai = Math.max(0, a.i);
    const step = bi >= ai ? 1 : -1;
    for (let i = ai; i !== bi + step; i += step) out.push({ n: b.n, i });
  } else out.push({ n: b.n, i: bi });
  return out;
}

/**
 * Checks the stretch between two stops for damage and fixes the first thing he finds: a hole in
 * the floor (filled from the bottom up) or a block in the way (dug out). True if he's busy with it.
 */
function repairStep(villager, dim, brain, mine, from, to) {
  const R = brain.route;
  for (const { n, i } of slicesBetween(mine, from, to)) {
    const key = `${n}:${i}`;
    if (R.checked.has(key)) continue;
    const seg = mine.segs[n];
    if (!seg || i >= (seg.done ? seg.len : seg.i)) {
      R.checked.add(key);
      continue;
    }
    // something in the way (not water or lava - he leaves that well alone)
    for (const p of sliceCells(seg, i)) {
      const b = getBlock(dim, p);
      if (!b || isPassable(b) || b.isLiquid || /bedrock|chest|furnace|torch/.test(b.typeId)) continue;
      return fixAt(villager, dim, brain, p, key, () => {
        const pick = getTool(villager, "pickaxe");
        debugLog(villager, `${b.typeId.replace("minecraft:", "")} blocking the mine at ${fmt(p)} - digging it out`);
        startBreak(brain, b, pick);
        setWorking(villager, true);
      });
    }
    // a hole in the floor
    for (const f of floorCells(seg, i)) {
      const b = getBlock(dim, f);
      if (!b || !(isPassable(b) || b.isLiquid)) continue;
      // fill from the bottom: find how deep it goes (up to 3)
      let bottom = f;
      for (let d = 1; d <= 3; d++) {
        const q = { x: f.x, y: f.y - d, z: f.z };
        const qb = getBlock(dim, q);
        if (!qb || !(isPassable(qb) || qb.isLiquid)) break;
        bottom = q;
      }
      const inv = getInventory(villager);
      const filler = FILLERS.find((id) => inv && countOf(inv, id) > 0);
      if (!filler) {
        R.checked.add(key); // nothing to fill it with - he'll just have to step round it
        break;
      }
      return fixAt(
        villager,
        dim,
        brain,
        bottom,
        key,
        () => {
          vTake(inv, (id) => id === filler, 1);
          if (placeBlock(villager, dim, bottom, filler, "use.stone")) debugLog(villager, `patched a hole in the mine floor at ${fmt(bottom)}`);
        },
        () => {
          vTake(inv, (id) => id === filler, 1);
          debugLog(villager, `standing in a hole in the mine floor at ${fmt(bottom)} - filling it in under himself`);
          pillarUp(villager, dim, filler, () => vAdd(inv, new ItemStack(filler, 1)));
        }
      );
    }
    R.checked.add(key);
  }
  return false;
}

function countOf(inv, id) {
  let n = 0;
  for (let s = 0; s < 18; s++) {
    const it = inv.getItem(s);
    if (it?.typeId === id) n += it.amount;
  }
  return n;
}

/** Does `fix` if he can reach the spot from here, otherwise walks up close to it first. */
function fixAt(villager, dim, brain, p, key, fix, pillar = undefined) {
  // it's the very hole he's standing in: jump and fill it under himself
  const feet = { x: Math.floor(villager.location.x), y: Math.floor(villager.location.y), z: Math.floor(villager.location.z) };
  if (pillar && feet.x === p.x && feet.y === p.y && feet.z === p.z) {
    navStop(villager, brain);
    pillar();
    return true;
  }
  if (canUse(dim, villager, p)) {
    navStop(villager, brain);
    brain.route.fixTries = 0;
    fix();
    return true;
  }
  // walk to the nearest intact floor he can reach it from
  const R = brain.route;
  R.fixTries = (R.fixTries ?? 0) + 1;
  if (R.fixTries > 6) {
    R.checked.add(key); // can't get at it - leave it and hope the way round works
    R.fixTries = 0;
    return false;
  }
  const near = [0, 1, 2, 3]
    .flatMap((r) => [
      { x: p.x + r, y: p.y + 1, z: p.z },
      { x: p.x - r, y: p.y + 1, z: p.z },
      { x: p.x, y: p.y + 1, z: p.z + r },
      { x: p.x, y: p.y + 1, z: p.z - r },
      { x: p.x + r, y: p.y + 2, z: p.z },
      { x: p.x - r, y: p.y + 2, z: p.z },
      { x: p.x, y: p.y + 2, z: p.z + r },
      { x: p.x, y: p.y + 2, z: p.z - r },
    ])
    .filter((q) => standable(dim, q))
    .sort((a, b) => dist(center(a), villager.location) - dist(center(b), villager.location));
  const spot = near.find((q) => dist({ x: q.x + 0.5, y: q.y + CFG.EYE_HEIGHT, z: q.z + 0.5 }, center(p)) <= CFG.REACH - 0.3);
  if (spot && navTo(villager, brain, spot, { radius: 0.6 })) return true;
  return false;
}

function standable(dim, q) {
  const feet = getBlock(dim, q);
  const head = getBlock(dim, { x: q.x, y: q.y + 1, z: q.z });
  const below = getBlock(dim, { x: q.x, y: q.y - 1, z: q.z });
  return !!feet && !!head && !!below && isPassable(feet) && !feet.isLiquid && isPassable(head) && !isPassable(below) && !below.isLiquid;
}

export { isFiller, FILLERS };
