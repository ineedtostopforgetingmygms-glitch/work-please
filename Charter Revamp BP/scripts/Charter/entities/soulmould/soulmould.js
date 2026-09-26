import { world, system } from "@minecraft/server";

world.afterEvents.itemUse.subscribe((event) => {
    const { itemStack, source: player } = event;

    // Check if the item used is the soulmould_item
    if (itemStack.typeId === "charter:soulmould_item") {
        const location = player.location;
        const dimension = player.dimension;

        // Spawn the souldmould entity at the player's location
        const soulMould = dimension.spawnEntity("charter:soulmould", location);

        // Access the tameable component
        const tameable = soulMould.getComponent("minecraft:tameable");

        if (tameable) {
            // Tame the entity to the player who used the item
            tameable.tame(player);
        }

        // Optional: Remove one item from the player's hand after use
        const inventory = player.getComponent("minecraft:inventory").container;
        const slot = player.selectedSlotIndex;
        
        if (itemStack.amount > 1) {
            itemStack.amount -= 1;
            inventory.setItem(slot, itemStack);
        } else {
            inventory.setItem(slot, undefined);
        }
    }
});

world.afterEvents.playerSpawn.subscribe(({ player }) => {
    const wolf = player.dimension.spawnEntity("charter:soulmould", player.location);

    // Tame the wolf to the player
    const tameable = wolf.getComponent("minecraft:tameable");
    tameable.tame(player);
});