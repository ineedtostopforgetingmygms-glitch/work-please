// Farmer - works at a composter:
//   survey   looks around his composter for fields: ripe crops to harvest, bare farmland to sow
//   tend     harvests ripe crops, sows seeds on empty farmland, picks the drops up
//   seeds    beats seeds out of tall grass (and takes a share from fields nearby) when he has none
//   shop     buys what he's missing off other villagers: logs from a lumberjack for his hoe,
//            raw iron and cobblestone from a miner for his bucket and furnace (shopping.js)
//            TODO: seeds from a wandering trader - wandering traders aren't handled yet
//   craft    crafts at a crafting table next to his composter: hoe, furnace, bucket
//   smelt    smelts the raw iron into ingots in his furnace (smelting.js)
//   fill     walks to the village well (or any water) and fills his bucket
//   build    no fields anywhere? he lays out his own: tills a 7x7 patch of soil, pours the water
//            in the middle and sows it
//   stash    takes the harvest home, stores it, restocks his shop row
//   market   his trading hours: stands at his composter and sells (market.js)
import { ItemStack } from "@minecraft/server";
import { BUILD_BLOCK, BUILD_BLOCK_EXCEPTIONS, CFG, FARM, LOGS, SAPLING_GROUND } from "../config.js";
import { setMode, setState, setWorking, sleep } from "../brain.js";
import { debugLog } from "../debug.js";
import { getTool, giveTool, holdItem, pickupItems, placeBlock, startBreak, updateBreak, wearTool } from "../actions.js";
import { navTo, navUpdate } from "../nav.js";
import { addStockpile } from "../registry.js";
import { storeInto, vAdd, vCount, vFreeSlots, vTake } from "../inventory.js";
import { restockSellRow } from "../trade.js";
import { canSee, canUse, center, dist, eyePos, findStandableNear, floorPos, getBlock, getInventory, horizDist, isPassable, isSolidGround, isStandable, lookAt, offset, particle, playSound, ringOffsets, samePos } from "../util.js";
import { getWorkstation, ownsWorkstation, unemploy } from "./employment.js";
import { isNearHome, spotNextTo, stockpileChests, walkTo } from "./common.js";
import { haveBench, putDown, useBench } from "./workshop.js";
import { claimField, claimedByOther, clusterFields, inField, myField } from "./fields.js";
import { fetchWood, woodState } from "./wood.js";
import { goShopping, shop } from "./shopping.js";
import { shopForTool } from "./tools.js";
import { market } from "./market.js";
import { hideState, offDuty, sleepState } from "./rest.js";
import { furnaceHas, furnaceNear, pickStack, plankFuel, smeltStep } from "./smelting.js";

const WORKSTATIONS = ["minecraft:composter"];
const fmt = (p) => `${p.x} ${p.y} ${p.z}`;
const k = (p) => `${p.x},${p.y},${p.z}`;

// crop block -> what it grows from and when it's ripe
const CROPS = {
  "minecraft:wheat": { seed: "minecraft:wheat_seeds", ripe: 7 },
  "minecraft:carrots": { seed: "minecraft:carrot", ripe: 7 },
  "minecraft:potatoes": { seed: "minecraft:potato", ripe: 7 },
  "minecraft:beetroot": { seed: "minecraft:beetroot_seeds", ripe: 7 },
};
const SEED_TO_CROP = {};
for (const [block, c] of Object.entries(CROPS)) SEED_TO_CROP[c.seed] = block;

const isSeed = (id) => id in SEED_TO_CROP;
const isLog = (id) => LOGS.has(id);
const PRODUCE = new Set(["minecraft:wheat", "minecraft:carrot", "minecraft:potato", "minecraft:beetroot", "minecraft:bread", "minecraft:wheat_seeds", "minecraft:beetroot_seeds", "minecraft:poisonous_potato", "minecraft:pumpkin", "minecraft:melon_slice", "minecraft:pumpkin_seeds", "minecraft:melon_seeds"]);
const isWanted = (id) => PRODUCE.has(id) || isSeed(id) || id === "minecraft:bone_meal" || id.endsWith("_hoe");
const IRON_RAW = "minecraft:raw_iron";
const IRON = "minecraft:iron_ingot";
const COBBLE = "minecraft:cobblestone";
const GRASS = new Set(["minecraft:short_grass", "minecraft:tall_grass", "minecraft:grass"]);
// soil he's willing to turn into a field
const SOIL = new Set(["minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt", "minecraft:podzol", "minecraft:farmland"]);

