// Names. Every villager gets one of 1000 names (names_data.js), handed out in turn - in an order
// shuffled for each world - so no two villagers share a name until all 1000 have been used. His
// name tag shows his name with his job on the line underneath; a new job only changes that second
// line, never his name. Rename him with a name tag and that becomes his name.
import { world } from "@minecraft/server";
import { PROFESSION_INFO, PROP_PROFESSION } from "./config.js";
import { NAMES } from "./names_data.js";

const DP_NAME = "iv:name"; // on the villager: his name
const DP_TAG = "iv:tag"; // the tag we last put over his head (anything else means a player renamed him)
const WORLD_NEXT = "iv:nameNext"; // how many names this world has handed out
const WORLD_SEED = "iv:nameSeed"; // where in the list this world starts
const STEP = 617; // shares no factor with 1000, so stepping by it visits every name once per 1000

// the job tags villagers wore before they had names ("Miner" isn't a name)
const OLD_TAGS = new Set(Object.values(PROFESSION_INFO).map((p) => p.nameTag).filter(Boolean));

function nextName() {
  let seed = world.getDynamicProperty(WORLD_SEED);
  if (typeof seed !== "number") {
    seed = Math.floor(Math.random() * NAMES.length);
    world.setDynamicProperty(WORLD_SEED, seed);
  }
  const n = world.getDynamicProperty(WORLD_NEXT);
  const i = typeof n === "number" ? n : 0;
  world.setDynamicProperty(WORLD_NEXT, i + 1);
  return NAMES[(seed + i * STEP) % NAMES.length];
}

/** His name (giving him the next one on the list if he hasn't got one yet). */
export function nameOf(villager) {
  const have = villager.getDynamicProperty(DP_NAME);
  if (typeof have === "string" && have) return have;
  const name = nextName();
  villager.setDynamicProperty(DP_NAME, name);
  return name;
}

export function setName(villager, name) {
  villager.setDynamicProperty(DP_NAME, name);
  villager.setDynamicProperty(DP_TAG, undefined);
}

export function jobOf(villager) {
  return PROFESSION_INFO[villager.getProperty(PROP_PROFESSION)]?.name ?? "Villager";
}

/** Puts "Name / Job" over his head (only when it's changed). */
export function updateTag(villager) {
  try {
    const cur = villager.nameTag ?? "";
    // renamed with a name tag (or a vanilla villager's name carried over): that's his name now
    if (cur && cur !== villager.getDynamicProperty(DP_TAG) && !cur.includes("\n") && !OLD_TAGS.has(cur)) {
      villager.setDynamicProperty(DP_NAME, cur);
    }
    const tag = `${nameOf(villager)}\n§7${jobOf(villager)}`;
    if (cur !== tag) {
      villager.nameTag = tag;
      villager.setDynamicProperty(DP_TAG, tag);
    }
  } catch {}
}

/** The first line of a name tag (his name), for logs and screens. */
export function shortName(entity) {
  return (entity?.nameTag ?? "").split("\n")[0];
}
