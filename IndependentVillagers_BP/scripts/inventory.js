// A villager's inventory: slots 0-17 are his normal inventory, slots 18-26 (the bottom row) are
// his shop stock - only items for sale go there, and only those can be bought from him.
import { SELL_SLOT_START } from "./config.js";
import { addToSlots, countItems, getInventory, takeItems } from "./util.js";

export const GEN_END = SELL_SLOT_START;

/** Count in the normal slots (not the shop row). */
export function vCount(inv, predicate) {
  return countItems(inv, predicate, 0, GEN_END);
}

/** Take from the normal slots (not the shop row). */
export function vTake(inv, predicate, amount) {
  return takeItems(inv, predicate, amount, 0, GEN_END);
}

/** Add to the normal slots. Returns the leftover stack (if full). */
export function vAdd(inv, stack) {
  return addToSlots(inv, stack, 0, GEN_END);
}

/** Add to the normal slots, dropping what doesn't fit at his feet. */
export function vGive(villager, stack) {
  const rest = vAdd(getInventory(villager), stack);
  if (rest) villager.dimension.spawnItem(rest, villager.location);
}

export function vFreeSlots(inv) {
  let n = 0;
  for (let i = 0; i < GEN_END; i++) if (!inv.getItem(i)) n++;
  return n;
}

/** item -> amount in the shop row */
export function sellRowCounts(inv) {
  const m = new Map();
  for (let i = GEN_END; i < inv.size; i++) {
    const it = inv.getItem(i);
    if (it) m.set(it.typeId, (m.get(it.typeId) ?? 0) + it.amount);
  }
  return m;
}

/** Removes up to `amount` of `typeId` from the shop row; returns how many were removed. */
export function takeFromSellRow(inv, typeId, amount) {
  return takeItems(inv, (id) => id === typeId, amount, GEN_END, inv.size).length;
}

/**
 * Moves every item in the normal slots matching `predicate` into `container`.
 * Returns true if nothing matching is left behind.
 */
export function storeInto(inv, container, predicate) {
  let left = false;
  for (let i = 0; i < GEN_END; i++) {
    const item = inv.getItem(i);
    if (!item || !predicate(item.typeId)) continue;
    const rest = container.addItem(item);
    inv.setItem(i, rest);
    if (rest) left = true;
  }
  return !left;
}

/** Moves up to `amount` of `typeId` from any container slots [from,to) into the shop row. */
export function moveToSellRow(inv, source, typeId, amount, from = 0, to = source.size) {
  let moved = 0;
  for (let i = from; i < Math.min(to, source.size) && moved < amount; i++) {
    const it = source.getItem(i);
    if (!it || it.typeId !== typeId) continue;
    const want = Math.min(it.amount, amount - moved);
    const part = it.clone();
    part.amount = want;
    const rest = addToSlots(inv, part, GEN_END, inv.size);
    const placed = want - (rest?.amount ?? 0);
    if (placed <= 0) break; // shop row full
    if (placed === it.amount) source.setItem(i);
    else {
      it.amount -= placed;
      source.setItem(i, it);
    }
    moved += placed;
  }
  return moved;
}

/** Anything in the shop row that isn't `sellable` goes back to the normal slots. */
export function cleanSellRow(inv, sellable) {
  for (let i = GEN_END; i < inv.size; i++) {
    const it = inv.getItem(i);
    if (!it || sellable(it.typeId)) continue;
    const rest = vAdd(inv, it);
    inv.setItem(i, rest);
  }
}
