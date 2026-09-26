// Miner - works at a stonecutter:
//   supply   works out what he's missing (pickaxe, crafting table, wood, torches, furnace)
//   shop     walks up to another villager with some to spare (one at his stall first) and buys
//            what he's missing for emeralds, hand to hand (shopping.js)
//   craft    crafts at a crafting table next to his stonecutter - crafting (and placing) the table
//            himself first if there isn't one: pickaxes, torches, a furnace
//   smelt    no coal for torches? he loads logs + plank fuel into his furnace, waits for them to
//            burn into charcoal and takes it out
//   dig      digs a 3 wide x 4 tall staircase mineshaft next to his stonecutter, then level
//            tunnels, block by block with his pickaxe (needs line of sight, stops at water/lava/builds,
//            bridges over holes with cobblestone), lighting it with torches as he goes
//   stash    walks home, stores what he mined in his chest (crafting a chest first if he has none),
//            restocks his shop row, upgrades to a stone pickaxe when he can
//   market   his trading hours: stands at his stonecutter and sells (market.js)
import { BlockPermutation, ItemStack } from "@minecraft/server";
import { BUILD_BLOCK, BUILD_BLOCK_EXCEPTIONS, CFG, LOGS, MINE, MINER_PICKUPS, MINE_AVOID, ORE, oreLevel, PICKAXE_BLOCK, PICKAXES, pickLevel, UNBREAKABLE } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { getTool, giveTool, holdItem, pickupItems, placeBlock, startBreak, updateBreak, wearTool } from "../actions.js";
import { navTo, navUpdate } from "../nav.js";
import { addStockpile } from "../registry.js";
import { takeGood } from "../economy.js";
import { storeInto, vAdd, vCount, vFreeSlots, vTake } from "../inventory.js";
import { restockSellRow } from "../trade.js";
import { canSee, canUse, center, countItems, dist, eyePos, findStandableNear, firstBlockInSight, floorPos, getBlock, getInventory, horizDist, isPassable, isStandable, lookAt, offset, particle, playSound, samePos } from "../util.js";
import { getWorkstation, ownsWorkstation, unemploy } from "./employment.js";
import { isNearHome, spotNextTo, stockpileChests, walkTo } from "./common.js";
import { haveBench, putDown, useBench } from "./workshop.js";
import { fetchWood, woodState } from "./wood.js";
import { goShopping, shop } from "./shopping.js";
import { shopForTool } from "./tools.js";
import { market } from "./market.js";
import { hideState, offDuty, sleepState } from "./rest.js";
import { claimSegment, createMine, findMine, finishSegment, mineOf, newBranch, saveMines, sliceCenter } from "./mines.js";
import { furnaceHas, furnaceNear, pickStack, plankFuel, smeltStep } from "./smelting.js";

const WORKSTATIONS = ["minecraft:stonecutter_block", "minecraft:stonecutter"];
const isLog = (id) => LOGS.has(id);
const isWanted = (id) => MINER_PICKUPS.has(id);
const isFuel = (id) => id === "minecraft:coal" || id === "minecraft:charcoal";
const isStick = (id) => id === "minecraft:stick";
const isTorch = (id) => id === "minecraft:torch";
const STONEISH = new Set(["minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:andesite", "minecraft:diorite", "minecraft:granite", "minecraft:tuff"]);
const COBBLE = "minecraft:cobblestone";
const IRON_RAW = "minecraft:raw_iron";
const IRON = "minecraft:iron_ingot";
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;

export function minerThink(villager, dim, brain, now) {
  const ws = getWorkstation(villager);
  if (!ws) return unemploy(villager, dim, brain);
  if (!ownsWorkstation(villager, ws)) return unemploy(villager, dim, brain, true); // someone else's job block
  const wsBlock = getBlock(dim, ws);
  if (wsBlock && !WORKSTATIONS.includes(wsBlock.typeId)) return unemploy(villager, dim, brain, true);
  if (!STATES[brain.state]) setState(villager, brain, "supply");
  offDuty(villager, dim, brain, now, ws, { interruptible: ["supply", "idle", "dig"], chestKind: "stone" });
  STATES[brain.state](villager, dim, brain, now, ws);
}

const STATES = {
  supply,
  shop,
  wood: woodState,
  craft,
  smelt,
  dig,
  stash,
  idle,
  market: (v, d, b, n, ws) => market(v, d, b, n, ws, { chestKind: "stone", backTo: "supply" }),
  sleep: (v, d, b, n, ws) => sleepState(v, d, b, n, ws, "supply"),
  hide: (v, d, b, n, ws) => hideState(v, d, b, n, ws, "supply"),
};

// ================================================================ supply

