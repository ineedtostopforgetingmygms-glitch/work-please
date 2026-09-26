// Money between villagers: everyone starts with emeralds, and villagers pay each other for goods.
import { ItemStack } from "@minecraft/server";
import { AXES, CFG, LOGS, PICKAXES } from "./config.js";
import { debugLog } from "./debug.js";
import { GEN_END, vAdd, vCount, vTake } from "./inventory.js";
import { getInventory, lookAt, particle, playSound } from "./util.js";
import { TRADES } from "./trades_data.js";
import { updateTradeTable } from "./trade.js";

const DP_INIT = "iv:init";
const EMERALD = "minecraft:emerald";

/** First time we see a villager: hand them their starting emeralds. */
export function initVillager(villager) {
  if (villager.getDynamicProperty(DP_INIT)) return;
  villager.setDynamicProperty(DP_INIT, true);
  let left = CFG.STARTING_EMERALDS;
  const inv = getInventory(villager);
  while (left > 0) {
    const n = Math.min(64, left);
    const rest = vAdd(inv, new ItemStack(EMERALD, n));
    left -= n;
    if (rest) break;
  }
}

export function emeralds(villager) {
  return vCount(getInventory(villager), (id) => id === EMERALD);
}

// ---------------------------------------------------------------- goods

/**
 * Things villagers buy from each other. `match` says which items count (any wood type for logs).
 * `keep` is how many the seller holds back for his own work.
 */
export const GOODS = {
  logs: { label: "logs", match: (id) => LOGS.has(id), keep: 0 },
  coal: { label: "coal", match: (id) => id === "minecraft:coal" || id === "minecraft:charcoal", keep: 0 },
  cobblestone: { label: "cobblestone", match: (id) => id === "minecraft:cobblestone", keep: 16 },
  iron: { label: "iron", match: (id) => id === "minecraft:raw_iron" || id === "minecraft:iron_ingot", keep: 0 },
  seeds: { label: "seeds", match: (id) => id === "minecraft:wheat_seeds" || id === "minecraft:beetroot_seeds", keep: 8 },
};

const NEVER_SOLD = (id) => id === EMERALD || !!AXES[id] || !!PICKAXES[id];

/** What a villager pays another for `count` of a good: the deal price for wood, else the shop price. */
export function priceFor(good, count) {
  if (good === "logs") return Math.ceil((count * CFG.WOOD_DEAL.price) / CFG.WOOD_DEAL.logs);
  for (const p of Object.values(TRADES.professions)) {
    const s = p.sells.find((s) => GOODS[good]?.match(s.item));
    if (s) return Math.max(1, Math.ceil((count / s.per) * s.price));
  }
  return Math.max(1, Math.ceil(count / 4));
}

function countSlots(inv, from, to, pred) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const it = inv.getItem(i);
    if (it && pred(it.typeId)) n += it.amount;
  }
  return n;
}

/** How many of a good he has to spare: his shop row plus what he carries, minus what he keeps. */
export function spareOf(villager, good) {
  const g = GOODS[good];
  const inv = getInventory(villager);
  const pred = (id) => g.match(id) && !NEVER_SOLD(id);
  return Math.max(0, countSlots(inv, 0, inv.size, pred) - g.keep);
}

/** How many of a good he has on him (shop row included). */
export function haveOf(villager, good) {
  const inv = getInventory(villager);
  return countSlots(inv, 0, inv.size, GOODS[good].match);
}

/** Takes up to `amount` of a good: shop row first (that's what he's selling), then his own pile. */
export function takeGood(inv, good, amount, sellRowFirst = true) {
  const pred = GOODS[good]?.match ?? ((id) => id === good);
  const taken = [];
  const fromRow = () => {
    for (let i = GEN_END; i < inv.size && taken.length < amount; i++) {
      const it = inv.getItem(i);
      if (!it || !pred(it.typeId)) continue;
      const n = Math.min(it.amount, amount - taken.length);
      for (let j = 0; j < n; j++) taken.push(it.typeId);
      if (n === it.amount) inv.setItem(i);
      else {
        it.amount -= n;
        inv.setItem(i, it);
      }
    }
  };
  if (sellRowFirst) fromRow();
  if (taken.length < amount) taken.push(...vTake(inv, pred, amount - taken.length));
  if (!sellRowFirst && taken.length < amount) fromRow();
  return taken;
}

export function canSellLogs(seller, amount) {
  return spareOf(seller, "logs") >= amount;
}

/**
 * Buyer pays the seller for `count` of a good, hand to hand.
 * Returns false (and nothing changes) if either side can't do the deal.
 */
export function buyGood(buyer, seller, good, count, price = priceFor(good, count)) {
  const bInv = getInventory(buyer);
  const sInv = getInventory(seller);
  if (vCount(bInv, (id) => id === EMERALD) < price || spareOf(seller, good) < count) return false;

  vTake(bInv, (id) => id === EMERALD, price);
  const paidRest = vAdd(sInv, new ItemStack(EMERALD, price));
  if (paidRest) seller.dimension.spawnItem(paidRest, seller.location);

  const counts = new Map();
  for (const id of takeGood(sInv, good, count)) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    const rest = vAdd(bInv, new ItemStack(id, n));
    if (rest) buyer.dimension.spawnItem(rest, buyer.location);
  }

  // make it look like a deal
  lookAt(buyer, { x: seller.location.x, y: seller.location.y + 1.5, z: seller.location.z });
  lookAt(seller, { x: buyer.location.x, y: buyer.location.y + 1.5, z: buyer.location.z });
  playSound(seller.dimension, "mob.villager.yes", seller.location);
  for (let i = 0; i < 4; i++) particle(seller.dimension, "minecraft:villager_happy", { x: seller.location.x, y: seller.location.y + 2.1, z: seller.location.z });
  debugLog(buyer, `bought ${count} ${GOODS[good]?.label ?? good} from #${String(seller.id).slice(-4)} for ${price} emeralds`);
  updateTradeTable(seller);
  return true;
}

export function buyLogs(buyer, seller, logs = CFG.WOOD_DEAL.logs, price = CFG.WOOD_DEAL.price) {
  return buyGood(buyer, seller, "logs", logs, price);
}
