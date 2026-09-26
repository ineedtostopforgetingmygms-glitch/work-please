"""Adds a buy station to both plots of Plot2.original.mcstructure and writes Plot2.mcstructure.

Run from this folder:  python3 build_plot2.py

The stations are only blocks. The logic lives in the PlotBuy behavior pack
(../addon/PlotBuy_BP/scripts/main.js), which reacts to the buttons being pressed.

Local coordinates used below (x 0..26, y 0..28, z 0..58):
  plot A      x1-25, z1-25   (grass at y26)
  walkway     z27-31         (tiles at y26, players stand at y27)
  plot B      x1-25, z33-57
  plot walls  y27 on rows z26 and z32, on top of the curb row at y26
"""
import nbt
from nbt import BYTE, INT, STRING, COMPOUND

SRC, DST = "Plot2.original.mcstructure", "Plot2.mcstructure"

STATION_X = 13               # middle of the plot's 25-block wall
NORTH, SOUTH = 2, 3          # Bedrock facing_direction values

name, root = nbt.load(SRC)
top = root[1]
sx, sy, sz = (v for v in top["size"][1][1])
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
    for i, p in enumerate(palette):
        if p["name"][1] == block and p["states"][1] == states:
            return i
    palette.append({"name": (STRING, block), "states": (COMPOUND, states), "version": (INT, VERSION)})
    return len(palette) - 1


def put(x, y, z, block, **states):
    layer0[index(x, y, z)] = palette_id(block, **states)
    block_data.pop(str(index(x, y, z)), None)


def button(x, y, z, facing):
    put(x, y, z, "minecraft:polished_blackstone_button",
        button_pressed_bit=(BYTE, 0), facing_direction=(INT, facing))


def build_station(wall_z, side):
    """side=-1: plot A (plot is north of the wall), side=+1: plot B (plot is south)."""
    X = STATION_X
    # Lamp on top of the wall (lime = for sale, red = sold) with a button on each side of it.
    # The script only accepts stations with the border block 3 below the lamp and the walkway's
    # deny block 3 below the walkway-side button, which players can't place themselves.
    put(X, 28, wall_z, "minecraft:lime_concrete")
    button(X, 28, wall_z - side, SOUTH if side < 0 else NORTH)   # walkway side
    button(X, 28, wall_z + side, SOUTH if side > 0 else NORTH)   # plot side
    put(X, 0, wall_z + side, "minecraft:deny")                   # owner can't break the inside button


build_station(wall_z=26, side=-1)
build_station(wall_z=32, side=+1)

# Drop the leftover SAVE structure block at the segment's corner. The next segment is pasted
# over the previous segment's LOAD block, so this spot turned the old load block into a save
# block sitting next to a redstone block. With air here the old load block is simply erased.
put(0, 28, 0, "minecraft:air")

nbt.dump(DST, name, root)
print(f"wrote {DST}")
