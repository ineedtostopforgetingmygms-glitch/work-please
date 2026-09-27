// Cartographer - works at a cartography table:
//   plan     works out what to do next (everything below)
//   shore    looks for water to grow sugar cane by: the shore nearest his table, up to
//            CARTO.WATER_RADIUS blocks away, becomes his sugar cane patch
//   wild     no sugar cane to plant? he cuts some wild cane nearby (leaving the bottom to regrow)...
//   trader   ...or, failing that, buys some off a wandering trader (wanderer.js)
//   tend     plants cane along his patch and harvests it once it's grown - planting more as he goes
//   pond     no water within CARTO.WATER_RADIUS: he buys iron, makes a bucket, fetches water from a
//            well or a farm (fill), digs a 2x2 pond by his table and pours two buckets in on the
//            diagonal - an infinite water source - and plants his cane round it
//   craft    at the crafting table next to his cartography table: cane -> paper, 9 paper -> a map,
//            4 iron + 1 redstone -> a compass (now and again), and the bucket
//   shop     iron from the armorer, redstone from the miner, logs from the lumberjack (shopping.js)
//            TODO(blacksmith): the pond's bucket iron should come from the blacksmith once he exists
//   tax      every so often (a long while) he goes round the whole village collecting emeralds -
//            the more a villager has, the bigger the share he takes
//   stash    paper, maps and compasses into his chest, restocks his shop row
//   market   his trading hours: stands at his cartography table and sells (market.js)
import { ItemStack, world } from "@minecraft/server";
import { BUILD_BLOCK, BUILD_BLOCK_EXCEPTIONS, CARTO, CFG, KEEP_CLEAR, LOGS, VILLAGER_ID } from "../config.js";
import { freeze, setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { holdItem, pickupItems, placeBlock, startBreak, updateBreak } from "../actions.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { addStockpile } from "../registry.js";
import { emeralds } from "../economy.js";
import { storeInto, vAdd, vCount, vFreeSlots, vTake } from "../inventory.js";
import { restockSellRow } from "../trade.js";
import { canUse, center, dist, findStandableNear, floorPos, getBlock, getInventory, horizDist, isPassable, isSolidGround, isValid, lookAt, offset, particle, playSound, ringOffsets, samePos } from "../util.js";
import { getWorkstation, ownsWorkstation, unemploy } from "./employment.js";
import { isNearHome, spotNextTo, stockpileChests, walkTo } from "./common.js";
import { benchNear, forgetBenches, placeSpotNear, putDown } from "./workshop.js";
import { fetchWood, woodState } from "./wood.js";
import { goShopping, shop } from "./shopping.js";
import { market } from "./market.js";
import { hideState, offDuty, sleepState } from "./rest.js";
import { claimedByOther } from "./fields.js";
import { goToTrader, traderState } from "./wanderer.js";

const WORKSTATIONS = ["minecraft:cartography_table"];
const CHEST = "maps";
const TABLE = "minecraft:crafting_table";
const DP_PATCH = "iv:cane"; // {d, spots:[{x,y,z}] (the ground under each cane), pond?:{x,y,z,done}}
const DP_TIMERS = "iv:carto"; // {compass, tax} - world time the next one is due

const CANE_ITEM = "minecraft:sugar_cane";
// the block is "reeds" in older Bedrock versions and "sugar_cane" in newer ones
const CANE_BLOCKS = new Set(["minecraft:sugar_cane", "minecraft:reeds"]);
const PAPER = "minecraft:paper";
const MAP = "minecraft:empty_map";
const COMPASS = "minecraft:compass";
const IRON = "minecraft:iron_ingot";
const REDSTONE = "minecraft:redstone";
const BUCKET = "minecraft:bucket";
const WATER_BUCKET = "minecraft:water_bucket";
// sugar cane grows on these, next to water
const CANE_GROUND = new Set([
  "minecraft:grass_block",
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:rooted_dirt",
  "minecraft:dirt_with_roots",
  "minecraft:podzol",
  "minecraft:mycelium",
  "minecraft:moss_block",
  "minecraft:pale_moss_block",
  "minecraft:mud",
  "minecraft:muddy_mangrove_roots",
  "minecraft:sand",
  "minecraft:red_sand",
]);
const DIGGABLE = new Set([...CANE_GROUND].filter((id) => !/sand|mud|roots/.test(id)));

const isCane = (id) => id === CANE_ITEM;
const isLog = (id) => LOGS.has(id);
const isProduct = (id) => id === PAPER || id === MAP || id === COMPASS;
const isWanted = (id) => isCane(id) || isProduct(id) || id === "minecraft:dirt" || isLog(id);
const isWater = (b) => !!b && b.isLiquid && !b.typeId.includes("lava");
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;
const k = (p) => `${p.x},${p.y},${p.z}`;
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function cartographerThink(villager, dim, brain, now) {
  const ws = getWorkstation(villager);
  if (!ws) return unemploy(villager, dim, brain);
  if (!ownsWorkstation(villager, ws)) return unemploy(villager, dim, brain, true);
  const wsBlock = getBlock(dim, ws);
  if (wsBlock && !WORKSTATIONS.includes(wsBlock.typeId)) return unemploy(villager, dim, brain, true);
  if (!STATES[brain.state]) setState(villager, brain, "plan");
  offDuty(villager, dim, brain, now, ws, { interruptible: ["plan", "idle", "shore"], chestKind: CHEST });
  STATES[brain.state](villager, dim, brain, now, ws);
}

const STATES = {
  plan,
  shore,
  wild,
  trader: (v, d, b, n) => traderState(v, d, b, n),
  tend,
  pond,
  fill,
  craft,
  shop,
  wood: woodState,
  tax,
  stash,
  idle,
  market: (v, d, b, n, ws) => market(v, d, b, n, ws, { chestKind: CHEST, backTo: "plan" }),
  sleep: (v, d, b, n, ws) => sleepState(v, d, b, n, ws, "plan"),
  hide: (v, d, b, n, ws) => hideState(v, d, b, n, ws, "plan"),
};

// ================================================================ saved state

function readJson(villager, key) {
  try {
    const raw = villager.getDynamicProperty(key);
    return typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function getPatch(villager, dim) {
  const p = readJson(villager, DP_PATCH);
  return p && p.d === dim.id && Array.isArray(p.spots) ? p : undefined;
}

function savePatch(villager, patch) {
  villager.setDynamicProperty(DP_PATCH, patch ? JSON.stringify(patch) : undefined);
}

/** World time, which (unlike the script tick counter) carries on across reloads. */
function worldTime() {
  try {
    return world.getAbsoluteTime();
  } catch {
    return 0;
  }
}

function timers(villager) {
  const t = readJson(villager, DP_TIMERS) ?? {};
  const at = worldTime();
  // first time round: his first compass a little way in, the first tax round a good while off
  let changed = false;
  if (typeof t.compass !== "number") {
    t.compass = at + Math.floor(CARTO.COMPASS_EVERY / 3);
    changed = true;
  }
  if (typeof t.tax !== "number") {
    t.tax = at + CARTO.TAX_EVERY;
    changed = true;
  }
  if (changed) villager.setDynamicProperty(DP_TIMERS, JSON.stringify(t));
  return t;
}

function setTimer(villager, which, ticksFromNow) {
  const t = timers(villager);
  t[which] = worldTime() + ticksFromNow;
  villager.setDynamicProperty(DP_TIMERS, JSON.stringify(t));
}

const due = (villager, which) => worldTime() >= timers(villager)[which];

// ================================================================ the patch

/** A block of ground sugar cane would grow on: the right soil, water beside it, room above. */
function caneSpot(dim, p) {
  const ground = getBlock(dim, p);
  if (!ground || !CANE_GROUND.has(ground.typeId)) return false;
  const above = getBlock(dim, offset(p, 0, 1, 0));
  if (!above) return false;
  if (!CANE_BLOCKS.has(above.typeId) && !above.isAir && (!isPassable(above) || above.isLiquid || KEEP_CLEAR.test(above.typeId))) return false;
  return SIDES.some(([dx, dz]) => isWater(getBlock(dim, offset(p, dx, 0, dz))));
}

/** The ground block at the top of a column (under grass, flowers or cane), or undefined. */
function groundAt(dim, x, z) {
  let b;
  try {
    b = dim.getTopmostBlock({ x, z });
  } catch {
    return undefined; // not loaded
  }
  while (b && !b.isLiquid && (b.isAir || isPassable(b))) b = b.below();
  return b;
}

const SHORE_COLUMNS = ringOffsets(0, CARTO.WATER_RADIUS, [0]);

/** Walks the shore search outwards from his table, a slice per think. */
function shore(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest");
  setWorking(villager, false);
  const s = (brain.shoreScan ??= { i: 0, unloaded: 0 });
  const end = Math.min(SHORE_COLUMNS.length, s.i + CARTO.SCAN_PER_THINK);
  for (; s.i < end; s.i++) {
    const o = SHORE_COLUMNS[s.i];
    const g = groundAt(dim, ws.x + o.x, ws.z + o.z);
    if (!g) {
      s.unloaded++;
      continue;
    }
    if (g.isLiquid || Math.abs(g.y - ws.y) > 24) continue;
    const p = { x: g.x, y: g.y, z: g.z };
    if (!caneSpot(dim, p) || claimedByOther(dim.id, villager.id, p)) continue;
    // found the nearest shore: everything along it close by is his patch
    const spots = patchAround(dim, villager, p);
    savePatch(villager, { d: dim.id, spots });
    brain.shoreScan = null;
    debugLog(villager, `found water to grow sugar cane by at ${fmt(p)} (${Math.round(horizDist(p, ws))} blocks from his table) - ${spots.length} spots`);
    return setState(villager, brain, "plan");
  }
  if (s.i < SHORE_COLUMNS.length) return sleep(brain, 2);
  brain.shoreScan = null;
  brain.noShore = true;
  debugLog(villager, `no water within ${CARTO.WATER_RADIUS} blocks of his table${s.unloaded ? ` (${s.unloaded} columns not loaded)` : ""} - he'll dig his own pond`);
  setState(villager, brain, "plan");
}

/** Every cane spot along the shore within CARTO.PATCH_RADIUS of the first one, nearest first. */
function patchAround(dim, villager, first) {
  const out = [];
  const r = CARTO.PATCH_RADIUS;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const p = { x: first.x + dx, y: first.y + dy, z: first.z + dz };
        if (!caneSpot(dim, p)) continue;
        const id = getBlock(dim, offset(p, 0, 1, 0))?.typeId ?? "";
        if (BUILD_BLOCK.test(id) && !BUILD_BLOCK_EXCEPTIONS.has(id)) continue;
        out.push(p);
        break;
      }
    }
  }
  return out
    .filter((p) => !claimedByOther(dim.id, villager.id, p))
    .sort((a, b) => dist(a, first) - dist(b, first))
    .slice(0, CARTO.PATCH_SPOTS);
}

