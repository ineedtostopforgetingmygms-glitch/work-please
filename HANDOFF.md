# Handoff: Independent Villagers

This file is for whoever picks up the project next, human or Claude. It covers what the project
is, what has been done, how the code fits together, what's still open, and the plan. Read
`README.md` too; it's the player-facing description of every job.

---

## 1. The project in one paragraph

**Independent Villagers** is a Minecraft **Bedrock** add-on, made of a behavior pack and a
resource pack. It replaces vanilla villagers with `iv:villager` entities. These have real
inventories and real jobs, and they pay each other in emeralds. Jobs so far: Lumberjack, Miner,
Farmer and, new in v1.9.0, **Cartographer** and **Armorer**. Everything runs in the Bedrock
Script API (`@minecraft/server` 2.0.0, min engine 1.21.90). The user sent v1.8.0 as an
`.mcaddon`. We unpacked it into this repo, built v1.9.0 on top of it, and sent it back as
`dist/IndependentVillagers_v1.9.0.mcaddon`.

- Repo: `ineedtostopforgetingmygms-glitch/work-please`
- Working branch: **`claude/gifted-volta-106lm5`**. Always push here. No PR unless the user asks
  for one.
- Commits so far: `e2783e2` imports the v1.8.0 source unchanged, as the baseline. `c71d4b9` adds
  the Cartographer and Armorer (v1.9.0). A handoff commit follows them: this file plus the
  simulator in `tools/sim/`.

## 2. What the user asked for (verbatim intent)

**Cartographer**, whose job block is the cartography table:
- Looks for nearby sugar cane. If he can't find any, he buys some from a **wandering trader**.
- Grows cane on the **nearest body of water** to his cartography table.
- If there's **no water within 100 blocks**, he buys iron from the **Blacksmith**. The user said
  "not yet finished, make a note of this". He crafts a bucket, fetches water from a well or farm,
  makes an **infinite water source**, and grows cane round a small pond.
- Harvests once there's enough while still planting more.
- Places a **crafting table next to his cartography table**, then crafts paper and maps.
- Every so often, buys **iron from the Armorer** and **redstone from the Miner** to make
  **compasses**.
- Every *long* while he walks round the whole village and **collects emeralds from everyone,
  scaled by how rich they are** (taxes).

**Armorer**, whose job block is the blast furnace:
- Buys **raw iron and raw gold from the Miner** and smelts them in his blast furnace.
- Buys **coal from the Miner**, but only if the miner has coal spare beyond what he needs for
  torches.
- If the miner won't sell coal, he buys **logs from the Lumberjack** and burns them into
  **charcoal**.
- Buys wood from the Lumberjack for sticks.
- Sells **iron tools** to villagers who need them, and **diamond tools** if he gets diamonds
  from the Miner.

**Everyone:** villagers only buy tools if they **can afford them and are decently rich**.

## 3. What was built (v1.9.0)

| Area | Files | Notes |
| --- | --- | --- |
| Cartographer job | `scripts/jobs/cartographer.js` (~1150 lines) | Full state machine, see §5 |
| Armorer job | `scripts/jobs/armorer.js` | Full state machine, see §5 |
| Buying better tools | `scripts/jobs/tools.js` | `shopForTool()`, called from the idle state of the lumberjack (axe), miner (pickaxe) and farmer (hoe) |
| Wandering-trader purchases | `scripts/jobs/wanderer.js` | `nearestTrader`, `goToTrader`, `traderState`. Can be reused, for example to get the farmer seeds |
| Economy goods | `scripts/economy.js` | New goods: raw_iron, raw_gold, iron_ingot, redstone, diamond, sugar_cane, every tool. `keep` can be a function of the seller. `neverSold` means only the armorer sells tools |
| Blast furnace support | `scripts/jobs/smelting.js` | `BLAST_FURNACES`, `furnaceNear(..., kinds)`, `cfg.ticksPer`. Also a fix: collect output even when there's nothing left to load |
| Crafting-table bug | `scripts/jobs/workshop.js` | This bug was already in v1.8. `benchNear` cached "no bench" for 100 ticks, so villagers placed several tables. `forgetBenches()` clears the cache after a placement |
| Settings | `scripts/config.js` | `Profession.CARTOGRAPHER=4`, `ARMORER=5`, plus the `CARTO`, `ARMOR`, `TOOL_RECIPES` and `TOOLS` blocks |
| Miner changes | `scripts/jobs/miner.js`, `economy.js` | Keeps diamonds and redstone on him, so they're buyable, instead of stashing them. Keeps 4 coal for torches. Keeps 3 raw iron while saving for his iron pickaxe |
| Trade screens | `tools/trades.json` → `tools/gen_trades.py` | Adds codes `C` (cartographer) and `A` (armorer). The generator writes 3,200 `trading/iv/*.json` tables, the entity events and `scripts/trades_data.js` |
| Wiring | `main.js`, `brain.js`, `inventory_view.js` | THINKERS entries, state labels, `spawnjack` accepting the new jobs, and the hoe in the status view |
| Entity / RP | `entities/iv_villager.json`, RP render controller, entity textures, `texts/en_US.lang` | Profession range is [0,5]. Skins are the vanilla cartographer and armorer profession textures |
| Packaging | `tools/build_mcaddon.py` | Writes `dist/IndependentVillagers_v<version>.mcaddon`. `dist/` is gitignored |
| Offline simulator | `tools/sim/` | See §7 |
| Manifests | both `manifest.json` | Bumped to `[1, 9, 0]`: header, modules and the RP dependency |

