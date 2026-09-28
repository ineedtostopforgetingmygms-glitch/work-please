// Lumberjack - works like a player would:
//   seek     scan the forest around the crafting table for trees, check each one strictly (trees.js)
//   approach walk to a spot next to the trunk
//   fell     look at each log and chop it (break time depends on the axe), clearing leaves that
//            block the view, stepping into the trunk or pillaring up with a log for tall trees
//   descend  break the pillar back down
//   gather   walk over and pick up the dropped logs/saplings/apples
//   replant  plant a sapling on each stump (only if he has one - otherwise he remembers the spot)
//   home     walk back to his own crafting table
//   deposit  craft an axe if needed, store the wood in his chests, craft + place a new chest if full
import { ItemStack, system } from "@minecraft/server";
import { AXES, CFG, DP_REPLANT, LEAVES, LOG_TO_SAPLING, LOGS, LUMBERJACK_PICKUPS, PROP_PROFESSION, Profession, SAPLING_GROUND, SAPLINGS } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { getTool, giveTool, holdItem, pickupItems, placeBlock, startBreak, updateBreak, wearTool } from "../actions.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { addStockpile } from "../registry.js";
import { analyzeTree, isNaturalLeaf, newScan, stepScan } from "../trees.js";
import {
  canSee,
  canUse,
  center,
  countItems,
  dist,
  eyePos,
  findStandableNear,
  firstBlockInSight,
  firstBlockOnLine,
  floorPos,
  getBlock,
  getInventory,
  horizDist,
  isPassable,
  isSolidGround,
  isStandable,
  lookAt,
  offset,
  particle,
  playSound,
  posKey,
  ringOffsets,
  samePos,
  takeItems,
} from "../util.js";
import { getWorkstation, ownsWorkstation, unemploy } from "./employment.js";
import { isNearHome, spotNextTo, stockpileChests, walkTo } from "./common.js";
import { haveBench, putDown, useBench } from "./workshop.js";
import { storeInto, vAdd, vCount, vFreeSlots, vTake } from "../inventory.js";
import { restockSellRow } from "../trade.js";
import { market } from "./market.js";
import { hideState, offDuty, sleepState } from "./rest.js";
import { goShopping, shop } from "./shopping.js";
import { shopForTool } from "./tools.js";
import { spareOf } from "../economy.js";

export const WORKSTATION = "iv:woodcutter_bench";
const isLog = (id) => LOGS.has(id);
const isWanted = (id) => LUMBERJACK_PICKUPS.has(id);
const isStick = (id) => id === "minecraft:stick";
const COBBLE = "minecraft:cobblestone";
const k = (p) => `${p.x},${p.y},${p.z}`;

// Trees we decided not to touch (or couldn't reach). posKey -> expiry tick
const rejected = new Map();

function isRejected(dimId, p, now) {
  return (rejected.get(posKey(dimId, p)) ?? 0) > now;
}

function reject(villager, dimId, positions, now, reason) {
  for (const p of positions) rejected.set(posKey(dimId, p), now + CFG.REJECT_MEMORY);
  debugLog(villager, `skip tree at ${positions[0].x} ${positions[0].y} ${positions[0].z}: ${reason}`);
  if (rejected.size > 5000) for (const [key, exp] of rejected) if (exp < now) rejected.delete(key);
}

// ---------------------------------------------------------------- tree claims
// A lumberjack claims the tree he's working on (and the ground around it where its wood falls).
// Other lumberjacks leave claimed trees alone and don't pick up drops lying there.
const claims = new Map(); // villager id -> {dimId, c:{x,y,z}, logs:Set, until}
const CLAIM_TTL = 20 * 30; // a claim lapses if its owner stops refreshing it (died, unloaded, ...)
const CLAIM_SPACING = 8; // no other lumberjack starts on a tree this close to a claimed one
const WORKING_STATES = new Set(["approach", "fell", "descend", "gather", "replant"]);

function claimTree(villager, dimId, tree, now) {
  claims.set(villager.id, { dimId, c: center(tree.base[0]), logs: new Set(tree.logs.map(k)), until: now + CLAIM_TTL });
}

function refreshClaim(villager, brain, now) {
  const cl = claims.get(villager.id);
  if (!cl) return;
  if (WORKING_STATES.has(brain.state)) cl.until = now + CLAIM_TTL;
  else claims.delete(villager.id);
}

function othersClaims(villager, dimId, now) {
  const out = [];
  for (const [id, cl] of claims) {
    if (cl.until < now) claims.delete(id);
    else if (id !== villager.id && cl.dimId === dimId) out.push(cl);
  }
  return out;
}

/** Is this tree (or the spot right next to it) being worked by another lumberjack? */
function claimedByOther(villager, dimId, tree, now) {
  const others = othersClaims(villager, dimId, now);
  if (!others.length) return false;
  const base = center(tree.base[0]);
  return others.some((cl) => horizDist(cl.c, base) < CLAIM_SPACING || tree.logs.some((l) => cl.logs.has(k(l))));
}

/** Items lying where another lumberjack is working belong to him (nearest claim wins). */
function mineToTake(villager, dimId, now) {
  const others = othersClaims(villager, dimId, now);
  if (!others.length) return undefined;
  const mine = claims.get(villager.id);
  return (loc) => {
    const theirs = Math.min(...others.map((cl) => horizDist(cl.c, loc)));
    if (theirs > CFG.GATHER_RADIUS + 1) return true;
    return !!mine && horizDist(mine.c, loc) < theirs;
  };
}

