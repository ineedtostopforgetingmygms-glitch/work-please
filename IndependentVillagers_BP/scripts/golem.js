// Iron golems: counting them (how many does a village need?) and telling them where a monster is.
// An alerted golem goes after monsters anywhere within 64 blocks, seen or not, for a while
// (the iv:alerted group in entities/iron_golem.json), and gets a turn of speed.
import { system, world } from "@minecraft/server";
import { GOLEM, VILLAGER_ID } from "./config.js";
import { isValid } from "./util.js";

export const IRON_GOLEM = "minecraft:iron_golem";
const alerted = new Map(); // golem id -> {golem, until}

export function golemsNear(dim, pos, r = GOLEM.RADIUS) {
  try {
    return dim.getEntities({ type: IRON_GOLEM, location: pos, maxDistance: r });
  } catch {
    return [];
  }
}

/** How many golems a village this size should have: one, and another for every GOLEM.PER villagers. */
export function golemCap(dim, pos) {
  let villagers = 0;
  try {
    villagers = dim.getEntities({ type: VILLAGER_ID, location: pos, maxDistance: GOLEM.RADIUS }).length;
  } catch {}
  return Math.min(GOLEM.MAX, 1 + Math.floor(villagers / GOLEM.PER));
}

/** A nitwit tells this golem there's a monster about: it goes looking. */
export function alertGolem(golem) {
  try {
    golem.triggerEvent("iv:alert");
    golem.addEffect("speed", GOLEM.ALERT_TIME, { amplifier: 1, showParticles: false });
  } catch {
    return false;
  }
  alerted.set(golem.id, { golem, until: system.currentTick + GOLEM.ALERT_TIME });
  return true;
}

export function isAlerted(golem) {
  return (alerted.get(golem.id)?.until ?? 0) > system.currentTick;
}

// alerts wear off
system.runInterval(() => {
  const now = system.currentTick;
  for (const [id, a] of alerted) {
    if (a.until > now) continue;
    alerted.delete(id);
    try {
      if (isValid(a.golem)) a.golem.triggerEvent("iv:alert_done");
    } catch {}
  }
}, 40);

// (a golem that was alerted when the world was saved has forgotten all about it by now)
world.afterEvents.entityLoad?.subscribe((ev) => {
  try {
    if (ev.entity?.typeId === IRON_GOLEM && !alerted.has(ev.entity.id)) ev.entity.triggerEvent("iv:alert_done");
  } catch {}
});
