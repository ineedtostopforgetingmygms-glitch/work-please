// Creative players: crouch + look at a villager + interact = open his REAL inventory.
//
// Scripts can't open inventory screens, but the game opens an entity's inventory when you click
// it. So while a creative player crouches and looks at a villager, we put an invisible
// "inventory window" entity (iv:inventory_view) over him, slightly bigger so the click lands on
// it, holding a copy of his 27 slots. Whatever the player changes there is written back to the
// villager every few ticks; when the player walks off, it syncs one last time and disappears
// (emptied first, so nothing ever drops or gets duplicated).
import { ItemStack, system, world } from "@minecraft/server";
import { PROFESSION_INFO, PROP_PROFESSION, Profession, VILLAGER_ID } from "./config.js";
import { peekBrain, stateLabel } from "./brain.js";
import { getTool } from "./actions.js";
import { isCreative } from "./inspect.js";
import { getInventory, isValid, prettyName } from "./util.js";

export const VIEW_ID = "iv:inventory_view";

const sessions = new Map(); // player id -> session
const inspected = new Set(); // villager ids currently open (their brains pause)

export function isBeingInspected(villagerId) {
  return inspected.has(villagerId);
}

function copyAll(from, to) {
  for (let i = 0; i < Math.min(from.size, to.size); i++) to.setItem(i, from.getItem(i));
}

/** A fingerprint of every slot, to see which side changed. */
function signature(container) {
  const out = [];
  for (let i = 0; i < container.size; i++) {
    const it = container.getItem(i);
    let dmg = "";
    try {
      dmg = it?.getComponent("minecraft:durability")?.damage ?? "";
    } catch {}
    out.push(it ? `${it.typeId}x${it.amount}d${dmg}` : "");
  }
  return out.join("|");
}

/** Two-way sync: whichever side changed since last time wins. */
function sync(s) {
  const viewInv = getInventory(s.view);
  const villInv = getInventory(s.villager);
  const v = signature(viewInv);
  if (v !== s.snap) {
    copyAll(viewInv, villInv); // the player moved something in the window
    s.snap = v;
    return;
  }
  const l = signature(villInv);
  if (l !== s.snap) {
    copyAll(villInv, viewInv);
    s.snap = l;
  }
}

function lookedAtVillager(player, session) {
  let hits = [];
  try {
    hits = player.getEntitiesFromViewDirection({ maxDistance: 6 });
  } catch {}
  for (const { entity } of hits) {
    if (entity.typeId === VILLAGER_ID) return entity;
    if (entity.typeId === VIEW_ID && session?.view.id === entity.id) return session.villager;
  }
  return undefined;
}

function start(player, villager) {
  if ([...sessions.values()].some((s) => s.villager.id === villager.id)) return; // someone else has him open
  const view = villager.dimension.spawnEntity(VIEW_ID, villager.location);
  copyAll(getInventory(villager), getInventory(view));
  const snap = signature(getInventory(view));
  sessions.set(player.id, { player, villager, view, snap, opened: false, openPos: null, lastSeen: system.currentTick });
  inspected.add(villager.id);
}

function end(playerId) {
  const s = sessions.get(playerId);
  sessions.delete(playerId);
  if (!s) return;
  inspected.delete(s.villager.id);
  try {
    if (isValid(s.villager)) sync(s); // keep the player's last edits
    const viewInv = getInventory(s.view);
    for (let i = 0; i < viewInv.size; i++) viewInv.setItem(i); // empty it so nothing can drop or duplicate
    s.view.remove();
  } catch {}
}

function statusLine(villager) {
  const prof = villager.getProperty(PROP_PROFESSION) ?? Profession.NONE;
  const state = stateLabel(peekBrain(villager.id));
  const tools = [getTool(villager, "axe")?.id, getTool(villager, "pickaxe")?.id].filter(Boolean).map(prettyName);
  return `§6${villager.nameTag || PROFESSION_INFO[prof]?.name}§r - ${state ?? "resting"} §7| tools: ${tools.join(", ") || "none"} | bottom row = shop stock`;
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const player of world.getPlayers()) {
    const s = sessions.get(player.id);
    const eligible = isCreative(player) && player.isSneaking;
    const looked = eligible ? lookedAtVillager(player, s) : undefined;

    if (!s) {
      if (looked) start(player, looked);
      continue;
    }
    if (!isValid(s.villager) || !isValid(s.view) || !isCreative(player)) {
      end(player.id);
      continue;
    }

    // keep the window glued to him (he's paused, but he might get pushed)
    try {
      s.view.teleport(s.villager.location);
    } catch {}

    sync(s); // edits in the window go straight into his real inventory

    if (s.opened) {
      // players can't move with an inventory screen open - once they walk away, it's closed
      const p = player.location;
      const moved = Math.hypot(p.x - s.openPos.x, p.z - s.openPos.z) > 0.4 || Math.abs(p.y - s.openPos.y) > 0.5;
      if (moved || now - s.openedAt > 20 * 300) end(player.id);
    } else if (looked?.id === s.villager.id) {
      s.lastSeen = now;
    } else if (now - s.lastSeen > 10) {
      end(player.id); // stopped crouching / looked away without opening it
    }
  }

  // tidy up windows left over from a reload
  if (now % 100 === 0) {
    const live = new Set([...sessions.values()].map((s) => s.view.id));
    for (const dimId of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
      try {
        for (const e of world.getDimension(dimId).getEntities({ type: VIEW_ID })) {
          if (live.has(e.id)) continue;
          const inv = getInventory(e);
          for (let i = 0; i < inv.size; i++) inv.setItem(i);
          e.remove();
        }
      } catch {}
    }
  }
}, 2);