**Testing so far:** simulator only. All scenarios run 24,000 ticks with 0 errors. **Nobody has
loaded v1.9.0 in real Minecraft yet.**

## 4. Decisions made without the user, still waiting on answers

The last reply asked these five questions and the user **hasn't answered yet**. Ask again, or
wait for their answers. Each one is a small change.

1. **Charcoal furnace.** In vanilla a blast furnace can't smelt logs. So the armorer builds an
   *ordinary* furnace, buying cobblestone from the miner, and makes charcoal there. Should the
   blast furnace just be allowed to make charcoal instead?
2. **Where taxes go.** The cartographer currently keeps them. Should they go into a village chest
   or somewhere else?
3. **Timing.** A compass about every 15 minutes (`CARTO.COMPASS_EVERY`) and taxes about every
   hour (`CARTO.TAX_EVERY`). Tax bands: 5% from 16 emeralds up, 10% from 64 up, 15% from 128 up.
   Is that right?
4. **Maps.** He makes plain empty maps (9 paper each). Should we attempt maps that already show
   the area?
5. **Miner behavior changes** (listed in §3). The farmer is also affected, because raw iron is
   scarcer. Is that OK?

Other judgment calls, in case the user asks why:
- The trigger for **"decently rich"**: iron tool if emeralds ≥ price + 64 (`TOOLS.RICH`). Diamond
  if ≥ price + 128 (`TOOLS.RICH_DIAMOND`).
- **Diamonds**: the armorer only buys them once he has at least 80 emeralds (`ARMOR.DIAMOND_RICH`).
- Until the Blacksmith exists, the cartographer's **bucket iron** is bought as the generic
  `iron_ingot` good from anyone with spare. In practice that's the armorer.

## 5. How the code works (architecture)

### Tick loop
`main.js` runs `system.runInterval` every `CFG.TICK_INTERVAL`. For each `iv:villager` it gets
the brain and calls `THINKERS[profession](villager, dim, brain, now)`. Exceptions are caught and
logged, and the villager backs off for 20 ticks.

### Brain (`brain.js`)
Per-villager state lives in memory, in `getBrain(entity)`. Key calls:
- `setState(entity, brain, state, idleFor)`
- `sleep(brain, ticks)`, which sets `brain.wake`
- `brain.job`, the current sub-task data

`STATE_LABELS` maps each state to text for `/scriptevent iv:status`. Anything that must survive
a reload goes in **dynamic properties** on the entity, with timers based on
`world.getAbsoluteTime()`.

### Each job file
Each job is one function, `xxxThink`, that switches on `brain.state`. Each state does a small
step and either stays or calls `setState`. Common helpers:
- **Moving:** `walkTo` in `jobs/common.js`, which wraps `navTo`/`navUpdate` in `nav.js` (A* in
  `pathfind.js`, plus marker blocks).
- **Breaking and placing:** `startBreak`/`updateBreak`/`placeBlock` in `actions.js`.
- **Picking up drops:** `pickupItems`.
- **Crafting table:** `useBench`/`benchNear`/`putDown` in `jobs/workshop.js`.
- **Furnaces:** `smeltStep` in `jobs/smelting.js`.
- **Market and stall:** `goToMarket`, `market` and market hours in `jobs/market.js`.
- **Chests:** `stockpileChests` plus `registry.js`, which tracks chests by *kind*: the armorer's
  is `"armory"`, the cartographer's is `"maps"`.
