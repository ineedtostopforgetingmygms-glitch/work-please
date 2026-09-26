import {world, system} from "@minecraft/server"


const lores = {
    //the item's typeId, followed by the lore in an array format.
    //Examples:
    "charter:contract": ["§6Use to sign.\n§8§k§WhoToldYouThis ThisWasASecret?"],
    //An example of using a arrow function to get a variable in the lore
    "minecraft:custom_item_name_player": [(player) => (`§f§2${player.name}`),"§aanother line"]
};

system.runInterval(() => {
    for (const player of world.getPlayers()) {
        const playerInv = player.getComponent("inventory").container;
        const items = Array.from({ length: playerInv.size })
            .map((_, i) => playerInv.getItem(i));
        items.forEach((item,slot) => {
            if (item?.typeId in lores){
                if (item.getLore() == ""){
                    const lore = lores[item.typeId]
                        .map(line => typeof line === 'function' ? line(player) : line);
                    item.setLore(lore);
                        playerInv.setItem(slot, item);
                }
            }
        })
    }
},1);
