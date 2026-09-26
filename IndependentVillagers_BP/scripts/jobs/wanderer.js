// Buying off a wandering trader. He isn't one of ours - no inventory we can see, no brain - so the
// villager does what a player does: walks up to him, stands face to face for a moment and pays the
// going (vanilla) price for what he's after.
//
//   brain.job.trader = { item, count, price, then }
import { ItemStack } from "@minecraft/server";
import { CARTO, CFG } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { emeralds } from "../economy.js";
import { vAdd, vTake } from "../inventory.js";
import { center, findStandableNear, floorPos, getInventory, horizDist, isValid, lookAt, particle, playSound } from "../util.js";

export const WANDERING_TRADER = "minecraft:wandering_trader";
const DEAL_TICKS = 60;

/** The nearest wandering trader within `radius` of `from`, if one is about. */
export function nearestTrader(dim, from, radius = CARTO.TRADER_RADIUS) {
  try {
    return dim.getEntities({ type: WANDERING_TRADER, location: from, maxDistance: radius, closest: 1 })[0];
  } catch {
    return undefined;
  }
}

/**
 * Off to buy `count` of `item` from a wandering trader, then back to state `then`.
 * False if there's no trader about, he can't afford it, or he tried a moment ago.
 */
export function goToTrader(villager, dim, brain, now, { item, count, price, then }) {
  if ((brain.noTraderUntil ?? 0) > now) return false;
  const total = price * count;
  if (emeralds(villager) < total) return false;
  const trader = nearestTrader(dim, villager.location);
  if (!trader) return false;
  navStop(villager, brain);
  brain.job = { trader: { item, count, total, then, id: trader.id } };
  setState(villager, brain, "trader");
  debugLog(villager, `off to buy ${count} ${item.replace("minecraft:", "")} from the wandering trader`);
  return true;
}

function giveUp(villager, brain, now, why) {
  const t = brain.job?.trader;
  debugLog(villager, `couldn't buy from the wandering trader: ${why}`);
  brain.noTraderUntil = now + CFG.BUY_RETRY;
  brain.job = null;
  navStop(villager, brain);
  setState(villager, brain, t?.then ?? "idle");
}

export function traderState(villager, dim, brain, now) {
  setWorking(villager, false);
  const t = brain.job?.trader;
  if (!t) return setState(villager, brain, "idle");
  let trader;
  try {
    trader = dim.getEntities({ type: WANDERING_TRADER, location: villager.location, maxDistance: CARTO.TRADER_RADIUS + 16 }).find((e) => e.id === t.id);
  } catch {}
  if (!trader || !isValid(trader)) return giveUp(villager, brain, now, "he's gone");
  if (emeralds(villager) < t.total) return giveUp(villager, brain, now, "not enough emeralds");

  const head = { x: trader.location.x, y: trader.location.y + 1.5, z: trader.location.z };
  if (t.deal) {
    lookAt(villager, head);
    try {
      trader.teleport(trader.location, { facingLocation: { x: villager.location.x, y: villager.location.y + 1.5, z: villager.location.z } });
    } catch {}
    if (now % 6 === 0) particle(dim, "minecraft:villager_happy", { x: head.x, y: head.y + 0.8, z: head.z });
    if (now < t.deal) return sleep(brain, 2);
    vTake(getInventory(villager), (id) => id === "minecraft:emerald", t.total);
    const rest = vAdd(getInventory(villager), new ItemStack(t.item, t.count));
    if (rest) dim.spawnItem(rest, villager.location);
    playSound(dim, "mob.wanderingtrader.yes", trader.location);
    debugLog(villager, `bought ${t.count} ${t.item.replace("minecraft:", "")} from the wandering trader for ${t.total} emerald(s)`);
    brain.job = null;
    return setState(villager, brain, t.then);
  }

  if (horizDist(villager.location, trader.location) <= 2.5 && Math.abs(villager.location.y - trader.location.y) < 2) {
    navStop(villager, brain);
    setMode(villager, brain, "work");
    t.deal = now + DEAL_TICKS;
    try {
      // he stands still for the deal, like a villager being traded with
      trader.addEffect("slowness", DEAL_TICKS + 10, { amplifier: 255, showParticles: false });
    } catch {}
    playSound(dim, "mob.wanderingtrader.haggle", trader.location);
    return sleep(brain, 2);
  }

  // he wanders about - keep heading to wherever he is now
  const target = floorPos(trader.location);
  if (brain.nav && horizDist(center(brain.nav.goal), trader.location) > 3) navStop(villager, brain);
  if (!brain.nav) {
    const spot = findStandableNear(dim, target, 2, 3);
    if (!spot || !navTo(villager, brain, spot, { radius: 1.5 })) {
      brain.tries++;
      if (brain.tries > 5) return giveUp(villager, brain, now, "can't get to him");
      return sleep(brain, 20);
    }
  }
  const r = navUpdate(villager, brain, now);
  if (r === "failed") brain.tries++;
  if (brain.tries > 8 || now - brain.since > 20 * 120) return giveUp(villager, brain, now, "can't get to him");
  sleep(brain, 4);
}