function pickup(villager, dim, inv) {
  return pickupItems(villager, dim, inv, isWanted, CFG.PICKUP_RADIUS, mineToTake(villager, dim.id, system.currentTick));
}

export function lumberjackThink(villager, dim, brain, now) {
  refreshClaim(villager, brain, now);
  const ws = getWorkstation(villager);
  if (!ws) return unemploy(villager, dim, brain);
  if (!ownsWorkstation(villager, ws)) return unemploy(villager, dim, brain, true); // someone else's job block
  const wsBlock = getBlock(dim, ws);
  // wsBlock undefined = chunk not loaded; keep the job until we can check
  if (wsBlock && wsBlock.typeId !== WORKSTATION) return unemploy(villager, dim, brain, true);

  if (!STATES[brain.state]) setState(villager, brain, "seek");
  offDuty(villager, dim, brain, now, ws, { interruptible: ["seek", "idle"], chestKind: "wood" });
  STATES[brain.state](villager, dim, brain, now, ws);
}

const STATES = {
  seek,
  approach,
  fell,
  descend,
  gather,
  replant,
  home,
  deposit,
  idle,
  shop,
  market: (v, d, b, n, ws) => market(v, d, b, n, ws, { chestKind: "wood", backTo: "seek" }),
  sleep: (v, d, b, n, ws) => sleepState(v, d, b, n, ws, "seek"),
  hide: (v, d, b, n, ws) => hideState(v, d, b, n, ws, "seek"),
};

// ================================================================ seek

function seek(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest"); // stands and looks around while deciding - no aimless strolling
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickup(villager, dim, inv);

  if (needsToUnload(inv) || (!getTool(villager) && vCount(inv, isLog) >= CFG.AXE_COST_LOGS + 2)) {
    return setState(villager, brain, "home");
  }

  const pending = pendingReplants(villager, inv);
  if (pending.length) {
    brain.job = { replant: pending };
    return setState(villager, brain, "replant");
  }

  // Tidy up: saplings/apples/logs lying around (e.g. from leaves that decayed after a felling)
  if (now >= (brain.nextTidy ?? 0)) {
    brain.nextTidy = now + 100;
    const feetY = Math.floor(villager.location.y);
    const tidyJob = { skipItems: brain.tidySkip ?? (brain.tidySkip = new Set()), itemTries: new Map() };
    if (nearestDrop(villager, dim, villager.location, CFG.TIDY_RADIUS, feetY, tidyJob)) {
      brain.job = { ...tidyJob, origin: villager.location, groundY: feetY };
      return setState(villager, brain, "gather");
    }
  }

  // Scan the forest around the workstation a slice at a time
  // (a fresh look round every so often - and when the last one found nothing, a good while later)
  const rescanAfter = brain.scan?.empty ? CFG.RESCAN_EMPTY : CFG.RESCAN_EVERY;
  if (!brain.scan || (brain.scan.done && now - brain.scan.doneAt > rescanAfter)) brain.scan = newScan(ws);
  if (!brain.scan.done) {
    stepScan(dim, brain.scan, CFG.SCAN_COLUMNS_PER_THINK);
    if (!brain.scan.done) return sleep(brain, 2);
    brain.scan.doneAt = now;
    debugLog(villager, `forest scan: ${brain.scan.found.size} trunk(s) found`);
  }

  const candidates = [...brain.scan.found.values()]
    .filter((c) => !isRejected(dim.id, c, now))
    .sort((a, b) => dist(a, villager.location) - dist(b, villager.location));

  let checked = 0;
  for (const c of candidates) {
    if (checked++ >= 4) return sleep(brain, 2); // spread the work over several ticks
    brain.scan.found.delete(k(c));
    const tree = analyzeTree(dim, c);
    if (!tree.ok) {
      reject(villager, dim.id, [c], now, tree.reason);
      continue;
    }
    if (claimedByOther(villager, dim.id, tree, now)) {
      debugLog(villager, `tree at ${fmt(tree.base[0])} is another lumberjack's - leaving it to him`);
      continue; // (not remembered as rejected: it's free again once he's done)
    }
    const spots = standSpotsForTree(dim, tree, villager);
    if (!spots.length) {
      reject(villager, dim.id, [c, ...tree.base, ...tree.logs], now, "no place to stand next to it");
      continue;
    }
    // try a few spots around the trunk before giving up on the tree
    const stand = spots.slice(0, 4).find((s) => navTo(villager, brain, s));
    if (!stand) {
      reject(villager, dim.id, [c, ...tree.base, ...tree.logs], now, "can't find a way there");
      continue;
    }
    debugLog(villager, `going to ${tree.species.replace("minecraft:", "")} tree at ${fmt(tree.base[0])} (${tree.logs.length} logs, ${tree.leaves} leaves)`);
    const spareSpots = spots.slice(spots.indexOf(stand) + 1, spots.indexOf(stand) + 6);
    brain.job = { tree, stand, spareSpots, pillar: [], repositionFails: 0, skipItems: new Set(), itemTries: new Map() };
    claimTree(villager, dim.id, tree, now);
    return setState(villager, brain, "approach");
  }

  // Nothing to chop right now
  if (brain.scan.done) {
    debugLog(villager, "no choppable trees nearby - taking a break");
    brain.scan.empty = true; // (he'll look again in a while, not straight after his break)
    return setState(villager, brain, "idle", CFG.IDLE_TIME);
  }
}

