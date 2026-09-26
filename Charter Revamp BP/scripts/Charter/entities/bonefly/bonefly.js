import { world, system, Player, EntityDamageCause, EntitySwingSource, EquipmentSlot } from "@minecraft/server";

// Bonefly behavior, modelled on the original mod's BoneflyEntity:
//  - a dormant flag that freezes it and regenerates health
//  - an action state machine (normal -> stabbing -> holding) with a 10 tick stab timer
//  - altitude sensing that switches it between ground and air movement
//  - a stab that picks up the nearest living entity below it and carries it
//  - ownership through the Soultrap Effigy, and owner-only interaction

const BONEFLY = "charter:bonefly";
const SOULTRAP_EFFIGY = "charter:soultrap_effigy";
const DIMENSIONS = ["overworld", "nether", "the_end"];

const ACTION_NORMAL = 0;
const ACTION_STABBING = 1;
const ACTION_HOLDING = 2;

const MODE_GROUND = 0;
const MODE_AIR = 1;
const MODE_DORMANT = 2;
const MODE_EVENTS = ["bonefly:mode_ground", "bonefly:mode_air", "bonefly:mode_dormant"];

const AIR_ALTITUDE = 2;
const STAB_TICKS = 10;
const STAB_DAMAGE = 8;
const DORMANT_HEAL = 2;
const DORMANT_HEAL_INTERVAL = 20;

// collision box, used for the stab's search volume
const WIDTH = 1.8;
const HEIGHT = 2.5;

function setProperty(bonefly, id, value) {
    if (bonefly.getProperty(id) !== value) bonefly.setProperty(id, value);
}

function isOwner(bonefly, entity) {
    const ownerId = bonefly.getComponent("minecraft:tameable")?.tamedToPlayerId;
    return entity !== undefined && ownerId !== undefined && entity.id === ownerId;
}

// Scan down through the blocks below it: it's "in the air" when there is no solid
// block within AIR_ALTITUDE blocks of its feet, rather than just "not on the ground".
function isInAir(bonefly) {
    const { x, y, z } = bonefly.location;
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    for (let by = Math.floor(y - 0.01); by >= Math.floor(y - AIR_ALTITUDE); by--) {
        let block;
        try {
            block = bonefly.dimension.getBlock({ x: bx, y: by, z: bz });
        } catch {
            // out of world bounds or unloaded: treat as ground so it doesn't float off
            return false;
        }
        if (block === undefined || block.isSolid) return false;
    }
    return true;
}

// Walks up the vehicle chain so the stab can never make an entity ride something it carries.
function isInRidingChain(bonefly, target) {
    let vehicle = bonefly.getComponent("minecraft:riding")?.entityRidingOn;
    while (vehicle !== undefined) {
        if (vehicle.id === target.id) return true;
        vehicle = vehicle.getComponent("minecraft:riding")?.entityRidingOn;
    }
    return target.getComponent("minecraft:riding")?.entityRidingOn?.id === bonefly.id;
}

function distanceSquared(a, b) {
    const dx = a.location.x - b.location.x;
    const dy = a.location.y - b.location.y;
    const dz = a.location.z - b.location.z;
    return dx * dx + dy * dy + dz * dz;
}

// The stab searches its collision box shifted 2 blocks down and grown by 1 block,
// then takes the nearest living entity. Non-players are skewered (damaged) and carried;
// players are just picked up.
function stabNearest(bonefly) {
    const rideable = bonefly.getComponent("minecraft:rideable");
    const controller = rideable?.getRiders()[0];
    if (!rideable || !isOwner(bonefly, controller)) return false;

    const { x, y, z } = bonefly.location;
    const candidates = bonefly.dimension.getEntities({
        location: { x: x - WIDTH / 2 - 1, y: y - 2 - 1, z: z - WIDTH / 2 - 1 },
        volume: { x: WIDTH + 2, y: HEIGHT + 2, z: WIDTH + 2 },
        excludeTypes: ["minecraft:item", "minecraft:xp_orb"],
        excludeFamilies: ["inanimate"],
    }).filter((entity) => entity.id !== bonefly.id && entity.getComponent("minecraft:health") !== undefined);
    candidates.sort((a, b) => distanceSquared(a, bonefly) - distanceSquared(b, bonefly));

    const target = candidates[0];
    if (target === undefined || isInRidingChain(bonefly, target)) return false;

    if (!(target instanceof Player)) {
        target.applyDamage(STAB_DAMAGE, { cause: EntityDamageCause.entityAttack, damagingEntity: bonefly });
    }
    if (!target.isValid || (target.getComponent("minecraft:health")?.currentValue ?? 0) <= 0) return false;
    return rideable.addRider(target);
}

// Drops everything it's carrying (every rider except its owner).
function releaseCarried(bonefly) {
    const rideable = bonefly.getComponent("minecraft:rideable");
    if (!rideable) return;
    for (const rider of rideable.getRiders()) {
        if (!isOwner(bonefly, rider)) rideable.ejectRider(rider);
    }
}

