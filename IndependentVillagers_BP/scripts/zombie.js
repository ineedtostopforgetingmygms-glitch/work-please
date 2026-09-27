// Killed by a zombie, a villager gets up again as a zombie villager - and the zombie keeps
// everything he had on him: his tools, his stock, his emeralds. Kill it and it drops the lot; cure
// it and he's back, with his things (and his name) in his pockets again.
import { ItemStack, system, world } from "@minecraft/server";
import { CFG, PROP_BIOME } from "./config.js";
import { debugLog } from "./debug.js";
import { vAdd } from "./inventory.js";
import { getInventory } from "./util.js";

const DP_HELD = "iv:held"; // on the zombie villager: {items: [{id, n, d}], name, biome, xp}
const ZOMBIE_VILLAGERS = ["minecraft:zombie_villager_v2", "minecraft:zombie_villager"];

// anything that gets up again and shambles about
export const ZOMBIES = new Set([
  "minecraft:zombie",
  "minecraft:husk",
  "minecraft:drowned",
  "minecraft:zombie_villager",
  "minecraft:zombie_villager_v2",
  "minecraft:zombified_piglin",
  "minecraft:zoglin",
]);

const held = new Map(); // zombie id -> held (the dynamic property can be gone by the time it dies)
const cures = []; // [{d, loc, held, at}] zombie villagers that just vanished - maybe cured

function pack(stack) {
  const out = { id: stack.typeId, n: stack.amount };
  try {
    const d = stack.getComponent("minecraft:durability");
    if (d?.damage) out.d = d.damage;
  } catch {}
  return out;
}

function unpack(e) {
  const s = new ItemStack(e.id, e.n);
  if (e.d) {
    try {
      const d = s.getComponent("minecraft:durability");
      if (d) d.damage = Math.min(e.d, d.maxDurability - 1);
    } catch {}
  }
  return s;
}

/** A villager died: if a zombie did it, he rises again - carrying everything he dropped. */
export function zombify(ev) {
  const dead = ev.deadEntity;
  const killer = ev.damageSource?.damagingEntity;
  if (!CFG.ZOMBIFY || !killer || !ZOMBIES.has(killer.typeId)) return;
  const dim = dead.dimension;
  const loc = { ...dead.location };
  const info = {};
  try {
    info.name = dead.nameTag;
    info.biome = dead.getProperty(PROP_BIOME);
    info.xp = dead.getDynamicProperty("iv:xp");
  } catch {}
  system.run(() => {
    // what he dropped when he fell: the zombie picks it all up
    const items = [];
    try {
      for (const it of dim.getEntities({ type: "minecraft:item", location: loc, maxDistance: 2.5 })) {
        const stack = it.getComponent("minecraft:item")?.itemStack;
        if (!stack) continue;
        items.push(pack(stack));
        it.remove();
      }
    } catch {}
    for (const type of ZOMBIE_VILLAGERS) {
      let z;
      try {
        z = dim.spawnEntity(type, loc);
      } catch {
        continue;
      }
      const h = { items, ...info };
      held.set(z.id, h);
      try {
        z.setDynamicProperty(DP_HELD, JSON.stringify(h));
        if (info.name) z.nameTag = info.name; // (a name tag also keeps it from despawning with his things)
      } catch {}
      console.warn(`[Independent Villagers] a villager was killed by a ${killer.typeId.replace("minecraft:", "")} and rose again as a zombie villager, still carrying ${items.length} stack(s) of his things`);
      return;
    }
  });
}

function heldBy(z) {
  let h = held.get(z.id);
  if (!h) {
    try {
      h = JSON.parse(z.getDynamicProperty(DP_HELD) ?? "null") ?? undefined;
    } catch {}
  }
  return h;
}

// the zombie is killed: everything it was carrying falls out
world.afterEvents.entityDie.subscribe(
  (ev) => {
    const z = ev.deadEntity;
    const h = heldBy(z);
    held.delete(z.id);
    if (!h?.items?.length) return;
    const dim = z.dimension;
    const loc = { ...z.location };
    system.run(() => {
      for (const e of h.items) {
        try {
          dim.spawnItem(unpack(e), loc);
        } catch {}
      }
    });
  },
  { entityTypes: ZOMBIE_VILLAGERS }
);

// the zombie villager vanishes: if it was cured, a villager turns up right where it stood
world.beforeEvents.entityRemove?.subscribe((ev) => {
  const z = ev.removedEntity;
  if (!ZOMBIE_VILLAGERS.includes(z?.typeId)) return;
  const h = heldBy(z);
  if (!h) return;
  try {
    cures.push({ d: z.dimension.id, loc: { ...z.location }, held: h, at: system.currentTick });
  } catch {}
  held.delete(z.id);
});

/** A villager just appeared here: was he a cured zombie? His things, name and savings come back. */
export function restoreCured(villager) {
  const now = system.currentTick;
  for (let i = cures.length - 1; i >= 0; i--) if (now - cures[i].at > 400) cures.splice(i, 1);
  const l = villager.location;
  const i = cures.findIndex((c) => c.d === villager.dimension.id && Math.hypot(c.loc.x - l.x, c.loc.y - l.y, c.loc.z - l.z) <= 2.5);
  if (i < 0) return false;
  const { held: h } = cures.splice(i, 1)[0];
  const inv = getInventory(villager);
  for (const e of h.items ?? []) {
    try {
      const rest = vAdd(inv, unpack(e));
      if (rest) villager.dimension.spawnItem(rest, l);
    } catch {}
  }
  try {
    if (h.name) villager.nameTag = h.name;
    if (typeof h.biome === "number") villager.setProperty(PROP_BIOME, h.biome);
    if (typeof h.xp === "number") villager.setDynamicProperty("iv:xp", h.xp);
    villager.setDynamicProperty("iv:init", true); // no second helping of starting emeralds
  } catch {}
  debugLog(villager, `cured! back with his ${h.items?.length ?? 0} stack(s) of belongings`);
  return true;
}