function supply(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest");
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  const tableCost = haveBench(dim, ws) ? 0 : 1;

  // 1. a pickaxe: stone if he has the cobblestone and a stick (or a log for sticks), else wooden
  //    (2 logs for planks + sticks) - plus 1 log for the crafting table if there isn't one
  if (!getTool(villager, "pickaxe")) {
    const logs = vCount(inv, isLog);
    const sticksOk = vCount(inv, isStick) >= 2 ? logs >= tableCost : logs >= 1 + tableCost;
    if (vCount(inv, (id) => id === COBBLE) >= 3 && sticksOk) {
      brain.job = { craft: "minecraft:stone_pickaxe" };
      return setState(villager, brain, "craft");
    }
    if (logs < 2 + tableCost) {
      // no pickaxe at all - he can't mine a thing without one, so he buys the wood if anyone will
      // sell it and otherwise goes and cuts it himself rather than waiting about
      if (goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, "supply", now, true)) return;
      if (fetchWood(villager, brain, 2 + tableCost, "supply", now)) return;
      return setState(villager, brain, "idle", 20 * 20);
    }
    brain.job = { craft: "minecraft:wooden_pickaxe" };
    return setState(villager, brain, "craft");
  }

  // 2. a better pickaxe, if he's run into ore his own won't get out of the rock
  if (pickPlan(villager, dim, brain, now, ws, inv)) return;

  // 3. torches to light the mine
  if (torchPlan(villager, dim, brain, now, ws, inv, tableCost)) return;

  setState(villager, brain, "dig");
}

/**
 * Iron pickaxe: gold, redstone and diamond all need one, so as soon as he's got three iron out of
 * the rock he smelts them down and makes himself one. Returns true if he's off to do that.
 */
function pickPlan(villager, dim, brain, now, ws, inv) {
  const pick = getTool(villager, "pickaxe");
  if (!pick || pickLevel(pick.id) >= 3) return false;
  const haveHandle = vCount(inv, isStick) >= 2 || vCount(inv, isLog) >= 1;

  // wooden -> stone first: even iron ore needs a stone pickaxe to come out of the rock
  if (pickLevel(pick.id) < 2 && haveHandle && vCount(inv, (id) => id === COBBLE) >= 3) {
    brain.job = { craft: "minecraft:stone_pickaxe" };
    setState(villager, brain, "craft");
    return true;
  }
  if ((brain.noIronUntil ?? 0) > now) return false;
  if (vCount(inv, (id) => id === IRON) >= 3) {
    if (!haveHandle) {
      brain.noIronUntil = now + CFG.BUY_RETRY; // no handle for it yet
      return false;
    }
    brain.job = { craft: "minecraft:iron_pickaxe" };
    setState(villager, brain, "craft");
    return true;
  }
  if (vCount(inv, (id) => id === IRON_RAW) < 3) return false; // he'll come across some as he digs
  const furnace = furnaceNear(dim, ws);
  if (!furnace) {
    if (vCount(inv, (id) => id === COBBLE) < 8) return false; // the furnace comes first
    brain.job = { craft: "minecraft:furnace" };
    setState(villager, brain, "craft");
    return true;
  }
  if (!vCount(inv, isFuel) && !vCount(inv, isLog)) {
    brain.noIronUntil = now + CFG.BUY_RETRY; // nothing to fire the furnace with yet
    return false;
  }
  brain.job = null;
  brain.smeltWhat = "iron";
  debugLog(villager, "three raw iron - time he had a proper pickaxe");
  setState(villager, brain, "smelt");
  return true;
}

/**
 * Makes sure he has torches: crafts them from coal (or charcoal) and sticks; with no coal he
 * smelts logs into charcoal in a furnace (crafting the furnace from 8 cobblestone first); buys
 * the logs from another villager when he has none. Returns true if he's off to do one of those.
 */
function torchPlan(villager, dim, brain, now, ws, inv, tableCost) {
  if (vCount(inv, isTorch) >= CFG.TORCH_WANT || (brain.noTorchesUntil ?? 0) > now || mineOf(villager)?.done) return false;
  const later = (why) => {
    debugLog(villager, `no torches for now: ${why}`);
    brain.noTorchesUntil = now + CFG.BUY_RETRY;
    return false;
  };
  const logs = vCount(inv, isLog);
  const buyLogs = (why, need = SMELT_LOGS + 2) => {
    debugLog(villager, `needs logs ${why}`);
    return (
      goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, "supply", now) ||
      fetchWood(villager, brain, need, "supply", now) ||
      later(`couldn't get logs ${why}`)
    );
  };

  // coal (from the mine, or charcoal he smelted): 1 coal + 1 stick -> 4 torches
  if (countItems(inv, isFuel) >= 1) {
    if (vCount(inv, isStick) < 1 && logs < 1 + tableCost) return buyLogs("for sticks", 1 + tableCost);
    brain.job = { craft: "minecraft:torch" };
    setState(villager, brain, "craft");
    return true;
  }

  // no coal: charcoal. The furnace comes first (8 cobblestone - he digs those himself).
  const furnace = furnaceNear(dim, ws);
  if (!furnace) {
    if (vCount(inv, (id) => id === COBBLE) < 8) return later("no coal, and not enough cobblestone for a furnace yet");
    if (logs < tableCost) return buyLogs("for a crafting table", tableCost);
    brain.job = { craft: "minecraft:furnace" };
    setState(villager, brain, "craft");
    return true;
  }
  // logs to burn (4) + 1 for plank fuel + 1 for sticks
  if (logs < SMELT_LOGS + 2 && !furnaceHas(dim, furnace, "minecraft:charcoal")) return buyLogs("to make charcoal");
  brain.job = null;
  setState(villager, brain, "smelt");
  return true;
}

const SMELT_LOGS = 4;

// ================================================================ craft