export function farmerThink(villager, dim, brain, now) {
  const ws = getWorkstation(villager);
  if (!ws) return unemploy(villager, dim, brain);
  if (!ownsWorkstation(villager, ws)) return unemploy(villager, dim, brain, true);
  const wsBlock = getBlock(dim, ws);
  if (wsBlock && !WORKSTATIONS.includes(wsBlock.typeId)) return unemploy(villager, dim, brain, true);
  if (!STATES[brain.state]) setState(villager, brain, "survey");
  offDuty(villager, dim, brain, now, ws, { interruptible: ["survey", "idle"], chestKind: "crops" });
  STATES[brain.state](villager, dim, brain, now, ws);
}

const STATES = {
  survey,
  tend,
  seeds,
  shop,
  wood: woodState,
  craft,
  smelt,
  fill,
  build,
  stash,
  idle,
  market: (v, d, b, n, ws) => market(v, d, b, n, ws, { chestKind: "crops", backTo: "survey" }),
  sleep: (v, d, b, n, ws) => sleepState(v, d, b, n, ws, "survey"),
  hide: (v, d, b, n, ws) => hideState(v, d, b, n, ws, "survey"),
};

// ================================================================ survey

// pumpkins and melons: the fruit is the harvest (the stem stays and grows another)
const FRUIT = new Set(["minecraft:pumpkin", "minecraft:melon_block"]);
const STEMS = new Set(["minecraft:pumpkin_stem", "minecraft:melon_stem"]);

const isRipe = (block) => {
  if (FRUIT.has(block?.typeId)) return true;
  const c = CROPS[block?.typeId];
  if (!c) return false;
  try {
    return (block.permutation.getState("growth") ?? 0) >= c.ripe;
  } catch {
    return false;
  }
};

/** Farmland and crops within FARM.RADIUS of his composter: what needs harvesting and sowing. */
function lookAround(dim, ws) {
  const ripe = [];
  const bare = [];
  const land = [];
  for (let dx = -FARM.RADIUS; dx <= FARM.RADIUS; dx++) {
    for (let dz = -FARM.RADIUS; dz <= FARM.RADIUS; dz++) {
      for (let dy = -4; dy <= 4; dy++) {
        const p = { x: ws.x + dx, y: ws.y + dy, z: ws.z + dz };
        const b = getBlock(dim, p);
        if (b?.typeId !== "minecraft:farmland") continue;
        land.push(p);
        const above = getBlock(dim, offset(p, 0, 1, 0));
        if (!above) break;
        if (STEMS.has(above.typeId)) {
          // a pumpkin or melon grown on the block beside the stem
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const q = { x: p.x + ox, y: p.y + 1, z: p.z + oz };
            if (FRUIT.has(getBlock(dim, q)?.typeId) && !ripe.some((r) => samePos(r, q))) ripe.push(q);
          }
        } else if (isRipe(above)) ripe.push({ x: p.x, y: p.y + 1, z: p.z });
        else if (above.isAir) bare.push({ x: p.x, y: p.y + 1, z: p.z });
        break;
      }
    }
  }
  return { ripe, bare, land, farmland: land.length };
}

/**
 * Which field is his. One field, one farmer: he keeps the one he claimed as long as it's still
 * there, otherwise he takes the nearest patch nobody else has claimed. Undefined means every field
 * around here already belongs to another farmer - so he'd better go and lay out his own.
 */
function pickField(villager, dim, brain, now, ws) {
  const groups = clusterFields(brain.fields.land);
  const mine = myField(villager.id);
  if (mine && mine.d === dim.id) {
    const still = groups.find((g) => horizDist(g, mine) <= Math.max(g.r, mine.r));
    if (still) {
      if (still.r !== mine.r || still.x !== mine.x || still.z !== mine.z) claimField(villager, dim.id, still); // it's grown
      return still;
    }
  }
  const free = groups
    .filter((g) => !claimedByOther(dim.id, villager.id, g))
    .sort((a, b) => horizDist(a, ws) - horizDist(b, ws))[0];
  if (!free) {
    if (groups.length && now - (brain.saidTaken ?? -1e9) > 20 * 120) {
      brain.saidTaken = now;
      debugLog(villager, `${groups.length} field(s) here, all taken by other farmers - he'll make his own`);
    }
    return undefined;
  }
  claimField(villager, dim.id, free);
  debugLog(villager, `this is his field now: ${free.n} tilled blocks around ${free.x} ${free.y} ${free.z}`);
  return free;
}

