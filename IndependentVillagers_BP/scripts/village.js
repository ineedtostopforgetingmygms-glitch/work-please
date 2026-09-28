// Village setup. Bedrock's village houses are built into the game (an add-on can't swap the
// village house pieces), so instead every village gets done up the first time we see it - when
// its vanilla villagers turn into ours:
//   - a Workshop: a new villager-style building near the bell with one of every job block in it
//     (woodcutter's bench, stonecutter, composter, cartography table, blast furnace, smoker), plus
//     crafting tables and chests, so every trade has somewhere to start
//   - houses with room to spare get a crafting table and a chest put in against a wall
// Each village is done once (remembered by its bell).
import { BlockPermutation, system, world } from "@minecraft/server";
import { CFG, VILLAGE } from "./config.js";
import { debugLog } from "./debug.js";
import { getBlock, isPassable, isSolidGround, ringOffsets } from "./util.js";

const DP_VILLAGES = "iv:villages"; // [{d, x, y, z}] bells of villages already done up
const BELL = "minecraft:bell";
const jobs = []; // work in progress, a slice per tick
const checkedNoBell = new Map(); // "dim|x|z" (rounded) -> tick: looked here, no bell

let villages;

function doneVillages() {
  if (!villages) {
    try {
      villages = JSON.parse(world.getDynamicProperty(DP_VILLAGES) ?? "[]");
    } catch {
      villages = [];
    }
  }
  return villages;
}

function remember(v) {
  const list = doneVillages();
  list.push(v);
  if (list.length > 400) list.shift();
  try {
    world.setDynamicProperty(DP_VILLAGES, JSON.stringify(list));
  } catch {}
}

