// Getting and losing jobs.
import { DP_WORKSTATION, PROFESSION_INFO, PROP_PROFESSION, Profession } from "../config.js";
import { claim, claimOwner, releaseAllClaims } from "../registry.js";
import { releaseFields } from "./fields.js";
import { setState, setWorking } from "../brain.js";
import { holdItem } from "../actions.js";
import { navStop } from "../nav.js";
import { debugLog } from "../debug.js";
import { center, particle, playSound } from "../util.js";

/** @returns {{d:string,x:number,y:number,z:number}|undefined} */
export function getWorkstation(villager) {
  const raw = villager.getDynamicProperty(DP_WORKSTATION);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Is this villager really the one registered at its workstation? (Only one villager per job
 * block: if the claim belongs to someone else, this villager has to find another job.)
 */
export function ownsWorkstation(villager, ws) {
  const owner = claimOwner(ws.d, ws);
  return !owner || owner === villager.id;
}

function isDefaultNameTag(tag) {
  return !tag || Object.values(PROFESSION_INFO).some((p) => p.nameTag === tag);
}

export function employ(villager, dim, brain, pos, profession) {
  releaseAllClaims(villager.id);
  claim(dim.id, pos, villager.id);
  villager.setDynamicProperty(DP_WORKSTATION, JSON.stringify({ d: dim.id, x: pos.x, y: pos.y, z: pos.z }));
  villager.setProperty(PROP_PROFESSION, profession);
  if (isDefaultNameTag(villager.nameTag)) villager.nameTag = PROFESSION_INFO[profession].nameTag;

  const head = { x: villager.location.x, y: villager.location.y + 2.1, z: villager.location.z };
  for (let i = 0; i < 5; i++) particle(dim, "minecraft:villager_happy", head);
  particle(dim, "minecraft:villager_happy", center(pos));
  playSound(dim, "mob.villager.yes", villager.location);
  debugLog(villager, `became a ${PROFESSION_INFO[profession].name} at ${pos.x} ${pos.y} ${pos.z}`);

  brain.job = null;
  brain.scan = null;
  brain.joblessSince = null;
  setState(villager, brain, "seek");
}

export function unemploy(villager, dim, brain, upset = false) {
  releaseAllClaims(villager.id);
  releaseFields(villager.id); // his field is somebody else's now
  navStop(villager, brain);
  villager.setDynamicProperty(DP_WORKSTATION, undefined);
  villager.setProperty(PROP_PROFESSION, Profession.NONE);
  setWorking(villager, false);
  holdItem(villager, undefined);
  if (isDefaultNameTag(villager.nameTag)) villager.nameTag = "";

  if (upset) {
    particle(dim, "minecraft:villager_angry", { x: villager.location.x, y: villager.location.y + 2.1, z: villager.location.z });
    playSound(dim, "mob.villager.no", villager.location);
  }
  debugLog(villager, "lost their job");

  brain.job = null;
  brain.action = null;
  brain.scan = null;
  brain.joblessSince = null;
  setState(villager, brain, "jobless");
}
