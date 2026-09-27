// Butcher - works at a smoker:
//   supply   works out what to do next (in this order): a pen for his animals, cook the raw meat he
//            has, butcher the extra animals, breed the ones he's got, bring more animals in, buy
//            feed, take his goods home
//   craft    no pen anywhere near: he buys logs off the lumberjack, puts a crafting table down next
//            to his smoker and makes fences and a gate
//   pen      builds a 7x7 pen of fences with a gate in it, on a flat patch near his smoker
//   herd     finds a cow, pig, sheep or chicken out and about that isn't in anybody's pen...
//   lead     ...holds its favourite food up and walks it back to his pen (it follows the food), in
//            through the gate and leaves it there
//   breed    two of a kind in the pen and some feed on him: he feeds them and they have a baby
//   butcher  more than two grown animals of a kind: the extras go (he never touches the babies)
//   cook     raw meat into the smoker (twice as quick as a furnace), cooked meat out
//   stash    his goods into his chest, restocks his shop row
//   market   his trading hours: stands at his smoker and sells (market.js)
import { BlockPermutation, ItemStack, system, world } from "@minecraft/server";
import { BUTCH, CFG, KEEP_CLEAR, LOGS } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { holdItem, pickupItems, placeBlock } from "../actions.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { addStockpile } from "../registry.js";
import { storeInto, vAdd, vCount, vFreeSlots, vTake } from "../inventory.js";
import { restockSellRow } from "../trade.js";
import { canUse, center, dist, findStandableNear, floorPos, getBlock, getInventory, horizDist, isPassable, isSolidGround, isValid, lookAt, offset, particle, playSound, ringOffsets } from "../util.js";
import { addXp } from "../xp.js";
import { getWorkstation, ownsWorkstation, unemploy } from "./employment.js";
import { isNearHome, spotNextTo, stockpileChests, walkTo } from "./common.js";
import { benchNear, forgetBenches, placeSpotNear, putDown } from "./workshop.js";
import { fetchWood, woodState } from "./wood.js";
import { goShopping, shop } from "./shopping.js";
import { market } from "./market.js";
import { hideState, offDuty, sleepState } from "./rest.js";
import { pickStack, plankFuel, smeltStep } from "./smelting.js";

const WORKSTATIONS = ["minecraft:smoker", "minecraft:lit_smoker"];
const CHEST = "meat";
const TABLE = "minecraft:crafting_table";
const FENCE = "minecraft:oak_fence";
const GATE = "minecraft:fence_gate"; // (the oak one)
const DP_PEN = "iv:pen"; // {d, x0, z0, x1, z1, y, gate: {x,y,z}} - inside corners, fence height
const DP_BRED = "iv:bred"; // {kind: world time} when he last bred each kind
const isLog = (id) => LOGS.has(id);
const isStick = (id) => id === "minecraft:stick";
const isFuel = (id) => id === "minecraft:coal" || id === "minecraft:charcoal";
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;

// the animals he keeps, what they eat, and what they're good for
export const ANIMALS = {
  "minecraft:cow": { food: ["minecraft:wheat"], good: "wheat" },
  "minecraft:sheep": { food: ["minecraft:wheat"], good: "wheat" },
  "minecraft:pig": { food: ["minecraft:carrot", "minecraft:potato", "minecraft:beetroot"], good: "carrot" },
  "minecraft:chicken": { food: ["minecraft:wheat_seeds", "minecraft:beetroot_seeds", "minecraft:pumpkin_seeds", "minecraft:melon_seeds"], good: "seeds" },
};
const COOKED = {
  "minecraft:beef": "minecraft:cooked_beef",
  "minecraft:porkchop": "minecraft:cooked_porkchop",
  "minecraft:chicken": "minecraft:cooked_chicken",
  "minecraft:mutton": "minecraft:cooked_mutton",
};
const isRaw = (id) => id in COOKED;
const isFood = (id) => Object.values(ANIMALS).some((a) => a.food.includes(id));
const PRODUCTS = new Set([...Object.values(COOKED), "minecraft:leather", "minecraft:feather", "minecraft:white_wool", "minecraft:egg"]);
const isProduct = (id) => PRODUCTS.has(id) || id.endsWith("_wool");
const isWanted = (id) => isRaw(id) || isProduct(id) || isFood(id) || isLog(id) || isStick(id) || isFuel(id) || id === FENCE || id === GATE;

export function butcherThink(villager, dim, brain, now) {
  const ws = getWorkstation(villager);
  if (!ws) return unemploy(villager, dim, brain);
  if (!ownsWorkstation(villager, ws)) return unemploy(villager, dim, brain, true);
  const wsBlock = getBlock(dim, ws);
  if (wsBlock && !WORKSTATIONS.includes(wsBlock.typeId)) return unemploy(villager, dim, brain, true);
  if (!STATES[brain.state]) setState(villager, brain, "supply");
  offDuty(villager, dim, brain, now, ws, { interruptible: ["supply", "idle"], chestKind: CHEST });
  STATES[brain.state](villager, dim, brain, now, ws);
}

const STATES = {
  supply,
  shop,
  wood: woodState,
  craft,
  pen: buildPen,
  herd,
  lead,
  breed,
  butcher: butcherState,
  cook,
  stash,
  idle,
  market: (v, d, b, n, ws) => market(v, d, b, n, ws, { chestKind: CHEST, backTo: "supply" }),
  sleep: (v, d, b, n, ws) => sleepState(v, d, b, n, ws, "supply"),
  hide: (v, d, b, n, ws) => hideState(v, d, b, n, ws, "supply"),
};

