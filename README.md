# work-please

**Independent Villagers** — a Minecraft Bedrock add-on where villagers have real inventories, real
jobs and pay each other in emeralds. Source for both packs lives here:

- `IndependentVillagers_BP/` — behavior pack (scripts in `scripts/`, one file per job in `scripts/jobs/`)
- `IndependentVillagers_RP/` — resource pack (skins, names)
- `tools/` — `gen_trades.py` (trade tables), `build_mcaddon.py` (packaging) and `sim/` (offline test world)

## Jobs

| Job | Job block | What he does |
| --- | --- | --- |
| Lumberjack | Woodcutter's Bench | Fells trees, replants, sells logs |
| Miner | Stonecutter | Digs a deep shared mine, sells stone, coal and ore |
| Farmer | Composter | Farms his own field, sells crops, pumpkins and melons |
| Cartographer (v1.9) | Cartography Table | Grows sugar cane, makes paper, maps and compasses, collects taxes |
| Armorer (v1.9) | Blast Furnace | Smelts ore, makes iron (and diamond) tools, builds iron golems |
| **Butcher** (v1.10) | Smoker | Builds a pen, brings animals in, breeds them, butchers and smokes the meat |
| **Nitwit** (v1.10) | none | Never works; spots monsters and runs to tell the iron golems |

### Butcher (new in v1.10)

1. Looks for an animal pen near his smoker: a fence gate with a fenced-in patch behind it.
2. **No pen:** he buys logs from the lumberjack and puts a crafting table next to his smoker. He
   makes fences and a gate, then fences in a 5x5 patch on flat ground nearby, with the gate facing
   his smoker.
3. Finds cows, pigs, sheep and chickens out and about (not in anybody else's pen, not named). He
   holds up their food and they follow him home through the gate: wheat for cows and sheep,
   carrots for pigs, seeds for chickens. He buys the feed from the farmer.
4. Keeps a pair of each kind. When a pair is ready (every 5 minutes, like vanilla) he feeds them
   and they have a baby.
5. Grown animals beyond the pair get butchered (never the babies). The raw meat goes in his
   smoker, and he sells cooked meat, leather and feathers.

### Nitwit (new in v1.10)

Vanilla nitwits (the ones in green) keep being nitwits instead of turning into jobless villagers.
A nitwit never takes a job. He wanders the village keeping watch. When he spots a zombie or other
monster, he runs (fast) to the nearest iron golem and tells it. The golem then hunts monsters
within 64 blocks for 45 seconds, even ones it can't see.

### Miner (reworked in v1.10)

- **One mine for the whole village.** Every miner within 200 blocks works the same mine, each on
  his own stretch of tunnel, so they never dig the same rock.
- **Proper mine layout.** A 3 wide, 4 tall spiral staircase goes down in legs of 8 steps. It stops
  at three levels:
  - **Coal level:** 12 blocks under the stonecutter.
  - **Iron level:** y = 15.
  - **Diamond level:** y = -53, just above the lava lakes.

  Each level has 3x3 main corridors, with 1x2 branch tunnels off both sides every 3 blocks
  (branch mining).
- **Which level:** while he's short of coal (for torches) he mines at the coal level. With plenty
  of coal he mines for iron at y 15. Only now and then, once he has lots of iron (48+) and an iron
  pickaxe, does he go down for diamonds.
- **He looks after the mine.** On his way through he fills holes in the stairs and floors with
  cobblestone, and digs out anything blocking the tunnel (gravel, sand), so he can always walk
  back up. He no longer digs ore out of the floor he walks on, which is what left holes in the
  stairwell.
- **Selling:** he keeps everything he digs on him to sell, and diorite, andesite, granite,
  deepslate, redstone, lapis and diamonds are now on his stall too. Only when his pockets are full
  does the cheapest stack go in his chest to make room: a stack of cobblestone makes way for iron,
  never the other way round. Dirt and other things nobody buys go straight in the chest.

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
6. **Iron golems (new in v1.10):** when the village is short of golems, he saves up 36 iron ingots.
   The village gets one golem, plus one more for every 10 villagers, up to 4. He buys a pumpkin
   from the farmer, makes shears and carves it, then builds the golem next to his blast furnace:
   four iron blocks in a T with the pumpkin on top. At most one every 20 minutes.

**Buying tools:** lumberjacks, miners and farmers buy a better axe, pickaxe or hoe from the armorer
only when they can afford it and still have plenty left: 64 spare emeralds for iron, 128 for
diamond.

## Village life (v1.12)

Every villager runs on the same simple routine:

- **Daytime:** does his job. A jobless villager looks for a free job block.
- **Night:** goes to bed.
- **Monsters about:** runs home to his house (his bed) if the way there isn't past the monster.
  Otherwise he runs to an iron golem, or just away. He goes back to what he was doing once it's
  gone.
- **Babies:** two villagers who both have plenty of food (12 points: bread and cooked meat 4
  each, a baked potato 2, carrots, potatoes and beetroot 1) have a baby in the daytime, when
  they're at a loose end. The village needs a free bed for it (more beds than villagers, and
  fewer than 30 villagers). They meet, hearts all round, and each gives up 12 points of food. The
  baby is a vanilla baby that grows up in 20 minutes and becomes one of ours, with a name. A
  villager can do this once every 20 minutes.
