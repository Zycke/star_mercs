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
});

/* ============================================ */
/*  Ready Hook                                  */
/* ============================================ */

Hooks.once("ready", () => {
  console.log("Star Mercs | System Ready");
});