// ================================================================ the pen

function loadPen(villager, dim) {
  try {
    const p = JSON.parse(villager.getDynamicProperty(DP_PEN) ?? "null");
    return p && p.d === dim.id ? p : undefined;
  } catch {
    return undefined;
  }
}

function savePen(villager, pen) {
  try {
    villager.setDynamicProperty(DP_PEN, pen ? JSON.stringify(pen) : undefined);
  } catch {}
}

const inPen = (pen, loc) => loc.x >= pen.x0 - 0.1 && loc.x <= pen.x1 + 1.1 && loc.z >= pen.z0 - 0.1 && loc.z <= pen.z1 + 1.1 && Math.abs(loc.y - pen.y) < 2.5;
const penCenter = (pen) => ({ x: Math.floor((pen.x0 + pen.x1) / 2), y: pen.y, z: Math.floor((pen.z0 + pen.z1) / 2) });
const isFencing = (id) => /fence|_wall$/.test(id ?? "");

/** Is his pen still standing (the gate there, the corners fenced)? Unloaded counts as fine. */
function penIntact(dim, pen) {
  const g = getBlock(dim, pen.gate);
  if (!g) return true;
  if (!/fence_gate$/.test(g.typeId)) return false;
  for (const [x, z] of [[pen.x0 - 1, pen.z0 - 1], [pen.x1 + 1, pen.z0 - 1], [pen.x0 - 1, pen.z1 + 1], [pen.x1 + 1, pen.z1 + 1]]) {
    const b = getBlock(dim, { x, y: pen.y, z });
    if (b && !isFencing(b.typeId)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- finding a pen that's already there

const GATE_LOOK = ringOffsets(0, BUTCH.PEN_SEARCH, [0, 1, -1, 2, -2]);

/**
 * Looks for a pen near his smoker a slice at a time: a fence gate with an enclosed patch behind it.
 * Returns the pen, "none", or undefined while still looking.
 */
function stepPenScan(dim, brain, ws) {
  const s = (brain.penScan ??= { i: 0 });
  const end = Math.min(GATE_LOOK.length, s.i + 800);
  for (; s.i < end; s.i++) {
    const o = GATE_LOOK[s.i];
    const g = offset(ws, o.x, o.y, o.z);
    if (!/fence_gate$/.test(getBlock(dim, g)?.typeId ?? "")) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const pen = enclosure(dim, offset(g, dx, 0, dz), g);
      if (pen) {
        brain.penScan = null;
        return pen;
      }
    }
  }
  if (s.i >= GATE_LOOK.length) {
    brain.penScan = null;
    return "none";
  }
  return undefined;
}

/** Floods the ground behind a gate: if it's fenced in (and not too big), that's a pen. */
function enclosure(dim, start, gate) {
  const open = (p) => {
    const b = getBlock(dim, p);
    return b && (b.isAir || (isPassable(b) && !/fence_gate$/.test(b.typeId))) && !b.isLiquid;
  };
  if (!open(start)) return undefined;
  const seen = new Set([`${start.x},${start.z}`]);
  const queue = [start];
  let x0 = start.x;
  let x1 = start.x;
  let z0 = start.z;
  let z1 = start.z;
  while (queue.length) {
    const p = queue.pop();
    if (seen.size > BUTCH.PEN_MAX_AREA) return undefined; // that's the great outdoors
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = { x: p.x + dx, y: p.y, z: p.z + dz };
      const key = `${q.x},${q.z}`;
      if (seen.has(key)) continue;
      const b = getBlock(dim, q);
      if (!b) return undefined;
      if (isFencing(b.typeId) || /fence_gate$/.test(b.typeId)) continue;
      if (!open(q)) {
        // a step up or down inside the pen is fine; a wall of something solid counts as fencing
        const up = offset(q, 0, 1, 0);
        if (isSolidGround(b) && open(up) && !isFencing(getBlock(dim, offset(up, 0, 1, 0))?.typeId)) return undefined; // you could hop out
        continue;
      }
      if (!isSolidGround(getBlock(dim, offset(q, 0, -1, 0)))) {
        if (open(offset(q, 0, -1, 0))) return undefined; // a hole in the ground... it isn't a pen
      }
      seen.add(key);
      queue.push(q);
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      z0 = Math.min(z0, q.z);
      z1 = Math.max(z1, q.z);
    }
  }
  if (seen.size < BUTCH.PEN_MIN_AREA) return undefined;
  return { d: dim.id, x0, z0, x1, z1, y: start.y, gate: { x: gate.x, y: gate.y, z: gate.z } };
}

// ---------------------------------------------------------------- a new pen

const SITES = ringOffsets(4, BUTCH.PEN_SITE_RADIUS, [0, 1, -1]);
const NO_PEN_HERE = /dirt_path|grass_path|farmland|_bed$|door|chest|furnace|smoker|crafting_table|torch|rail|composter|bell$|stonecutter|cartography|blast_furnace|bench|lantern|campfire|_sign$/;

/**
 * A flat, clear 7x7 patch near his smoker for a new pen (a slice of the search per call).
 * Returns the plan, "none", or undefined while still looking.
 */
function stepSiteScan(dim, brain, ws) {
  const s = (brain.siteScan ??= { i: 0 });
  const r = BUTCH.PEN_INNER; // inside is r x r, fences round it
  const end = Math.min(SITES.length, s.i + 25);
  for (; s.i < end; s.i++) {
    const o = SITES[s.i];
    const x0 = ws.x + o.x;
    const z0 = ws.z + o.z;
    const y = ws.y + o.y;
    let ok = true;
    for (let dx = -1; dx <= r && ok; dx++) {
      for (let dz = -1; dz <= r && ok; dz++) {
        const g = getBlock(dim, { x: x0 + dx, y: y - 1, z: z0 + dz });
        const f = getBlock(dim, { x: x0 + dx, y, z: z0 + dz });
        const h = getBlock(dim, { x: x0 + dx, y: y + 1, z: z0 + dz });
        if (!g || !f || !h) ok = false;
        else if (!isSolidGround(g) || NO_PEN_HERE.test(g.typeId)) ok = false;
        else if (!(f.isAir || (isPassable(f) && !KEEP_CLEAR.test(f.typeId))) || f.isLiquid) ok = false;
        else if (!(h.isAir || isPassable(h)) || h.isLiquid) ok = false;
      }
    }
    // not right up against his smoker (he needs to get to it)
    if (ok && ws.x >= x0 - 2 && ws.x <= x0 + r + 1 && ws.z >= z0 - 2 && ws.z <= z0 + r + 1) ok = false;
    if (!ok) continue;
    brain.siteScan = null;
    // the gate on the side facing his smoker
    const cx = x0 + Math.floor(r / 2);
    const cz = z0 + Math.floor(r / 2);
    const dx = ws.x - cx;
    const dz = ws.z - cz;
    const gate = Math.abs(dx) >= Math.abs(dz) ? { x: dx > 0 ? x0 + r : x0 - 1, y, z: cz } : { x: cx, y, z: dz > 0 ? z0 + r : z0 - 1 };
    return { d: dim.id, x0, z0, x1: x0 + r - 1, z1: z0 + r - 1, y, gate };
  }
  if (s.i >= SITES.length) {
    brain.siteScan = null;
    return "none";
  }
  return undefined;
}

/** The fence posts round a planned pen (the gate spot left out), in walking order. */
function fenceLine(pen) {
  const out = [];
  const { x0, z0, x1, z1, y } = pen;
  for (let x = x0 - 1; x <= x1 + 1; x++) out.push({ x, y, z: z0 - 1 });
  for (let z = z0; z <= z1 + 1; z++) out.push({ x: x1 + 1, y, z });
  for (let x = x1; x >= x0 - 1; x--) out.push({ x, y, z: z1 + 1 });
  for (let z = z1; z >= z0; z--) out.push({ x: x0 - 1, y, z });
  return out.filter((p) => !(p.x === pen.gate.x && p.z === pen.gate.z));
}

// ================================================================ supply

function supply(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest");
  setWorking(villager, false);
  holdItem(villager, undefined);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  if (vFreeSlots(inv) <= 2 || vCount(inv, isProduct) >= BUTCH.RETURN_AT) return setState(villager, brain, "stash");

  // 1. a pen: one that's already there near his smoker, or one he builds
  let pen = loadPen(villager, dim);
  if (pen && now >= (brain.penCheck ?? 0)) {
    brain.penCheck = now + 20 * 30;
    if (!penIntact(dim, pen)) {
      debugLog(villager, "his pen isn't there any more");
      pen = undefined;
      savePen(villager, undefined);
    }
  }
  if (!pen) {
    const found = stepPenScan(dim, brain, ws);
    if (found === undefined) return sleep(brain, 2);
    if (found !== "none") {
      savePen(villager, found);
      debugLog(villager, `using the pen at ${found.x0} ${found.y} ${found.z0} (gate at ${fmt(found.gate)})`);
      return sleep(brain, 4);
    }
    return planPen(villager, dim, brain, now, ws, inv);
  }

  // 2. raw meat: into the smoker
  if (vCount(inv, isRaw) >= BUTCH.COOK_AT || (vCount(inv, isRaw) > 0 && now >= (brain.cookAnyway ?? 0))) {
    if (vCount(inv, isFuel) > 0 || vCount(inv, isLog) > 0) {
      brain.job = null;
      return setState(villager, brain, "cook");
    }
    if (buyLogs(villager, brain, now, 2, "to fire his smoker")) return;
  }

  const herd = animalsIn(dim, pen);
  // 3. too many grown animals of a kind: the extras go (babies are left alone)
  for (const [kind, list] of Object.entries(herd)) {
    const adults = list.filter((a) => !isBaby(a));
    if (adults.length > BUTCH.KEEP_ADULTS && (list.length > BUTCH.KEEP_ADULTS + 1 || totalIn(herd) >= BUTCH.MAX_IN_PEN)) {
      brain.job = { target: adults[adults.length - 1].id, kind };
      return setState(villager, brain, "butcher");
    }
  }

  // 4. two of a kind and something to feed them: breeding time
  const bred = breedTimes(villager);
  const t = world_time();
  for (const [kind, list] of Object.entries(herd)) {
    const adults = list.filter((a) => !isBaby(a));
    if (adults.length < 2 || totalIn(herd) >= BUTCH.MAX_IN_PEN) continue;
    if (t - (bred[kind] ?? -1e9) < BUTCH.BREED_EVERY) continue;
    const food = foodFor(inv, kind);
    if (food) {
      brain.job = { kind, food, fed: [] };
      return setState(villager, brain, "breed");
    }
    if (buyFeed(villager, brain, now, kind)) return;
  }

  // 5. short of a pair of something: bring one in off the land
  if (totalIn(herd) < BUTCH.MAX_IN_PEN && now >= (brain.noHerdUntil ?? 0)) {
    for (const kind of Object.keys(ANIMALS)) {
      if ((herd[kind]?.length ?? 0) >= 2) continue;
      if (!foodFor(inv, kind)) {
        if (buyFeed(villager, brain, now, kind)) return;
        continue;
      }
      const animal = wildAnimal(villager, dim, pen, kind);
      if (!animal) continue;
      brain.job = { target: animal.id, kind, started: now };
      debugLog(villager, `off to bring in a ${kind.replace("minecraft:", "")} (${Math.round(dist(animal.location, villager.location))} blocks away)`);
      return setState(villager, brain, "herd");
    }
    brain.noHerdUntil = now + BUTCH.HERD_RETRY;
  }

  if (vCount(inv, isProduct) > 0 && now >= (brain.nextStash ?? 0)) {
    brain.nextStash = now + 20 * 60;
    return setState(villager, brain, "stash");
  }
  brain.cookAnyway ??= now + 20 * 60 * 2;
  if (now >= brain.cookAnyway) brain.cookAnyway = now + 20 * 60 * 2;
  setState(villager, brain, "idle", CFG.IDLE_TIME);
}

function world_time() {
  return system.currentTick; // (breeding cooldowns don't need to survive a reload)
}

function breedTimes(villager) {
  try {
    return JSON.parse(villager.getDynamicProperty(DP_BRED) ?? "{}");
  } catch {
    return {};
  }
}

function setBred(villager, kind) {
  const b = breedTimes(villager);
  b[kind] = world_time();
  try {
    villager.setDynamicProperty(DP_BRED, JSON.stringify(b));
  } catch {}
}

function isBaby(e) {
  try {
    return !!e.getComponent("minecraft:is_baby");
  } catch {
    return false;
  }
}

/** The animals in his pen, by kind. */
function animalsIn(dim, pen) {
  const out = {};
  const c = penCenter(pen);
  let list = [];
  try {
    list = dim.getEntities({ location: { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, maxDistance: BUTCH.PEN_INNER + 3 });
  } catch {}
  for (const e of list) {
    if (!ANIMALS[e.typeId] || !inPen(pen, e.location)) continue;
    (out[e.typeId] ??= []).push(e);
  }
  return out;
}

const totalIn = (herd) => Object.values(herd).reduce((n, l) => n + l.length, 0);

function foodFor(inv, kind) {
  return ANIMALS[kind].food.find((f) => vCount(inv, (id) => id === f) > 0);
}

/** Feed off the farmer: wheat for cows and sheep, carrots for pigs, seeds for chickens. */
function buyFeed(villager, brain, now, kind) {
  const good = ANIMALS[kind].good;
  if ((brain.cantBuy?.[good] ?? 0) > now) return false;
  debugLog(villager, `needs ${good} to feed his ${kind.replace("minecraft:", "")}s`);
  return goShopping(villager, brain, good, BUTCH.FEED_BUY, "supply", now);
}

function buyLogs(villager, brain, now, need, why, then = "supply") {
  debugLog(villager, `needs logs ${why}`);
  return goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, then, now) || fetchWood(villager, brain, need, then, now);
}

/** A grown animal of this kind out on the land (not in his pen, not in anybody's, not tied up). */
function wildAnimal(villager, dim, pen, kind) {
  let list = [];
  try {
    list = dim.getEntities({ type: kind, location: villager.location, maxDistance: BUTCH.ANIMAL_RADIUS });
  } catch {}
  for (const a of list) {
    if (isBaby(a) || inPen(pen, a.location)) continue;
    if (fencedIn(dim, a.location)) continue; // somebody else's
    try {
      if (a.getComponent("minecraft:leashable")?.isLeashed) continue;
    } catch {}
    if (a.nameTag) continue; // a pet
    return a;
  }
  return undefined;
}

/** Is there fencing close round this spot on three sides or more? (Somebody's pen or field.) */
function fencedIn(dim, loc) {
  const f = floorPos(loc);
  let sides = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let d = 1; d <= 6; d++) {
      if (isFencing(getBlock(dim, { x: f.x + dx * d, y: f.y, z: f.z + dz * d })?.typeId)) {
        sides++;
        break;
      }
    }
  }
  return sides >= 3;
}

