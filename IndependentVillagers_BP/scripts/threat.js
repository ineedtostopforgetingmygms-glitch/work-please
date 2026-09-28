// Danger. A zombie (or any other monster) close by and in plain sight - or one that has just hit
// him - beats whatever he was doing: he drops it, runs (fast), preferably towards an iron golem,
// and once nothing has come after him for a few seconds he goes back to what he was doing.
// Monsters on the other side of a wall don't count: a villager in bed with a zombie at the door
// stays in bed.
import { system, world } from "@minecraft/server";
import { THREAT, VILLAGER_ID } from "./config.js";
import { setMode, setState, setWorking } from "./brain.js";
import { debugLog } from "./debug.js";
import { navStop, navTo, navUpdate } from "./nav.js";
import { dist, eyePos, findStandableNear, floorPos, getBlock, isValid, raycast } from "./util.js";

/** His bed (where he sleeps - his house), if he has one in this dimension. */
function bedOf(villager, dim) {
  try {
    const b = JSON.parse(villager.getDynamicProperty("iv:bed") ?? "null");
    return b && b.d === dim.id ? { x: b.x, y: b.y, z: b.z } : undefined;
  } catch {
    return undefined;
  }
}

// monsters that leave villagers alone
const HARMLESS = new Set([
  "minecraft:enderman",
  "minecraft:zombie_pigman",
  "minecraft:zombified_piglin",
  "minecraft:piglin",
  "minecraft:piglin_brute",
  "minecraft:strider",
  "minecraft:bat",
]);

const hurtBy = new Map(); // villager id -> {id, at}: a monster that hit him

world.afterEvents.entityHurt.subscribe(
  (ev) => {
    const src = ev.damageSource?.damagingEntity;
    if (!src || src.typeId === "minecraft:player") return;
    try {
      if (!src.matches({ families: ["monster"] })) return;
    } catch {
      return;
    }
    hurtBy.set(ev.hurtEntity.id, { id: src.id, at: system.currentTick });
  },
  { entityTypes: [VILLAGER_ID] }
);

/** Eyes of a mob (roughly - they're all about villager height or less). */
function mobEye(e) {
  return { x: e.location.x, y: e.location.y + 1.2, z: e.location.z };
}

/** Can he see it? Nothing solid on the line between his eyes and the mob's. */
export function canSeeMob(dim, villager, mob) {
  return !raycast(dim, eyePos(villager), mobEye(mob));
}

/**
 * Monsters within `radius` that could get at him: in sight (or right on top of him), not across
 * a big drop or climb. Nearest first.
 */
export function threatsNear(dim, villager, radius = THREAT.RADIUS) {
  let list;
  try {
    list = dim.getEntities({ families: ["monster"], location: villager.location, maxDistance: radius });
  } catch {
    return [];
  }
  const l = villager.location;
  const out = [];
  for (const m of list) {
    if (HARMLESS.has(m.typeId)) continue;
    const d = dist(m.location, l);
    if (Math.abs(m.location.y - l.y) > 5) continue;
    if (d > THREAT.CLOSE && !canSeeMob(dim, villager, m)) continue;
    if (d <= THREAT.CLOSE && Math.abs(m.location.y - l.y) > 2.5 && !canSeeMob(dim, villager, m)) continue;
    out.push({ m, d });
  }
  const hit = hurtBy.get(villager.id);
  if (hit && system.currentTick - hit.at < THREAT.SAFE_AFTER) {
    const m = list.find((e) => e.id === hit.id);
    if (m && !out.some((o) => o.m.id === m.id)) out.push({ m, d: dist(m.location, l) });
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.m);
}

/**
 * Called every loop for every villager, before his job. True while he's running away (the job
 * waits). `onWake` gets him out of bed first if he was asleep.
 */
export function dangerCheck(villager, dim, brain, now, onWake) {
  const f = brain.flee;
  if (!f) {
    if (now < (brain.nextDanger ?? 0)) return false;
    // (everyone checks on his own tick, not all twenty in the same one)
    brain.nextDanger = now + THREAT.CHECK_EVERY + (brain.nextDanger === undefined ? Math.floor(Math.random() * THREAT.CHECK_EVERY) : 0);
    const threats = threatsNear(dim, villager);
    if (!threats.length) return false;
    startFleeing(villager, dim, brain, now, threats, onWake);
    return true;
  }

  // already running: keep an eye on them, and keep going
  if (now >= (f.nextLook ?? 0)) {
    f.nextLook = now + 6;
    const threats = threatsNear(dim, villager, THREAT.RADIUS + 6);
    if (threats.length) {
      f.lastSeen = now;
      f.threats = threats.map((m) => ({ x: m.location.x, y: m.location.y, z: m.location.z }));
      const goalBad = brain.nav && f.threats.some((t) => dist(t, brain.nav.goal) < dist(t, villager.location));
      if (!brain.nav || goalBad) runFrom(villager, dim, brain, f.threats);
    }
  }
  if (now - f.lastSeen > THREAT.SAFE_AFTER) {
    stopFleeing(villager, brain);
    return false;
  }
  if (now % 40 < 2) speedUp(villager);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r !== "moving") navStop(villager, brain);
  } else if (now - (f.lastRun ?? 0) > 20) {
    // home and indoors: he stays put unless it's come in after him
    const home = f.homeSpot && dist(villager.location, { x: f.homeSpot.x + 0.5, y: f.homeSpot.y, z: f.homeSpot.z + 0.5 }) < 3;
    const close = f.threats.some((t) => dist(t, villager.location) <= THREAT.CLOSE + 1);
    if (!home || close) runFrom(villager, dim, brain, f.threats);
    else setMode(villager, brain, "rest");
  }
  return true;
}

