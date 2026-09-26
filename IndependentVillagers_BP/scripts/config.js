// Shared constants for Independent Villagers.

export const VILLAGER_ID = "iv:villager";

// Entity properties (defined in entities/iv_villager.json, synced to the client for visuals)
export const PROP_PROFESSION = "iv:profession";
export const PROP_WORKING = "iv:working"; // arms out + swinging
export const PROP_BIOME = "iv:biome"; // 0 plains, 1 desert, 2 jungle, 3 savanna, 4 snow, 5 swamp, 6 taiga
export const PROP_SLEEPING = "iv:sleeping"; // lying in a bed

// Dynamic properties on the villager
export const DP_WORKSTATION = "iv:workstation"; // {d,x,y,z}
export const DP_TOOL = "iv:tool"; // {id, uses}
export const DP_REPLANT = "iv:replant"; // [{x,y,z,sapling}]
export const DP_NAV = "iv:nav"; // {d,x,y,z,slot} marker to clean up after a reload

// Dynamic properties on the world
export const WORLD_DP_CLAIMS = "iv:claims"; // { "dim|x|y|z": villagerId }
export const WORLD_DP_FIELDS = "iv:fields"; // [{owner, d, x, y, z, r}] one farmer per field
export const WORLD_DP_STOCKPILES = "iv:stockpiles"; // [{d,x,y,z,kind}]
export const WORLD_DP_PLACED_PREFIX = "iv:pp:"; // per-chunk lists of logs placed by players
export const WORLD_DP_DEBTS = "iv:debts"; // [{borrower, lender, chest:{d,x,y,z}, logs, owe:{item,count}, paid}]
export const DP_TRADEKEY = "iv:tradekey"; // which generated trade table is active
export const DP_MINE = "iv:mine"; // the miner's shaft plan and progress

// Inventory layout: 27 slots. The bottom row (slots 18-26) is the villager's shop stock -
// only items for sale live there. Everything else goes in slots 0-17.
export const SELL_SLOT_START = 18;

export const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

// Vanilla villagers that get swapped for independent ones (see CFG.REPLACE_VANILLA_VILLAGERS)
export const VANILLA_VILLAGERS = ["minecraft:villager_v2", "minecraft:villager"];

export const Profession = Object.freeze({
  NONE: 0,
  LUMBERJACK: 1,
  MINER: 2,
  FARMER: 3,
});

// Add new professions here. `workstation` lists the block(s) an unemployed villager claims to get the job.
export const PROFESSION_INFO = {
  [Profession.NONE]: { name: "Unemployed", nameTag: "" },
  [Profession.LUMBERJACK]: {
    name: "Lumberjack",
    nameTag: "Lumberjack",
    workstation: ["iv:woodcutter_bench"],
  },
  [Profession.MINER]: {
    name: "Miner",
    nameTag: "Miner",
    workstation: ["minecraft:stonecutter_block", "minecraft:stonecutter"],
  },
  [Profession.FARMER]: {
    name: "Farmer",
    nameTag: "Farmer",
    workstation: ["minecraft:composter"],
  },
};

