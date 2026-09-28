// Two (or three) miners sharing one mine: node tools/sim/mine.mjs [ticks] [miners] [logRegex] [maxLines]
import { cpSync, rmSync } from "node:fs";
import { S, world, ItemStack } from "@minecraft/server";
const here = new URL(".", import.meta.url).pathname;
rmSync(here + "scripts", { recursive: true, force: true });
cpSync(here + "../../IndependentVillagers_BP/scripts", here + "scripts", { recursive: true });
const TICKS = Number(process.argv[2] ?? 60000);
const N = Number(process.argv[3] ?? 2);
const warns = [];
console.warn = (m) => warns.push(String(m));
await import("./scripts/main.js");
const { setDebug } = await import("./scripts/debug.js");
const { allBrains } = await import("./scripts/brain.js");
setDebug(true);
const dim = world.getDimension("minecraft:overworld");
const set = (x, y, z, id) => dim._set(x, y, z, id);
const never = { start: 23990, len: 1 };
if (process.env.OLDMINE) {
  // a mine from before v1.10: a 3x4 staircase down 12 from -4 64 0 heading +x, 20 slices dug
  const segs = [{ ox: -4, oy: 64, oz: 0, dx: 1, dz: 0, len: 32, descend: true, i: 20, seen: 0, done: false }];
  world.setDynamicProperty("iv:mines", JSON.stringify([{ id: "mold", d: "minecraft:overworld", x: -6, y: 64, z: 0, segs, bad: [], done: false }]));
  for (let i = 0; i < 20; i++) {
    const fy = 64 - Math.min(i, 12);
    for (let w = -1; w <= 1; w++) for (let h = 0; h < 4; h++) set(-4 + i, fy + h, w, "minecraft:air");
  }
}
const miners = [];
for (let n = 0; n < N; n++) {
  set(-6 + n * 8, 64, 0, "minecraft:stonecutter_block");
  const e = dim.spawnEntity("iv:villager", { x: -5.5 + n * 8, y: 64, z: 1.5 });
  const items = [[n === 0 ? "minecraft:iron_pickaxe" : "minecraft:stone_pickaxe", 1], ["minecraft:torch", 64], ["minecraft:coal", n === 1 ? 2 : 24], ["minecraft:oak_log", 16], ["minecraft:cobblestone", 32], ["minecraft:raw_iron", n === 0 ? 60 : 0]];
  for (const [id, k] of items) if (k) e._inv.addItem(new ItemStack(id, k));
  e.setDynamicProperty("iv:market", JSON.stringify(never));
  miners.push(e);
}
set(0, 64, 6, "minecraft:crafting_table");
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
const states = new Map();
const minY = new Map();
for (S.tick = 1; S.tick <= TICKS; S.tick++) {
  for (const iv of S.intervals) if (S.tick % iv.n === 0) iv.fn();
  const due = S.timeouts.filter((t) => t.at <= S.tick); S.timeouts = S.timeouts.filter((t) => t.at > S.tick); for (const t of due) t.fn();
  walk();
  miners.forEach((e, n) => {
    const st = allBrains().get(e.id)?.state;
    if (states.get(n)?.at(-1) !== st) states.set(n, [...(states.get(n) ?? []), st]);
    minY.set(n, Math.min(minY.get(n) ?? 999, e.location.y));
  });
  if (S.tick === Math.floor(TICKS / 2)) {
    // a creeper takes out a stretch of the staircase floor
    const ids = JSON.parse(world.getDynamicProperty("iv:mines") ?? "[]");
    const m = ids.length && JSON.parse(world.getDynamicProperty(`iv:mine_${ids[0]}`));
    if (m) {
      const s = m.segs[0];
      for (const i of [3, 4]) for (const w of [-1, 0, 1]) { const y = s.oy - i - 1; set(s.ox + s.dx * i - s.dz * w, y, s.oz + s.dz * i + s.dx * w, "minecraft:air"); set(s.ox + s.dx * i - s.dz * w, y - 1, s.oz + s.dz * i + s.dx * w, "minecraft:air"); }
      console.log(`(tick ${S.tick}: blew a hole in the stairs at slices 3-4 of the first leg)`);
    }
  }
}
const inv = (e) => { const m = new Map(); for (const s of e._inv.slots) if (s) m.set(s.typeId.replace("minecraft:", ""), (m.get(s.typeId.replace("minecraft:", "")) ?? 0) + s.amount); return [...m].map(([k, v]) => `${v} ${k}`).join(", "); };
const errs = warns.filter((w) => !w.startsWith("[IV]"));
console.log(`=== ${N} miners, ${TICKS} ticks; ${errs.length} non-debug warnings`);
for (const e of errs.slice(0, 10)) console.log("WARN", e.slice(0, 800));
miners.forEach((e, n) => {
  console.log(`MINER${n}: state=${allBrains().get(e.id)?.state} at ${e.location.x.toFixed(1)},${e.location.y},${e.location.z.toFixed(1)} (deepest y ${minY.get(n)}) | ${inv(e)}`);
  console.log(`   states: ${(states.get(n) ?? []).join(" > ").slice(0, 700)}`);
});
const ids = JSON.parse(world.getDynamicProperty("iv:mines") ?? "[]");
for (const id of ids) {
  const m = JSON.parse(world.getDynamicProperty(`iv:mine_${id}`));
  console.log(`mine ${id}: levels ${m.levels.map((l) => `${l.n}@${l.y}${l.hub !== undefined ? "*" : ""}`).join(" ")} bottom=${m.bottom} done=${m.done}; ${m.segs.length} segments:`);
  const byKind = {};
  for (const s of m.segs) { const k = `${s.k}${s.lvl ? "/" + s.lvl : ""}`; byKind[k] ??= { n: 0, done: 0, slices: 0, empty: 0 }; byKind[k].n++; if (s.done) byKind[k].done++; if (s.done && s.len === 0) byKind[k].empty++; byKind[k].slices += s.done ? s.len : s.i; }
  for (const [k, v] of Object.entries(byKind)) console.log(`   ${k}: ${v.n} (${v.done} done, ${v.empty} unusable slots), ${v.slices} slices dug`);
  console.log(`   stairs: ${m.segs.filter((s) => s.k === "stair").map((s) => `[${s.ox},${s.oy},${s.oz} d${s.dx},${s.dz} ${s.done ? s.len : s.i + "/" + s.len}]`).join(" ")}`);
}
const chests = [...dim._containers].map(([k, c]) => `${k}: ${c.slots.filter(Boolean).map((s) => s.amount + " " + s.typeId.replace("minecraft:", "")).join(", ")}`);
console.log(`containers:\n  ${chests.join("\n  ")}`);
const logs = warns.filter((w) => w.startsWith("[IV]"));
const filt = process.argv[4] ? new RegExp(process.argv[4]) : /level|mine|tunnel|patched|blocking|stack|stash|can't|leaving/;
const shown = logs.filter((l) => filt.test(l) && !/nav:/.test(l));
const dedup = []; for (const l of shown) if (dedup.at(-1)?.l !== l) dedup.push({ l, n: 1 }); else dedup.at(-1).n++;
console.log(`--- ${shown.length} log lines`);
for (const d of dedup.slice(0, Number(process.argv[5] ?? 80))) console.log(d.l + (d.n > 1 ? ` (x${d.n})` : ""));
if (process.env.DUMP) {
  for (const e of miners) {
    const f = { x: Math.floor(e.location.x), y: Math.floor(e.location.y), z: Math.floor(e.location.z) };
    console.log(`around ${f.x} ${f.y} ${f.z} (layers y-1..y+2, x across, z down):`);
    for (let dy = -1; dy <= 2; dy++) {
      console.log(` y=${f.y + dy}`);
      for (let dz = -3; dz <= 3; dz++) {
        let row = "";
        for (let dx = -3; dx <= 3; dx++) { const id = dim._get(f.x + dx, f.y + dy, f.z + dz).replace("minecraft:", ""); row += (dx === 0 && dz === 0 ? "*" : " ") + (id === "air" ? "." : id === "torch" ? "t" : id[0]); }
        console.log("   " + row);
      }
    }
    const b = allBrains().get(e.id);
    console.log("brain", JSON.stringify({ state: b.state, walk: b.walk && { key: b.walk.key, fails: b.walk.fails, bad: [...b.walk.bad] }, route: b.route && { k: b.route.k, stops: b.route.stops.map((s) => s.p), fails: b.route.fails } }));
  }
}
