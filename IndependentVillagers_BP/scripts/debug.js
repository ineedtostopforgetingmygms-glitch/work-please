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
  const tag = entity ? `${entity.nameTag || "villager"}#${String(entity.id).slice(-4)}` : "iv";
  console.warn(`[IV] ${tag}: ${msg}`);
}
