// Per-villager short-term memory (what it's doing right now). Not saved: after a world reload
// every villager simply starts its job loop again.
import { system } from "@minecraft/server";
import { CFG, PROP_WORKING } from "./config.js";
import { debugLog } from "./debug.js";

const brains = new Map();

export const STATE_LABELS = {
  jobless: "Looking for a job (place a Woodcutter's Bench or a Stonecutter nearby!)",
  bench: "Setting up his own woodcutter's bench",
  wood: "Cutting his own wood",
  supply: "Getting ready for work",
  shop: "Buying materials from another villager",
  craft: "Crafting",
  smelt: "At the furnace",
  market: "Trading at his job block (his trading hours)",
  dig: "Digging the mineshaft",
  stash: "Storing what he mined",
  seek: "Looking for trees",
  approach: "Walking to a tree",
  fell: "Chopping a tree",
  descend: "Climbing down",
  gather: "Picking up drops",
  replant: "Replanting saplings",
  home: "Carrying wood home",
  deposit: "Storing wood",
  survey: "Looking over the fields",
  tend: "Harvesting and sowing",
  seeds: "Collecting seeds",
  fill: "Fetching water",
  build: "Laying out a new field",
  idle: "Taking a break",
  sleep: "Off to bed",
  hide: "Getting indoors (the bell!)",
};

/** What to show a player: a villager who hasn't earned a break yet is only pausing, not resting. */
export function stateLabel(brain) {
  if (brain?.state === "idle" && !brain.onBreak) return "Sizing up what to do next";
  return STATE_LABELS[brain?.state];
}

export function getBrain(entity) {
  let brain = brains.get(entity.id);
  if (!brain) {
    brain = {
      state: null,
      since: system.currentTick,
      mode: null,
      job: null,
      nav: null,
      action: null,
      wake: 0,
      tries: 0,
      idleFor: 0,
      shiftStart: system.currentTick, // when his current stretch of work started
      onBreak: false,
      nextJobScan: 0,
      scan: null,
      fresh: true,
    };
    brains.set(entity.id, brain);
  }
  brain.seen = system.currentTick;
  return brain;
}

export function peekBrain(id) {
  return brains.get(id);
}

export function allBrains() {
  return brains;
}

export function forgetBrain(id) {
  brains.delete(id);
}

export function pruneBrains(now, maxAge) {
  for (const [id, brain] of brains) {
    if (now - brain.seen > maxAge) brains.delete(id);
  }
}

export function setState(entity, brain, state, idleFor = 0) {
  const now = system.currentTick;
  if (state === "idle") idleFor = restFor(entity, brain, idleFor, now);
  else {
    // rested, or just spent his trading hours standing at the stall: a fresh shift either way
    if (brain.state === "market" || (brain.state === "idle" && brain.onBreak)) brain.shiftStart = now;
    brain.onBreak = false;
  }
  brain.shiftStart ??= now;
  if (brain.state !== state) debugLog(entity, `${brain.state ?? "-"} -> ${state}`);
  brain.state = state;
  brain.since = now;
  brain.tries = 0;
  brain.idleFor = idleFor;
  brain.wake = 0;
}

/**
 * How long he actually stops for. He's only allowed a proper break once he's been at work for
 * CFG.WORK_BEFORE_BREAK; before that he just pauses briefly and has another go. Pauses still
 * count towards the shift, so a villager who keeps finding nothing to do earns his break in the
 * end rather than pacing about for ever.
 */
function restFor(entity, brain, wanted, now) {
  const want = wanted || CFG.IDLE_TIME;
  brain.shiftStart ??= now;
  brain.onBreak = now - brain.shiftStart >= CFG.WORK_BEFORE_BREAK;
  if (brain.onBreak) {
    debugLog(entity, `has been working for ${Math.round((now - brain.shiftStart) / 20)}s - taking a break`);
    return want;
  }
  return Math.max(CFG.SHORT_PAUSE, Math.round(want / 2));
}

/** Movement modes map to entity events that swap AI component groups. */
export function setMode(entity, brain, mode) {
  if (brain.mode === mode) return;
  brain.mode = mode;
  try {
    entity.triggerEvent(`iv:mode_${mode}`);
  } catch {}
}

export function setWorking(entity, on) {
  try {
    if (entity.getProperty(PROP_WORKING) !== on) entity.setProperty(PROP_WORKING, on);
  } catch {}
}

/**
 * Makes a villager stand still for a while (e.g. while another villager trades with him).
 * He picks up exactly where he left off afterwards.
 */
export function freeze(entity, ticks) {
  const brain = getBrain(entity);
  brain.frozenUntil = system.currentTick + ticks;
}

/** Think again in `ticks` ticks (the main loop runs every CFG.TICK_INTERVAL). */
export function sleep(brain, ticks) {
  brain.wake = system.currentTick + ticks;
}
