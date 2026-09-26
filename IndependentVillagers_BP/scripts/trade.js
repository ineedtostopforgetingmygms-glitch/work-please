// Trading with players through the normal villager trade screen.
//
// Vanilla trade screens read fixed JSON tables, so tools/gen-entity.ps1 generates one table per
// combination of up to 3 stocked items (trading/iv/*.json) and this file switches the villager to
// the table matching what's in his shop row (the bottom inventory row).
//
// Purchases aren't reported to scripts, so when a player opens the trade screen we watch their
// inventory: when they gain an item he sells, that many come out of his shop row and he gets the
// emeralds they paid.
import { ItemStack, system, world } from "@minecraft/server";
import { DP_TRADEKEY, PROP_PROFESSION } from "./config.js";
import { TRADES } from "./trades_data.js";
import { debugLog } from "./debug.js";
import { freeze, peekBrain } from "./brain.js";
import { cleanSellRow, moveToSellRow, sellRowCounts, takeFromSellRow, vAdd, vCount } from "./inventory.js";
import { getInventory, isValid } from "./util.js";

const byProfession = {};
for (const p of Object.values(TRADES.professions)) byProfession[p.profession] = p;

export function tradeInfo(profession) {
  return byProfession[profession];
}

export function isSellable(profession, typeId) {
  return !!byProfession[profession]?.sells.some((s) => s.item === typeId);
}

// ---------------------------------------------------------------- choosing the trade table

/** The biggest generated stock tier he can back with real goods (and is willing to part with). */
function bestTier(lots, cap) {
  let best = TRADES.tiers[0];
  for (const t of TRADES.tiers) if (t <= lots && t <= cap) best = t;
  return best;
}

/** Is he standing at his job block selling right now? (Then he'll sell the lot - see market.js) */
function atMarket(villager) {
  const b = peekBrain(villager.id);
  return b?.state === "market" && !!b.marketOpen;
}

const inTrade = new Map(); // villager id -> number of players currently trading
const pendingKey = new Map(); // villager id -> table being switched to (applied a couple of ticks later)
const DP_TRADESOLD = "iv:tradesold"; // something was bought since the table was last (re)stocked
const DP_TRADESTOCK = "iv:tradestock"; // shop row counts when the table was last (re)stocked

/**
 * Keeps the trade screen in step with his shop row. The offers are rebuilt from scratch (every
 * offer back to full uses, nothing left locked) whenever:
 *  - what he stocks changes (new item types, or one sold out),
 *  - he's sold something since the last rebuild (as soon as the buyer walks off), or
 *  - he's got more of something than when the offers were last built (restocked).
 */
