// Independent Villagers - entry point.
// The main loop runs every CFG.TICK_INTERVAL ticks. Each villager has a "brain" that decides when
// it next needs to think (every 2 ticks while chopping, less often while idle).
import { BlockPermutation, ItemStack, system, world } from "@minecraft/server";
import { CFG, DIMENSIONS, LEAVES, LOGS, PROFESSION_INFO, PROP_PROFESSION, Profession, VANILLA_VILLAGERS, VILLAGER_ID, XP } from "./config.js";
import { allBrains, forgetBrain, getBrain, pruneBrains, stateLabel } from "./brain.js";
import { releaseAllClaims } from "./registry.js";
import { registerPlacedTracking } from "./placed.js";
import { cleanupStaleMarker, navForget, navStop, navTo, navUpdate, noteVillagers } from "./nav.js";
import { getTool } from "./actions.js";
import { analyzeTree, compareScans } from "./trees.js";
import { debugLog, isDebug, setDebug } from "./debug.js";
import { getInventory, isPassable, isValid, prettyName, ringOffsets, summarizeItems } from "./util.js";
import { unemployedThink } from "./jobs/unemployed.js";
import { lumberjackThink } from "./jobs/lumberjack.js";
import { minerThink } from "./jobs/miner.js";
import { farmerThink } from "./jobs/farmer.js";
import { cartographerThink } from "./jobs/cartographer.js";
import { armorerThink } from "./jobs/armorer.js";
import { butcherThink } from "./jobs/butcher.js";
import { nitwitThink } from "./jobs/nitwit.js";
import { getWorkstation } from "./jobs/employment.js";
import { isCreative } from "./inspect.js";
import { isBeingInspected, viewSelfTest } from "./inventory_view.js";
import { setMode, setWorking } from "./brain.js";
import { replaceVanillaVillager, sweepVanillaVillagers } from "./replace.js";
import { initVillager } from "./economy.js";
import { vGive } from "./inventory.js";
import { startTradeSession, updateTradeTable } from "./trade.js";
import { clock, marketHours } from "./jobs/market.js";
import { bellRung, wakeIfNeeded, wakeUp } from "./jobs/rest.js";
import { dangerCheck } from "./threat.js";
import { tattleCheck } from "./golem.js";
import { familyCheck } from "./family.js";
import { fieldClaims, releaseFields } from "./jobs/fields.js";
import { zombify } from "./zombie.js";
import { updateTag } from "./names.js";
import { forceVillage, noteVillage } from "./village.js";
import { bottleXp, xpOf } from "./xp.js";

// profession -> brain function. New jobs plug in here.
const THINKERS = {
  [Profession.NONE]: unemployedThink,
  [Profession.LUMBERJACK]: lumberjackThink,
  [Profession.MINER]: minerThink,
  [Profession.FARMER]: farmerThink,
  [Profession.CARTOGRAPHER]: cartographerThink,
  [Profession.ARMORER]: armorerThink,
  [Profession.BUTCHER]: butcherThink,
  [Profession.NITWIT]: nitwitThink,
};

