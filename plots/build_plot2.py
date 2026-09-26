"""Adds the plot buying system to Plot2.original.mcstructure and writes Plot2.mcstructure.

Run from this folder:  python3 build_plot2.py

Local coordinates used below (x 0..26, y 0..28, z 0..58):
  plot A      x1-25, z1-25   (grass at y26)
  walkway     z27-31         (tiles at y26, players stand at y27)
  plot B      x1-25, z33-57
  plot walls  y27 on rows z26 and z32, on top of the curb row at y26
Every plot gets one buy station on its walkway-side wall at x=9.
"""
import copy

import nbt
from nbt import BYTE, INT, LONG, LIST, STRING, COMPOUND

SRC, DST = "Plot2.original.mcstructure", "Plot2.mcstructure"

PRICE = 10000
MONEY = "c"                  # the currency scoreboard
STATION_X = 9                # x of the button / impulse command block
CHAIN_END_X = 25             # last chain block (x26 is shared with the next segment)

EAST, NORTH, SOUTH = 5, 2, 3  # Bedrock facing_direction values

name, root = nbt.load(SRC)
top = root[1]
sx, sy, sz = (v for v in top["size"][1][1])
origin = top["structure_world_origin"][1][1]
st = top["structure"][1]
layer0 = st["block_indices"][1][1][0]
default = st["palette"][1]["default"][1]
palette = default["block_palette"][1][1]
block_data = default["block_position_data"][1]
VERSION = palette[0]["version"][1]


def index(x, y, z):
    return (x * sy + y) * sz + z


def palette_id(block, **states):
    """Palette index for block+states, adding the entry if it is new."""
    want = {k: v for k, v in states.items()}
    for i, p in enumerate(palette):
        if p["name"][1] == block and p["states"][1] == want:
            return i
    palette.append({"name": (STRING, block), "states": (COMPOUND, want), "version": (INT, VERSION)})
    return len(palette) - 1


def put(x, y, z, block, **states):
    layer0[index(x, y, z)] = palette_id(block, **states)
    block_data.pop(str(index(x, y, z)), None)


def block_at(x, y, z):
    return palette[layer0[index(x, y, z)]]["name"][1]


# Template for command block entities, copied from the generator's repeating block.
template = next(v[1]["block_entity_data"][1] for v in block_data.values()
                if v[1]["block_entity_data"][1]["id"][1] == "CommandBlock")


def command_block(x, y, z, command, kind, label):
    block = {"impulse": "minecraft:command_block", "chain": "minecraft:chain_command_block"}[kind]
    put(x, y, z, block, conditional_bit=(BYTE, 0), facing_direction=(INT, EAST))
    data = copy.deepcopy(template)
    data.update({
        "Command": (STRING, command),
        "CustomName": (STRING, label),
        "ExecuteOnFirstTick": (BYTE, 0),
        "LPCommandMode": (INT, 0 if kind == "impulse" else 2),
        "LastExecution": (LONG, 0),
        "LastOutput": (STRING, ""),
        "LastOutputParams": (LIST, (STRING, [])),
        "SuccessCount": (INT, 0),
        "TrackOutput": (BYTE, 1),
        "auto": (BYTE, 0 if kind == "impulse" else 1),
        "conditionMet": (BYTE, 0),
        "powered": (BYTE, 0),
        "x": (INT, origin[0] + x), "y": (INT, origin[1] + y), "z": (INT, origin[2] + z),
    })
    block_data[str(index(x, y, z))] = (COMPOUND, {"block_entity_data": (COMPOUND, data)})


def rel(frm, to):
    return " ".join(f"~{t - f}" if t != f else "~" for f, t in zip(frm, to))


def sel_pos(frm, to):
    return ",".join(f"{a}=~{t - f}" if t != f else f"{a}=~" for a, f, t in zip("xyz", frm, to))