function craft(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);

  // something he's crafted and now has to stand somewhere (his furnace)
  if (brain.job?.place) {
    const what = brain.job.place;
    const at = putDown(villager, dim, brain, now, ws, what, "use.stone");
    if (at === "busy") return sleep(brain, 4);
    if (at) debugLog(villager, `stood his ${what.replace("minecraft:", "")} at ${fmt(at)}`);
    else {
      debugLog(villager, `nowhere to put the ${what.replace("minecraft:", "")}`);
      brain.noTorchesUntil = now + CFG.BUY_RETRY;
    }
    brain.job = null;
    return setState(villager, brain, "supply");
  }

  const item = brain.job?.craft;
  if (!item) return setState(villager, brain, "supply");

  // he crafts at a crafting table: the village's nearest (he walks over to it) or, if there isn't
  // one anywhere about, one he knocks together himself from a log
  const table = useBench(villager, dim, brain, now, ws, () => vTake(inv, isLog, 1).length === 1);
  if (table === "busy") return sleep(brain, 6);
  if (!table) {
    debugLog(villager, "can't get to a crafting table");
    return setState(villager, brain, "idle", 20 * 30);
  }
  setMode(villager, brain, "work");

  const c = center(table);
  if (item === "minecraft:wooden_pickaxe") {
    if (vTake(inv, isLog, 2).length < 2) return setState(villager, brain, "supply");
    finishCraft(villager, dim, c, item);
    vAdd(inv, new ItemStack("minecraft:stick", 2)); // 8 planks: 3 for the head, 2 for 4 sticks
  } else if (item === "minecraft:stone_pickaxe") {
    if (!makeSticks(inv, 2)) return setState(villager, brain, "dig");
    vTake(inv, isStick, 2);
    vTake(inv, (id) => id === COBBLE, 3);
    finishCraft(villager, dim, c, item); // the old wooden one stays with him as a spare
  } else if (item === "minecraft:iron_pickaxe") {
    if (vCount(inv, (id) => id === IRON) < 3 || !makeSticks(inv, 2)) return setState(villager, brain, "dig");
    vTake(inv, isStick, 2);
    vTake(inv, (id) => id === IRON, 3);
    finishCraft(villager, dim, c, item);
  } else if (item === "minecraft:torch") {
    // 1 coal/charcoal + 1 stick -> 4 torches, a few at a time
    const batches = Math.min(4, countItems(inv, isFuel));
    if (!batches || !makeSticks(inv, batches)) return setState(villager, brain, "supply");
    takeFuel(inv, batches);
    vTake(inv, isStick, batches);
    lookAt(villager, c);
    const rest = vAdd(inv, new ItemStack("minecraft:torch", batches * 4));
    if (rest) dim.spawnItem(rest, villager.location);
    playSound(dim, "dig.wood", c, 1.4);
    particle(dim, "minecraft:villager_happy", offset(c, 0, 0.8, 0));
    debugLog(villager, `crafted ${batches * 4} torches`);
  } else if (item === "minecraft:furnace") {
    // 8 cobblestone at the table, then he looks for room for it near his stonecutter
    if (vCount(inv, (id) => id === COBBLE) < 8) {
      debugLog(villager, "not enough cobblestone for a furnace");
      brain.noTorchesUntil = now + CFG.BUY_RETRY;
    } else {
      lookAt(villager, c);
      playSound(dim, "dig.stone", c, 1.2);
      vTake(inv, (id) => id === COBBLE, 8);
      brain.job = { place: "minecraft:furnace" };
      debugLog(villager, "crafted a furnace - off to find somewhere to stand it");
      return sleep(brain, 10);
    }
  }
  brain.job = null;
  setState(villager, brain, "supply");
}

/** Makes sure he has `n` sticks, turning a log into sticks if he's short (1 log -> 4 planks -> 8 sticks). */
function makeSticks(inv, n) {
  if (vCount(inv, isStick) >= n) return true;
  if (vTake(inv, isLog, 1).length < 1) return false;
  vAdd(inv, new ItemStack("minecraft:stick", 8));
  return vCount(inv, isStick) >= n;
}

/** Coal from his pockets first, then from his shop row. */
function takeFuel(inv, n) {
  const got = vTake(inv, isFuel, n).length;
  if (got < n) takeGood(inv, "coal", n - got);
}

function finishCraft(villager, dim, tableCenter, item) {
  try {
    villager.teleport(villager.location, { facingLocation: tableCenter });
  } catch {}
  giveTool(villager, item);
  playSound(dim, "dig.wood", tableCenter, 1.4);
  particle(dim, "minecraft:villager_happy", offset(tableCenter, 0, 0.8, 0));
  debugLog(villager, `crafted a ${item.replace("minecraft:", "").replace("_", " ")}`);
}

// ================================================================ smelt

/**
 * Charcoal, like a player makes it: logs in the top slot, planks as fuel, wait for them to burn
 * (10 seconds each), take the charcoal out. (smelting.js does the furnace work.)
 */