function survey(villager, dim, brain, now, ws) {
  setMode(villager, brain, "rest");
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);

  if (vFreeSlots(inv) <= 1 || vCount(inv, (id) => PRODUCE.has(id)) >= FARM.RETURN_AT) return setState(villager, brain, "stash");

  // what's around? (cached for a few seconds - it's a big look around)
  if (!brain.fields || now - brain.fields.at > 20 * 10) brain.fields = { ...lookAround(dim, ws), at: now };
  const field = brain.fields.land.length ? pickField(villager, dim, brain, now, ws) : undefined;
  brain.myField = field;
  // only his own field is his business - the next farmer's rows are for him to tend
  const ripe = brain.fields.ripe.filter((p) => inField(field, p));
  const bare = brain.fields.bare.filter((p) => inField(field, p));

  const seedsOnHand = vCount(inv, isSeed);
  if (ripe.length || (bare.length && seedsOnHand)) {
    brain.job = { targets: [...ripe, ...(seedsOnHand ? bare : [])].sort((a, b) => dist(a, villager.location) - dist(b, villager.location)).slice(0, 40), done: new Set() };
    return setState(villager, brain, "tend");
  }

  // no field of his own: he lays one out (hoe, bucket, water, then till and sow)
  if (!field) {
    const step = setUpFarm(villager, dim, brain, now, ws, inv);
    if (step === "busy") return;
    if (step === "ready") return setState(villager, brain, "build");
    return setState(villager, brain, "idle", CFG.IDLE_TIME); // can't get what he needs yet
  }

  // fields, but nothing to do on them: get seeds for the bare patches, else take a break
  const mayLookForSeeds = (brain.noSeedsUntil ?? 0) <= now;
  if (bare.length && !seedsOnHand && mayLookForSeeds) return setState(villager, brain, "seeds");
  if (mayLookForSeeds && seedsOnHand < FARM.SEEDS_WANTED && !bare.length && Math.random() < 0.3) return setState(villager, brain, "seeds");
  setState(villager, brain, "idle", CFG.IDLE_TIME);
}

/**
 * Everything he needs before he can lay out a field: a hoe (wood from a lumberjack), a bucket
 * (raw iron from a miner, smelted in his own furnace) and water in it.
 * @returns "busy" (off to sort one of those out), "ready", or "stuck" (nothing he can do now).
 */
function setUpFarm(villager, dim, brain, now, ws, inv) {
  const tableCost = haveBench(dim, ws) ? 0 : 1;
  const logs = vCount(inv, isLog);
  // he has no field at all yet, so every link in this chain is urgent: he'll buy out of hours
  const buy = (good, count, why) => {
    debugLog(villager, `needs ${good} ${why}`);
    return goShopping(villager, brain, good, count, "survey", now, true) ? "busy" : "stuck";
  };
  // ...and if nobody will sell him the wood, he goes and cuts it himself
  const getLogs = (need, why) => {
    const bought = buy("logs", CFG.WOOD_DEAL.logs, why);
    if (bought === "busy") return "busy";
    return fetchWood(villager, brain, need, "survey", now) ? "busy" : "stuck";
  };

  // 1. a hoe
  if (!getTool(villager, "hoe")) {
    if (logs < FARM.HOE_COST_LOGS + tableCost) return getLogs(FARM.HOE_COST_LOGS + tableCost, "for a hoe");
    brain.job = { craft: "minecraft:wooden_hoe" };
    setState(villager, brain, "craft");
    return "busy";
  }

  // 2. a bucket: 3 iron ingots, smelted from raw iron in his own furnace
  const hasBucket = vCount(inv, (id) => id === "minecraft:bucket" || id === "minecraft:water_bucket") > 0;
  if (!hasBucket) {
    if (vCount(inv, (id) => id === IRON) >= FARM.BUCKET_IRON) {
      brain.job = { craft: "minecraft:bucket" };
      setState(villager, brain, "craft");
      return "busy";
    }
    const furnace = furnaceNear(dim, ws);
    if (!furnace) {
      if (vCount(inv, (id) => id === COBBLE) < FARM.FURNACE_COBBLE) return buy("cobblestone", FARM.FURNACE_COBBLE, "for a furnace");
      if (logs < tableCost) return getLogs(tableCost, "for a crafting table");
      brain.job = { craft: "minecraft:furnace" };
      setState(villager, brain, "craft");
      return "busy";
    }
    if (vCount(inv, (id) => id === IRON_RAW) < FARM.BUCKET_IRON && !furnaceHas(dim, furnace, IRON)) {
      return buy("iron", FARM.BUCKET_IRON, "for a bucket");
    }
    if (logs < 1 && !furnaceHas(dim, furnace, IRON)) return getLogs(2, "to fire the furnace");
    brain.job = null;
    setState(villager, brain, "smelt");
    return "busy";
  }

  // 3. water in the bucket
  if (vCount(inv, (id) => id === "minecraft:water_bucket") === 0) {
    setState(villager, brain, "fill");
    return "busy";
  }

  // 4. seeds to sow it with
  if (vCount(inv, isSeed) === 0 && (brain.noSeedsUntil ?? 0) <= now) {
    setState(villager, brain, "seeds");
    return "busy";
  }
  return "ready";
}

