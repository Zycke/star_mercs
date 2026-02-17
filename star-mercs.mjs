/**
 * Star Mercs Game System for Foundry VTT
 * A hex-based tactical wargame system.
 */

// --- Imports ---
import { STARMERCS } from "./module/config.mjs";
import * as dataModels from "./module/data/_module.mjs";
import * as documents from "./module/documents/_module.mjs";
import * as sheets from "./module/sheets/_module.mjs";
import * as combat from "./module/combat.mjs";
import * as dice from "./module/dice.mjs";
import { preloadHandlebarsTemplates, registerHandlebarsHelpers } from "./module/helpers.mjs";
import TargetingArrowLayer from "./module/canvas/targeting-layer.mjs";

/* ============================================ */
/*  Foundry VTT Initialization                  */
/* ============================================ */

Hooks.once("init", () => {
  console.log("Star Mercs | Initializing Star Mercs Game System");

  // Expose system classes and utilities on the game object
  game.starmercs = {
    StarMercsActor: documents.StarMercsActor,
    StarMercsItem: documents.StarMercsItem,
    combat,
    dice
  };

  // Assign system configuration object
  CONFIG.STARMERCS = STARMERCS;

  // --- Register Document Classes ---
  CONFIG.Actor.documentClass = documents.StarMercsActor;
  CONFIG.Item.documentClass = documents.StarMercsItem;

  // --- Register Data Models ---
  CONFIG.Actor.dataModels.unit = dataModels.actor.UnitData;
  CONFIG.Item.dataModels.weapon = dataModels.item.WeaponData;
  CONFIG.Item.dataModels.trait = dataModels.item.TraitData;
  CONFIG.Item.dataModels.order = dataModels.item.OrderData;

  // --- Configure Token Trackable Attributes ---
  CONFIG.Actor.trackableAttributes = {
    unit: {
      bar: ["strength", "readiness"],
      value: []
    }
  };

  // --- Register Sheet Classes ---
  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet("star-mercs", sheets.StarMercsUnitSheet, {
    types: ["unit"],
    makeDefault: true,
    label: "STARMERCS.SheetLabels.Unit"
  });

  Items.unregisterSheet("core", ItemSheet);
  Items.registerSheet("star-mercs", sheets.StarMercsWeaponSheet, {
    types: ["weapon"],
    makeDefault: true,
    label: "STARMERCS.SheetLabels.Weapon"
  });
  Items.registerSheet("star-mercs", sheets.StarMercsTraitSheet, {
    types: ["trait"],
    makeDefault: true,
    label: "STARMERCS.SheetLabels.Trait"
  });
  Items.registerSheet("star-mercs", sheets.StarMercsOrderSheet, {
    types: ["order"],
    makeDefault: true,
    label: "STARMERCS.SheetLabels.Order"
  });

  // --- Handlebars Setup ---
  registerHandlebarsHelpers();
  preloadHandlebarsTemplates();

  // --- Client Settings ---
  game.settings.register("star-mercs", "showTargetingArrows", {
    name: "STARMERCS.Settings.ShowTargetingArrows",
    hint: "STARMERCS.Settings.ShowTargetingArrowsHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      game.starmercs?.targetingArrowLayer?.drawArrows();
    }
  });
});

/* ============================================ */
/*  Ready Hook                                  */
/* ============================================ */

Hooks.once("ready", () => {
  console.log("Star Mercs | System Ready");
});

/* ============================================ */
/*  Canvas & Targeting Arrow Hooks              */
/* ============================================ */

/**
 * When the canvas is ready, create the targeting arrow layer
 * and add it to the interface group.
 */
Hooks.on("canvasReady", () => {
  const layer = new TargetingArrowLayer();
  game.starmercs.targetingArrowLayer = layer;
  canvas.interface.addChild(layer);
  layer.drawArrows();
});

/** Redraw arrows when a token is visually refreshed (position change, etc.). */
Hooks.on("refreshToken", () => {
  game.starmercs?.targetingArrowLayer?.drawArrows();
});

/** Redraw arrows when an embedded weapon item is updated. */
Hooks.on("updateItem", (item, changes) => {
  if (item.type !== "weapon") return;
  if (foundry.utils.hasProperty(changes, "system.targetId")
      || foundry.utils.hasProperty(changes, "system.attackType")) {
    game.starmercs?.targetingArrowLayer?.drawArrows();
  }
});

/** Redraw arrows when a weapon is created or deleted. */
Hooks.on("createItem", (item) => {
  if (item.type === "weapon") game.starmercs?.targetingArrowLayer?.drawArrows();
});

Hooks.on("deleteItem", (item) => {
  if (item.type === "weapon") game.starmercs?.targetingArrowLayer?.drawArrows();
});

/** Add the targeting arrows toggle button to the scene controls. */
Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = controls.find(c => c.name === "token");
  if (!tokenControls) return;

  tokenControls.tools.push({
    name: "targetingArrows",
    title: "STARMERCS.Controls.TargetingArrows",
    icon: "fas fa-location-arrow",
    toggle: true,
    active: game.settings.get("star-mercs", "showTargetingArrows"),
    onClick: (toggled) => {
      game.settings.set("star-mercs", "showTargetingArrows", toggled);
    }
  });
});