- **Sleeping and hiding:** `jobs/rest.js`.

### Inventory and shop
A villager's inventory slots **18–26 are the "sell row"**. Whatever is there is for sale to
players and to other villagers. The general slots end at `GEN_END` (`inventory.js`).

### Economy between villagers (`economy.js` plus `jobs/shopping.js`)
- `GOODS[name] = { match, keep, unit? }`. `keep` is a number or `fn(seller)`.
- `spareOf(seller, good)` is how many the seller would sell after keeping back what he needs.
- `priceFor(good, n)` comes from the trade tables, or from `unit`.
- `buyGood(buyer, seller, good, n, price)` swaps items for emeralds.
- `goShopping(villager, brain, good, n, thenState, now, urgent)` switches the villager to the
  `shop` state. He walks to the nearest seller with spare stock, buys, and returns to
  `thenState`.

### Trade screens (players)
Bedrock trade tables are static JSON. There is one table per combination of up to 3 sold items
× stock tiers `[1,2,3,4,6,8,12,16]`. Each table has a component group and an entity event,
`iv:trade_<code>_<idx>_t<tier>`, and `iv:trade_clear` resets them. `trade.js` fires the right
event based on what's in the sell row. **Never edit `trading/iv/*.json`, the trade events in
`iv_villager.json` or `trades_data.js` by hand.** Edit `tools/trades.json` and run
`python3 tools/gen_trades.py`.

### Cartographer (`jobs/cartographer.js`)

**States:**
- `plan`: the decision hub.
- `shore`: an incremental ring scan for water within `CARTO.WATER_RADIUS`, `SCAN_PER_THINK`
  columns per think.
- `wild`: cuts wild cane, leaving the bottom block.
- `trader`: buys cane from a wandering trader.
- `tend`: plants, harvests and collects drops.
- `pond`: digs a 2x2 hole and pours water on the diagonal, which makes an infinite source.
- `fill`: an incremental search for any water, dry-ground spot to stand on, then fills the
  bucket. Water it fails to reach is marked bad.
- `craft`: `ownTable` places a crafting table within 2 blocks of the cartography table. Makes
  paper (≤64 per trip), then maps, then compasses.
- `shop` and `wood`: buying things.
- `tax`: walks to every villager within `TAX_RADIUS`. `taxOn(n)` is exported and uses the bands.
- `stash`: puts things in the "maps" chest.
- `idle`, `market`, `sleep` and `hide`.

**Dynamic properties:**
- `iv:cane`: the patch, `{d, spots, pond?}`.
- `iv:carto`: timers for compass and taxes.

**Cane block ID** is `minecraft:reeds` on older versions and `minecraft:sugar_cane` on newer
ones. The code tries both. **Check this in-game first.**

The **blacksmith hook** is `pondPlan()`. Search for `TODO(blacksmith)`.

### Armorer (`jobs/armorer.js`)

**States:**
- `supply`: works out what to buy next.
- `shop`: buys ore, coal, diamonds or cobble through `goShopping`.
- `wood`: buys logs for sticks and charcoal.
- `craft`: sticks, then tools.
- `smelt`: blast furnace, 100 ticks per item.
- `char`: charcoal in an ordinary furnace, which he builds if there isn't one.
- `stash`: keeps one of each tool on him and puts the rest in the "armory" chest.
- `idle`, `market`, `sleep` and `hide`.

**Helpers:**
- `getFuel`: coal first, charcoal as the fallback.
- `nextTool`: `villageDemand()`, meaning villagers with wooden or stone tools, plus the target
  stock in `ARMOR.STOCK`.
- `surplus`: works out what he has spare.
- `buyLogs`: buys logs from the lumberjack.

## 6. Conventions and gotchas

- **Line endings:** `IndependentVillagers_RP/texts/en_US.lang` has CRLF line endings, and some
  lines are LF. Editing tools can quietly convert them to LF. Check with `file` or `git diff`
  after editing and keep what was there. The same care applies to the manifests.
- **Version bump** for a release: change `[1, 9, 0]` in both manifests, in the header, the
  modules and the BP→RP dependency. The build script reads the version from the BP manifest.