// ---------------------------------------------------------------- building one

/** No pen: where it'll go, and the fences for it. True if he's busy with it. */
function planPen(villager, dim, brain, now, ws, inv) {
  if ((brain.noPenUntil ?? 0) > now) return setState(villager, brain, "idle", CFG.IDLE_TIME);
  if (!brain.penPlan) {
    const site = stepSiteScan(dim, brain, ws);
    if (site === undefined) return sleep(brain, 2);
    if (site === "none") {
      debugLog(villager, "no flat, clear patch near his smoker for a pen");
      brain.noPenUntil = now + 20 * 60 * 3;
      return setState(villager, brain, "idle", CFG.IDLE_TIME);
    }
    brain.penPlan = site;
    debugLog(villager, `no pen about - he'll build one at ${site.x0} ${site.y} ${site.z0} (gate at ${fmt(site.gate)})`);
  }
  const posts = fenceLine(brain.penPlan).length;
  const fences = vCount(inv, (id) => id === FENCE);
  const gates = vCount(inv, (id) => id === GATE);
  if (fences >= posts && gates >= 1) {
    brain.job = { step: 0 };
    return setState(villager, brain, "pen");
  }
  // fences: 4 planks + 2 sticks -> 3 fences; gate: 4 sticks + 2 planks. Logs for all of it (and a table).
  const need = logsFor(posts - fences, gates < 1) + (benchNear(dim, ws, 3) ? 0 : 1);
  if (vCount(inv, isLog) < need) return buyLogs(villager, brain, now, need, `for a pen (${need} logs)`) || setState(villager, brain, "idle", CFG.IDLE_TIME);
  brain.job = { craft: "pen" };
  return setState(villager, brain, "craft");
}

