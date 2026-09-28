// Precise walking.
//  1. pathfind.js plans a real route (A*) over walkable blocks, a slice per tick
//  2. we place an invisible, non-solid marker block (iv:nav_N) a few steps ahead on that route and
//     switch on the entity's move_to_block goal for that marker - the vanilla navigator walks the hop
//  3. when he reaches the marker we move it further along the route, until the goal
// Each walking villager uses its own marker slot so two villagers don't chase each other's markers.
import { system, world } from "@minecraft/server";
import { CFG, DP_NAV } from "./config.js";
import { setMode } from "./brain.js";
import { debugLog } from "./debug.js";
import { PathSearch, takeBudget } from "./pathfind.js";
import { center, dist, findStandableNear, floorPos, getBlock, horizDist, isPassable, isStandable, offset, playSound, samePos } from "./util.js";

const slotOwners = new Map(); // slot -> villager id

// ---------------------------------------------------------------- where everybody is
// The main loop tells us where every villager is (every couple of ticks), so routes can go round
// other villagers and walkers can step aside for each other.
const crowd = new Map(); // dimId -> [{id, x, y, z}]

export function noteVillagers(dimId, villagers) {
  const list = [];
  for (const v of villagers) {
    try {
      const l = v.location;
      list.push({ id: v.id, x: l.x, y: l.y, z: l.z });
    } catch {}
  }
  crowd.set(dimId, list);
}

/** The spots (feet blocks) other villagers near `loc` are standing on, as "x,y,z" keys. */
function othersAround(dimId, selfId, loc, r = 24) {
  const out = new Set();
  for (const o of crowd.get(dimId) ?? []) {
    if (o.id === selfId || Math.abs(o.x - loc.x) > r || Math.abs(o.z - loc.z) > r) continue;
    out.add(`${Math.floor(o.x)},${Math.floor(o.y)},${Math.floor(o.z)}`);
  }
  return out;
}
const activeMarkers = new Map(); // villager id -> {dimId, pos, slot}

// ---------------------------------------------------------------- manual walking
// Fallback when the vanilla walking goal won't take a hop: steer the villager ourselves every
// tick along the planned route, jumping up steps like a player holding forward + jump.
const manualWalkers = new Map(); // villager id -> {villager, nav}

system.runInterval(() => {
  for (const [id, w] of manualWalkers) {
    const { villager, nav } = w;
    try {
      if (!villager.isValid || !nav.manual || !nav.path) {
        manualWalkers.delete(id);
        continue;
      }
      steer(villager, nav);
    } catch {
      manualWalkers.delete(id);
    }
  }
}, 1);

