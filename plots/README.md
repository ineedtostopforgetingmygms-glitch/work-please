# Auto-generating plots with a buy system

- `Plot2.original.mcstructure`: the plot segment as exported from the world.
- `Plot2.mcstructure`: the same segment with a buy station on each of its two plots. Import this one.
- `build_plot2.py`: turns the original into `Plot2.mcstructure` (`python3 build_plot2.py`). Change `PRICE` or `MONEY` here.
- `nbt.py`: small Bedrock NBT reader/writer used by the build script.

## One-time setup in the world

```
/scoreboard objectives add plotid dummy
/scoreboard objectives add pb dummy
```

`c` must already exist. Then replace the world's saved `mystructure:Plot2` with the new file: use a structure block in Load mode named `mystructure:Plot2`, then Import. Players should be in Adventure mode.

## How a buy station works

Each plot has a polished blackstone button on both sides of its walkway wall at x=9. Above it is a lamp block: lime means for sale, red means sold. Pressing either button fires a hidden chain of command blocks under the wall (x9 to x25):

1. The nearest player within 4 blocks is marked as the presser (`pb=1`).
2. If they pressed from inside the plot, they are teleported back to the walkway.
3. If the plot is sold (a hidden `plotmark` armor stand exists under the walkway), the owner is teleported in. Anyone else is told it's owned.
4. If the plot is unsold and the presser has at least 10000 `c` and no plot yet, they pay 10000 `c`. They then get the next plot id, the armor stand is summoned with that id, the lamp turns red and they are teleported in.

Plot ids come from the fake player `#next` on `plotid`. A player's `plotid` is the id of their plot (0 = none).
