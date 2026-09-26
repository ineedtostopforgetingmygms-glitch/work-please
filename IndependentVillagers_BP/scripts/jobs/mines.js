// Shared mineshafts. Mines live in a world-wide list, not on one miner: a miner whose stonecutter
// is within MINE.SHARE_RADIUS blocks of a mine that's still being dug joins it instead of digging
// his own. Everyone digs his own tunnel ("segment") of it - the first miner digs the staircase
// shaft, the others branch off the tunnels that are already dug - so they never dig the same rock.
//
//   mine = { id, d, x, y, z, segs: [seg], bad: ["dx,dz"], done }
//   seg  = { ox, oy, oz, dx, dz, len, descend, i, owner, seen, done }
import { world } from "@minecraft/server";
import { DP_MINE, MINE } from "../config.js";
import { horizDist } from "../util.js";

const WORLD_DP_MINES = "iv:mines";
const DP_MINE_ID = "iv:mineid";
const OWNER_TIMEOUT = 20 * 60 * 3; // a tunnel whose miner hasn't touched it for this long is up for grabs

let mines;

function all() {
  if (!mines) {
    try {
      mines = JSON.parse(world.getDynamicProperty(WORLD_DP_MINES) ?? "[]");
    } catch {
      mines = [];
    }
  }
  return mines;
}

export function saveMines() {
  try {
    world.setDynamicProperty(WORLD_DP_MINES, JSON.stringify(all()));
  } catch {}
}

export function sliceFloorY(seg, i) {
  return seg.descend ? seg.oy - Math.max(0, Math.min(i, MINE.DEPTH)) : seg.oy;
}

export function sliceCenter(seg, i) {
  return { x: seg.ox + seg.dx * i, y: sliceFloorY(seg, i), z: seg.oz + seg.dz * i };
}

/** The mine this miner works (joining a nearby one if he has none). Undefined: he needs a new one. */
export function findMine(villager, dimId, ws) {
  migrateOld(villager, dimId, ws);
  const list = all();
  const id = villager.getDynamicProperty(DP_MINE_ID);
  const own = list.find((m) => m.id === id);
  if (own && !own.done) return own;
  // join the nearest unfinished mine within reach of his stonecutter
  const near = list
    .filter((m) => m.d === dimId && !m.done && horizDist(m, ws) <= MINE.SHARE_RADIUS)
    .sort((a, b) => horizDist(a, ws) - horizDist(b, ws))[0];
  if (near) {
    villager.setDynamicProperty(DP_MINE_ID, near.id);
    return near;
  }
  if (own) villager.setDynamicProperty(DP_MINE_ID, undefined); // his old one is finished
  return undefined;
}

/** Just a lookup - is his mine finished? */
export function mineOf(villager) {
  const id = villager.getDynamicProperty(DP_MINE_ID);
  return id ? all().find((m) => m.id === id) : undefined;
}

export function createMine(villager, dimId, ws, firstSeg, bad = []) {
  const mine = {
    id: `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
    d: dimId,
    x: ws.x,
    y: ws.y,
    z: ws.z,
    segs: [{ ...firstSeg, i: 0, owner: villager.id, seen: 0, done: false }],
    bad,
    done: false,
  };
  all().push(mine);
  villager.setDynamicProperty(DP_MINE_ID, mine.id);
  saveMines();
  return mine;
}

/** His tunnel in this mine: the one he's digging, or a free one. */
export function claimSegment(mine, villagerId, now) {
  let seg = mine.segs.find((s) => !s.done && s.owner === villagerId);
  if (!seg) {
    seg = mine.segs.find((s) => !s.done && (!s.owner || now - (s.seen ?? 0) > OWNER_TIMEOUT || now < (s.seen ?? 0)));
    if (seg) {
      seg.owner = villagerId;
      saveMines();
    }
  }
  if (seg) seg.seen = now;
  return seg;
}

/** Nobody's digging the rest of this tunnel. */
export function finishSegment(mine, seg) {
  seg.done = true;
  seg.owner = undefined;
  saveMines();
}

/**
 * A new tunnel branching off one that's already dug, far enough (4+ blocks) from every other
 * tunnel. Returns the new (claimed) segment, or undefined if the mine is as big as it gets.
 */
export function newBranch(mine, villagerId, now) {
  if (mine.segs.length >= MINE.MAX_SEGMENTS * 3) return undefined;
  // off any stretch of tunnel that's already dug (also one somebody is still digging, a few
  // slices behind him), newest tunnels first
  const dugLen = (s) => (s.done ? s.len : s.i - 3);
  const dug = mine.segs.filter((s) => dugLen(s) >= 4).reverse();
  for (const s of dug) {
    const first = s.descend ? MINE.DEPTH + 2 : 2;
    for (let j = dugLen(s) - 1; j >= first; j -= 8) {
      for (const turn of [1, -1]) {
        const c = sliceCenter(s, j);
        const dx = -s.dz * turn;
        const dz = s.dx * turn;
        const seg = { ox: c.x + dx * 2, oy: c.y, oz: c.z + dz * 2, dx, dz, len: MINE.BRANCH_LENGTH, descend: false };
        if (overlaps(mine, seg, s)) continue;
        const out = { ...seg, i: 0, owner: villagerId, seen: now, done: false };
        mine.segs.push(out);
        saveMines();
        return out;
      }
    }
  }
  return undefined;
}

/** Would this new tunnel run into (or right alongside) another one? (It starts off `parent`, so that one's fine.) */
function overlaps(mine, seg, parent) {
  for (let k = 0; k < seg.len; k++) {
    const p = sliceCenter(seg, k);
    for (const e of mine.segs) {
      if (e === parent) continue;
      for (let m = 0; m < e.len; m++) {
        const q = sliceCenter(e, m);
        if (Math.abs(p.y - q.y) < 5 && Math.abs(p.x - q.x) < 4 && Math.abs(p.z - q.z) < 4) return true;
      }
    }
  }
  return false;
}

/** Mines from before they were shared (kept on the villager) move to the world list. */
function migrateOld(villager, dimId, ws) {
  const raw = villager.getDynamicProperty(DP_MINE);
  if (typeof raw !== "string") return;
  villager.setDynamicProperty(DP_MINE, undefined);
  try {
    const old = JSON.parse(raw);
    if (!old?.segs?.length) return;
    const segs = old.segs.map((s, n) => ({
      ...s,
      i: n < old.cur ? s.len : n === old.cur ? old.i : 0,
      done: n < old.cur || (n === old.cur && old.i >= s.len),
      owner: n === old.cur ? villager.id : undefined,
      seen: 0,
    }));
    const mine = { id: `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, d: dimId, x: ws.x, y: ws.y, z: ws.z, segs, bad: old.bad ?? [], done: !!old.done };
    all().push(mine);
    villager.setDynamicProperty(DP_MINE_ID, mine.id);
    saveMines();
  } catch {}
}