export const CFG = {
  // Turn every vanilla villager into an independent villager (no more trading/breeding!)
  REPLACE_VANILLA_VILLAGERS: true,
  REPLACE_SWEEP_INTERVAL: 100,

  TICK_INTERVAL: 2, // the main loop runs this often; each villager decides when it next thinks
  THINK_IDLE: 10, // ticks between thoughts when nothing urgent is happening

  // Job hunting
  JOB_SCAN_RADIUS: 10,
  JOB_SCAN_EVERY: 40,
  // Nobody's hiring: after this long with no free job block in sight, a villager gets himself some
  // wood and puts up his own Woodcutter's Bench rather than loafing about for ever.
  SELF_EMPLOY: true,
  SELF_EMPLOY_AFTER: 20 * 90,
  SELF_EMPLOY_RETRY: 20 * 60 * 3,
  BENCH_COST_LOGS: 4, // 4 logs at a crafting table -> one Woodcutter's Bench

  // The workshop around a job block: the crafting table, chests and furnace he puts up himself.
  // Village houses are cramped, so he looks well beyond arm's reach for room and walks to it - and
  // he never builds a second crafting table when the village already has one he can use.
  WORK: { BENCH_RADIUS: 10, PLACE_RADIUS: 5 },

  // Getting his own wood: no lumberjack will sell him any, so he goes and punches a tree himself
  // (that's how a player starts too) instead of standing about waiting for a delivery.
  WOOD: { RADIUS: 40, SCAN_PER_THINK: 900, RETRY: 20 * 60, TIMEOUT: 20 * 120, PATIENCE: 20 * 60 },

  // Player-like limits
  REACH: 4.5, // how far a villager can reach to place blocks / use chests (from its eyes)
  CHOP_REACH: 3.5, // how far he chops from - he walks up close to the tree like a player would
  NEW_TREES_PER_IDLE: 3, // saplings he plants around home when there's nothing to chop
  EYE_HEIGHT: 1.5,
  PICKUP_RADIUS: 1.6, // like a player walking over items

  // Navigation
  NAV_SLOTS: 8, // must match tools/gen-entity.ps1 and the iv:nav_N blocks
  NAV_STEP: 6, // route nodes per hop
  PATH_BUDGET: 350, // A* expansions per navigation update (keeps each tick cheap)
  NAV_SHORT_NODES: 5, // routes this short are walked by hand (see nav.js) - faster and surer
  NAV_STUCK_TICKS: 50, // no progress for this long counts as stuck
  NAV_STILL_TICKS: 100, // ...and so does hardly moving at all (jittering against a tree or a wall)
  NAV_MAX_STUCK: 3,

  // Lumberjack
  FOREST_RADIUS: 32, // trees are searched for around the workstation
  SCAN_COLUMNS_PER_THINK: 200,
  RESCAN_EVERY: 20 * 60,
  TREE_RADIUS: 7, // max horizontal spread of a single tree from its trunk
  MAX_TREE_LOGS: 600, // giant jungle trees (2x2 trunks, 30+ tall, big branches) can top 300
  MIN_TREE_LOGS: 3,
  MIN_TREE_LEAVES: 4, // natural leaves touching the logs
  REJECT_MEMORY: 20 * 60 * 5, // how long to remember "not a tree" / "can't reach that"
  RETURN_AT_LOGS: 64,
  KEEP_LOGS: 8, // kept as building blocks (pillaring up tall trees), like a player keeps some blocks
  TIDY_RADIUS: 10, // picks up useful drops (e.g. saplings from decaying leaves) this close
  MAX_SAPLINGS_KEPT: 16,
  GATHER_TIME: 20 * 20,
  GATHER_RADIUS: 9,
  FELL_TIMEOUT: 20 * 240,
  IDLE_TIME: 20 * 15,
  // A villager only puts his feet up once he's put a shift in: until he's worked this long,
  // "nothing to do right now" is a short pause and he gets straight back to trying.
  WORK_BEFORE_BREAK: 20 * 60 * 2,
  SHORT_PAUSE: 20 * 8,
  STOCKPILE_RADIUS: 4, // chests within this range of the workstation belong to it
  CHEST_COST_LOGS: 2, // 2 logs -> 8 planks -> 1 chest
  AXE_COST_LOGS: 2, // 2 logs -> 8 planks -> 3 planks + 2 sticks -> wooden axe
  MAX_PILLAR: 32,

  // Economy
  STARTING_EMERALDS: 64,
  WOOD_DEAL: { logs: 8, price: 6 }, // what a miner pays a lumberjack for the wood he needs
  BUY_RETRY: 20 * 90, // after failing to buy something, don't try again for this long
  BUY_RETRY_SOON: 20 * 20, // ...unless he can't work without it, or he's only waiting for a stall to open
  // Trading hours (ticks of the day: 0 = 6:00 sunrise, 6000 = noon, 12000 = sunset). Each villager
  // picks his own start time between EARLIEST and LATEST and trades at his job block for LENGTH.
  // He only bothers opening the stall if he has MIN_LOTS trades' worth of goods to put out.
  // A villager whose shop row is half full works less and sells more: he opens up outside his
  // hours too, for EXTRA_LENGTH at a time with EXTRA_REST of work in between.
  MARKET: { EARLIEST: 1000, LATEST: 8000, LENGTH: 3000, MIN_LOTS: 2, EXTRA_LENGTH: 20 * 90, EXTRA_REST: 20 * 120 },

  ZOMBIFY: true, // killed by a zombie -> he gets up again as a zombie villager

  // Home life
  NIGHT: { START: 12600, END: 23200 }, // ticks of the day he'd rather be in bed than at work
  BED: { RADIUS: 16, SCAN_PER_THINK: 2000, RETRY: 20 * 30 }, // how far he'll look for a free bed
  BELL: { RADIUS: 32, HIDE: 20 * 45 }, // ring the bell and everyone this close gets indoors
  // No bed of his own: he still gets in out of the dark, under the nearest roof with a door on it,
  // rather than standing outside at his job block all night waiting to be eaten.
  SHELTER: { RADIUS: 20, RETRY: 20 * 20 },
  DOOR_CLOSE: 30, // he pulls a door shut this long after he's walked through it

  // Miner's torches
  TORCH_WANT: 8, // makes more when he has fewer than this
  TORCH_EVERY: 5, // places one every this many tunnel slices...
  TORCH_GAP: 6, // ...and always when he's this far from the last one he placed (dark corners, caves)
  SMELT_TIMEOUT: 20 * 90,
};

