import { world, system, ItemStack, EnchantmentType } from '@minecraft/server'
import { ActionFormData, ModalFormData, FormCancelationReason } from '@minecraft/server-ui'
import { sellPercent } from './percent.js'
import { CATEGORIES } from './items.js'

// ---------------------------------------------------------------------------
// Server settings - change these to fit your server
// ---------------------------------------------------------------------------
const SHOP_NAME = 'Eclipse Shop'
const SHOP_ITEM = 'eclipse:shop'          // item that opens the shop
const MONEY_OBJECTIVE = 'money'          // scoreboard that holds player money
const CURRENCY = '$'
const GIVE_SHOP_ON_FIRST_JOIN = true     // new players get a shop book
const MAX_AMOUNT = 64                    // biggest amount per purchase/sale

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------
function getObjective() {
  return world.scoreboard.getObjective(MONEY_OBJECTIVE) ?? world.scoreboard.addObjective(MONEY_OBJECTIVE, 'Money')
}

function getMoney(player) {
  try {
    return getObjective().getScore(player) ?? 0
  } catch {
    return 0
  }
}

function setMoney(player, amount) {
  getObjective().setScore(player, amount)
}

function sellPrice(item) {
  return Math.max(1, Math.floor(item.cost * sellPercent))
}

// ---------------------------------------------------------------------------
// Inventory helpers
// ---------------------------------------------------------------------------
function fullId(id) {
  return id.includes(':') ? id : `minecraft:${id}`
}

function getContainer(player) {
  return player.getComponent('minecraft:inventory')?.container
}

// Damaged tools/armor can't be sold, so a broken elytra isn't worth full price
function isSellable(stack, typeId) {
  if (!stack || stack.typeId !== typeId) return false
  const durability = stack.getComponent('minecraft:durability')
  return !durability || durability.damage === 0
}

function countItem(player, typeId) {
  const container = getContainer(player)
  let total = 0
  for (let slot = 0; slot < container.size; slot++) {
    const stack = container.getItem(slot)
    if (isSellable(stack, typeId)) total += stack.amount
  }
  return total
}

function removeItem(player, typeId, amount) {
  const container = getContainer(player)
  let left = amount
  for (let slot = 0; slot < container.size && left > 0; slot++) {
    const stack = container.getItem(slot)
    if (!isSellable(stack, typeId)) continue
    if (stack.amount <= left) {
      left -= stack.amount
      container.setItem(slot, undefined)
    } else {
      stack.amount -= left
      container.setItem(slot, stack)
      left = 0
    }
  }
}

// Gives items, dropping anything that doesn't fit at the player's feet
function giveItem(player, stack) {
  const leftover = getContainer(player).addItem(stack)
  if (leftover) player.dimension.spawnItem(leftover, player.location)
}

function giveItems(player, typeId, amount) {
  let left = amount
  while (left > 0) {
    const stack = new ItemStack(typeId, 1)
    stack.amount = Math.min(left, stack.maxAmount)
    left -= stack.amount
    giveItem(player, stack)
  }
}

// Commands are only used for potions, since their type can't be set from scripts
function command(player, cmd) {
  try {
    return player.runCommand(cmd).successCount > 0
  } catch {
    return false
  }
}

function hasPotions(player, item, amount) {
  return command(player, `testfor @s[hasitem={item=${item.id},data=${item.data},quantity=${amount}..}]`)
}

// ---------------------------------------------------------------------------
// Buying and selling
// ---------------------------------------------------------------------------
function buy(player, item, amount) {
  const total = item.cost * amount
  const money = getMoney(player)
  if (money < total) {
    player.sendMessage(`§cYou need §f${CURRENCY}${total}§c but only have §f${CURRENCY}${money}`)
    return
  }
  if (item.data !== undefined) {
    if (!command(player, `give @s ${item.id} ${amount} ${item.data}`)) {
      player.sendMessage('§cThat item could not be given. Nothing was charged.')
      return
    }
  } else {
    giveItems(player, fullId(item.id), amount)
  }
  setMoney(player, money - total)
  player.sendMessage(`§6You bought §fx${amount} ${item.name} §6for §c-${CURRENCY}${total}`)
  player.playSound('random.orb')
}

function sell(player, item, amount) {
  const total = sellPrice(item) * amount
  if (item.data !== undefined) {
    if (!hasPotions(player, item, amount) || !command(player, `clear @s ${item.id} ${item.data} ${amount}`)) {
      player.sendMessage(`§cYou don't have §fx${amount} ${item.name}§c to sell`)
      return
    }
  } else {
    const typeId = fullId(item.id)
    if (countItem(player, typeId) < amount) {
      player.sendMessage(`§cYou don't have §fx${amount} ${item.name}§c to sell (damaged items can't be sold)`)
      return
    }
    removeItem(player, typeId, amount)
  }
  setMoney(player, getMoney(player) + total)
  player.sendMessage(`§6You sold §fx${amount} ${item.name} §6for §a+${CURRENCY}${total}`)
  player.playSound('random.orb')
}

function makeEnchantedBook(player, item) {
  // Preferred: build the book with the script API
  try {
    const book = new ItemStack('minecraft:enchanted_book', 1)
    const enchantable = book.getComponent('minecraft:enchantable')
    if (enchantable) {
      enchantable.addEnchantment({ type: new EnchantmentType(item.enchant), level: item.level })
      return book
    }
  } catch { }

  // Fallback: briefly put a plain book in the player's hand and use /enchant on it
  try {
    const container = getContainer(player)
    const slot = player.selectedSlotIndex
    const held = container.getItem(slot)
    container.setItem(slot, new ItemStack('minecraft:book', 1))
    command(player, `enchant @s ${item.enchant} ${item.level}`)
    const result = container.getItem(slot)
    container.setItem(slot, held)
    if (result?.typeId === 'minecraft:enchanted_book') return result
  } catch { }
  return undefined
}