function tickStab(bonefly) {
    const state = bonefly.getProperty("bonefly:action_state");

    if (state === ACTION_STABBING) {
        const ticks = Number(bonefly.getProperty("bonefly:stab_ticks") ?? 0) + 1;
        if (ticks < STAB_TICKS) {
            bonefly.setProperty("bonefly:stab_ticks", ticks);
            return;
        }
        bonefly.setProperty("bonefly:stab_ticks", 0);
        setProperty(bonefly, "bonefly:action_state", stabNearest(bonefly) ? ACTION_HOLDING : ACTION_NORMAL);
    } else if (state === ACTION_HOLDING) {
        // let go once the owner is no longer in control, or there's nothing left to hold
        const riders = bonefly.getComponent("minecraft:rideable")?.getRiders() ?? [];
        if (riders.length < 2 || !isOwner(bonefly, riders[0])) {
            releaseCarried(bonefly);
            bonefly.setProperty("bonefly:action_state", ACTION_NORMAL);
        }
    }
}

function tickBonefly(bonefly, healTick) {
    const dormant = bonefly.getProperty("bonefly:dormant") === true;
    const airborne = isInAir(bonefly);
    setProperty(bonefly, "bonefly:airborne", airborne);

    const mode = dormant ? MODE_DORMANT : airborne ? MODE_AIR : MODE_GROUND;
    if (bonefly.getProperty("bonefly:move_mode") !== mode) bonefly.triggerEvent(MODE_EVENTS[mode]);

    if (dormant) {
        bonefly.clearVelocity();
        const health = bonefly.getComponent("minecraft:health");
        if (healTick && health && health.currentValue < health.effectiveMax) {
            health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + DORMANT_HEAL));
        }
    }

    tickStab(bonefly);

    // Tamed pets announce their death by name; an unnamed custom mob shows up
    // as "Unknown", so give tamed boneflies a default name.
    if (!bonefly.nameTag && bonefly.getComponent("minecraft:is_tamed")) {
        bonefly.nameTag = "Bonefly";
    }
}

system.runInterval(() => {
    const healTick = system.currentTick % DORMANT_HEAL_INTERVAL === 0;
    for (const id of DIMENSIONS) {
        for (const bonefly of world.getDimension(id).getEntities({ type: BONEFLY })) {
            if (bonefly.isValid) tickBonefly(bonefly, healTick);
        }
    }
}, 1);

// The rider attacks (left click / tap) to stab, and again to drop what it's holding.
world.afterEvents.playerSwingStart.subscribe(({ player, swingSource }) => {
    if (swingSource !== EntitySwingSource.Attack) return;

    const bonefly = player.getComponent("minecraft:riding")?.entityRidingOn;
    if (bonefly?.typeId !== BONEFLY || !bonefly.isValid) return;
    if (bonefly.getComponent("minecraft:rideable")?.getRiders()[0]?.id !== player.id) return;
    if (bonefly.getProperty("bonefly:dormant") === true) return;

    const state = bonefly.getProperty("bonefly:action_state");
    if (state === ACTION_NORMAL) {
        bonefly.setProperty("bonefly:stab_ticks", 0);
        bonefly.setProperty("bonefly:action_state", ACTION_STABBING);
    } else if (state === ACTION_HOLDING) {
        releaseCarried(bonefly);
        bonefly.setProperty("bonefly:action_state", ACTION_NORMAL);
    }
});

function carriesSoultrapEffigy(player) {
    const offhand = player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Offhand);
    if (offhand?.typeId === SOULTRAP_EFFIGY) return true;

    const inventory = player.getComponent("minecraft:inventory")?.container;
    if (!inventory) return false;
    for (let slot = 0; slot < inventory.size; slot++) {
        if (inventory.getItem(slot)?.typeId === SOULTRAP_EFFIGY) return true;
    }
    return false;
}

// Hitting a bonefly while carrying a Soultrap Effigy makes you its owner.
world.afterEvents.entityHurt.subscribe(({ hurtEntity: bonefly, damageSource }) => {
    const player = damageSource.damagingEntity;
    if (!(player instanceof Player) || !bonefly.isValid || !carriesSoultrapEffigy(player)) return;

    const tameable = bonefly.getComponent("minecraft:tameable");
    if (!tameable || tameable.tamedToPlayerId === player.id) return;

    if (tameable.tame(player)) {
        if (!bonefly.getComponent("minecraft:rideable")) bonefly.triggerEvent("minecraft:on_tame");
        player.onScreenDisplay.setActionBar("The Bonefly is now bound to you");
    }
}, { entityTypes: [BONEFLY] });

// Only the owner can interact with a tamed bonefly: sneak to toggle dormancy,
// otherwise ride it (unless it's dormant).
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    const { player, target: bonefly } = event;
    if (bonefly.typeId !== BONEFLY) return;

    // wild: leads and name tags still work, and it has no seat to ride
    if (bonefly.getComponent("minecraft:tameable")?.tamedToPlayerId === undefined) return;

    if (!isOwner(bonefly, player)) {
        event.cancel = true;
        return;
    }

    const dormant = bonefly.getProperty("bonefly:dormant") === true;
    if (player.isSneaking) {
        event.cancel = true;
        system.run(() => {
            if (!bonefly.isValid) return;
            bonefly.setProperty("bonefly:dormant", !dormant);
            player.onScreenDisplay.setActionBar(dormant ? "The Bonefly stirs awake" : "The Bonefly falls dormant");
        });
    } else if (dormant) {
        event.cancel = true;
        system.run(() => player.onScreenDisplay.setActionBar("The Bonefly is dormant. Sneak and interact to wake it"));
    }
});
