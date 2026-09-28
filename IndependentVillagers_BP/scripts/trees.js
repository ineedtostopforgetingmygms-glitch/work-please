// Finding trees, and deciding very strictly whether a group of logs is a natural tree.
//
// A log group only counts as a tree if ALL of these are true:
//  1. every log is the same wood type, connected (diagonals count, for acacia/cherry branches)
//  2. at least CFG.MIN_TREE_LEAVES leaves of the matching type touch the logs, and those leaves
//     grew naturally (player-placed leaves have persistent_bit = true -> instant reject)
//  3. the lowest logs stand upright (pillar_axis = y) on natural ground (dirt, grass, podzol, ...)
//  4. nothing player-made touches any log (planks, glass, doors, torches, stairs, ...)
//  5. no log in it was placed by a player (tracked in placed.js)
import { BUILD_BLOCK, BUILD_BLOCK_EXCEPTIONS, CFG, LEAVES, LOG_TO_LEAVES, LOGS, PASSABLE, TREE_GROUND } from "./config.js";
import { isPlayerPlaced } from "./placed.js";
import { getBlock, offset } from "./util.js";

const N6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const N26 = [];
for (let dx = -1; dx <= 1; dx++)
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) N26.push([dx, dy, dz]);

// Other natural ground a (leafy) tree can grow on
const NATURAL_GROUND = /^minecraft:(sand|red_sand|gravel|stone|granite|diorite|andesite|tuff|deepslate|calcite|dripstone_block|snow|powder_snow|ice|packed_ice|terracotta|\w+_terracotta|sandstone|red_sandstone|suspicious_sand|suspicious_gravel|farmland|soul_soil|soul_sand)$/;

const k = (p) => `${p.x},${p.y},${p.z}`;
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;