function smelt(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const r = walkTo(villager, dim, brain, now, furnaceNear(dim, ws) ?? ws); // stand at the furnace itself
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");

  const iron = brain.smeltWhat === "iron";
  const status = smeltStep(
    villager,
    dim,
    brain,
    now,
    ws,
    iron
      ? {
          product: IRON,
          isInput: (id) => id === IRON_RAW,
          pickInput: (inv) => pickStack(inv, (id) => id === IRON_RAW, 8),
          takeFuel: anyFuel,
        }
      : {
          product: "minecraft:charcoal",
          isInput: isLog,
          pickInput: (inv) => pickStack(inv, isLog, SMELT_LOGS),
          takeFuel: plankFuel,
        }
  );
  if (status === "working") return sleep(brain, 20);
  if (status === "toofar") {
    stepToFurnace(villager, dim, brain, now, ws);
    return sleep(brain, 6);
  }
  const got = brain.job?.got ?? 0;
  const later = () => {
    if (iron) brain.noIronUntil = now + CFG.BUY_RETRY;
    else brain.noTorchesUntil = now + CFG.BUY_RETRY;
  };
  if (status === "done") {
    debugLog(villager, `took ${got} ${iron ? "iron ingot(s)" : "charcoal"} out of the furnace`);
    if (!got) {
      debugLog(villager, "the furnace isn't burning - leaving it for now");
      later();
    }
  } else if (status === "busy") {
    debugLog(villager, "someone else's things are in the furnace - leaving it be");
    later();
  } else if (status === "nothing") {
    later();
  }
  brain.job = null;
  brain.smeltWhat = null;
  setState(villager, brain, "supply");
}

/** Coal if he has any (8 items a lump), otherwise planks off a log. */
function anyFuel(inv) {
  const [coal] = vTake(inv, isFuel, 1);
  return coal ? new ItemStack(coal, 1) : plankFuel(inv);
}
/** Stands right next to the furnace when he can't reach it from where he is. */
function stepToFurnace(villager, dim, brain, now, ws) {
  const fpos = furnaceNear(dim, ws);
  if (!fpos) return false;
  const spot = spotNextTo(dim, fpos, villager);
  if (spot && navTo(villager, brain, spot, { radius: 0.8 })) return true;
  brain.tries++;
  if (brain.tries > 3) {
    try {
      villager.teleport(center(spot ?? fpos));
    } catch {}
    brain.tries = 0;
  }
  return true;
}
// ================================================================ dig

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** The 3x4 blocks of slice i, top row first, middle column first. */
function sliceBlocks(seg, i) {
  const c = sliceCenter(seg, i);
  const px = -seg.dz;
  const pz = seg.dx;
  const out = [];
  for (let h = MINE.HEIGHT - 1; h >= 0; h--) for (const w of [0, -1, 1]) out.push({ x: c.x + px * w, y: c.y + h, z: c.z + pz * w });
  return out;
}

function unsafe(dim, p) {
  const b = getBlock(dim, p);
  if (!b) return "unloaded";
  if (UNBREAKABLE.test(b.typeId)) return b.typeId;
  if (MINE_AVOID.test(b.typeId)) return b.typeId; // somebody's path, field or house
  if (BUILD_BLOCK.test(b.typeId) && !BUILD_BLOCK_EXCEPTIONS.has(b.typeId) && !PICKAXE_BLOCK.test(b.typeId)) return b.typeId;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = getBlock(dim, offset(p, dx, dy, dz));
    if (n?.isLiquid || /water|lava/.test(n?.typeId ?? "")) return n.typeId;
  }
  return undefined;
}

/**
 * Is there anything of the village where this shaft would go? He looks along the mouth of it - a
 * block wider and a block higher than the tunnel itself - for paths, fields, houses and gardens,
 * so he doesn't start his staircase in the middle of somebody's front garden.
 */
function villageInTheWay(dim, seg, slices = 6) {
  for (let i = -1; i < slices; i++) {
    const c = sliceCenter(seg, i);
    for (let w = -2; w <= 2; w++) {
      for (let h = -1; h <= MINE.HEIGHT; h++) {
        const b = getBlock(dim, { x: c.x - seg.dz * w, y: c.y + h, z: c.z + seg.dx * w });
        if (!b) return "unloaded chunk";
        if (MINE_AVOID.test(b.typeId)) return b.typeId.replace("minecraft:", "");
      }
    }
  }
  return undefined;
}

/**
 * Where to start the shaft: the direction whose first slices are safest and most solid, moved
 * further out from the stonecutter (up to MINE.MAX_SHIFT) until it's clear of the village.
 */
function planMine(dim, ws, bad = [], villager = undefined) {
  let best;
  for (const [dx, dz] of DIRS) {
    if (bad.includes(`${dx},${dz}`)) continue;
    let blockedBy;
    for (let off = MINE.START_OFFSET; off <= MINE.START_OFFSET + MINE.MAX_SHIFT; off += 2) {
      const seg = { ox: ws.x + dx * off, oy: ws.y, oz: ws.z + dz * off, dx, dz, len: MINE.FIRST_LENGTH, descend: true };
      const village = villageInTheWay(dim, seg);
      if (village) {
        blockedBy ??= village;
        continue; // try a bit further out in this direction
      }
      let solid = 0;
      let hazard = false;
      for (let i = 0; i < 6 && !hazard; i++) {
        for (const p of sliceBlocks(seg, i)) {
          const b = getBlock(dim, p);
          if (!b || unsafe(dim, p)) {
            hazard = true;
            break;
          }
          if (!isPassable(b)) solid++;
        }
      }
      if (hazard) continue;
      const score = solid - (off - MINE.START_OFFSET) * 6; // all else equal, close to home
      if (!best || score > best.score) best = { seg, score, off, why: blockedBy };
      break; // the nearest workable start in this direction is the one he'd use
    }
  }
  if (villager && best?.why) {
    debugLog(villager, `started the shaft ${best.off} blocks out - ${best.why} in the way closer in`);
  }
  return best && { segs: [best.seg], cur: 0, i: 0, bad };
}