def build_station(label, wall_z, side):
    """side=-1: plot A (plot is north of the wall), side=+1: plot B (plot is south)."""
    walk = -side                       # direction from the wall towards the walkway
    X = STATION_X
    host = (X, 27, wall_z)             # full block that both buttons hang on
    lamp = (X, 28, wall_z)             # lime = for sale, red = sold
    marker = (X, 21, wall_z + 2 * walk)  # hidden armor stand under the walkway, holds the owner's pid
    inside_spot = (X, 27, wall_z + 3 * side)
    outside_spot = (X, 27, wall_z + 2 * walk)
    inside_box_lo = (X - 2, 27, min(wall_z + side, wall_z + 3 * side))

    put(*host, "minecraft:polished_blackstone_bricks")
    put(*lamp, "minecraft:lime_concrete")
    put(X, 27, wall_z + walk, "minecraft:polished_blackstone_button",
        button_pressed_bit=(BYTE, 0), facing_direction=(INT, SOUTH if walk > 0 else NORTH))
    put(X, 27, wall_z + side, "minecraft:polished_blackstone_button",
        button_pressed_bit=(BYTE, 0), facing_direction=(INT, SOUTH if side > 0 else NORTH))
    put(marker[0], marker[1] - 1, marker[2], "minecraft:stone")   # floor for the armor stand
    put(X, 0, wall_z + side, "minecraft:deny")                     # owner can't break the inside button

    def M(at, extra=""):
        return f"@e[type=armor_stand,name=plotmark,{sel_pos(at, marker)},r=1{extra}]"

    def near(at, r=6):
        # every player selector is limited to this station, so each plot only scans itself
        return f"{sel_pos(at, host)},r={r}"

    def inside_box(at):
        return f"{sel_pos(at, inside_box_lo)},dx=4,dy=2,dz=2"

    ok = '{"rawtext":[{"text":"§aYou bought this plot for §6%d %s§a!"}]}' % (PRICE, MONEY)
    owned = '{"rawtext":[{"text":"§cThis plot is owned by someone else."}]}'
    broke = ('{"rawtext":[{"text":"§cThis plot costs §6%d %s§c. You only have §6"},'
             '{"score":{"name":"@s","objective":"%s"}},{"text":" %s§c."}]}' % (PRICE, MONEY, MONEY, MONEY))

    def presser(p, pb=1, extra=""):
        return f"@a[scores={{pb={pb}{extra}}},{near(p)}]"

    steps = [
        # scan: the nearest player to this plot's button is the presser
        lambda p: f"scoreboard players set @p[{near(p, 4)}] pb 1",
        # every player gets a permanent player id (pid) the first time they press any plot button
        lambda p: f"scoreboard players add {presser(p)} pid 0",
        lambda p: f"execute if entity {presser(p, extra=',pid=0')} run scoreboard players add #next pid 1",
        lambda p: f"scoreboard players operation {presser(p, extra=',pid=0')} pid = #next pid",
        # pressed from inside the plot -> back out to the walkway (always allowed)
        lambda p: f"scoreboard players set @a[scores={{pb=1}},{inside_box(p)}] pb 2",
        lambda p: f"tp {presser(p, 2)} {rel(p, outside_spot)}",
        # sold plot: the owner goes in, anyone else gets a message
        lambda p: f"execute as {presser(p)} if score @s pid = {M(p, ',c=1')} pid "
                  f"run tp @s {rel(p, inside_spot)}",
        lambda p: f"execute as {presser(p)} if entity {M(p)} unless score @s pid = "
                  f"{M(p, ',c=1')} pid run tellraw @s {owned}",
        # unsold plot: only a presser with at least PRICE money becomes the buyer (pb=4)
        lambda p: f"execute unless entity {M(p)} run scoreboard players set "
                  f"@p[scores={{pb=1,{MONEY}={PRICE}..}},{near(p)}] pb 4",
        lambda p: f"execute unless entity {M(p)} as {presser(p)} run tellraw @s {broke}",
        # the purchase: only pb=4 players, and the money check is repeated on the payment itself
        lambda p: f"scoreboard players remove {presser(p, 4, f',{MONEY}={PRICE}..')} {MONEY} {PRICE}",
        lambda p: f"execute if entity {presser(p, 4)} run summon armor_stand plotmark {rel(p, marker)}",
        lambda p: f"execute as {presser(p, 4)} run scoreboard players operation {M(p)} pid = @s pid",
        lambda p: f"execute if entity {presser(p, 4)} run setblock {rel(p, lamp)} red_concrete",
        lambda p: f"tellraw {presser(p, 4)} {ok}",
        lambda p: f"tp {presser(p, 4)} {rel(p, inside_spot)}",
        lambda p: "scoreboard players reset @a pb",
    ]
    assert X + len(steps) - 1 == CHAIN_END_X, "chain must end at x=25"
    for i, step in enumerate(steps):
        pos = (X + i, 26, wall_z)
        assert block_at(*pos) == "minecraft:polished_blackstone_bricks", pos
        command_block(*pos, step(pos), "impulse" if i == 0 else "chain", f"{label} buy {i + 1}")


build_station("Plot A", wall_z=26, side=-1)
build_station("Plot B", wall_z=32, side=+1)

# Drop the leftover SAVE structure block at the segment's corner. The next segment is pasted
# over the previous segment's LOAD block, so this spot turned the old load block into a save
# block sitting next to a redstone block. With air here the old load block is simply erased.
put(0, 28, 0, "minecraft:air")

nbt.dump(DST, name, root)
print(f"wrote {DST}")
