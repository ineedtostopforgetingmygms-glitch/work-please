import { system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const TITLE = "statue:ui:";
const ROTATION_STEP = 15;

const PARTS = [
    ["Head", "statue:head_x", "statue:head_y", "statue:head_z"],
    ["Body", "statue:waist_x", "statue:waist_y", "statue:waist_z"],
    ["Left Arm", "statue:leftarm_x", "statue:leftarm_y", "statue:leftarm_z"],
    ["Right Arm", "statue:rightarm_x", "statue:rightarm_y", "statue:rightarm_z"],
    ["Left Leg", "statue:leftleg_x", "statue:leftleg_y", "statue:leftleg_z"],
    ["Right Leg", "statue:rightleg_x", "statue:rightleg_y", "statue:rightleg_z"]
];

const HIDE_PROPERTIES = [
    ["Head", "statue:head_scale"],
    ["L. Arm", "statue:leftarm_scale"],
    ["R. Arm", "statue:rightarm_scale"],
    ["L. Leg", "statue:leftleg_scale"],
    ["R. Leg", "statue:rightleg_scale"],
    ["Layer", "statue:layer"]
];


const lastSelectedPart = new Map();

world.afterEvents.entityHitEntity.subscribe((event) => {
    const { damagingEntity, hitEntity } = event;

    if (damagingEntity.typeId !== "minecraft:player" || hitEntity.typeId !== "charter:statue") {
        return;
    }

    system.run(() => {
        showStatueGui(damagingEntity, hitEntity);
    });
});

function showStatueGui(player, statue) {
    const partIndex = getLastPartIndex(player);
    const part = PARTS[partIndex];
    const [partLabel, xProperty, yProperty, zProperty] = part;

    const x = readNumber(statue, xProperty);
    const y = readNumber(statue, yProperty);
    const z = readNumber(statue, zProperty);

    const form = new ActionFormData()
        .title(TITLE)
        .body(`${partLabel}  X ${x}  Y ${y}  Z ${z}`);

    for (const [label, propertyId] of HIDE_PROPERTIES) {
        form.button(`${label} ${readBoolean(statue, propertyId) ? "On" : "Off"}`);
    }

    for (const [label] of PARTS) {
        form.button(label);
    }

    form.button("Close");
    form.button("Save");
    form.button(`X  ${x} deg`);
    form.button(`Y  ${y} deg`);
    form.button(`Z  ${z} deg`);

    form.show(player).then((response) => {
        if (response.canceled || response.selection === undefined) {
            return;
        }

        const selection = response.selection;

        if (selection >= 0 && selection < HIDE_PROPERTIES.length) {
            const [, propertyId] = HIDE_PROPERTIES[selection];
            const nextValue = !readBoolean(statue, propertyId);
            statue.setProperty(propertyId, nextValue);
            syncLayer(statue);
            reopen(player, statue);
            return;
        }

        switch (selection) {
            case 6:
            case 7:
            case 8:
            case 9:
            case 10:
            case 11:
                lastSelectedPart.set(player.id, selection - 6);
                reopen(player, statue);
                break;
            case 12:
            case 13:
                break;
            case 14:
                rotateProperty(statue, xProperty);
                reopen(player, statue);
                break;
            case 15:
                rotateProperty(statue, yProperty);
                reopen(player, statue);
                break;
            case 16:
                rotateProperty(statue, zProperty);
                reopen(player, statue);
                break;
            default:
                break;
        }
    });
}

function reopen(player, statue) {
    system.run(() => {
        showStatueGui(player, statue);
    });
}

function syncLayer(statue) {
    if (readBoolean(statue, "statue:layer")) {
        statue.triggerEvent("statue:outer_layer");
    } else {
        statue.triggerEvent("statue:remove_outer_layer");
    }
}

function rotateProperty(statue, propertyId) {
    const nextValue = (readNumber(statue, propertyId) + ROTATION_STEP) % 361;
    statue.setProperty(propertyId, nextValue);
}

function getLastPartIndex(player) {
    return clampPartIndex(lastSelectedPart.get(player.id) ?? 0);
}

function clampPartIndex(value) {
    const index = Number(value);
    if (!Number.isFinite(index)) {
        return 0;
    }

    return Math.max(0, Math.min(PARTS.length - 1, Math.trunc(index)));
}

function readNumber(entity, propertyId) {
    const value = entity.getProperty(propertyId);
    return typeof value === "number" ? Math.max(0, Math.min(360, Math.round(value))) : 0;
}

function readBoolean(entity, propertyId) {
    return Boolean(entity.getProperty(propertyId));
}