/** Logs for `fences` fences (and a gate). 1 log -> 4 planks; a fence craft is 4 planks + 2 sticks (1 plank) for 3. */
function logsFor(fences, gate) {
  const crafts = Math.ceil(Math.max(0, fences) / 3);
  const planks = crafts * 5 + (gate ? 4 : 0);
  return Math.ceil(planks / 4);
}

/**
 * The crafting table right by his smoker (one that's there, or one he makes from a log and stands
 * beside it), then fences and a gate for his pen.
 */
function craft(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  let table = benchNear(dim, ws, 3);
  if (!table) {
    brain.tableSpot ??= placeSpotNear(dim, ws, villager, { radius: 2 }) ?? placeSpotNear(dim, ws, villager, { radius: 4 }) ?? null;
    const spot = brain.tableSpot;
    if (!spot || vCount(inv, isLog) < 1) {
      brain.tableSpot = undefined;
      table = benchNear(dim, ws); // the village's, then
      if (!table) {
        brain.job = null;
        return setState(villager, brain, "idle", 20 * 30);
      }
    } else {
      if (!canUse(dim, villager, spot)) {
        const r = walkTo(villager, dim, brain, now, spot);
        if (r === "moving") return sleep(brain, 4);
      }
      brain.tableSpot = undefined;
      if (placeBlock(villager, dim, spot, TABLE, "use.wood")) {
        vTake(inv, isLog, 1);
        forgetBenches();
        debugLog(villager, `made a crafting table and stood it next to his smoker at ${fmt(spot)}`);
      }
      return sleep(brain, 10);
    }
  }
  if (!canUse(dim, villager, table)) {
    const r = walkTo(villager, dim, brain, now, table);
    if (r === "moving") return sleep(brain, 4);
    if (!canUse(dim, villager, table)) {
      brain.job = null;
      return setState(villager, brain, "idle", 20 * 30);
    }
  }
  setMode(villager, brain, "work");
  lookAt(villager, center(table));
  const plan = brain.penPlan;
  if (brain.job?.craft === "pen" && plan) {
    const posts = fenceLine(plan).length;
    const wantF = Math.max(0, posts - vCount(inv, (id) => id === FENCE));
    const wantG = vCount(inv, (id) => id === GATE) < 1;
    let planks = vCount(inv, isLog) * 4;
    const logsBefore = vCount(inv, isLog);
    let madeF = 0;
    let madeG = false;
    if (wantG && planks >= 4) {
      planks -= 4;
      madeG = true;
    }
    while (madeF < wantF && planks >= 5) {
      planks -= 5;
      madeF += 3;
    }
    const used = logsBefore - Math.floor(planks / 4);
    vTake(inv, isLog, used);
    if (madeF) vAdd(inv, new ItemStack(FENCE, madeF));
    if (madeG) vAdd(inv, new ItemStack(GATE, 1));
    playSound(dim, "dig.wood", center(table), 1.3);
    particle(dim, "minecraft:villager_happy", offset(center(table), 0, 0.8, 0));
    debugLog(villager, `made ${madeF} fences${madeG ? " and a gate" : ""} from ${used} logs`);
  }
  brain.job = null;
  setState(villager, brain, "supply");
}