// ================================================================ tend

function tend(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  const job = brain.job;
  if (!job?.targets?.length) return finishTending(villager, brain);
  pickupItems(villager, dim, inv, isWanted);

  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    pickupItems(villager, dim, inv, isWanted);
    return sleep(brain, 4);
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed") job.targets.shift();
  }
  if (now - brain.since > FARM.TEND_TIME || vFreeSlots(inv) === 0) return finishTending(villager, brain);

  const p = job.targets[0];
  if (!p) return finishTending(villager, brain);
  const block = getBlock(dim, p);
  if (!block) {
    job.targets.shift();
    return;
  }

  // in reach? harvest it or sow it
  if (canUse(dim, villager, p)) {
    setMode(villager, brain, "work");
    if (isRipe(block)) {
      lookAt(villager, center(p));
      startBreak(brain, block, getTool(villager, "hoe"));
      setWorking(villager, true);
      job.targets.shift();
      return;
    }
    if (block.isAir && getBlock(dim, offset(p, 0, -1, 0))?.typeId === "minecraft:farmland") {
      const seed = pickSeed(inv);
      if (seed) {
        vTake(inv, (id) => id === seed, 1);
        placeBlock(villager, dim, p, SEED_TO_CROP[seed], "dig.grass");
        debugLog(villager, `sowed ${seed.replace("minecraft:", "")} at ${fmt(p)}`);
      }
    }
    job.targets.shift();
    return sleep(brain, 6);
  }

  // walk over to it
  const spot = findStandableNear(dim, p, 2, 2) ?? spotNextTo(dim, p, villager);
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9 })) {
    job.targets.shift();
    return;
  }
  sleep(brain, 4);
}

/** The seed he has most of (so a field ends up mostly one crop, like a villager's). */
function pickSeed(inv) {
  let best;
  let bestN = 0;
  for (const seed of Object.keys(SEED_TO_CROP)) {
    const n = vCount(inv, (id) => id === seed);
    if (n > bestN) {
      best = seed;
      bestN = n;
    }
  }
  return best;
}

function finishTending(villager, brain) {
  brain.job = null;
  brain.fields = null;
  setWorking(villager, false);
  setState(villager, brain, "survey");
}

// ================================================================ seeds

/** Beats seeds out of the tall grass around him, like a player does. */
function seeds(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);

  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    pickupItems(villager, dim, inv, isWanted);
    return sleep(brain, 4);
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  if (vCount(inv, isSeed) >= FARM.SEEDS_WANTED || now - brain.since > 20 * 40) {
    if (vCount(inv, isSeed) === 0) {
      debugLog(villager, "no seeds anywhere - he'll try again later (a wandering trader would sell some)");
      brain.noSeedsUntil = now + CFG.BUY_RETRY;
    }
    brain.job = null;
    return setState(villager, brain, "survey");
  }

  const grass = findGrass(dim, villager, brain, ws);
  if (!grass) {
    debugLog(villager, "no grass around to get seeds from");
    brain.noSeedsUntil = now + CFG.BUY_RETRY;
    return setState(villager, brain, "survey");
  }
  if (canUse(dim, villager, grass)) {
    setMode(villager, brain, "work");
    lookAt(villager, center(grass));
    startBreak(brain, getBlock(dim, grass), getTool(villager, "hoe"));
    setWorking(villager, true);
    return;
  }
  const spot = findStandableNear(dim, grass, 2, 2);
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9 })) {
    (brain.badGrass ??= new Set()).add(k(grass));
    return sleep(brain, 4);
  }
  sleep(brain, 4);
}