- **Food:** villagers with 24+ emeralds buy food when they're short: bread from the farmer, who
  now bakes his spare wheat, and cooked meat from the butcher.

**Hurting villagers:** hit a villager for more than half his health (within 30 seconds) and he
runs to the nearest iron golem and tells on you. For the next minute, that golem comes after you
from up to 64 blocks away, seen or not.

## Village setup (v1.12)

Bedrock's village houses are built into the game, and an add-on can't change the pieces villages
are built from. So instead, the first time we see a village (its vanilla villagers turning into
ours, or one of ours loading near its bell), it gets done up:

- **A Workshop** goes up near the bell (8 to 36 blocks away, on flat ground clear of the village):
  a villager-style building of cobblestone, oak planks and oak logs, with windows, a door facing
  the bell, lanterns and a path. Inside there's one of every job block along the back wall
  (Woodcutter's Bench, Stonecutter, Composter, Cartography Table, Blast Furnace, Smoker), plus
  crafting tables, chests and a barrel. Every trade in the add-on has somewhere to start.
- **Houses with room to spare** get a crafting table and a chest against a wall. They never go in
  the doorway or next to a bed, and a house that already has one is left alone.

Each village is only done once (remembered by its bell). A village without a bell is left alone.
`/scriptevent iv:village <x> <y> <z>` does up the village round a spot on demand, and
`VILLAGE_SETUP: false` in `config.js` turns it off.

## Names (v1.11)

Every villager has a name, shown over his head with his job on the line underneath:

```
Chester
Miner
```

There are 1000 names (`scripts/names_data.js`, made by `tools/gen_names.py`). They're handed
out in turn, in an order shuffled for each world, so no two villagers share a name until all 1000
have been used. Changing jobs only changes the second line; he keeps his name. Rename a villager
with a name tag and that becomes his name (his job still shows underneath). A villager killed by a
zombie keeps his name as a zombie villager, and has it again when he's cured.

## Everyone (v1.10)

- **Running from monsters comes first.** A zombie (or any monster) close by and in sight, or one
  that just hit him, and a villager drops whatever he's doing and runs, fast. He heads for an iron
  golem if there's one about, otherwise away from the monster. He goes back to work once it's
  gone. Monsters behind a wall don't count, so a villager in bed stays in bed.
- **No more teleporting.** Villagers walk everywhere. When there's no way all the way somewhere,
  they get as close as they can and try again from there. If one ends up stuck down a hole, he
  climbs out by jumping and putting a block under himself, like a player.
- **No more jumping up two blocks.** Villagers now wait between hops, so two jumps no longer
  stack. They turn smoothly and only hop up single steps.
- **Villagers stay out of water:** the route planner treats water as a long detour, and deep water
  as a longer one.
- **Trading face to face:** two villagers doing a deal look each other in the eye instead of up at
  the sky.
- **Zombies keep their things.** A villager killed by a zombie gets up as a zombie villager
  carrying everything he had, and with his name. Kill the zombie and it drops the lot. Cure it and
  he's back with his things, his name and his saved-up experience.
- **Experience:** villagers earn experience like a player does: digging ore, smelting, trading
  with players, breeding and butchering. They bottle every 7 points into a Bottle o' Enchanting to
  sell to the cleric.
- **Farmers** now harvest ripe pumpkins and melons, and leave the stem to grow another.
- **Lumberjacks** look for trees up to 56 blocks away instead of 32. They stop looking once
  they've found 8 trees within 24 blocks, which keeps it cheap.
- **Iron golems** notice monsters 32 blocks away (and chase them 48). Nitwits can send them after
  monsters out of sight (see above).

## Not finished yet

- **Blacksmith** — not written yet. When there's no water near him, the cartographer should buy
  his bucket iron from the blacksmith. For now he buys iron ingots from anyone who has them spare,
  which in practice is the armorer. Look for `TODO(blacksmith)` in `scripts/jobs/cartographer.js`
  and `scripts/economy.js`.
- **Cleric** — not written yet. Villagers already save their experience and bottle it into
  Bottles o' Enchanting to sell to him, but until he exists they just keep the bottles (or store
  them in their chest). Look for `TODO(cleric)` in `scripts/xp.js` and `scripts/economy.js`
  (`GOODS.xp_bottle`).