function needsStash(inv) {
  return vFreeSlots(inv) <= 1 || vCount(inv, (id) => STONEISH.has(id)) >= MINE.RETURN_AT;
}

/**
 * Which mine and which tunnel of it he works on: joins a mine within MINE.SHARE_RADIUS of his
 * stonecutter, or plans his own. Returns {mine, seg} ({mine} alone when it's finished), or
 * undefined if there's nowhere safe to dig.
 */
function workplace(villager, dim, ws, now) {
  let mine = findMine(villager, dim.id, ws);
  if (!mine) {
    const plan = planMine(dim, ws, [], villager);
    if (!plan) return undefined;
    mine = createMine(villager, dim.id, ws, plan.segs[0]);
    const s0 = mine.segs[0];
    debugLog(villager, `planned a new mineshaft heading ${s0.dx},${s0.dz} from ${s0.ox} ${s0.oy} ${s0.oz}`);
  }
  if (mine.done) return { mine };
  let seg = claimSegment(mine, villager.id, now);
  if (!seg) {
    seg = newBranch(mine, villager.id, now);
    if (seg) debugLog(villager, `starting a new tunnel (#${mine.segs.length}) off the mine at ${mine.x} ${mine.y} ${mine.z}`);
  }
  if (!seg) {
    if (mine.segs.some((s) => !s.done)) {
      // someone's still digging the shaft - nothing to branch off yet
      if (now - (brain_waitSaid.get(villager.id) ?? -1e9) > 20 * 60) {
        brain_waitSaid.set(villager.id, now);
        debugLog(villager, `waiting for the shaft of the mine at ${mine.x} ${mine.y} ${mine.z} to get deep enough to branch off`);
      }
      return { mine, wait: true };
    }
    mine.done = true;
    saveMines();
    debugLog(villager, "mine finished");
    return { mine };
  }
  if (seg !== brain_lastSeg.get(villager.id)) {
    brain_lastSeg.set(villager.id, seg);
    const who = mine.segs.filter((s) => s.owner && !s.done).length;
    debugLog(villager, `working tunnel #${mine.segs.indexOf(seg) + 1} of the mine at ${mine.x} ${mine.y} ${mine.z} (${who} miner(s) digging there)`);
  }
  return { mine, seg };
}
const brain_lastSeg = new Map();
const brain_waitSaid = new Map();

/** This tunnel ends here (water, lava, can't reach the face...). The very first shaft re-plans. */
function endTunnel(villager, dim, mine, seg, why) {
  debugLog(villager, `${why} - ending this tunnel`);
  seg.len = seg.i;
  if (mine.segs.indexOf(seg) === 0 && seg.len < 3) {
    // the staircase didn't get anywhere: try another direction from the same stonecutter
    mine.bad = [...(mine.bad ?? []), `${seg.dx},${seg.dz}`];
    const plan = planMine(dim, mine, mine.bad, villager);
    if (plan) {
      Object.assign(seg, plan.segs[0], { i: 0, done: false });
      debugLog(villager, `shaft heading didn't work out - trying ${seg.dx},${seg.dz} instead`);
      return saveMines();
    }
    mine.done = true;
  }
  finishSegment(mine, seg);
}