function findGrass(dim, villager, brain, ws) {
  // around his composter, not around wherever he's wandered to - he stays near his patch
  const from = ws;
  const bad = brain.badGrass;
  let best;
  let bestD = Infinity;
  for (let dx = -FARM.GRASS_SEARCH; dx <= FARM.GRASS_SEARCH; dx += 1) {
    for (let dz = -FARM.GRASS_SEARCH; dz <= FARM.GRASS_SEARCH; dz += 1) {
      const d = dx * dx + dz * dz;
      if (d >= bestD) continue;
      for (let dy = -3; dy <= 3; dy++) {
        const p = { x: from.x + dx, y: from.y + dy, z: from.z + dz };
        if (!GRASS.has(getBlock(dim, p)?.typeId ?? "")) continue;
        if (bad?.has(k(p))) continue;
        best = p;
        bestD = d;
        break;
      }
    }
  }
  return best;
}

// ================================================================ craft & smelt

function craft(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);

  // his furnace, crafted and now looking for somewhere to stand
  if (brain.job?.place) {
    const what = brain.job.place;
    const at = putDown(villager, dim, brain, now, ws, what, "use.stone");
    if (at === "busy") return sleep(brain, 4);
    debugLog(villager, at ? `stood his ${what.replace("minecraft:", "")} at ${fmt(at)}` : `nowhere to put the ${what.replace("minecraft:", "")}`);
    brain.job = null;
    return setState(villager, brain, at ? "survey" : "idle", at ? 0 : 20 * 30);
  }

  const item = brain.job?.craft;
  if (!item) return setState(villager, brain, "survey");

  // at a crafting table: the village's nearest one, or one he makes himself from a log
  const table = useBench(villager, dim, brain, now, ws, () => vTake(inv, isLog, 1).length === 1);
  if (table === "busy") return sleep(brain, 6);
  if (!table) {
    debugLog(villager, "can't get to a crafting table");
    return setState(villager, brain, "idle", 20 * 30);
  }
  setMode(villager, brain, "work");
  const c = center(table);
  lookAt(villager, c);

  if (item === "minecraft:wooden_hoe") {
    if (vTake(inv, isLog, FARM.HOE_COST_LOGS).length < FARM.HOE_COST_LOGS) return setState(villager, brain, "survey");
    giveTool(villager, item);
    vAdd(inv, new ItemStack("minecraft:stick", 2));
  } else if (item === "minecraft:bucket") {
    if (vTake(inv, (id) => id === IRON, FARM.BUCKET_IRON).length < FARM.BUCKET_IRON) return setState(villager, brain, "survey");
    giveTool(villager, item);
  } else if (item === "minecraft:furnace") {
    if (vCount(inv, (id) => id === COBBLE) < FARM.FURNACE_COBBLE) {
      debugLog(villager, "not enough cobblestone for a furnace");
      return setState(villager, brain, "idle", 20 * 30);
    }
    vTake(inv, (id) => id === COBBLE, FARM.FURNACE_COBBLE);
    playSound(dim, "dig.stone", c, 1.2);
    brain.job = { place: "minecraft:furnace" };
    debugLog(villager, "crafted a furnace - off to find somewhere to stand it");
    return sleep(brain, 10);
  }
  playSound(dim, "dig.wood", c, 1.4);
  particle(dim, "minecraft:villager_happy", offset(c, 0, 0.8, 0));
  debugLog(villager, `crafted a ${item.replace("minecraft:", "").replace("_", " ")}`);
  brain.job = null;
  setState(villager, brain, "survey");
}

/** Raw iron -> iron ingots, for his bucket. */
function smelt(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const r = walkTo(villager, dim, brain, now, furnaceNear(dim, ws) ?? ws); // stand at the furnace itself
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");

  const status = smeltStep(villager, dim, brain, now, ws, {
    product: IRON,
    isInput: (id) => id === IRON_RAW,
    pickInput: (inv) => pickStack(inv, (id) => id === IRON_RAW, FARM.BUCKET_IRON),
    takeFuel: plankFuel,
  });
  if (status === "working") return sleep(brain, 20);
  if (status === "toofar") {
    if (!stepToFurnace(villager, dim, brain, now, ws)) {
      brain.job = null;
      return setState(villager, brain, "idle", CFG.IDLE_TIME);
    }
    return sleep(brain, 6);
  }
  if (status === "done") debugLog(villager, `took ${brain.job?.got ?? 0} iron ingot(s) out of the furnace`);
  brain.job = null;
  setState(villager, brain, "survey");
}

