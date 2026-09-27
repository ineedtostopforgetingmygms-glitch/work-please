// Armorer - works at a blast furnace:
//   supply   works out what to do next: smelt the ore he has, make the tools the village is short
//            of, buy more ore, fuel, wood or diamonds
//   shop     buys raw iron and raw gold off the miner, coal off the miner (only what the miner can
//            spare after his torches), logs off the lumberjack for sticks and charcoal (shopping.js)
//   smelt    raw iron / raw gold into ingots in his blast furnace, with coal or charcoal
//   char     the miner won't sell him coal: logs into charcoal in an ordinary furnace (a blast
//            furnace only takes ore) - crafting and standing the furnace first if there isn't one
//   craft    iron tools (and diamond ones when he's bought diamonds) at a crafting table
//   stash    tools and gold into his chest, restocks his shop row - everybody's tools come from him
//   market   his trading hours: stands at his blast furnace and sells (market.js)
import { ItemStack } from "@minecraft/server";
import { world } from "@minecraft/server";
import { ARMOR, CFG, GOLEM, LOGS, PROP_PROFESSION, Profession, TOOL_RECIPES, VILLAGER_ID } from "../config.js";
import { golemCap, golemsNear, IRON_GOLEM } from "../golem.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { getTool, holdItem, pickupItems } from "../actions.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { addStockpile } from "../registry.js";
import { emeralds } from "../economy.js";
import { storeInto, vAdd, vCount, vFreeSlots, vTake } from "../inventory.js";
import { restockSellRow } from "../trade.js";
import { canUse, center, getBlock, getInventory, isPassable, isStandable, lookAt, offset, particle, playSound, ringOffsets } from "../util.js";
import { placeBlock } from "../actions.js";
import { getWorkstation, ownsWorkstation, unemploy } from "./employment.js";
import { isNearHome, spotNextTo, stockpileChests, walkTo } from "./common.js";
import { haveBench, putDown, useBench } from "./workshop.js";
import { fetchWood, woodState } from "./wood.js";
import { goShopping, shop } from "./shopping.js";
import { market } from "./market.js";
import { hideState, offDuty, sleepState } from "./rest.js";
import { BLAST_FURNACES, furnaceHas, furnaceNear, pickStack, plankFuel, smeltStep } from "./smelting.js";

const WORKSTATIONS = BLAST_FURNACES;
const CHEST = "armory";
const IRON_RAW = "minecraft:raw_iron";
const GOLD_RAW = "minecraft:raw_gold";
const IRON = "minecraft:iron_ingot";
const GOLD = "minecraft:gold_ingot";
const DIAMOND = "minecraft:diamond";
const COBBLE = "minecraft:cobblestone";
const isLog = (id) => LOGS.has(id);
const isStick = (id) => id === "minecraft:stick";
const isFuel = (id) => id === "minecraft:coal" || id === "minecraft:charcoal";
const isOre = (id) => id === IRON_RAW || id === GOLD_RAW;
const isProduct = (id) => !!TOOL_RECIPES[id] || id === GOLD;
const isWanted = (id) => isOre(id) || isFuel(id) || isLog(id) || isStick(id) || isProduct(id) || id === IRON || id === DIAMOND || id === COBBLE || id === PUMPKIN;
const SMELTED = { [IRON_RAW]: IRON, [GOLD_RAW]: GOLD };
const IRON_BLOCK = "minecraft:iron_block";
const PUMPKIN = "minecraft:pumpkin";
const CARVED = "minecraft:carved_pumpkin";
const SHEARS = "minecraft:shears";
const DP_GOLEM = "iv:golemAt"; // when he last built one (world time)
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;

// which job needs which of his tools
const NEEDS = {
  [Profession.LUMBERJACK]: "axe",
  [Profession.MINER]: "pickaxe",
  [Profession.FARMER]: "hoe",
};