system.runInterval(() => {
  const now = system.currentTick;
  const sweep = CFG.REPLACE_VANILLA_VILLAGERS && now % CFG.REPLACE_SWEEP_INTERVAL < CFG.TICK_INTERVAL;

  for (const dimId of DIMENSIONS) {
    let dim;
    let villagers;
    try {
      dim = world.getDimension(dimId);
      if (sweep) sweepVanillaVillagers(dim);
      villagers = dim.getEntities({ type: VILLAGER_ID });
    } catch {
      continue;
    }
    noteVillagers(dimId, villagers); // where everybody is: routes go round each other
    for (const villager of villagers) {
      const brain = getBrain(villager);
      if (brain.debugGoto) {
        debugGotoTick(villager, brain, now);
        continue;
      }
      if (isBeingInspected(villager.id)) {
        // a creative player has his inventory open: stand still until they're done
        if (brain.nav) navStop(villager, brain);
        brain.action = null;
        setMode(villager, brain, "work");
        setWorking(villager, false);
        continue;
      }
      wakeIfNeeded(villager, dim, brain); // out of bed if anything pulled him out of the sleep state
      // a zombie about to get him beats everything else - even a deal or his bed
      try {
        if (dangerCheck(villager, dim, brain, now, () => wakeUp(villager, dim, brain))) continue;
        if (tattleCheck(villager, dim, brain, now)) continue; // a player hit him hard: off to the golem
        if (familyCheck(villager, dim, brain, now)) continue; // plenty of food and someone special
      } catch (e) {
        console.warn(`[Independent Villagers] danger check: ${e}`);
      }
      if (brain.frozenUntil) {
        if (now < brain.frozenUntil) {
          // standing still for a deal: switch walking off, but keep his plans (route, job) intact
          if (brain.frozenMode === undefined) brain.frozenMode = brain.mode;
          if (brain.mode !== "work") {
            try {
              villager.triggerEvent("iv:mode_work");
            } catch {}
            brain.mode = "work";
          }
          continue;
        }
        // back to work: restore whatever movement he had going
        brain.frozenUntil = 0;
        const prev = brain.frozenMode;
        brain.frozenMode = undefined;
        brain.mode = null;
        if (prev) setMode(villager, brain, prev);
        if (brain.nav) brain.nav.lastProgress = now; // the pause isn't "being stuck"
      }
      if (now < brain.wake) continue;
      try {
        if (brain.fresh) {
          brain.fresh = false;
          cleanupStaleMarker(villager);
          initVillager(villager); // starting emeralds (once per villager)
          updateTag(villager); // his name, and his job underneath
          noteVillage(dim, villager.location); // (villages from before v1.12 get their Workshop too)
        }
        if (now >= (brain.nextTradeCheck ?? 0)) {
          brain.nextTradeCheck = now + 160 + Math.floor(Math.random() * 40); // (spread out, not all at once)
          updateTradeTable(villager); // offers always match what's in his shop row
          if (now >= (brain.nextTag ?? 0)) {
            brain.nextTag = now + 600;
            updateTag(villager); // (a nitwit made one by the vanilla swap, a name tag used on him...)
          }
        }
        if (now >= (brain.nextBottle ?? 0)) {
          brain.nextBottle = now + XP.BOTTLE_EVERY;
          bottleXp(villager); // his saved-up experience into bottles o' enchanting
        }
        const think = THINKERS[villager.getProperty(PROP_PROFESSION)] ?? unemployedThink;
        think(villager, dim, brain, now);
      } catch (e) {
        console.warn(`[Independent Villagers] ${villager.id} (${brain.state}): ${e}\n${e?.stack ?? ""}`);
        brain.wake = now + 20; // don't spam errors
      }
    }
  }

  if (now % 1200 < CFG.TICK_INTERVAL) pruneBrains(now, 6000);
}, CFG.TICK_INTERVAL);

registerPlacedTracking();

// Replace vanilla villagers as soon as they appear (spawned, bred, cured, loaded in)
world.afterEvents.entitySpawn.subscribe((ev) => {
  if (!CFG.REPLACE_VANILLA_VILLAGERS) return;
  const entity = ev.entity;
  if (!VANILLA_VILLAGERS.includes(entity?.typeId)) return;
  system.run(() => {
    try {
      replaceVanillaVillager(entity);
    } catch {}
  });
});

// Interacting with a villager opens the trade screen (vanilla) and we start watching the trade so
// his stock and emeralds stay correct. (Creative + crouch opens his real inventory instead - see
// inventory_view.js.)
world.afterEvents.playerInteractWithEntity.subscribe((ev) => {
  const { player, target } = ev;
  if (target?.typeId !== VILLAGER_ID) return;
  system.run(() => {
    if (!isValid(target) || !isValid(player)) return;
    if (player.isSneaking && isCreative(player)) return;
    startTradeSession(player, target);
  });
});