/** Stands right next to the furnace when he can't reach it from where he is. */
function stepToFurnace(villager, dim, brain, now, ws) {
  const fpos = furnaceNear(dim, ws);
  if (!fpos) return false;
  const spot = spotNextTo(dim, fpos, villager);
  if (spot && navTo(villager, brain, spot, { radius: 0.8 })) return true;
  // no way to stand next to it: he gives up on the furnace for now (see the smelt state)
  brain.tries++;
  return brain.tries <= 4;
}
// ================================================================ fill the bucket

function fill(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  if (vCount(inv, (id) => id === "minecraft:water_bucket")) return setState(villager, brain, "survey");
  if (!vCount(inv, (id) => id === "minecraft:bucket")) return setState(villager, brain, "survey");

  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  const water = brain.job?.water && getBlock(dim, brain.job.water)?.isLiquid ? brain.job.water : findWater(dim, ws, brain);
  if (!water) {
    debugLog(villager, "no water anywhere near to fill his bucket");
    return setState(villager, brain, "idle", 20 * 60);
  }
  brain.job = { water };

  if (canUse(dim, villager, water)) {
    setMode(villager, brain, "work");
    lookAt(villager, center(water));
    vTake(inv, (id) => id === "minecraft:bucket", 1);
    vAdd(inv, new ItemStack("minecraft:water_bucket", 1));
    getBlock(dim, water).setType("minecraft:air"); // scooped up - a well refills itself
    playSound(dim, "bucket.fill_water", center(water));
    debugLog(villager, `filled his bucket at ${fmt(water)}`);
    brain.job = null;
    return setState(villager, brain, "survey");
  }
  const spot = findStandableNear(dim, water, 2, 2) ?? findStandableNear(dim, water, 3, 3);
  if (!spot || !navTo(villager, brain, spot, { radius: 0.9 })) {
    (brain.badWater ??= new Set()).add(k(water));
    brain.job = null;
    return sleep(brain, 20);
  }
  sleep(brain, 4);
}

/** Water he can take a bucketful from: it has to be a source block with more water beside it. */
function findWater(dim, ws, brain) {
  const bad = brain.badWater;
  let best;
  let bestD = Infinity;
  for (let dx = -FARM.WATER_SEARCH; dx <= FARM.WATER_SEARCH; dx += 1) {
    for (let dz = -FARM.WATER_SEARCH; dz <= FARM.WATER_SEARCH; dz += 1) {
      const d = dx * dx + dz * dz;
      if (d >= bestD) continue;
      for (let dy = -6; dy <= 6; dy++) {
        const p = { x: ws.x + dx, y: ws.y + dy, z: ws.z + dz };
        const b = getBlock(dim, p);
        if (!b?.isLiquid || b.typeId.includes("lava")) continue;
        if (bad?.has(k(p))) continue;
        let neighbours = 0;
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (getBlock(dim, offset(p, ox, 0, oz))?.isLiquid) neighbours++;
        }
        if (neighbours < 2) continue; // don't drain a puddle (or someone's one-block well)
        best = { x: p.x, y: p.y, z: p.z };
        bestD = d;
        break;
      }
    }
  }
  return best;
}

// ================================================================ build a field

/**
 * Lays out his own field: a FARM.SIZE x FARM.SIZE patch of soil, tilled, with the water hole in
 * the middle, and sown with whatever seeds he has.
 */