/** For /scriptevent iv:village: do up the village round here now, done before or not. */
export function forceVillage(dim, loc) {
  const here = { d: dim.id, x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
  villages = doneVillages().filter((v) => !near(v, here, VILLAGE.RADIUS));
  jobs.push({ step: "bell", dim, at: here, key: "force", i: 0 });
}

const near = (a, b, r) => a.d === b.d && Math.abs(a.x - b.x) <= r && Math.abs(a.z - b.z) <= r;

/**
 * A vanilla villager just became one of ours here: if this is a village we haven't seen before,
 * find its bell and do it up (over the next few seconds).
 */
export function noteVillage(dim, loc) {
  if (!CFG.VILLAGE_SETUP) return;
  const here = { d: dim.id, x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
  if (doneVillages().some((v) => near(v, here, VILLAGE.RADIUS))) return;
  if (jobs.some((j) => near(j.at, here, VILLAGE.RADIUS))) return;
  const key = `${dim.id}|${Math.round(here.x / 32)}|${Math.round(here.z / 32)}`;
  if (system.currentTick - (checkedNoBell.get(key) ?? -1e9) < 20 * 60 * 10) return;
  jobs.push({ step: "bell", dim, at: here, key, i: 0 });
}

const BELL_LOOK = ringOffsets(0, VILLAGE.BELL_SEARCH, [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]);
const DOOR_LOOK = ringOffsets(0, VILLAGE.RADIUS, [0, 1, -1, 2, -2, 3, -3, 4, -4]);
const SITE_LOOK = ringOffsets(VILLAGE.HALL_MIN, VILLAGE.HALL_MAX, [0]);

system.runInterval(() => {
  const job = jobs[0];
  if (!job) return;
  try {
    STEPS[job.step](job);
  } catch (e) {
    console.warn(`[Independent Villagers] village setup: ${e}`);
    jobs.shift();
  }
}, 1);

const STEPS = {
  // 1. the bell: that's the middle of the village
  bell(job) {
    const end = Math.min(BELL_LOOK.length, job.i + 3000);
    for (; job.i < end; job.i++) {
      const o = BELL_LOOK[job.i];
      const p = { x: job.at.x + o.x, y: job.at.y + o.y, z: job.at.z + o.z };
      if (getBlock(job.dim, p)?.typeId !== BELL) continue;
      const v = { d: job.dim.id, x: p.x, y: p.y, z: p.z };
      if (doneVillages().some((d) => near(d, v, VILLAGE.RADIUS))) return jobs.shift();
      remember(v);
      job.bell = p;
      job.step = "doors";
      job.i = 0;
      job.houses = 0;
      job.doorsSeen = [];
      debugLog(undefined, `a new village round the bell at ${p.x} ${p.y} ${p.z} - doing it up`);
      return;
    }
    if (job.i >= BELL_LOOK.length) {
      checkedNoBell.set(job.key, system.currentTick);
      jobs.shift();
    }
  },

  // 2. the houses: a crafting table and a chest in each one with room for them
  doors(job) {
    const end = Math.min(DOOR_LOOK.length, job.i + 1500);
    for (; job.i < end; job.i++) {
      const o = DOOR_LOOK[job.i];
      const p = { x: job.bell.x + o.x, y: job.bell.y + o.y, z: job.bell.z + o.z };
      const b = getBlock(job.dim, p);
      if (!b || !/_door$/.test(b.typeId) || /iron/.test(b.typeId)) continue;
      if (getBlock(job.dim, { x: p.x, y: p.y - 1, z: p.z })?.typeId === b.typeId) continue; // top half
      if (job.doorsSeen.some((q) => Math.abs(q.x - p.x) + Math.abs(q.z - p.z) <= 3 && Math.abs(q.y - p.y) <= 2)) continue; // the same house
      job.doorsSeen.push(p);
      if (furnishHouse(job.dim, p)) job.houses++;
      return; // one house a tick
    }
    if (job.i >= DOOR_LOOK.length) {
      job.step = "site";
      job.i = 0;
    }
  },

  // 3. somewhere flat and clear near the bell for the Workshop
  site(job) {
    const end = Math.min(SITE_LOOK.length, job.i + 4);
    for (; job.i < end; job.i++) {
      const o = SITE_LOOK[job.i];
      const plan = planHall(job.dim, { x: job.bell.x + o.x, z: job.bell.z + o.z }, job.bell);
      if (!plan) continue;
      job.plan = plan;
      job.step = "build";
      job.i = 0;
      return;
    }
    if (job.i >= SITE_LOOK.length) {
      debugLog(undefined, `village at ${job.bell.x} ${job.bell.y} ${job.bell.z}: furnished ${job.houses} house(s), no room for a Workshop`);
      jobs.shift();
    }
  },

  // 4. up it goes, a few blocks a tick
  build(job) {
    const blocks = (job.blocks ??= hallBlocks(job.plan));
    const end = Math.min(blocks.length, job.i + 24);
    for (; job.i < end; job.i++) {
      const [p, what] = blocks[job.i];
      const b = getBlock(job.dim, p);
      if (!b) continue;
      try {
        if (typeof what === "string") b.setType(what);
        else b.setPermutation(what());
      } catch {
        try {
          if (typeof what !== "string") b.setType(what.fallback ?? "minecraft:air");
        } catch {}
      }
    }
    if (job.i >= blocks.length) {
      const c = job.plan.origin;
      console.warn(`[Independent Villagers] village at ${job.bell.x} ${job.bell.y} ${job.bell.z}: built a Workshop at ${c.x} ${c.y} ${c.z} and furnished ${job.houses} house(s)`);
      jobs.shift();
    }
  },
};

// ---------------------------------------------------------------- houses

const roofed = (dim, p) => {
  for (let h = 2; h <= 6; h++) {
    const b = getBlock(dim, { x: p.x, y: p.y + h, z: p.z });
    if (!b) return false;
    if (!isPassable(b) && !b.isLiquid) return true;
  }
  return false;
};
const open = (dim, p) => {
  const f = getBlock(dim, p);
  const h = getBlock(dim, { x: p.x, y: p.y + 1, z: p.z });
  const g = getBlock(dim, { x: p.x, y: p.y - 1, z: p.z });
  return !!f && !!h && f.isAir && h.isAir && isSolidGround(g) && !/bed$|door|slab|stairs/.test(g.typeId);
};
const FURNITURE = /chest|crafting_table|furnace|smoker|barrel|composter|bench|stonecutter|table|lectern|loom|grindstone|anvil|brewing|cauldron|bell$/;

/**
 * Inside the house behind this door: a room with some space in it gets a crafting table and a
 * chest against a wall (never in the doorway, never on the way to a bed). True if it got anything.
 */
function furnishHouse(dim, door) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const inside = { x: door.x + dx, y: door.y, z: door.z + dz };
    if (!open(dim, inside) || !roofed(dim, inside)) continue;
    // the room: open, roofed floor reachable from just inside the door (a small flood)
    const room = [];
    const seen = new Set([`${inside.x},${inside.z}`]);
    const queue = [inside];
    while (queue.length && room.length < 60) {
      const p = queue.shift();
      room.push(p);
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = { x: p.x + ax, y: p.y, z: p.z + az };
        const k = `${q.x},${q.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (Math.abs(q.x - door.x) > 7 || Math.abs(q.z - door.z) > 7) continue;
        if (open(dim, q) && roofed(dim, q)) queue.push(q);
      }
    }
    if (room.length < VILLAGE.ROOM_MIN) return false; // no room to spare in here
    // it's got its own already? leave it be
    let hasTable = false;
    let hasChest = false;
    for (const p of room) {
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const id = getBlock(dim, { x: p.x + ax, y: p.y, z: p.z + az })?.typeId ?? "";
        if (id === "minecraft:crafting_table") hasTable = true;
        if (id === "minecraft:chest") hasChest = true;
      }
    }
    // spots against a wall, away from the door and not next to anything in the way
    const spots = room.filter((p) => {
      if (Math.abs(p.x - door.x) + Math.abs(p.z - door.z) <= 2) return false;
      let walls = 0;
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = getBlock(dim, { x: p.x + ax, y: p.y, z: p.z + az });
        if (!b) return false;
        if (/bed$|door/.test(b.typeId) || FURNITURE.test(b.typeId)) return false;
        if (!isPassable(b) && !b.isLiquid) walls++;
      }
      return walls === 1; // along a wall, not in a corner nook he'd need to get round
    });
    const put = [];
    if (!hasTable) put.push("minecraft:crafting_table");
    if (!hasChest) put.push("minecraft:chest");
    let placed = 0;
    const used = [];
    for (const id of put) {
      const spot = spots.find((s) => !used.some((u) => Math.abs(u.x - s.x) + Math.abs(u.z - s.z) <= 1));
      if (!spot) break;
      try {
        getBlock(dim, spot).setType(id);
        used.push(spot);
        placed++;
      } catch {}
    }
    return placed > 0;
  }
  return false;
}

// ---------------------------------------------------------------- the Workshop

// Its plan in local coordinates: u across (0..W-1), v front to back (0..D-1), the door in the
// middle of the front wall (v = 0), facing the bell. H is the wall height.
const W = 9;
const D = 7;
const H = 4;

/** A flat, clear spot for the Workshop around `c`, facing `bell`. */
function planHall(dim, c, bell) {
  // face the bell: the front wall on the side nearest it
  const dx = bell.x - c.x;
  const dz = bell.z - c.z;
  const face = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? [1, 0] : [-1, 0]) : dz > 0 ? [0, 1] : [0, -1];
  // local (u, v) -> world: v runs from the front (towards the bell) to the back
  const back = [-face[0], -face[1]];
  const across = [-back[1], back[0]];
  const origin = { x: c.x - across[0] * Math.floor(W / 2), z: c.z - across[1] * Math.floor(W / 2) };
  const at = (u, v) => ({ x: origin.x + across[0] * u + back[0] * v, z: origin.z + across[1] * u + back[1] * v });
  // ground heights: nearly flat, dry, nothing of the village's (or a tree) in the way
  const heights = [];
  for (let u = -1; u <= W; u++) {
    for (let v = -1; v <= D; v++) {
      const p = at(u, v);
      let top;
      try {
        top = dim.getTopmostBlock({ x: p.x, z: p.z });
      } catch {
        return undefined; // not loaded
      }
      if (!top) return undefined;
      while (top && (isPassable(top) || /leaves|snow_layer/.test(top.typeId)) && top.y > bell.y - 12) top = top.below();
      if (!top || top.isLiquid) return undefined;
      if (VILLAGE_BLOCKS.test(top.typeId)) return undefined;
      if (Math.abs(top.y - bell.y) > 6) return undefined;
      heights.push(top.y);
      // anything built or grown above the ground here (a tree trunk, a lamp post, a house)
      for (let h = 1; h <= H + 2; h++) {
        const a = getBlock(dim, { x: p.x, y: top.y + h, z: p.z });
        if (!a) return undefined;
        if (!(a.isAir || isPassable(a) || /leaves/.test(a.typeId)) || /_log$|_wood$/.test(a.typeId)) return undefined;
      }
    }
  }
  const lo = Math.min(...heights);
  const hi = Math.max(...heights);
  if (hi - lo > 2) return undefined;
  const floorY = hi + 1; // the floor sits on the highest ground (foundations fill in below)
  return { origin: { x: origin.x, y: floorY, z: origin.z }, across, back, lo, floorY, face };
}

const VILLAGE_BLOCKS = /dirt_path|grass_path|farmland|planks|cobblestone|_bed$|door|glass|log|wool|hay_block|bell|torch|lantern|fence|_slab|stairs|composter|chest|water/;

/** Everything to place, in order: foundations, floor, walls, roof, then the inside. */
function hallBlocks(plan) {
  const { origin, across, back, lo, floorY } = plan;
  const at = (u, v, y) => ({ x: origin.x + across[0] * u + back[0] * v, y, z: origin.z + across[1] * u + back[1] * v });
  const out = [];
  const wall = (u, v) => u === 0 || u === W - 1 || v === 0 || v === D - 1;
  const corner = (u, v) => (u === 0 || u === W - 1) && (v === 0 || v === D - 1);
  const doorU = Math.floor(W / 2);
  // clear the space (and a block round it) of grass, flowers, leaves...
  for (let u = -1; u <= W; u++) for (let v = -1; v <= D; v++) for (let y = floorY; y <= floorY + H + 1; y++) out.push([at(u, v, y), "minecraft:air"]);
  // foundations and floor
  for (let u = 0; u < W; u++) {
    for (let v = 0; v < D; v++) {
      for (let y = lo; y < floorY - 1; y++) out.push([at(u, v, y), "minecraft:cobblestone"]);
      out.push([at(u, v, floorY - 1), wall(u, v) ? "minecraft:cobblestone" : "minecraft:oak_planks"]);
    }
  }
  // walls: log corners, a cobblestone course, planks above, windows down the sides
  for (let u = 0; u < W; u++) {
    for (let v = 0; v < D; v++) {
      if (!wall(u, v)) continue;
      for (let h = 0; h < H; h++) {
        const y = floorY + h;
        let id = corner(u, v) ? "minecraft:oak_log" : h === 0 ? "minecraft:cobblestone" : "minecraft:oak_planks";
        const window = !corner(u, v) && (h === 1 || h === 2) && ((v === 0 || v === D - 1) ? u % 2 === 0 && u !== doorU : v % 2 === 1 && v !== 0 && v !== D - 1);
        if (window && !(v === 0 && Math.abs(u - doorU) <= 1)) id = "minecraft:glass_pane";
        if (v === 0 && u === doorU && h < 2) continue; // the doorway
        out.push([at(u, v, y), id]);
      }
    }
  }
  // roof: planks with a cobblestone rim, a log beam over the door
  for (let u = 0; u < W; u++) for (let v = 0; v < D; v++) out.push([at(u, v, floorY + H), wall(u, v) ? "minecraft:cobblestone" : "minecraft:oak_planks"]);
  // the door (turned to face out of the front)
  const doorDir = dirIndex(plan.face);
  out.push([at(doorU, 0, floorY), doorPerm(doorDir, false)]);
  out.push([at(doorU, 0, floorY + 1), doorPerm(doorDir, true)]);
  // inside: every job block along the back wall, crafting tables and chests down the sides
  const back1 = D - 2;
  const row = ["iv:woodcutter_bench", "minecraft:stonecutter_block", "minecraft:composter", "minecraft:crafting_table", "minecraft:cartography_table", "minecraft:blast_furnace", "minecraft:smoker"];
  row.forEach((id, i) => out.push([at(1 + i, back1, floorY), id]));
  out.push([at(1, 2, floorY), "minecraft:chest"]);
  out.push([at(W - 2, 2, floorY), "minecraft:chest"]);
  out.push([at(1, 3, floorY), "minecraft:crafting_table"]);
  out.push([at(W - 2, 3, floorY), "minecraft:barrel"]);
  // light: lanterns on the crafting tables
  out.push([at(1, 3, floorY + 1), lanternPerm()]);
  out.push([at(4, back1, floorY + 1), lanternPerm()]);
  // a lantern either side of the door, outside
  out.push([at(doorU - 1, -1, floorY), "minecraft:cobblestone_wall"]);
  out.push([at(doorU + 1, -1, floorY), "minecraft:cobblestone_wall"]);
  out.push([at(doorU - 1, -1, floorY + 1), lanternPerm()]);
  out.push([at(doorU + 1, -1, floorY + 1), lanternPerm()]);
  // a path to the door
  out.push([at(doorU, -1, floorY - 1), "minecraft:dirt_path"]);
  out.push([at(doorU, -2, floorY - 1), "minecraft:dirt_path"]);
  return out;
}

// door facing: 0 east, 1 south, 2 west, 3 north (the "direction" state); the front faces `face`
function dirIndex(face) {
  if (face[0] === 1) return 0;
  if (face[1] === 1) return 1;
  if (face[0] === -1) return 2;
  return 3;
}
const CARDINAL = ["east", "south", "west", "north"];

function doorPerm(dir, upper) {
  const make = () => {
    for (const states of [
      { "minecraft:cardinal_direction": CARDINAL[dir], upper_block_bit: upper },
      { direction: dir, upper_block_bit: upper },
    ]) {
      try {
        return BlockPermutation.resolve("minecraft:wooden_door", states);
      } catch {}
    }
    return BlockPermutation.resolve("minecraft:air");
  };
  make.fallback = "minecraft:air";
  return make;
}

function lanternPerm() {
  const make = () => {
    try {
      return BlockPermutation.resolve("minecraft:lantern", { hanging: false });
    } catch {
      return BlockPermutation.resolve("minecraft:lantern");
    }
  };
  make.fallback = "minecraft:torch";
  return make;
}