// Killed by a zombie: he rises again as a zombie villager, carrying his things (zombie.js)
world.afterEvents.entityDie.subscribe(
  (ev) => {
    const id = ev.deadEntity.id;
    if (isDebug()) console.warn(`[IV] villager #${String(id).slice(-4)} died at ${Math.floor(ev.deadEntity.location.x)} ${Math.floor(ev.deadEntity.location.y)} ${Math.floor(ev.deadEntity.location.z)}`);
    zombify(ev);
    releaseAllClaims(id);
    releaseFields(id);
    navForget(id, world);
    forgetBrain(id);
  },
  { entityTypes: [VILLAGER_ID] }
);

// ---------------------------------------------------------------- debug commands
//   /scriptevent iv:debug on|off      log every decision to the content log / console
//   /scriptevent iv:status            print every villager's job, task, tool and inventory
//   /scriptevent iv:tree <x> <y> <z>  would a lumberjack chop the tree with a log at x y z? (and why)
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const say = (msg) => {
    console.warn(msg);
    try {
      ev.sourceEntity?.sendMessage?.(msg);
    } catch {}
  };
  const args = ev.message.trim().split(/\s+/).filter(Boolean);

  if (ev.id === "iv:debug") {
    setDebug(args[0] !== "off");
    say(`[IV] debug ${isDebug() ? "on" : "off"}`);
  } else if (ev.id === "iv:status") {
    for (const dimId of DIMENSIONS) {
      for (const v of world.getDimension(dimId).getEntities({ type: VILLAGER_ID })) {
        const brain = getBrain(v);
        const prof = PROFESSION_INFO[v.getProperty(PROP_PROFESSION)]?.name;
        const l = v.location;
        const inv = [...summarizeItems(getInventory(v))].map(([id, n]) => `${n} ${prettyName(id)}`).join(", ") || "empty";
        const ws = getWorkstation(v);
        const hours = ws ? marketHours(v) : undefined;
        say(
          `[IV] #${String(v.id).slice(-4)} ${prof} | ${brain.state} (${stateLabel(brain) ?? "-"}) | at ${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)}` +
            ` | worked ${Math.round((system.currentTick - (brain.shiftStart ?? system.currentTick)) / 20)}s` +
            (hours ? ` | trades ${clock(hours.start)}-${clock(hours.start + hours.len)}` : "") +
            ` | ws ${ws ? `${ws.x} ${ws.y} ${ws.z}` : "-"} | xp ${xpOf(v).toFixed(1)} | tools ${[getTool(v, "axe")?.id, getTool(v, "pickaxe")?.id, getTool(v, "hoe")?.id].filter(Boolean).map((t) => t.replace("minecraft:", "")).join("+") || "hands"} | inv: ${inv}`
        );
      }
    }
  } else if (ev.id === "iv:spawnjack") {
    // /scriptevent iv:spawnjack <x> <z> [miner|farmer|cartographer|armorer|butcher|nitwit]  - job block + villager on the ground at x z (for testing)
    const [x0, z0] = args.map(Number);
    const dim = world.getDimension("minecraft:overworld");
    // open ground, not under a tree (a villager placed inside a trunk suffocates)
    let b;
    let x = x0;
    let z = z0;
    for (const o of [{ x: 0, z: 0 }, ...ringOffsets(1, 4, [0])]) {
      let c;
      let clear;
      try {
        c = dim.getTopmostBlock({ x: x0 + o.x, z: z0 + o.z });
        while (c && (c.isAir || isPassable(c) || LEAVES.has(c.typeId) || LOGS.has(c.typeId))) c = c.below();
        if (!c) continue;
        clear = [1, 2, 3].every((dy) => {
          const a = dim.getBlock({ x: c.x, y: c.y + dy, z: c.z });
          return a && (a.isAir || isPassable(a));
        });
      } catch {
        continue; // chunk isn't loaded yet
      }
      if (!clear) continue;
      b = c;
      x = x0 + o.x;
      z = z0 + o.z;
      break;
    }
    if (!b) return say("[IV] spawnjack: no clear ground found (chunk loaded?)");
    const table = { x, y: b.y + 1, z };
    const job = { miner: "minecraft:stonecutter_block", farmer: "minecraft:composter", cartographer: "minecraft:cartography_table", armorer: "minecraft:blast_furnace", butcher: "minecraft:smoker" }[args[2]] ?? "iv:woodcutter_bench";
    const v = dim.spawnEntity(VILLAGER_ID, { x: x + 1.5, y: b.y + 1, z: z + 0.5 });
    if (args[2] === "nitwit") {
      v.setProperty(PROP_PROFESSION, Profession.NITWIT); // no job block for him
      return say(`[IV] spawnjack: a nitwit at ${x + 1} ${b.y + 1} ${z}`);
    }
    dim.getBlock(table).setType(job);
    say(`[IV] spawnjack: table at ${table.x} ${table.y} ${table.z} (ground ${b.typeId})`);
  } else if (ev.id === "iv:village") {
    // /scriptevent iv:village <x> <y> <z>  - do up the village round there now (Workshop + furnished houses)
    const [x, y, z] = args.map(Number);
    forceVillage(world.getDimension("minecraft:overworld"), { x, y, z });
    say(`[IV] village: looking for a bell round ${x} ${y} ${z}`);
  } else if (ev.id === "iv:goto") {
    // /scriptevent iv:goto <x> <y> <z>  - the nearest villager walks there (pauses its job)
    const [x, y, z] = args.map(Number);
    const dim = world.getDimension("minecraft:overworld");
    const v = dim.getEntities({ type: VILLAGER_ID, location: { x, y, z }, closest: 1 })[0];
    if (!v) return say("[IV] goto: no villager");
    const brain = getBrain(v);
    brain.debugGoto = { x, y, z, started: system.currentTick, last: 0 };
    navStop(v, brain);
    if (!navTo(v, brain, { x, y, z })) {
      brain.debugGoto = null;
      return say("[IV] goto: navTo refused");
    }
    say(`[IV] goto: #${String(v.id).slice(-4)} walking to ${x} ${y} ${z}, marker at ${JSON.stringify(brain.nav?.marker)}`);
  } else if (ev.id === "iv:scancompare") {
    // /scriptevent iv:scancompare <x> <y> <z>  - old vs new forest scan: how many trees each one finds
    const [x, y, z] = args.map(Number);
    const r = compareScans(world.getDimension("minecraft:overworld"), { x, y, z });
    say(`[IV] scan around ${x} ${y} ${z}: ${r.full.trunks} trunks -> ${r.full.trees} choppable trees`);
    for (const [why, e] of [...r.full.reasons].sort((a, b) => b[1].n - a[1].n)) say(`[IV]   rejected x${e.n}: ${why}  (e.g. ${e.example})`);
  } else if (ev.id === "iv:pathdebug") {
    // /scriptevent iv:pathdebug <x> <y> <z>  - nearest villager: where he stands, what's around his feet
    const [x, y, z] = args.map(Number);
    const dim = world.getDimension("minecraft:overworld");
    const v = dim.getEntities({ type: VILLAGER_ID, location: { x, y, z }, closest: 1 })[0];
    if (!v) return say("[IV] pathdebug: no villager");
    const f = { x: Math.floor(v.location.x), y: Math.floor(v.location.y), z: Math.floor(v.location.z) };
    const id = (dx, dy, dz) => {
      const b = dim.getBlock({ x: f.x + dx, y: f.y + dy, z: f.z + dz });
      return b ? `${b.typeId.replace("minecraft:", "")}${b.isLiquid ? "(liq)" : ""}${b.isWaterlogged ? "(wl)" : ""}` : "?";
    };
    say(`[IV] pathdebug at ${v.location.x.toFixed(1)} ${v.location.y.toFixed(2)} ${v.location.z.toFixed(1)}: below=${id(0, -1, 0)} feet=${id(0, 0, 0)} head=${id(0, 1, 0)}`);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      say(`[IV]   ${dx},${dz}: y-2=${id(dx, -2, dz)} y-1=${id(dx, -1, dz)} y0=${id(dx, 0, dz)} y1=${id(dx, 1, dz)} y2=${id(dx, 2, dz)}`);
    }
  } else if (ev.id === "iv:treedump") {
    // /scriptevent iv:treedump <x> <y> <z>  - every log connected to this one (with its axis) and what touches it
    const [x, y, z] = args.map(Number);
    const dim = world.getDimension("minecraft:overworld");
    const start = dim.getBlock({ x, y, z });
    const seen = new Set();
    const queue = [start];
    const out = [];
    const touching = new Map();
    while (queue.length && out.length < 80) {
      const b = queue.shift();
      const key = `${b.x},${b.y},${b.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${b.x} ${b.y} ${b.z} ${b.permutation.getState("pillar_axis") ?? "?"}`);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const n = dim.getBlock({ x: b.x + dx, y: b.y + dy, z: b.z + dz });
            if (!n) continue;
            if (n.typeId === start.typeId) queue.push(n);
            else if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1 && !n.isAir) touching.set(n.typeId, (touching.get(n.typeId) ?? 0) + 1);
          }
    }
    say(`[IV] treedump ${start.typeId}: ${out.length} logs: ${out.join(" | ")}`);
    say(`[IV]   touching: ${[...touching].map(([id, n]) => `${n} ${id.replace("minecraft:", "")}`).join(", ")}`);
  } else if (ev.id === "iv:scanat") {
    // /scriptevent iv:scanat <label> <x> <z>  - like scancompare, finding the ground height itself
    const [label, x, z] = [args[0], Number(args[1]), Number(args[2])];
    const dim = world.getDimension("minecraft:overworld");
    let b = dim.getTopmostBlock({ x, z });
    while (b && (b.isAir || isPassable(b) || LEAVES.has(b.typeId) || LOGS.has(b.typeId))) b = b.below();
    if (!b) return say(`[IV] ${label}: not loaded`);
    const r = compareScans(dim, { x, y: b.y + 1, z });
    const species = [...r.full.species].map(([s, n]) => `${n} ${s.replace("minecraft:", "").replace("_log", "")}`).join(", ");
    say(`[IV] ${label} (${x} ${b.y + 1} ${z}): ${r.full.trunks} trunks -> ${r.full.trees} choppable trees [${species}]`);
    for (const [why, e] of [...r.full.reasons].sort((a, b) => b[1].n - a[1].n)) say(`[IV]   ${label} rejected x${e.n}: ${why}  (e.g. ${e.example})`);
  } else if (ev.id === "iv:around") {
    // /scriptevent iv:around <x> <y> <z> [r]  - list the non-air blocks around a spot (debugging)
    const [x, y, z, r = 3] = args.map(Number);
    const dim = world.getDimension("minecraft:overworld");
    const counts = new Map();
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -1; dy <= 2; dy++)
        for (let dz = -r; dz <= r; dz++) {
          const b = dim.getBlock({ x: x + dx, y: y + dy, z: z + dz });
          if (!b || b.isAir) continue;
          const key = `${b.typeId.replace("minecraft:", "")}${LOGS.has(b.typeId) ? `(${b.permutation.getState("pillar_axis")}) @${dx},${dy},${dz}` : ""}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    say(`[IV] around ${x} ${y} ${z}: ${[...counts].map(([k2, n]) => `${n} ${k2}`).join(", ")}`);
  } else if (ev.id === "iv:viewtest") {
    // /scriptevent iv:viewtest <x> <y> <z>  - self-test: inventory window edits reach the villager
    const [x, y, z] = args.map(Number);
    const v = world.getDimension("minecraft:overworld").getEntities({ type: VILLAGER_ID, location: { x, y, z }, closest: 1 })[0];
    if (v) viewSelfTest(v, say);
  } else if (ev.id === "iv:torchtest") {
    // /scriptevent iv:torchtest <x> <y> <z>  - hang torches on a stone pillar at x y z, poke the neighbours, see which stay
    const [x0, y, z] = args.map(Number);
    const dim = world.getDimension("minecraft:overworld");
    const sides = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
    const opposite = { east: "west", west: "east", south: "north", north: "south" };
    const pillars = [
      { x: x0, name: (s) => s },
      { x: x0 + 6, name: (s) => opposite[s] },
    ];
    for (const p of pillars) {
      dim.getBlock({ x: p.x, y, z }).setType("minecraft:stone");
      for (const [side, [dx, dz]] of Object.entries(sides)) {
        dim.getBlock({ x: p.x + dx, y, z: z + dz }).setPermutation(BlockPermutation.resolve("minecraft:torch", { torch_facing_direction: p.name(side) }));
      }
      say(`[IV] placed: ${Object.entries(sides).map(([s, [dx, dz]]) => dim.getBlock({ x: p.x + dx, y, z: z + dz }).typeId.replace("minecraft:", "")).join(",")}`);
    }
    system.runTimeout(() => {
      for (const p of pillars) for (const [dx, dz] of Object.values(sides)) dim.getBlock({ x: p.x + dx, y: y - 1, z: z + dz })?.setType("minecraft:dirt"); // block updates
      system.runTimeout(() => {
        for (const p of pillars) {
          for (const [side, [dx, dz]] of Object.entries(sides)) {
            const b = dim.getBlock({ x: p.x + dx, y, z: z + dz });
            say(`[IV] torch on the ${side} side of the stone, facing "${p.name(side)}": ${b.typeId === "minecraft:torch" ? "STAYED" : "popped"}`);
          }
        }
      }, 10);
    }, 10);
  } else if (ev.id === "iv:give") {
    // /scriptevent iv:give <x> <y> <z> <item> [count]  - put items in the nearest villager's inventory
    const [x, y, z] = args.slice(0, 3).map(Number);
    const v = world.getDimension("minecraft:overworld").getEntities({ type: VILLAGER_ID, location: { x, y, z }, closest: 1 })[0];
    if (v) vGive(v, new ItemStack(args[3], Number(args[4] ?? 1)));
    say(v ? `[IV] gave ${args[4] ?? 1} ${args[3]} to #${String(v.id).slice(-4)}` : "[IV] give: no villager");
  } else if (ev.id === "iv:bell") {
    // /scriptevent iv:bell <x> <y> <z>  - as if somebody rang a bell there
    const [x, y, z] = args.slice(0, 3).map(Number);
    bellRung(world.getDimension("minecraft:overworld"), { x, y, z });
    say(`[IV] rang the bell at ${x} ${y} ${z}`);
  } else if (ev.id === "iv:beds") {
    // /scriptevent iv:beds  - who's sleeping where
    for (const dimId of DIMENSIONS) {
      for (const v of world.getDimension(dimId).getEntities({ type: VILLAGER_ID })) {
        const brain = getBrain(v);
        const bed = v.getDynamicProperty("iv:bed");
        const l = v.location;
        let occupied = "-";
        try {
          const b = JSON.parse(bed ?? "null");
          if (b) occupied = String(world.getDimension(b.d).getBlock(b)?.permutation.getState("occupied_bit"));
        } catch {}
        say(`[IV] #${String(v.id).slice(-4)} ${brain.state} | at ${l.x.toFixed(1)} ${l.y.toFixed(2)} ${l.z.toFixed(1)} | bed ${bed ?? "-"} occupied=${occupied} sleeping=${v.getProperty("iv:sleeping")}`);
      }
    }
  } else if (ev.id === "iv:selfemploy") {
    // /scriptevent iv:selfemploy  - don't wait CFG.SELF_EMPLOY_AFTER: jobless villagers set up
    // their own woodcutter's bench right now (for testing)
    let n = 0;
    for (const dimId of DIMENSIONS) {
      for (const v of world.getDimension(dimId).getEntities({ type: VILLAGER_ID })) {
        const brain = getBrain(v);
        brain.joblessSince = 0;
        brain.noBenchUntil = 0;
        brain.wake = 0;
        n++;
      }
    }
    say(`[IV] ${n} villager(s) won't wait around for a job any longer`);
  } else if (ev.id === "iv:fields") {
    // /scriptevent iv:fields  - which farmer has claimed which field
    const claims = fieldClaims();
    if (!claims.length) say("[IV] no fields claimed");
    for (const f of claims) {
      const owner = world.getEntity(f.owner);
      say(`[IV] field at ${f.x} ${f.y} ${f.z} (radius ${f.r}) belongs to #${String(f.owner).slice(-4)}${owner ? "" : " (not loaded)"}`);
    }
  } else if (ev.id === "iv:hours") {
    // /scriptevent iv:hours <start> [length]  - set every villager's trading hours (ticks of the day, 0 = 6:00)
    const start = Number(args[0] ?? 1000);
    const len = Number(args[1] ?? CFG.MARKET.LENGTH);
    let n = 0;
    for (const dimId of DIMENSIONS) {
      for (const v of world.getDimension(dimId).getEntities({ type: VILLAGER_ID })) {
        v.setDynamicProperty("iv:market", JSON.stringify({ start, len }));
        n++;
      }
    }
    say(`[IV] trading hours for ${n} villager(s): ${clock(start)} - ${clock(start + len)}`);
  } else if (ev.id === "iv:dropitem") {
    // /scriptevent iv:dropitem <x> <y> <z> <item>  - drop an item entity (for testing pickups)
    const [x, y, z] = args.slice(0, 3).map(Number);
    world.getDimension("minecraft:overworld").spawnItem(new ItemStack(args[3], 1), { x, y, z });
  } else if (ev.id === "iv:markers") {
    // /scriptevent iv:markers  - count nav marker blocks around every villager (should be 0 or 1 each)
    for (const dimId of DIMENSIONS) {
      const dim = world.getDimension(dimId);
      for (const v of dim.getEntities({ type: VILLAGER_ID })) {
        const o = v.location;
        let n = 0;
        for (let dx = -20; dx <= 20; dx++)
          for (let dy = -8; dy <= 8; dy++)
            for (let dz = -20; dz <= 20; dz++) {
              try {
                if (dim.getBlock({ x: Math.floor(o.x) + dx, y: Math.floor(o.y) + dy, z: Math.floor(o.z) + dz })?.typeId.startsWith("iv:nav_")) n++;
              } catch {}
            }
        say(`[IV] #${String(v.id).slice(-4)} ${getBrain(v).state}: ${n} marker block(s) nearby, walking=${!!getBrain(v).nav}`);
      }
    }
  } else if (ev.id === "iv:tree") {
    const [x, y, z] = args.map(Number);
    const r = analyzeTree(world.getDimension("minecraft:overworld"), { x, y, z });
    say(r.ok ? `[IV] tree at ${x} ${y} ${z}: YES - ${r.species} with ${r.logs.length} logs, ${r.leaves} natural leaves` : `[IV] tree at ${x} ${y} ${z}: NO - ${r.reason}`);
  }
});

function debugGotoTick(villager, brain, now) {
  const g = brain.debugGoto;
  const r = navUpdate(villager, brain, now);
  const l = villager.location;
  if (r !== "moving" || now - g.last >= 40) {
    g.last = now;
    console.warn(
      `[IV] goto #${String(villager.id).slice(-4)}: ${r} after ${((now - g.started) / 20).toFixed(1)}s at ${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)}` +
        ` mode=${brain.mode} marker=${JSON.stringify(brain.nav?.marker ?? null)}`
    );
  }
  if (r !== "moving") brain.debugGoto = null;
}

debugLog(undefined, "loaded");
