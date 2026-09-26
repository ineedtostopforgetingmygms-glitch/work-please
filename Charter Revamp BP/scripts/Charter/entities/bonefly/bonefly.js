import { world, system } from "@minecraft/server";

const DIMENSIONS = ["overworld", "nether", "the_end"];

// q.is_on_ground can't be trusted for the bonefly: it hovers, and while ridden it has
// no gravity, so it never "lands" and its wings kept flapping on the ground.
// Instead, check for a block just below it here and sync the result to the client
// through the "bonefly:airborne" property, which the animation controller reads.
function isGrounded(bonefly) {
    if (bonefly.isOnGround) return true;

    const { x, y, z } = bonefly.location;
    try {
        const below = bonefly.dimension.getBlock({ x: Math.floor(x), y: Math.floor(y - 0.5), z: Math.floor(z) });
        return below !== undefined && !below.isAir && !below.isLiquid;
    } catch {
        // chunk not loaded or out of world bounds
        return false;
    }
}

system.runInterval(() => {
    for (const id of DIMENSIONS) {
        for (const bonefly of world.getDimension(id).getEntities({ type: "charter:bonefly" })) {
            const airborne = !isGrounded(bonefly);
            if (bonefly.getProperty("bonefly:airborne") !== airborne) {
                bonefly.setProperty("bonefly:airborne", airborne);
            }

            // Tamed pets announce their death by name; an unnamed custom mob shows up
            // as "Unknown", so give tamed boneflies a default name.
            if (!bonefly.nameTag && bonefly.getComponent("minecraft:is_tamed")) {
                bonefly.nameTag = "Bonefly";
            }
        }
    }
}, 2);
