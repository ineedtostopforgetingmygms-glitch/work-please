// Offline smoke test: runs the real behavior-pack scripts against a tiny fake of @minecraft/server
// (node_modules/@minecraft/server) on a flat world. Not Minecraft - it only catches crashes and
// logic loops. Usage: node tools/sim/run.mjs [shore|well|wild|wild2|tools] [ticks] [logRegex] [maxLines]
import { cpSync, rmSync } from "node:fs";
import { S, world, ItemStack } from "@minecraft/server";
// the scripts import "@minecraft/server", so they must sit under this folder to find the fake
const here = new URL(".", import.meta.url).pathname;
rmSync(here + "scripts", { recursive: true, force: true });
cpSync(here + "../../IndependentVillagers_BP/scripts", here + "scripts", { recursive: true });
const scenario = process.argv[2] ?? "shore";
const TICKS = Number(process.argv[3] ?? 24000);
const warns = [];
const origWarn = console.warn;
console.warn = (m) => { warns.push(String(m)); };
await import("./scripts/main.js");
const { setDebug } = await import("./scripts/debug.js");
const { allBrains } = await import("./scripts/brain.js");
setDebug(true);
const cfg = await import("./scripts/config.js");
cfg.CARTO.TAX_EVERY = 9000; cfg.CARTO.COMPASS_EVERY = 6000;
const dim = world.getDimension("minecraft:overworld");
const set = (x, y, z, id) => dim._set(x, y, z, id);

// terrain
if (scenario === "shore" || scenario === "tools") {
  for (let x = 20; x <= 23; x++) for (let z = 20; z <= 23; z++) set(x, 63, z, "minecraft:water");
} else if (scenario === "wild2") {
  for (let x = 8; x <= 9; x++) for (let z = 8; z <= 9; z++) set(x, 63, z, "minecraft:water");
  set(-20, 63, 5, "minecraft:water"); set(-21, 64, 5, "minecraft:reeds"); set(-21, 65, 5, "minecraft:reeds"); set(-21, 66, 5, "minecraft:reeds");
  set(-19, 64, 5, "minecraft:reeds"); set(-19, 65, 5, "minecraft:reeds"); set(-20, 64, 6, "minecraft:reeds");
} else if (scenario === "wild") {
  for (let x = 20; x <= 23; x++) for (let z = 20; z <= 23; z++) set(x, 63, z, "minecraft:water");
  set(19, 64, 21, "minecraft:reeds"); set(19, 65, 21, "minecraft:reeds"); set(19, 66, 21, "minecraft:reeds");
  set(24, 64, 22, "minecraft:reeds"); set(24, 65, 22, "minecraft:reeds");
} else {
  // only a village well: water ringed with cobblestone, nothing to plant by
  for (let x = 29; x <= 33; x++) for (let z = 29; z <= 33; z++) set(x, 63, z, "minecraft:cobblestone");
  for (let x = 30; x <= 32; x++) for (let z = 30; z <= 32; z++) { set(x, 63, z, "minecraft:water"); set(x, 62, z, "minecraft:cobblestone"); }
  for (let x = 29; x <= 33; x++) for (let z = 29; z <= 33; z++) if ((x === 29 || x === 33) && (z === 29 || z === 33)) set(x, 64, z, "minecraft:cobblestone_wall"); // corner posts
}
set(0, 64, 0, "minecraft:cartography_table");
set(6, 64, 0, "minecraft:blast_furnace");
set(-6, 64, 0, "minecraft:stonecutter_block");
set(0, 64, -6, "iv:woodcutter_bench");

const V = (x, z, items, hours) => {
  const e = dim.spawnEntity("iv:villager", { x, y: 64, z });
  for (const [id, n] of items) { let left = n; while (left > 0) { const k = Math.min(64, left); e._inv.addItem(new ItemStack(id, k)); left -= k; } }
  if (hours) e.setDynamicProperty("iv:market", JSON.stringify(hours));
  return e;
};
const always = { start: 0, len: 24000 }, never = { start: 23990, len: 1 };
const carto = V(1.5, 1.5, [], never);
const armorer = V(6.5, 1.5, [], never);
const miner = V(-5.5, 1.5, [["minecraft:stone_pickaxe", 1], ["minecraft:raw_iron", 30], ["minecraft:raw_gold", 6], ["minecraft:coal", 12], ["minecraft:redstone", 6], ["minecraft:diamond", 6], ["minecraft:cobblestone", 40], ["minecraft:torch", 16]], always);
const jack = V(1.5, -5.5, [["minecraft:stone_axe", 1], ["minecraft:oak_log", 64], ["minecraft:emerald", scenario === "tools" ? 100 : 64]], scenario === "tools" ? never : always);
const farmerLike = V(10.5, -10.5, [["minecraft:emerald", 200]], never); // a rich jobless villager - a taxpayer
const trader = dim.spawnEntity("minecraft:wandering_trader", { x: 12.5, y: 64, z: 12.5 });
const names = new Map([[carto.id, "CARTO"], [armorer.id, "ARMOR"], [miner.id, "MINER"], [jack.id, "JACK"], [farmerLike.id, "RICH"]]);

