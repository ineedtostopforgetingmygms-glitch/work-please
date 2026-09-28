// Families. Two villagers who both have plenty of food (FAMILY.FOOD points of it: bread and cooked
// meat 4 each, a baked potato 2, carrots, potatoes and beetroot 1) and a free bed in the village
// for the baby have one: in the daytime, when they're at a loose end, one goes over to the other,
// hearts all round, they each give up their food, and there's a baby villager (a vanilla baby -
// it grows up in 20 minutes and becomes one of ours, with a name of its own).
//
// Villagers who are doing well buy food for it off the farmer (bread) and the butcher (meat).
import { system, world } from "@minecraft/server";
import { FAMILY, Profession, PROP_PROFESSION, VILLAGER_ID } from "./config.js";
import { freeze, getBrain, setMode, setState } from "./brain.js";
import { debugLog } from "./debug.js";
import { navStop, navTo, navUpdate } from "./nav.js";
import { emeralds } from "./economy.js";
import { vTake } from "./inventory.js";
import { eyePos, findStandableNear, floorPos, getBlock, getInventory, horizDist, isValid, lookAt, particle, playSound, ringOffsets } from "./util.js";
import { goShopping } from "./jobs/shopping.js";
import { isNight } from "./jobs/rest.js";

export const FOOD_POINTS = {
  "minecraft:bread": 4,
  "minecraft:cooked_beef": 4,
  "minecraft:cooked_porkchop": 4,
  "minecraft:cooked_chicken": 4,
  "minecraft:cooked_mutton": 4,
  "minecraft:baked_potato": 2,
  "minecraft:carrot": 1,
  "minecraft:potato": 1,
  "minecraft:beetroot": 1,
};
const DP_BRED = "iv:babyAt"; // world time he last had a baby
// states where he's at a loose end (not in the middle of something)
const LOOSE = new Set(["idle", "jobless", "watch", "supply", "plan", "survey", "seek"]);
// jobs that can go shopping (their brains have a "shop" state)
const SHOPPERS = new Set([Profession.LUMBERJACK, Profession.MINER, Profession.FARMER, Profession.CARTOGRAPHER, Profession.ARMORER, Profession.BUTCHER]);

export function foodPoints(villager) {
  const inv = getInventory(villager);
  let n = 0;
  for (let i = 0; i < 18; i++) {
    const it = inv?.getItem(i);
    if (it && FOOD_POINTS[it.typeId]) n += FOOD_POINTS[it.typeId] * it.amount;
  }
  return n;
}

/** Gives up `points` worth of food, the ready meals first. */
function eat(villager, points) {
  const inv = getInventory(villager);
  const order = Object.entries(FOOD_POINTS).sort((a, b) => b[1] - a[1]);
  for (const [id, p] of order) {
    while (points > 0 && vTake(inv, (x) => x === id, 1).length) points -= p;
    if (points <= 0) return;
  }
}

function cooledDown(villager) {
  const t = villager.getDynamicProperty(DP_BRED);
  const now = world.getAbsoluteTime();
  return typeof t !== "number" || now - t >= FAMILY.EVERY || now < t;
}

const willing = (v, brain) =>
  !brain.flee && !brain.tattle && !brain.court && !brain.asleep && LOOSE.has(brain.state) && foodPoints(v) >= FAMILY.FOOD && cooledDown(v);

const BED_LOOK = ringOffsets(0, FAMILY.BED_RADIUS, [0, 1, -1, 2, -2, 3, -3]);
const bedCache = new Map(); // "dim|cell" -> {at, i, heads, done}

/**
 * Beds around here. Counting them is a big look round, so it's done a slice at a time (whoever
 * asks next carries it on) and the answer is kept for a few minutes. Undefined until it's known.
 */
function bedsNear(dim, pos) {
  const key = `${dim.id}|${Math.floor(pos.x / 32)},${Math.floor(pos.z / 32)}`;
  const now = system.currentTick;
  let c = bedCache.get(key);
  if (c?.done && now - c.at < FAMILY.BED_RECOUNT) return c.heads;
  if (!c || c.done) {
    c = { i: 0, heads: 0, done: false, at: now, o: { x: Math.floor(pos.x / 32) * 32 + 16, y: pos.y, z: Math.floor(pos.z / 32) * 32 + 16 } };
    if (bedCache.size > 64) bedCache.clear();
    bedCache.set(key, c);
  }
  const end = Math.min(BED_LOOK.length, c.i + 4000);
  for (; c.i < end; c.i++) {
    const o = BED_LOOK[c.i];
    const b = getBlock(dim, { x: c.o.x + o.x, y: c.o.y + o.y, z: c.o.z + o.z });
    if (!b || !/bed$/.test(b.typeId)) continue;
    try {
      if (b.permutation.getState("head_piece_bit") !== true) continue; // count each bed once
    } catch {}
    c.heads++;
  }
  if (c.i >= BED_LOOK.length) {
    c.done = true;
    c.at = now;
    return c.heads;
  }
  return undefined;
}

/** Room for a baby: fewer villagers (babies included) about than there are beds, and not too many. */
function roomForBaby(dim, pos) {
  let people = 0;
  try {
    people =
      dim.getEntities({ type: VILLAGER_ID, location: pos, maxDistance: FAMILY.RADIUS }).length +
      dim.getEntities({ type: "minecraft:villager_v2", location: pos, maxDistance: FAMILY.RADIUS }).length;
  } catch {}
  const beds = bedsNear(dim, floorPos(pos));
  return beds !== undefined && people < FAMILY.MAX && people < beds;
}