function dig(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);

  if (brain.action) {
    const id = brain.action.id;
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    if (r === "done" && PICKAXE_BLOCK.test(id)) wearTool(villager, "pickaxe");
    pickupItems(villager, dim, inv, isWanted);
    return;
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed") brain.digWalkFails = (brain.digWalkFails ?? 0) + 1;
  }
  pickupItems(villager, dim, inv, isWanted);

  const pick = getTool(villager, "pickaxe");
  if (!pick) return setState(villager, brain, "supply");
  if (needsStash(inv)) return setState(villager, brain, "stash");

  const work = workplace(villager, dim, ws, now);
  if (!work) {
    debugLog(villager, "no safe place to dig a mineshaft here");
    return setState(villager, brain, "idle", 20 * 60);
  }
  const { mine, seg } = work;
  if (!seg) return setState(villager, brain, "idle", work.wait ? 20 * 20 : 20 * 60);
  if (seg.i >= seg.len) return finishSegment(mine, seg);

  // stand in the previous slice, facing the rock
  const stand = seg.i === 0 ? { x: seg.ox - seg.dx, y: seg.oy, z: seg.oz - seg.dz } : sliceCenter(seg, seg.i - 1);
  const l = villager.location;
  if (now - (brain.digTrace ?? 0) > 100) {
    brain.digTrace = now;
    debugLog(villager, `dig: tunnel ${mine.segs.indexOf(seg) + 1} slice ${seg.i}/${seg.len}, stand ${fmt(stand)} (standable=${isStandable(dim, stand)}), at ${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)}, walkFails=${brain.digWalkFails ?? 0}`);
  }
  if (!getBlock(dim, stand)) return sleep(brain, 20); // not loaded yet - wait, don't give up on it
  // a long way off (his tunnel is in a shared mine): walk over there first
  if (horizDist(l, center(stand)) > 16) {
    if ((brain.digWalkFails ?? 0) >= 2) {
      // can't find the way (e.g. hemmed in by leaves): last resort, like walkTo does
      const to = isStandable(dim, stand) ? stand : findStandableNear(dim, stand, 1, 1);
      if (to) {
        debugLog(villager, "couldn't walk to his tunnel - teleporting");
        villager.teleport(center(to));
        brain.digWalkFails = 0;
      }
      return sleep(brain, 10);
    }
    if (navTo(villager, brain, isStandable(dim, stand) ? stand : findStandableNear(dim, stand, 1, 1) ?? stand, { radius: 0.9 })) return sleep(brain, 4);
    brain.digWalkFails = (brain.digWalkFails ?? 0) + 1;
    return sleep(brain, 10);
  }
  // (if that exact spot isn't standable, e.g. a flower pot or slab, stand right next to it)
  const spot = isStandable(dim, stand) ? stand : findStandableNear(dim, stand, 1, 1);
  if (!spot) {
    brain.digWalkFails = 0;
    return endTunnel(villager, dim, mine, seg, `can't get to the tunnel face at ${fmt(stand)}`);
  }
  if ((brain.digWalkFails ?? 0) >= 3) {
    // one step away and still not getting there (a corner of his own tunnel): step over it
    debugLog(villager, `couldn't take the last step to ${fmt(spot)} - stepping over`);
    try {
      villager.teleport(center(spot));
    } catch {}
    brain.digWalkFails = 0;
    return sleep(brain, 6);
  }
  if (horizDist(l, center(spot)) > 1.0 || Math.abs(l.y - spot.y) > 0.6) {
    if (navTo(villager, brain, spot, { radius: 0.5 })) return sleep(brain, 4);
    brain.digWalkFails = (brain.digWalkFails ?? 0) + 1;
    return sleep(brain, 10);
  }
  brain.digWalkFails = 0;
  setMode(villager, brain, "work");
  holdItem(villager, pick.id);

  // safety: water, lava, builds, bedrock -> this tunnel ends here
  const blocks = sliceBlocks(seg, seg.i);
  for (const p of blocks) {
    if (isPassable(getBlock(dim, p))) continue;
    const why = unsafe(dim, p);
    if (why === "unloaded") return sleep(brain, 20);
    if (why) return endTunnel(villager, dim, mine, seg, `stopped the tunnel at ${fmt(p)}: ${why}`);
  }

  // floor: bridge over holes / caves with cobblestone, like a player would
  const c = sliceCenter(seg, seg.i);
  for (const w of [0, -1, 1]) {
    const f = { x: c.x - seg.dz * w, y: c.y - 1, z: c.z + seg.dx * w };
    const fb = getBlock(dim, f);
    if (fb && isPassable(fb) && !fb.isLiquid) {
      if (vTake(inv, (id) => id === COBBLE, 1).length) {
        placeBlock(villager, dim, f, COBBLE, "use.stone");
        return sleep(brain, 6);
      }
      if (w === 0) return endTunnel(villager, dim, mine, seg, "hole in the floor and no cobblestone to fill it");
    }
  }

  // dig the next block he can see. Natural blocks in the space right in front of the face (the
  // previous slice - e.g. a bush at the entrance) get cleared too when they're in the way.
  const set = new Set(blocks.map(fmt));
  const approachSet = new Set(sliceBlocks(seg, seg.i - 1).map(fmt));
  const feetBelow = fmt(offset(floorPos(villager.location), 0, -1, 0));
  for (const p of blocks) {
    const b = getBlock(dim, p);
    if (!b || isPassable(b)) continue;
    const seen = firstBlockInSight(dim, villager, p);
    if (!seen) continue;
    const key = fmt(seen);
    const ok = set.has(key) || (approachSet.has(key) && key !== feetBelow && !unsafe(dim, seen));
    if (ok && dist(eyePos(villager), center(seen)) <= CFG.REACH) {
      // ore in the way of the tunnel that his pickaxe is too soft for: he goes and makes a better
      // one if he can, and otherwise breaks through it knowing it'll come to nothing
      const tooSoft = ORE.test(seen.typeId) && oreLevel(seen.typeId) > pickLevel(pick.id);
      if (tooSoft && pickPlan(villager, dim, brain, now, ws, inv)) return;
      startBreak(brain, seen, pick, tooSoft);
      setWorking(villager, true);
      return;
    }
  }
  if (blocks.some((p) => !isPassable(getBlock(dim, p)))) {
    // something blocks the view - try once more next tick, then give up on this tunnel
    brain.blind = (brain.blind ?? 0) + 1;
    if (brain.blind > 10) {
      brain.blind = 0;
      return endTunnel(villager, dim, mine, seg, "can't see the rest of the tunnel face");
    }
    return sleep(brain, 4);
  }
  brain.blind = 0;

  // ore showing in the walls of the tunnel: dig the vein out and pack the holes back up
  if (oreStep(villager, dim, brain, seg, inv, pick)) return;

  // slice done - light it up every few slices, then step forward
  setWorking(villager, false);
  const darkHere = !brain.lastTorch || dist(brain.lastTorch, center(sliceCenter(seg, seg.i))) > CFG.TORCH_GAP;
  if (((seg.i + 1) % CFG.TORCH_EVERY === 0 || darkHere) && placeTorch(villager, dim, seg, seg.i, inv, brain)) return sleep(brain, 6);
  seg.i++;
  seg.seen = now;
  saveMines();
  if (seg.i % 8 === 0) debugLog(villager, `tunnel ${mine.segs.indexOf(seg) + 1}: ${seg.i}/${seg.len}`);
  sleep(brain, 4);
}
/**
 * Ore in the tunnel walls. Like a player, he stops when something shows in the rock, follows the
 * vein as far as he can reach and then fills the holes he's left behind with spare cobblestone,
 * so the tunnel comes out with tidy walls instead of pockets everywhere.
 *
 * Returns true while he's busy with a vein (the tunnel waits).
 */
