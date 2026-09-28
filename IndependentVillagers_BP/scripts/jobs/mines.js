// Shared mines. A mine belongs to the village, not to one miner: every miner whose stonecutter is
// within MINE.SHARE_RADIUS of a mine works that mine, each on his own stretch of tunnel.
//
// Layout (like a player's mine):
//   - a 3 wide, 4 tall spiral staircase: legs of MINE.STAIR_LEG steps, turning at a little landing
//   - levels where the staircase stops: the coal level (MINE.COAL_DEPTH under the stonecutter),
//     the iron level (y = MINE.IRON_Y) and the diamond level (y = MINE.DIAMOND_Y)
//   - at each level, 3x3 main corridors off the landing, with 1x2 branch tunnels every
//     MINE.BRANCH_EVERY blocks down both sides of them (branch mining: every block between two
//     branches is looked at, and ore is dug out of the walls)
// One miner at a time digs the staircase deeper; the others dig branches on the levels already
// reached. Segments never run into each other: there's always at least a block of rock between.
//
//   mine = { id, v: 2, d, x, y, z, levels: [{n, y, hub}], bottom, segs: [seg], bad, done }
//   seg  = { k: "stair"|"main"|"branch", p (parent index), at (slice of the parent it starts
//            from), side, lvl, ox, oy, oz, dx, dz, len, drop, w, h, i, owner, seen, done }
import { world } from "@minecraft/server";
import { DP_MINE, MINE } from "../config.js";
import { horizDist } from "../util.js";

const WORLD_DP_MINES = "iv:mines"; // list of mine ids (each mine is kept under iv:mine_<id>)
const DP_MINE_ID = "iv:mineid";
const OWNER_TIMEOUT = 20 * 60 * 3; // a tunnel whose miner hasn't touched it for this long is up for grabs

let mines;
const CHUNK = 30000; // a dynamic property holds at most 32767 characters: a big mine is kept in parts

function readMine(id) {
  const head = world.getDynamicProperty(`iv:mine_${id}`);
  if (typeof head !== "string") return undefined;
  let json = head;
  if (head.startsWith("#parts:")) {
    json = "";
    const n = Number(head.slice(7));
    for (let i = 0; i < n; i++) json += world.getDynamicProperty(`iv:mine_${id}_${i}`) ?? "";
  }
  return JSON.parse(json);
}

function writeMine(m) {
  const json = JSON.stringify(m);
  if (json.length <= CHUNK) {
    world.setDynamicProperty(`iv:mine_${m.id}`, json);
    return;
  }
  const n = Math.ceil(json.length / CHUNK);
  for (let i = 0; i < n; i++) world.setDynamicProperty(`iv:mine_${m.id}_${i}`, json.slice(i * CHUNK, (i + 1) * CHUNK));
  world.setDynamicProperty(`iv:mine_${m.id}`, `#parts:${n}`);
}

function all() {
  if (mines) return mines;
  mines = [];
  let ids = [];
  try {
    ids = JSON.parse(world.getDynamicProperty(WORLD_DP_MINES) ?? "[]");
  } catch {}
  let migrated = false;
  for (const entry of ids) {
    try {
      if (typeof entry === "string") {
        const m = readMine(entry);
        if (m?.v === 2) mines.push(m);
      } else if (entry?.segs) {
        // a mine from before v1.10 (kept whole in this list): carried on as a proper deep mine
        // rather than left behind while the miners dig a new one next to it
        mines.push(migrateOld(entry));
        migrated = true;
      }
    } catch {}
  }
  if (migrated) saveMines();
  return mines;
}

/** Saves one mine (or all of them). */
export function saveMines(mine) {
  try {
    world.setDynamicProperty(WORLD_DP_MINES, JSON.stringify(all().map((m) => m.id)));
    for (const m of mine ? [mine] : all()) writeMine(m);
  } catch {}
}

/**
 * An old mine (a 3x4 staircase 12 deep, then level 3x4 tunnels) in the new layout: the staircase
 * becomes the first leg down to the coal level, the tunnels become that level's corridors, and the
 * stairs carry on down to the iron level from where the old ones stopped.
 */
