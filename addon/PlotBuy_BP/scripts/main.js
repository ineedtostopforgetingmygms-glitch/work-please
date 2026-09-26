// Plot buying for the auto-generated Plot2 segments.
//
// Every plot has a buy station on its walkway wall: a polished blackstone bricks block with a
// button on each side and a lamp on top (lime = for sale, red = sold).
//   walkway-side button, plot for sale -> buy it if the player has PRICE on the MONEY scoreboard
//   walkway-side button, plot sold     -> owner and members are teleported in, others get a message
//   plot-side button                   -> owner gets the plot menu, anyone else is sent out
// Plot data lives in world dynamic properties keyed by the station's position, so there are
// no marker entities and no command blocks. A player can own any number of plots.
import { world, BlockPermutation } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const PRICE = 10000;
const MONEY = "c";

const BUTTON = "minecraft:polished_blackstone_button";
const HOST = "minecraft:polished_blackstone_bricks";
const FOR_SALE = "minecraft:lime_concrete";
const SOLD = "minecraft:red_concrete";
const WALKWAY_FLOOR = "minecraft:deepslate_tiles";

// A button's facing_direction points from the block it hangs on towards the button.
const FACING = { 2: { x: 0, z: -1 }, 3: { x: 0, z: 1 }, 4: { x: -1, z: 0 }, 5: { x: 1, z: 0 } };

// Distance from the station's wall to where players are teleported.
const INSIDE_DISTANCE = 3;
const OUTSIDE_DISTANCE = 2;

// ---- plot data: { owner: {id, name}, members: [{name, id?}] } ----

function plotKey(host) {
  return `plot:${host.dimension.id}:${host.x},${host.y},${host.z}`;
}

function loadPlot(host) {
  const raw = world.getDynamicProperty(plotKey(host));
  if (typeof raw !== "string") return undefined;
  const plot = JSON.parse(raw);
  plot.members ??= [];
  return plot;
}

function savePlot(host, plot) {
  world.setDynamicProperty(plotKey(host), JSON.stringify(plot));
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function isOwner(plot, player) {
  return plot.owner.id === player.id;
}

function findMember(plot, player) {
  return plot.members.find((m) => m.id === player.id || (!m.id && sameName(m.name, player.name)));
}

// ---- actions ----

function getBalance(objective, player) {
  try {
    return objective.getScore(player) ?? 0;
  } catch {
    return 0; // player has never had a score on this objective
  }
}

// Teleport `steps` blocks away from the wall in direction `dir`, facing further that way.
function sendFromWall(player, host, dir, steps) {
  const x = host.x + dir.x * steps + 0.5;
  const z = host.z + dir.z * steps + 0.5;
  player.teleport(
    { x, y: host.y, z },
    { dimension: host.dimension, facingLocation: { x: x + dir.x * 5, y: host.y + 1.6, z: z + dir.z * 5 } }
  );
}

function buy(player, host, lamp) {
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
  savePlot(host, { owner: { id: player.id, name: player.name }, members: [] });
  lamp.setPermutation(BlockPermutation.resolve(SOLD));
  player.sendMessage(`§aYou bought this plot for §6${PRICE} ${MONEY}§a!`);
  return true;
}

// ---- owner menu ----

async function show(form, player) {
  // Forms can't open while the player is in another screen; retry briefly.
  for (let i = 0; i < 10; i++) {
    const res = await form.show(player);
    if (res.cancelationReason !== "UserBusy") return res;
  }
  return { canceled: true };
}

function addMember(player, host, name, id) {
  const plot = loadPlot(host);
  name = name.trim();
  if (!name) return;
  if (sameName(name, plot.owner.name)) {
    player.sendMessage("§cYou already own this plot.");
  } else if (plot.members.some((m) => sameName(m.name, name))) {
    player.sendMessage(`§e${name} is already added.`);
  } else {
    plot.members.push(id ? { name, id } : { name });
    savePlot(host, plot);
    player.sendMessage(`§aAdded §f${name}§a to this plot.`);
  }
}

function removeMember(player, host, name) {
  const plot = loadPlot(host);
  const before = plot.members.length;
  plot.members = plot.members.filter((m) => !sameName(m.name, name.trim()));
  if (plot.members.length === before) {
    player.sendMessage(`§c${name.trim()} isn't added to this plot.`);
    return;
  }
  savePlot(host, plot);
  player.sendMessage(`§aRemoved §f${name.trim()}§a from this plot.`);
}

async function ownerMenu(player, host, out) {
  const plot = loadPlot(host);
  const list = plot.members.length ? plot.members.map((m) => m.name).join(", ") : "nobody yet";
  const res = await show(
    new ActionFormData()
      .title("Your plot")
      .body(`Players who can enter: §f${list}`)
      .button("Leave plot")
      .button("Add online player")
      .button("Remove player")
      .button("Add or remove by username"),
    player
  );
  if (res.canceled) return;

  if (res.selection === 0) {
    sendFromWall(player, host, out, OUTSIDE_DISTANCE);
  } else if (res.selection === 1) {
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
    if (!pick.canceled) addMember(player, host, online[pick.formValues[0]].name, online[pick.formValues[0]].id);
  } else if (res.selection === 2) {
    if (!plot.members.length) {
      player.sendMessage("§eNobody is added to this plot.");
      return;
    }
    const pick = await show(
      new ModalFormData().title("Remove player").dropdown("Player", plot.members.map((m) => m.name)),
      player
    );
    if (!pick.canceled) removeMember(player, host, plot.members[pick.formValues[0]].name);
  } else if (res.selection === 3) {
    const pick = await show(
      new ModalFormData()
        .title("Add or remove by username")
        .textField("Exact username", "Steve")
        .dropdown("Action", ["Add", "Remove"]),
      player
    );
    if (pick.canceled) return;
    const [name, action] = pick.formValues;
    if (action === 0) addMember(player, host, name);
    else removeMember(player, host, name);
  }
}

// ---- button presses ----

world.afterEvents.buttonPush.subscribe(({ block, source }) => {
  if (source?.typeId !== "minecraft:player" || block.typeId !== BUTTON) return;

  const out = FACING[block.permutation.getState("facing_direction")];
  if (!out) return;
  const host = block.dimension.getBlock({ x: block.x - out.x, y: block.y, z: block.z - out.z });
  const lamp = host?.above();
  if (host?.typeId !== HOST || (lamp?.typeId !== FOR_SALE && lamp?.typeId !== SOLD)) return;

  const player = source;
  const back = { x: -out.x, z: -out.z }; // from the wall through to the other side
  const plot = loadPlot(host);

  if (block.below()?.typeId !== WALKWAY_FLOOR) {
    // Pressed from inside the plot: the owner gets the menu, anyone else is sent out.
    if (plot && isOwner(plot, player)) ownerMenu(player, host, back);
    else sendFromWall(player, host, back, OUTSIDE_DISTANCE);
    return;
  }

  if (plot) {
    const member = findMember(plot, player);
    if (isOwner(plot, player) || member) {
      if (member && !member.id) {
        member.id = player.id; // first visit of a player added by name
        member.name = player.name;
        savePlot(host, plot);
      }
      sendFromWall(player, host, back, INSIDE_DISTANCE);
    } else {
      player.sendMessage(`§cThis plot is owned by §f${plot.owner.name}§c.`);
    }
    return;
  }
  if (lamp.typeId === SOLD) {
    player.sendMessage("§cThis plot is already owned.");
    return;
  }
  if (buy(player, host, lamp)) sendFromWall(player, host, back, INSIDE_DISTANCE);
});
