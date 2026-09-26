# Auto Plots by Exactdrake7

A plot world system for Minecraft Bedrock. A walkway lined with plots keeps building itself as players walk along it. Players buy plots with Coins, teleport in and out with a button, let friends in, and can join plots next to each other into one bigger plot.

Made by **Exactdrake7**.

---

## What's in this folder

| File | What it is |
|---|---|
| `PlotBuy.mcaddon` | The behavior pack that runs buying, teleporting, the plot menu and combining. It also contains the plot structure. |
| `Plot2auto.mcstructure` | The plot segment structure: one piece of walkway with a plot on each side. You import it into your world as `mystructure:Plot2`. |
| `README.md` | This file. |

---

## Requirements

- Minecraft Bedrock 1.21.0 or newer.
- Cheats turned on for the world, so you can run the setup commands and command blocks work.
- Nothing experimental. The pack only uses stable script APIs, so you don't need the "Beta APIs" toggle.

---

## Setup (step by step)

1. **Install the pack.** Open `PlotBuy.mcaddon` and Minecraft imports it. Then go to your world's settings, open **Behavior Packs**, and activate **Plot Buy by Exactdrake7**.

2. **Create the money scoreboard.** Players pay with the `c` scoreboard, which is shown to them as "Coins":
   ```
   /scoreboard objectives add c dummy Coins
   ```
   To show everyone's Coins on the side of the screen:
   ```
   /scoreboard objectives setdisplay sidebar c
   ```

3. **Import the structure into the world.**
   - Get a structure block with `/give @s structure_block`, place it, and switch it to **Load** mode.
   - Set the name to exactly `mystructure:Plot2`.
   - Press **Import** and choose `Plot2auto.mcstructure`.

   The name has to match, because every segment loads the next one by that name. The pack also carries a copy under the same name, but a copy saved in the world wins over the pack's copy, so importing makes sure the world uses this version.

4. **Place the first segment** where the plot row should start. With the same structure block, press **Load**. The structure is 27 wide (X), 29 tall and 59 deep (Z), and the row grows toward **+X (east)**. The grass on the plots ends up 26 blocks above the bottom of the structure.

5. **Put players in Adventure mode:**
   ```
   /gamemode adventure @a
   ```
   In Adventure mode, players can only build and break on their plots (above the Allow blocks). The walkway and walls are protected by Deny and Border blocks.

That's it. Walk along the walkway and new plots appear.

---

## How the plots generate

- Each **segment** holds **two plots** (25 × 25 each), one on each side of a **5-wide walkway**. The ground under each plot is 26 blocks deep: dirt and grass on top, then stone and deepslate, with Allow blocks at the very bottom.
- Segments overlap by one block, so every new segment adds **26 blocks** to the row. Neighbouring plots share a wall.
- Each segment has a **repeating command block** at the end of its walkway. When a player walks past the end of the row, it places a redstone block next to a **structure block in Load mode**. That structure block loads the next segment (`mystructure:Plot2`), which has its own command block and structure block, and the chain continues.
- Until the next segment loads, a Border block across the end of the walkway stops players from walking off it. The new segment removes that Border block.
- **Walking without generating:** players with the `test` tag don't trigger new segments, which is handy for admins and builders.
  ```
  /tag @s add test
  /tag @s remove test
  ```

---

## Buying and using plots

Every plot has a **station** in the middle of the wall between the plot and the walkway: a **concrete lamp** with a **button on each side** of it.

- 🟩 **Lime lamp:** the plot is for sale.
- 🟥 **Red lamp:** the plot is owned.

### Clicking the button

| Who | Button | What happens |
|---|---|---|
| Anyone | Walkway side, plot for sale | A buy screen asks "Buy this plot for 10000 Coins?". Buying takes 10000 Coins, turns the lamp red and teleports you in. |
| Owner or added player | Walkway side | Teleports you into the plot, any time. |
| Anyone else | Walkway side, plot owned | Tells you who owns the plot. |
| Anyone | Plot side | Teleports you out to the walkway, any time. |

Teleporting doesn't change where you're looking.

### Shift + click: the plot menu (owner only)

Sneak and press either button of a plot you own to open its menu:

- **Add online player:** pick someone from a list of everyone online.
- **Remove player:** pick from the players you've added, whether they're online or offline.
- **Add or remove by username:** type an exact username. Use this for players who are offline. Capital letters don't matter. The first time that player enters, the pack links the name to their account.
- **Combine with the plot to the east/west:** see below.