// ---------------------------------------------------------------- farming
export const FARM = {
  RADIUS: 24, // he looks for fields (his own or the village's) this far from his composter
  GAP: 2, // farmland this close together is all one field - and a field is one farmer's job
  MIN_FIELD: 4, // fewer tilled blocks than this isn't worth claiming as a field
  SIZE: 7, // the field he lays out himself: 7x7 with a water hole in the middle
  RETURN_AT: 64, // produce in his pockets before he takes it home
  HOE_COST_LOGS: 2, // 2 logs -> planks + sticks -> wooden hoe
  BUCKET_IRON: 3,
  FURNACE_COBBLE: 8,
  WATER_SEARCH: 32, // how far he'll walk to fill his bucket (the village well, a pond, a river)
  SEEDS_WANTED: 8,
  GRASS_SEARCH: 20, // he beats seeds out of tall grass this far away
  TEND_TIME: 20 * 60,
};

// ---------------------------------------------------------------- blocks & items

export const LOG_TO_SAPLING = {
  "minecraft:oak_log": "minecraft:oak_sapling",
  "minecraft:spruce_log": "minecraft:spruce_sapling",
  "minecraft:birch_log": "minecraft:birch_sapling",
  "minecraft:jungle_log": "minecraft:jungle_sapling",
  "minecraft:acacia_log": "minecraft:acacia_sapling",
  "minecraft:dark_oak_log": "minecraft:dark_oak_sapling",
  "minecraft:mangrove_log": "minecraft:mangrove_propagule",
  "minecraft:cherry_log": "minecraft:cherry_sapling",
  "minecraft:pale_oak_log": "minecraft:pale_oak_sapling",
  "minecraft:poplar_log": "minecraft:poplar_sapling", // dappled forests (autumn colours)
};

// Which leaves count as "this tree's leaves" for each log type
export const LOG_TO_LEAVES = {
  "minecraft:oak_log": ["minecraft:oak_leaves", "minecraft:azalea_leaves", "minecraft:azalea_leaves_flowered"],
  "minecraft:spruce_log": ["minecraft:spruce_leaves"],
  "minecraft:birch_log": ["minecraft:birch_leaves"],
  "minecraft:jungle_log": ["minecraft:jungle_leaves", "minecraft:oak_leaves"], // jungle bushes use oak leaves
  "minecraft:acacia_log": ["minecraft:acacia_leaves"],
  "minecraft:dark_oak_log": ["minecraft:dark_oak_leaves"],
  "minecraft:mangrove_log": ["minecraft:mangrove_leaves"],
  "minecraft:cherry_log": ["minecraft:cherry_leaves"],
  "minecraft:pale_oak_log": ["minecraft:pale_oak_leaves"],
  "minecraft:poplar_log": ["minecraft:yellow_poplar_leaves", "minecraft:orange_poplar_leaves", "minecraft:red_poplar_leaves"],
};

export const LOGS = new Set(Object.keys(LOG_TO_SAPLING));
export const SAPLINGS = new Set(Object.values(LOG_TO_SAPLING));
export const LEAVES = new Set(Object.values(LOG_TO_LEAVES).flat());