function build(villager, dim, brain, now, ws) {
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);

  if (brain.action) {
    const r = updateBreak(villager, dim, brain, now);
    if (r === "working") return;
    setWorking(villager, false);
    return sleep(brain, 4);
  }
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
    if (r === "failed" && brain.farmPlan) {
      // that cell is out of the way (a rock, a tree in the middle of it): leave it and get on
      brain.farmPlan.i++;
      brain.farmPlan.skipped = (brain.farmPlan.skipped ?? 0) + 1;
      if (brain.farmPlan.skipped > 8) {
        debugLog(villager, "too much in the way here - he'll lay the field out somewhere else");
        brain.farmPlan = null;
        brain.job = null;
        return setState(villager, brain, "idle", CFG.IDLE_TIME);
      }
    }
  }
  if (!getTool(villager, "hoe")) return setState(villager, brain, "survey");

  // the field he's laying out (kept on his mind, so fetching more water doesn't start a new one)
  if (!brain.farmPlan) {
    const plan = planField(dim, ws, villager);
    if (!plan) {
      debugLog(villager, "nowhere flat and open enough for a field around here");
      return setState(villager, brain, "idle", 20 * 60);
    }
    brain.farmPlan = { ...plan, i: 0 };
    debugLog(villager, `laying out a field of ${plan.cells.length} at ${fmt(plan.center)}`);
  }
  const job = brain.farmPlan;
  const plan = job;

  // the water hole in the middle goes in first, so the soil is watered as he tills it
  if (!job.watered) {
    const c = plan.center;
    const at = getBlock(dim, c);
    if (at?.isLiquid) {
      job.watered = true;
    } else if (!vCount(inv, (id) => id === "minecraft:water_bucket")) {
      return setState(villager, brain, "survey"); // off to fill his bucket first
    } else if (canUse(dim, villager, c)) {
      lookAt(villager, center(c));
      vTake(inv, (id) => id === "minecraft:water_bucket", 1);
      vAdd(inv, new ItemStack("minecraft:bucket", 1));
      getBlock(dim, c).setType("minecraft:water");
      playSound(dim, "bucket.empty_water", center(c));
      debugLog(villager, `poured his bucket into the middle of the field at ${fmt(c)}`);
      job.watered = true;
      return sleep(brain, 10);
    } else {
      const spot = findStandableNear(dim, c, 2, 2);
      if (!spot || !navTo(villager, brain, spot, { radius: 0.9 })) {
        brain.farmPlan = null; // can't get to that spot - pick another patch
        return sleep(brain, 20);
      }
      return sleep(brain, 4);
    }
  }

  // till the cells one by one
  while (job.i < plan.cells.length) {
    const p = plan.cells[job.i];
    const b = getBlock(dim, p);
    if (!b || b.typeId === "minecraft:farmland") {
      job.i++;
      continue;
    }
    if (!SOIL.has(b.typeId)) {
      job.i++;
      continue;
    }
    if (!canUse(dim, villager, p)) {
      const spot = findStandableNear(dim, offset(p, 0, 1, 0), 2, 2);
      if (!spot || !navTo(villager, brain, spot, { radius: 0.9 })) {
        job.i++;
        continue;
      }
      return sleep(brain, 4);
    }
    // anything growing on top gets cleared first (that's where the seeds come from, too)
    const above = getBlock(dim, offset(p, 0, 1, 0));
    if (above && !above.isAir && isPassable(above)) {
      setMode(villager, brain, "work");
      lookAt(villager, center(offset(p, 0, 1, 0)));
      startBreak(brain, above, getTool(villager, "hoe"));
      setWorking(villager, true);
      return;
    }
    setMode(villager, brain, "work");
    lookAt(villager, center(p));
    holdItem(villager, getTool(villager, "hoe")?.id);
    b.setType("minecraft:farmland");
    playSound(dim, "step.gravel", center(p), 0.8);
    particle(dim, "minecraft:crop_growth_emitter", center(offset(p, 0, 1, 0)));
    wearTool(villager, "hoe");
    job.i++;
    return sleep(brain, 8);
  }

  debugLog(villager, `field at ${fmt(plan.center)} is tilled - time to sow it`);
  brain.farmPlan = null;
  brain.job = null;
  brain.fields = null;
  setState(villager, brain, "survey");
}

/**
 * A patch of soil near his composter he can turn into a field: all at one height (so one water
 * hole waters the lot), nothing built on it, sky above. He'll settle for a smaller field, and for
 * a patch with a few odd blocks in it (rocks, a pond edge) - those cells just don't get tilled.
 */
