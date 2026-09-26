import { world, system } from "@minecraft/server";

world.afterEvents.entitySpawn.subscribe((event) => {
    const { entity } = event;

    // Check if the spawned entity is the specific statue type
    if (entity.typeId === "charter:statue") {
        
        // Use system.run to ensure the entity is fully initialized 
        // before setting properties to avoid potential timing bugs
        system.run(() => {
            if (entity.isValid) {
                entity.nameTag = "§S§t§a§t§u§e";
                
                // Optional: Make the name tag always visible 
                // (like a boss bar or holographic display)
                // entity.setProperty("minecraft:nametag_always_visible", true);
            }
        });
    }
});