function steer(villager, nav) {
  const loc = villager.location;
  // first route node we haven't stepped on yet
  let i = nav.idx;
  while (i < nav.path.length - 1 && horizDist(loc, center(nav.path[i])) < 0.45 && Math.abs(loc.y - nav.path[i].y) < 0.6) i++;
  nav.idx = i;
  const node = nav.path[i];
  const dx = node.x + 0.5 - loc.x;
  const dz = node.z + 0.5 - loc.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.05) return;

  // a walk - he only runs when he's running from something (or a nitwit with news)
  const speed = nav.fast ? CFG.RUN_SPEED : CFG.WALK_SPEED;
  const v = villager.getVelocity();
  let ix = (dx / len) * Math.min(speed, len * 0.5) - v.x;
  let iz = (dz / len) * Math.min(speed, len * 0.5) - v.z;
  // step aside for anybody right in front of him instead of walking into them
  for (const o of crowd.get(villager.dimension.id) ?? []) {
    if (o.id === villager.id) continue;
    const ox = loc.x - o.x;
    const oz = loc.z - o.z;
    const d2 = ox * ox + oz * oz;
    if (d2 > 0.81 || d2 < 1e-4 || Math.abs(o.y - loc.y) > 1.5) continue;
    const d = Math.sqrt(d2);
    ix += (ox / d) * 0.04;
    iz += (oz / d) * 0.04;
  }
  // doors in the way get opened, like a player would (the vanilla goal isn't running right now)
  openDoorsAhead(villager, loc, dx / len, dz / len);
  // jump for a step up (stairs and slabs included), or when pushing against something without
  // moving (auto-jump)
  const blocked = Math.sqrt(v.x * v.x + v.z * v.z) < 0.03 && len > 0.4;
  if (blocked && system.currentTick % 20 === 0) {
    const f = { x: Math.floor(loc.x + (dx / len) * 0.7), y: Math.floor(loc.y), z: Math.floor(loc.z + (dz / len) * 0.7) };
    const at = (p) => getBlock(villager.dimension, p)?.typeId.replace("minecraft:", "") ?? "?";
    debugLog(villager, `steer: not moving at ${loc.x.toFixed(2)} ${loc.y.toFixed(2)} ${loc.z.toFixed(2)} towards ${node.x} ${node.y} ${node.z} - ahead feet=${at(f)} head=${at(offset(f, 0, 1, 0))}`);
  }
  // Hop up a step - one block, never more. The impulse brings his upward speed to a normal jump
  // (0.42) rather than adding to it, and there's a pause between hops: isOnGround stays true for a
  // tick after a jump, and two impulses back to back used to send him up two blocks.
  const now = system.currentTick;
  const wantsUp = node.y > loc.y + 0.6 || stepUpAhead(villager, loc, dx / len, dz / len);
  let jump = 0;
  if (wantsUp && villager.isOnGround && v.y <= 0.01 && now - (nav.lastJump ?? -100) >= JUMP_GAP) {
    jump = 0.42 - Math.max(0, v.y);
    nav.lastJump = now;
  }
  villager.applyImpulse({ x: ix, y: jump, z: iz });
  // turn smoothly towards where he's going instead of snapping round
  const want = (Math.atan2(-dx, dz) * 180) / Math.PI;
  let yaw = nav.yaw ?? want;
  let diff = ((want - yaw + 540) % 360) - 180;
  yaw += Math.max(-30, Math.min(30, diff));
  nav.yaw = yaw;
  try {
    villager.setRotation({ x: 0, y: yaw });
  } catch {}
}

const JUMP_GAP = 10; // ticks between two hops

// ---------------------------------------------------------------- doors
// Villagers open the doors in their way and - now - shut them again behind them, like the vanilla
// ones do. Only doors we opened ourselves are ever closed: a door the player left open stays open.
const openedDoors = new Map(); // "dimId|x|y|z" -> {dimId, pos, by, at}

/** Opens a (wooden) door or gate right in front of him and remembers to close it again. */
function openDoorsAhead(villager, loc, nx, nz) {
  const dim = villager.dimension;
  for (const ahead of [0.6, 1.2]) {
    const p = { x: Math.floor(loc.x + nx * ahead), y: Math.floor(loc.y), z: Math.floor(loc.z + nz * ahead) };
    let b;
    try {
      b = dim.getBlock(p);
    } catch {
      return;
    }
    const id = b?.typeId ?? "";
    if (!DOORISH.test(id) || id.includes("iron")) continue;
    try {
      if (b.permutation.getState("open_bit") === true) continue;
      b.setPermutation(b.permutation.withState("open_bit", true));
      playSound(dim, id.includes("gate") ? "open.fence_gate" : "open.wooden_door", center(p));
      openedDoors.set(`${dim.id}|${p.x}|${p.y}|${p.z}`, { dimId: dim.id, pos: p, by: villager.id, at: system.currentTick });
    } catch {}
  }
}

const DOORISH = /(_door|fence_gate)$/;

/** Which way he's heading right now - for spotting the door in front of him. */
function headingTo(villager, target) {
  const loc = villager.location;
  const dx = target.x + 0.5 - loc.x;
  const dz = target.z + 0.5 - loc.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  return len < 0.05 ? undefined : { nx: dx / len, nz: dz / len };
}