/** Puts the fence up, post by post, and the gate on the side facing his smoker. */
function buildPen(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  const plan = brain.penPlan;
  if (!plan) return setState(villager, brain, "supply");
  const job = (brain.job ??= { step: 0 });
  const posts = [...fenceLine(plan), plan.gate];
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  while (job.step < posts.length) {
    const p = posts[job.step];
    const isGate = job.step === posts.length - 1;
    const b = getBlock(dim, p);
    if (!b) return sleep(brain, 20);
    if (isFencing(b.typeId) || (isGate && /fence_gate$/.test(b.typeId))) {
      job.step++;
      continue;
    }
    if (!(b.isAir || isPassable(b)) || b.isLiquid) {
      debugLog(villager, `${b.typeId.replace("minecraft:", "")} where a fence post should go at ${fmt(p)} - looking for another spot`);
      brain.penPlan = null;
      brain.job = null;
      return setState(villager, brain, "supply");
    }
    if (!canUse(dim, villager, p)) {
      // stand just outside the fence line (or inside, if that's the way)
      const out = { x: p.x + Math.sign(p.x - (plan.x0 + plan.x1) / 2), y: p.y, z: p.z + Math.sign(p.z - (plan.z0 + plan.z1) / 2) };
      const spot = findStandableNear(dim, out, 1, 1, (q) => onFenceLine(plan, q)) ?? findStandableNear(dim, p, 2, 1, (q) => onFenceLine(plan, q));
      job.walks = (job.walks ?? 0) + 1;
      if (!spot || job.walks > 40 || !navTo(villager, brain, spot, { radius: 0.8, partial: true })) {
        job.skip = (job.skip ?? 0) + 1;
        if (job.skip > 4) {
          brain.penPlan = null;
          brain.job = null;
          return setState(villager, brain, "idle", CFG.IDLE_TIME);
        }
      }
      return sleep(brain, 4);
    }
    job.walks = 0;
    setMode(villager, brain, "work");
    const id = isGate ? GATE : FENCE;
    if (vTake(inv, (x) => x === id, 1).length < 1) {
      brain.job = null;
      return setState(villager, brain, "supply"); // short of fencing: make more
    }
    const ok = isGate ? placeGate(villager, dim, p, plan) : placeBlock(villager, dim, p, FENCE, "use.wood");
    if (!ok) vAdd(inv, new ItemStack(id, 1));
    job.step++;
    return sleep(brain, 6);
  }
  // done
  const pen = { ...plan };
  savePen(villager, pen);
  brain.penPlan = null;
  brain.job = null;
  debugLog(villager, `built a pen at ${pen.x0} ${pen.y} ${pen.z0} - ${pen.x1 - pen.x0 + 1}x${pen.z1 - pen.z0 + 1} inside`);
  setState(villager, brain, "supply");
}