// Blocks a naturally grown tree can stand on
export const TREE_GROUND = new Set([
  "minecraft:dirt",
  "minecraft:grass_block",
  "minecraft:grass",
  "minecraft:podzol",
  "minecraft:coarse_dirt",
  "minecraft:rooted_dirt",
  "minecraft:dirt_with_roots",
  "minecraft:mycelium",
  "minecraft:moss_block",
  "minecraft:pale_moss_block",
  "minecraft:mud",
  "minecraft:muddy_mangrove_roots",
  "minecraft:mangrove_roots",
  "minecraft:clay",
  "minecraft:snow",
]);

// Saplings can be planted on these
export const SAPLING_GROUND = new Set([
  "minecraft:dirt",
  "minecraft:grass_block",
  "minecraft:grass",
  "minecraft:podzol",
  "minecraft:coarse_dirt",
  "minecraft:rooted_dirt",
  "minecraft:dirt_with_roots",
  "minecraft:mycelium",
  "minecraft:moss_block",
  "minecraft:pale_moss_block",
  "minecraft:mud",
  "minecraft:muddy_mangrove_roots",
  "minecraft:farmland",
]);

// If any of these touch a log, it's part of a build - never chop it.
export const BUILD_BLOCK =
  /planks|stairs|slab|fence|door|glass|wool|torch|lantern|chest|barrel|_bed$|bricks|_wall$|sign|crafting_table|furnace|smoker|bookshelf|ladder|concrete|terracotta|button|lever|pressure_plate|rail|redstone|hopper|lamp|banner|anvil|_table$|campfire|chain|iron_bars|_block$|polished|smooth_|cut_|chiseled|stripped|_wood$|carpet|scaffolding|shulker|beacon|cauldron|lectern|loom|composter|grindstone|stonecutter|bell$|candle|pot$|frame|dispenser|dropper|observer|piston|target|jukebox|noteblock|note_block|respawn|lodestone|conduit|creaking_heart|bench|bee_nest|beehive/;

// ...except these, which also generate naturally next to trees
export const BUILD_BLOCK_EXCEPTIONS = new Set([
  "minecraft:grass_block",
  "minecraft:moss_block",
  "minecraft:pale_moss_block",
  "minecraft:snow_layer",
  "minecraft:moss_carpet",
  "minecraft:pale_moss_carpet",
  "minecraft:mushroom_stem",
  "minecraft:brown_mushroom_block",
  "minecraft:red_mushroom_block",
  "minecraft:hay_block",
  "minecraft:melon_block", // jungles: melons grow right up against the trees
  "minecraft:pumpkin",
  "minecraft:creaking_heart", // grows inside pale oak trunks
]);

// Blocks you can walk through (feet/head space) - including the things that cover a village
// floor (carpets, plates, rails, crops), or villagers can't get into their own houses.
export const PASSABLE =
  /^(minecraft:(air|short_grass|tall_grass|fern|large_fern|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torchflower|pink_petals|wildflowers|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|dead_bush|.*_sapling|mangrove_propagule|brown_mushroom|red_mushroom|vine|glow_lichen|snow_layer|sweet_berry_bush|cave_vines.*|hanging_roots|pale_hanging_moss|seagrass|kelp|lily_pad|waterlily|sugar_cane|reeds|bamboo|bamboo_sapling|cocoa|nether_wart|sculk_vein|light_block|.*torch|.*carpet|.*_pressure_plate|.*rail|lever|.*_button|redstone_wire|tripwire.*|.*standing_sign|.*wall_sign|.*hanging_sign|flower_pot|.*skull|web|banner|.*_banner|.*item_frame|end_rod|lightning_rod|small_dripleaf|big_dripleaf|amethyst_cluster|.*_amethyst_bud|wheat|carrots|potatoes|beetroot|pumpkin_stem|melon_stem|torchflower_crop|pitcher_crop)|iv:nav_\d)$/;

// Standing where a villager wants to put a chest or a workbench down: grass, flowers and snow he
// just squashes (a player does the same), but anything on this list he leaves well alone.
export const KEEP_CLEAR =
  /_sapling|mangrove_propagule|wheat|carrots|potatoes|beetroot|torchflower|pitcher|_stem$|torch|lantern|candle|rail|_pressure_plate|_button|lever|redstone|repeater|comparator|tripwire|_carpet|flower_pot|_sign$|_banner|item_frame|_bed$|door|iv:nav_\d|amethyst|dripleaf|sculk|end_rod|lightning_rod|bamboo|cave_vines|sweet_berry/;