// Shut the doors again once he's through and clear of them. A door with somebody still in the
// doorway stays open - nobody likes a door in the face.
system.runInterval(() => {
  const now = system.currentTick;
  for (const [key, d] of openedDoors) {
    if (now - d.at < CFG.DOOR_CLOSE) continue;
    let dim;
    let block;
    try {
      dim = world.getDimension(d.dimId);
      block = dim.getBlock(d.pos);
    } catch {
      continue; // chunk not loaded: leave it for later
    }
    if (!block || !DOORISH.test(block.typeId)) {
      openedDoors.delete(key);
      continue;
    }
    try {
      if (block.permutation.getState("open_bit") !== true) {
        openedDoors.delete(key);
        continue;
      }
      const c = center(d.pos);
      const near = dim.getEntities({ location: c, maxDistance: 1.9, excludeTypes: ["minecraft:item"] });
      if (near.length) continue; // somebody's in the doorway
      block.setPermutation(block.permutation.withState("open_bit", false));
      playSound(dim, block.typeId.includes("gate") ? "close.fence_gate" : "close.wooden_door", c);
      openedDoors.delete(key);
      debugLog(undefined, `door at ${d.pos.x} ${d.pos.y} ${d.pos.z} shut behind #${String(d.by).slice(-4)}`);
    } catch {
      openedDoors.delete(key);
    }
  }
}, 10);

// Blocks you step onto without jumping (they're less than half a block high). Farmland, paths
// and slabs are the ones villagers walk over all day - hopping over those looks daft.
const LOW_BLOCK = /_slab|stairs|farmland|dirt_path|grass_path|snow_layer|carpet|moss_bed/;

/** A block in front, high enough that he has to hop onto it (not a slab, path or farmland). */
function stepUpAhead(villager, loc, nx, nz) {
  try {
    const dim = villager.dimension;
    const at = { x: Math.floor(loc.x + nx * 0.7), y: Math.floor(loc.y), z: Math.floor(loc.z + nz * 0.7) };
    const b = dim.getBlock(at);
    if (!b || isPassable(b) || b.isLiquid || LOW_BLOCK.test(b.typeId)) return false;
    if (at.y + 1 - loc.y < 0.6) return false; // its top is level with his feet - just walk on
    const above = dim.getBlock({ ...at, y: at.y + 1 });
    return !!above && isPassable(above);
  } catch {
    return false;
  }
}

function setManual(villager, brain, on, quiet = false) {
  const nav = brain.nav;
  if (!nav) return;
  nav.manual = on;
  if (on) {
    manualWalkers.set(villager.id, { villager, nav });
    setMode(villager, brain, "work"); // switch the vanilla goal off so it doesn't fight us
    if (!quiet) debugLog(villager, "nav: taking manual steps");
  } else {
    manualWalkers.delete(villager.id);
  }
}

const markerId = (slot) => `iv:nav_${slot}`;

function acquireSlot(id) {
  for (const [slot, owner] of slotOwners) if (owner === id) return slot;
  for (let slot = 0; slot < CFG.NAV_SLOTS; slot++) {
    if (!slotOwners.has(slot)) {
      slotOwners.set(slot, id);
      return slot;
    }
  }
  return Math.floor(Math.random() * CFG.NAV_SLOTS); // all busy: share one
}

function releaseSlot(id) {
  for (const [slot, owner] of slotOwners) if (owner === id) slotOwners.delete(slot);
}

function removeMarker(dim, nav) {
  if (!nav.marker) return;
  const b = getBlock(dim, nav.marker);
  if (b?.typeId === markerId(nav.slot)) b.setType("minecraft:air");
  nav.marker = null;
}