export function armorerThink(villager, dim, brain, now) {
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
  golem: golemState,
  wood: woodState,
  craft,
  smelt,
  char,
  stash,
  idle,
  market: (v, d, b, n, ws) => market(v, d, b, n, ws, { chestKind: CHEST, backTo: "supply" }),
  sleep: (v, d, b, n, ws) => sleepState(v, d, b, n, ws, "supply"),
  hide: (v, d, b, n, ws) => hideState(v, d, b, n, ws, "supply"),
};

// ================================================================ supply

function supply(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest");
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  if (vFreeSlots(inv) <= 2 || surplus(inv) >= ARMOR.RETURN_AT) return setState(villager, brain, "stash");

  // 1. ore on him (or ingots waiting in the blast furnace): into the blast furnace with it
  const ingotsWaiting = furnaceHas(dim, ws, IRON) || furnaceHas(dim, ws, GOLD);
  if (vCount(inv, isOre) > 0 || ingotsWaiting) {
    if (vCount(inv, isFuel) > 0 || ingotsWaiting) {
      brain.job = null;
      return setState(villager, brain, "smelt");
    }
    if (getFuel(villager, dim, brain, now, ws, inv)) return;
  }

  // 2. tools: the one the village is shortest of that he has the iron (or diamonds) for
  const tool = nextTool(villager, dim, brain, now, ws, inv);
  if (tool) {
    const r = TOOL_RECIPES[tool];
    if (vCount(inv, isStick) < r.sticks && vCount(inv, isLog) < 1 + (haveBench(dim, ws) ? 0 : 1)) {
      if (buyLogs(villager, brain, now, 2, "for tool handles")) return;
    } else {
      brain.job = { craft: tool };
      return setState(villager, brain, "craft");
    }
  }

  // 2b. an iron golem for the village, when it's short of one and he has the iron
  if (golemPlan(villager, dim, brain, now, ws, inv)) return;

  // 3. more to work with: raw iron (and some gold) off the miner, diamonds when he's flush
  const stock = stockOf(villager, dim, ws);
  const ironShort = Object.keys(ARMOR.STOCK).some((t) => TOOL_RECIPES[t].mat === IRON && (stock.get(t) ?? 0) < ARMOR.STOCK[t]);
  const iron = vCount(inv, (id) => id === IRON || id === IRON_RAW);
  const golemIron = wantsGolem(villager, dim, brain, now, ws) && vCount(inv, (id) => id === IRON_BLOCK) < 4 ? GOLEM.IRON + 2 : 0;
  if (iron < ARMOR.KEEP_INGOTS + (ironShort ? 3 : 0) + golemIron) {
    if (goShopping(villager, brain, "raw_iron", ARMOR.ORE_BUY, "supply", now)) return;
  }
  const diamondShort = Object.keys(ARMOR.STOCK).some((t) => TOOL_RECIPES[t].mat === DIAMOND && (stock.get(t) ?? 0) < ARMOR.STOCK[t]);
  if (diamondShort && emeralds(villager) >= ARMOR.DIAMOND_RICH && vCount(inv, (id) => id === DIAMOND) < ARMOR.DIAMOND_BUY) {
    if (goShopping(villager, brain, "diamond", ARMOR.DIAMOND_BUY - vCount(inv, (id) => id === DIAMOND), "supply", now)) return;
  }
  if ((stock.get(GOLD) ?? 0) < 8 && emeralds(villager) >= 32) {
    if (goShopping(villager, brain, "raw_gold", ARMOR.GOLD_BUY, "supply", now)) return;
  }

  // anything made that isn't in the chest (and so on his stall) yet?
  if (surplus(inv) > 0) return setState(villager, brain, "stash");
  setState(villager, brain, "idle", CFG.IDLE_TIME);
}

/** Tools beyond the one of each he keeps on him, and gold: what belongs in his chest. */
function surplus(inv) {
  let n = vCount(inv, (id) => id === GOLD);
  for (const t of Object.keys(TOOL_RECIPES)) n += Math.max(0, vCount(inv, (id) => id === t) - 1);
  return n;
}

