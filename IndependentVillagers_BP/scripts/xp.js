// Experience. Villagers earn it the way a player does - digging ore out, smelting, trading,
// breeding and butchering animals - and save it up. Every XP.PER_BOTTLE points they bottle into a
// Bottle o' Enchanting, which they hang on to for the cleric.
//   TODO(cleric): the cleric isn't written yet. Once he is, he buys the bottles (see GOODS.xp_bottle).
import { ItemStack } from "@minecraft/server";
import { XP } from "./config.js";
import { debugLog } from "./debug.js";
import { vAdd } from "./inventory.js";
import { getInventory, particle, playSound } from "./util.js";

const DP_XP = "iv:xp";

export function xpOf(villager) {
  const v = villager.getDynamicProperty(DP_XP);
  return typeof v === "number" ? v : 0;
}

/** He earned `n` experience (fractions add up). */
export function addXp(villager, n) {
  if (!(n > 0)) return;
  try {
    villager.setDynamicProperty(DP_XP, xpOf(villager) + n);
  } catch {}
}

// vanilla's average experience for each ore
const ORE_XP = [
  [/coal_ore/, 1],
  [/nether_gold_ore/, 0.5],
  [/redstone_ore/, 3],
  [/lapis_ore/, 3.5],
  [/quartz_ore/, 3.5],
  [/diamond_ore|emerald_ore/, 5],
];

export function oreXp(blockId) {
  for (const [re, n] of ORE_XP) if (re.test(blockId)) return n;
  return 0;
}

/**
 * Bottles what he's saved up (called now and then from the main loop): XP.PER_BOTTLE points make
 * one Bottle o' Enchanting, a few at a time.
 */
export function bottleXp(villager) {
  const xp = xpOf(villager);
  const n = Math.min(XP.MAX_AT_ONCE, Math.floor(xp / XP.PER_BOTTLE));
  if (n < 1) return;
  const rest = vAdd(getInventory(villager), new ItemStack("minecraft:experience_bottle", n));
  const made = n - (rest?.amount ?? 0);
  if (made < 1) return; // pockets full
  villager.setDynamicProperty(DP_XP, xp - made * XP.PER_BOTTLE);
  const l = villager.location;
  playSound(villager.dimension, "random.orb", l, 0.8);
  playSound(villager.dimension, "bottle.fill", l);
  for (let i = 0; i < 4; i++) particle(villager.dimension, "minecraft:villager_happy", { x: l.x + (Math.random() - 0.5), y: l.y + 1.8, z: l.z + (Math.random() - 0.5) });
  debugLog(villager, `bottled ${made * XP.PER_BOTTLE} experience into ${made} bottle(s) o' enchanting (for the cleric)`);
}

