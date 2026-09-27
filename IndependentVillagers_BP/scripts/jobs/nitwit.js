// Nitwit - no job, and he'll never take one. But he keeps his eyes open: when he spots a zombie (or
// any other monster) about the village he runs - fast - to the nearest iron golem and tells it,
// and the golem goes after it. (Too close for comfort and he runs away instead, like everyone.)
import { CFG, NITWIT } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { navStop, navTo, navUpdate } from "../nav.js";
import { alertGolem, IRON_GOLEM } from "../golem.js";
import { threatsNear } from "../threat.js";
import { findStandableNear, floorPos, horizDist, isValid, lookAt, particle, playSound } from "../util.js";
import { goIndoors, goToBed, hideState, sleepState } from "./rest.js";

export function nitwitThink(villager, dim, brain, now) {
  if (brain.state === "sleep") return sleepState(villager, dim, brain, now, undefined, "watch");
  if (brain.state === "hide") return hideState(villager, dim, brain, now, undefined, "watch");
  if (brain.state !== "report" && (goIndoors(villager, dim, brain, now) || goToBed(villager, dim, brain, now))) return;
  if (brain.state === "report") return report(villager, dim, brain, now);
  if (brain.state !== "watch") setState(villager, brain, "watch");
  setMode(villager, brain, "wander");
  setWorking(villager, false);
  sleep(brain, CFG.THINK_IDLE);
  if (now < (brain.nextLookout ?? 0)) return;
  brain.nextLookout = now + NITWIT.LOOK_EVERY;

  // anything out there he hasn't told a golem about yet?
  brain.told ??= new Map();
  for (const [id, at] of brain.told) if (now - at > NITWIT.RETELL) brain.told.delete(id);
  const seen = threatsNear(dim, villager, NITWIT.SIGHT).filter((m) => !brain.told.has(m.id));
  if (!seen.length) return;
  const m = seen[0];
  let golem;
  try {
    golem = dim.getEntities({ type: IRON_GOLEM, location: villager.location, maxDistance: NITWIT.GOLEM_RADIUS, closest: 1 })[0];
  } catch {}
  for (const s of seen) brain.told.set(s.id, now);
  const what = m.typeId.replace("minecraft:", "");
  const where = floorPos(m.location);
  if (!golem) {
    // no golem to tell: he makes a fuss about it at least
    playSound(dim, "mob.villager.no", villager.location);
    particle(dim, "minecraft:villager_angry", { x: villager.location.x, y: villager.location.y + 2.1, z: villager.location.z });
    debugLog(villager, `spotted a ${what} at ${where.x} ${where.y} ${where.z} - and there's no iron golem to tell`);
    return;
  }
  debugLog(villager, `spotted a ${what} at ${where.x} ${where.y} ${where.z} - running to tell the iron golem ${Math.round(horizDist(golem.location, villager.location))} blocks away`);
  playSound(dim, "mob.villager.haggle", villager.location, 1.4);
  brain.job = { golem: golem.id, what, where, started: now };
  setState(villager, brain, "report");
}

/** Running to the golem (fast), then telling it. */
function report(villager, dim, brain, now) {
  const job = brain.job;
  let golem;
  try {
    golem = job && dim.getEntities({ type: IRON_GOLEM, location: villager.location, maxDistance: NITWIT.GOLEM_RADIUS + 16 }).find((g) => g.id === job.golem);
  } catch {}
  const done = () => {
    brain.fast = false;
    navStop(villager, brain);
    try {
      villager.removeEffect("speed");
    } catch {}
    brain.job = null;
    setState(villager, brain, "watch");
  };
  if (!golem || !isValid(golem) || now - job.started > NITWIT.TIMEOUT) return done();

  brain.fast = true; // (nav.js runs him flat out)
  if (now % 40 < 4) {
    try {
      villager.addEffect("speed", 60, { amplifier: NITWIT.SPEED, showParticles: false });
    } catch {}
  }
  if (horizDist(villager.location, golem.location) <= 3.5 && Math.abs(villager.location.y - golem.location.y) < 3) {
    navStop(villager, brain);
    lookAt(villager, { x: golem.location.x, y: golem.location.y + 2.3, z: golem.location.z });
    alertGolem(golem);
    playSound(dim, "mob.villager.yes", villager.location, 1.3);
    for (let i = 0; i < 5; i++) particle(dim, "minecraft:villager_happy", { x: golem.location.x + (Math.random() - 0.5), y: golem.location.y + 3, z: golem.location.z + (Math.random() - 0.5) });
    debugLog(villager, `told the iron golem about the ${job.what} at ${job.where.x} ${job.where.y} ${job.where.z}`);
    return done();
  }
  // head for the golem (it wanders about - follow it)
  if (brain.nav && horizDist(brain.nav.goal, golem.location) > 3) navStop(villager, brain);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 2);
  }
  const spot = findStandableNear(dim, floorPos(golem.location), 2, 3);
  if (!spot || !navTo(villager, brain, spot, { radius: 2, partial: true })) {
    job.fails = (job.fails ?? 0) + 1;
    if (job.fails > 5) return done();
  }
  sleep(brain, 2);
}