/**
 * No coal to fire the blast furnace. First choice: buy some off the miner - he only sells what
 * he doesn't need for his torches (see GOODS.coal). If the miner won't, logs from the lumberjack,
 * burnt into charcoal in an ordinary furnace. True if he's off to do one of those.
 */
function getFuel(villager, dim, brain, now, ws, inv) {
  if (goShopping(villager, brain, "coal", ARMOR.COAL_BUY, "supply", now)) return true;

  // charcoal it is
  const furnace = furnaceNear(dim, ws);
  const tableCost = haveBench(dim, ws) ? 0 : 1;
  if (!furnace) {
    if (vCount(inv, (id) => id === COBBLE) < ARMOR.FURNACE_COBBLE) {
      debugLog(villager, "no coal to be had - he needs a furnace for charcoal, and cobblestone for that");
      if (goShopping(villager, brain, "cobblestone", ARMOR.FURNACE_COBBLE, "supply", now)) return true;
      return false;
    }
    if (vCount(inv, isLog) < tableCost) return buyLogs(villager, brain, now, tableCost, "for a crafting table");
    brain.job = { craft: "minecraft:furnace" };
    setState(villager, brain, "craft");
    return true;
  }
  if (furnaceHas(dim, furnace, "minecraft:charcoal")) {
    brain.job = null;
    setState(villager, brain, "char");
    return true;
  }
  // logs to burn, and one more for plank fuel
  if (vCount(inv, isLog) < ARMOR.CHARCOAL_LOGS + 1) return buyLogs(villager, brain, now, ARMOR.CHARCOAL_LOGS + 1, "to burn into charcoal");
  brain.job = null;
  setState(villager, brain, "char");
  return true;
}

/** Logs off the lumberjack; if there's nobody selling any for long enough, he cuts his own. */
function buyLogs(villager, brain, now, need, why, then = "supply") {
  debugLog(villager, `needs logs ${why}`);
  return goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, then, now) || fetchWood(villager, brain, need, then, now);
}

/** How many of each product he has: in his chests, his shop row and his pockets. */
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

/**
 * Which tool to make next: the villagers around here who could do with a better one first (a
 * lumberjack wants an axe, a miner a pickaxe, a farmer a hoe), then whatever his stock is lowest
 * on. Only tools he has the materials for - he keeps ARMOR.KEEP_INGOTS iron back to sell.
 */
function nextTool(villager, dim, brain, now, ws, inv) {
  const ingots = vCount(inv, (id) => id === IRON) - ARMOR.KEEP_INGOTS;
  const diamonds = vCount(inv, (id) => id === DIAMOND);
  if (ingots < 2 && diamonds < 2) return undefined;
  const demand = villageDemand(villager, dim, brain, now);
  const stock = stockOf(villager, dim, ws);
  let best;
  let bestScore = -Infinity;
  for (const [tool, want] of Object.entries(ARMOR.STOCK)) {
    const r = TOOL_RECIPES[tool];
    const have = stock.get(tool) ?? 0;
    if (have >= want + (demand[kindOf(tool)] ?? 0)) continue;
    if ((r.mat === IRON ? ingots : diamonds) < r.n) continue;
    const score = (demand[kindOf(tool)] ?? 0) * 2 + (want - have) + (r.mat === DIAMOND ? 1 : 0);
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }
  return best;
}

const kindOf = (tool) => tool.replace(/^minecraft:(iron|diamond)_/, "");

/** How many villagers nearby still work with a tool worse than iron, per kind of tool. */
function villageDemand(villager, dim, brain, now) {
  if (brain.demand && now - brain.demand.at < 20 * 30) return brain.demand.by;
  const by = {};
  try {
    for (const v of dim.getEntities({ type: VILLAGER_ID, location: villager.location, maxDistance: 96 })) {
      const kind = NEEDS[v.getProperty(PROP_PROFESSION)];
      if (!kind) continue;
      const t = getTool(v, kind);
      if (!t || /wooden_|stone_|golden_|copper_/.test(t.id)) by[kind] = (by[kind] ?? 0) + 1;
    }
  } catch {}
  brain.demand = { at: now, by };
  return by;
}