/** Height of the cane standing on `g` (0 = none). */
function caneHeight(dim, g) {
  let h = 0;
  while (h < 4 && CANE_BLOCKS.has(getBlock(dim, offset(g, 0, h + 1, 0))?.typeId ?? "")) h++;
  return h;
}

function patchStatus(dim, patch) {
  const free = [];
  const grown = [];
  let planted = 0;
  for (const g of patch.spots) {
    const h = caneHeight(dim, g);
    if (h > 0) planted++;
    if (h >= 2) grown.push(g);
    else if (h === 0 && caneSpot(dim, g)) free.push(g);
  }
  return { free, grown, planted };
}

// ================================================================ plan

function plan(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest");
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  if (vFreeSlots(inv) <= 1 || vCount(inv, isProduct) >= CARTO.RETURN_AT || vCount(inv, isCane) >= CARTO.RETURN_AT * 2) return setState(villager, brain, "stash");

  // tax day
  if (due(villager, "tax")) return startTax(villager, dim, brain, now, ws);

  // 1. somewhere to grow sugar cane: the nearest shore, or a pond of his own
  let patch = getPatch(villager, dim);
  if (!patch) {
    if (!brain.noShore) return setState(villager, brain, "shore");
    const r = pondPlan(villager, dim, brain, now, ws, inv, undefined);
    if (r === "busy") return;
    return setState(villager, brain, "idle", CFG.IDLE_TIME);
  }
  if (patch.pond?.done && !holeOf(patch.pond).every((p) => isWater(getBlock(dim, p)))) {
    patch.pond.done = false; // somebody's drained it: fill it up again
    savePatch(villager, patch);
  }
  if (patch.pond && !patch.pond.done) {
    const r = pondPlan(villager, dim, brain, now, ws, inv, patch);
    if (r === "busy") return;
    if (r === "stuck") return setState(villager, brain, "idle", CFG.IDLE_TIME);
    patch = getPatch(villager, dim);
  }

  // 2. the patch: harvest what's grown, plant what's bare (as long as he has cane)
  const st = patchStatus(dim, patch);
  if (!patch.spots.length || (!st.planted && !st.free.length && !patch.pond)) {
    // the shore's gone (built over, dried up): find another one
    debugLog(villager, "his sugar cane patch is gone - he'll look for another");
    savePatch(villager, undefined);
    brain.noShore = false;
    return setState(villager, brain, "idle", CFG.SHORT_PAUSE);
  }
  const cane = vCount(inv, isCane);
  const stock = stockOf(villager, dim, ws);
  const spareCane = cane - (st.free.length ? CARTO.KEEP_CANE : 0);
  const paper = vCount(inv, (id) => id === PAPER);
  const wantsMaps = (stock.get(MAP) ?? 0) < CARTO.MAPS_WANTED;
  const wantsPaper = (stock.get(PAPER) ?? 0) < CARTO.PAPER_WANTED + (wantsMaps ? CARTO.PAPER_PER_MAP : 0);
  const makePaper = spareCane >= 3 && wantsPaper;
  const makeMaps = paper >= CARTO.PAPER_PER_MAP && wantsMaps;
  // a good armful already: off to the crafting table with it before he cuts any more
  if ((makePaper && spareCane >= 32) || makeMaps) {
    if (craftAtTable(villager, dim, brain, now, ws, inv, makeMaps ? "map" : "paper", spareCane)) return;
  }
  if (st.grown.length || (st.free.length && cane)) {
    const targets = [...st.grown.map((g) => ({ g, harvest: true })), ...(cane ? st.free.map((g) => ({ g })) : [])];
    targets.sort((a, b) => dist(center(a.g), villager.location) - dist(center(b.g), villager.location));
    brain.job = { targets };
    return setState(villager, brain, "tend");
  }

  // 3. nothing planted and nothing to plant: find some cane to get started
  if (!st.planted && !cane) {
    if (findWildCane(dim, ws, patch)) {
      brain.job = { wild: { started: now } };
      return setState(villager, brain, "wild");
    }
    if (goToTrader(villager, dim, brain, now, { item: CANE_ITEM, count: CARTO.TRADER_CANE, price: CARTO.TRADER_PRICE, then: "plan" })) return;
    if ((brain.saidNoCane ?? 0) <= now) {
      brain.saidNoCane = now + 20 * 300;
      debugLog(villager, "no sugar cane growing anywhere near and no wandering trader about - he'll wait for one");
    }
  }

  // 4. paper and maps, at the crafting table next to his cartography table
  if (makePaper || makeMaps) {
    if (craftAtTable(villager, dim, brain, now, ws, inv, makePaper ? "paper" : "map", spareCane)) return;
  }

  // 5. now and again, a compass: iron from the armorer, redstone from the miner
  if (due(villager, "compass")) {
    const r = compassPlan(villager, dim, brain, now, ws, inv, stock);
    if (r) return;
  }

  // 6. stock that isn't on his stall yet
  if (vCount(inv, isProduct) > 0 && !brain.stashedIdle) {
    brain.stashedIdle = true;
    return setState(villager, brain, "stash");
  }
  brain.stashedIdle = false;
  setState(villager, brain, "idle", CFG.IDLE_TIME);
}