function migrateOld(old) {
  const ws = { x: old.x, y: old.y, z: old.z };
  const levels = levelsFor(old.d, ws);
  const segs = [];
  const dug = (s) => (s.done ? s.len : s.i ?? 0);
  const at = (x, y, z) => {
    for (let n = 0; n < segs.length; n++) {
      const s = segs[n];
      for (let i = 0; i < s.len; i++) {
        const c = sliceCenter(s, i);
        if (c.x === x && c.z === z && Math.abs(c.y - y) <= 1) return { n, i };
      }
    }
    return undefined;
  };
  for (const s of old.segs ?? []) {
    const d = dug(s);
    if (s.descend) {
      const stairLen = Math.max(1, Math.min(s.done ? s.len : 13, 13));
      segs.push({ k: "stair", p: -1, at: 0, ox: s.ox, oy: s.oy, oz: s.oz, dx: s.dx, dz: s.dz, len: stairLen, drop: 1, w: 3, h: 4, i: Math.min(d, stairLen), seen: 0, done: d >= stairLen });
      const coal = levels.find((l) => l.n === "coal");
      if (coal) coal.y = s.oy - (stairLen - 1);
      if (s.len > 13) {
        segs.push({ k: "main", p: segs.length - 1, at: 12, lvl: "coal", ox: s.ox + s.dx * 13, oy: s.oy - 12, oz: s.oz + s.dz * 13, dx: s.dx, dz: s.dz, len: s.len - 13, drop: 0, w: 3, h: 4, i: Math.max(0, d - 13), seen: 0, done: !!s.done || d >= s.len });
      }
    } else {
      const par = at(s.ox - s.dx * 2, s.oy, s.oz - s.dz * 2) ?? { n: 0, i: Math.max(0, (segs[0]?.len ?? 1) - 1) };
      segs.push({ k: "main", p: par.n, at: par.i, lvl: "coal", ox: s.ox, oy: s.oy, oz: s.oz, dx: s.dx, dz: s.dz, len: s.len, drop: 0, w: 3, h: 4, i: d, seen: 0, done: !!s.done || d >= s.len });
    }
  }
  const mine = { id: old.id ?? `m${Date.now().toString(36)}`, v: 2, d: old.d, x: ws.x, y: ws.y, z: ws.z, levels, segs, bad: old.bad ?? [], done: false };
  if (segs[0]?.done) afterStairLeg(mine, 0);
  return mine;
}

// ---------------------------------------------------------------- geometry

export function sliceFloorY(seg, i) {
  return seg.oy - (seg.drop ? Math.max(0, i) : 0);
}

export function sliceCenter(seg, i) {
  return { x: seg.ox + seg.dx * i, y: sliceFloorY(seg, i), z: seg.oz + seg.dz * i };
}

/** Where he stands to dig slice i: the slice before it (for slice 0, the parent's cell). */
export function standFor(seg, i) {
  if (i > 0) return sliceCenter(seg, i - 1);
  return { x: seg.ox - seg.dx, y: seg.oy, z: seg.oz - seg.dz };
}

/** The w x h blocks of slice i, top row first, middle column first. */
export function sliceCells(seg, i) {
  const c = sliceCenter(seg, i);
  const px = -seg.dz;
  const pz = seg.dx;
  const half = (seg.w - 1) / 2;
  const cols = [0];
  for (let k = 1; k <= half; k++) cols.push(-k, k);
  const out = [];
  for (let h = seg.h - 1; h >= 0; h--) for (const w of cols) out.push({ x: c.x + px * w, y: c.y + h, z: c.z + pz * w });
  return out;
}

/** The blocks he walks on in slice i (under each column). */
export function floorCells(seg, i) {
  const c = sliceCenter(seg, i);
  const half = (seg.w - 1) / 2;
  const out = [];
  for (let w = -half; w <= half; w++) out.push({ x: c.x - seg.dz * w, y: c.y - 1, z: c.z + seg.dx * w });
  return out;
}

function sliceBox(seg, i) {
  const c = sliceCenter(seg, i);
  const half = (seg.w - 1) / 2;
  const hx = Math.abs(seg.dz) * half;
  const hz = Math.abs(seg.dx) * half;
  return { x0: c.x - hx, x1: c.x + hx, y0: c.y, y1: c.y + seg.h - 1, z0: c.z - hz, z1: c.z + hz };
}

const touches = (a, b, m) => a.x0 - m <= b.x1 && a.x1 + m >= b.x0 && a.y0 - m <= b.y1 && a.y1 + m >= b.y0 && a.z0 - m <= b.z1 && a.z1 + m >= b.z0;