const onFenceLine = (plan, q) => (q.x === plan.x0 - 1 || q.x === plan.x1 + 1 || q.z === plan.z0 - 1 || q.z === plan.z1 + 1) && q.x >= plan.x0 - 1 && q.x <= plan.x1 + 1 && q.z >= plan.z0 - 1 && q.z <= plan.z1 + 1;

/** The gate, turned to sit in the line of the fence. */
function placeGate(villager, dim, p, plan) {
  if (!placeBlock(villager, dim, p, GATE, "use.wood")) return false;
  // in a fence running east-west the gate faces north-south, and the other way round
  const alongX = p.z === plan.z0 - 1 || p.z === plan.z1 + 1;
  const b = getBlock(dim, p);
  for (const [state, value] of [["direction", alongX ? 0 : 1], ["minecraft:cardinal_direction", alongX ? "south" : "east"]]) {
    try {
      b.setPermutation(BlockPermutation.resolve(GATE, { [state]: value }));
      break;
    } catch {}
  }
  return true;
}

// ================================================================ herding

// animals following a villager who's holding their food up: id -> {animal, leader, since, last}
const followers = new Map();

system.runInterval(() => {
  for (const [id, f] of followers) {
    try {
      if (!isValid(f.animal) || !isValid(f.leader)) {
        followers.delete(id);
        continue;
      }
      const a = f.animal.location;
      const l = f.leader.location;
      const dx = l.x - a.x;
      const dz = l.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > BUTCH.LEAD_LOSE) {
        followers.delete(id); // lost interest
        continue;
      }
      if (d < 1.6) continue;
      // it trots after the food like it would after a player's
      const v = f.animal.getVelocity();
      const speed = Math.min(0.2, d * 0.08);
      const step = { x: (dx / d) * speed - v.x, y: 0, z: (dz / d) * speed - v.z };
      // hop up a step when it's pressing against one
      if (f.animal.isOnGround && Math.hypot(v.x, v.z) < 0.02 && l.y > a.y + 0.5) step.y = 0.42;
      f.animal.applyImpulse(step);
      f.animal.setRotation({ x: 0, y: (Math.atan2(-dx, dz) * 180) / Math.PI });
    } catch {
      followers.delete(id);
    }
  }
}, 2);

function follow(animal, leader) {
  followers.set(animal.id, { animal, leader, since: system.currentTick });
}

function unfollow(animal) {
  if (animal) followers.delete(animal.id);
}

/** The animal he's after, wherever it's got to (undefined once it's dead or gone). */
function findEntity(dim, near, id) {
  try {
    const e = world.getEntity(id);
    return e && isValid(e) && e.dimension.id === dim.id ? e : undefined;
  } catch {
    return undefined;
  }
}

/** Walks up to the animal with its food in his hand. */
function herd(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const job = brain.job;
  const pen = loadPen(villager, dim);
  const animal = job && pen && findEntity(dim, villager.location, job.target);
  const food = foodFor(getInventory(villager), job?.kind ?? "");
  if (!animal || !food || now - job.started > BUTCH.LEAD_TIMEOUT) {
    brain.job = null;
    navStop(villager, brain);
    return setState(villager, brain, "supply");
  }
  holdItem(villager, food);
  if (dist(villager.location, animal.location) <= 3) {
    navStop(villager, brain);
    lookAt(villager, { x: animal.location.x, y: animal.location.y + 0.8, z: animal.location.z });
    follow(animal, villager);
    job.leadStart = now;
    debugLog(villager, `the ${job.kind.replace("minecraft:", "")} has seen the ${food.replace("minecraft:", "")} - leading it home`);
    return setState(villager, brain, "lead");
  }
  if (brain.nav && horizDist(brain.nav.goal, animal.location) > 3) navStop(villager, brain);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  const spot = findStandableNear(dim, floorPos(animal.location), 2, 2);
  if (!spot || !navTo(villager, brain, spot, { radius: 1.5, partial: true })) {
    job.fails = (job.fails ?? 0) + 1;
    if (job.fails > 4) {
      brain.job = null;
      return setState(villager, brain, "supply");
    }
  }
  sleep(brain, 4);
}

