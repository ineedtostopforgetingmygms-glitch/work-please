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

Each plot has a polished blackstone bricks block in the middle of its walkway wall (x=13). It has a button on both sides and a lamp on top: lime means for sale, red means sold.

- **Walkway button, plot for sale:** buys the plot if the player has at least 10000 `c`. Otherwise it tells them their balance and takes nothing.
- **Walkway button, plot sold:** the owner and added players are teleported in, any time. Everyone else is told who owns it.
- **Plot button:** the owner gets the plot menu. Anyone else is teleported out to the walkway.

The plot menu has these options:
- **Leave plot**
- **Add online player:** pick from a list of online players.
- **Remove player:** pick from the plot's added players, online or offline.
- **Add or remove by username:** type an exact username, for players who are offline.

Plot data is stored in world dynamic properties, keyed by the station's position: `{owner, members}`. There are no entities and no command blocks. Players can own any number of plots.
