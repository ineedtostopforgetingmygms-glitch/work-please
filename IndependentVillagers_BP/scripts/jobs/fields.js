// Who farms which field.
//
// A field is a patch of farmland: every tilled block within FARM.GAP of another one is the same
// field. One farmer works one field - if two farmers' composters are next to the same village farm,
// the first one there claims it and the other goes off and lays out a field of his own. Claims are
// saved with the world (so they survive a reload) and released when the farmer dies or changes job.
import { world } from "@minecraft/server";
import { FARM, WORLD_DP_FIELDS } from "../config.js";
import { horizDist, isValid } from "../util.js";

let fields = null; // [{owner, d, x, y, z, r}]

function load() {
  if (fields) return fields;
  try {
    const raw = world.getDynamicProperty(WORLD_DP_FIELDS);
    fields = typeof raw === "string" ? JSON.parse(raw) : [];
  } catch {
    fields = [];
  }
  return fields;
}

function save() {
  try {
    world.setDynamicProperty(WORLD_DP_FIELDS, JSON.stringify(fields ?? []));
  } catch {}
}

/**
 * Other farmers' fields in this dimension. Claims whose owner has died are dropped as we go;
 * one whose owner is simply in an unloaded chunk still stands (he'll be back).
 */
function live(dimId, exceptId) {
  const list = load();
  const keep = [];
  const out = [];
  for (const f of list) {
    const owner = world.getEntity(f.owner);
    if (owner && !isValid(owner)) continue;
    keep.push(f);
    if (f.d === dimId && f.owner !== exceptId) out.push(f);
  }
  if (keep.length !== list.length) {
    fields = keep;
    save();
  }
  return out;
}

/** The field this farmer has claimed, if any. */
export function myField(villagerId) {
  return load().find((f) => f.owner === villagerId);
}

/** Every claim there is (for /scriptevent iv:fields). */
export function fieldClaims() {
  return load();
}

/** Is any of this patch somebody else's field? */
export function claimedByOther(dimId, villagerId, pos, radius = 0) {
  return live(dimId, villagerId).some((f) => horizDist(f, pos) <= f.r + radius);
}

export function claimField(villager, dimId, cluster) {
  fields = load().filter((f) => f.owner !== villager.id);
  fields.push({ owner: villager.id, d: dimId, x: cluster.x, y: cluster.y, z: cluster.z, r: cluster.r });
  save();
}

export function releaseFields(villagerId) {
  const list = load();
  if (!list.some((f) => f.owner === villagerId)) return;
  fields = list.filter((f) => f.owner !== villagerId);
  save();
}

/**
 * Groups farmland positions into fields: anything within FARM.GAP of a block already in the group
 * belongs to the same field (so a village farm split by its water channel is still one field, but
 * two patches on either side of the village aren't).
 * @returns [{x, y, z, r, n, land:[]}] middle, radius, how many tilled blocks - biggest first
 */
export function clusterFields(land) {
  const gap = FARM.GAP;
  // one tilled block per column, so a x|z map is enough to look up the neighbours of a block
  const left = new Map();
  for (const p of land) left.set(`${p.x}|${p.z}`, p);
  const out = [];
  for (const start of land) {
    const k0 = `${start.x}|${start.z}`;
    if (!left.has(k0)) continue;
    left.delete(k0);
    const group = [start];
    // grow the group: anything close to a block we've already taken joins it
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      for (let dx = -gap; dx <= gap; dx++) {
        for (let dz = -gap; dz <= gap; dz++) {
          const k = `${a.x + dx}|${a.z + dz}`;
          const p = left.get(k);
          if (!p || Math.abs(p.y - a.y) > 2) continue;
          left.delete(k);
          group.push(p);
        }
      }
    }
    if (group.length < FARM.MIN_FIELD) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const p of group) {
      sx += p.x;
      sy += p.y;
      sz += p.z;
    }
    const mid = { x: Math.round(sx / group.length), y: Math.round(sy / group.length), z: Math.round(sz / group.length) };
    let r = 2;
    for (const p of group) r = Math.max(r, Math.abs(p.x - mid.x), Math.abs(p.z - mid.z));
    out.push({ ...mid, r: r + 1, n: group.length, land: group });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** Is this block part of the field he's claimed? */
export function inField(field, p) {
  return !!field && horizDist(field, p) <= field.r + 1 && Math.abs(field.y - p.y) <= 4;
}