const TREE_STAND_SPOTS = ringOffsets(1, 3, [0, -1, 1]); // up to 3 away: low leaves can crowd the trunk

/** Places to stand right next to the trunk (closest to the trunk first, then closest to us). */
function standSpotsForTree(dim, tree, villager) {
  const inTree = new Set(tree.logs.map(k));
  const toTrunk = (p) => Math.min(...tree.base.map((b) => horizDist(center(p), center(b))));
  const spots = [];
  const seen = new Set();
  for (const b of tree.base) {
    for (const o of TREE_STAND_SPOTS) {
      const p = offset(b, o.x, o.y, o.z);
      if (inTree.has(k(p)) || seen.has(k(p))) continue;
      seen.add(k(p));
      if (!isStandable(dim, p) || LEAVES.has(getBlock(dim, offset(p, 0, -1, 0))?.typeId)) continue; // not up on the leaves
      spots.push({ p, t: Math.round(toTrunk(p) * 2) / 2, v: dist(center(p), villager.location) });
    }
  }
  spots.sort((a, b) => a.t - b.t || a.v - b.v);
  return spots.map((s) => s.p);
}

// ================================================================ approach

function approach(villager, dim, brain, now) {
  const job = brain.job;
  if (!job?.tree) return setState(villager, brain, "seek");
  pickup(villager, dim, getInventory(villager));

  const r = navUpdate(villager, brain, now);
  if (r === "moving") return sleep(brain, 4);
  if (r === "failed") {
    // try the other places to stand around the trunk before giving up on the tree
    while (job.spareSpots?.length) {
      const next = job.spareSpots.shift();
      if (navTo(villager, brain, next)) {
        job.stand = next;
        return sleep(brain, 4);
      }
    }
    // (every log of it: the scan finds a big tree by many of its logs)
    reject(villager, dim.id, [...job.tree.base, ...job.tree.logs], now, "couldn't walk there");
    brain.job = null;
    return setState(villager, brain, "seek");
  }
  // arrived
  setMode(villager, brain, "work");
  holdItem(villager, getTool(villager)?.id);
  setState(villager, brain, "fell");
}

// ================================================================ fell

function fell(villager, dim, brain, now) {
  const job = brain.job;
  if (!job?.tree) return setState(villager, brain, "seek");
  const inv = getInventory(villager);

  // 1. keep chopping the block we're on
  if (brain.action) {
    const brokeId = brain.action.id;
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    if (r === "done" && LOGS.has(brokeId)) wearTool(villager);
    pickup(villager, dim, inv);
    return;
  }

  // 2. walking to a better spot
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    setMode(villager, brain, "work");
    if (r === "failed") job.repositionFails++;
  }

  pickup(villager, dim, inv);
  if (now - brain.since > CFG.FELL_TIMEOUT + job.tree.logs.length * 50) return finishFelling(villager, dim, brain, "took too long");

  // (pillar blocks can sit where trunk logs used to be - those are ours, not the tree's)
  const pillar = new Set(job.pillar.map(k));
  const remaining = job.tree.logs.filter((l) => !pillar.has(k(l)) && getBlock(dim, l)?.typeId === job.tree.species);
  if (!remaining.length) return finishFelling(villager, dim, brain);

  // Safety net: no log came down for 40s -> give up on the rest instead of fiddling forever
  if (remaining.length !== job.lastRemaining) {
    job.lastRemaining = remaining.length;
    job.lastProgressAt = now;
  } else if (now - job.lastProgressAt > 20 * 40) {
    return finishFelling(villager, dim, brain, `no progress on the last ${remaining.length} log(s)`);
  }

  if (now - (job.lastTrace ?? 0) > 100) {
    job.lastTrace = now;
    const l = villager.location;
    const f = floorPos(l);
    const seen = remaining.map((r) => `${fmt(r)}->${firstBlockInSight(dim, villager, r)?.typeId?.replace("minecraft:", "") ?? "none"}@${dist(eyePos(villager), center(r)).toFixed(1)}`).join(", ");
    debugLog(
      villager,
      `felling: ${remaining.length} left, at ${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)}, onGround=${villager.isOnGround}, ` +
        `feet=${getBlock(dim, f)?.typeId} under=${getBlock(dim, offset(f, 0, -1, 0))?.typeId} | sees: ${seen}`
    );
  }

  // 3. chop the lowest log we can reach and see (clearing leaves / logs in the way first)
  const target = pickTarget(villager, dim, remaining, pillar);
  if (target) {
    startBreak(brain, target, getTool(villager));
    return;
  }

  // 4. climb up next to/inside the trunk if the rest is above us
  if (tryPillar(villager, dim, brain, job, remaining, inv)) return;

  // 5. walk somewhere we can reach more of it from
  if (job.repositionFails < 3) {
    const spot = bestSpot(villager, dim, remaining, job);
    if (spot && navTo(villager, brain, spot, { radius: 0.6 })) {
      setWorking(villager, false);
      return sleep(brain, 4);
    }
    job.repositionFails++;
  }

  finishFelling(villager, dim, brain, `${remaining.length} log(s) out of reach`);
}