function oreStep(villager, dim, brain, seg, inv, pick) {
  const job = (brain.oreJob ??= { fill: [], dug: 0 });
  const tunnel = new Set();
  for (let i = seg.i - 1; i <= seg.i + 1; i++) for (const p of sliceBlocks(seg, i)) tunnel.add(fmt(p));

  // 1. anything left to dig out? (nearest first, and only what he can see and reach)
  if (job.dug < MINE.ORE_VEIN) {
    const c = sliceCenter(seg, seg.i - 1);
    const r = MINE.ORE_REACH;
    let target;
    let bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -1; dy <= MINE.HEIGHT; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
          if (tunnel.has(fmt(p))) continue; // the tunnel face itself gets dug anyway
          const b = getBlock(dim, p);
          if (!b || !ORE.test(b.typeId)) continue;
          if (oreLevel(b.typeId) > pickLevel(pick.id)) {
            // his pickaxe is too soft: it would break and drop nothing, so he leaves it in the
            // wall (and goes and makes himself a better one - see pickPlan)
            if (!brain.sawHardOre) debugLog(villager, `${b.typeId.replace("minecraft:", "")} here, but his ${pick.id.replace("minecraft:", "")} won't get it out`);
            brain.sawHardOre = true;
            continue;
          }
          const d = dist(eyePos(villager), center(p));
          if (d >= bestD || !canUse(dim, villager, p)) continue;
          target = { block: b, p, id: b.typeId };
          bestD = d;
        }
      }
    }
    if (target) {
      if (!job.dug) debugLog(villager, `${target.id.replace("minecraft:", "")} in the tunnel wall - digging it out`);
      job.dug++;
      job.fill.push(target.p);
      lookAt(villager, center(target.p));
      startBreak(brain, target.block, pick);
      setWorking(villager, true);
      return true;
    }
  }

  // 2. vein done: brick the holes up again, the farthest away first
  setWorking(villager, false);
  if (job.fill.length) {
    const here = floorPos(villager.location);
    job.fill.sort((a, b) => dist(center(a), villager.location) - dist(center(b), villager.location));
    while (job.fill.length) {
      const p = job.fill.pop();
      const b = getBlock(dim, p);
      const standingThere = samePos(p, here) || samePos(p, offset(here, 0, 1, 0)) || samePos(p, offset(here, 0, -1, 0));
      if (!b || !isPassable(b) || tunnel.has(fmt(p)) || standingThere) continue;
      if (!canUse(dim, villager, p)) continue; // out of reach now - leave that one open
      if (!vTake(inv, (id) => id === COBBLE, 1).length) {
        job.fill.length = 0; // nothing to fill with; he'll do better next time
        break;
      }
      placeBlock(villager, dim, p, COBBLE, "use.stone");
      return true;
    }
  }
  brain.oreJob = null;
  return false;
}

// torch_facing_direction names the side the supporting block is on (checked on BDS with
// /scriptevent iv:torchtest - the other way round they pop off at the next block update)
const TORCH_FACING = { "1,0": "east", "-1,0": "west", "0,1": "south", "0,-1": "north" };