function startSearch(villager, nav) {
  const dim = villager.dimension;
  let start = floorPos(villager.location);
  if (!isStandable(dim, start)) start = findStandableNear(dim, start, 1, 1) ?? start;
  nav.search = new PathSearch(dim, start, nav.goal, { avoid: othersAround(dim.id, villager.id, villager.location) });
  nav.path = null;
  nav.idx = 0;
  const budget = takeBudget(CFG.PATH_BUDGET);
  if (budget > 0) nav.search.step(budget);
}

/**
 * Start walking to `goal` (a standable feet position). Returns false if it's clearly unreachable.
 * `partial`: if there's no way all the way there, walk as close as he can get instead (the caller
 * sees "arrived" and decides what to do from there - walking, never teleporting).
 */
export function navTo(villager, brain, goal, { radius = 0.8, partial = false } = {}) {
  navStop(villager, brain);
  const now = system.currentTick;
  const nav = {
    goal,
    radius,
    partial,
    fast: !!brain.fast,
    slot: acquireSlot(villager.id),
    marker: null,
    waypoint: null,
    bestD: Infinity,
    lastProgress: now,
    stuck: 0,
    replans: 0,
  };
  brain.nav = nav;
  startSearch(villager, nav);
  if (nav.search.status === "failed" && !usePartial(villager, nav)) {
    debugLog(villager, `nav: no path to ${goal.x} ${goal.y} ${goal.z}`);
    navStop(villager, brain);
    return false;
  }
  if (nav.search.status === "found") return beginWalking(villager, brain);
  setMode(villager, brain, "work"); // stand still while thinking about the route
  return true;
}

/**
 * No route all the way: if he asked for it, head for the spot that got closest to the goal (if that
 * gets him meaningfully nearer). True if there's now a route to walk.
 */
function usePartial(villager, nav) {
  if (!nav.partial || !nav.search) return false;
  const path = nav.search.partial();
  const end = path[path.length - 1];
  const from = floorPos(villager.location);
  const gain = horizDist(from, nav.goal) - horizDist(end, nav.goal);
  if (path.length < 2 || gain < 2) return false;
  debugLog(villager, `nav: no way right up to ${nav.goal.x} ${nav.goal.y} ${nav.goal.z} - getting as close as he can (${end.x} ${end.y} ${end.z})`);
  nav.search.path = path;
  nav.search.status = "found";
  nav.goal = end;
  nav.partial = false; // one fallback per route
  return true;
}

function beginWalking(villager, brain) {
  const nav = brain.nav;
  nav.path = nav.search.path;
  nav.search = null;
  nav.lastProgress = system.currentTick;
  if (!placeNextMarker(villager, brain)) {
    navStop(villager, brain);
    return false;
  }
  // Short hops - a step to the next tunnel slice, the next row of crops - go much better if we
  // just walk him there ourselves: the vanilla goal is clumsy over a block or two (it would
  // amble, stall, and end up taking the long way round in a mineshaft).
  if (nav.path.length <= CFG.NAV_SHORT_NODES) setManual(villager, brain, true, true);
  return true;
}

