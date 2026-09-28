// Iron golems: counting them (how many does a village need?) and telling them where a monster is.
// An alerted golem goes after monsters anywhere within 64 blocks, seen or not, for a while
// (the iv:alerted group in entities/iron_golem.json), and gets a turn of speed.
import { system, world } from "@minecraft/server";
import { GOLEM, TATTLE, VILLAGER_ID } from "./config.js";
import { getBrain, setMode, setState, setWorking } from "./brain.js";
import { debugLog } from "./debug.js";
import { navStop, navTo, navUpdate } from "./nav.js";
import { findStandableNear, floorPos, horizDist, isValid, lookAt, particle, playSound } from "./util.js";

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

// ---------------------------------------------------------------- telling on a player

// Hit a villager for more than half his health and he goes and tells the nearest iron golem, which
// comes after you (the player gets the iv_wanted tag for a minute; alerted golems go for players
// with that tag - see entities/iron_golem.json).
const WANTED_TAG = "iv_wanted";
const hurtLog = new Map(); // villager id -> {player, total, since, told}
const wanted = new Map(); // player id -> {player, until}

world.afterEvents.entityHurt.subscribe(
  (ev) => {
    const src = ev.damageSource?.damagingEntity;
    if (src?.typeId !== "minecraft:player") return;
    const v = ev.hurtEntity;
    const now = system.currentTick;
    let h = hurtLog.get(v.id);
    if (!h || h.player !== src.id || now - h.since > TATTLE.WINDOW) h = { player: src.id, total: 0, since: now, told: false };
    h.total += ev.damage;
    hurtLog.set(v.id, h);
    let max = 20;
    try {
      max = v.getComponent("minecraft:health")?.effectiveMax ?? 20;
    } catch {}
    if (h.told || h.total < max * TATTLE.SHARE) return;
    h.told = true;
    const brain = getBrain(v);
    brain.tattle = { player: src.id, name: src.name, started: now };
    brain.wake = 0;
  },
  { entityTypes: [VILLAGER_ID] }
);

/** Golems told about this player go after him for a while. */
export function wantPlayer(player) {
  try {
    player.addTag(WANTED_TAG);
  } catch {
    return;
  }
  wanted.set(player.id, { player, until: system.currentTick + TATTLE.HUNT_TIME });
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const [id, w] of wanted) {
    if (w.until > now) continue;
    wanted.delete(id);
    try {
      if (isValid(w.player)) w.player.removeTag(WANTED_TAG);
    } catch {}
  }
}, 40);

// (left over from last time he played)
world.afterEvents.playerSpawn?.subscribe((ev) => {
  try {
    if (ev.initialSpawn && !wanted.has(ev.player.id)) ev.player.removeTag(WANTED_TAG);
  } catch {}
});

/**
 * Called every loop for every villager (after the monster check): a villager who's been hit hard by
 * a player runs - fast - to the nearest iron golem and tells on him. True while he's at it.
 */
export function tattleCheck(villager, dim, brain, now) {
  const t = brain.tattle;
  if (!t) return false;
  const finish = (why) => {
    if (why) debugLog(villager, why);
    brain.tattle = null;
    brain.fast = false;
    navStop(villager, brain);
    try {
      villager.removeEffect("speed");
    } catch {}
    if (t.prev) {
      setState(villager, brain, t.prev);
      brain.job = t.prevJob ?? null;
    }
    brain.mode = null;
    setMode(villager, brain, "rest");
    return false;
  };
  const player = world.getPlayers().find((p) => p.id === t.player);
  if (!player || now - t.started > TATTLE.TIMEOUT) return finish();
  if (!t.prev) {
    // drop everything
    t.prev = brain.state;
    t.prevJob = brain.job;
    brain.state = "tattle";
    brain.action = null;
    brain.frozenUntil = 0;
    navStop(villager, brain);
    setWorking(villager, false);
    playSound(dim, "mob.villager.no", villager.location);
    particle(dim, "minecraft:villager_angry", { x: villager.location.x, y: villager.location.y + 2.1, z: villager.location.z });
  }
  let golem;
  try {
    golem = dim.getEntities({ type: IRON_GOLEM, location: villager.location, maxDistance: TATTLE.GOLEM_RADIUS, closest: 1 })[0];
  } catch {}
  if (!golem) return finish(`hurt by ${t.name ?? "a player"} - and no iron golem to tell`);
  brain.fast = true;
  if (now % 40 < 4) {
    try {
      villager.addEffect("speed", 60, { amplifier: 2, showParticles: false }); // (he walks otherwise)
    } catch {}
  }
  if (horizDist(villager.location, golem.location) <= 3.5 && Math.abs(villager.location.y - golem.location.y) < 3) {
    lookAt(villager, { x: golem.location.x, y: golem.location.y + 2.3, z: golem.location.z });
    wantPlayer(player);
    alertGolem(golem);
    playSound(dim, "mob.villager.haggle", villager.location, 0.8);
    particle(dim, "minecraft:villager_angry", { x: golem.location.x, y: golem.location.y + 3, z: golem.location.z });
    return finish(`told the iron golem that ${t.name ?? "a player"} hurt him`);
  }
  if (brain.nav && horizDist(brain.nav.goal, golem.location) > 3) navStop(villager, brain);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return true;
  }
  const spot = findStandableNear(dim, floorPos(golem.location), 2, 3);
  if (!spot || !navTo(villager, brain, spot, { radius: 2, partial: true })) {
    t.fails = (t.fails ?? 0) + 1;
    if (t.fails > 6) return finish("can't get to the iron golem");
  }
  return true;
}