/**
 * Leading it home: out of the field to his gate, in through it to the middle of the pen (it
 * follows the food), and back out again once it's inside. The gate shuts behind him.
 */
function lead(villager, dim, brain, now, ws) {
  const job = brain.job;
  const pen = loadPen(villager, dim);
  const animal = job && pen && findEntity(dim, villager.location, job.target);
  const giveUp = (why) => {
    if (why) debugLog(villager, why);
    unfollow(animal);
    brain.job = null;
    navStop(villager, brain);
    holdItem(villager, undefined);
    return setState(villager, brain, "supply");
  };
  if (!animal || !pen) return giveUp("lost the animal he was leading");
  if (now - job.leadStart > BUTCH.LEAD_TIMEOUT) return giveUp(`the ${job.kind.replace("minecraft:", "")} wouldn't come along`);
  if (!followers.has(animal.id) && !job.home) {
    // it wandered off: back to fetch it
    job.started = now;
    return setState(villager, brain, "herd");
  }
  const inside = penCenter(pen);
  const g = pen.gate;
  // which way is "in" at the gate
  const inDir = g.x < pen.x0 ? [1, 0] : g.x > pen.x1 ? [-1, 0] : g.z < pen.z0 ? [0, 1] : [0, -1];
  const outside = { x: g.x - inDir[0] * 2, y: g.y, z: g.z - inDir[1] * 2 };

  if (!job.home) {
    // the animal is in: let go of it and walk out
    if (inPen(pen, animal.location)) {
      unfollow(animal);
      job.home = true;
      debugLog(villager, `the ${job.kind.replace("minecraft:", "")} is in the pen`);
      navStop(villager, brain);
      return sleep(brain, 2);
    }
    // outside the gate first, then in through it (a straight line through a gate beats a detour)
    const target = job.throughGate ? inside : outside;
    if (!job.throughGate && horizDist(villager.location, center(outside)) < 1.5) job.throughGate = true;
    if (!brain.nav || brain.nav.goal.x !== target.x || brain.nav.goal.z !== target.z) {
      const spot = findStandableNear(dim, target, 1, 2) ?? target;
      if (!navTo(villager, brain, spot, { radius: 1.0, partial: true })) {
        job.fails = (job.fails ?? 0) + 1;
        if (job.fails > 6) return giveUp("can't find the way back to his pen");
      }
    }
    const r = brain.nav ? navUpdate(villager, brain, now) : "failed";
    // (it keeps up at the animal's pace: he waits for it now and then)
    if (r === "moving" && dist(villager.location, animal.location) > 6) {
      navStop(villager, brain);
      lookAt(villager, { x: animal.location.x, y: animal.location.y + 0.8, z: animal.location.z });
    }
    return sleep(brain, 4);
  }

  // back out through the gate
  if (horizDist(villager.location, center(outside)) <= 1.2 || !inPen(pen, villager.location)) {
    holdItem(villager, undefined);
    brain.job = null;
    navStop(villager, brain);
    return setState(villager, brain, "supply");
  }
  if (!brain.nav) {
    const spot = findStandableNear(dim, outside, 1, 2) ?? outside;
    if (!navTo(villager, brain, spot, { radius: 0.9, partial: true })) return giveUp("can't get back out of the pen");
  }
  const r = navUpdate(villager, brain, now);
  if (r !== "moving") navStop(villager, brain);
  sleep(brain, 4);
}

// ================================================================ breeding & butchering

/** Walks up to (or into) the pen close enough to reach `animal`. True when he can reach it. */
function reachAnimal(villager, dim, brain, now, pen, animal) {
  if (dist(villager.location, animal.location) <= BUTCH.REACH) {
    navStop(villager, brain);
    return true;
  }
  if (brain.nav && horizDist(brain.nav.goal, animal.location) > 2) navStop(villager, brain);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return false;
  }
  const spot = findStandableNear(dim, floorPos(animal.location), 1, 1) ?? findStandableNear(dim, penCenter(pen), 2, 1);
  if (!spot || !navTo(villager, brain, spot, { radius: 1.2, partial: true })) {
    brain.job.fails = (brain.job.fails ?? 0) + 1;
  }
  return false;
}

