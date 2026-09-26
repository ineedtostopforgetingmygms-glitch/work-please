# Auto-generating plots with a buy system

- `Plot2.original.mcstructure`: the plot segment as exported from the world.
- `Plot2.mcstructure`: the same segment with a buy station (blocks only) on each of its two plots.
- `build_plot2.py`: turns the original into `Plot2.mcstructure` (`python3 build_plot2.py`).
- `nbt.py`: small Bedrock NBT reader/writer used by the build script.
- `../addon/PlotBuy.mcaddon`: the behavior pack that runs the buy stations. It also carries `Plot2.mcstructure` as `mystructure:Plot2`.

## Setup

1. Open `PlotBuy.mcaddon` and add the **Plot Buy** behavior pack to the world. It uses only stable script APIs, so no experiments are needed.
2. Make sure the world's saved `mystructure:Plot2` is the new one. Use a structure block in Load mode named `mystructure:Plot2`, then Import `Plot2.mcstructure`. A copy saved in the world may win over the pack's copy.
3. `c` must exist as a scoreboard. Players should be in Adventure mode.

To change the price or currency, edit `PRICE` and `MONEY` at the top of `addon/PlotBuy_BP/scripts/main.js`.

## Buy stations

Each plot has a lime/red concrete lamp in the middle of its walkway wall (x=13), with a button on both sides of it. Lime means for sale, red means sold.

- **Click, plot for sale:** shows a confirm screen, then buys the plot if the player has at least 10000 `c`. Otherwise it tells them their balance and takes nothing.
- **Click, walkway side:** the owner and added players are teleported in, any time. Everyone else is told who owns it.
- **Click, plot side:** teleports anyone out to the walkway.
- **Shift + click (owner only), either side:** opens the plot menu. It has these options:
  - **Add online player**
  - **Remove player:** works for online and offline players.
  - **Add or remove by username:** type an exact username, for players who are offline.
  - **Combine with the plot to the east/west:** only shows when you own the plot next to this one on the same side of the walkway. It replaces the wall between the two plots with ground from top to bottom and shares added players across the combined plots. It can't be undone.

A station only works if there's a border block 3 below the lamp and the walkway's deny block 3 below the walkway-side button. Players can't get those blocks, so fake stations do nothing.

Plot data is stored in world dynamic properties, keyed by the wall block under the lamp: `{owner, members, links}`. There are no entities and no command blocks. Players can own any number of plots.