function pickTarget(villager, dim, remaining, pillar) {
  const eye = eyePos(villager);
  const logSet = new Set(remaining.map(k));
  const feet = floorPos(villager.location);
  const reachable = remaining
    .map((l) => ({ l, d: dist(eye, center(l)) }))
    .filter((e) => e.d <= CFG.CHOP_REACH)
    .sort((a, b) => a.l.y - b.l.y || a.d - b.d);

  // Only chop what he can actually see: the first block on the line from his eyes must be the log
  // (or another log of this tree, or natural leaves in the way, which he clears first).
  for (const { l } of reachable) {
    const hit = firstBlockInSight(dim, villager, l);
    if (!hit) continue; // no line of sight
    const hp = { x: hit.x, y: hit.y, z: hit.z };
    if (pillar.has(k(hp)) || samePos(hp, offset(feet, 0, -1, 0))) continue; // never the block we stand on
    if (dist(eye, center(hp)) > CFG.CHOP_REACH) continue;
    if (samePos(hp, l) || logSet.has(k(hp))) return hit;
    if (LEAVES.has(hit.typeId) && isNaturalLeaf(hit)) return hit;
  }
  return null;
}

function tryPillar(villager, dim, brain, job, remaining, inv) {
  if (job.pillar.length >= CFG.MAX_PILLAR) return false;
  const feet = floorPos(villager.location);
  const eye = eyePos(villager);
  const above = remaining.filter((l) => l.y > feet.y && horizDist(center(l), villager.location) <= 2.5 && dist(eye, center(l)) > CFG.CHOP_REACH);
  if (!above.length) return false;
  if (!villager.isOnGround && (job.airWait = (job.airWait ?? 0) + 1) < 15) return true; // wait until we've landed
  job.airWait = 0;

  const head = getBlock(dim, offset(feet, 0, 2, 0));
  if (!head) return false;
  if (LEAVES.has(head.typeId) && isNaturalLeaf(head)) {
    startBreak(brain, head, getTool(villager)); // leaves above our head
    return true;
  }
  const feetBlock = getBlock(dim, feet);
  const feetWater = feetBlock?.isLiquid && !feetBlock.typeId.includes("lava"); // pillaring up out of a swamp is fine
  if (!isPassable(head) || !(isPassable(feetBlock) || feetWater)) {
    debugLog(villager, `can't pillar here: feet ${feetBlock?.typeId}, above head ${head.typeId}`);
    return false;
  }

  // Jump and place one of our logs under ourselves, like a player pillaring up
  const log = vTake(inv, isLog, 1)[0];
  if (!log) {
    // go grab the logs we just chopped off the ground first
    if ((job.fetchTries = (job.fetchTries ?? 0) + 1) <= 3) {
      const drop = nearestDrop(villager, dim, villager.location, 6, feet.y, job, isLog);
      if (drop?.spot && navTo(villager, brain, drop.spot, { radius: 0.5 })) {
        debugLog(villager, "out of logs to pillar with - picking up drops first");
        return true;
      }
    }
    debugLog(villager, "can't pillar: no logs to stand on");
    return false;
  }
  // a real jump, and the log goes in under him at the top of it
  setMode(villager, brain, "work");
  try {
    villager.applyImpulse({ x: 0, y: 0.42 - Math.max(0, villager.getVelocity().y), z: 0 });
  } catch {}
  job.pillar.push(feet);
  system.runTimeout(() => {
    try {
      const b = getBlock(dim, feet);
      if (villager.location.y >= feet.y + 0.8 && b && (isPassable(b) || (b.isLiquid && !b.typeId.includes("lava")))) {
        b.setType(log);
        playSound(dim, "use.wood", center(feet));
        return;
      }
    } catch {}
    try {
      vAdd(getInventory(villager), new ItemStack(log, 1)); // didn't get high enough - try again
    } catch {}
    const i = job.pillar.findIndex((q) => samePos(q, feet));
    if (i >= 0) job.pillar.splice(i, 1);
  }, 5);
  debugLog(villager, `pillaring up (${job.pillar.length})`);
  sleep(brain, 12);
  return true;
}

