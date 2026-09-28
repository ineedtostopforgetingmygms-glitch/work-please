// Debug output. Toggle with:  /scriptevent iv:debug on   (or off)
// Dump every villager:        /scriptevent iv:status
let enabled = false;

export function setDebug(on) {
  enabled = on;
}

export function isDebug() {
  return enabled;
}

export function debugLog(entity, msg) {
  if (!enabled) return;
  // "Chester (Miner)#1017" - his name, his job, and the end of his id
  const [name, job] = (entity?.nameTag ?? "").split("\n");
  const tag = entity ? `${job ? `${job.replace(/§./g, "")} ` : ""}${name || "villager"}#${String(entity.id).slice(-4)}` : "iv";
  console.warn(`[IV] ${tag}: ${msg}`);
}