/** What he has of each product: his chests, his shop row and his pockets. */
function stockOf(villager, dim, ws) {
  const out = new Map();
  const add = (id, n) => out.set(id, (out.get(id) ?? 0) + n);
  const inv = getInventory(villager);
  for (let i = 0; i < inv.size; i++) {
    const it = inv.getItem(i);
    if (it) add(it.typeId, it.amount);
  }
  for (const { container } of stockpileChests(dim, ws, CHEST)) {
    for (let i = 0; i < container.size; i++) {
      const it = container.getItem(i);
      if (it) add(it.typeId, it.amount);
    }
  }
  return out;
}

/** Off to the crafting table to make `what` (`n`: how much cane he can spare for paper). True if he's going. */
function craftAtTable(villager, dim, brain, now, ws, inv, what, n = 0) {
  if (!benchNear(dim, ws, 2) && vCount(inv, isLog) < 1) {
    // the crafting table goes right next to his cartography table - it takes a log
    return buyLogs(villager, brain, now, 1, "for a crafting table next to his cartography table");
  }
  brain.job = { craft: what, n };
  setState(villager, brain, "craft");
  return true;
}

function buyLogs(villager, brain, now, need, why, then = "plan") {
  if ((brain.cantBuy?.logs ?? 0) > now && (brain.noWoodUntil ?? 0) > now) return false;
  debugLog(villager, `needs logs ${why}`);
  return goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, then, now) || fetchWood(villager, brain, need, then, now);
}

/**
 * A compass: 4 iron ingots from the armorer and a redstone from the miner. True if he's off
 * shopping or crafting; false (and the next try put off a while) if he can't get what he needs.
 */