function startFleeing(villager, dim, brain, now, threats, onWake) {
  if (brain.asleep && onWake) onWake();
  const what = threats[0].typeId.replace("minecraft:", "");
  debugLog(villager, `a ${what} ${dist(threats[0].location, villager.location).toFixed(1)} blocks away - running for it (was ${brain.state})`);
  navStop(villager, brain);
  brain.action = null;
  brain.frozenUntil = 0;
  brain.flee = {
    prev: brain.state,
    prevJob: brain.job,
    lastSeen: now,
    threats: threats.map((m) => ({ x: m.location.x, y: m.location.y, z: m.location.z })),
  };
  brain.state = "flee"; // (not setState: his shift, break and job all stay as they were)
  brain.fast = true;
  setWorking(villager, false);
  speedUp(villager);
  runFrom(villager, dim, brain, brain.flee.threats);
}

function stopFleeing(villager, brain) {
  const f = brain.flee;
  brain.flee = null;
  brain.fast = false;
  navStop(villager, brain);
  try {
    villager.removeEffect("speed");
  } catch {}
  debugLog(villager, `safe again - back to ${f.prev ?? "work"}`);
  // back to whatever he was at (states re-check everything they need, so a fresh start is fine)
  const prev = f.prev && !["flee"].includes(f.prev) ? f.prev : "idle";
  setState(villager, brain, prev);
  brain.job = f.prevJob ?? null;
  brain.mode = null;
  setMode(villager, brain, "rest");
}

function speedUp(villager) {
  try {
    villager.addEffect("speed", 60, { amplifier: 2, showParticles: false }); // (he walks otherwise)
  } catch {}
}

/**
 * Picks somewhere to run to: his own house (his bed) if the monsters aren't between him and it,
 * then an iron golem the same way, otherwise a dry spot a dozen blocks directly away from them (or
 * as near that as the ground allows).
 */
function runFrom(villager, dim, brain, threats) {
  const f = brain.flee;
  if (f) f.lastRun = system.currentTick;
  const l = villager.location;
  let ax = 0;
  let az = 0;
  for (const t of threats) {
    const dx = l.x - t.x;
    const dz = l.z - t.z;
    const d2 = Math.max(0.25, dx * dx + dz * dz);
    ax += dx / d2;
    az += dz / d2;
  }
  const len = Math.hypot(ax, az);
  if (len < 1e-6) {
    const a = Math.random() * Math.PI * 2;
    ax = Math.cos(a);
    az = Math.sin(a);
  } else {
    ax /= len;
    az /= len;
  }
  const nearest = (p) => Math.min(...threats.map((t) => dist(t, p)));
  const here = nearest(l);
  const awayish = (p) => {
    const gx = p.x - l.x;
    const gz = p.z - l.z;
    const gl = Math.hypot(gx, gz) || 1;
    return (gx * ax + gz * az) / gl > -0.3;
  };

  // home: into his house, by his bed (the monster isn't in there with him)
  const bed = bedOf(villager, dim);
  if (bed && dist(bed, l) <= THREAT.HOME_RADIUS && (awayish(bed) || dist(bed, l) < 4) && nearest(bed) > THREAT.CLOSE + 1) {
    const spot = findStandableNear(dim, bed, 2, 2, (q) => /bed$/.test(getBlock(dim, q)?.typeId ?? "") || /bed$/.test(getBlock(dim, { x: q.x, y: q.y - 1, z: q.z })?.typeId ?? ""));
    if (spot && navTo(villager, brain, spot, { radius: 1.2, partial: true })) {
      if (f && !f.homeSpot) debugLog(villager, "running home");
      if (f) f.homeSpot = spot;
      return;
    }
  }

  // an iron golem he can run to (not one on the far side of the zombies)
  try {
    const golem = dim.getEntities({ type: "minecraft:iron_golem", location: l, maxDistance: THREAT.GOLEM_RADIUS, closest: 1 })[0];
    if (golem && isValid(golem)) {
      const gx = golem.location.x - l.x;
      const gz = golem.location.z - l.z;
      const gl = Math.hypot(gx, gz) || 1;
      if ((gx * ax + gz * az) / gl > -0.3 && gl > 3) {
        const spot = findStandableNear(dim, floorPos(golem.location), 2, 3);
        if (spot && navTo(villager, brain, spot, { radius: 1.5, partial: true })) return;
      }
    }
  } catch {}

  for (const deg of [0, 35, -35, 70, -70, 110, -110]) {
    const a = (deg * Math.PI) / 180;
    const rx = ax * Math.cos(a) - az * Math.sin(a);
    const rz = ax * Math.sin(a) + az * Math.cos(a);
    const p = floorPos({ x: l.x + rx * THREAT.RUN, y: l.y, z: l.z + rz * THREAT.RUN });
    const spot = findStandableNear(dim, p, 2, 4, (q) => !!getBlock(dim, q)?.isLiquid);
    if (!spot || nearest({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }) < here + 3) continue;
    if (navTo(villager, brain, spot, { radius: 1.5, partial: true })) return;
  }
}