/** Standable spot near the remaining logs from which the most of them are in reach. */
function bestSpot(villager, dim, remaining, job) {
  const cols = new Map();
  for (const l of remaining) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) cols.set(`${l.x + dx},${l.z + dz}`, { x: l.x + dx, z: l.z + dz });
    }
  }
  const baseY = job.tree.base[0].y;
  const here = floorPos(villager.location);
  let best;
  let bestScore = 0;
  for (const c of cols.values()) {
    for (let dy = -1; dy <= 2; dy++) {
      const p = { x: c.x, y: baseY + dy, z: c.z };
      if (samePos(p, here)) continue;
      // score first (cheap), only check the terrain for promising spots.
      // More logs in reach is better; being close to them breaks ties.
      const eye = { x: p.x + 0.5, y: p.y + CFG.EYE_HEIGHT, z: p.z + 0.5 };
      let inReach = 0;
      let nearest = Infinity;
      for (const l of remaining) {
        const d = dist(eye, center(l));
        if (d <= CFG.CHOP_REACH) inReach++;
        nearest = Math.min(nearest, d);
      }
      const score = inReach ? inReach + 1 / (1 + nearest) : 0;
      if (score <= bestScore) continue;
      if (!isStandable(dim, p) || LEAVES.has(getBlock(dim, offset(p, 0, -1, 0))?.typeId)) continue; // not on top of leaves
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function finishFelling(villager, dim, brain, why) {
  const job = brain.job;
  if (why) debugLog(villager, `stopped chopping: ${why}`);
  job.origin = center(job.tree.base[0]);
  job.groundY = job.tree.base[0].y;
  setWorking(villager, false);
  brain.action = null;
  navStop(villager, brain);
  if (job.pillar.length) return setState(villager, brain, "descend");
  holdItem(villager, undefined);
  setState(villager, brain, "gather");
}

// ================================================================ descend

function descend(villager, dim, brain, now) {
  const job = brain.job;
  setMode(villager, brain, "work");
  const inv = getInventory(villager);

  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    if (r === "done") wearTool(villager);
    return sleep(brain, 6); // let him drop down
  }
  pickup(villager, dim, inv);
  if (!villager.isOnGround) return sleep(brain, 2);

  while (job.pillar.length) {
    const top = job.pillar.pop();
    const b = getBlock(dim, top);
    if (!b || !LOGS.has(b.typeId)) continue;
    if (dist(eyePos(villager), center(top)) <= CFG.REACH) {
      startBreak(brain, b, getTool(villager));
      return;
    }
    debugLog(villager, `left a pillar block at ${fmt(top)} (out of reach)`);
  }

  setWorking(villager, false);
  holdItem(villager, undefined);
  setState(villager, brain, "gather");
}

// ================================================================ gather

const notOnLeaves = (dim) => (q) => LEAVES.has(getBlock(dim, offset(q, 0, -1, 0))?.typeId);

/**
 * Nearest wanted item near `origin` (within 4 blocks of height `groundY`).
 *   spot      - a place to stand right next to it (walk over and pick it up)
 *   reachSpot - otherwise, a place within reach of it (e.g. it's stuck on/behind leaves he can break)
 */
function nearestDrop(villager, dim, origin, radius, groundY, job, wanted = isWanted) {
  let items = [];
  try {
    items = dim.getEntities({ type: "minecraft:item", location: origin, maxDistance: radius });
  } catch {}
  items.sort((a, b) => dist(a.location, villager.location) - dist(b.location, villager.location));
  const allowed = mineToTake(villager, dim.id, system.currentTick);
  for (const item of items) {
    if (job?.skipItems?.has(item.id)) continue;
    if (allowed && !allowed(item.location)) continue; // another lumberjack's wood
    if (Math.abs(item.location.y - groundY) > 4) continue;
    try {
      if (!wanted(item.getComponent("minecraft:item").itemStack.typeId)) continue;
    } catch {
      continue;
    }
    const at = floorPos(item.location);
    const spot = findStandableNear(dim, at, 1, 2, notOnLeaves(dim));
    if (spot && Math.abs(spot.y - item.location.y) < 1.5) return { item, spot };
    const reachSpot = findStandableNear(dim, at, 3, 4, (q) => notOnLeaves(dim)(q) || dist({ x: q.x + 0.5, y: q.y + CFG.EYE_HEIGHT, z: q.z + 0.5 }, item.location) > CFG.CHOP_REACH);
    if (reachSpot) return { item, reachSpot };
    job?.skipItems?.add(item.id);
  }
  return undefined;
}

/** Natural leaves the item is resting on, or that block his view of it (within reach), if any. */
function leavesInTheWay(villager, dim, item) {
  const eye = eyePos(villager);
  const loc = item.location;
  if (dist(eye, loc) > CFG.CHOP_REACH + 1) return undefined;
  const under = getBlock(dim, { x: Math.floor(loc.x), y: Math.floor(loc.y - 0.1), z: Math.floor(loc.z) });
  const candidates = [];
  if (under && LEAVES.has(under.typeId)) candidates.push(under);
  const onLine = firstBlockOnLine(dim, villager, { x: loc.x, y: loc.y + 0.15, z: loc.z });
  if (onLine && LEAVES.has(onLine.typeId)) candidates.push(onLine);
  for (const leaf of candidates) {
    if (!isNaturalLeaf(leaf) || dist(eye, center(leaf)) > CFG.CHOP_REACH) continue;
    const seen = firstBlockInSight(dim, villager, leaf);
    if (seen && samePos(seen, leaf)) return leaf; // he can see the leaves themselves
    if (seen && LEAVES.has(seen.typeId) && isNaturalLeaf(seen)) return seen; // other leaves first
  }
  return undefined;
}

function gather(villager, dim, brain, now) {
  const job = brain.job;
  const inv = getInventory(villager);
  pickup(villager, dim, inv);

  // breaking leaves that hold / hide an item
  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    return sleep(brain, 8); // let the item drop
  }
  setWorking(villager, false);

  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    setMode(villager, brain, "rest");
    if (r === "failed" && job.target) job.skipItems.add(job.target); // can't get to it - forget it
  }
  if (now - brain.since > CFG.GATHER_TIME || inv.emptySlotsCount === 0) return afterGather(villager, dim, brain);

  const drop = nearestDrop(villager, dim, job.origin, CFG.GATHER_RADIUS, job.groundY, job);
  if (!drop) return afterGather(villager, dim, brain);
  const tries = (job.itemTries.get(drop.item.id) ?? 0) + 1;
  job.itemTries.set(drop.item.id, tries);
  if (tries > 4) {
    job.skipItems.add(drop.item.id);
    return;
  }

  // Leaves in the way? Break them (like a player would), then the item falls or becomes reachable
  const leaf = leavesInTheWay(villager, dim, drop.item);
  if (leaf) {
    setMode(villager, brain, "work");
    startBreak(brain, leaf, getTool(villager));
    debugLog(villager, `breaking leaves at ${fmt(leaf)} to get to a drop`);
    return;
  }

  const spot = drop.spot ?? drop.reachSpot;
  if (!navTo(villager, brain, spot, { radius: 0.5 })) {
    job.skipItems.add(drop.item.id);
    return;
  }
  job.target = drop.item.id;
  sleep(brain, 4);
}