- **Comment and log style:** plain English, and villagers are "he". Log lines go through
  `debugLog(villager, "...")`.
- **Performance:** never scan big areas in one think. Spread scans over ticks, as `shore` and
  `fill` do.
- **After placing a crafting table**, call `forgetBenches()`.
- Commit messages must not name the AI model. End them with the attribution lines the session
  gives you.

## 7. Workflow: build, test, ship

```bash
python3 tools/gen_trades.py          # only if tools/trades.json changed
node tools/sim/run.mjs shore         # offline smoke test (also: well, wild, wild2, tools)
node tools/sim/run.mjs well 24000 'Cartographer' 200   # [scenario] [ticks] [log regex] [max lines]
python3 tools/build_mcaddon.py       # -> dist/IndependentVillagers_v<version>.mcaddon
git add -A && git commit && git push -u origin claude/gifted-volta-106lm5
```

Then send the `.mcaddon` to the user with SendUserFile (`display: attach`). They open it on
their device to import it.

**The simulator** (`tools/sim/`) is a ~140-line fake of `@minecraft/server`: a flat world,
blocks, containers, entities, dynamic properties and `runInterval`. `run.mjs` copies the real
BP scripts into `tools/sim/scripts/` (gitignored). It builds a scenario: a cartography table,
blast furnace, stonecutter and woodcutter bench, a miner and lumberjack with stock, a rich
jobless taxpayer and a wandering trader. Then it runs N ticks, including fake walking, furnace
smelting and cane growth. It prints warnings, each villager's final inventory and state history,
and filtered logs. The scenarios:
- `shore`: a pond nearby.
- `well`: only a village well, so it tests the bucket and pond path.
- `wild` and `wild2`: wild cane.
- `tools`: a rich lumberjack buys an iron axe.

It catches crashes and logic loops. It **doesn't** prove anything about real block names,
pathing on real terrain, textures or trade screens.

**In game:**
- `/scriptevent iv:debug on`: log every decision.
- `/scriptevent iv:status`: every villager's job, task and inventory.
- `/scriptevent iv:spawnjack <x> <z> cartographer|armorer|miner|farmer`: places the job block
  and a villager.

## 8. Plan of attack

In order:

1. **Get the user's answers to the five questions in §4** and make those tweaks. Each is a small
   change: a config value or a few lines.
2. **In-game test of v1.9.0**, done by the user. Ask them to report `/scriptevent iv:status`
   output and any content-log errors. Most likely problems, in order of suspicion:
   - Block IDs: `minecraft:reeds` vs `minecraft:sugar_cane`, `minecraft:lit_blast_furnace`, and
     the cartography table and stonecutter IDs.
   - Water: placing it (bucket pour) and detecting it (`minecraft:water` vs `flowing_water`,
     waterlogged blocks).
   - The profession textures in the RP render controller.
   - Trade screens for professions 4 and 5.
   - Pathing to the shore on real terrain, and the cost of the shore scan on big maps.
3. **Build the Blacksmith**, the user's explicitly promised next villager:
   - First ask which job block. Vanilla has no "blacksmith". The candidates are the smithing
     table (toolsmith), the grindstone (weaponsmith) or an anvil.
   - Ask what he makes and sells. The minimum is **iron ingots and buckets**, because the
     cartographer needs them.
   - Once he exists, point the cartographer's pond iron at him. Change `pondPlan()` in
     `cartographer.js` and the `iron_ingot` good in `economy.js` (both marked
     `TODO(blacksmith)`). Perhaps sell a ready-made bucket.
   - Decide how he and the armorer split the work, so they don't both smelt the miner's ore.
   - Add a profession number (6), a `tools/trades.json` entry, a THINKERS entry, state labels,
     RP texture and lang name, README docs, and a sim scenario.
4. **Farmer buys seeds from wandering traders.** This TODO was already in v1.8, in `farmer.js`.
   `wanderer.js` already does the walking and paying, so this is just the hook-up.
5. Bump the version (1.10.0), rebuild, push, and send the `.mcaddon`.

## 9. Where the original upload is

The user's original file is
`/root/.claude/uploads/1f436e6b-344d-5e4d-a814-e412c941861b/abd88232-IndependentVillagers_v1.8.0.mcaddon`,
but it only exists in that one session's container. The unchanged v1.8.0 source is commit
`e2783e2`, so use `git diff e2783e2` to see everything we changed.
