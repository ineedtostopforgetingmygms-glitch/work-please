// Village setup (Workshop + furnished houses), babies, telling the golem on a player, running
// home: node tools/sim/village2.mjs [ticks] [logRegex] [maxLines]
import { cpSync, rmSync } from "node:fs";
import { S, world, ItemStack } from "@minecraft/server";
const here = new URL(".", import.meta.url).pathname;
rmSync(here + "scripts", { recursive: true, force: true });
cpSync(here + "../../IndependentVillagers_BP/scripts", here + "scripts", { recursive: true });
const TICKS = Number(process.argv[2] ?? 20000);
const warns = [];
console.warn = (m) => warns.push(String(m));
await import("./scripts/main.js");
const { setDebug } = await import("./scripts/debug.js");
const { allBrains, getBrain } = await import("./scripts/brain.js");
setDebug(true);
const dim = world.getDimension("minecraft:overworld");
const set = (x, y, z, id) => dim._set(x, y, z, id);
S.time = 3000; // daytime
// the bell, and a little house to the north: planks walls, a roof, a door facing south, two beds
set(0, 64, 0, "minecraft:bell");
for (let x = -3; x <= 3; x++) for (let z = -16; z <= -10; z++) for (let y = 64; y <= 67; y++) {
  const wall = x === -3 || x === 3 || z === -16 || z === -10;
  if (y === 67) set(x, y, z, "minecraft:oak_planks");
  else if (wall) set(x, y, z, "minecraft:oak_planks");
}
set(0, 64, -10, "minecraft:wooden_door"); set(0, 65, -10, "minecraft:wooden_door");
set(-2, 64, -15, "minecraft:bed"); dim._states.set("-2,64,-15", { head_piece_bit: true });
set(-1, 64, -15, "minecraft:bed");
set(2, 64, -15, "minecraft:bed"); dim._states.set("2,64,-15", { head_piece_bit: true });
set(2, 64, -14, "minecraft:bed");
set(-2, 64, -12, "minecraft:bed"); dim._states.set("-2,64,-12", { head_piece_bit: true });
set(-2, 64, -11, "minecraft:bed");
set(1, 64, -12, "minecraft:bed"); dim._states.set("1,64,-12", { head_piece_bit: true });
set(1, 64, -11, "minecraft:bed");
const V = (x, z, items, prof = 0) => {
  const e = dim.spawnEntity("iv:villager", { x, y: 64, z });
  for (const [id, n] of items) e._inv.addItem(new ItemStack(id, n));
  e.setDynamicProperty("iv:market", JSON.stringify({ start: 23990, len: 1 }));
  if (prof) e.setProperty("iv:profession", prof);
  return e;
};
const a = V(5.5, 5.5, [["minecraft:bread", 4]], 7);
const b = V(8.5, 5.5, [["minecraft:bread", 3], ["minecraft:cooked_beef", 1]], 7);
const hurt = V(-8.5, 8.5, [], 7);
const golem = dim.spawnEntity("minecraft:iron_golem", { x: -30.5, y: 64, z: 20.5 });
const player = dim.spawnEntity("minecraft:player", { x: -10.5, y: 64, z: 10.5 });
player.name = "Steve";
function walk() {
  for (const [id, br] of allBrains()) {
    const e = S.entities.get(id);
    if (!e || !br.nav || br.nav.search || br.frozenUntil > S.tick) continue;
    const t = br.nav.waypoint ?? br.nav.goal;
    const dx = t.x + 0.5 - e.location.x, dz = t.z + 0.5 - e.location.z, d = Math.hypot(dx, dz);
    const step = Math.min(br.fast ? 0.4 : 0.25, d);
    if (d > 0.01) e.location = { x: e.location.x + (dx / d) * step, y: t.y, z: e.location.z + (dz / d) * step };
  }
}
let zombie;
for (S.tick = 1; S.tick <= TICKS; S.tick++) {
  for (const iv of S.intervals) if (S.tick % iv.n === 0) iv.fn();
  const due = S.timeouts.filter((t) => t.at <= S.tick); S.timeouts = S.timeouts.filter((t) => t.at > S.tick); for (const t of due) t.fn();
  walk();
  if (S.tick === 3000) { getBrain(hurt).tattle = { player: player.id, name: "Steve", started: S.tick }; console.log("(tick 3000: Steve hits a villager hard)"); }
  if (S.tick === 8000) {
    // a villager with a bed in the house, and a zombie turns up next to him
    b.setDynamicProperty("iv:bed", JSON.stringify({ d: dim.id, x: 2, y: 64, z: -15 }));
    zombie = dim.spawnEntity("minecraft:zombie", { x: b.location.x + 5, y: 64, z: b.location.z + 4 });
    console.log(`(tick 8000: a zombie by ${b.nameTag.split("\n")[0]} at ${b.location.x.toFixed(0)} ${b.location.z.toFixed(0)})`);
  }
  if (S.tick === 9500 && zombie) zombie.remove();
}
const errs = warns.filter((w) => !w.startsWith("[IV]"));
console.log(`=== village2, ${TICKS} ticks; ${errs.length} non-debug warnings`);
for (const e of errs.slice(0, 10)) console.log("WARN", e.slice(0, 600));
const blocks = (re) => [...dim.blocks].filter(([, id]) => re.test(id));
console.log("job blocks:", blocks(/woodcutter_bench|stonecutter|composter|cartography|blast_furnace|smoker/).map(([k, id]) => `${id.replace(/^.*:/, "")}@${k}`).join(" "));
console.log("crafting tables:", blocks(/crafting_table/).map(([k]) => k).join(" "), "| chests:", blocks(/:chest$|barrel/).map(([k, id]) => `${id.replace(/^.*:/, "")}@${k}`).join(" "));
console.log("doors:", blocks(/door/).map(([k]) => k).join(" "));
console.log("babies:", [...S.entities.values()].filter((e) => e.typeId === "minecraft:villager_v2").map((e) => `${e._baby ? "baby" : "adult"} at ${e.location.x.toFixed(1)} ${e.location.z.toFixed(1)}`).join(", ") || "none");
console.log("golem events:", JSON.stringify(golem._events ?? []), "| Steve's tags:", JSON.stringify([...(player._tags ?? [])]));
const filt = process.argv[3] ? new RegExp(process.argv[3]) : /village|Workshop|baby|someone|told|golem|running home|safe again|special|food/i;
const shown = warns.filter((l) => filt.test(l) && !/nav:/.test(l));
const dedup = []; for (const l of shown) if (dedup.at(-1)?.l !== l) dedup.push({ l, n: 1 }); else dedup.at(-1).n++;
console.log(`--- ${shown.length} log lines`);
for (const d of dedup.slice(0, Number(process.argv[4] ?? 60))) console.log(d.l + (d.n > 1 ? ` (x${d.n})` : ""));