// ---------------------------------------------------------------- tools

// Mining speed multipliers for logs (vanilla values) and durability
export const AXES = {
  "minecraft:wooden_axe": { speed: 2, durability: 59 },
  "minecraft:stone_axe": { speed: 4, durability: 131 },
  "minecraft:copper_axe": { speed: 5, durability: 190 },
  "minecraft:iron_axe": { speed: 6, durability: 250 },
  "minecraft:diamond_axe": { speed: 8, durability: 1561 },
  "minecraft:netherite_axe": { speed: 9, durability: 2031 },
  "minecraft:golden_axe": { speed: 12, durability: 32 },
};

export const LUMBERJACK_PICKUPS = new Set([...LOGS, ...SAPLINGS, "minecraft:apple", "minecraft:stick", ...Object.keys(AXES)]);

export const HOES = {
  "minecraft:wooden_hoe": { speed: 2, durability: 59 },
  "minecraft:stone_hoe": { speed: 4, durability: 131 },
  "minecraft:copper_hoe": { speed: 5, durability: 190 },
  "minecraft:iron_hoe": { speed: 6, durability: 250 },
  "minecraft:diamond_hoe": { speed: 8, durability: 1561 },
  "minecraft:netherite_hoe": { speed: 9, durability: 2031 },
  "minecraft:golden_hoe": { speed: 12, durability: 32 },
};

export const PICKAXES = {
  "minecraft:wooden_pickaxe": { speed: 2, durability: 59 },
  "minecraft:stone_pickaxe": { speed: 4, durability: 131 },
  "minecraft:copper_pickaxe": { speed: 5, durability: 190 },
  "minecraft:iron_pickaxe": { speed: 6, durability: 250 },
  "minecraft:diamond_pickaxe": { speed: 8, durability: 1561 },
  "minecraft:netherite_pickaxe": { speed: 9, durability: 2031 },
  "minecraft:golden_pickaxe": { speed: 12, durability: 32 },
};

// ---------------------------------------------------------------- mining

export const MINE = {
  WIDTH: 3, // mineshaft is 3 wide...
  HEIGHT: 4, // ...and 4 tall
  DEPTH: 12, // staircase goes this far down, then the tunnel runs level
  FIRST_LENGTH: 32, // slices in the first tunnel (incl. the staircase)
  BRANCH_LENGTH: 16, // later branches turn off the end of the previous one
  MAX_SEGMENTS: 8, // tunnels per miner (a shared mine grows to 3x this)
  SHARE_RADIUS: 200, // a miner whose stonecutter is this close to a mine being dug works that mine
  START_OFFSET: 2, // blocks from the stonecutter to the shaft entrance...
  MAX_SHIFT: 20, // ...and how much further out he'll look for a spot clear of the village
  ORE_REACH: 3, // he digs ore this far into the tunnel walls
  ORE_VEIN: 24, // blocks of one vein he'll chase before getting on with the tunnel
  RETURN_AT: 64, // head home after collecting this many blocks
  BORROW_LOGS: 4, // 2 for a wooden pickaxe (+ sticks), 2 for a chest
  REPAY: { item: "minecraft:cobblestone", count: 3 },
};

// Village (and structure) blocks a miner keeps well away from: he digs his shaft somewhere else
// rather than through the paths, fields and houses people live in.
export const MINE_AVOID =
  /dirt_path|grass_path|farmland|wheat$|carrots|potatoes|beetroot|melon|pumpkin|hay_block|_bed$|door|planks|fence|glass|wool|carpet|bell$|lantern|ladder|bookshelf|barrel|brewing|anvil|bricks|scaffolding|stairs|slab|_wall$|rail|bee_nest|beehive|candle|flower_pot|mob_spawner/;

// Worth stopping to dig out of the tunnel wall
export const ORE = /_ore$|ancient_debris|gilded_blackstone/;