function compassPlan(villager, dim, brain, now, ws, inv, stock) {
  if ((stock.get(COMPASS) ?? 0) >= CARTO.COMPASS_WANTED) {
    setTimer(villager, "compass", CARTO.COMPASS_EVERY);
    return false;
  }
  const later = (why) => {
    debugLog(villager, `no compass this time: ${why}`);
    setTimer(villager, "compass", CFG.BUY_RETRY);
    return false;
  };
  const iron = vCount(inv, (id) => id === IRON);
  if (iron < CARTO.COMPASS_IRON) {
    if (goShopping(villager, brain, "iron_ingot", CARTO.COMPASS_IRON - iron, "plan", now)) return true;
    return later("nobody selling iron");
  }
  if (vCount(inv, (id) => id === REDSTONE) < 1) {
    if (goShopping(villager, brain, "redstone", 1, "plan", now)) return true;
    return later("nobody selling redstone");
  }
  return craftAtTable(villager, dim, brain, now, ws, inv, "compass");
}

// ================================================================ getting started: wild cane

/** The nearest wild sugar cane around his table that isn't in his own patch. */
function findWildCane(dim, ws, patch, bad) {
  const mine = new Set((patch?.spots ?? []).map((g) => k(offset(g, 0, 1, 0))));
  const r = CARTO.WILD_RADIUS;
  let best;
  let bestD = Infinity;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const d = dx * dx + dz * dz;
      if (d >= bestD) continue;
      for (let dy = -6; dy <= 6; dy++) {
        const p = { x: ws.x + dx, y: ws.y + dy, z: ws.z + dz };
        if (!CANE_BLOCKS.has(getBlock(dim, p)?.typeId ?? "")) continue;
        if (CANE_BLOCKS.has(getBlock(dim, offset(p, 0, -1, 0))?.typeId ?? "")) continue; // not the bottom
        if (mine.has(k(p)) || bad?.has(k(p))) break;
        best = p;
        bestD = d;
        break;
      }
    }
  }
  return best;
}

/** Cuts wild cane: the top of it, leaving the bottom to grow back (all of it if it's a stub). */
function wild(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  const job = brain.job?.wild;
  if (!job) return setState(villager, brain, "plan");
  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    return sleep(brain, 6); // give the drops a moment to land
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed" && job.target) (job.bad ??= new Set()).add(k(job.target));
  }
  if (vCount(inv, isCane) >= CARTO.START_CANE || now - job.started > 20 * 90) {
    debugLog(villager, `got ${vCount(inv, isCane)} sugar cane from the wild`);
    brain.job = null;
    return setState(villager, brain, "plan");
  }
  const base = findWildCane(dim, ws, getPatch(villager, dim), job.bad);
  if (!base) {
    debugLog(villager, `no more wild sugar cane about - got ${vCount(inv, isCane)}`);
    brain.job = null;
    return setState(villager, brain, "plan");
  }
  job.target = base;
  const h = caneHeight(dim, offset(base, 0, -1, 0));
  const cut = h >= 2 ? offset(base, 0, 1, 0) : base; // the second block brings down all above it
  if (canUse(dim, villager, cut)) {
    setMode(villager, brain, "work");
    lookAt(villager, center(cut));
    startBreak(brain, getBlock(dim, cut), undefined);
    brain.action.left = 2; // sugar cane breaks at a touch
    setWorking(villager, true);
    if (h < 2) (job.bad ??= new Set()).add(k(base));
    return;
  }
  const spot = findStandableNear(dim, base, 2, 2, (q) => samePos(q, base));
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9, partial: true })) {
    (job.bad ??= new Set()).add(k(base));
    return sleep(brain, 4);
  }
  sleep(brain, 4);
}

// ================================================================ tend

function tend(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  const job = brain.job;
  pickupItems(villager, dim, inv, isWanted);
  if (!job?.targets?.length) return collectDrops(villager, dim, brain, now) || finishTending(villager, brain);

  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    pickupItems(villager, dim, inv, isWanted, 2.5);
    return sleep(brain, 6);
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed") job.targets.shift();
  }
  if (now - brain.since > CARTO.TEND_TIME || vFreeSlots(inv) === 0) return finishTending(villager, brain);

  const t = job.targets[0];
  if (!t) return finishTending(villager, brain);
  const g = t.g;
  const top = offset(g, 0, 1, 0);
  const h = caneHeight(dim, g);
  if (t.harvest ? h < 2 : h > 0 || !caneSpot(dim, g) || !vCount(inv, isCane)) {
    // (harvest: it hasn't grown / was cut already. planting: taken, gone, or he's out of cane)
    job.targets.shift(); // someone got there first, or he's run out of cane
    return;
  }

  if (canUse(dim, villager, top)) {
    setMode(villager, brain, "work");
    if (t.harvest) {
      // cut the second block: everything above it comes down, the bottom one grows back
      const cut = offset(g, 0, 2, 0);
      lookAt(villager, center(cut));
      startBreak(brain, getBlock(dim, cut), undefined);
      brain.action.left = 2;
      setWorking(villager, true);
      job.targets.shift();
      return;
    }
    if (plantCane(villager, dim, top)) {
      vTake(inv, isCane, 1);
      debugLog(villager, `planted sugar cane at ${fmt(top)}`);
    }
    job.targets.shift();
    return sleep(brain, 6);
  }

  const spot = findStandableNear(dim, top, 2, 2, (q) => samePos(q, top)) ?? spotNextTo(dim, top, villager);
  // (his patch can be a long way off: partial routes get him there a stretch at a time)
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9, partial: true })) {
    job.targets.shift();
    return;
  }
  sleep(brain, 4);
}

function plantCane(villager, dim, p) {
  const b = getBlock(dim, p);
  if (b && !b.isAir && isPassable(b)) {
    try {
      b.setType("minecraft:air"); // the grass or flower standing there
    } catch {}
  }
  for (const id of CANE_BLOCKS) {
    if (placeBlock(villager, dim, p, id, "dig.grass")) return true;
  }
  return false;
}

