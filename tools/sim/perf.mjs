// A busy village of 20 villagers, counting how much they ask of the game:
//   node tools/sim/perf.mjs [ticks]            (SRC=<path to scripts> to measure another version)
import { cpSync, rmSync } from "node:fs";
import { S, world, ItemStack } from "@minecraft/server";
const here = new URL(".", import.meta.url).pathname;
rmSync(here + "scripts", { recursive: true, force: true });
cpSync(process.env.SRC ?? here + "../../IndependentVillagers_BP/scripts", here + "scripts", { recursive: true });
const TICKS = Number(process.argv[2] ?? 12000);
console.warn = () => {};
await import("./scripts/main.js");
const { allBrains } = await import("./scripts/brain.js");
const dim = world.getDimension("minecraft:overworld");
const set = (x, y, z, id) => dim._set(x, y, z, id);
S.time = 3000;
const V = (x, z, items, prof = 0) => {
  const e = dim.spawnEntity("iv:villager", { x, y: 64, z });
  for (const [id, n] of items) e._inv.addItem(new ItemStack(id, n));
  e.setDynamicProperty("iv:market", JSON.stringify({ start: 23990, len: 1 }));
  if (prof) e.setProperty("iv:profession", prof);
  return e;
};
// a field for the farmers
for (let x = 10; x <= 18; x++) for (let z = 10; z <= 18; z++) { set(x, 63, z, x === 14 && z === 14 ? "minecraft:water" : "minecraft:farmland"); if (x !== 14 || z !== 14) { set(x, 64, z, "minecraft:wheat"); dim._states.set(`${x},64,${z}`, { growth: 7 }); } }
for (let x = 20; x <= 23; x++) for (let z = -20; z <= -17; z++) set(x, 63, z, "minecraft:water");
const jobs = [["minecraft:stonecutter_block", -12, 0], ["minecraft:stonecutter_block", -12, 8], ["minecraft:composter", 8, 8], ["minecraft:composter", 20, 8], ["iv:woodcutter_bench", 0, -12], ["minecraft:cartography_table", 16, -14], ["minecraft:blast_furnace", 6, -6], ["minecraft:smoker", -6, 12]];
for (const [id, x, z] of jobs) set(x, 64, z, id);
const kit = [["minecraft:stone_pickaxe", 1], ["minecraft:torch", 32], ["minecraft:coal", 16], ["minecraft:oak_log", 16], ["minecraft:cobblestone", 32], ["minecraft:emerald", 40], ["minecraft:bread", 4], ["minecraft:wheat_seeds", 16], ["minecraft:stone_hoe", 1], ["minecraft:raw_iron", 12]];
for (let i = 0; i < 20; i++) V(-8 + (i % 5) * 4 + 0.5, -8 + Math.floor(i / 5) * 4 + 0.5, kit, i >= 17 ? 7 : 0);
for (const [t, x, z] of [["minecraft:cow", 25, -5], ["minecraft:cow", 28, -2], ["minecraft:pig", -25, -10], ["minecraft:pig", -22, -14]]) dim.spawnEntity(t, { x: x + 0.5, y: 64, z: z + 0.5 });
dim.spawnEntity("minecraft:iron_golem", { x: 0.5, y: 64, z: 20.5 });
function walk() {
  for (const [id, b] of allBrains()) {
    const e = S.entities.get(id);
    if (!e || !b.nav || b.nav.search || b.frozenUntil > S.tick) continue;
    const t = b.nav.waypoint ?? b.nav.goal;
    const dx = t.x + 0.5 - e.location.x, dz = t.z + 0.5 - e.location.z, d = Math.hypot(dx, dz);
    const step = Math.min(0.2, d);
    if (d > 0.01) e.location = { x: e.location.x + (dx / d) * step, y: t.y, z: e.location.z + (dz / d) * step };
  }
}
const warm = 3000;
let t0;
let c0;
for (S.tick = 1; S.tick <= TICKS; S.tick++) {
  if (S.tick === warm) { t0 = performance.now(); c0 = { ...S.calls }; if (process.env.PROFILE) S.profile = new Map(); }
  for (const iv of S.intervals) if (S.tick % iv.n === 0) iv.fn();
  const due = S.timeouts.filter((t) => t.at <= S.tick); S.timeouts = S.timeouts.filter((t) => t.at > S.tick); for (const t of due) t.fn();
  walk();
}
const n = TICKS - warm;
const per = (k) => ((S.calls[k] - c0[k]) / n).toFixed(1);
const jobsHeld = {};
for (const e of S.entities.values()) if (e.typeId === "iv:villager") { const p = e.getProperty("iv:profession"); jobsHeld[p] = (jobsHeld[p] ?? 0) + 1; }
console.log(`${[...S.entities.values()].filter((e) => e.typeId === "iv:villager").length} villagers (by job ${JSON.stringify(jobsHeld)}), ticks ${warm}-${TICKS}: ${((performance.now() - t0) / n).toFixed(3)} ms/tick of script time; per tick: getBlock ${per("getBlock")}, getTopmostBlock ${per("topmost")}, getEntities ${per("getEntities")}, entity events ${per("events")}`);
if (S.profile) for (const [k, v] of [...S.profile].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(v).padStart(6), k);
