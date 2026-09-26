// Plot buying for the auto-generated Plot2 segments.
//
// Every plot has a station in the middle of its walkway wall: a concrete lamp (lime = for sale,
// red = sold) with a button on each side of it.
//   click                  -> for sale: confirm and buy it for PRICE on the MONEY scoreboard
//                             walkway side: owner and added players are teleported in
//                             plot side: teleported out to the walkway
//   shift + click (owner)  -> plot menu: add online players, remove players, add/remove by
//                             name, combine with a neighbouring plot you also own
// A station only works when it sits in the real structure: a border block 3 below the lamp and
// a deny block under the walkway next to it. Players can't get those blocks, so they can't
// build fake stations. Plot data lives in world dynamic properties keyed by the station's
// position, so there are no marker entities and no command blocks. The lamp is the proof of a
// sale: an owned plot whose lamp is lime again was re-pasted, so its old data is dropped.
import { world, BlockPermutation } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const PRICE = 10000;
const MONEY = "c";

const BUTTON = "minecraft:polished_blackstone_button";
const FOR_SALE = "minecraft:lime_concrete";
const SOLD = "minecraft:red_concrete";
const UNDER_WALL = "minecraft:border_block"; // 3 below the lamp
const UNDER_WALKWAY = "minecraft:deny"; // 3 below the walkway-side button

// A button's facing_direction points from the block it hangs on towards the button.
const FACING = { 2: { x: 0, z: -1 }, 3: { x: 0, z: 1 }, 4: { x: -1, z: 0 }, 5: { x: 1, z: 0 } };

// Distance from the station's wall to where players are teleported.
const INSIDE_DISTANCE = 3;
const OUTSIDE_DISTANCE = 2;

// Segment layout (see plots/build_plot2.py): segments repeat every 26 blocks along x, the lamp
// sits in the middle (13 blocks from the shared wall column), plots are 25 deep, and the lamp is
// at local y28 above a ground column that starts at local y0.
const SEGMENT = 26;
const LAMP_TO_EDGE = 13;
const PLOT_DEPTH = 25;
const LAMP_Y = 28;
// Ground to put in the wall column when two plots are combined, by local y.
function groundAt(y) {
  if (y === 0) return "minecraft:allow";
  if (y <= 10) return "minecraft:deepslate";
  if (y <= 23) return "minecraft:stone";
  if (y <= 25) return "minecraft:dirt";
  if (y === 26) return "minecraft:grass_block";
  return "minecraft:air";
}

// ---- plot data: { owner: {id, name}, members: [{name, id?}], links: [plot keys] } ----

function keyOf(host) {
  return `plot:${host.dimension.id}:${host.x},${host.y},${host.z}`;
}

function loadPlot(key) {
  const raw = world.getDynamicProperty(key);
  if (typeof raw !== "string") return undefined;
  const plot = JSON.parse(raw);
  plot.members ??= [];
  plot.links ??= [];
  return plot;
}

function savePlot(key, plot) {
  world.setDynamicProperty(key, JSON.stringify(plot));
}

// Forget a plot (and unlink it from plots it was combined with).
function clearPlot(key) {
  for (const k of loadPlot(key)?.links ?? []) {
    const p = loadPlot(k);
    if (!p) continue;
    p.links = p.links.filter((l) => l !== key);
    savePlot(k, p);
  }
  world.setDynamicProperty(key, undefined);
}