/** The cane that fell when he cut it: he walks over the drops before heading back. */
function collectDrops(villager, dim, brain, now) {
  const job = brain.job;
  if (!job || (job.collected ?? 0) >= 12) return false;
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") {
      sleep(brain, 4);
      return true;
    }
  }
  let items = [];
  try {
    items = dim.getEntities({ type: "minecraft:item", location: villager.location, maxDistance: 8 });
  } catch {}
  const drop = items.find((e) => {
    try {
      return isCane(e.getComponent("minecraft:item")?.itemStack?.typeId ?? "");
    } catch {
      return false;
    }
  });
  if (!drop) return false;
  job.collected = (job.collected ?? 0) + 1;
  const spot = findStandableNear(dim, floorPos(drop.location), 1, 2);
  if (!spot || !navTo(villager, brain, spot, { radius: 0.6 })) return false;
  sleep(brain, 4);
  return true;
}

function finishTending(villager, brain) {
  brain.job = null;
  setWorking(villager, false);
  setState(villager, brain, "plan");
}

// ================================================================ no water about: his own pond

/**
 * Everything the pond needs, one step at a time: a site, a bucket (iron - see the TODO on the
 * blacksmith), the hole dug, and two buckets of water poured in on the diagonal.
 * @returns "busy" (off doing one of those), "done", or "stuck"
 */
function pondPlan(villager, dim, brain, now, ws, inv, patch) {
  // a site for it
  if (!patch) {
    const site = pondSite(dim, ws, villager);
    if (!site) {
      if ((brain.saidNoPond ?? 0) <= now) {
        brain.saidNoPond = now + 20 * 300;
        debugLog(villager, "no flat open ground near his table for a pond");
      }
      return "stuck";
    }
    savePatch(villager, { d: dim.id, spots: site.ring, pond: { ...site.hole[0], done: false } });
    debugLog(villager, `he'll dig a pond for his sugar cane at ${fmt(site.hole[0])}`);
    setState(villager, brain, "plan");
    return "busy";
  }
  const hole = holeOf(patch.pond);
  // two sources on the diagonal: the other two corners fill in by themselves - infinite water
  if (isWater(getBlock(dim, hole[0])) && isWater(getBlock(dim, hole[3]))) {
    for (const p of [hole[1], hole[2]]) if (!isWater(getBlock(dim, p))) getBlock(dim, p)?.setType("minecraft:water");
  }
  if (hole.every((p) => isWater(getBlock(dim, p)))) {
    patch.pond.done = true;
    savePatch(villager, patch);
    debugLog(villager, "his pond is full - an infinite water source to grow sugar cane round");
    return "done";
  }

  // a bucket: 3 iron ingots
  // TODO(blacksmith): buy the iron (or the bucket) from the blacksmith once there is one; until
  // then anyone with iron ingots to spare (the armorer smelts them) will do.
  const hasBucket = vCount(inv, (id) => id === BUCKET || id === WATER_BUCKET) > 0;
  if (!hasBucket) {
    if (vCount(inv, (id) => id === IRON) >= CARTO.BUCKET_IRON) return craftAtTable(villager, dim, brain, now, ws, inv, "bucket") ? "busy" : "stuck";
    if (goShopping(villager, brain, "iron_ingot", CARTO.BUCKET_IRON - vCount(inv, (id) => id === IRON), "plan", now, true)) return "busy";
    return "stuck";
  }

  // dig the hole
  const toDig = hole.filter((p) => {
    const b = getBlock(dim, p);
    return b && !b.isAir && !isWater(b);
  });
  if (toDig.length) {
    brain.job = { dig: toDig };
    setState(villager, brain, "pond");
    return "busy";
  }

  // water: fetch a bucketful and pour it in, on the diagonal
  if (!vCount(inv, (id) => id === WATER_BUCKET)) {
    brain.job = null;
    setState(villager, brain, "fill");
    return "busy";
  }
  brain.job = { pour: true };
  setState(villager, brain, "pond");
  return "busy";
}

/** The 2x2 hole from its north-west corner. [0] and [3] are the diagonal the water goes in. */
function holeOf(c) {
  return [
    { x: c.x, y: c.y, z: c.z },
    { x: c.x + 1, y: c.y, z: c.z },
    { x: c.x, y: c.y, z: c.z + 1 },
    { x: c.x + 1, y: c.y, z: c.z + 1 },
  ];
}

/**
 * Flat soil near his table for a 2x2 pond with a ring of ground round it for the cane: all one
 * height, open sky, nobody's field or house.
 */
function pondSite(dim, ws, villager) {
  for (const o of ringOffsets(2, CARTO.POND_RADIUS, [0])) {
    const g = groundAt(dim, ws.x + o.x, ws.z + o.z);
    if (!g || g.isLiquid || !DIGGABLE.has(g.typeId) || Math.abs(g.y - ws.y) > 3) continue;
    const c = { x: g.x, y: g.y, z: g.z };
    const hole = holeOf(c);
    const ring = [];
    let ok = true;
    for (let dx = -1; dx <= 2 && ok; dx++) {
      for (let dz = -1; dz <= 2 && ok; dz++) {
        const p = { x: c.x + dx, y: c.y, z: c.z + dz };
        const b = getBlock(dim, p);
        const above = getBlock(dim, offset(p, 0, 1, 0));
        const inHole = dx >= 0 && dx <= 1 && dz >= 0 && dz <= 1;
        if (!b || !above || !(inHole ? DIGGABLE : CANE_GROUND).has(b.typeId)) ok = false;
        else if (!above.isAir && (!isPassable(above) || KEEP_CLEAR.test(above.typeId))) ok = false;
        else if (!isSolidGround(getBlock(dim, offset(p, 0, -1, 0)))) ok = false; // no caves under it
        else if (!inHole && (dx === -1 || dx === 2) !== (dz === -1 || dz === 2)) ring.push(p); // sides, not corners
      }
    }
    if (!ok || claimedByOther(dim.id, villager.id, c, 3)) continue;
    let sky = true;
    for (let h = 2; h <= 5 && sky; h++) if (!getBlock(dim, offset(c, 0, h, 0))?.isAir) sky = false;
    if (!sky) continue;
    return { hole, ring };
  }
  return undefined;
}