function placeNextMarker(villager, brain) {
  const nav = brain.nav;
  const dim = villager.dimension;
  removeMarker(dim, nav);
  const loc = villager.location;

  let wp;
  if (nav.path) {
    // where are we on the route? (closest node a little ahead of the last known one)
    let best = nav.idx;
    let bestD = Infinity;
    for (let i = nav.idx; i < Math.min(nav.path.length, nav.idx + 16); i++) {
      const p = nav.path[i];
      const d = horizDist(loc, center(p)) + Math.abs(loc.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    nav.idx = best;
  }

  // The marker goes in the head space (so it never sits where a flower, a crop or a path block
  // would have to make way for it), or the feet space if the head space is taken. If neither is
  // free at the hop, use a nearer route node.
  const last = nav.path ? Math.min(nav.path.length - 1, nav.idx + CFG.NAV_STEP) : 0;
  for (let j = last; j >= (nav.path ? nav.idx : 0) && !nav.marker; j--) {
    const node = nav.path ? nav.path[j] : nav.goal;
    for (const p of [offset(node, 0, 1, 0), node]) {
      const b = getBlock(dim, p);
      if (b?.isAir) {
        b.setType(markerId(nav.slot));
        nav.marker = p;
        wp = node;
        break;
      }
    }
  }
  if (!nav.marker) return false;

  nav.waypoint = wp;
  nav.bestD = Infinity; // progress is measured toward the current hop
  nav.lastProgress = system.currentTick;
  activeMarkers.set(villager.id, { dimId: dim.id, pos: nav.marker, slot: nav.slot });
  try {
    villager.setDynamicProperty(DP_NAV, JSON.stringify({ d: dim.id, ...nav.marker, slot: nav.slot }));
  } catch {}
  brain.mode = null; // force the event so the goal re-targets
  setMode(villager, brain, `nav_${nav.slot}`);
  return true;
}

/** @returns {"moving"|"arrived"|"failed"} */
export function navUpdate(villager, brain, now) {
  const nav = brain.nav;
  if (!nav) return "failed";

  // still planning the route (sharing the village's search budget: if it's used up this tick,
  // he waits for the next)
  if (nav.search) {
    const budget = takeBudget(CFG.PATH_BUDGET);
    if (budget <= 0 && nav.search.status === "running") return "moving";
    const s = nav.search.step(budget);
    if (s === "running") return "moving";
    if (s === "failed" && !usePartial(villager, nav)) {
      debugLog(villager, `nav: no path to ${nav.goal.x} ${nav.goal.y} ${nav.goal.z} (searched ${nav.search.expanded} spots)`);
      navStop(villager, brain);
      return "failed";
    }
    if (!beginWalking(villager, brain)) return "failed";
    return "moving";
  }

  const dim = villager.dimension;
  const loc = villager.location;
  const goal = nav.goal;
  const gc = center(goal);
  const hGoal = horizDist(loc, gc);
  const dy = Math.abs(loc.y - goal.y);

  if (hGoal <= nav.radius && dy < 0.8) {
    navStop(villager, brain);
    return "arrived";
  }

  // a door between him and the next hop gets opened (the vanilla goal is walking him there, but it
  // won't always bother) - and closed again behind him a moment later
  if (!nav.manual) {
    const h = headingTo(villager, nav.waypoint ?? goal);
    if (h) openDoorsAhead(villager, loc, h.nx, h.nz);
  }

  // Reached the current hop (really on it - not just below it at the foot of a step) -> next one
  if (nav.waypoint && !samePos(nav.waypoint, goal)) {
    if (horizDist(loc, center(nav.waypoint)) <= 1.3 && Math.abs(loc.y - nav.waypoint.y) < 0.6) {
      if (nav.manual) setManual(villager, brain, false); // back to normal walking for the next hop
      if (!placeNextMarker(villager, brain)) {
        navStop(villager, brain);
        return "failed";
      }
    }
  }

  // Marker got replaced (someone built there) -> put it back
  if (nav.marker) {
    const mb = getBlock(dim, nav.marker);
    if (mb && mb.typeId !== markerId(nav.slot) && !placeNextMarker(villager, brain)) {
      navStop(villager, brain);
      return "failed";
    }
  }

  const wc = center(nav.waypoint ?? goal);
  const d = dist(loc, wc);

  // pressed up against a step and not getting up it: a hop, straight away (instead of standing
  // there until the stuck check gives up on the vanilla walking a few seconds later)
  if (!nav.manual && nav.path) stepNudge(villager, nav, now, loc);

  // Two ways of noticing he's getting nowhere: no closer to the next hop, or (the one that used to
  // leave a villager jittering against a tree for minutes on end) barely moving at all.
  let why;
  if (d < nav.bestD - 0.3) {
    nav.bestD = d;
    nav.lastProgress = now;
  } else if (now - nav.lastProgress > CFG.NAV_STUCK_TICKS) {
    nav.lastProgress = now;
    why = `${d.toFixed(1)} blocks from next hop, ${hGoal.toFixed(1)} from goal`;
  }
  if (!nav.lastPos || dist(loc, nav.lastPos) > 0.8) {
    nav.lastPos = { x: loc.x, y: loc.y, z: loc.z };
    nav.lastMoved = now;
  } else if (!why && now - (nav.lastMoved ?? now) > CFG.NAV_STILL_TICKS) {
    nav.lastMoved = now;
    nav.lastProgress = now;
    why = `hasn't moved in ${Math.round(CFG.NAV_STILL_TICKS / 20)}s, ${hGoal.toFixed(1)} from goal`;
  }

  if (why) {
    nav.stuck++;
    if (hGoal <= 1.6 && dy < 1.5) {
      navStop(villager, brain);
      return "arrived"; // close enough
    }
    debugLog(villager, `nav: stuck (${nav.stuck}/${CFG.NAV_MAX_STUCK}) ${why}`);
    if (nav.stuck >= CFG.NAV_MAX_STUCK) {
      navStop(villager, brain);
      return "failed";
    }
    if (nav.stuck === 1 && nav.path) {
      setManual(villager, brain, true); // walk this hop ourselves
    } else {
      // still stuck: re-plan the route from where we are now
      setManual(villager, brain, false);
      removeMarker(dim, nav);
      startSearch(villager, nav);
      if (nav.search.status === "failed" && !usePartial(villager, nav)) {
        navStop(villager, brain);
        return "failed";
      }
      if (nav.search.status === "found" && !beginWalking(villager, brain)) return "failed";
    }
  }
  return "moving";
}

function stepNudge(villager, nav, now, loc) {
  const moved = !nav.nudgePos || horizDist(loc, nav.nudgePos) > 0.15;
  if (moved) {
    nav.nudgePos = { x: loc.x, y: loc.y, z: loc.z };
    nav.nudgeAt = now;
    return;
  }
  if (now - nav.nudgeAt < 8 || now - (nav.lastJump ?? -100) < JUMP_GAP) return;
  const next = nav.path[Math.min(nav.path.length - 1, nav.idx + 1)];
  const h = headingTo(villager, next);
  if (!h) return;
  if (!(next.y > loc.y + 0.4 || stepUpAhead(villager, loc, h.nx, h.nz))) return;
  try {
    if (!villager.isOnGround) return;
    villager.applyImpulse({ x: h.nx * 0.1, y: 0.42, z: h.nz * 0.1 });
    nav.lastJump = now;
    nav.nudgeAt = now;
  } catch {}
}

export function navStop(villager, brain) {
  const nav = brain.nav;
  if (!nav) return;
  nav.manual = false;
  manualWalkers.delete(villager.id);
  removeMarker(villager.dimension, nav);
  releaseSlot(villager.id);
  activeMarkers.delete(villager.id);
  brain.nav = null;
  try {
    villager.setDynamicProperty(DP_NAV, undefined);
  } catch {}
}

/** After a reload: remove a marker this villager left behind. */
export function cleanupStaleMarker(villager) {
  const raw = villager.getDynamicProperty(DP_NAV);
  if (typeof raw !== "string") return;
  try {
    const m = JSON.parse(raw);
    const b = getBlock(villager.dimension, m);
    if (b?.typeId === markerId(m.slot)) b.setType("minecraft:air");
  } catch {}
  villager.setDynamicProperty(DP_NAV, undefined);
}

/** A villager died or vanished: free its slot and marker. */
export function navForget(id, world) {
  releaseSlot(id);
  const m = activeMarkers.get(id);
  activeMarkers.delete(id);
  if (!m) return;
  try {
    const b = world.getDimension(m.dimId).getBlock(m.pos);
    if (b?.typeId === markerId(m.slot)) b.setType("minecraft:air");
  } catch {}
}
