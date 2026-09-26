// World-wide shared state, saved in world dynamic properties:
//  - claims:     which villager owns which workstation block
//  - stockpiles: chests villagers placed, tagged by what they hold. Future builder villagers
//                read these to find wood (see findStockpiles()).
import { world } from "@minecraft/server";
import { WORLD_DP_CLAIMS, WORLD_DP_DEBTS, WORLD_DP_STOCKPILES } from "./config.js";
import { posKey } from "./util.js";

let claims = null;
let stockpiles = null;

function load(key, fallback) {
  try {
    const raw = world.getDynamicProperty(key);
    return typeof raw === "string" ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  world.setDynamicProperty(key, JSON.stringify(value));
}

// ---------- Workstation claims ----------

function getClaims() {
  if (!claims) claims = load(WORLD_DP_CLAIMS, {});
  return claims;
}

export function claimOwner(dimId, p) {
  return getClaims()[posKey(dimId, p)];
}

export function claim(dimId, p, villagerId) {
  getClaims()[posKey(dimId, p)] = villagerId;
  save(WORLD_DP_CLAIMS, claims);
}

export function releaseClaim(dimId, p, villagerId) {
  const c = getClaims();
  const k = posKey(dimId, p);
  if (c[k] !== villagerId) return;
  delete c[k];
  save(WORLD_DP_CLAIMS, c);
}

export function releaseAllClaims(villagerId) {
  const c = getClaims();
  let changed = false;
  for (const k of Object.keys(c)) {
    if (c[k] === villagerId) {
      delete c[k];
      changed = true;
    }
  }
  if (changed) save(WORLD_DP_CLAIMS, c);
}

// ---------- Stockpiles ----------

function getStockpiles() {
  if (!stockpiles) stockpiles = load(WORLD_DP_STOCKPILES, []);
  return stockpiles;
}

export function addStockpile(dimId, p, kind, owner) {
  getStockpiles().push({ d: dimId, x: p.x, y: p.y, z: p.z, kind, owner });
  save(WORLD_DP_STOCKPILES, stockpiles);
}

/** Workstation blocks claimed by villagers, as positions: [{d,x,y,z,owner}] */
export function claimedWorkstations(dimId) {
  const out = [];
  for (const [k, owner] of Object.entries(getClaims())) {
    const [d, x, y, z] = k.split("|");
    if (d === dimId) out.push({ d, x: Number(x), y: Number(y), z: Number(z), owner });
  }
  return out;
}

// ---------- Debts (e.g. a miner borrowing logs from a lumberjack's chest) ----------

let debts = null;
function getDebts() {
  if (!debts) debts = load(WORLD_DP_DEBTS, []);
  return debts;
}

export function addDebt(debt) {
  getDebts().push(debt);
  save(WORLD_DP_DEBTS, debts);
}

export function debtsOf(borrowerId) {
  return getDebts().filter((d) => d.borrower === borrowerId && !d.paid);
}

export function markDebtPaid(debt) {
  debt.paid = true;
  debts = getDebts().filter((d) => !d.paid);
  save(WORLD_DP_DEBTS, debts);
}

export function removeStockpile(dimId, p) {
  const list = getStockpiles();
  const i = list.findIndex((s) => s.d === dimId && s.x === p.x && s.y === p.y && s.z === p.z);
  if (i < 0) return;
  list.splice(i, 1);
  save(WORLD_DP_STOCKPILES, list);
}

/** Stockpiles of a given kind (e.g. "wood") within `radius` blocks of `p`, closest first. */
export function findStockpiles(dimId, p, radius, kind) {
  const r2 = radius * radius;
  return getStockpiles()
    .filter((s) => s.d === dimId && (!kind || s.kind === kind))
    .map((s) => ({ s, d: (s.x - p.x) ** 2 + (s.y - p.y) ** 2 + (s.z - p.z) ** 2 }))
    .filter((e) => e.d <= r2)
    .sort((a, b) => a.d - b.d)
    .map((e) => e.s);
}