// Keys of this plot and every plot combined with it.
function groupOf(key) {
  const seen = new Set([key]);
  const todo = [key];
  while (todo.length) {
    for (const next of loadPlot(todo.pop())?.links ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
    }
  }
  return [...seen];
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function isOwner(plot, player) {
  return plot.owner.id === player.id;
}

function findMember(plot, player) {
  return plot.members.find((m) => m.id === player.id || (!m.id && sameName(m.name, player.name)));
}

// ---- world helpers ----

function blockAt(dimension, x, y, z) {
  try {
    return dimension.getBlock({ x, y, z });
  } catch {
    return undefined; // outside the world or not loaded
  }
}

// If `lamp` is a real station, returns the direction from the lamp towards its walkway.
function stationWalkway(lamp) {
  if (lamp?.typeId !== FOR_SALE && lamp?.typeId !== SOLD) return undefined;
  const dim = lamp.dimension;
  if (blockAt(dim, lamp.x, lamp.y - 3, lamp.z)?.typeId !== UNDER_WALL) return undefined;
  for (const d of [{ x: 0, z: 1 }, { x: 0, z: -1 }]) {
    if (blockAt(dim, lamp.x + d.x, lamp.y - 3, lamp.z + d.z)?.typeId === UNDER_WALKWAY) return d;
  }
  return undefined;
}

function getBalance(objective, player) {
  try {
    return objective.getScore(player) ?? 0;
  } catch {
    return 0; // player has never had a score on this objective
  }
}

// Teleport `steps` blocks away from the wall in direction `dir`. No rotation is passed, so the
// player keeps looking where they were looking.
function sendFromWall(player, host, dir, steps) {
  player.teleport(
    { x: host.x + dir.x * steps + 0.5, y: host.y, z: host.z + dir.z * steps + 0.5 },
    { dimension: host.dimension }
  );
}

async function show(form, player) {
  // Forms can't open while the player is in another screen; retry briefly.
  for (let i = 0; i < 10; i++) {
    const res = await form.show(player);
    if (res.cancelationReason !== "UserBusy") return res;
  }
  return { canceled: true };
}

// ---- buying ----

function buy(player, key, lamp) {
  const objective = world.scoreboard.getObjective(MONEY);
  if (!objective) {
    player.sendMessage(`§cThe ${MONEY} scoreboard doesn't exist.`);
    return false;
  }
  const balance = getBalance(objective, player);
  if (balance < PRICE) {
    player.sendMessage(`§cThis plot costs §6${PRICE} ${MONEY}§c. You only have §6${balance} ${MONEY}§c.`);
    return false;
  }
  objective.addScore(player, -PRICE);
  savePlot(key, { owner: { id: player.id, name: player.name }, members: [], links: [] });
  lamp.setPermutation(BlockPermutation.resolve(SOLD));
  player.sendMessage(`§aYou bought this plot for §6${PRICE} ${MONEY}§a!`);
  return true;
}

async function confirmBuy(player, host, lamp, into) {
  const res = await show(
    new ActionFormData()
      .title("Plot for sale")
      .body(`Buy this plot for §6${PRICE} ${MONEY}§r?`)
      .button(`Buy for ${PRICE} ${MONEY}`)
      .button("Cancel"),
    player
  );
  if (res.canceled || res.selection !== 0) return;
  // The plot may have been bought by someone else while the form was open.
  if (loadPlot(keyOf(host))) {
    player.sendMessage("§cSomeone else just bought this plot.");
    return;
  }
  if (buy(player, keyOf(host), lamp)) sendFromWall(player, host, into, INSIDE_DISTANCE);
}

// ---- members (shared by every plot in a combined group) ----

function addMember(player, key, name, id) {
  name = name.trim();
  if (!name) return;
  const plot = loadPlot(key);
  if (sameName(name, plot.owner.name)) {
    player.sendMessage("§cYou already own this plot.");
    return;
  }
  if (plot.members.some((m) => sameName(m.name, name))) {
    player.sendMessage(`§e${name} is already added.`);
    return;
  }
  for (const k of groupOf(key)) {
    const p = loadPlot(k);
    if (!p.members.some((m) => sameName(m.name, name))) p.members.push(id ? { name, id } : { name });
    savePlot(k, p);
  }
  player.sendMessage(`§aAdded §f${name}§a to this plot.`);
}

function removeMember(player, key, name) {
  name = name.trim();
  if (!loadPlot(key).members.some((m) => sameName(m.name, name))) {
    player.sendMessage(`§c${name} isn't added to this plot.`);
    return;
  }
  for (const k of groupOf(key)) {
    const p = loadPlot(k);
    p.members = p.members.filter((m) => !sameName(m.name, name));
    savePlot(k, p);
  }
  player.sendMessage(`§aRemoved §f${name}§a from this plot.`);
}

// ---- combining ----

// Neighbouring stations (one segment east and west) that the same player owns and that
// aren't combined with this plot yet.
function combinableNeighbours(player, lamp, key) {
  const group = groupOf(key);
  const found = [];
  for (const [side, dx] of [["east", 1], ["west", -1]]) {
    const other = blockAt(lamp.dimension, lamp.x + dx * SEGMENT, lamp.y, lamp.z);
    if (!stationWalkway(other)) continue;
    const otherKey = keyOf(other.below());
    const otherPlot = loadPlot(otherKey);
    if (!otherPlot || !isOwner(otherPlot, player) || group.includes(otherKey)) continue;
    found.push({ side, dx, otherKey });
  }
  return found;
}

function combine(player, lamp, key, plotDir, { dx, otherKey }) {
  // Replace the shared wall column (wall, curb, border and the gap below) with plot ground.
  const dim = lamp.dimension;
  const x = lamp.x + dx * LAMP_TO_EDGE;
  const baseY = lamp.y - LAMP_Y;
  for (let i = 1; i <= PLOT_DEPTH; i++) {
    const z = lamp.z + plotDir.z * i;
    for (let y = 0; y <= LAMP_Y; y++) {
      blockAt(dim, x, baseY + y, z)?.setPermutation(BlockPermutation.resolve(groundAt(y)));
    }
  }

  // Link the plots and give the whole group the same members.
  const group = [...new Set([...groupOf(key), ...groupOf(otherKey)])];
  const members = [];
  for (const k of group) {
    for (const m of loadPlot(k).members) {
      const known = members.find((x) => sameName(x.name, m.name));
      if (!known) members.push({ ...m });
      else if (!known.id && m.id) known.id = m.id;
    }
  }
  for (const k of group) {
    const p = loadPlot(k);
    if (k === key && !p.links.includes(otherKey)) p.links.push(otherKey);
    if (k === otherKey && !p.links.includes(key)) p.links.push(key);
    p.members = members.map((m) => ({ ...m }));
    savePlot(k, p);
  }
  player.sendMessage("§aPlots combined!");
}

// ---- owner menu ----

async function ownerMenu(player, lamp, plotDir) {
  const key = keyOf(lamp.below());
  const plot = loadPlot(key);
  const neighbours = combinableNeighbours(player, lamp, key);
  const list = plot.members.length ? plot.members.map((m) => m.name).join(", ") : "nobody yet";

  const form = new ActionFormData()
    .title("Your plot")
    .body(`Players who can enter: §f${list}`)
    .button("Add online player")
    .button("Remove player")
    .button("Add or remove by username");
  for (const n of neighbours) form.button(`Combine with the plot to the ${n.side}`);
  const res = await show(form, player);
  if (res.canceled) return;

  if (res.selection === 0) {
    const online = world
      .getAllPlayers()
      .filter((p) => !isOwner(plot, p) && !plot.members.some((m) => sameName(m.name, p.name)));
    if (!online.length) {
      player.sendMessage("§eNo other online players to add.");
      return;
    }
    const pick = await show(
      new ModalFormData().title("Add online player").dropdown("Player", online.map((p) => p.name)),
      player
    );
    if (!pick.canceled) addMember(player, key, online[pick.formValues[0]].name, online[pick.formValues[0]].id);
  } else if (res.selection === 1) {
    if (!plot.members.length) {
      player.sendMessage("§eNobody is added to this plot.");
      return;
    }
    const pick = await show(
      new ModalFormData().title("Remove player").dropdown("Player", plot.members.map((m) => m.name)),
      player
    );
    if (!pick.canceled) removeMember(player, key, plot.members[pick.formValues[0]].name);
  } else if (res.selection === 2) {
    const pick = await show(
      new ModalFormData()
        .title("Add or remove by username")
        .textField("Exact username", "Steve")
        .dropdown("Action", ["Add", "Remove"]),
      player
    );
    if (pick.canceled) return;
    const [name, action] = pick.formValues;
    if (action === 0) addMember(player, key, name);
    else removeMember(player, key, name);
  } else {
    const n = neighbours[res.selection - 3];
    const confirm = await show(
      new ActionFormData()
        .title("Combine plots")
        .body(`Remove the wall between this plot and your plot to the ${n.side}? This can't be undone.`)
        .button("Combine")
        .button("Cancel"),
      player
    );
    // Re-check: ownership may have changed while the forms were open.
    if (confirm.canceled || confirm.selection !== 0) return;
    const still = combinableNeighbours(player, lamp, key).find((m) => m.otherKey === n.otherKey);
    if (!still || !isOwner(loadPlot(key), player)) return;
    combine(player, lamp, key, plotDir, still);
  }
}

// ---- button presses ----

world.afterEvents.buttonPush.subscribe(({ block, source }) => {
  if (source?.typeId !== "minecraft:player" || block.typeId !== BUTTON) return;

  const face = FACING[block.permutation.getState("facing_direction")];
  if (!face) return;
  const lamp = blockAt(block.dimension, block.x - face.x, block.y, block.z - face.z);
  const walkway = stationWalkway(lamp);
  if (!walkway) return; // not a real plot station

  const player = source;
  const plotDir = { x: -walkway.x, z: -walkway.z };
  const fromWalkway = face.x === walkway.x && face.z === walkway.z;
  const host = lamp.below(); // the wall block under the lamp; plot data is keyed by it
  const key = keyOf(host);
  let plot = loadPlot(key);
  if (plot && lamp.typeId === FOR_SALE) {
    // A lime lamp on an owned plot means the segment was pasted again (plot reset), so the old
    // owner data no longer belongs to what's there. The plot is for sale again.
    clearPlot(key);
    plot = undefined;
  }

  if (player.isSneaking && plot && isOwner(plot, player)) {
    ownerMenu(player, lamp, plotDir);
    return;
  }

  if (!fromWalkway) {
    sendFromWall(player, host, walkway, OUTSIDE_DISTANCE);
    return;
  }

  if (plot) {
    const member = findMember(plot, player);
    if (isOwner(plot, player) || member) {
      if (member && !member.id) {
        // First visit of a player added by name: remember who they are across the group.
        for (const k of groupOf(key)) {
          const p = loadPlot(k);
          const m = findMember(p, player);
          if (m) Object.assign(m, { id: player.id, name: player.name });
          savePlot(k, p);
        }
      }
      sendFromWall(player, host, plotDir, INSIDE_DISTANCE);
    } else {
      player.sendMessage(`§cThis plot is owned by §f${plot.owner.name}§c.`);
    }
    return;
  }
  confirmBuy(player, host, lamp, plotDir);
});