/** Hangs a torch on the tunnel wall at head height in slice i. False if there's nothing to do. */
function placeTorch(villager, dim, seg, i, inv, brain) {
  if (vCount(inv, isTorch) < 1) return false;
  const c = sliceCenter(seg, i);
  if (brain.torchAt === fmt(c)) return false; // one go per slice, even if it didn't stick
  const px = -seg.dz;
  const pz = seg.dx;
  for (const w of i % 2 ? [1, -1] : [-1, 1]) {
    const t = { x: c.x + px * w, y: c.y + 2, z: c.z + pz * w };
    const tb = getBlock(dim, t);
    if (tb?.typeId === "minecraft:torch") return false; // already lit
    const wb = getBlock(dim, { x: c.x + px * 2 * w, y: c.y + 2, z: c.z + pz * 2 * w });
    if (!tb?.isAir || !wb || isPassable(wb) || wb.isLiquid) continue;
    if (!canUse(dim, villager, t)) continue;
    try {
      lookAt(villager, center(t));
      tb.setPermutation(BlockPermutation.resolve("minecraft:torch", { torch_facing_direction: TORCH_FACING[`${px * w},${pz * w}`] }));
    } catch (e) {
      debugLog(villager, `couldn't place a torch: ${e}`);
      return false;
    }
    vTake(inv, isTorch, 1);
    brain.torchAt = fmt(c);
    brain.lastTorch = center(t);
    playSound(dim, "use.wood", center(t));
    debugLog(villager, `placed a torch at ${fmt(t)}`);
    return true;
  }
  // no wall to hang it on (he's broken into a cave): stand one on the floor beside him
  for (const w of [1, -1, 0]) {
    const t = { x: c.x + px * w, y: c.y, z: c.z + pz * w };
    const tb = getBlock(dim, t);
    if (tb?.typeId === "minecraft:torch") return false;
    const floor = getBlock(dim, offset(t, 0, -1, 0));
    if (!tb?.isAir || !floor || isPassable(floor) || floor.isLiquid) continue;
    if (!canUse(dim, villager, t)) continue;
    try {
      lookAt(villager, center(t));
      tb.setPermutation(BlockPermutation.resolve("minecraft:torch", { torch_facing_direction: "top" }));
    } catch {
      return false;
    }
    vTake(inv, isTorch, 1);
    brain.torchAt = fmt(c);
    brain.lastTorch = center(t);
    playSound(dim, "use.wood", center(t));
    debugLog(villager, `stood a torch on the floor at ${fmt(t)}`);
    return true;
  }
  return false;
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
  const chests = stockpileChests(dim, ws, "stone");

  // keep: tools, emeralds, some logs/sticks, torches, a little coal for torches, 16 cobblestone
  // for bridging - and his diamonds and redstone, which the armorer and cartographer buy off him
  const cobble = vCount(inv, (id) => id === COBBLE);
  const coal = vCount(inv, isFuel);
  const iron = vCount(inv, (id) => id === IRON_RAW || id === IRON);
  const wantsIron = pickLevel(getTool(villager, "pickaxe")?.id ?? "") < 3;
  const extra = (id) =>
    !PICKAXES[id] &&
    id !== "minecraft:emerald" &&
    !isLog(id) &&
    !isStick(id) &&
    !isTorch(id) &&
    id !== "minecraft:diamond" &&
    id !== "minecraft:redstone" &&
    !(isFuel(id) && coal <= 8) &&
    !(id === COBBLE && cobble <= 16) &&
    !(wantsIron && (id === IRON_RAW || id === IRON) && iron <= 3); // saving up for an iron pickaxe

  if (vCount(inv, extra) > 0) {
    for (const { block, container } of chests) {
      const key = fmt(block);
      if (visit.tried.has(key)) continue;
      visit.tried.add(key);
      if (!canUse(dim, villager, block, CFG.REACH + 1)) continue; // not through a wall
      try {
        villager.teleport(villager.location, { facingLocation: center(block) });
      } catch {}
      playSound(dim, "random.chestopen", center(block));
      const keepCobble = cobble > 16 ? vTake(inv, (id) => id === COBBLE, 16).length : 0;
      storeInto(inv, container, extra);
      if (keepCobble) vAdd(inv, new ItemStack(COBBLE, keepCobble));
      return sleep(brain, 16);
    }
    // no chest (or full): craft one from 2 logs - buy the wood, or cut it himself, if he has none
    if (visit.placed < 2) {
      if (vCount(inv, isLog) < CFG.CHEST_COST_LOGS) {
        if (!chests.length) {
          if (goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, "stash", now)) return;
          if (fetchWood(villager, brain, CFG.CHEST_COST_LOGS, "stash", now)) return;
        }
      } else {
        const spot = putDown(villager, dim, brain, now, ws, "minecraft:chest");
        if (spot === "busy") return sleep(brain, 4);
        if (spot) {
          vTake(inv, isLog, CFG.CHEST_COST_LOGS);
          addStockpile(dim.id, spot, "stone", villager.id);
          visit.placed++;
          visit.tried.clear();
          debugLog(villager, `placed a chest for his stone at ${fmt(spot)}`);
          return sleep(brain, 16);
        }
      }
    }
  }

  restockSellRow(villager, chests.map((c) => c.container));

  // upgrade: 3 cobblestone + 2 sticks -> stone pickaxe
  const pick = getTool(villager, "pickaxe");
  if (pick && PICKAXES[pick.id].speed < PICKAXES["minecraft:stone_pickaxe"].speed && vCount(inv, (id) => id === COBBLE) >= 3) {
    brain.job = { craft: "minecraft:stone_pickaxe" };
    return setState(villager, brain, "craft");
  }
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
    if (shopForTool(villager, dim, brain, "pickaxe", "idle", now)) return; // doing well: a better pickaxe off the armorer
    if (!isNearHome(villager, ws)) {
      const spot = spotNextTo(dim, ws, villager);
      if (spot && navTo(villager, brain, spot, { radius: 0.9 })) return sleep(brain, 4);
    }
  }
  setMode(villager, brain, "rest");
  if (now - brain.since >= (brain.idleFor || CFG.IDLE_TIME)) return setState(villager, brain, "supply");
  sleep(brain, CFG.THINK_IDLE);
}
