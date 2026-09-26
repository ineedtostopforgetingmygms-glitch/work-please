// Market hours: every working villager picks a time of day (his own - they don't all pick the
// same one) to stop work, go stand by his job block with his shop row stocked up, and wait for
// players and other villagers to come and trade with him.
import { world } from "@minecraft/server";
import { CFG, SELL_SLOT_START } from "../config.js";
import { peekBrain, setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { holdItem } from "../actions.js";
import { navStop } from "../nav.js";
import { restockSellRow, stallStock } from "../trade.js";
import { sellRowCounts } from "../inventory.js";
import { center, getInventory, lookAt, particle, playSound } from "../util.js";
import { stockpileChests, walkTo } from "./common.js";

const DP_MARKET = "iv:market"; // {start, len} in ticks of the day (0 = sunrise, 6000 = noon)

/** His trading hours - chosen once, at random, the first time we ask. */
export function marketHours(villager) {
  try {
    const m = JSON.parse(villager.getDynamicProperty(DP_MARKET) ?? "null");
    if (m && typeof m.start === "number") return m;
  } catch {}
  const { EARLIEST, LATEST, LENGTH } = CFG.MARKET;
  const start = Math.round((EARLIEST + Math.random() * (LATEST - EARLIEST)) / 250) * 250;
  const m = { start, len: LENGTH };
  villager.setDynamicProperty(DP_MARKET, JSON.stringify(m));
  debugLog(villager, `picked his trading hours: ${clock(start)} - ${clock(start + LENGTH)}`);
  return m;
}

export function isMarketTime(villager) {
  const { start, len } = marketHours(villager);
  const t = world.getTimeOfDay();
  return t >= start && t < start + len;
}

/**
 * Shelves full? With half his shop row (or more) stocked he'd rather be selling than working, so
 * he opens up outside his trading hours too, in stints of MARKET.EXTRA_LENGTH.
 */
export function overstocked(villager) {
  const inv = getInventory(villager);
  let full = 0;
  for (let i = SELL_SLOT_START; i < inv.size; i++) if (inv.getItem(i)) full++;
  return full >= Math.ceil((inv.size - SELL_SLOT_START) / 2);
}

/** Is this villager standing at his stall right now? */
export function isAtMarket(villager) {
  const b = peekBrain(villager.id);
  return b?.state === "market" && !!b.marketOpen;
}

/**
 * Would he stop and do a deal right now? He's at his stall, it's his trading time anyway, or he's
 * between jobs. Outside that, another villager only interrupts him for something urgent.
 */
export function willingToTrade(villager) {
  const b = peekBrain(villager.id);
  return b?.state === "market" || b?.state === "idle" || isMarketTime(villager);
}

/** In-game clock time for a tick of the day (0 = 6:00). */
export function clock(t) {
  const mins = Math.floor((((t / 1000 + 6) % 24) * 60) % (24 * 60));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Does he have enough on the shelves to be worth opening? Standing at an empty stall all afternoon
 * is a waste of a day's work, so until he has CFG.MARKET.MIN_LOTS trades' worth (in the shop row,
 * his stockpile chests or his own pockets) he carries on working and checks again in a moment.
 */
function enoughToTrade(villager, dim, brain, ws, chestKind, now) {
  if (brain.stockCheck && now - brain.stockCheck.at < 40) return brain.stockCheck.ok;
  const lots = stallStock(villager, stockpileChests(dim, ws, chestKind).map((c) => c.container));
  const ok = lots >= CFG.MARKET.MIN_LOTS;
  brain.stockCheck = { at: now, ok };
  if (!ok && (brain.saidNoStock ?? 0) <= now) {
    brain.saidNoStock = now + 20 * 60;
    debugLog(villager, `it's his trading time but he's only got ${lots} trade(s) worth of stock - staying at work`);
  }
  return ok;
}

/**
 * Called by a job before running its current state: when it's his trading time, he has something
 * to sell and he's at a point where he can put down what he's doing, he heads to his stall.
 */
export function goToMarket(villager, dim, brain, now, ws, { interruptible, chestKind }) {
  if (brain.state === "market" || brain.action || !interruptible.includes(brain.state)) return false;
  const hours = isMarketTime(villager);
  if (!hours) {
    // his own hours are over, but the shelves are full - he'd do better selling than working
    if (!overstocked(villager) || now < (brain.nextExtraStall ?? 0)) return false;
    brain.stallUntil = now + CFG.MARKET.EXTRA_LENGTH;
  } else {
    brain.stallUntil = 0;
    if (!enoughToTrade(villager, dim, brain, ws, chestKind, now)) return false;
  }
  navStop(villager, brain);
  brain.job = null;
  brain.marketOpen = false;
  setState(villager, brain, "market");
  debugLog(villager, hours ? "trading time - heading to his stall" : "his shop row is full - knocking off early to sell some of it");
  return true;
}

/**
 * The market state: walk to the job block, stock the shop row from his chests, then stand there
 * facing whoever comes by until his hours are over, and go back to `backTo`.
 */
export function market(villager, dim, brain, now, ws, { chestKind, backTo }) {
  setWorking(villager, false);
  // his own hours, or an extra stint because his shop row was full (until it isn't any more)
  const hours = isMarketTime(villager);
  if (!hours && !(now < (brain.stallUntil ?? 0) && overstocked(villager))) {
    const wasExtra = (brain.stallUntil ?? 0) > 0;
    brain.marketOpen = false;
    brain.stallUntil = 0;
    if (wasExtra) brain.nextExtraStall = now + CFG.MARKET.EXTRA_REST;
    holdItem(villager, undefined);
    debugLog(villager, wasExtra ? "that's enough selling for now - back to work" : "trading time is over - back to work");
    return setState(villager, brain, backTo);
  }

  if (!brain.marketOpen) {
    const r = walkTo(villager, dim, brain, now, ws);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed") return sleep(brain, 20);
    brain.marketOpen = true;
    restockSellRow(villager, stockpileChests(dim, ws, chestKind).map((c) => c.container));
    const stock = [...sellRowCounts(getInventory(villager))].map(([id, n]) => `${n} ${id.replace("minecraft:", "")}`);
    debugLog(villager, `opened his stall: ${stock.length ? stock.join(", ") : "nothing to sell"}`);
    playSound(dim, "mob.villager.idle", villager.location);
  }

  // stand at the stall with an emerald in hand, looking at whoever is closest
  setMode(villager, brain, "work");
  holdItem(villager, "minecraft:emerald");
  const near = dim
    .getEntities({ location: villager.location, maxDistance: 8, families: ["player"] })
    .concat(dim.getEntities({ location: villager.location, maxDistance: 8, type: villager.typeId }).filter((e) => e.id !== villager.id))
    .sort((a, b) => distSq(a, villager) - distSq(b, villager))[0];
  if (near) lookAt(villager, { x: near.location.x, y: near.location.y + 1.5, z: near.location.z });
  else if (now % 200 < 10) lookAt(villager, { x: center(ws).x, y: ws.y + 1, z: center(ws).z });

  if (now >= (brain.nextStallRestock ?? 0)) {
    brain.nextStallRestock = now + 20 * 20;
    const chests = stockpileChests(dim, ws, chestKind).map((c) => c.container);
    restockSellRow(villager, chests);
    // sold out: no sense minding an empty stall for the rest of his hours
    if (stallStock(villager, chests) < 1) {
      brain.marketOpen = false;
      brain.stockCheck = null;
      holdItem(villager, undefined);
      debugLog(villager, "sold out - closing up and going back to work");
      return setState(villager, brain, backTo);
    }
  }
  if (Math.random() < 0.03) {
    particle(dim, "minecraft:villager_happy", { x: villager.location.x, y: villager.location.y + 2.2, z: villager.location.z });
  }
  sleep(brain, 10);
}

function distSq(a, b) {
  const dx = a.location.x - b.location.x;
  const dz = a.location.z - b.location.z;
  return dx * dx + dz * dz;
}
