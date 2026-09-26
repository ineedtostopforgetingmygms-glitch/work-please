# Auto-generating plots with a buy system

- `Plot2.original.mcstructure`: the plot segment as exported from the world.
- `Plot2.mcstructure`: the same segment with a buy station on each of its two plots. Import this one.
- `build_plot2.py`: turns the original into `Plot2.mcstructure` (`python3 build_plot2.py`). Change `PRICE` or `MONEY` here.
- `nbt.py`: small Bedrock NBT reader/writer used by the build script.

## One-time setup in the world

```
/scoreboard objectives add pid dummy
/scoreboard objectives add pb dummy
```

`c` must already exist. Then replace the world's saved `mystructure:Plot2` with the new file: use a structure block in Load mode named `mystructure:Plot2`, then Import. Players should be in Adventure mode.

## How a buy station works

Each plot has a polished blackstone button on both sides of its walkway wall at x=9. Above it is a lamp block: lime means for sale, red means sold. Pressing either button fires that plot's own hidden chain of command blocks under the wall (x9 to x25). Every player selector in the chain is limited to a few blocks around that plot's button, so each plot only scans its own players.

1. The nearest player within 4 blocks of the button is the presser (`pb=1`). The first time a player presses any plot button, they get a permanent player id (`pid`) from the counter `#next`.
2. Pressed from inside the plot: the presser is teleported back to the walkway. This always works.
3. Plot sold (a hidden `plotmark` armor stand under the walkway stores the owner's `pid`): the owner is teleported in, whenever they want. Anyone else is told it's owned.
4. Plot unsold: only a presser with at least 10000 `c` becomes the buyer. The 10000 is removed only from that buyer, and the removal checks the balance again. Players with less are told the price and their balance, and nothing is taken.
5. After a purchase, the armor stand is summoned with the buyer's `pid`, the lamp turns red and the buyer is teleported in.

Players can buy as many plots as they can afford. Ownership lives on each plot's armor stand, not on the player.