function afterGather(villager, dim, brain) {
  const job = brain.job;
  navStop(villager, brain);
  if (!job.tree) {
    brain.job = null;
    return setState(villager, brain, "seek");
  }
  // Stumps: where the bottom logs were, if a sapling can grow there
  const stumps = [];
  // (a fallen log lying on the ground isn't where the tree grew - only its stump gets a sapling)
  for (const b of job.tree.fallen === "log" ? [] : job.tree.base) {
    const block = getBlock(dim, b);
    const below = getBlock(dim, offset(b, 0, -1, 0));
    if (isPassable(block) && below && SAPLING_GROUND.has(below.typeId)) {
      stumps.push({ x: b.x, y: b.y, z: b.z, sapling: LOG_TO_SAPLING[job.tree.species] });
    }
  }
  brain.job = { replant: stumps };
  setState(villager, brain, "replant");
}

// ================================================================ replant

function replant(villager, dim, brain, now) {
  const job = brain.job;
  const inv = getInventory(villager);
  if (!brain.nav) setMode(villager, brain, "work");

  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    setMode(villager, brain, "work");
    if (r === "failed") {
      const s = job.replant.shift();
      if (s && !s.fresh) addPending(villager, s);
    }
  }

  while (job?.replant?.length) {
    const s = job.replant[0];
    const block = getBlock(dim, s);
    const below = getBlock(dim, offset(s, 0, -1, 0));
    if (!block || !isPassable(block) || SAPLINGS.has(block.typeId) || !below || !SAPLING_GROUND.has(below.typeId)) {
      removePending(villager, s);
      job.replant.shift();
      continue;
    }
    if (vCount(inv, (id) => id === s.sapling) === 0) {
      if (!s.fresh) addPending(villager, s); // no sapling yet - come back when we have one
      job.replant.shift();
      continue;
    }
    // (saplings have no collision, so like a player he can plant one right at his own feet)
    if (!canUse(dim, villager, s)) {
      const spot = findStandableNear(dim, s, 2, 2, (q) => samePos(q, s));
      if (!spot || !navTo(villager, brain, spot, { radius: 0.6 })) {
        if (!s.fresh) addPending(villager, s);
        job.replant.shift();
        continue;
      }
      return sleep(brain, 4);
    }
    vTake(inv, (id) => id === s.sapling, 1);
    placeBlock(villager, dim, s, s.sapling, "dig.grass");
    debugLog(villager, `planted ${s.sapling.replace("minecraft:", "")} at ${fmt(s)}`);
    removePending(villager, s);
    job.replant.shift();
    return sleep(brain, 10);
  }

  brain.job = null;
  setState(villager, brain, needsToUnload(inv) ? "home" : "seek");
}

