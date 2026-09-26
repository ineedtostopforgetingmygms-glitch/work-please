// Using a furnace like a player: put the goods in the top slot, fuel underneath, wait for it to
// burn (10 seconds an item) and take the result out. Shared by the miner (logs -> charcoal) and
// the farmer (raw iron -> iron ingots).
import { ItemStack } from "@minecraft/server";
import { CFG, LOGS } from "../config.js";
import { debugLog } from "../debug.js";
import { GEN_END, vAdd, vTake } from "../inventory.js";
import { canUse, center, getBlock, lookAt, offset, particle, playSound } from "../util.js";

export const FURNACES = ["minecraft:furnace", "minecraft:lit_furnace"];

/**
 * A furnace near a job block, if there is one - as far out as a villager will walk to put one down
 * (see workshop.js), so he never builds a second one he can't find.
 */
export function furnaceNear(dim, ws, radius = CFG.WORK.PLACE_RADIUS) {
  let best;
  let bestD = Infinity;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -radius; dx <= radius; dx++)
      for (let dz = -radius; dz <= radius; dz++) {
        const d = dx * dx + dz * dz + dy * dy * 4;
        if (d >= bestD) continue;
        const p = offset(ws, dx, dy, dz);
        if (!FURNACES.includes(getBlock(dim, p)?.typeId)) continue;
        best = p;
        bestD = d;
      }
  return best;
}

export function furnaceContainer(dim, p) {
  try {
    return getBlock(dim, p)?.getComponent("minecraft:inventory")?.container;
  } catch {
    return undefined;
  }
}

/** Something already smelted and waiting in the output slot. */
export function furnaceHas(dim, p, product) {
  return furnaceContainer(dim, p)?.getItem(2)?.typeId === product;
}

/** 1 log -> 4 planks: enough fuel for 6 items. */
export function plankFuel(inv) {
  const [log] = vTake(inv, (id) => LOGS.has(id), 1);
  return log ? new ItemStack(log.replace("_log", "_planks"), 4) : undefined;
}

/**
 * One think's worth of smelting. `job` is the villager's brain.job (kept between thinks).
 * @returns {"working"|"done"|"nofurnace"|"toofar"|"busy"|"nothing"}
 */
export function smeltStep(villager, dim, brain, now, ws, cfg) {
  const inv = villager.getComponent("minecraft:inventory").container;
  const fpos = furnaceNear(dim, ws);
  if (!fpos) return "nofurnace";
  if (!canUse(dim, villager, fpos, CFG.REACH + 1)) return "toofar"; // he has to walk round to it
  const fc = center(fpos);
  lookAt(villager, fc);
  const furnace = furnaceContainer(dim, fpos);
  const job = (brain.job ??= { started: now, loaded: false, got: 0 });

  // Older game versions don't let scripts reach into furnaces - then he just burns it "by hand".
  if (!furnace) {
    if (!job.loaded) {
      const pick = cfg.pickInput(inv);
      if (!pick?.count) return "nothing";
      vTake(inv, (id) => id === pick.type, pick.count);
      cfg.takeFuel(inv);
      job.n = pick.count;
      job.loaded = true;
      job.done = now + 200 * Math.max(1, job.n);
      debugLog(villager, `smelting ${job.n} ${pick.type.replace("minecraft:", "")}`);
    }
    if (now % 20 === 0) particle(dim, "minecraft:basic_flame_particle", offset(fc, 0, 0.3, 0));
    if (now < job.done) return "working";
    if (job.n > 0) vAdd(inv, new ItemStack(cfg.product, job.n));
    job.got = job.n ?? 0;
    return "done";
  }

  if (!job.loaded) {
    job.loaded = true;
    const input = furnace.getItem(0);
    if (input && !cfg.isInput(input.typeId)) return "busy";
    if (!input) {
      const pick = cfg.pickInput(inv);
      if (!pick?.count) return "nothing";
      vTake(inv, (id) => id === pick.type, pick.count);
      furnace.setItem(0, new ItemStack(pick.type, pick.count));
      job.n = pick.count;
    }
    if (!furnace.getItem(1)) {
      const fuel = cfg.takeFuel(inv);
      if (fuel) furnace.setItem(1, fuel);
    }
    playSound(dim, "random.click", fc, 0.8);
    debugLog(villager, `put ${job.n ?? 0} in the furnace to make ${cfg.product.replace("minecraft:", "")}`);
    return "working";
  }

  // take out whatever is ready
  const out = furnace.getItem(2);
  if (out?.typeId === cfg.product) {
    furnace.setItem(2);
    job.got += out.amount;
    const rest = vAdd(inv, out);
    if (rest) dim.spawnItem(rest, villager.location);
    playSound(dim, "random.pop", fc, 1.2);
  }
  const left = furnace.getItem(0);
  const burning = left && cfg.isInput(left.typeId);
  if (burning && now - job.started <= CFG.SMELT_TIMEOUT) return "working"; // stands by and waits
  return "done";
}

/** The item type he has most of that can go in the furnace (up to `max` of it). */
export function pickStack(inv, isInput, max) {
  const counts = new Map();
  for (let i = 0; i < GEN_END; i++) {
    const it = inv.getItem(i);
    if (it && isInput(it.typeId)) counts.set(it.typeId, (counts.get(it.typeId) ?? 0) + it.amount);
  }
  const [type, have] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  return type ? { type, count: Math.min(max, have) } : undefined;
}
