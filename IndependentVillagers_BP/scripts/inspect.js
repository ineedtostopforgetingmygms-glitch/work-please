// Creative-mode debug view: sneak + interact with a villager to print its inventory and job to chat.
import { PROFESSION_INFO, PROP_PROFESSION, Profession } from "./config.js";
import { peekBrain, stateLabel } from "./brain.js";
import { getInventory, prettyName, summarizeItems } from "./util.js";
import { getWorkstation } from "./jobs/employment.js";
import { getTool } from "./actions.js";

export function isCreative(player) {
  try {
    return String(player.getGameMode()).toLowerCase() === "creative";
  } catch {
    return false;
  }
}

export function showInventory(player, villager) {
  const profession = villager.getProperty(PROP_PROFESSION) ?? Profession.NONE;
  const info = PROFESSION_INFO[profession] ?? PROFESSION_INFO[Profession.NONE];
  const state = stateLabel(peekBrain(villager.id));
  const inv = getInventory(villager);
  const ws = getWorkstation(villager);

  const lines = [
    `§6--- ${villager.nameTag || info.name} §7(${info.name}) §6---`,
    `§7Doing: §f${state ?? "Just hanging around"}`,
  ];
  if (ws) lines.push(`§7Workstation: §f${ws.x}, ${ws.y}, ${ws.z}`);
  const tool = getTool(villager);
  lines.push(`§7Tool: §f${tool ? `${prettyName(tool.id)} (${tool.uses} uses left)` : "bare hands"}`);
  lines.push(`§7Inventory (${inv.size - inv.emptySlotsCount}/${inv.size} slots):`);

  const items = summarizeItems(inv);
  if (items.size === 0) lines.push("§8  (empty)");
  for (const [typeId, amount] of items) lines.push(`§f  ${amount}x ${prettyName(typeId)}`);

  player.sendMessage(lines.join("\n"));
}