/**
 * Would this new segment run into (or right up against) any other? At least one block of rock
 * has to stay between tunnels - except where it opens off its parent: its first couple of slices
 * may touch the parent's slices round the junction, the other tunnels opening off the same spot,
 * and the landing the parent itself started from.
 */
function overlaps(mine, seg) {
  const parent = seg.p >= 0 ? mine.segs[seg.p] : undefined;
  for (let k = 0; k < seg.len; k++) {
    const box = sliceBox(seg, k);
    for (let n = 0; n < mine.segs.length; n++) {
      const e = mine.segs[n];
      const len = e.done ? e.len : Math.max(e.len, e.i);
      for (let m = 0; m < len; m++) {
        if (k < 2) {
          if (n === seg.p && Math.abs(m - seg.at) <= 2) continue; // the junction itself
          if (e.p === seg.p && Math.abs((e.at ?? 0) - seg.at) <= 1 && m < 2) continue; // opens off the same spot
          if (parent && n === parent.p && m >= len - 2) continue; // the landing before
        }
        if (touches(box, sliceBox(e, m), 1)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- levels

/** The levels a mine from this stonecutter works, deepest last. */
export function levelsFor(dimId, ws) {
  const out = [];
  const coal = ws.y - MINE.COAL_DEPTH;
  const overworld = dimId === "minecraft:overworld";
  if (!overworld || coal >= MINE.IRON_Y + MINE.MIN_LEVEL_GAP) out.push({ n: "coal", y: coal });
  if (overworld && ws.y - MINE.IRON_Y >= MINE.MIN_LEVEL_GAP) {
    out.push({ n: "iron", y: MINE.IRON_Y });
    out.push({ n: "diamond", y: MINE.DIAMOND_Y });
  }
  if (!out.length) out.push({ n: "coal", y: Math.max(ws.y - 6, MINE.DIAMOND_Y) });
  return out;
}

export function levelNamed(mine, name) {
  return mine.levels.find((l) => l.n === name);
}

/** The level he'd work if he wants `name`: that one if the stairs reach it, else the deepest reached above it. */
export function reachedLevel(mine, name) {
  const want = levelNamed(mine, name) ?? mine.levels[mine.levels.length - 1];
  let best;
  for (const l of mine.levels) if (l.hub !== undefined && l.y >= want.y) best = l;
  return best;
}

// ---------------------------------------------------------------- mines

/** The mine this miner works (joining a nearby one if he has none). Undefined: he needs a new one. */
export function findMine(villager, dimId, ws) {
  if (typeof villager.getDynamicProperty(DP_MINE) === "string") villager.setDynamicProperty(DP_MINE, undefined); // pre-v1.9
  const list = all();
  const id = villager.getDynamicProperty(DP_MINE_ID);
  const own = list.find((m) => m.id === id);
  if (own && !own.done) return own;
  const near = list
    .filter((m) => m.d === dimId && !m.done && horizDist(m, ws) <= MINE.SHARE_RADIUS)
    .sort((a, b) => horizDist(a, ws) - horizDist(b, ws))[0];
  if (near) {
    villager.setDynamicProperty(DP_MINE_ID, near.id);
    return near;
  }
  if (id) villager.setDynamicProperty(DP_MINE_ID, undefined);
  return undefined;
}

export function mineById(id) {
  return all().find((m) => m.id === id);
}

/** Mines (in this dimension) with an entrance within `r` of `loc`. */
export function minesNear(dimId, loc, r = MINE.SHARE_RADIUS) {
  return all().filter((m) => m.d === dimId && horizDist(m, loc) <= r);
}

export function mineOf(villager) {
  const id = villager.getDynamicProperty(DP_MINE_ID);
  return id ? all().find((m) => m.id === id) : undefined;
}

/** A first staircase leg, from the surface, heading dx,dz from ox,oy,oz. */
export function firstLeg(ox, oy, oz, dx, dz, levels) {
  return { k: "stair", p: -1, at: 0, ox, oy, oz, dx, dz, len: legLength(oy, levels), drop: 1, w: 3, h: MINE.STAIR_H };
}

function legLength(oy, levels) {
  const target = levels.find((l) => l.y <= oy)?.y ?? oy;
  return Math.max(1, Math.min(MINE.STAIR_LEG, oy - target + 1));
}

export function createMine(villager, dimId, ws, leg, bad = []) {
  const mine = {
    id: `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
    v: 2,
    d: dimId,
    x: ws.x,
    y: ws.y,
    z: ws.z,
    levels: levelsFor(dimId, ws),
    segs: [{ ...leg, i: 0, owner: villager.id, seen: 0, done: false }],
    bad,
    done: false,
  };
  all().push(mine);
  villager.setDynamicProperty(DP_MINE_ID, mine.id);
  saveMines(mine);
  return mine;
}

const free = (s, id, now) => !s.done && (!s.owner || s.owner === id || now - (s.seen ?? 0) > OWNER_TIMEOUT || now < (s.seen ?? 0));

function claim(mine, seg, id, now) {
  seg.owner = id;
  seg.seen = now;
  saveMines(mine);
  return seg;
}

/** The unfinished bottom of the staircase, if there is one. */
function stairTip(mine) {
  for (let n = mine.segs.length - 1; n >= 0; n--) if (mine.segs[n].k === "stair" && !mine.segs[n].done) return mine.segs[n];
  return undefined;
}

/**
 * What he digs next in this mine, wanting level `want` ("coal", "iron", "diamond"). His own
 * unfinished tunnel if it's on the right level; otherwise the staircase (if the level he wants
 * isn't reached yet and nobody else is on it), or a free tunnel / a new branch on the level.
 * Returns {seg} or {wait: true} or {done: true}.
 */
export function chooseWork(mine, villagerId, now, want) {
  const target = reachedLevel(mine, want);
  const wantLevel = levelNamed(mine, want) ?? mine.levels[mine.levels.length - 1];
  const mine_ = mine.segs.find((s) => !s.done && s.owner === villagerId && now - (s.seen ?? 0) <= OWNER_TIMEOUT);
  if (mine_ && (mine_.k === "stair" || !target || mine_.lvl === target.n)) {
    mine_.seen = now;
    return { seg: mine_ };
  }
  if (mine_) mine_.owner = undefined; // wrong level for this trip: somebody else can have it

  // the staircase, when the level he's after isn't reached yet
  const tip = stairTip(mine);
  if (tip && (!target || target.y > wantLevel.y) && free(tip, villagerId, now)) return { seg: claim(mine, tip, villagerId, now) };

  // a tunnel on his level (or the deepest reached above it), then any other level reached
  const order = mine.levels.filter((l) => l.hub !== undefined).sort((a, b) => (a === target ? -1 : b === target ? 1 : a.y - b.y));
  for (const l of order) {
    const open = mine.segs.find((s) => s.lvl === l.n && s.k !== "stair" && free(s, villagerId, now));
    if (open) return { seg: claim(mine, open, villagerId, now) };
    const b = newBranch(mine, l, villagerId, now) ?? newMain(mine, l, villagerId, now);
    if (b) return { seg: b };
  }
  if (tip && free(tip, villagerId, now)) return { seg: claim(mine, tip, villagerId, now) }; // deeper, then
  if (mine.segs.some((s) => !s.done)) return { wait: true }; // others are still at it
  mine.done = true;
  saveMines(mine);
  return { done: true };
}

/**
 * A stretch of tunnel is finished. A staircase leg ending on a level opens that level up (main
 * corridors off the landing); if there are deeper levels still to reach, the next leg is laid out.
 */
export function finishSegment(mine, seg) {
  seg.done = true;
  seg.owner = undefined;
  if (seg.k === "stair") afterStairLeg(mine, mine.segs.indexOf(seg));
  saveMines(mine);
}

function afterStairLeg(mine, idx) {
  const leg = mine.segs[idx];
  if (leg.len < 1) {
    // nothing dug at all: try turning the other way from the landing before, or it ends here
    return retryLeg(mine, idx);
  }
  const f = sliceFloorY(leg, leg.len - 1);
  const lvl = mine.levels.find((l) => l.y === f && l.hub === undefined);
  if (lvl) {
    lvl.hub = idx;
    for (const turn of ["fwd", "left"]) {
      const m = mainFrom(mine, idx, turn, lvl);
      if (m && !overlaps(mine, m)) mine.segs.push({ ...m, i: 0, seen: 0, done: false });
    }
  }
  const deeper = mine.levels.filter((l) => l.y < f);
  if (!deeper.length || mine.bottom !== undefined) return;
  for (const turn of [1, -1, 0]) {
    const next = legFrom(mine, idx, turn);
    if (next && !overlaps(mine, next)) {
      mine.segs.push({ ...next, i: 0, seen: 0, done: false });
      return;
    }
  }
  mine.bottom = f; // boxed in: the stairs stop here
}

/** A leg that got nowhere: another direction off the same landing, or the bottom of the stairs. */
function retryLeg(mine, idx) {
  const leg = mine.segs[idx];
  if (leg.p < 0) return; // the very first leg is re-planned by the miner (another direction from home)
  leg.tried = (leg.tried ?? 0) + 1;
  const parent = mine.segs[leg.p];
  for (const turn of [1, -1, 0]) {
    const next = legFrom(mine, leg.p, turn);
    if (!next || (next.dx === leg.dx && next.dz === leg.dz)) continue;
    if (mine.segs.some((s) => s.p === leg.p && s.k === "stair" && s.dx === next.dx && s.dz === next.dz)) continue;
    if (overlaps(mine, next)) continue;
    mine.segs.push({ ...next, i: 0, seen: 0, done: false });
    return;
  }
  mine.bottom = sliceFloorY(parent, parent.len - 1);
}

/** The next staircase leg off the end of leg `idx`: turn 1 = right, -1 = left, 0 = straight on. */
function legFrom(mine, idx, turn) {
  const leg = mine.segs[idx];
  const end = sliceCenter(leg, leg.len - 1);
  const dx = turn === 0 ? leg.dx : turn > 0 ? -leg.dz : leg.dz;
  const dz = turn === 0 ? leg.dz : turn > 0 ? leg.dx : -leg.dx;
  const off = turn === 0 ? 1 : 2;
  const o = { x: end.x + dx * off, y: end.y, z: end.z + dz * off };
  const levels = mine.levels.filter((l) => l.y < end.y);
  if (!levels.length) return undefined;
  return { k: "stair", p: idx, at: leg.len - 1, ox: o.x, oy: o.y, oz: o.z, dx, dz, len: legLength(o.y, levels), drop: 1, w: 3, h: MINE.STAIR_H };
}

/** A main corridor off the landing at the end of leg `idx`: straight on ("fwd") or to the left. */
function mainFrom(mine, idx, turn, lvl) {
  const leg = mine.segs[idx];
  const end = sliceCenter(leg, leg.len - 1);
  const [dx, dz, off] = turn === "fwd" ? [leg.dx, leg.dz, 1] : [leg.dz, -leg.dx, 2];
  return { k: "main", p: idx, at: leg.len - 1, lvl: lvl.n, ox: end.x + dx * off, oy: end.y, oz: end.z + dz * off, dx, dz, len: MINE.MAIN_LEN, drop: 0, w: 3, h: MINE.MAIN_H };
}

/** A corridor that's run its course early (water, a cave...): the level gets another one off the landing. */
function newMain(mine, lvl, villagerId, now) {
  if (lvl.hub === undefined) return undefined;
  const have = mine.segs.filter((s) => s.k === "main" && s.lvl === lvl.n).length;
  if (have >= MINE.MAX_MAINS) return undefined;
  // off the far end of an existing corridor, carrying on in the same direction
  for (const m of mine.segs.filter((s) => s.k === "main" && s.lvl === lvl.n && s.done && s.len >= MINE.MAIN_LEN)) {
    const n = mine.segs.indexOf(m);
    if (mine.segs.some((s) => s.p === n && s.k === "main")) continue;
    const end = sliceCenter(m, m.len - 1);
    const seg = { k: "main", p: n, at: m.len - 1, lvl: lvl.n, ox: end.x + m.dx, oy: end.y, oz: end.z + m.dz, dx: m.dx, dz: m.dz, len: MINE.MAIN_LEN, drop: 0, w: 3, h: MINE.MAIN_H };
    if (overlaps(mine, seg)) continue;
    const out = { ...seg, i: 0, owner: villagerId, seen: now, done: false };
    mine.segs.push(out);
    saveMines(mine);
    return out;
  }
  return undefined;
}

/**
 * A new 1x2 branch off one of this level's main corridors, into rock nobody has looked at yet.
 * Returns the new (claimed) segment, or undefined if there's no room for another.
 */
function newBranch(mine, lvl, villagerId, now) {
  if (mine.segs.length >= MINE.MAX_SEGMENTS) return undefined;
  const mains = mine.segs.map((s, n) => ({ s, n })).filter((e) => e.s.k === "main" && e.s.lvl === lvl.n);
  for (const { s, n } of mains) {
    const dug = s.done ? s.len : s.i - 2; // (not right behind somebody still digging it)
    for (let j = MINE.BRANCH_START; j < dug; j += MINE.BRANCH_EVERY) {
      for (const side of [1, -1]) {
        if (mine.segs.some((b) => b.p === n && b.at === j && b.side === side)) continue;
        const c = sliceCenter(s, j);
        const dx = -s.dz * side;
        const dz = s.dx * side;
        const seg = { k: "branch", p: n, at: j, side, lvl: lvl.n, ox: c.x + dx * 2, oy: c.y, oz: c.z + dz * 2, dx, dz, len: MINE.BRANCH_LEN, drop: 0, w: 1, h: 2 };
        if (overlaps(mine, seg)) {
          mine.segs.push({ ...seg, len: 0, i: 0, done: true }); // remember the slot is no good
          continue;
        }
        const out = { ...seg, i: 0, owner: villagerId, seen: now, done: false };
        mine.segs.push(out);
        saveMines(mine);
        return out;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- finding the way

/**
 * Which slice of the mine is he standing in? {n (segment index), i} or undefined (not in it).
 * Standing in a nook off it (a corner he knocked out, a hole) counts as the nearest slice.
 */
export function locate(mine, loc) {
  let best;
  let bestD = Infinity;
  let near;
  let nearD = 3.5;
  for (let n = 0; n < mine.segs.length; n++) {
    const s = mine.segs[n];
    const len = s.done ? s.len : s.i;
    for (let i = 0; i < len; i++) {
      const b = sliceBox(s, i);
      const c0 = sliceCenter(s, i);
      const dn = Math.abs(loc.x - c0.x - 0.5) + Math.abs(loc.z - c0.z - 0.5) + Math.abs(loc.y - c0.y) * 2;
      if (dn < nearD) {
        near = { n, i };
        nearD = dn;
      }
      if (loc.y < b.y0 - 2.6 || loc.y > b.y1 + 0.5) continue; // (or down a hole in its floor)
      if (loc.x < b.x0 - 0.2 || loc.x > b.x1 + 1.2 || loc.z < b.z0 - 0.2 || loc.z > b.z1 + 1.2) continue;
      const c = sliceCenter(s, i);
      const d = Math.abs(loc.x - c.x - 0.5) + Math.abs(loc.z - c.z - 0.5) + Math.abs(loc.y - c.y);
      if (d < bestD) {
        best = { n, i };
        bestD = d;
      }
    }
  }
  return best ?? near;
}

function chain(mine, n) {
  const out = [];
  for (let cur = n; cur >= 0; cur = mine.segs[cur].p) out.unshift(cur);
  return out;
}

/**
 * The way through the mine from (segment a, slice ai) to (segment b, slice bi): a list of stops
 * {n, i, p (feet position)}, junction by junction. a = -1 means from the entrance.
 */
export function route(mine, a, ai, b, bi) {
  const stops = [];
  const add = (n, i) => {
    const p = i < 0 ? standFor(mine.segs[n], 0) : sliceCenter(mine.segs[n], i);
    const last = stops[stops.length - 1];
    if (!last || last.p.x !== p.x || last.p.y !== p.y || last.p.z !== p.z) stops.push({ n, i, p });
  };
  const ca = a >= 0 ? chain(mine, a) : [];
  const cb = chain(mine, b);
  let common = 0;
  while (common < ca.length && common < cb.length && ca[common] === cb[common]) common++;
  if (a < 0) add(cb[0], -1); // the top of the stairs
  // up and out of his own branch to where the two ways part
  let cur = a;
  let curI = ai;
  for (let k = ca.length - 1; k >= common; k--) {
    const s = mine.segs[ca[k]];
    add(ca[k], Math.min(curI, s.len - 1));
    add(ca[k], 0);
    cur = s.p;
    curI = s.at;
  }
  // down the other way
  for (let k = Math.max(common - 1, 0); k < cb.length; k++) {
    const n = cb[k];
    if (k < common - 1) continue;
    const next = cb[k + 1];
    if (k === common - 1 && cur === n && curI !== undefined) add(n, curI);
    if (next !== undefined) {
      add(n, mine.segs[next].at);
      add(next, 0);
    } else add(n, bi);
  }
  return stops;
}