/** Digging the pond out, and pouring the water in. */
function pond(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  const patch = getPatch(villager, dim);
  if (!patch?.pond) return setState(villager, brain, "plan");
  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    return sleep(brain, 4);
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed") brain.tries++;
  }
  if (brain.tries > 6) {
    debugLog(villager, "can't get at his pond - he'll try again later");
    brain.job = null;
    return setState(villager, brain, "idle", CFG.IDLE_TIME);
  }
  const hole = holeOf(patch.pond);

  // pouring: the diagonal first; the other two fill in by themselves
  if (brain.job?.pour) {
    const target = [hole[0], hole[3]].find((p) => !isWater(getBlock(dim, p)));
    if (!target) {
      brain.job = null;
      return setState(villager, brain, "plan");
    }
    if (!vCount(inv, (id) => id === WATER_BUCKET)) return setState(villager, brain, "plan");
    if (canUse(dim, villager, target)) {
      setMode(villager, brain, "work");
      lookAt(villager, center(target));
      holdItem(villager, WATER_BUCKET);
      vTake(inv, (id) => id === WATER_BUCKET, 1);
      vAdd(inv, new ItemStack(BUCKET, 1));
      getBlock(dim, target).setType("minecraft:water");
      playSound(dim, "bucket.empty_water", center(target));
      debugLog(villager, `poured a bucket of water into his pond at ${fmt(target)}`);
      holdItem(villager, undefined);
      brain.job = null;
      return setState(villager, brain, "plan");
    }
    return walkNear(villager, dim, brain, target, hole);
  }

  // digging
  const p = (brain.job?.dig ?? []).find((q) => {
    const b = getBlock(dim, q);
    return b && !b.isAir && !isWater(b);
  });
  if (!p) {
    brain.job = null;
    return setState(villager, brain, "plan");
  }
  const above = getBlock(dim, offset(p, 0, 1, 0));
  const target = above && !above.isAir && isPassable(above) ? offset(p, 0, 1, 0) : p; // grass on top first
  if (canUse(dim, villager, target)) {
    setMode(villager, brain, "work");
    lookAt(villager, center(target));
    startBreak(brain, getBlock(dim, target), undefined);
    setWorking(villager, true);
    return;
  }
  walkNear(villager, dim, brain, p, hole);
}

/** Walks up to the pond - never standing down in the hole he's digging. */
function walkNear(villager, dim, brain, p, hole) {
  const inHole = (q) => hole.some((h) => h.x === q.x && h.z === q.z && q.y <= h.y + 1);
  const spot = findStandableNear(dim, offset(p, 0, 1, 0), 2, 2, inHole);
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9 })) brain.tries++;
  sleep(brain, 4);
}

/** Fills his bucket from a well, a farm's water channel - anywhere with water that refills. */
function fill(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  if (vCount(inv, (id) => id === WATER_BUCKET) || !vCount(inv, (id) => id === BUCKET)) return setState(villager, brain, "plan");
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed" && brain.job?.water) {
      (brain.badWater ??= new Set()).add(k(brain.job.water)); // can't get to that one
      brain.job = null;
    }
  }
  const patch = getPatch(villager, dim);
  const own = patch?.pond ? holeOf(patch.pond).map(k) : [];
  const water = brain.job?.water && isWater(getBlock(dim, brain.job.water)) ? brain.job.water : findWater(dim, ws, brain, own);
  if (water === undefined) return sleep(brain, 2); // still looking
  if (water === "none") {
    debugLog(villager, `no water anywhere within ${CARTO.WATER_SEARCH} blocks to fill his bucket`);
    return setState(villager, brain, "idle", 20 * 60);
  }
  brain.job = { water };
  if (canUse(dim, villager, water)) {
    setMode(villager, brain, "work");
    lookAt(villager, center(water));
    vTake(inv, (id) => id === BUCKET, 1);
    vAdd(inv, new ItemStack(WATER_BUCKET, 1));
    getBlock(dim, water).setType("minecraft:air"); // scooped up - an infinite source fills back in
    playSound(dim, "bucket.fill_water", center(water));
    debugLog(villager, `filled his bucket at ${fmt(water)}`);
    brain.job = null;
    return setState(villager, brain, "plan");
  }
  // dry ground beside it - he doesn't climb into the well
  const wet = (q) => isWater(getBlock(dim, q));
  const spot = findStandableNear(dim, water, 2, 2, wet) ?? findStandableNear(dim, water, 3, 3, wet);
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9, partial: true })) {
    (brain.badWater ??= new Set()).add(k(water));
    brain.job = null;
    return sleep(brain, 20);
  }
  sleep(brain, 4);
}

/**
 * A water source that refills when scooped (two more water blocks beside it), nearest first -
 * searched a slice per think. @returns the position, undefined (still looking) or "none"
 */
function findWater(dim, ws, brain, exclude) {
  const bad = brain.badWater;
  const skip = new Set(exclude);
  const s = (brain.waterScan ??= { i: 0 });
  const end = Math.min(SHORE_COLUMNS.length, s.i + CARTO.SCAN_PER_THINK);
  for (; s.i < end; s.i++) {
    const o = SHORE_COLUMNS[s.i];
    if (Math.max(Math.abs(o.x), Math.abs(o.z)) > CARTO.WATER_SEARCH) break;
    for (let dy = -4; dy <= 4; dy++) {
      const p = { x: ws.x + o.x, y: ws.y + dy, z: ws.z + o.z };
      const b = getBlock(dim, p);
      if (!isWater(b) || bad?.has(k(p)) || skip.has(k(p))) continue;
      try {
        if ((b.permutation.getState("liquid_depth") ?? 0) !== 0) continue; // flowing, not a source
      } catch {}
      let n = 0;
      for (const [dx, dz] of SIDES) if (isWater(getBlock(dim, offset(p, dx, 0, dz)))) n++;
      if (n < 2) continue;
      brain.waterScan = null;
      return p;
    }
  }
  if (s.i < end || s.i >= SHORE_COLUMNS.length) {
    brain.waterScan = null;
    return "none";
  }
  return undefined;
}

