// A* path-finding over walkable blocks, run a slice at a time so it never causes a lag spike.
// The vanilla navigator only plans short paths; this finds the long route (around walls, through
// door gaps, up hills) and nav.js then walks it hop by hop.
import { system } from "@minecraft/server";
import { CFG, PASSABLE } from "./config.js";

// ---------------------------------------------------------------- shared block knowledge
// Every search used to ask the game about every block it looked at, and villagers walking about
// the same village asked about the same blocks over and over. Now what a block means for walking
// (open / solid / water) is worked out once and shared by all searches for a few seconds.
const OPEN = 1;
const SOLID = 2;
const WATER = 4;
const CELL_TTL = 60;
const cellMaps = new Map(); // dimId -> Map(key -> {v, t})

function classify(b) {
  if (!b) return 0;
  if (b.isAir) return OPEN;
  const id = b.typeId;
  if (b.isLiquid) return id.includes("lava") ? 0 : WATER;
  if (PASSABLE.test(id)) return OPEN;
  if (id.endsWith("_door") || id.endsWith("fence_gate")) return id.includes("iron") ? 0 : OPEN;
  // can't stand on fences/walls (1.5 high) without jumping - treat as blocked, not as ground
  if (/fence|_wall$/.test(id)) return 0;
  return SOLID;
}

/** A block changed (broken, placed): forget what we knew about it. */
export function invalidateCell(dimId, p) {
  cellMaps.get(dimId)?.delete(key(p.x, p.y, p.z));
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const m of cellMaps.values()) {
    if (m.size < 20000) {
      for (const [k, c] of m) if (now - c.t > CELL_TTL) m.delete(k);
    } else m.clear();
  }
}, 100);