function buyBook(player, item) {
  const money = getMoney(player)
  if (money < item.cost) {
    player.sendMessage(`§cYou need §f${CURRENCY}${item.cost}§c but only have §f${CURRENCY}${money}`)
    return
  }
  const book = makeEnchantedBook(player, item)
  if (!book) {
    player.sendMessage('§cThat book could not be made on this version. Nothing was charged.')
    return
  }
  giveItem(player, book)
  setMoney(player, money - item.cost)
  player.sendMessage(`§6You bought §f${item.name} §6for §c-${CURRENCY}${item.cost}`)
  player.playSound('random.orb')
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
function pageTurn(player) {
  player.playSound('item.book.page_turn')
}

function header(player, page) {
  return `§l§b${SHOP_NAME} §r§8| §a${CURRENCY}${getMoney(player)}${page ? ` §8| §f${page}` : ''}`
}

function mainMenu(player) {
  const form = new ActionFormData()
    .title(header(player))
    .body(`§7Balance: §a${CURRENCY}${getMoney(player)}\n§7Pick a category:`)
    .button('§lHow to use the shop', 'textures/ui/book_shiftright_default')
  for (const category of CATEGORIES) form.button(`§l${category.title}`, category.icon)

  form.show(player).then(result => {
    if (result.canceled) {
      // Player still had chat or another screen open - try again shortly
      if (result.cancelationReason === FormCancelationReason.UserBusy) system.runTimeout(() => mainMenu(player), 10)
      return
    }
    pageTurn(player)
    if (result.selection === 0) return aboutMenu(player)
    const category = CATEGORIES[result.selection - 1]
    if (category) categoryMenu(player, category)
  })
}

function aboutMenu(player) {
  new ActionFormData()
    .title(header(player, 'Help'))
    .body(
      `§3§lWelcome to the ${SHOP_NAME}!§r\n\n` +
      `§f- Pick a category, then an item.\n` +
      `§f- Choose an amount and whether to §cbuy§f or §asell§f.\n` +
      `§f- Items sell back for §6${Math.round(sellPercent * 100)} percent§f of the buy price (never less than §a${CURRENCY}1§f).\n` +
      `§f- Damaged tools and armor can't be sold.\n` +
      `§f- Enchanted books go straight into your inventory.\n\n` +
      `§7Use the back button or ESC to go back.`
    )
    .button('Ok!')
    .show(player)
    .then(() => {
      pageTurn(player)
      mainMenu(player)
    })
}

function categoryMenu(player, category) {
  const form = new ActionFormData().title(header(player, category.title))
  for (const item of category.items) {
    const price = category.books
      ? `§cBuy: ${CURRENCY}${item.cost}`
      : `§cBuy: ${CURRENCY}${item.cost} §8| §aSell: ${CURRENCY}${sellPrice(item)}`
    form.button(`§l${item.name}\n§r${price}`, item.icon)
  }

  form.show(player).then(result => {
    pageTurn(player)
    if (result.canceled) return mainMenu(player)
    const item = category.items[result.selection]
    if (!item) return
    if (category.books) bookMenu(player, category, item)
    else tradeMenu(player, category, item)
  })
}

function tradeMenu(player, category, item) {
  const form = new ModalFormData()
    .title(header(player, category.title))
    .slider(
      `\n§l${item.name}§r\n§cBuy x1 = -${CURRENCY}${item.cost}\n§aSell x1 = +${CURRENCY}${sellPrice(item)}\n\n§6Amount`,
      1, MAX_AMOUNT, { valueStep: 1, defaultValue: 1 }
    )
    .toggle('§cBuy §f/ §aSell', { defaultValue: false })
    .submitButton('Confirm')

  form.show(player).then(result => {
    pageTurn(player)
    if (result.canceled) return categoryMenu(player, category)
    const [amount, selling] = result.formValues
    if (selling) sell(player, item, amount)
    else buy(player, item, amount)
  })
}

function bookMenu(player, category, item) {
  new ActionFormData()
    .title(header(player, category.title))
    .body(`§l${item.name}§r\n\n§cPrice: -${CURRENCY}${item.cost}\n\n§7The book is added to your inventory.`)
    .button('§aBuy book', 'textures/items/book_enchanted')
    .button('Back')
    .show(player)
    .then(result => {
      pageTurn(player)
      if (result.canceled || result.selection === 1) return categoryMenu(player, category)
      buyBook(player, item)
    })
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
world.afterEvents.itemUse.subscribe(event => {
  if (event.itemStack?.typeId !== SHOP_ITEM) return
  pageTurn(event.source)
  mainMenu(event.source)
})

world.afterEvents.playerSpawn.subscribe(event => {
  if (!GIVE_SHOP_ON_FIRST_JOIN || !event.initialSpawn) return
  const player = event.player
  if (player.getDynamicProperty('eclipse_shop:received')) return
  player.setDynamicProperty('eclipse_shop:received', true)
  giveItem(player, new ItemStack(SHOP_ITEM, 1))
  player.sendMessage(`§bWelcome! §fUse your §l${SHOP_NAME}§r§f book to buy and sell items.`)
})

system.run(() => getObjective())