export function isNaturalLeaf(block) {
  try {
    return block.permutation.getState("persistent_bit") !== true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- scanning for candidates

const SPIRAL = [];
for (let dx = -CFG.FOREST_RADIUS; dx <= CFG.FOREST_RADIUS; dx++)
  for (let dz = -CFG.FOREST_RADIUS; dz <= CFG.FOREST_RADIUS; dz++) SPIRAL.push({ x: dx, z: dz, d: dx * dx + dz * dz });
SPIRAL.sort((a, b) => a.d - b.d);

export function newScan(centerPos) {
  return { c: { x: centerPos.x, y: centerPos.y, z: centerPos.z }, i: 0, found: new Map(), done: false, doneAt: 0 };
}

/** Scans `budget` more columns around the scan centre for tree trunks. */
export function stepScan(dim, scan, budget) {
  const end = Math.min(SPIRAL.length, scan.i + budget);
  const near = CFG.FOREST_NEAR * CFG.FOREST_NEAR;
  for (; scan.i < end; scan.i++) {
    const o = SPIRAL[scan.i];
    // nearest first, so once there are trees enough close by there's no need to look further out
    if (o.d > near && scan.found.size >= CFG.FOREST_ENOUGH) {
      scan.i = SPIRAL.length;
      break;
    }
    const trunk = trunkInColumn(dim, scan.c.x + o.x, scan.c.z + o.z, scan.c.y);
    if (trunk) scan.found.set(k(trunk), trunk);
  }
  if (scan.i >= SPIRAL.length) scan.done = true;
}

function topBlock(dim, x, z) {
  try {
    return dim.getTopmostBlock({ x, z });
  } catch {
    return undefined;
  }
}

/**
 * Looks down a column from the sky all the way to the ground - through the canopy, the air under
 * it, and any smaller tree's leaves further down - and returns the bottom of the first log column
 * it meets. (Only stopping at the first canopy missed every smaller tree growing under a big one.)
 */
export function trunkInColumn(dim, x, z, refY) {
  let b = topBlock(dim, x, z);
  for (let i = 0; i < 64 && b; i++) {
    const id = b.typeId;
    if (LOGS.has(id)) break;
    if (!(b.isAir || LEAVES.has(id) || PASSABLE.test(id))) return undefined; // reached the ground (or a build)
    if (b.y < refY - 24) return undefined;
    b = b.below();
  }
  if (!b || !LOGS.has(b.typeId)) return undefined;
  return trunkBase(b, refY);
}

function trunkBase(b, refY) {
  const type = b.typeId;
  for (let i = 0; i < 48; i++) {
    const below = b.below();
    if (!below || below.typeId !== type) break;
    b = below;
  }
  if (Math.abs(b.y - refY) > 20) return undefined;
  return { x: b.x, y: b.y, z: b.z, type };
}

/** Debug: how many trees the scan finds around a point, and why it rejects the rest. */
export function compareScans(dim, c) {
  const count = (fn) => {
    const found = new Map();
    for (const o of SPIRAL) {
      const t = fn(dim, c.x + o.x, c.z + o.z, c.y);
      if (t) found.set(k(t), t);
    }
    // group trunks into trees (a tree's logs all analyze to the same base)
    const trees = new Set();
    const reasons = new Map();
    const species = new Map();
    const covered = new Set(); // logs of trees already analyzed (big trees have many "trunks")
    for (const t of found.values()) {
      if (covered.has(k(t))) continue;
      const r = analyzeTree(dim, t);
      if (r.ok) {
        if (!trees.has(k(r.base[0]))) species.set(r.species, (species.get(r.species) ?? 0) + 1);
        trees.add(k(r.base[0]));
        for (const l of r.logs) covered.add(k(l));
      }
      else {
        const why = r.reason.replace(/-?\d+ -?\d+ -?\d+/g, "#").replace(/\d+/g, "N");
        const e = reasons.get(why) ?? { n: 0, example: `${fmt(t)}: ${r.reason}` };
        e.n++;
        reasons.set(why, e);
      }
    }
    return { trunks: found.size, trees: trees.size, reasons, species };
  };
  return { full: count(trunkInColumn) };
}

// ---------------------------------------------------------------- analysis

/**
 * @returns {{ok:true, species:string, logs:{x,y,z}[], base:{x,y,z}[], leaves:number}
 *          | {ok:false, reason:string}}
 */
export function analyzeTree(dim, start) {
  const first = getBlock(dim, start);
  if (!first || !LOGS.has(first.typeId)) return { ok: false, reason: "no log there" };
  const species = first.typeId;
  const okLeaves = new Set(LOG_TO_LEAVES[species]);

  const cache = new Map();
  const get = (p) => {
    const key = k(p);
    if (!cache.has(key)) cache.set(key, getBlock(dim, p) ?? null);
    return cache.get(key);
  };

  const s = { x: first.x, y: first.y, z: first.z };
  const logs = [s];
  const logSeen = new Set([k(s)]);
  const faceSeen = new Set();
  const queue = [s];
  let naturalLeaves = 0;
  let wet = false;

  while (queue.length) {
    const p = queue.shift();

    // grow through connected logs of the same type
    for (const [dx, dy, dz] of N26) {
      const n = offset(p, dx, dy, dz);
      const key = k(n);
      if (logSeen.has(key)) continue;
      if (Math.abs(n.x - s.x) > 10 || Math.abs(n.z - s.z) > 10 || Math.abs(n.y - s.y) > 40) continue;
      const b = get(n);
      if (b === null) return { ok: false, reason: "tree is in an unloaded chunk" };
      if (b.typeId !== species) continue;
      logSeen.add(key);
      logs.push(n);
      queue.push(n);
      if (logs.length > CFG.MAX_TREE_LOGS) return { ok: false, reason: `too many logs (>${CFG.MAX_TREE_LOGS}) - a build?` };
    }

    // check what directly touches this log
    for (const [dx, dy, dz] of N6) {
      const n = offset(p, dx, dy, dz);
      const key = k(n);
      if (faceSeen.has(key) || logSeen.has(key)) continue;
      faceSeen.add(key);
      const b = get(n);
      if (!b) continue;
      const id = b.typeId;
      if (LEAVES.has(id)) {
        if (!isNaturalLeaf(b)) return { ok: false, reason: `player-placed ${id} at ${fmt(n)}` };
        if (okLeaves.has(id)) naturalLeaves++;
        continue;
      }
      if (id === species || LOGS.has(id)) continue;
      // the log border round a village farm (and nothing natural ever grows up against farmland)
      if (FARMISH.test(id)) return { ok: false, reason: `${id} touches log at ${fmt(p)} - part of a farm` };
      if (b.isLiquid) wet = true;
      if (BUILD_BLOCK.test(id) && !BUILD_BLOCK_EXCEPTIONS.has(id)) {
        return { ok: false, reason: `${id} touches log at ${fmt(p)} - part of a build` };
      }
    }
  }

  for (const l of logs) {
    if (isPlayerPlaced(dim.id, l)) return { ok: false, reason: `log at ${fmt(l)} was placed by a player` };
  }

  // Fallen trees (natural forest decoration: a log lying on the ground + a short stump nearby) have
  // no leaves, so they get their own, equally strict, check.
  // (a leafless log lying in a line next to water is a farm's edge, not a fallen tree)
  if (naturalLeaves < CFG.MIN_TREE_LEAVES && !wet) {
    const fallen = fallenTree(dim, species, logs, get);
    if (fallen && !nearFarm(dim, logs, get)) return fallen;
  }

  // (1-2 logs with natural leaves is fine: jungle bushes are a single log under a ball of leaves)
  if (naturalLeaves < CFG.MIN_TREE_LEAVES && logs.length < CFG.MIN_TREE_LOGS) return { ok: false, reason: `only ${logs.length} log(s) - a stump or build` };
  if (naturalLeaves < CFG.MIN_TREE_LEAVES) {
    return { ok: false, reason: `only ${naturalLeaves} natural leaves attached (need ${CFG.MIN_TREE_LEAVES})` };
  }

  // The trunk's bottom: the lowest upright logs. (Sideways logs lower down are a fallen log lying
  // against the trunk - natural forest decoration, e.g. in dappled forests - and come down with it.)
  let minY = Infinity;
  for (const l of logs) if ((safeState(get(l), "pillar_axis") ?? "y") === "y") minY = Math.min(minY, l.y);
  if (minY === Infinity) return { ok: false, reason: `no upright logs - not a standing tree` };
  const base = logs.filter((l) => l.y === minY && (safeState(get(l), "pillar_axis") ?? "y") === "y");
  // Natural leaves can't be placed by players, so a leafy tree may stand on any natural ground -
  // jungle and beach trees grow on sand, mountain trees on stone/gravel, big trees overhang edges.
  // What it may never stand on is something built.
  let grounded = 0;
  for (const b of base) {
    const below = get(offset(b, 0, -1, 0));
    const id = below?.typeId ?? "nothing";
    if (TREE_GROUND.has(id) || NATURAL_GROUND.test(id)) grounded++;
    else if (!below || below.isAir || PASSABLE.test(id) || below.isLiquid || (LEAVES.has(id) && isNaturalLeaf(below))) continue; // (overhanging water, or another tree's leaves)
    else if (!LOGS.has(id)) return { ok: false, reason: `bottom log at ${fmt(b)} sits on ${id}, not natural ground` };
  }
  // anything lower than the trunk's bottom must be a natural fallen log lying on the ground
  for (const l of logs) {
    if (l.y >= minY) continue;
    const below = get(offset(l, 0, -1, 0));
    const id = below?.typeId ?? "nothing";
    if (!(TREE_GROUND.has(id) || NATURAL_GROUND.test(id) || LOGS.has(id) || !below || below.isAir || PASSABLE.test(id) || (LEAVES.has(id) && isNaturalLeaf(below)))) {
      return { ok: false, reason: `log at ${fmt(l)} sits on ${id}, not natural ground` };
    }
  }
  if (!grounded) return { ok: false, reason: `bottom log at ${fmt(base[0])} isn't standing on the ground` };

  for (const l of logs) {
    if (isPlayerPlaced(dim.id, l)) return { ok: false, reason: `log at ${fmt(l)} was placed by a player` };
  }

  return { ok: true, species, logs, base, leaves: naturalLeaves };
}

/**
 * A fallen log: 2-8 logs of one type, all lying sideways (x or z axis, along their own axis) in a
 * straight line at one height, resting on natural ground. Or a stump: 1-2 upright logs on
 * natural ground with nothing built on top.
 * (Build blocks touching and player-placed logs were already ruled out by the caller.)
 */
function fallenTree(dim, species, logs, get) {
  const axisOf = (p) => safeState(get(p), "pillar_axis");
  const onGround = (p) => TREE_GROUND.has(get(offset(p, 0, -1, 0))?.typeId ?? "");

  // a stump: one upright log standing on natural ground (newer worlds generate these on their own,
  // with or without the fallen log next to them). Nothing player-made may sit on top of it.
  // (1-2 logs high)
  if (logs.length <= 2 && logs.every((l) => axisOf(l) === "y" && l.x === logs[0].x && l.z === logs[0].z)) {
    const s = logs.reduce((a, b) => (a.y <= b.y ? a : b));
    const t = logs.reduce((a, b) => (a.y >= b.y ? a : b));
    if (!onGround(s)) return undefined;
    const top = get(offset(t, 0, 1, 0));
    if (top && !top.isAir && !PASSABLE.test(top.typeId) && !LEAVES.has(top.typeId)) return undefined;
    return { ok: true, species, logs, base: [s], leaves: 0, fallen: "stump" };
  }

  // the log lying on the ground (2-8 long; on a slope part of it may hang over a dip)
  if (logs.length < 2 || logs.length > 8) return undefined;
  const axis = axisOf(logs[0]);
  if (axis !== "x" && axis !== "z") return undefined;
  const y = logs[0].y;
  const across = axis === "x" ? "z" : "x";
  if (!logs.every((l) => l.y === y && l[across] === logs[0][across] && axisOf(l) === axis)) return undefined;
  if (!logs.some(onGround)) return undefined;
  return { ok: true, species, logs, base: logs, leaves: 0, fallen: "log" };
}

// crops and farmland: logs next to these are a farm's border
const FARMISH = /farmland|wheat|carrots|potatoes|beetroot|pumpkin_stem|melon_stem|torchflower_crop|pitcher_crop|composter/;

/** Farmland within a couple of blocks of these logs (a village farm's log border, a crop bed). */
function nearFarm(dim, logs, get) {
  for (const l of logs) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 0; dy++) {
          if (FARMISH.test(get({ x: l.x + dx, y: l.y + dy, z: l.z + dz })?.typeId ?? "")) return true;
        }
      }
    }
  }
  return false;
}

function safeState(block, name) {
  try {
    return block?.permutation.getState(name);
  } catch {
    return undefined;
  }
}
