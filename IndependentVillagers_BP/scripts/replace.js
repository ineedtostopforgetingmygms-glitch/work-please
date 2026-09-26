// Swaps vanilla villagers for independent villagers, keeping their biome skin, name and items.
// Babies are left alone until they grow up (the periodic sweep picks them up then).
import { PROP_BIOME, VANILLA_VILLAGERS, VILLAGER_ID } from "./config.js";
import { getInventory, isValid } from "./util.js";
import { vAdd } from "./inventory.js";

export function replaceVanillaVillager(old) {
  if (!isValid(old) || !VANILLA_VILLAGERS.includes(old.typeId)) return;
  if (old.getComponent("minecraft:is_baby")) return;

  const dim = old.dimension;
  const location = old.location;
  const rotation = old.getRotation();
  const nameTag = old.nameTag;
  const biome = old.getComponent("minecraft:mark_variant")?.value ?? 0;

  const items = [];
  try {
    const oldInv = getInventory(old);
    for (let i = 0; oldInv && i < oldInv.size; i++) {
      const item = oldInv.getItem(i);
      if (item) items.push(item);
    }
  } catch {}

  old.remove();

  const villager = dim.spawnEntity(VILLAGER_ID, location);
  villager.setProperty(PROP_BIOME, Math.min(6, Math.max(0, biome)));
  villager.setRotation(rotation);
  if (nameTag) villager.nameTag = nameTag;

  const inv = getInventory(villager);
  for (const item of items) {
    const leftover = vAdd(inv, item);
    if (leftover) dim.spawnItem(leftover, location);
  }
}

export function sweepVanillaVillagers(dim) {
  for (const type of VANILLA_VILLAGERS) {
    let list;
    try {
      list = dim.getEntities({ type });
    } catch {
      continue;
    }
    for (const old of list) {
      try {
        replaceVanillaVillager(old);
      } catch (e) {
        console.warn(`[Independent Villagers] couldn't replace villager: ${e}`);
      }
    }
  }
}