function readPending(villager) {
  try {
    const raw = villager.getDynamicProperty(DP_REPLANT);
    return typeof raw === "string" ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function addPending(villager, s) {
  const list = readPending(villager).filter((p) => !samePos(p, s));
  list.push(s);
  villager.setDynamicProperty(DP_REPLANT, JSON.stringify(list.slice(-32)));
}

function removePending(villager, s) {
  const list = readPending(villager);
  const next = list.filter((p) => !samePos(p, s));
  if (next.length !== list.length) villager.setDynamicProperty(DP_REPLANT, next.length ? JSON.stringify(next) : undefined);
}

function pendingReplants(villager, inv) {
  return readPending(villager).filter((p) => vCount(inv, (id) => id === p.sapling) > 0);
}

// ================================================================ home & deposit

function home(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  pickup(villager, dim, getInventory(villager));
  const r = walkTo(villager, dim, brain, now, ws);
  if (r === "moving") return sleep(brain, 4);
  if (r === "failed") return sleep(brain, 20); // home chunk not loaded yet
  setMode(villager, brain, "work");
  setState(villager, brain, "deposit");
}

/** Extras = what goes in the chest. He keeps tools, emeralds, a few saplings and logs on him. */
function keepFilter(inv) {
  const keepSaplings = vCount(inv, (id) => SAPLINGS.has(id)) <= CFG.MAX_SAPLINGS_KEPT;
  return (id) => !AXES[id] && id !== "minecraft:emerald" && !(SAPLINGS.has(id) && keepSaplings) && !isLog(id);
}

function deposit(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  // he may have walked off to the village crafting table: his chests are back at his own bench
  if (!brain.nav && !isNearHome(villager, ws, 4)) {
    if (walkTo(villager, dim, brain, now, ws) === "moving") return sleep(brain, 4);
  }
  setMode(villager, brain, "work");
  if (!brain.job?.visit) brain.job = { visit: { tried: new Set(), placed: 0 } };
  const visit = brain.job.visit;
  const chests = stockpileChests(dim, ws, "wood");

  // Crafting happens at a crafting table: the village's nearest, or one he makes from a log
  const table = () => useBench(villager, dim, brain, now, ws, () => vTake(inv, isLog, 1).length === 1);

  // 1a. a stone axe (3 cobblestone + 2 sticks) - he buys the cobblestone from a miner. With no
  //     miner around to buy from, he just keeps making wooden ones.
  const axe = getTool(villager);
  const tableCost = haveBench(dim, ws) ? 0 : 1;
  if (!axe || AXES[axe.id].speed < AXES["minecraft:stone_axe"].speed) {
    const cobble = vCount(inv, (id) => id === COBBLE);
    const stickLogs = vCount(inv, isStick) >= 2 ? 0 : 1;
    if (cobble >= 3 && vCount(inv, isLog) >= stickLogs + tableCost) {
      const t = table();
      if (t === "busy") return sleep(brain, 6);
      if (t) {
        craftAt(villager, dim, t, () => {
          if (stickLogs) {
            vTake(inv, isLog, 1);
            vAdd(inv, new ItemStack("minecraft:stick", 4)); // 1 log -> 4 planks -> 2 of them into 4 sticks
          }
          vTake(inv, isStick, 2);
          vTake(inv, (id) => id === COBBLE, 3);
        }, "minecraft:stone_axe");
        return sleep(brain, 20);
      }
    } else if (cobble < 3 && (brain.cantBuy?.cobblestone ?? 0) <= now) {
      if (minerSellingCobble(villager, dim)) {
        if (goShopping(villager, brain, "cobblestone", 3, "home", now)) return;
      } else if (!brain.saidNoMiner || now - brain.saidNoMiner > 20 * 300) {
        brain.saidNoMiner = now;
        debugLog(villager, "no miner around to buy cobblestone from - sticking with wooden axes");
      }
    }
  }

  // 1b. no axe at all? craft a wooden one at the crafting table (2 logs -> planks + sticks)
  if (!getTool(villager) && vCount(inv, isLog) >= CFG.AXE_COST_LOGS + tableCost) {
    const t = table();
    if (t === "busy") return sleep(brain, 6);
    if (t) {
      craftAt(villager, dim, t, () => vTake(inv, isLog, CFG.AXE_COST_LOGS), "minecraft:wooden_axe");
      return sleep(brain, 20);
    }
  }

  // 2. store extras in a chest (keeping a few logs as building blocks and the shop row untouched)
  const logs = vCount(inv, isLog);
  const storeLogs = Math.max(0, logs - CFG.KEEP_LOGS);
  const keep = keepFilter(inv);
  const hasExtras = storeLogs > 0 || vCount(inv, keep) > 0;
  if (hasExtras) {
    for (const { block, container } of chests) {
      const key = k(block);
      if (visit.tried.has(key)) continue;
      visit.tried.add(key);
      if (!canUse(dim, villager, block, CFG.REACH + 1)) continue; // not through the wall of his shed
      lookAt(villager, center(block));
      playSound(dim, "random.chestopen", center(block));
      const reserve = logs > CFG.KEEP_LOGS ? vTake(inv, isLog, CFG.KEEP_LOGS) : [];
      storeInto(inv, container, (id) => keep(id) || (isLog(id) && storeLogs > 0));
      for (const id of reserve) vAdd(inv, new ItemStack(id, 1));
      system.runTimeout(() => playSound(dim, "random.chestclosed", center(block)), 12);
      return sleep(brain, 16);
    }

    // all chests full (or none yet): craft a chest from 2 logs and place it
    if (visit.placed < 2 && vCount(inv, isLog) >= CFG.CHEST_COST_LOGS) {
      const t = table();
      if (t === "busy") return sleep(brain, 6);
      const spot = t && putDown(villager, dim, brain, now, ws, "minecraft:chest");
      if (spot === "busy") return sleep(brain, 4);
      if (spot) {
        vTake(inv, isLog, CFG.CHEST_COST_LOGS);
        addStockpile(dim.id, spot, "wood", villager.id);
        visit.placed++;
        visit.tried.clear();
        debugLog(villager, `placed a new wood chest at ${fmt(spot)}`);
        return sleep(brain, 16);
      }
    }
    if (vFreeSlots(inv) === 0) {
      debugLog(villager, "nowhere to store items");
      return finishDeposit(villager, brain, true);
    }
  }

  // 3. restock his shop row (bottom row) from what he carries and his chests
  restockSellRow(villager, chests.map((c) => c.container));
  finishDeposit(villager, brain);
}

/** A miner nearby with cobblestone to spare. */
function minerSellingCobble(villager, dim) {
  try {
    return dim
      .getEntities({ type: villager.typeId, location: villager.location, maxDistance: 96 })
      .some((e) => e.getProperty(PROP_PROFESSION) === Profession.MINER && spareOf(e, "cobblestone") >= 3);
  } catch {
    return false;
  }
}

/** Crafting at the table: looks at it, uses up the ingredients, gets the item. */
function craftAt(villager, dim, table, consume, result) {
  lookAt(villager, center(table));
  consume();
  giveTool(villager, result);
  playSound(dim, "dig.wood", center(table), 1.4);
  particle(dim, "minecraft:villager_happy", offset(center(table), 0, 0.8, 0));
  debugLog(villager, `crafted a ${result.replace("minecraft:", "").replace("_", " ")}`);
}

function finishDeposit(villager, brain, stuck = false) {
  brain.job = null;
  setState(villager, brain, stuck ? "idle" : "seek", stuck ? CFG.IDLE_TIME * 2 : 0);
}

// ================================================================ idle

// Nothing to chop: instead of wandering aimlessly he goes back to his crafting table, keeps an eye
// out, and plants saplings he's carrying on open ground nearby so there's wood to cut later.
function idle(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickup(villager, dim, inv);
  if (brain.idleInfo?.since !== brain.since) {
    brain.idleInfo = { since: brain.since, walked: false, planted: false };
    if (shopForTool(villager, dim, brain, "axe", "idle", now)) return; // doing well: a better axe off the armorer
  }
  const info = brain.idleInfo;

  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }

  // 1. back to the workstation
  if (!info.walked) {
    info.walked = true;
    if (!isNearHome(villager, ws)) {
      const spot = spotNextTo(dim, ws, villager);
      if (spot && navTo(villager, brain, spot, { radius: 0.9 })) return sleep(brain, 4);
    }
  }
  setMode(villager, brain, "rest");

  // 2. grow new trees around home
  if (!info.planted) {
    info.planted = true;
    const spots = newTreeSpots(dim, ws, inv);
    if (spots.length) {
      debugLog(villager, `no trees to cut - planting ${spots.length} new sapling(s) around home`);
      brain.job = { replant: spots };
      return setState(villager, brain, "replant");
    }
  }

  if (now - brain.since >= (brain.idleFor || CFG.IDLE_TIME)) return setState(villager, brain, "seek");
  sleep(brain, CFG.THINK_IDLE);
}

// Saplings that grow into a tree on their own (dark/pale oak need 2x2, mangroves need mud)
const NEW_TREE_SAPLINGS = [
  "minecraft:oak_sapling",
  "minecraft:birch_sapling",
  "minecraft:spruce_sapling",
  "minecraft:jungle_sapling",
  "minecraft:acacia_sapling",
  "minecraft:cherry_sapling",
  "minecraft:poplar_sapling",
];
const PLANT_GROUND = new Set(["minecraft:grass_block", "minecraft:dirt", "minecraft:podzol", "minecraft:coarse_dirt", "minecraft:rooted_dirt"]);

function newTreeSpots(dim, ws, inv) {
  const stock = new Map();
  for (const id of NEW_TREE_SAPLINGS) {
    const n = vCount(inv, (x) => x === id);
    if (n) stock.set(id, n);
  }
  if (!stock.size) return [];

  const out = [];
  for (let attempt = 0; attempt < 60 && out.length < CFG.NEW_TREES_PER_IDLE && stock.size; attempt++) {
    const dx = Math.floor(Math.random() * 21) - 10;
    const dz = Math.floor(Math.random() * 21) - 10;
    if (Math.abs(dx) <= 3 && Math.abs(dz) <= 3) continue; // keep the workshop clear
    let p;
    for (let dy = -3; dy <= 3 && !p; dy++) {
      const q = { x: ws.x + dx, y: ws.y + dy, z: ws.z + dz };
      const b = getBlock(dim, q);
      const below = getBlock(dim, offset(q, 0, -1, 0));
      if (b?.isAir && below && PLANT_GROUND.has(below.typeId)) p = q;
    }
    if (!p || !roomForTree(dim, p) || out.some((o) => horizDist(center(o), center(p)) < 4)) continue;
    // plant whatever we have the most of
    const [sapling] = [...stock.entries()].sort((a, b) => b[1] - a[1])[0];
    out.push({ ...p, sapling, fresh: true });
    const left = stock.get(sapling) - 1;
    if (left > 0) stock.set(sapling, left);
    else stock.delete(sapling);
  }
  return out;
}

/**
 * Somewhere a tree can actually grow: open sky, nothing woody or built within 2 blocks (it needs
 * the room) - and it has to be next to the woods. He plants to fill gaps in the forest and extend
 * its edge, never out in the middle of a field.
 */
function roomForTree(dim, p) {
  for (let y = 1; y <= 6; y++) if (!getBlock(dim, offset(p, 0, y, 0))?.isAir) return false;
  let neighbours = 0;
  for (let dx = -TREE_NEIGHBOUR_R; dx <= TREE_NEIGHBOUR_R; dx++) {
    for (let dz = -TREE_NEIGHBOUR_R; dz <= TREE_NEIGHBOUR_R; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        const id = getBlock(dim, offset(p, dx, dy, dz))?.typeId ?? "";
        const woody = LOGS.has(id) || SAPLINGS.has(id) || LEAVES.has(id);
        const close = Math.abs(dx) <= 2 && Math.abs(dz) <= 2 && dy >= 0 && dy <= 2;
        if (close && (woody || /chest|crafting_table|door|fence|planks/.test(id))) return false;
        if (woody) neighbours++;
      }
    }
  }
  return neighbours > 0;
}

const TREE_NEIGHBOUR_R = 6; // a new sapling has to have a tree (or another sapling) this close

// ================================================================ helpers

function needsToUnload(inv) {
  return inv.emptySlotsCount <= 1 || vCount(inv, isLog) >= CFG.RETURN_AT_LOGS;
}

function fmt(p) {
  return `${p.x} ${p.y} ${p.z}`;
}