// ================================================================ craft

function craft(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  const what = brain.job?.craft;
  if (!what) return setState(villager, brain, "plan");

  // his crafting table stands right next to his cartography table
  const table = ownTable(villager, dim, brain, now, ws, inv);
  if (table === "busy") return sleep(brain, 4);
  if (!table) {
    brain.job = null;
    return setState(villager, brain, "idle", 20 * 30);
  }
  if (!canUse(dim, villager, table)) {
    const r = walkTo(villager, dim, brain, now, table);
    if (r === "moving") return sleep(brain, 4);
    if (!canUse(dim, villager, table)) {
      brain.tries++;
      if (brain.tries > 4) {
        brain.job = null;
        return setState(villager, brain, "idle", 20 * 30);
      }
      return sleep(brain, 10);
    }
  }
  setMode(villager, brain, "work");
  const c = center(table);
  lookAt(villager, c);

  let made = "";
  if (what === "paper") {
    // 3 cane -> 3 paper, as much as he can spare (keeping some cane back to plant)
    const n = Math.floor(Math.min(brain.job.n ?? 0, vCount(inv, isCane), 64) / 3) * 3; // an armful at a time
    if (n < 3) return backToPlan(villager, brain);
    vTake(inv, isCane, n);
    give(villager, dim, PAPER, n);
    made = `${n} paper`;
  } else if (what === "map") {
    const n = Math.floor(vCount(inv, (id) => id === PAPER) / CARTO.PAPER_PER_MAP);
    const maps = Math.min(n, 4);
    if (maps < 1) return backToPlan(villager, brain);
    vTake(inv, (id) => id === PAPER, maps * CARTO.PAPER_PER_MAP);
    give(villager, dim, MAP, maps);
    playSound(dim, "ui.cartography_table.take_result", c);
    made = `${maps} map${maps > 1 ? "s" : ""}`;
  } else if (what === "compass") {
    if (vCount(inv, (id) => id === IRON) < CARTO.COMPASS_IRON || vCount(inv, (id) => id === REDSTONE) < 1) return backToPlan(villager, brain);
    vTake(inv, (id) => id === IRON, CARTO.COMPASS_IRON);
    vTake(inv, (id) => id === REDSTONE, 1);
    give(villager, dim, COMPASS, 1);
    setTimer(villager, "compass", CARTO.COMPASS_EVERY);
    made = "a compass";
  } else if (what === "bucket") {
    if (vCount(inv, (id) => id === IRON) < CARTO.BUCKET_IRON) return backToPlan(villager, brain);
    vTake(inv, (id) => id === IRON, CARTO.BUCKET_IRON);
    give(villager, dim, BUCKET, 1);
    made = "a bucket";
  }
  playSound(dim, "dig.wood", c, 1.4);
  particle(dim, "minecraft:villager_happy", offset(c, 0, 0.8, 0));
  debugLog(villager, `crafted ${made}`);
  backToPlan(villager, brain);
}

/**
 * The crafting table right next to his cartography table: there already, or one he makes from a
 * log and stands there. If there's no room beside it at all he makes do with the village's nearest.
 * @returns its position, "busy" (walking / just placed it), or undefined
 */
function ownTable(villager, dim, brain, now, ws, inv) {
  const table = benchNear(dim, ws, 2);
  if (table) {
    if (canUse(dim, villager, table)) return table;
    const r = walkTo(villager, dim, brain, now, table);
    if (r === "moving") return "busy";
    if (canUse(dim, villager, table)) return table;
    brain.tries++;
    return brain.tries > 4 ? undefined : "busy";
  }
  brain.tableSpot ??= placeSpotNear(dim, ws, villager, { radius: 2 }) ?? null;
  if (!brain.tableSpot) {
    const village = benchNear(dim, ws);
    if (!village) debugLog(villager, "no room next to his cartography table for a crafting table");
    brain.tableSpot = undefined;
    if (!village) return undefined;
    if (canUse(dim, villager, village)) return village;
    const r = walkTo(villager, dim, brain, now, village);
    return r === "failed" ? undefined : "busy";
  }
  if (vCount(inv, isLog) < 1) {
    brain.tableSpot = undefined;
    return undefined;
  }
  const spot = brain.tableSpot;
  if (!canUse(dim, villager, spot)) {
    const r = walkTo(villager, dim, brain, now, spot);
    if (r !== "failed") return "busy";
  }
  brain.tableSpot = undefined;
  if (!placeBlock(villager, dim, spot, TABLE, "use.wood")) return undefined;
  forgetBenches();
  vTake(inv, isLog, 1);
  debugLog(villager, `made a crafting table and stood it next to his cartography table at ${fmt(spot)}`);
  return "busy";
}

function give(villager, dim, id, n) {
  const rest = vAdd(getInventory(villager), new ItemStack(id, n));
  if (rest) dim.spawnItem(rest, villager.location);
}

function backToPlan(villager, brain) {
  brain.job = null;
  setState(villager, brain, "plan");
}

// ================================================================ taxes

/** What a villager with `n` emeralds pays: a bigger share the richer he is, never below the floor. */
export function taxOn(n) {
  if (n <= CARTO.TAX_FLOOR) return 0;
  const band = CARTO.TAX_BANDS.find((b) => n >= b.from);
  if (!band) return 0;
  return Math.max(0, Math.min(n - CARTO.TAX_FLOOR, Math.floor(n * band.rate)));
}

function startTax(villager, dim, brain, now, ws) {
  setTimer(villager, "tax", CARTO.TAX_EVERY);
  let payers = [];
  try {
    payers = dim
      .getEntities({ type: VILLAGER_ID, location: { x: ws.x + 0.5, y: ws.y, z: ws.z + 0.5 }, maxDistance: CARTO.TAX_RADIUS })
      .filter((e) => e.id !== villager.id && taxOn(emeralds(e)) > 0)
      .sort((a, b) => dist(a.location, ws) - dist(b.location, ws))
      .map((e) => e.id);
  } catch {}
  if (!payers.length) {
    debugLog(villager, "tax day - but nobody in the village has enough emeralds to pay any");
    return setState(villager, brain, "plan");
  }
  brain.job = { tax: { queue: payers, started: now, got: 0, from: 0 } };
  debugLog(villager, `tax day: ${payers.length} villager(s) to collect from`);
  setState(villager, brain, "tax");
}