/**
 * Called every loop for every villager (after the danger checks). True while he's busy with a
 * partner (his job waits). Also sends a well-off villager with no food off to buy some.
 */
export function familyCheck(villager, dim, brain, now) {
  if (brain.court) return courting(villager, dim, brain, now);
  if (now < (brain.nextFamily ?? 0)) return false;
  brain.nextFamily = now + FAMILY.CHECK_EVERY + Math.floor(Math.random() * 200);
  if (isNight()) return false;

  // food: a villager with money to spare keeps some in (the farmer and butcher sell it)
  const prof = villager.getProperty(PROP_PROFESSION);
  if (brain.state === "idle" && SHOPPERS.has(prof) && foodPoints(villager) < FAMILY.FOOD && emeralds(villager) >= FAMILY.RICH) {
    if (goShopping(villager, brain, "food", FAMILY.BUY, "idle", now)) {
      debugLog(villager, "doing well - off to buy some food");
      return false;
    }
  }

  if (!willing(villager, brain) || !roomForBaby(dim, villager.location)) return false;
  let partner;
  try {
    partner = dim
      .getEntities({ type: VILLAGER_ID, location: villager.location, maxDistance: FAMILY.PARTNER_RADIUS })
      .find((v) => v.id !== villager.id && willing(v, getBrain(v)));
  } catch {}
  if (!partner) return false;
  const pb = getBrain(partner);
  const start = (b, role, other) => {
    b.court = { partner: other.id, role, started: now, prev: b.state, prevJob: b.job };
    b.state = "court";
    b.action = null;
    navStop(role === "lead" ? villager : partner, b);
  };
  start(brain, "lead", partner);
  start(pb, "wait", villager);
  debugLog(villager, `plenty of food, and so has ${partner.nameTag?.split("\n")[0] || "a neighbour"} - off to see them`);
  return true;
}

function endCourt(v, b) {
  const c = b.court;
  b.court = null;
  if (!c) return;
  navStop(v, b);
  setState(v, b, c.prev && c.prev !== "court" ? c.prev : "idle");
  b.job = c.prevJob ?? null;
  b.mode = null;
  setMode(v, b, "rest");
}

function courting(villager, dim, brain, now) {
  const c = brain.court;
  let partner;
  try {
    partner = world.getEntity(c.partner);
  } catch {}
  const pb = partner && isValid(partner) ? getBrain(partner) : undefined;
  if (!pb || pb.court?.partner !== villager.id || now - c.started > FAMILY.TIMEOUT || brain.flee || pb.flee) {
    endCourt(villager, brain);
    if (pb?.court?.partner === villager.id) endCourt(partner, pb);
    return false;
  }
  if (c.role === "wait") {
    // stands and waits for them, looking their way
    setMode(villager, brain, "work");
    lookAt(villager, eyePos(partner));
    return true;
  }
  // walk over
  if (horizDist(villager.location, partner.location) > 2 || Math.abs(villager.location.y - partner.location.y) > 1.5) {
    if (brain.nav) {
      const r = navUpdate(villager, brain, now);
      if (r === "moving") return true;
    }
    const spot = findStandableNear(dim, floorPos(partner.location), 1, 2);
    if (!spot || !navTo(villager, brain, spot, { radius: 1.2, partial: true })) {
      c.fails = (c.fails ?? 0) + 1;
      if (c.fails > 5) {
        endCourt(villager, brain);
        endCourt(partner, pb);
      }
    }
    return true;
  }
  // together: a few seconds of hearts, then the baby
  navStop(villager, brain);
  setMode(villager, brain, "work");
  freeze(partner, 20);
  lookAt(villager, eyePos(partner));
  lookAt(partner, eyePos(villager));
  c.hearts ??= now;
  if (now - c.hearts < FAMILY.HEARTS) {
    if (now % 8 < 2) {
      for (const v of [villager, partner]) particle(dim, "minecraft:heart_particle", { x: v.location.x + (Math.random() - 0.5) * 0.6, y: v.location.y + 2.1, z: v.location.z + (Math.random() - 0.5) * 0.6 });
    }
    return true;
  }
  if (!roomForBaby(dim, villager.location) || foodPoints(villager) < FAMILY.FOOD || foodPoints(partner) < FAMILY.FOOD) {
    endCourt(villager, brain);
    endCourt(partner, pb);
    return false;
  }
  eat(villager, FAMILY.FOOD);
  eat(partner, FAMILY.FOOD);
  const at = { x: (villager.location.x + partner.location.x) / 2, y: villager.location.y, z: (villager.location.z + partner.location.z) / 2 };
  spawnBaby(dim, at);
  const t = world.getAbsoluteTime();
  villager.setDynamicProperty(DP_BRED, t);
  partner.setDynamicProperty(DP_BRED, t);
  playSound(dim, "mob.villager.yes", at);
  for (let i = 0; i < 8; i++) particle(dim, "minecraft:heart_particle", { x: at.x + (Math.random() - 0.5) * 1.5, y: at.y + 1 + Math.random(), z: at.z + (Math.random() - 0.5) * 1.5 });
  debugLog(villager, `a baby villager at ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}!`);
  endCourt(villager, brain);
  endCourt(partner, pb);
  return false;
}

function spawnBaby(dim, at) {
  try {
    return dim.spawnEntity("minecraft:villager_v2", at, { spawnEvent: "minecraft:entity_born" });
  } catch {}
  try {
    const b = dim.spawnEntity("minecraft:villager_v2", at);
    b.triggerEvent("minecraft:entity_born");
    return b;
  } catch {}
  return undefined;
}