export function updateTradeTable(villager) {
  if (inTrade.get(villager.id)) return; // never swap the table under someone's nose
  const info = byProfession[villager.getProperty(PROP_PROFESSION)];
  let key = "";
  const counts = sellRowCounts(getInventory(villager));
  if (info) {
    // How many trades' worth of each item he has in the shop row. The tiers are fine-grained
    // (1, 2, 3, 4, 6, 8...) so the offer really does match his stock instead of locking up while
    // he's still holding goods. Normally he'll only part with TRADES.normalTier lots at a time;
    // while he's minding his stall he'll sell his whole stock.
    const cap = atMarket(villager) ? Infinity : TRADES.normalTier;
    const lots = (e) => Math.floor(e.n / e.s.per);
    const stocked = info.sells
      .map((s, i) => ({ i, s, n: counts.get(s.item) ?? 0 }))
      .filter((e) => lots(e) >= 1)
      .sort((a, b) => lots(b) - lots(a));
    if (stocked.length) {
      const tier = bestTier(lots(stocked[0]), cap);
      const listed = stocked
        .filter((e) => lots(e) >= tier)
        .slice(0, TRADES.maxOffers)
        .map((e) => e.i)
        .sort((a, b) => a - b);
      key = `${info.code}_${listed.join("_")}_t${tier}`;
    }
  }
  const current = villager.getDynamicProperty(DP_TRADEKEY) ?? "";
  const sold = villager.getDynamicProperty(DP_TRADESOLD) === true;
  let restocked = false;
  try {
    const before = JSON.parse(villager.getDynamicProperty(DP_TRADESTOCK) ?? "{}");
    for (const [item, n] of counts) if (n > (before[item] ?? 0)) restocked = true;
  } catch {}
  if (current === key && !(key && (sold || restocked))) {
    if (!key && sold) villager.setDynamicProperty(DP_TRADESOLD, undefined);
    if (!key) villager.setDynamicProperty(DP_TRADESTOCK, JSON.stringify(Object.fromEntries(counts)));
    return;
  }
  villager.setDynamicProperty(DP_TRADEKEY, key || undefined);
  villager.setDynamicProperty(DP_TRADESOLD, undefined);
  villager.setDynamicProperty(DP_TRADESTOCK, JSON.stringify(Object.fromEntries(counts)));
  debugLog(villager, key ? (current === key ? `trades restocked: ${key}` : `now selling: ${key}`) : "nothing to sell");

  // Take the old table away, then give the new one a couple of ticks later - so the game really
  // builds fresh offers instead of keeping the used-up ones - and resupply them like a vanilla
  // villager does after working at his job block.
  try {
    villager.triggerEvent("iv:trade_clear");
  } catch {}
  pendingKey.set(villager.id, key);
  system.runTimeout(() => {
    const k = pendingKey.get(villager.id);
    pendingKey.delete(villager.id);
    if (!k || !isValid(villager)) return;
    if (inTrade.get(villager.id)) {
      villager.setDynamicProperty(DP_TRADEKEY, undefined); // try again once they're done
      return;
    }
    try {
      villager.triggerEvent(`iv:trade_${k}`);
      villager.triggerEvent("iv:resupply");
    } catch {}
    system.runTimeout(() => {
      try {
        if (isValid(villager)) villager.triggerEvent("iv:resupply_done");
      } catch {}
    }, 2);
  }, 2);
}

const KEEP_ON_HAND = 8; // of a sellable item he keeps this many to work with, out of the shop row

/**
 * Fills the shop row with everything he can sell: the item types he has most trades' worth of
 * (up to 3), taken from `chests` first and then from what he can spare in his own slots.
 */
export function restockSellRow(villager, chests = []) {
  const prof = villager.getProperty(PROP_PROFESSION);
  const info = byProfession[prof];
  const inv = getInventory(villager);
  if (!info) return;
  cleanSellRow(inv, (id) => isSellable(prof, id));

  const available = (item) =>
    (sellRowCounts(inv).get(item) ?? 0) + vCount(inv, (id) => id === item) + chests.reduce((n, c) => n + countIn(c, item), 0);
  const picks = info.sells
    .map((s) => ({ s, n: available(s.item) }))
    .filter((e) => e.n >= e.s.per)
    .sort((a, b) => b.n / b.s.per - a.n / a.s.per)
    .slice(0, TRADES.maxOffers);

  const topTier = TRADES.tiers[TRADES.tiers.length - 1];
  for (const { s } of picks) {
    const target = s.per * topTier; // as much as the biggest offer could ever sell
    let need = target - (sellRowCounts(inv).get(s.item) ?? 0);
    if (need <= 0) continue;
    // from his chests first - what he carries is what he works with (bridging blocks, pillar logs)
    for (const c of chests) {
      if (need <= 0) break;
      need -= moveToSellRow(inv, c, s.item, need);
    }
    // ...and out of his own pockets only what he can spare
    const spare = vCount(inv, (id) => id === s.item) - KEEP_ON_HAND;
    if (need > 0 && spare > 0) moveToSellRow(inv, inv, s.item, Math.min(need, spare), 0, 18);
  }
  updateTradeTable(villager);
}

/**
 * How many trades' worth of goods he could actually put on the stall right now: what's already in
 * the shop row, what's in his stockpile chests, and whatever he can spare out of his own pockets.
 * (Used to decide whether opening for his trading hours is worth it at all.)
 */
