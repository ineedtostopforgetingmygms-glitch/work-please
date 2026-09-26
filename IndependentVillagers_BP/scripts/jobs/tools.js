// Better tools from the armorer. A villager makes his own wooden and stone tools, but once he's
// doing well for himself - he can pay for an iron one and still have TOOLS.RICH emeralds left - he
// goes and buys one off the armorer (a diamond one if he's really rich and the armorer has one).
import { AXES, HOES, PICKAXES, PROP_PROFESSION, Profession, TOOLS, VILLAGER_ID } from "../config.js";
import { debugLog } from "../debug.js";
import { getTool } from "../actions.js";
import { emeralds, priceFor, spareOf } from "../economy.js";
import { goShopping } from "./shopping.js";

const TABLES = { axe: AXES, pickaxe: PICKAXES, hoe: HOES };

/** An armorer within walking distance with one of these to sell. */
function armorerSelling(villager, dim, good) {
  try {
    return dim
      .getEntities({ type: VILLAGER_ID, location: villager.location, maxDistance: 96 })
      .some((e) => e.getProperty(PROP_PROFESSION) === Profession.ARMORER && spareOf(e, good) >= 1);
  } catch {
    return false;
  }
}

/**
 * If he can afford a better `kind` of tool (axe/pickaxe/hoe) and the armorer has one, he goes to
 * buy it and comes back to state `then`. True if he's off shopping.
 */
export function shopForTool(villager, dim, brain, kind, then, now) {
  if ((brain.toolCheck ?? 0) > now) return false;
  brain.toolCheck = now + TOOLS.RETRY;
  const table = TABLES[kind];
  const cur = getTool(villager, kind);
  const curSpeed = cur ? table[cur.id]?.speed ?? 0 : 0;
  if (cur?.id.startsWith("minecraft:golden_")) return false; // fast enough, whatever it lasts
  const cash = emeralds(villager);
  for (const [tier, rich] of [
    ["diamond", TOOLS.RICH_DIAMOND],
    ["iron", TOOLS.RICH],
  ]) {
    const id = `minecraft:${tier}_${kind}`;
    const good = `${tier}_${kind}`;
    if (!table[id] || table[id].speed <= curSpeed) continue;
    const price = priceFor(good, 1);
    if (cash < price + rich) continue; // he could pay, but he's not that well off
    if (!armorerSelling(villager, dim, good)) continue;
    debugLog(villager, `doing well (${cash} emeralds) - off to buy a ${tier} ${kind} from the armorer`);
    return goShopping(villager, brain, good, 1, then, now);
  }
  return false;
}
