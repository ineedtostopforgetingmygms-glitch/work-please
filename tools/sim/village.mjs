// Butcher, nitwit + golem, running from a zombie, the armorer's golem, zombie keeping a villager's
// things: node tools/sim/village.mjs [ticks] [logRegex] [maxLines]
import { cpSync, rmSync } from "node:fs";
import { S, world, ItemStack } from "@minecraft/server";
const here = new URL(".", import.meta.url).pathname;
rmSync(here + "scripts", { recursive: true, force: true });
cpSync(here + "../../IndependentVillagers_BP/scripts", here + "scripts", { recursive: true });
const TICKS = Number(process.argv[2] ?? 30000);
const warns = [];
console.warn = (m) => warns.push(String(m));
await import("./scripts/main.js");
const { setDebug } = await import("./scripts/debug.js");
const { allBrains } = await import("./scripts/brain.js");
const { zombify } = await import("./scripts/zombie.js");
const { xpOf } = await import("./scripts/xp.js");
setDebug(true);
const cfg = await import("./scripts/config.js");
cfg.GOLEM.EVERY = 2000;
cfg.GOLEM.PER = 2; // a small village that wants more golems
const dim = world.getDimension("minecraft:overworld");
const set = (x, y, z, id) => dim._set(x, y, z, id);
const never = { start: 23990, len: 1 };
const always = { start: 0, len: 24000 };
const V = (x, z, items, hours = never, prof) => {
  const e = dim.spawnEntity("iv:villager", { x, y: 64, z });
  for (const [id, n] of items) { let left = n; while (left > 0) { const k = Math.min(64, left); e._inv.addItem(new ItemStack(id, k)); left -= k; } }
  e.setDynamicProperty("iv:market", JSON.stringify(hours));
  if (prof) e.setProperty("iv:profession", prof);
  return e;
};
set(0, 64, 0, "minecraft:smoker");
set(-8, 64, 0, "iv:woodcutter_bench");
set(0, 64, -10, "minecraft:composter");
set(10, 64, -10, "minecraft:blast_furnace");
const butcher = V(1.5, 1.5, [["minecraft:coal", 8]]);
const jack = V(-7.5, 1.5, [["minecraft:stone_axe", 1], ["minecraft:oak_log", 64], ["minecraft:oak_log", 40]], always);
const farmer = V(1.5, -9.5, [["minecraft:stone_hoe", 1], ["minecraft:wheat", 40], ["minecraft:carrot", 30], ["minecraft:wheat_seeds", 30], ["minecraft:pumpkin", 3]], always);
const armorer = V(11.5, -9.5, [["minecraft:iron_ingot", 64], ["minecraft:iron_ingot", 64], ["minecraft:iron_block", 0], ["minecraft:coal", 10], ["minecraft:oak_log", 6]]);
const nitwit = V(-20.5, 20.5, [], never, 7);
const victim = V(30.5, 30.5, [["minecraft:emerald", 40], ["minecraft:bread", 5]]);
victim.nameTag = "Farmer";
// animals roaming about
const animals = [];
for (const [t, x, z] of [["minecraft:cow", 25, -5], ["minecraft:cow", 28, -2], ["minecraft:pig", -25, -10], ["minecraft:chicken", 15, 25], ["minecraft:sheep", -15, -25], ["minecraft:pig", -22, -14]]) animals.push(dim.spawnEntity(t, { x: x + 0.5, y: 64, z: z + 0.5 }));
const golem = dim.spawnEntity("minecraft:iron_golem", { x: -40.5, y: 64, z: 40.5 });
let zombie;
function walk() {
  for (const [id, b] of allBrains()) {
    const e = S.entities.get(id);
    if (!e || !b.nav || b.nav.search || b.frozenUntil > S.tick) continue;
    const t = b.nav.waypoint ?? b.nav.goal;
    const dx = t.x + 0.5 - e.location.x, dz = t.z + 0.5 - e.location.z, d = Math.hypot(dx, dz);
    const step = Math.min(b.fast ? 0.4 : 0.25, d);
    if (d > 0.01) e.location = { x: e.location.x + (dx / d) * step, y: t.y, z: e.location.z + (dz / d) * step };
    else e.location = { ...e.location, y: t.y };
  }
}
const SMELT = { "minecraft:beef": "minecraft:cooked_beef", "minecraft:porkchop": "minecraft:cooked_porkchop", "minecraft:chicken": "minecraft:cooked_chicken", "minecraft:mutton": "minecraft:cooked_mutton" };
function furnaces() {
  for (const [k, c] of dim._containers) {
    const id = dim._get(...k.split(",").map(Number));
    if (!/smoker/.test(id)) continue;
    const inp = c.slots[0], fuel = c.slots[1];
    if (!inp || !SMELT[inp.typeId] || (!fuel && !c._burn)) continue;
    if (!c._burn) { c._burn = 8; fuel.amount--; if (!fuel.amount) c.slots[1] = undefined; }
    c._t = (c._t ?? 0) + 1;
    if (c._t >= 100) { c._t = 0; c._burn--; inp.amount--; if (!inp.amount) c.slots[0] = undefined; const out = c.slots[2]; if (out) out.amount++; else c.slots[2] = new ItemStack(SMELT[inp.typeId], 1); }
  }
}
// butchered animals drop meat (the fake world has no loot tables)
const MEAT = { "minecraft:cow": ["minecraft:beef", "minecraft:leather"], "minecraft:pig": ["minecraft:porkchop"], "minecraft:chicken": ["minecraft:chicken", "minecraft:feather"], "minecraft:sheep": ["minecraft:mutton", "minecraft:white_wool"] };
const alive = new Set();
const states = new Map();
const names = new Map([[butcher.id, "BUTCHER"], [nitwit.id, "NITWIT"], [armorer.id, "ARMORER"], [victim.id, "VICTIM"], [farmer.id, "FARMER"]]);
for (S.tick = 1; S.tick <= TICKS; S.tick++) {
  for (const iv of S.intervals) if (S.tick % iv.n === 0) iv.fn();
  const due = S.timeouts.filter((t) => t.at <= S.tick); S.timeouts = S.timeouts.filter((t) => t.at > S.tick); for (const t of due) t.fn();
  walk();
  furnaces();
  for (const e of S.entities.values()) if (MEAT[e.typeId]) { alive.add(e); if (e._baby) { e._bornAt ??= S.tick; if (S.tick - e._bornAt > 3000) e._baby = false; } }
  for (const e of [...alive]) if (!e._valid) { alive.delete(e); for (const id of MEAT[e.typeId]) dim.spawnItem(new ItemStack(id, 2), e.location); }
  if (S.tick === 6000) {
    // a zombie turns up near the nitwit, then wanders into the village
    zombie = dim.spawnEntity("minecraft:zombie", { x: -2.5, y: 64, z: 22.5 });
    console.log(`(tick ${S.tick}: a zombie at -3 64 22)`);
  }
  if (zombie && S.tick > 6000 && S.tick < 9000 && S.tick % 40 === 0) zombie.location = { ...zombie.location, z: zombie.location.z - 0.5 };
  if (S.tick === 9000 && zombie) { zombie.remove(); zombie = null; }
  if (S.tick === 12000) {
    // the victim is killed by a zombie
    const z = dim.spawnEntity("minecraft:zombie", { x: 31.5, y: 64, z: 31.5 });
    for (let i = 0; i < 27; i++) { const it = victim._inv.slots[i]; if (it) dim.spawnItem(it, victim.location); }
    const ev = { deadEntity: victim, damageSource: { damagingEntity: z } };
    zombify(ev);
    victim.remove();
    z.remove();
  }
  if (process.env.XPLOG && S.tick % 500 === 0) console.log(S.tick, "butcher xp", xpOf(butcher), JSON.stringify(butcher._dp.get("iv:xp")));
  for (const [id, n] of names) { const st = allBrains().get(id)?.state; if (st && states.get(n)?.at(-1) !== st) states.set(n, [...(states.get(n) ?? []), st]); }
}
const inv = (e) => { const m = new Map(); for (const s of e._inv?.slots ?? []) if (s) m.set(s.typeId.replace("minecraft:", ""), (m.get(s.typeId.replace("minecraft:", "")) ?? 0) + s.amount); return [...m].map(([k, v]) => `${v} ${k}`).join(", "); };
const errs = warns.filter((w) => !w.startsWith("[IV]"));
console.log(`=== village, ${TICKS} ticks; ${errs.length} non-debug warnings`);
for (const e of errs.slice(0, 12)) console.log("WARN", e.slice(0, 700));
for (const [id, n] of names) { const e = S.entities.get(id); if (!e) { console.log(`${n}: gone`); continue; } console.log(`${n}: prof=${e.getProperty("iv:profession")} state=${allBrains().get(id)?.state} xp=${xpOf(e).toFixed(1)} at ${e.location.x.toFixed(1)},${e.location.y},${e.location.z.toFixed(1)} | ${inv(e)}`); console.log(`   states: ${(states.get(n) ?? []).join(" > ").slice(0, 600)}`); }
const kinds = {}; for (const e of S.entities.values()) if (MEAT[e.typeId] || /golem|zombie/.test(e.typeId)) { const k = e.typeId.replace("minecraft:", "") + (e._baby ? "(baby)" : ""); kinds[k] = (kinds[k] ?? 0) + 1; }
console.log("mobs:", JSON.stringify(kinds));
console.log("golem events:", JSON.stringify(golem._events ?? []));
const zv = [...S.entities.values()].filter((e) => /zombie_villager/.test(e.typeId));
for (const z of zv) console.log(`zombie villager "${z.nameTag}" holds: ${z.getDynamicProperty("iv:held")}`);
const fences = [...dim.blocks].filter(([, id]) => /fence/.test(id));
console.log(`fence blocks: ${fences.length} (${fences.filter(([, id]) => /gate/.test(id)).length} gate); pen: ${butcher.getDynamicProperty("iv:pen")}`);
console.log("placed:", [...dim.blocks].filter(([, id]) => /crafting_table|chest|iron_block|carved/.test(id)).map(([k, id]) => `${id.replace("minecraft:", "")}@${k}`).join(" "));
const chests = [...dim._containers].map(([k, c]) => `${k}: ${c.slots.filter(Boolean).map((s) => s.amount + " " + s.typeId.replace("minecraft:", "")).join(", ")}`);
console.log(`containers:\n  ${chests.join("\n  ")}`);
const logs = warns.filter((w) => w.startsWith("[IV]"));
const filt = process.argv[3] ? new RegExp(process.argv[3]) : /Butcher|Nitwit|golem|running|safe again|bottled|cured/;
const shown = logs.filter((l) => filt.test(l) && !/nav:/.test(l));
const dedup = []; for (const l of shown) if (dedup.at(-1)?.l !== l) dedup.push({ l, n: 1 }); else dedup.at(-1).n++;
console.log(`--- ${shown.length} log lines`);
for (const d of dedup.slice(0, Number(process.argv[4] ?? 120))) console.log(d.l + (d.n > 1 ? ` (x${d.n})` : ""));