// Clicking the window opens the real inventory screen (vanilla) - remember where they stood.
world.afterEvents.playerInteractWithEntity.subscribe((ev) => {
  if (ev.target?.typeId !== VIEW_ID) return;
  const s = sessions.get(ev.player.id);
  if (!s || s.view.id !== ev.target.id) return;
  s.opened = true;
  s.openedAt = system.currentTick;
  s.openPos = { ...ev.player.location };
  try {
    ev.player.onScreenDisplay.setActionBar(statusLine(s.villager));
  } catch {}
});

world.afterEvents.playerLeave.subscribe((ev) => end(ev.playerId));

/**
 * Self-test of the sync code (used by /scriptevent iv:viewtest): opens a window on the villager,
 * edits it the way a player would (adds, removes, changes amounts), and checks that his real
 * inventory follows - including when the window closes.
 */
export function viewSelfTest(villager, say) {
  const fake = "iv:selftest";
  const view = villager.dimension.spawnEntity(VIEW_ID, villager.location);
  const villInv = getInventory(villager);
  copyAll(villInv, getInventory(view));
  const s = { player: null, villager, view, snap: signature(getInventory(view)) };
  sessions.set(fake, s);
  inspected.add(villager.id);
  const viewInv = getInventory(view);
  const results = [];
  const check = (label, ok) => results.push(`${ok ? "PASS" : "FAIL"} ${label}`);

  // 1. player puts 5 diamonds into an empty slot
  const empty = [...Array(18).keys()].find((i) => !viewInv.getItem(i));
  viewInv.setItem(empty, new ItemStack("minecraft:diamond", 5));
  sync(s);
  check(`added 5 diamonds -> villager slot ${empty}: ${villInv.getItem(empty)?.typeId} x${villInv.getItem(empty)?.amount}`, villInv.getItem(empty)?.typeId === "minecraft:diamond" && villInv.getItem(empty)?.amount === 5);

  // 2. player takes 2 of them back
  const d = viewInv.getItem(empty);
  d.amount = 3;
  viewInv.setItem(empty, d);
  sync(s);
  check(`took 2 back -> villager has x${villInv.getItem(empty)?.amount}`, villInv.getItem(empty)?.amount === 3);

  // 3. player takes the emeralds out completely
  const emeraldSlot = [...Array(viewInv.size).keys()].find((i) => viewInv.getItem(i)?.typeId === "minecraft:emerald");
  if (emeraldSlot !== undefined) {
    viewInv.setItem(emeraldSlot);
    sync(s);
    check(`removed emeralds -> villager slot ${emeraldSlot} empty`, !villInv.getItem(emeraldSlot));
  }

  // 4. player drops a stack into the shop row (bottom row)
  viewInv.setItem(20, new ItemStack("minecraft:oak_log", 16));
  sync(s);
  check(`put 16 oak logs in shop slot 20 -> villager: ${villInv.getItem(20)?.typeId} x${villInv.getItem(20)?.amount}`, villInv.getItem(20)?.amount === 16);

  // 5. the villager's own change shows up in the window
  villInv.setItem(1, new ItemStack("minecraft:apple", 2));
  sync(s);
  check(`villager got 2 apples -> window shows x${viewInv.getItem(1)?.amount}`, viewInv.getItem(1)?.typeId === "minecraft:apple");

  // 6. last-second edit, then the window closes
  viewInv.setItem(2, new ItemStack("minecraft:gold_ingot", 7));
  end(fake);
  check(`edit right before closing kept: ${villInv.getItem(2)?.typeId} x${villInv.getItem(2)?.amount}`, villInv.getItem(2)?.typeId === "minecraft:gold_ingot");
  check("window removed", !isValid(view));

  for (const r of results) say(`[IV] viewtest: ${r}`);
}