// Harvest levels, like vanilla: mine an ore with too soft a pickaxe and you get nothing at all,
// so a miner makes the right one before he touches it.
const PICK_LEVELS = {
  "minecraft:wooden_pickaxe": 1,
  "minecraft:golden_pickaxe": 1,
  "minecraft:stone_pickaxe": 2,
  "minecraft:copper_pickaxe": 2,
  "minecraft:iron_pickaxe": 3,
  "minecraft:diamond_pickaxe": 4,
  "minecraft:netherite_pickaxe": 5,
};
export const pickLevel = (id) => PICK_LEVELS[id] ?? 0;

export function oreLevel(id) {
  if (/ancient_debris/.test(id)) return 4; // diamond
  if (/nether_gold_ore|quartz|gilded_blackstone|coal_ore/.test(id)) return 1; // wooden
  if (/diamond|emerald|gold_ore|redstone/.test(id)) return 3; // iron
  if (/iron_ore|copper_ore|lapis/.test(id)) return 2; // stone
  return 1;
}

// Needs a pickaxe (drops nothing and takes forever without one)
export const PICKAXE_BLOCK =
  /stone|ore$|_ore|deepslate|andesite|diorite|granite|tuff|calcite|netherrack|basalt|blackstone|sandstone|terracotta|bricks|obsidian|dripstone|amethyst|prismarine|end_stone/;
// Never dig these
export const UNBREAKABLE = /bedrock|obsidian|reinforced_deepslate|end_portal|barrier|command_block|structure|spawner/;

// Vanilla hardness for common underground blocks (default 1.5)
export const HARDNESS = {
  "minecraft:dirt": 0.5,
  "minecraft:grass_block": 0.6,
  "minecraft:coarse_dirt": 0.5,
  "minecraft:rooted_dirt": 0.5,
  "minecraft:podzol": 0.5,
  "minecraft:mycelium": 0.6,
  "minecraft:mud": 0.5,
  "minecraft:clay": 0.6,
  "minecraft:gravel": 0.6,
  "minecraft:sand": 0.5,
  "minecraft:red_sand": 0.5,
  "minecraft:stone": 1.5,
  "minecraft:wheat": 0,
  "minecraft:carrots": 0,
  "minecraft:potatoes": 0,
  "minecraft:beetroot": 0,
  "minecraft:short_grass": 0,
  "minecraft:tall_grass": 0,
  "minecraft:farmland": 0.6,
  "minecraft:cobblestone": 2,
  "minecraft:andesite": 1.5,
  "minecraft:diorite": 1.5,
  "minecraft:granite": 1.5,
  "minecraft:tuff": 1.5,
  "minecraft:calcite": 0.75,
  "minecraft:deepslate": 3,
  "minecraft:cobbled_deepslate": 3.5,
  "minecraft:sandstone": 0.8,
  "minecraft:coal_ore": 3,
  "minecraft:iron_ore": 3,
  "minecraft:copper_ore": 3,
  "minecraft:gold_ore": 3,
  "minecraft:redstone_ore": 3,
  "minecraft:lapis_ore": 3,
  "minecraft:diamond_ore": 3,
  "minecraft:emerald_ore": 3,
  "minecraft:deepslate_coal_ore": 4.5,
  "minecraft:deepslate_iron_ore": 4.5,
  "minecraft:deepslate_copper_ore": 4.5,
  "minecraft:deepslate_gold_ore": 4.5,
  "minecraft:deepslate_redstone_ore": 4.5,
  "minecraft:deepslate_lapis_ore": 4.5,
  "minecraft:deepslate_diamond_ore": 4.5,
};

export const MINER_PICKUPS = new Set([
  "minecraft:cobblestone",
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:rooted_dirt",
  "minecraft:gravel",
  "minecraft:sand",
  "minecraft:clay_ball",
  "minecraft:deepslate",
  "minecraft:cobbled_deepslate",
  "minecraft:andesite",
  "minecraft:diorite",
  "minecraft:granite",
  "minecraft:tuff",
  "minecraft:coal",
  "minecraft:raw_iron",
  "minecraft:raw_copper",
  "minecraft:raw_gold",
  "minecraft:redstone",
  "minecraft:lapis_lazuli",
  "minecraft:diamond",
  "minecraft:emerald",
  "minecraft:flint",
  "minecraft:stick",
  "minecraft:torch",
  "minecraft:charcoal",
  "minecraft:iron_ingot",
  "minecraft:quartz",
  "minecraft:amethyst_shard",
  ...Object.keys(PICKAXES),
]);