If anyone who isn't the owner shift-clicks, it acts like a normal click.

### Combining plots

When you own two plots **directly next to each other on the same side of the walkway**, the menu shows **"Combine with the plot to the east"** (or west). After you confirm:

- The wall between the two plots is replaced with normal ground, from the top all the way down, so they become one big plot. The outer walls stay.
- The players you've added are shared across the combined plots, and adding or removing someone from either station changes both.
- You can keep going and combine three or more plots in a row.
- **It can't be undone.**

### Owning several plots

Players can buy as many plots as they can afford. Each plot keeps track of its own owner.

---

## How the score (Coins) system works

- Coins are stored on the **`c` scoreboard**. Messages call them **Coins**, but the score itself is always `c`.
- **This pack doesn't hand out Coins.** It only spends them. Your server decides how players earn Coins, for example with shops, jobs, rewards or admin commands.
- **Price: 10000 Coins per plot.**
- Before charging, the pack checks that the player has **at least 10000**. If they don't, it tells them their balance ("You only have 3500 Coins") and **takes nothing**. A player with no `c` score counts as having 0. Balances never go negative from buying a plot.

Useful admin commands:
```
/scoreboard players add <player> c 10000     give Coins
/scoreboard players remove <player> c 10000  take Coins
/scoreboard players set <player> c 50000     set someone's Coins
/scoreboard players list <player>            see someone's scores
```

### Changing the price or the currency name

Both are at the top of `scripts/main.js` inside the pack:
```js
const PRICE = 10000;        // cost of one plot
const MONEY = "c";          // scoreboard that holds the money
const MONEY_NAME = "Coins"; // what players see in messages
```
To change them:
1. Rename `PlotBuy.mcaddon` to `.zip` and unzip it.
2. Edit these lines.
3. Raise the `version` numbers in `manifest.json`, both in `header` and in `modules`. Minecraft won't replace a pack that has the same version.
4. Zip the `PlotBuy_BP` folder again and rename the zip to `.mcaddon`.

---

## Protection and security

- **Border blocks** around every plot keep players out. The only way into a plot is the station's teleport, and it only lets in the owner and added players.
- **Deny blocks** under the walkway stop anyone building or breaking on it.
- **Allow blocks** under the plots let Adventure-mode players build inside plots.
- **No fake stations.** A station only works when there's a Border block 3 blocks below the lamp and the walkway's Deny block 3 blocks below the walkway-side button. Players can't get those blocks, so a copied lamp and button do nothing.
- The plot-side button has a Deny block under it, so owners can't break it and lock themselves in.

---

## Where the data is saved

- Owners, added players and combined plots are saved inside the world (script "dynamic properties"), keyed by each station's position.
- There are **no marker entities** and **no command blocks** for buying. The only command block is the generator's, one per segment.
- **The lamp is the proof of a sale.** If a bought plot is loaded again, its lamp goes back to lime and the pack treats it as a fresh plot for sale. This is also how admins can **reset a plot**: load `mystructure:Plot2` again at that segment's exact position. That resets both plots in the segment.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Clicking the button does nothing | Check that **Plot Buy by Exactdrake7** is active in the world's behavior packs. For errors, turn on **Settings → Creator → Content Log**. Plots generated from an older structure don't have stations, so reset those segments. |
| "The c scoreboard doesn't exist" | Run `/scoreboard objectives add c dummy Coins`. |
| New plots don't generate | Check that cheats and command blocks are on, that the structure is saved in the world as exactly `mystructure:Plot2`, and that you don't have the `test` tag. |
| An updated pack doesn't change anything | Raise the pack version (see above), or remove the old pack from the world and from global resources before importing the new one. |
| You end up inside blocks after teleporting in | The owner built at the spot 3 blocks inside the wall, in front of the station. Keep that spot clear. |

---

## Known limits

- Rows only grow in one direction (+X / east).
- Every segment's generator command block keeps running forever, one per segment.
- A player added by username is recognized by name until they enter the plot the first time. After that, it's their account. If someone changes their gamertag before their first visit, add them again.
- Combining can't be undone.

---

**Auto Plots by Exactdrake7.** Please keep this credit if you share or edit the pack.