// ================================================================ craft

function craft(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);

  // the charcoal furnace, crafted and looking for somewhere to stand
  if (brain.job?.place) {
    const what = brain.job.place;
    const at = putDown(villager, dim, brain, now, ws, what, "use.stone");
    if (at === "busy") return sleep(brain, 4);
    debugLog(villager, at ? `stood his ${what.replace("minecraft:", "")} at ${fmt(at)}` : `nowhere to put the ${what.replace("minecraft:", "")}`);
    brain.job = null;
    return setState(villager, brain, at ? "supply" : "idle", at ? 0 : 20 * 30);
  }

  const item = brain.job?.craft;
  if (!item) return setState(villager, brain, "supply");
  const table = useBench(villager, dim, brain, now, ws, () => vTake(inv, isLog, 1).length === 1);
  if (table === "busy") return sleep(brain, 6);
  if (!table) {
    debugLog(villager, "can't get to a crafting table");
    return setState(villager, brain, "idle", 20 * 30);
  }
  setMode(villager, brain, "work");
  const c = center(table);
  lookAt(villager, c);

  if (item === SHEARS) {
    if (vTake(inv, (id) => id === IRON, 2).length < 2) return setState(villager, brain, "supply");
    vAdd(inv, new ItemStack(SHEARS, 1));
    playSound(dim, "random.anvil_use", c, 1.4);
    debugLog(villager, "made a pair of shears (for carving a pumpkin)");
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  if (item === CARVED) {
    if (!vCount(inv, (id) => id === SHEARS) || vTake(inv, (id) => id === PUMPKIN, 1).length < 1) return setState(villager, brain, "supply");
    vAdd(inv, new ItemStack(CARVED, 1));
    vAdd(inv, new ItemStack("minecraft:pumpkin_seeds", 4));
    playSound(dim, "mob.sheep.shear", c);
    debugLog(villager, "carved a pumpkin for the golem's head");
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  if (item === IRON_BLOCK) {
    const want = 4 - vCount(inv, (id) => id === IRON_BLOCK);
    const n = Math.min(want, Math.floor(vCount(inv, (id) => id === IRON) / 9));
    if (n < 1) return setState(villager, brain, "supply");
    vTake(inv, (id) => id === IRON, n * 9);
    vAdd(inv, new ItemStack(IRON_BLOCK, n));
    playSound(dim, "random.anvil_use", c, 0.9);
    debugLog(villager, `made ${n} iron block(s) for a golem`);
    brain.job = null;
    return setState(villager, brain, "supply");
  }

  if (item === "minecraft:furnace") {
    if (vTake(inv, (id) => id === COBBLE, ARMOR.FURNACE_COBBLE).length < ARMOR.FURNACE_COBBLE) return setState(villager, brain, "supply");
    playSound(dim, "dig.stone", c, 1.2);
    brain.job = { place: "minecraft:furnace" };
    debugLog(villager, "crafted a furnace for charcoal - off to find somewhere to stand it");
    return sleep(brain, 10);
  }

  const r = TOOL_RECIPES[item];
  if (!r || vCount(inv, (id) => id === r.mat) < r.n || !makeSticks(inv, r.sticks)) {
    brain.job = null;
    return setState(villager, brain, "supply");
  }
  vTake(inv, (id) => id === r.mat, r.n);
  vTake(inv, isStick, r.sticks);
  const rest = vAdd(inv, new ItemStack(item, 1));
  if (rest) dim.spawnItem(rest, villager.location);
  playSound(dim, "random.anvil_use", c, 1.2);
  particle(dim, "minecraft:villager_happy", offset(c, 0, 0.8, 0));
  debugLog(villager, `made ${item.includes("iron") ? "an" : "a"} ${item.replace("minecraft:", "").replace("_", " ")}`);
  brain.job = null;
  setState(villager, brain, "supply");
}

/** 1 log -> 4 planks -> 8 sticks, when he's short. */
function makeSticks(inv, n) {
  if (vCount(inv, isStick) >= n) return true;
  if (vTake(inv, isLog, 1).length < 1) return false;
  vAdd(inv, new ItemStack("minecraft:stick", 8));
  return vCount(inv, isStick) >= n;
}

// ================================================================ iron golem

/** Is the village short of iron golems, and is it long enough since he built the last one? */
function wantsGolem(villager, dim, brain, now, ws) {
  if (brain.golemCheck && now - brain.golemCheck.at < 20 * 30) return brain.golemCheck.yes;
  const last = villager.getDynamicProperty(DP_GOLEM);
  const t = world.getAbsoluteTime();
  const due = typeof last !== "number" || t - last >= GOLEM.EVERY || t < last;
  const yes = due && golemsNear(dim, ws).length < golemCap(dim, ws);
  brain.golemCheck = { at: now, yes };
  return yes;
}

/**
 * An iron golem: 4 iron blocks (36 ingots) in a T and a carved pumpkin on top. The pumpkin comes
 * off the farmer and he carves it with shears he makes himself. True if he's off to do a step.
 */
function golemPlan(villager, dim, brain, now, ws, inv) {
  if (!wantsGolem(villager, dim, brain, now, ws)) return false;
  const blocks = vCount(inv, (id) => id === IRON_BLOCK);
  const iron = vCount(inv, (id) => id === IRON);
  if (blocks < 4 && iron + blocks * 9 < GOLEM.IRON) return false; // he'll buy the ore for it (step 3)
  if (!vCount(inv, (id) => id === CARVED)) {
    if (!vCount(inv, (id) => id === PUMPKIN)) return goShopping(villager, brain, "pumpkin", 1, "supply", now);
    if (!vCount(inv, (id) => id === SHEARS)) {
      if (iron + blocks * 9 < GOLEM.IRON + 2) return false;
      brain.job = { craft: SHEARS };
    } else brain.job = { craft: CARVED };
    setState(villager, brain, "craft");
    return true;
  }
  if (blocks < 4) {
    brain.job = { craft: IRON_BLOCK };
    setState(villager, brain, "craft");
    return true;
  }
  brain.job = null;
  debugLog(villager, "the village could do with another iron golem - building one");
  setState(villager, brain, "golem");
  return true;
}

/** Somewhere near his blast furnace with room for a golem: 3 wide, 3 high, and a spot to work from. */
function golemSite(dim, ws) {
  for (const o of ringOffsets(3, 7, [0, 1, -1])) {
    const p = offset(ws, o.x, o.y, o.z);
    if (!isStandable(dim, p)) continue;
    for (const [sx, sz] of [[1, 0], [0, 1]]) {
      let clear = true;
      for (let w = -1; w <= 1 && clear; w++) {
        for (let h = 0; h <= 3 && clear; h++) {
          const b = getBlock(dim, offset(p, sx * w, h, sz * w));
          if (!b?.isAir && !(b && isPassable(b) && !/_sapling|torch|rail|_bed$|door/.test(b.typeId))) clear = false;
        }
      }
      if (!clear) continue;
      for (const f of [1, -1]) {
        const stand = offset(p, sz * 2 * f, 0, sx * 2 * f);
        if (isStandable(dim, stand)) return { p, side: [sx, sz], stand };
      }
    }
  }
  return undefined;
}

function golemState(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  const job = (brain.job ??= { step: 0 });
  if (!job.site) {
    job.site = golemSite(dim, ws);
    if (!job.site) {
      debugLog(villager, "no room near his blast furnace to build a golem");
      villager.setDynamicProperty(DP_GOLEM, world.getAbsoluteTime() - GOLEM.EVERY + 20 * 60 * 3); // try again in a bit
      brain.job = null;
      return setState(villager, brain, "idle", CFG.IDLE_TIME);
    }
  }
  const { p, side, stand } = job.site;
  const cells = [
    { at: p, id: IRON_BLOCK },
    { at: offset(p, 0, 1, 0), id: IRON_BLOCK },
    { at: offset(p, side[0], 1, side[1]), id: IRON_BLOCK },
    { at: offset(p, -side[0], 1, -side[1]), id: IRON_BLOCK },
    { at: offset(p, 0, 2, 0), id: CARVED },
  ];
  // gave up half way: he takes down what he's put up (it's 9 ingots a block)
  const abandon = (why) => {
    debugLog(villager, `couldn't finish the golem: ${why}`);
    for (const c of cells.slice(0, job.step)) {
      const b = getBlock(dim, c.at);
      if (b?.typeId !== c.id) continue;
      b.setType("minecraft:air");
      vAdd(inv, new ItemStack(c.id, 1));
    }
    navStop(villager, brain);
    brain.job = null;
    return setState(villager, brain, "idle", CFG.IDLE_TIME);
  };
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  if (job.step < cells.length) {
    const cell = cells[job.step];
    if (!canUse(dim, villager, cell.at)) {
      // he works from the spot out in front of it (never from where the golem's going)
      job.fails = (job.fails ?? 0) + 1;
      if (job.fails > 6) return abandon(`can't reach ${fmt(cell.at)}`);
      if (!navTo(villager, brain, stand, { radius: 0.6, partial: true })) return abandon("can't get to the spot in front of it");
      return sleep(brain, 4);
    }
    setMode(villager, brain, "work");
    if (vTake(inv, (id) => id === cell.id, 1).length < 1) {
      brain.job = null;
      return setState(villager, brain, "supply");
    }
    if (!placeBlock(villager, dim, cell.at, cell.id, "random.anvil_land")) {
      vAdd(inv, new ItemStack(cell.id, 1));
      return abandon(`something in the way at ${fmt(cell.at)}`);
    }
    job.step++;
    return sleep(brain, 12);
  }
  // all in place: it comes to life
  for (const c of cells) {
    const b = getBlock(dim, c.at);
    if (b?.typeId === c.id) b.setType("minecraft:air");
  }
  try {
    const g = dim.spawnEntity(IRON_GOLEM, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
    g.triggerEvent("minecraft:from_village");
  } catch {}
  for (let i = 0; i < 12; i++) particle(dim, "minecraft:villager_happy", { x: p.x + 0.5 + (Math.random() - 0.5) * 2, y: p.y + Math.random() * 3, z: p.z + 0.5 + (Math.random() - 0.5) * 2 });
  playSound(dim, "mob.irongolem.repair", center(p));
  villager.setDynamicProperty(DP_GOLEM, world.getAbsoluteTime());
  brain.golemCheck = null;
  debugLog(villager, `built an iron golem at ${fmt(p)}`);
  brain.job = null;
  setState(villager, brain, "supply");
}

// ================================================================ smelt

/** Raw iron and raw gold into ingots, in his blast furnace (twice as quick as a furnace). */
function smelt(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const r = walkTo(villager, dim, brain, now, ws);
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");

  const inv = getInventory(villager);
  if (!brain.smeltWhat) {
    const waiting = [IRON, GOLD].find((p) => furnaceHas(dim, ws, p));
    brain.smeltWhat = waiting ? (waiting === IRON ? IRON_RAW : GOLD_RAW) : pickStack(inv, isOre, 64)?.type ?? IRON_RAW;
  }
  const ore = brain.smeltWhat;
  const status = smeltStep(villager, dim, brain, now, ws, {
    furnaces: BLAST_FURNACES,
    ticksPer: 100,
    product: SMELTED[ore],
    isInput: (id) => id === ore,
    pickInput: (i) => pickStack(i, (id) => id === ore, 8), // one lump of coal does 8
    takeFuel: (i) => {
      const [f] = vTake(i, isFuel, 1);
      return f ? new ItemStack(f, 1) : undefined;
    },
  });
  if (status === "working") {
    holdItem(villager, undefined);
    return sleep(brain, 20);
  }
  if (status === "toofar") {
    if (!stepTo(villager, dim, brain, ws)) {
      brain.job = null;
      return setState(villager, brain, "idle", CFG.IDLE_TIME);
    }
    return sleep(brain, 6);
  }
  const got = brain.job?.got ?? 0;
  if (status === "done") debugLog(villager, `took ${got} ${SMELTED[ore].replace("minecraft:", "")} out of the blast furnace`);
  else if (status === "busy") debugLog(villager, "something else is in his blast furnace - leaving it be");
  brain.job = null;
  brain.smeltWhat = null;
  // nothing came out (the furnace isn't burning, or it's full of someone else's things): leave it a while
  const stuck = status === "busy" || (status === "done" && !got);
  setState(villager, brain, stuck ? "idle" : "supply", stuck ? CFG.IDLE_TIME : 0);
}

/** Logs into charcoal in an ordinary furnace - fuel for the blast furnace when there's no coal. */
function char(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const fpos = furnaceNear(dim, ws);
  if (!fpos) return setState(villager, brain, "supply");
  const r = walkTo(villager, dim, brain, now, fpos);
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");
  const status = smeltStep(villager, dim, brain, now, ws, {
    product: "minecraft:charcoal",
    isInput: isLog,
    pickInput: (inv) => pickStack(inv, isLog, ARMOR.CHARCOAL_LOGS),
    takeFuel: plankFuel,
  });
  if (status === "working") return sleep(brain, 20);
  if (status === "toofar") {
    if (!stepTo(villager, dim, brain, fpos)) {
      brain.job = null;
      return setState(villager, brain, "idle", CFG.IDLE_TIME);
    }
    return sleep(brain, 6);
  }
  if (status === "done") debugLog(villager, `burnt ${brain.job?.got ?? 0} charcoal to fire his blast furnace`);
  brain.job = null;
  setState(villager, brain, status === "done" ? "supply" : "idle", status === "done" ? 0 : CFG.IDLE_TIME);
}

function stepTo(villager, dim, brain, pos) {
  const spot = spotNextTo(dim, pos, villager);
  if (spot && navTo(villager, brain, spot, { radius: 0.8 })) return true;
  // no way to stand next to it: he gives up on the furnace for now (see the smelt state)
  brain.tries++;
  return brain.tries <= 4;
}

// ================================================================ stash

/**
 * Tools and gold into the chest, and the shop row restocked from it. He keeps one of each tool
 * on him, so a villager who comes to buy one never finds him sold out while the chest is full.
 */
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

  if (surplus(inv) > 0) {
    for (const { block, container } of chests) {
      const key = fmt(block);
      if (visit.tried.has(key)) continue;
      visit.tried.add(key);
      if (!canUse(dim, villager, block, CFG.REACH + 1)) continue;
      lookAt(villager, center(block));
      playSound(dim, "random.chestopen", center(block));
      // one of each tool stays with him; the rest (and all the gold) goes in the chest
      const kept = [];
      for (const t of Object.keys(TOOL_RECIPES)) kept.push(...vTake(inv, (id) => id === t, 1));
      storeInto(inv, container, isProduct);
      for (const id of kept) vAdd(inv, new ItemStack(id, 1));
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
          debugLog(villager, `placed a chest for his tools at ${fmt(spot)}`);
          return sleep(brain, 16);
        }
      }
    }
  }

  restockSellRow(villager, chests.map((c) => c.container));
  brain.job = null;
  setState(villager, brain, "supply");
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
  if (now - brain.since >= (brain.idleFor || CFG.IDLE_TIME)) return setState(villager, brain, "supply");
  sleep(brain, CFG.THINK_IDLE);
}
