// Buying from other villagers: a villager who's missing something walks up to another villager who
// has some to spare - preferring one who's standing at his stall for his trading hours - and they
// do the deal face to face (a few seconds, green sparkles), emeralds for goods.
//
//   brain.job.want = { good, count, price?, then }   (goods are listed in economy.js)
import { system } from "@minecraft/server";
import { CFG, VILLAGER_ID } from "../config.js";
import { freeze, setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { buyGood, emeralds, GOODS, priceFor, spareOf } from "../economy.js";
import { center, dist, findStandableNear, floorPos, horizDist, particle, playSound, samePos } from "../util.js";
import { isAtMarket, willingToTrade } from "./market.js";

const DEAL_TICKS = 60; // 3 seconds

/**
 * Start shopping for `count` of `good`, then carry on with state `then`. False if it's no use trying.
 *
 * `urgent` means he can't do his job at all without it (no tool, no field): then he'll knock on any
 * villager's door, trading hours or not. Everything else is shopping he can do when the seller is
 * actually open for business, so he waits for someone to be at his stall (or at least free).
 */
export function goShopping(villager, brain, good, count, then, now, urgent = false) {
  if ((brain.cantBuy?.[good] ?? 0) > now) return false;
  brain.job = { want: { good, count, price: priceFor(good, count), then, urgent } };
  setState(villager, brain, "shop");
  return true;
}

/**
 * Couldn't buy it: remember for a while, so he gets on with something else meanwhile.
 * `noSeller` means there was nobody to buy from at all - that's what makes a villager give up on the
 * market in the end and go and get the stuff himself (see jobs/wood.js).
 */
function giveUp(villager, brain, why, soon = false, noSeller = false) {
  const want = brain.job.want;
  (brain.cantBuy ??= {})[want.good] = system.currentTick + (soon || want.urgent ? CFG.BUY_RETRY_SOON : CFG.BUY_RETRY);
  if (noSeller) brain.noSellerSince ??= system.currentTick;
  debugLog(villager, `can't buy ${want.good}: ${why}`);
  brain.job = null;
  navStop(villager, brain);
  setState(villager, brain, want.then);
}

export function shop(villager, dim, brain, now) {
  setWorking(villager, false);
  const want = brain.job?.want;
  if (!want) return setState(villager, brain, "idle");
  const label = GOODS[want.good]?.label ?? want.good;
  if (emeralds(villager) < want.price) return giveUp(villager, brain, `not enough emeralds (need ${want.price})`);

  // who sells it? someone at his stall first, then the nearest villager with enough to spare
  let seller = want.seller && villagerById(dim, want.seller);
  if (!seller || spareOf(seller, want.good) < want.count) {
    let sellers = dim
      .getEntities({ type: VILLAGER_ID, location: villager.location, maxDistance: 96 })
      .filter((e) => e.id !== villager.id && spareOf(e, want.good) >= want.count)
      .map((e) => ({ e, score: dist(e.location, villager.location) + (isAtMarket(e) ? 0 : 1000) }))
      .sort((a, b) => a.score - b.score);
    if (!sellers.length) return giveUp(villager, brain, `nobody nearby has ${want.count} ${label} to sell`, false, true);
    if (!want.urgent) {
      // not urgent: he won't drag a villager off his job for it - he buys from someone who's
      // trading (or at a loose end) and otherwise comes back another time
      const open = sellers.filter((s) => willingToTrade(s.e));
      if (!open.length) return giveUp(villager, brain, `nobody's trading ${label} right now - it can wait`, true);
      sellers = open;
    }
    seller = sellers[0].e;
    want.seller = seller.id;
    want.deal = undefined;
    navStop(villager, brain);
    const how = isAtMarket(seller) ? " at his stall" : want.urgent ? " (urgent - can't work without it)" : "";
    debugLog(villager, `going to buy ${want.count} ${label} from #${String(seller.id).slice(-4)}${how}`);
  }

  // a deal in progress: both stand face to face for a few seconds while they haggle
  if (want.deal) {
    if (now < want.deal.until) {
      dealEffects(villager, seller, now, want.deal);
      return sleep(brain, 2);
    }
    if (!buyGood(villager, seller, want.good, want.count, want.price)) return giveUp(villager, brain, "the deal fell through");
    brain.job = null;
    brain.noSellerSince = null; // the market works after all
    return setState(villager, brain, want.then);
  }

  if (horizDist(villager.location, seller.location) <= 2.5 && Math.abs(villager.location.y - seller.location.y) < 2) {
    navStop(villager, brain);
    setMode(villager, brain, "work");
    want.deal = { until: now + DEAL_TICKS, next: now };
    freeze(seller, DEAL_TICKS + 10); // the seller stops what he's doing for the deal
    playSound(dim, "mob.villager.haggle", seller.location);
    debugLog(villager, `haggling with #${String(seller.id).slice(-4)} over ${want.count} ${label} for ${want.price} emeralds`);
    return sleep(brain, 2);
  }

  // he might be on the move - keep heading to where he is now
  const target = floorPos(seller.location);
  if (brain.nav && horizDist(center(brain.nav.goal), seller.location) > 3) navStop(villager, brain);
  if (!brain.nav) {
    const spot = findStandableNear(dim, target, 1, 2, (q) => samePos(q, target)) ?? findStandableNear(dim, target, 2, 3);
    if (!spot || !navTo(villager, brain, spot, { radius: 1.5 })) {
      brain.tries++;
      if (brain.tries > 5) return giveUp(villager, brain, "can't get to the seller", false, true);
      return sleep(brain, 20);
    }
  }
  const r = navUpdate(villager, brain, now);
  if (r === "failed") brain.tries++;
  if (brain.tries > 8) return giveUp(villager, brain, "can't get to the seller", false, true);
  sleep(brain, 4);
}

/** Face each other, green sparkles over both heads, the odd villager noise. */
function dealEffects(buyer, seller, now, deal) {
  const bHead = { x: buyer.location.x, y: buyer.location.y + 1.5, z: buyer.location.z };
  const sHead = { x: seller.location.x, y: seller.location.y + 1.5, z: seller.location.z };
  try {
    buyer.teleport(buyer.location, { facingLocation: sHead });
    seller.teleport(seller.location, { facingLocation: bHead });
  } catch {}
  if (now < deal.next) return;
  deal.next = now + 6;
  for (const h of [bHead, sHead]) {
    for (let i = 0; i < 3; i++) {
      particle(buyer.dimension, "minecraft:villager_happy", {
        x: h.x + (Math.random() - 0.5) * 0.8,
        y: h.y + 0.6 + Math.random() * 0.5,
        z: h.z + (Math.random() - 0.5) * 0.8,
      });
    }
  }
  if (Math.random() < 0.3) playSound(buyer.dimension, Math.random() < 0.5 ? "mob.villager.haggle" : "mob.villager.idle", Math.random() < 0.5 ? buyer.location : seller.location);
}

function villagerById(dim, id) {
  try {
    return dim.getEntities({ type: VILLAGER_ID }).find((v) => v.id === id);
  } catch {
    return undefined;
  }
}
