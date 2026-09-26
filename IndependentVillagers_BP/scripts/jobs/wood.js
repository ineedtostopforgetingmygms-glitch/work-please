// Getting his own wood.
//
// A miner with no pickaxe, or a farmer with no hoe, used to stand about waiting for a lumberjack to
// sell him some logs - and if there was no lumberjack in range (or the one there was had nothing
// spare) he waited for ever. Now he does what a player does on the first day: walks to the nearest
// tree and punches the bottom of it out by hand.
//
// It's slow on purpose (a log by hand is ~3 seconds without an axe) and he only takes what he needs,
// so buying from a lumberjack is still much the better deal.
import { CFG, LOGS } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { getTool, holdItem, pickupItems, startBreak, updateBreak, wearTool } from "../actions.js";
import { navTo, navUpdate } from "../nav.js";
import { vCount } from "../inventory.js";
import { analyzeTree } from "../trees.js";
import { canUse, center, dist, findStandableNear, floorPos, getBlock, getInventory, isStandable, lookAt, offset, ringOffsets } from "../util.js";

const isLog = (id) => LOGS.has(id);
const k = (p) => `${p.x},${p.y},${p.z}`;

/**
 * Off to fetch `need` logs himself, then back to state `then`. False if it isn't time for that yet.
 *
 * This is the last resort, not the plan: buying off a lumberjack is much quicker and it's what keeps
 * the village economy going, so he only picks up the job himself once there's been nobody selling
 * wood for `patience` ticks. (Pass 0 when there's nothing else he could possibly do.)
 */
export function fetchWood(villager, brain, need, then, now, patience = CFG.WOOD.PATIENCE) {
  if ((brain.noWoodUntil ?? 0) > now) return false;
  if (patience && now - (brain.noSellerSince ?? now) < patience) return false;
  brain.job = { wood: { need, then, started: now } };
  setState(villager, brain, "wood");
  debugLog(villager, `nobody will sell him wood - going to cut ${need} log(s) himself`);
  return true;
}

const COLUMNS = ringOffsets(1, CFG.WOOD.RADIUS, [0]);

/** Scans outwards for the foot of a real tree (analyzeTree vets it, so no chopping houses). */
function stepTreeScan(villager, dim, brain, origin) {
  const s = (brain.woodScan ??= { i: 0 });
  const end = Math.min(COLUMNS.length, s.i + CFG.WOOD.SCAN_PER_THINK);
  for (; s.i < end; s.i++) {
    const o = COLUMNS[s.i];
    for (let dy = 6; dy >= -6; dy--) {
      const p = { x: origin.x + o.x, y: origin.y + dy, z: origin.z + o.z };
      const b = getBlock(dim, p);
      if (!b || !isLog(b.typeId)) continue;
      if (brain.badTrees?.has(k(p))) continue;
      const tree = analyzeTree(dim, p);
      if (!tree.ok) {
        (brain.badTrees ??= new Set()).add(k(p));
        continue;
      }
      brain.woodScan = null;
      return tree;
    }
  }
  if (s.i >= COLUMNS.length) {
    brain.woodScan = null;
    return "none";
  }
  return undefined;
}

/** The lowest log of the tree he can actually get at from where he's standing. */
function reachableLog(dim, villager, logs) {
  let best;
  let bestScore = Infinity;
  for (const p of logs) {
    const b = getBlock(dim, p);
    if (!b || !isLog(b.typeId)) continue;
    if (!canUse(dim, villager, p)) continue;
    const score = p.y * 4 + dist(center(p), villager.location); // bottom-up, like a player
    if (score < bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

export function woodState(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  const job = brain.job?.wood;
  if (!job) return setState(villager, brain, "idle", CFG.SHORT_PAUSE);
  pickupItems(villager, dim, inv, isLog);

  // enough wood (or he's been at it long enough): back to what he was doing
  const done = vCount(inv, isLog) >= job.need;
  if (done || now - job.started > CFG.WOOD.TIMEOUT) {
    if (!done) {
      brain.noWoodUntil = now + CFG.WOOD.RETRY;
      debugLog(villager, "gave up trying to get his own wood");
    } else {
      debugLog(villager, `cut ${vCount(inv, isLog)} log(s) himself - back to work`);
    }
    const then = job.then;
    brain.job = null;
    brain.tree = null;
    setWorking(villager, false);
    holdItem(villager, undefined);
    return setState(villager, brain, then);
  }

  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    if (r === "done") wearTool(villager, "axe");
    setWorking(villager, false);
    pickupItems(villager, dim, inv, isLog);
    return sleep(brain, 4);
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed" && brain.tree) {
      (brain.badTrees ??= new Set()).add(k(brain.tree.base[0]));
      brain.tree = null;
    }
  }

  // which tree?
  if (!brain.tree || !brain.tree.logs.some((p) => isLog(getBlock(dim, p)?.typeId ?? ""))) {
    const found = stepTreeScan(villager, dim, brain, floorPos(ws ?? villager.location));
    if (found === undefined) return sleep(brain, 2);
    if (found === "none") {
      debugLog(villager, "no tree he can get to anywhere near - he'll have to buy his wood");
      brain.noWoodUntil = now + CFG.WOOD.RETRY;
      brain.job = null;
      return setState(villager, brain, job.then);
    }
    brain.tree = found;
    debugLog(villager, `walking over to the tree at ${found.base[0].x} ${found.base[0].y} ${found.base[0].z}`);
  }

  // chop the lowest log he can reach; otherwise walk right up to the trunk
  const target = reachableLog(dim, villager, brain.tree.logs);
  if (target) {
    setMode(villager, brain, "work");
    holdItem(villager, getTool(villager, "axe")?.id);
    lookAt(villager, center(target));
    startBreak(brain, target, getTool(villager, "axe"));
    setWorking(villager, true);
    return;
  }
  const base = brain.tree.base[0];
  const spot = findStandableNear(dim, base, 3, 2, (q) => isLog(getBlock(dim, q)?.typeId ?? "")) ?? (isStandable(dim, offset(base, 1, 0, 0)) ? offset(base, 1, 0, 0) : undefined);
  if (!spot || !navTo(villager, brain, spot, { radius: 1.0 })) {
    (brain.badTrees ??= new Set()).add(k(base));
    brain.tree = null;
    return sleep(brain, 10);
  }
  sleep(brain, 4);
}