// ---------------------------------------------------------------- a budget for everybody
// Searching is the expensive part of walking. All villagers together get CFG.PATH_TICK_BUDGET
// node expansions a tick; a villager whose turn it isn't just waits a tick for his route.
let budgetTick = -1;
let budgetLeft = 0;
export function takeBudget(want) {
  const now = system.currentTick;
  if (now !== budgetTick) {
    budgetTick = now;
    budgetLeft = CFG.PATH_TICK_BUDGET;
  }
  const n = Math.min(want, budgetLeft);
  budgetLeft -= n;
  return n;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const key = (x, y, z) => `${x},${y},${z}`;

// what a block of water costs on a route, against 1 for a block of dry ground
const WATER_WADE = 8;
const WATER_SWIM = 20;
const CROWD_COST = 4; // a spot another villager is standing on

class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class PathSearch {
  constructor(dim, start, goal, { maxNodes = 8000, maxRange = 56, avoid = undefined } = {}) {
    this.dim = dim;
    this.avoid = avoid; // spots other villagers are standing on: he'd rather go round them
    this.now = system.currentTick;
    if (!cellMaps.has(dim.id)) cellMaps.set(dim.id, new Map());
    this.cells = cellMaps.get(dim.id);
    this.start = start;
    this.goal = goal;
    this.maxNodes = maxNodes;
    this.maxRange = maxRange;
    this.standCache = new Map();
    this.open = new Heap();
    this.best = new Map(); // key -> g
    this.parent = new Map();
    this.expanded = 0;
    this.status = "running";
    this.path = null;
    const s = { x: start.x, y: start.y, z: start.z, g: 0, f: this.h(start.x, start.y, start.z) };
    this.open.push(s);
    this.best.set(key(s.x, s.y, s.z), 0);
    this.closest = s; // for partial paths
  }

  h(x, y, z) {
    const dx = Math.abs(x - this.goal.x);
    const dz = Math.abs(z - this.goal.z);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) + Math.abs(y - this.goal.y) * 0.5;
  }

  /** What this block is for walking (OPEN / SOLID / WATER bits, 0 = in the way or not loaded). */
  cell(x, y, z) {
    const k = key(x, y, z);
    const c = this.cells.get(k);
    if (c && this.now - c.t <= CELL_TTL) return c.v;
    let b;
    try {
      b = this.dim.getBlock({ x, y, z });
    } catch {
      b = undefined;
    }
    const v = classify(b);
    if (b) this.cells.set(k, { v, t: this.now }); // (unloaded chunks aren't remembered)
    return v;
  }

  passable(x, y, z) {
    return (this.cell(x, y, z) & OPEN) !== 0;
  }

  solid(x, y, z) {
    return (this.cell(x, y, z) & SOLID) !== 0;
  }

  /** Shallow water he can wade through (swamps, mangroves, river edges) - never lava. */
  water(x, y, z) {
    return (this.cell(x, y, z) & WATER) !== 0;
  }

  /** Extra cost of standing here: 0 on dry land, a lot in water (and more again out of your depth). */
  wet(x, y, z) {
    if (!this.water(x, y, z)) return 0;
    return this.water(x, y - 1, z) ? WATER_SWIM : WATER_WADE;
  }

  /** Feet space: open, or wading water. */
  feetOk(x, y, z) {
    return this.passable(x, y, z) || this.water(x, y, z);
  }

  standable(x, y, z) {
    const k = key(x, y, z);
    let s = this.standCache.get(k);
    if (s === undefined) {
      // on the ground (feet may be wading), or swimming at the surface of deeper water
      s = this.feetOk(x, y, z) && this.passable(x, y + 1, z) && (this.solid(x, y - 1, z) || (this.water(x, y, z) && this.water(x, y - 1, z)));
      this.standCache.set(k, s);
    }
    return s;
  }

  /** Runs up to `budget` node expansions. Returns "running" | "found" | "failed". */
  step(budget) {
    if (this.status !== "running") return this.status;
    const g0 = this.goal;
    while (budget-- > 0) {
      if (!this.open.size || this.expanded >= this.maxNodes) {
        this.status = "failed";
        return this.status;
      }
      const n = this.open.pop();
      if ((this.best.get(key(n.x, n.y, n.z)) ?? Infinity) < n.g) continue; // stale
      this.expanded++;

      if (n.x === g0.x && n.z === g0.z && Math.abs(n.y - g0.y) <= 1) {
        this.path = this.rebuild(n);
        this.status = "found";
        return this.status;
      }
      if (n.f - n.g < this.closest.f - this.closest.g) this.closest = n;

      for (const [dx, dz] of DIRS) {
        const nx = n.x + dx;
        const nz = n.z + dz;
        if (Math.abs(nx - this.start.x) > this.maxRange || Math.abs(nz - this.start.z) > this.maxRange) continue;
        const diagonal = dx !== 0 && dz !== 0;
        // no corner cutting on diagonals
        if (diagonal && !(this.feetOk(n.x + dx, n.y, n.z) && this.passable(n.x + dx, n.y + 1, n.z) && this.feetOk(n.x, n.y, n.z + dz) && this.passable(n.x, n.y + 1, n.z + dz))) continue;

        // same level, one step up (needs head room to jump), or a drop of up to 3
        for (const dy of [0, 1, -1, -2, -3]) {
          const ny = n.y + dy;
          if (!this.standable(nx, ny, nz)) continue;
          if (dy === 1 && (diagonal || !this.passable(n.x, n.y + 2, n.z))) continue;
          if (dy < 0) {
            // must be able to walk off the edge: the column above the landing spot is clear
            let clear = true;
            for (let y = ny + 2; y <= n.y + 1; y++) if (!this.passable(nx, y, nz)) clear = false;
            if (!clear) continue;
          }
          // villagers keep out of the water: wading costs as much as a long detour, swimming more
          const crowd = this.avoid?.has(key(nx, ny, nz)) ? CROWD_COST : 0; // someone standing there
          const cost = (diagonal ? 1.414 : 1) + (dy > 0 ? 0.6 : dy < 0 ? 0.3 * -dy : 0) + this.wet(nx, ny, nz) + crowd;
          const g = n.g + cost;
          const k = key(nx, ny, nz);
          if (g >= (this.best.get(k) ?? Infinity)) break;
          this.best.set(k, g);
          this.parent.set(k, n);
          this.open.push({ x: nx, y: ny, z: nz, g, f: g + this.h(nx, ny, nz) });
          break; // only the first valid height per column
        }
      }
    }
    return this.status;
  }

  rebuild(n) {
    const out = [];
    let cur = n;
    while (cur) {
      out.push({ x: cur.x, y: cur.y, z: cur.z });
      cur = this.parent.get(key(cur.x, cur.y, cur.z));
    }
    return out.reverse();
  }

  /** Path to the node that got closest to the goal (used when the goal itself is unreachable). */
  partial() {
    return this.rebuild(this.closest);
  }
}
