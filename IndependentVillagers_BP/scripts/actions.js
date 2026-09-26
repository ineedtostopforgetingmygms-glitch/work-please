// Player-like actions: holding tools, breaking blocks over time, picking up items, placing blocks.
import { ItemStack, system } from "@minecraft/server";
import { AXES, CFG, DP_TOOL, HARDNESS, HOES, LEAVES, LOGS, PICKAXE_BLOCK, PICKAXES } from "./config.js";
import { setWorking } from "./brain.js";
import { GEN_END, vAdd, vGive } from "./inventory.js";
import { canSee, center, getBlock, getInventory, lookAt, playSound } from "./util.js";

// ---------------------------------------------------------------- tools
// The axe is a real item in the villager's inventory (with real durability). The one in his hand
// is only for show while he works.

const TOOL_TABLES = { axe: AXES, pickaxe: PICKAXES, hoe: HOES };

/** Best tool of a kind in the normal inventory slots: {slot, item, id, speed} */
function bestTool(inv, kind = "axe") {
  const table = TOOL_TABLES[kind];
  let best;
  for (let i = 0; i < GEN_END; i++) {
    const item = inv.getItem(i);
    const info = item && table[item.typeId];
    if (info && (!best || info.speed > best.speed)) best = { slot: i, item, id: item.typeId, speed: info.speed };
  }
  return best;
}
const bestAxe = (inv) => bestTool(inv, "axe");

function durabilityLeft(item) {
  try {
    const d = item.getComponent("minecraft:durability");
    return d ? d.maxDurability - d.damage : 1;
  } catch {
    return 1;
  }
}

/** @returns {{id:string, uses:number, speed:number}|undefined} */
export function getTool(villager, kind = "axe") {
  const inv = getInventory(villager);
  migrateOldTool(villager, inv);
  const t = inv && bestTool(inv, kind);
  return t ? { id: t.id, uses: durabilityLeft(t.item), speed: t.speed } : undefined;
}

/** Axes used to be stored as a dynamic property (v1.2.x) - turn it into a real item. */
function migrateOldTool(villager, inv) {
  const raw = villager.getDynamicProperty(DP_TOOL);
  if (typeof raw !== "string" || !inv) return;
  villager.setDynamicProperty(DP_TOOL, undefined);
  try {
    const old = JSON.parse(raw);
    const item = new ItemStack(old.id, 1);
    const d = item.getComponent("minecraft:durability");
    if (d) d.damage = Math.max(0, Math.min(d.maxDurability - 1, d.maxDurability - old.uses));
    vGive(villager, item);
  } catch {}
}

export function giveTool(villager, id) {
  vGive(villager, new ItemStack(id, 1));
}

export function holdItem(villager, itemId) {
  try {
    villager.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${itemId ?? "air"}`);
  } catch {}
}

/** Uses up one durability point of the best tool of that kind. Returns true if it broke. */
export function wearTool(villager, kind = "axe") {
  const inv = getInventory(villager);
  const axe = inv && bestTool(inv, kind);
  if (!axe) return false;
  let d;
  try {
    d = axe.item.getComponent("minecraft:durability");
  } catch {}
  if (!d) return false;
  if (d.damage + 1 < d.maxDurability) {
    d.damage += 1;
    inv.setItem(axe.slot, axe.item);
    return false;
  }
  inv.setItem(axe.slot); // worn out
  playSound(villager.dimension, "random.break", villager.location);
  holdItem(villager, bestTool(inv, kind)?.id); // switch to a spare if he has one
  return true;
}

// ---------------------------------------------------------------- breaking

/**
 * Vanilla break times in ticks: hardness * 1.5 / speed with the right tool,
 * hardness * 5 for pickaxe blocks without a pickaxe.
 */
export function breakTicks(blockId, tool) {
  if (LEAVES.has(blockId)) return 6;
  if (LOGS.has(blockId)) {
    const speed = (tool && AXES[tool.id]?.speed) || 1;
    return Math.ceil(((2 * 1.5) / speed) * 20);
  }
  const hardness = HARDNESS[blockId] ?? 1.5;
  if (PICKAXE_BLOCK.test(blockId)) {
    const pick = tool && PICKAXES[tool.id];
    return Math.ceil((pick ? (hardness * 1.5) / pick.speed : hardness * 5) * 20);
  }
  return Math.max(2, Math.ceil(hardness * 1.5 * 20));
}

/** `noDrop`: the tool is too soft for it (ore mined with a wooden pickaxe) - it breaks into nothing. */
export function startBreak(brain, block, tool, noDrop = false) {
  brain.action = {
    kind: "break",
    pos: { x: block.x, y: block.y, z: block.z },
    id: block.typeId,
    left: breakTicks(block.typeId, tool),
    last: system.currentTick,
    nextHit: 0,
    noDrop,
  };
}

/**
 * Advances the current break. Looks at the block, swings, plays hit sounds and finally breaks it
 * with real particles + drops (setblock ... destroy), exactly like a player mining it.
 * @returns {"working"|"done"|"gone"}
 */
export function updateBreak(villager, dim, brain, now) {
  const a = brain.action;
  const block = getBlock(dim, a.pos);
  if (!block || block.typeId !== a.id) {
    brain.action = null;
    return "gone";
  }
  const c = center(a.pos);
  lookAt(villager, c);
  setWorking(villager, true);

  a.left -= now - a.last;
  a.last = now;
  if (now >= a.nextHit) {
    playSound(dim, LOGS.has(a.id) ? "hit.wood" : "hit.grass", c, 0.9 + Math.random() * 0.2);
    a.nextHit = now + 4;
  }
  if (a.left > 0) return "working";

  try {
    if (a.noDrop) block.setType("minecraft:air"); // wrong tool: it drops nothing, like vanilla
    else dim.runCommand(`setblock ${a.pos.x} ${a.pos.y} ${a.pos.z} air destroy`);
  } catch {
    block.setType("minecraft:air");
  }
  brain.action = null;
  return "done";
}

// ---------------------------------------------------------------- items

/** Picks up wanted items lying within reach of the villager's feet, like a player walking over them. */
export function pickupItems(villager, dim, inv, wanted, radius = CFG.PICKUP_RADIUS, allowedAt = undefined) {
  let items;
  try {
    items = dim.getEntities({ type: "minecraft:item", location: villager.location, maxDistance: radius + 0.6 });
  } catch {
    return 0;
  }
  let picked = 0;
  for (const item of items) {
    let stack;
    try {
      stack = item.getComponent("minecraft:item")?.itemStack;
    } catch {
      continue;
    }
    if (!stack || !wanted(stack.typeId)) continue;
    const loc = item.location;
    if (allowedAt && !allowedAt(loc)) continue; // e.g. another lumberjack's wood
    const rest = vAdd(inv, stack); // never into the shop row
    if (rest && rest.amount === stack.amount) continue; // no room
    item.remove();
    if (rest) dim.spawnItem(rest, loc);
    playSound(dim, "random.pop", loc, 1.4 + Math.random() * 0.6);
    picked++;
  }
  return picked;
}

/** Places a block while looking at it. */
export function placeBlock(villager, dim, pos, typeId, sound = "use.wood") {
  const block = getBlock(dim, pos);
  if (!block) return false;
  if (!canSee(dim, villager, pos)) return false; // no building through walls
  lookAt(villager, center(pos));
  try {
    block.setType(typeId);
  } catch {
    return false;
  }
  playSound(dim, sound, center(pos));
  return true;
}
