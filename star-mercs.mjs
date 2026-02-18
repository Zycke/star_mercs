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
    StarMercsCombat: documents.StarMercsCombat,
    combat,
    dice
  };

  // Assign system configuration object
  CONFIG.STARMERCS = STARMERCS;

  // --- Register Document Classes ---
  CONFIG.Actor.documentClass = documents.StarMercsActor;
  CONFIG.Item.documentClass = documents.StarMercsItem;
  CONFIG.Combat.documentClass = documents.StarMercsCombat;

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
  // Clean up the previous layer to prevent accumulation across scene changes
  const previousLayer = game.starmercs.targetingArrowLayer;
  if (previousLayer) {
    previousLayer.destroy({ children: true });
  }

  const layer = new TargetingArrowLayer();
  game.starmercs.targetingArrowLayer = layer;
  canvas.interface.addChild(layer);
  layer.drawArrows();
});

/** Redraw arrows when a token is visually refreshed (position change, etc.). */
Hooks.on("refreshToken", () => {
  game.starmercs?.targetingArrowLayer?.drawArrows();
});

/**
 * Enforce movement restrictions based on the current combat phase and order.
 * Blocks token position changes when movement is not allowed.
 */
Hooks.on("preUpdateToken", (tokenDoc, changes, options, userId) => {
  if (!("x" in changes) && !("y" in changes)) return true;

  const combat = game.combat;
  if (!combat?.started) return true;

  const actor = tokenDoc.actor;
  if (!actor || actor.type !== "unit") return true;

  // Phase/order restriction check
  const moveCheck = combat.canMove(actor);
  if (!moveCheck.allowed) {
    ui.notifications.warn(moveCheck.reason);
    return false;
  }

  // Tactical phase: enforce speed limit
  if (combat.phase === "tactical") {
    const movementUsed = tokenDoc.getFlag("star-mercs", "movementUsed") ?? 0;
    const speed = actor.system.speed ?? 0;
    if (speed > 0 && movementUsed >= speed) {
      ui.notifications.warn(
        game.i18n.format("STARMERCS.Phase.MovementExhausted", { speed })
      );
      return false;
    }
  }

  return true;
});

/** Redraw arrows and track movement on token position changes. */
Hooks.on("updateToken", (tokenDoc, changes) => {
  // Redraw targeting arrows
  if ("x" in changes || "y" in changes || "elevation" in changes) {
    game.starmercs?.targetingArrowLayer?.drawArrows();
  }

  // Track movement during tactical phase
  if (("x" in changes || "y" in changes) && game.combat?.started
      && game.combat.phase === "tactical") {
    const actor = tokenDoc.actor;
    if (actor?.type === "unit") {
      const movementUsed = tokenDoc.getFlag("star-mercs", "movementUsed") ?? 0;
      tokenDoc.setFlag("star-mercs", "movementUsed", movementUsed + 1);
    }
  }
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

/* ============================================ */
/*  Combat Phase Hooks                         */
/* ============================================ */

/**
 * When the combat phase changes, reset movement counters (on tactical entry)
 * and re-render all open unit sheets so the order dropdown updates.
 */
Hooks.on("updateCombat", (combat, changes) => {
  if (!foundry.utils.hasProperty(changes, "flags.star-mercs.phase")) return;
  const newPhase = foundry.utils.getProperty(changes, "flags.star-mercs.phase");

  // Reset movement counters when entering tactical phase
  if (newPhase === "tactical") {
    for (const combatant of combat.combatants) {
      const token = combatant.token;
      if (token) {
        token.setFlag("star-mercs", "movementUsed", 0);
      }
    }
  }

  // Re-render all open unit sheets so phase indicators and order dropdown update
  for (const app of Object.values(ui.windows)) {
    if (app instanceof ActorSheet && app.actor?.type === "unit") {
      app.render(false);
    }
  }
});

/**
 * Inject the current phase display into the Combat Tracker sidebar.
 */
Hooks.on("renderCombatTracker", (app, html, data) => {
  const combat = game.combat;
  if (!combat?.started) return;
  if (!(combat instanceof documents.StarMercsCombat)) return;

  const phaseLabel = combat.phaseLabel;
  const phase = combat.phase;

  const phaseHtml = `
    <div class="star-mercs-phase-display phase-${phase}">
      <i class="fas fa-flag"></i>
      Round ${combat.round} &mdash; ${phaseLabel}
    </div>
  `;

  // Insert after the combat tracker header
  const header = html.find("#combat-round");
  if (header.length) {
    html.find(".star-mercs-phase-display").remove();
    header.after(phaseHtml);
  }

  // Rename "Next Turn" button to "Next Phase"
  const nextTurnBtn = html.find('a[data-control="nextTurn"]');
  if (nextTurnBtn.length) {
    nextTurnBtn.attr("title", "Next Phase");
    nextTurnBtn.find("i").attr("title", "Next Phase");
  }
});

/** Add the targeting arrows toggle button to the scene controls. */
Hooks.on("getSceneControlButtons", (controls) => {
  // v13: controls is an object keyed by name; v12: controls is an array
  const isV13 = !Array.isArray(controls);
  const tokenControls = isV13 ? controls.tokens : controls.find(c => c.name === "token");
  if (!tokenControls) return;

  const tool = {
    name: "targetingArrows",
    title: "STARMERCS.Controls.TargetingArrows",
    icon: "fas fa-location-arrow",
    visible: true,
    toggle: true,
    active: game.settings.get("star-mercs", "showTargetingArrows"),
    onChange: (event, active) => {
      game.settings.set("star-mercs", "showTargetingArrows", active);
    },
    onClick: (toggled) => {
      game.settings.set("star-mercs", "showTargetingArrows", toggled);
    }
  };

  if (isV13) {
    tool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.targetingArrows = tool;
  } else {
    tokenControls.tools.push(tool);
  }
});