function planField(dim, ws, villager) {
  for (const size of [FARM.SIZE, 5]) {
    const half = Math.floor(size / 2);
    const need = Math.ceil(size * size * 0.7);
    let best;
    for (const o of ringOffsets(2, FARM.RADIUS, [0])) {
      const cx = ws.x + o.x;
      const cz = ws.z + o.z;
      // not on top of another farmer's field, and not so close that the two run into each other
      if (claimedByOther(dim.id, villager.id, { x: cx, y: ws.y, z: cz }, half + 1)) continue;
      let top;
      try {
        top = dim.getTopmostBlock({ x: cx, z: cz });
      } catch {
        continue;
      }
      while (top && isPassable(top)) top = top.below();
      if (!top || !SOIL.has(top.typeId)) continue;
      const y = top.y;
      const cells = [];
      let built = false;
      for (let dx = -half; dx <= half && !built; dx++) {
        for (let dz = -half; dz <= half && !built; dz++) {
          const p = { x: cx + dx, y, z: cz + dz };
          const b = getBlock(dim, p);
          const above = getBlock(dim, offset(p, 0, 1, 0));
          const id = b?.typeId ?? "";
          if (!b || !above) continue;
          if (BUILD_BLOCK.test(id) && !BUILD_BLOCK_EXCEPTIONS.has(id)) built = true; // somebody's build - leave it alone
          else if (!SOIL.has(id) || (!above.isAir && !isPassable(above))) continue;
          else if (dx || dz) cells.push(p);
        }
      }
      if (built || cells.length < need) continue;
      // and open sky over the middle, so the crops grow
      let sky = true;
      for (let h = 2; h <= 6 && sky; h++) if (!getBlock(dim, { x: cx, y: y + h, z: cz })?.isAir) sky = false;
      if (!sky) continue;
      best = { center: { x: cx, y, z: cz }, cells };
      break;
    }
    if (best) return best;
  }
  return undefined;
}

// ================================================================ stash

function stash(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  const inv = getInventory(villager);
  pickupItems(villager, dim, inv, isWanted);
  holdItem(villager, undefined);
  const r = walkTo(villager, dim, brain, now, ws);
  if (r === "moving") return sleep(brain, 4);
  setMode(villager, brain, "work");

  if (!brain.job?.visit) brain.job = { visit: { tried: new Set(), placed: 0 } };
  const visit = brain.job.visit;
  const chests = stockpileChests(dim, ws, "crops");

  // he keeps his tools, emeralds, bucket and a handful of seeds to sow with
  const seedsKept = vCount(inv, isSeed);
  const extra = (id) =>
    !id.endsWith("_hoe") && id !== "minecraft:emerald" && !id.includes("bucket") && !(isSeed(id) && seedsKept <= FARM.SEEDS_WANTED);

  if (vCount(inv, extra) > 0) {
    for (const { block, container } of chests) {
      const key = fmt(block);
      if (visit.tried.has(key)) continue;
      visit.tried.add(key);
      if (!canUse(dim, villager, block, CFG.REACH + 1)) continue; // not through a wall
      lookAt(villager, center(block));
      playSound(dim, "random.chestopen", center(block));
      storeInto(inv, container, extra);
      return sleep(brain, 16);
    }
    if (visit.placed < 2) {
      if (vCount(inv, isLog) < CFG.CHEST_COST_LOGS) {
        if (!chests.length) {
          if (goShopping(villager, brain, "logs", CFG.WOOD_DEAL.logs, "stash", now)) return;
          if (fetchWood(villager, brain, CFG.CHEST_COST_LOGS, "stash", now)) return;
        }
      } else {
        const spot = putDown(villager, dim, brain, now, ws, "minecraft:chest");
        if (spot === "busy") return sleep(brain, 4);
        if (spot) {
          vTake(inv, isLog, CFG.CHEST_COST_LOGS);
          addStockpile(dim.id, spot, "crops", villager.id);
          visit.placed++;
          visit.tried.clear();
          debugLog(villager, `placed a chest for his crops at ${fmt(spot)}`);
          return sleep(brain, 16);
        }
      }
    }
  }

  restockSellRow(villager, chests.map((c) => c.container));
  brain.job = null;
  brain.fields = null;
  setState(villager, brain, "survey");
}

// ================================================================ idle

function idle(villager, dim, brain, now, ws) {
  setWorking(villager, false);
  pickupItems(villager, dim, getInventory(villager), isWanted);
  if (brain.nav) {
    const r = navUpdate(villager, brain, now);
    if (r === "moving") return sleep(brain, 4);
  }
  if (brain.idleInfo?.since !== brain.since) {
    brain.idleInfo = { since: brain.since };
    if (shopForTool(villager, dim, brain, "hoe", "idle", now)) return; // doing well: a better hoe off the armorer
    if (!isNearHome(villager, ws)) {
      const spot = spotNextTo(dim, ws, villager);
      if (spot && navTo(villager, brain, spot, { radius: 0.9 })) return sleep(brain, 4);
    }
  }
  setMode(villager, brain, "rest");
  if (now - brain.since >= (brain.idleFor || CFG.IDLE_TIME)) {
    brain.fields = null;
    return setState(villager, brain, "survey");
  }
  sleep(brain, CFG.THINK_IDLE);
}