function tax(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const t = brain.job?.tax;
  if (!t) return setState(villager, brain, "plan");
  const done = () => {
    debugLog(villager, `tax round done: ${t.got} emerald(s) from ${t.from} villager(s)`);
    holdItem(villager, undefined);
    navStop(villager, brain);
    brain.job = null;
    setState(villager, brain, "plan");
  };
  if (!t.queue.length || now - t.started > CARTO.TAX_TIMEOUT) return done();

  let payer;
  try {
    payer = dim.getEntities({ type: VILLAGER_ID, location: villager.location, maxDistance: CARTO.TAX_RADIUS * 2 }).find((e) => e.id === t.queue[0]);
  } catch {}
  if (!payer || !isValid(payer)) {
    t.queue.shift();
    t.tries = 0;
    navStop(villager, brain);
    return sleep(brain, 2);
  }

  if (horizDist(villager.location, payer.location) <= 2.5 && Math.abs(villager.location.y - payer.location.y) < 2) {
    navStop(villager, brain);
    setMode(villager, brain, "work");
    freeze(payer, 30);
    lookAt(villager, { x: payer.location.x, y: payer.location.y + 1.5, z: payer.location.z });
    lookAt(payer, { x: villager.location.x, y: villager.location.y + 1.5, z: villager.location.z });
    const owed = taxOn(emeralds(payer));
    if (owed > 0) {
      const paid = vTake(getInventory(payer), (id) => id === "minecraft:emerald", owed).length;
      give(villager, dim, "minecraft:emerald", paid);
      t.got += paid;
      t.from++;
      holdItem(villager, "minecraft:emerald");
      playSound(dim, "mob.villager.no", payer.location); // nobody likes paying
      playSound(dim, "random.orb", villager.location, 1.2);
      particle(dim, "minecraft:villager_angry", { x: payer.location.x, y: payer.location.y + 2.1, z: payer.location.z });
      debugLog(villager, `collected ${paid} emerald(s) in tax from #${String(payer.id).slice(-4)}`);
    }
    t.queue.shift();
    t.tries = 0;
    return sleep(brain, 30);
  }

  // they're about their business - go to wherever they are now
  const target = floorPos(payer.location);
  if (brain.nav && horizDist(center(brain.nav.goal), payer.location) > 3) navStop(villager, brain);
  if (!brain.nav) {
    const spot = findStandableNear(dim, target, 2, 3);
    if (!spot || !navTo(villager, brain, spot, { radius: 1.5, partial: true })) {
      t.tries = (t.tries ?? 0) + 1;
      if (t.tries > 4) t.queue.shift();
      return sleep(brain, 10);
    }
  }
  const r = navUpdate(villager, brain, now);
  if (r === "failed") {
    t.tries = (t.tries ?? 0) + 1;
    if (t.tries > 4) t.queue.shift();
  }
  sleep(brain, 4);
}

// ================================================================ stash

function stash(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  holdItem(villager, undefined);
  const r = walkTo(villager, dim, brain, now, ws);
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");

  if (!brain.job?.visit) brain.job = { visit: { tried: new Set(), placed: 0 } };
  const visit = brain.job.visit;
  const chests = stockpileChests(dim, ws, CHEST);

  // he keeps his emeralds, bucket, the cane he plants with, iron/redstone for a compass and a log
  const cane = vCount(inv, isCane);
  const extra = (id) => isProduct(id) || id === "minecraft:dirt" || (isCane(id) && cane > 16);

  if (vCount(inv, extra) > 0) {
    for (const { block, container } of chests) {
      const key = fmt(block);
      if (visit.tried.has(key)) continue;
      visit.tried.add(key);
      if (!canUse(dim, villager, block, CFG.REACH + 1)) continue;
      lookAt(villager, center(block));
      playSound(dim, "random.chestopen", center(block));
      const keepCane = cane > 16 ? vTake(inv, isCane, 16).length : 0;
      storeInto(inv, container, extra);
      if (keepCane) vAdd(inv, new ItemStack(CANE_ITEM, keepCane));
      return sleep(brain, 16);
    }
    if (visit.placed < 2) {
      if (vCount(inv, isLog) < CFG.CHEST_COST_LOGS) {
        if (!chests.length && buyLogs(villager, brain, now, CFG.CHEST_COST_LOGS, "for a chest", "stash")) return;
      } else {
        const spot = putDown(villager, dim, brain, now, ws, "minecraft:chest");
        if (spot === "busy") return sleep(brain, 4);
        if (spot) {
          vTake(inv, isLog, CFG.CHEST_COST_LOGS);
          addStockpile(dim.id, spot, CHEST, villager.id);
          visit.placed++;
          visit.tried.clear();
          debugLog(villager, `placed a chest for his maps at ${fmt(spot)}`);
          return sleep(brain, 16);
        }
      }
    }
  }

  restockSellRow(villager, chests.map((c) => c.container));
  brain.job = null;
  setState(villager, brain, "plan");
}

// ================================================================ idle

function idle(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  pickupItems(villager, dim, getInventory(villager), isWanted);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  if (brain.idleInfo?.since !== brain.since) {
    brain.idleInfo = { since: brain.since };
    if (!isNearHome(villager, ws)) {
      const spot = spotNextTo(dim, ws, villager);
      if (spot && navTo(villager, brain, spot, { radius: 0.9 })) return sleep(brain, 4);
    }
  }
  setMode(villager, brain, "rest");
  if (now - brain.since >= (brain.idleFor || CFG.IDLE_TIME)) return setState(villager, brain, "plan");
  sleep(brain, CFG.THINK_IDLE);
}