/** Feeds a pair of them; they have a baby (hearts all round). */
function breed(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  const job = brain.job;
  const pen = loadPen(villager, dim);
  if (!job || !pen || (job.fails ?? 0) > 8) {
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  const adults = (animalsIn(dim, pen)[job.kind] ?? []).filter((a) => !isBaby(a) && !job.fed.includes(a.id));
  const food = foodFor(inv, job.kind);
  if (!food || (job.fed.length < 2 && !adults.length)) {
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  if (job.fed.length < 2) {
    const a = adults[0];
    holdItem(villager, food);
    if (!reachAnimal(villager, dim, brain, now, pen, a)) return sleep(brain, 4);
    setMode(villager, brain, "work");
    lookAt(villager, { x: a.location.x, y: a.location.y + 0.8, z: a.location.z });
    vTake(inv, (id) => id === food, 1);
    job.fed.push(a.id);
    job.at = a.location;
    playSound(dim, "random.eat", a.location);
    for (let i = 0; i < 3; i++) particle(dim, "minecraft:heart_particle", { x: a.location.x + (Math.random() - 0.5), y: a.location.y + 1.2, z: a.location.z + (Math.random() - 0.5) });
    return sleep(brain, 20);
  }
  // both fed: a baby
  const where = job.at;
  try {
    const baby = dim.spawnEntity(job.kind, { x: where.x, y: where.y, z: where.z });
    baby.triggerEvent("minecraft:entity_born");
  } catch {}
  for (let i = 0; i < 6; i++) particle(dim, "minecraft:heart_particle", { x: where.x + (Math.random() - 0.5) * 1.5, y: where.y + 1, z: where.z + (Math.random() - 0.5) * 1.5 });
  playSound(dim, "random.orb", where);
  addXp(villager, 1 + Math.floor(Math.random() * 7)); // like breeding by hand
  setBred(villager, job.kind);
  debugLog(villager, `bred his ${job.kind.replace("minecraft:", "")}s - a baby in the pen`);
  holdItem(villager, undefined);
  brain.job = null;
  setState(villager, brain, "supply");
}

/** One of the extra grown animals: a few blows with whatever he's holding, then he picks up the meat. */
function butcherState(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  const job = brain.job;
  const pen = loadPen(villager, dim);
  const animal = job && pen && findEntity(dim, villager.location, job.target);
  if (!job || !pen || (job.fails ?? 0) > 8 || now - (job.started ??= now) > BUTCH.BUTCHER_TIMEOUT) {
    brain.job = null;
    setWorking(villager, false);
    return setState(villager, brain, "supply");
  }
  if (animal && !inPen(pen, animal.location) && dist(animal.location, villager.location) > 8) {
    brain.job = null; // it got out: nothing to do with it here
    return setState(villager, brain, "supply");
  }
  if (!animal || !isValid(animal)) {
    // done: pick the drops up
    setWorking(villager, false);
    pickupItems(villager, dim, inv, isWanted, 3);
    if (!job.picked) {
      job.picked = now;
      addXp(villager, 1 + Math.floor(Math.random() * 3));
      debugLog(villager, `butchered a ${job.kind.replace("minecraft:", "")}`);
    }
    if (now - job.picked < 40) return sleep(brain, 4);
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  if (!reachAnimal(villager, dim, brain, now, pen, animal)) return sleep(brain, 4);
  setMode(villager, brain, "work");
  holdItem(villager, "minecraft:iron_sword");
  lookAt(villager, { x: animal.location.x, y: animal.location.y + 0.6, z: animal.location.z });
  if (now >= (job.nextHit ?? 0)) {
    job.nextHit = now + 12;
    setWorking(villager, true);
    try {
      animal.applyDamage(BUTCH.HIT, { cause: "entityAttack", damagingEntity: villager });
    } catch {}
    playSound(dim, "game.player.attack.strong", animal.location);
  }
  sleep(brain, 4);
}

// ================================================================ cooking

function cook(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const r = walkTo(villager, dim, brain, now, ws);
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");
  const inv = getInventory(villager);
  if (!brain.cookWhat) brain.cookWhat = pickStack(inv, isRaw, 64)?.type ?? Object.keys(COOKED).find((raw) => furnaceOut(dim, ws) === COOKED[raw]);
  const raw = brain.cookWhat;
  if (!raw) {
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  const status = smeltStep(villager, dim, brain, now, ws, {
    furnaces: WORKSTATIONS,
    ticksPer: 100,
    product: COOKED[raw],
    isInput: (id) => id === raw,
    pickInput: (i) => pickStack(i, (id) => id === raw, 8),
    takeFuel: (i) => {
      const [f] = vTake(i, isFuel, 1);
      return f ? new ItemStack(f, 1) : plankFuel(i);
    },
  });
  if (status === "working") return sleep(brain, 20);
  const got = brain.job?.got ?? 0;
  if (status === "done") debugLog(villager, `took ${got} ${COOKED[raw].replace("minecraft:", "").replace("_", " ")} out of the smoker`);
  brain.job = null;
  brain.cookWhat = null;
  const stuck = status === "busy" || status === "toofar" || status === "nofurnace" || (status === "done" && !got);
  if (stuck) brain.cookAnyway = now + 20 * 60 * 5;
  setState(villager, brain, stuck ? "idle" : "supply", stuck ? CFG.IDLE_TIME : 0);
}

function furnaceOut(dim, p) {
  try {
    return getBlock(dim, p)?.getComponent("minecraft:inventory")?.container?.getItem(2)?.typeId;
  } catch {
    return undefined;
  }
}

// ================================================================ stash & idle

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
  const extra = (id) => isProduct(id) || id === "minecraft:experience_bottle";
  if (vCount(inv, extra) > 0) {
    for (const { block, container } of chests) {
      const key = fmt(block);
      if (visit.tried.has(key)) continue;
      visit.tried.add(key);
      if (!canUse(dim, villager, block, CFG.REACH + 1)) continue;
      lookAt(villager, center(block));
      playSound(dim, "random.chestopen", center(block));
      restockSellRow(villager, []); // his stall first, then the chest
      storeInto(inv, container, extra);
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
          debugLog(villager, `placed a chest for his meat at ${fmt(spot)}`);
          return sleep(brain, 16);
        }
      }
    }
  }
  restockSellRow(villager, chests.map((c) => c.container));
  brain.job = null;
  setState(villager, brain, "supply");
}

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
  if (now - brain.since >= (brain.idleFor || CFG.IDLE_TIME)) return setState(villager, brain, "supply");
  sleep(brain, CFG.THINK_IDLE);
}
