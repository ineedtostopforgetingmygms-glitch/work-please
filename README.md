# work-please

**Independent Villagers** — a Minecraft Bedrock add-on where villagers have real inventories, real
jobs and pay each other in emeralds. Source for both packs lives here:

- `IndependentVillagers_BP/` — behavior pack (scripts in `scripts/`, one file per job in `scripts/jobs/`)
- `IndependentVillagers_RP/` — resource pack (skins, names)
- `tools/` — `gen_trades.py` (trade tables) and `build_mcaddon.py` (packaging)

## Jobs

| Job | Job block | What he does |
| --- | --- | --- |
| Lumberjack | Woodcutter's Bench | Fells trees, replants, sells logs |
| Miner | Stonecutter | Digs a mineshaft, sells stone, coal and ore |
| Farmer | Composter | Farms his own field, sells crops |
| **Cartographer** (v1.9) | Cartography Table | Grows sugar cane, makes paper, maps and compasses, collects taxes |
| **Armorer** (v1.9) | Blast Furnace | Smelts ore, makes iron (and diamond) tools and sells them to the village |

### Cartographer

1. Looks for the nearest shore to his cartography table (up to 100 blocks away) and makes it his
   sugar cane patch.
2. To get started he cuts wild sugar cane nearby, leaving the bottom block to grow back. If there
   isn't any, he buys some off a wandering trader.
3. **No water within 100 blocks:** he buys iron and crafts a bucket, then fetches water from a well
   or a farm's water channel. He digs a 2x2 pond by his table and pours two buckets in on the
   diagonal, which makes an infinite water source, then plants his cane round it.
4. He plants cane along the patch, harvests it once it's grown (the bottom block stays) and keeps
   planting more.
5. He puts a crafting table right next to his cartography table (the log comes from the lumberjack).
   He turns cane into paper and every 9 paper into an empty map.
6. Every so often he buys 4 iron ingots from the armorer and 1 redstone from the miner and makes a
   compass.
7. **Taxes:** every so often (about an hour of play by default) he walks round the village. Anyone
   with more than 16 emeralds pays a share: 5% from 16 up, 10% from 64 up, 15% from 128 up.
8. Sells paper, maps, compasses and spare sugar cane at his stall.

### Armorer

1. Buys raw iron and raw gold from the miner and smelts them in his blast furnace.
2. Fuel: he buys coal from the miner. The miner only sells coal beyond the 4 he keeps back for
   torches. If the miner won't sell, the armorer buys logs from the lumberjack and burns them into
   charcoal. A blast furnace can't do that, so he builds an ordinary furnace for it, with
   cobblestone from the miner.
3. Buys logs from the lumberjack for tool handles and makes iron pickaxes, axes, hoes and swords.
   He starts with the tools the village needs most, meaning villagers still using wooden or stone
   ones.
4. When he has at least 80 emeralds and the miner has diamonds spare, he buys some and makes
   diamond tools.
5. Keeps one of each tool on him and the rest in his chest. His stall sells tools, iron ingots and
   gold ingots.

**Buying tools:** lumberjacks, miners and farmers buy a better axe, pickaxe or hoe from the armorer
only when they can afford it and still have plenty left: 64 spare emeralds for iron, 128 for
diamond.

## Not finished yet

- **Blacksmith** — not written yet. When there's no water near him, the cartographer should buy
  his bucket iron from the blacksmith. For now he buys iron ingots from anyone who has them spare,
  which in practice is the armorer. Look for `TODO(blacksmith)` in `scripts/jobs/cartographer.js`
  and `scripts/economy.js`.
- The farmer still doesn't buy seeds from wandering traders. `scripts/jobs/wanderer.js` can now do
  it, but it isn't hooked up for the farmer yet.

## Tuning

Everything is in `IndependentVillagers_BP/scripts/config.js`: `CARTO` (search radii, how many maps
to stock, compass and tax timers, tax bands), `ARMOR` (how much ore to buy, tool stock, coal the
miner keeps back) and `TOOLS` (how rich a villager must be before he buys a tool).

## Trade screens

Player trade screens come from fixed JSON tables. After changing what a job sells in
`tools/trades.json`, regenerate the tables, the entity's trade events and `scripts/trades_data.js`:

```
python3 tools/gen_trades.py
python3 tools/build_mcaddon.py   # -> dist/IndependentVillagers_v<version>.mcaddon
```

## Debugging in game

- `/scriptevent iv:debug on`: log every decision
- `/scriptevent iv:status`: every villager's job, task and inventory
- `/scriptevent iv:spawnjack <x> <z> cartographer|armorer|miner|farmer`: job block plus a villager

## Working on the add-on

See `HANDOFF.md` for how the code fits together, open questions and the plan. `node tools/sim/run.mjs <scenario>` runs the scripts against a fake world, which is a quick check for crashes before testing in game.