export function stallStock(villager, chests = []) {
  const info = byProfession[villager.getProperty(PROP_PROFESSION)];
  if (!info) return 0;
  const inv = getInventory(villager);
  const row = sellRowCounts(inv);
  let lots = 0;
  for (const s of info.sells) {
    const n =
      (row.get(s.item) ?? 0) +
      Math.max(0, vCount(inv, (id) => id === s.item) - KEEP_ON_HAND) +
      chests.reduce((t, c) => t + countIn(c, s.item), 0);
    lots += Math.floor(n / s.per);
  }
  return lots;
}

function countIn(container, item) {
  let n = 0;
  for (let i = 0; i < container.size; i++) {
    const it = container.getItem(i);
    if (it?.typeId === item) n += it.amount;
  }
  return n;
}

// ---------------------------------------------------------------- purchase bookkeeping

const sessions = new Map(); // player id -> {player, villager, info, before: Map, started}

export function startTradeSession(player, villager) {
  const info = byProfession[villager.getProperty(PROP_PROFESSION)];
  if (!info || !villager.getDynamicProperty(DP_TRADEKEY)) return;
  const old = sessions.get(player.id);
  if (old) endSession(player.id);
  const from = { x: player.location.x, z: player.location.z };
  sessions.set(player.id, { player, villager, info, before: playerCounts(player, info), started: system.currentTick, from });
  inTrade.set(villager.id, (inTrade.get(villager.id) ?? 0) + 1);
}

function playerCounts(player, info) {
  const m = new Map();
  const inv = getInventory(player);
  for (const s of info.sells) m.set(s.item, 0);
  for (let i = 0; i < inv.size; i++) {
    const it = inv.getItem(i);
    if (it && m.has(it.typeId)) m.set(it.typeId, m.get(it.typeId) + it.amount);
  }
  return m;
}

function endSession(playerId) {
  const s = sessions.get(playerId);
  sessions.delete(playerId);
  if (!s) return;
  const n = (inTrade.get(s.villager.id) ?? 1) - 1;
  if (n > 0) inTrade.set(s.villager.id, n);
  else inTrade.delete(s.villager.id);
  if (isValid(s.villager)) updateTradeTable(s.villager);
}

system.runInterval(() => {
  for (const [id, s] of sessions) {
    const { player, villager, info } = s;
    if (!isValid(player) || !isValid(villager)) {
      endSession(id);
      continue;
    }
    freeze(villager, 15); // he stands still while someone is trading with him
    const now = playerCounts(player, info);
    for (const sell of info.sells) {
      const gained = now.get(sell.item) - s.before.get(sell.item);
      const trades = Math.floor(gained / sell.per);
      if (trades <= 0) continue;
      // he hands over the goods from his shop row and keeps what the player paid
      const inv = getInventory(villager);
      takeFromSellRow(inv, sell.item, trades * sell.per);
      const rest = vAdd(inv, new ItemStack("minecraft:emerald", trades * sell.price));
      if (rest) villager.dimension.spawnItem(rest, villager.location);
      s.before.set(sell.item, s.before.get(sell.item) + trades * sell.per);
      villager.setDynamicProperty(DP_TRADESOLD, true);
      debugLog(villager, `sold ${trades * sell.per} ${sell.item.replace("minecraft:", "")} for ${trades * sell.price} emerald(s)`);
    }
    for (const [item, n] of now) if (n < s.before.get(item)) s.before.set(item, n); // they used/dropped some
    // The trade screen holds the player still, so once they've moved they've closed it.
    const far = Math.hypot(player.location.x - villager.location.x, player.location.z - villager.location.z) > 8;
    const moved = Math.hypot(player.location.x - s.from.x, player.location.z - s.from.z) > 1.5;
    if (far || moved || system.currentTick - s.started > 20 * 180) endSession(id);
  }
}, 10);

world.afterEvents.playerLeave?.subscribe((ev) => endSession(ev.playerId));