// fake "walking": step along the route toward the next hop
function walk() {
  for (const [id, b] of allBrains()) {
    const e = S.entities.get(id);
    if (!e || !b.nav || b.nav.search || b.frozenUntil > S.tick) continue;
    const t = b.nav.waypoint ?? b.nav.goal;
    const dx = t.x + 0.5 - e.location.x, dz = t.z + 0.5 - e.location.z, d = Math.hypot(dx, dz);
    const step = Math.min(0.25, d);
    if (d > 0.01) e.location = { x: e.location.x + (dx / d) * step, y: t.y, z: e.location.z + (dz / d) * step };
    else e.location = { ...e.location, y: t.y };
  }
}
// furnaces: one item per 200 ticks (100 in a blast furnace), fuel permitting
const SMELT = { "minecraft:raw_iron": "minecraft:iron_ingot", "minecraft:raw_gold": "minecraft:gold_ingot", "minecraft:oak_log": "minecraft:charcoal" };
const burn = new Map();
function furnaces() {
  for (const [k, c] of dim._containers) {
    const id = dim._get(...k.split(",").map(Number));
    if (!/furnace/.test(id)) continue;
    const per = /blast/.test(id) ? 100 : 200;
    const inp = c.slots[0], fuel = c.slots[1];
    if (!inp || !SMELT[inp.typeId] || (/blast/.test(id) && /log/.test(inp.typeId))) continue;
    let b = burn.get(k) ?? { left: 0, t: 0 };
    if (b.left <= 0) { if (!fuel) continue; b.left = /coal/.test(fuel.typeId) ? 8 : /planks/.test(fuel.typeId) ? 1.5 : 1; fuel.amount--; if (!fuel.amount) c.slots[1] = undefined; }
    b.t++;
    if (b.t >= per) { b.t = 0; b.left--; inp.amount--; if (!inp.amount) c.slots[0] = undefined; const out = c.slots[2]; if (out) out.amount++; else c.slots[2] = new ItemStack(SMELT[inp.typeId], 1); }
    burn.set(k, b);
  }
}
// fast-growing cane
function grow() {
  for (const [k, id] of [...dim.blocks]) {
    if (id !== "minecraft:reeds") continue;
    const [x, y, z] = k.split(",").map(Number);
    if (dim._get(x, y - 1, z) === "minecraft:reeds") continue;
    let h = 1; while (dim._get(x, y + h, z) === "minecraft:reeds") h++;
    if (h < 3 && dim._get(x, y + h, z) === "minecraft:air") set(x, y + h, z, "minecraft:reeds");
  }
}
const states = new Map();
for (S.tick = 1; S.tick <= TICKS; S.tick++) {
  for (const iv of S.intervals) if (S.tick % iv.n === 0) iv.fn();
  const due = S.timeouts.filter((t) => t.at <= S.tick); S.timeouts = S.timeouts.filter((t) => t.at > S.tick); for (const t of due) t.fn();
  walk();
  furnaces();
  if (S.tick % 300 === 0) grow();
  for (const [id, n] of names) { const st = allBrains().get(id)?.state; if (states.get(n)?.at(-1) !== st) states.set(n, [...(states.get(n) ?? []), st]); }
}
const inv = (e) => { const m = new Map(); for (const s of e._inv.slots) if (s) m.set(s.typeId.replace("minecraft:", ""), (m.get(s.typeId.replace("minecraft:", "")) ?? 0) + s.amount); return [...m].map(([k, v]) => `${v} ${k}`).join(", "); };
const errs = warns.filter((w) => !w.startsWith("[IV]"));
console.log(`=== scenario ${scenario}, ${TICKS} ticks; ${errs.length} non-debug warnings`);
for (const e of errs.slice(0, 10)) console.log("WARN", e.slice(0, 600));
for (const [id, n] of names) { const e = S.entities.get(id); console.log(`${n}: prof=${e.getProperty("iv:profession")} state=${allBrains().get(id)?.state} at ${e.location.x.toFixed(1)},${e.location.y},${e.location.z.toFixed(1)} | ${inv(e)}`); console.log(`   states: ${(states.get(n) ?? []).join(" > ").slice(0, 900)}`); }
const logs = warns.filter((w) => w.startsWith("[IV]"));
const filt = process.argv[4] ? new RegExp(process.argv[4]) : /Cartographer|Armorer/;
const shown = logs.filter((l) => filt.test(l) && !/nav:/.test(l));
console.log(`--- ${shown.length} log lines`);
const dedup = []; for (const l of shown) if (dedup.at(-1)?.l !== l) dedup.push({ l, n: 1 }); else dedup.at(-1).n++;
for (const d of dedup.slice(0, Number(process.argv[5] ?? 150))) console.log(d.l + (d.n > 1 ? ` (x${d.n})` : ""));
const reeds = [...dim.blocks].filter(([, id]) => id === "minecraft:reeds").length;
const chests = [...dim._containers].map(([k, c]) => `${k}: ${c.slots.filter(Boolean).map((s) => s.amount + " " + s.typeId.replace("minecraft:", "")).join(", ")}`);
console.log(`reeds blocks: ${reeds}; containers:\n  ${chests.join("\n  ")}`);
console.log("tables:", [...dim.blocks].filter(([, id]) => /crafting_table|furnace|chest/.test(id)).map(([k, id]) => `${id.replace("minecraft:", "")}@${k}`).join(" "));
const cb = allBrains().get(carto.id);
console.log("CARTO brain:", JSON.stringify({ state: cb.state, job: cb.job, since: cb.since, tick: S.tick, nav: cb.nav && { goal: cb.nav.goal, search: !!cb.nav.search, status: cb.nav.search?.status, path: cb.nav.path?.length }, waterScan: cb.waterScan, badWater: cb.badWater && [...cb.badWater] }, (k, v) => v instanceof Set ? [...v] : v));
console.log("patch:", carto.getDynamicProperty("iv:cane"));
console.log("hole:", [[0,63,2],[1,63,2],[0,63,3],[1,63,3]].map(p=>dim._get(...p)).join(","));