- The farmer still doesn't buy seeds from wandering traders. `scripts/jobs/wanderer.js` can do
  it, but it isn't hooked up for the farmer yet.
- Mines dug before v1.10 are carried on (v1.12): the old staircase becomes the way down to the
  coal level and the stairs continue from there. Miners no longer start a second shaft next to a
  mine that's already there.

## Tuning

Everything is in `IndependentVillagers_BP/scripts/config.js`:

| Setting | What it controls |
| --- | --- |
| `MINE` | Levels, corridor and branch sizes, when miners go for coal, iron or diamonds |
| `BUTCH` | Pen size, how many animals, breeding time |
| `GOLEM` / `NITWIT` | Golems per villager, alert time, how far nitwits look and run |
| `THREAT` | How close a monster has to be before villagers run |
| `XP` | Experience per bottle |
| `FAMILY` | Food needed for a baby, how often, village size limit |
| `TATTLE` | How hard a player has to hit a villager before he tells a golem |
| `VILLAGE` | Where the Workshop goes, how much room a house needs to be furnished |
| `CARTO` | Cartographer search radii, stock, compass and tax timers, tax bands |
| `ARMOR` | Ore to buy, tool stock, coal the miner keeps back |
| `TOOLS` | How rich a villager must be before he buys a tool |

The iron golem changes live in `IndependentVillagers_BP/entities/iron_golem.json`, which replaces
the vanilla golem.

## Trade screens

Player trade screens come from fixed JSON tables. After changing what a job sells in
`tools/trades.json`, regenerate the tables, the entity's trade events and `scripts/trades_data.js`:

```
python3 tools/gen_trades.py
python3 tools/build_mcaddon.py   # -> dist/IndependentVillagers_v<version>.mcaddon
```

## Debugging in game

- `/scriptevent iv:debug on`: log every decision
- `/scriptevent iv:status`: every villager's job, task, experience and inventory
- `/scriptevent iv:spawnjack <x> <z> cartographer|armorer|miner|farmer|butcher|nitwit`: job block
  plus a villager (a nitwit gets no job block)
- `/scriptevent iv:village <x> <y> <z>`: build the Workshop and furnish the houses of the village
  round there now

## Working on the add-on

`tools/sim/` runs the real scripts against a small fake of the game, which catches crashes and
logic loops before you test in game. It doesn't show real block names, terrain or textures.

```
node tools/sim/run.mjs shore|well|wild2|tools   # cartographer + armorer
node tools/sim/mine.mjs 60000 3                   # three miners sharing one mine
node tools/sim/village.mjs 30000                  # butcher, nitwit + golem, zombies, armorer's golem
node tools/sim/village2.mjs 15000                 # Workshop + houses, babies, telling on a player, running home
```
