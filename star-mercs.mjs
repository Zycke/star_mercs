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
import CommsLinkManager from "./module/comms-link-manager.mjs";
import CommsLinkLayer from "./module/canvas/comms-link-layer.mjs";
import * as hexUtils from "./module/hex-utils.mjs";
import TerrainLayer from "./module/canvas/terrain-layer.mjs";
import TerrainPainter from "./module/apps/terrain-painter.mjs";
import TeamSettingsForm from "./module/apps/team-settings.mjs";
import * as detection from "./module/detection.mjs";
import DetectionLayer from "./module/canvas/detection-layer.mjs";
import MovementPathLayer from "./module/canvas/movement-path-layer.mjs";
import DamageOverlayLayer from "./module/canvas/damage-overlay-layer.mjs";
import AltitudeOverlayLayer from "./module/canvas/altitude-overlay-layer.mjs";
import FiringBlipLayer from "./module/canvas/firing-blip-layer.mjs";
import TacticalMarkerLayer from "./module/canvas/tactical-marker-layer.mjs";
import TacticalMarkerPainter from "./module/apps/tactical-marker-painter.mjs";
import TurnControlPanel from "./module/apps/turn-control.mjs";
import StructureLayer from "./module/canvas/structure-layer.mjs";
import StructureSettings from "./module/apps/structure-settings.mjs";
import DeployPanel from "./module/apps/deploy-panel.mjs";

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
    dice,
    commsLinkManager: new CommsLinkManager(),
    hexUtils,
    detection
  };

  // Assign system configuration object
  CONFIG.STARMERCS = STARMERCS;

  // --- Register Custom Status Effects ---
  CONFIG.statusEffects.push(
    { id: "fired",      name: "Fired",      img: "icons/svg/explosion.svg" },
    { id: "breaking",   name: "Breaking",   img: "icons/svg/skull.svg" },
    { id: "engaged",    name: "Engaged",    img: "icons/svg/sword.svg" },
    { id: "entrenched", name: "Entrenched", img: "icons/svg/shield.svg" },
    { id: "fortified",  name: "Fortified",  img: "icons/svg/castle.svg" },
    { id: "landed",     name: "Landed",     img: "icons/svg/downgrade.svg" },
    { id: "meteoric-assault", name: "Meteoric Assault", img: "icons/svg/fire.svg" },
    { id: "air-drop",         name: "Air Drop",         img: "icons/svg/wing.svg" },
    { id: "air-assault",      name: "Air Assault",      img: "icons/svg/combat.svg" }
  );

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
    name: "Show Targeting Arrows",
    hint: "Display arrows between units and their weapon targets on the canvas.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      game.starmercs?.targetingArrowLayer?.drawArrows();
    }
  });

  game.settings.register("star-mercs", "showCommsLinks", {
    name: "Show Comms Links",
    hint: "Display communications link lines between units on the canvas.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      game.starmercs?.commsLinkLayer?.drawLinks();
    }
  });

  game.settings.register("star-mercs", "showTerrainOverlay", {
    name: "Show Terrain Overlay",
    hint: "Display colored hex overlays showing terrain types on the canvas.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      game.starmercs?.terrainLayer?.drawTerrain();
    }
  });

  game.settings.register("star-mercs", "showDetectionOverlay", {
    name: "Show Detection Overlay",
    hint: "Display detection range rings and blip markers on the canvas.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      game.starmercs?.detectionLayer?.drawDetection();
    }
  });

  game.settings.register("star-mercs", "showDetectionRing", {
    name: "Show Detection Ring",
    hint: "Display the detection range ring around the selected token.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      game.starmercs?.detectionLayer?.drawDetection();
    }
  });

  game.settings.register("star-mercs", "detectionRingTargetSig", {
    name: "Target Signature Size",
    hint: "The assumed target signature for the detection range ring display.",
    scope: "client",
    config: false,
    type: Number,
    default: 2,
    onChange: () => {
      game.starmercs?.detectionLayer?.drawDetection();
    }
  });

  // --- World Settings (GM only) ---
  game.settings.register("star-mercs", "teamAssignments", {
    name: "Team Assignments",
    hint: "Maps user IDs to teams.",
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => {
      syncAllOwnership();
    }
  });

  game.settings.register("star-mercs", "teamAssignmentsEnabled", {
    name: "Enable Team Ownership Enforcement",
    hint: "When enabled, actor ownership is automatically synced based on team assignments.",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => {
      syncAllOwnership();
    }
  });

  game.settings.register("star-mercs", "structureOverrides", {
    name: "Structure Type Overrides",
    hint: "GM-customizable defaults for constructable structure types.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("star-mercs", "deployPool", {
    name: "Deploy Pool",
    hint: "Actor IDs waiting to deploy, keyed by team.",
    scope: "world",
    config: false,
    type: Object,
    default: { a: [], b: [] }
  });
});

/* ============================================ */
/*  Ready Hook                                  */
/* ============================================ */

Hooks.once("ready", async () => {
  console.log("Star Mercs | System Ready");

  // Socket listener: GM executes phase advances requested by non-GM players
  game.socket.on("system.star-mercs", async (data) => {
    if (!game.user.isGM) return;
    if (data.action === "nextPhase") {
      const combat = game.combat;
      if (combat?.started) await combat.nextTurn();
    }

    // Tactical marker operations relayed from players
    if (data.action === "tacticalMarker") {
      const scene = game.scenes.get(data.sceneId);
      if (!scene) return;
      const existing = scene.getFlag("star-mercs", "tacticalMarkers") ?? [];

      switch (data.op) {
        case "create": {
          const marker = { id: foundry.utils.randomID(), ...data.data };
          existing.push(marker);
          await scene.setFlag("star-mercs", "tacticalMarkers", existing);
          break;
        }
        case "remove": {
          const updated = existing.filter(m => m.id !== data.markerId);
          await scene.setFlag("star-mercs", "tacticalMarkers", updated);
          break;
        }
        case "update": {
          const idx = existing.findIndex(m => m.id === data.markerId);
          if (idx !== -1) {
            Object.assign(existing[idx], data.changes);
            await scene.setFlag("star-mercs", "tacticalMarkers", existing);
          }
          break;
        }
        case "clearTeam": {
          const updated = existing.filter(m => m.team !== data.team);
          if (updated.length === 0) {
            await scene.unsetFlag("star-mercs", "tacticalMarkers");
          } else {
            await scene.setFlag("star-mercs", "tacticalMarkers", updated);
          }
          break;
        }
      }
    }

    // Structure operations relayed from players
    if (data.action === "structure") {
      const scene = game.scenes.get(data.sceneId);
      if (!scene) return;
      const existing = scene.getFlag("star-mercs", "structures") ?? [];

      switch (data.op) {
        case "create": {
          const structure = { id: foundry.utils.randomID(), ...data.data };
          existing.push(structure);
          await scene.setFlag("star-mercs", "structures", existing);
          break;
        }
        case "update": {
          const idx = existing.findIndex(s => s.id === data.structureId);
          if (idx !== -1) {
            // Validate team ownership: players can only modify their own team's structures
            if (data.team && existing[idx].team !== data.team) {
              console.warn("Star Mercs | Blocked structure update: team mismatch");
              break;
            }
            Object.assign(existing[idx], data.changes);
            await scene.setFlag("star-mercs", "structures", existing);
          }
          break;
        }
        case "remove": {
          const updated = existing.filter(s => s.id !== data.structureId);
          if (updated.length === 0) {
            await scene.unsetFlag("star-mercs", "structures");
          } else {
            await scene.setFlag("star-mercs", "structures", updated);
          }
          break;
        }
      }
    }

    // Deploy operations relayed from players
    if (data.action === "deploy") {
      switch (data.op) {
        case "addToPool": {
          const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
          if (!pool[data.team]) pool[data.team] = [];
          if (!pool[data.team].some(e => e.actorId === data.actorId)) {
            pool[data.team].push({ actorId: data.actorId, addedBy: data.userId });
            await game.settings.set("star-mercs", "deployPool", pool);
          }
          break;
        }
        case "removeFromPool": {
          const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
          if (pool[data.team]) {
            pool[data.team] = pool[data.team].filter(e => e.actorId !== data.actorId);
            await game.settings.set("star-mercs", "deployPool", pool);
          }
          break;
        }
        case "place": {
          const scene = game.scenes.get(data.sceneId);
          if (!scene) break;
          const actor = game.actors.get(data.actorId);
          if (!actor) break;

          // Create the token
          const protoToken = actor.prototypeToken;
          const tokenData = foundry.utils.mergeObject(protoToken.toObject(), {
            actorId: actor.id,
            x: data.x,
            y: data.y
          });
          const created = await scene.createEmbeddedDocuments("Token", [tokenData]);
          const tokenDoc = created[0];

          // Add combatant if combat is active
          if (game.combat?.started) {
            await game.combat.createEmbeddedDocuments("Combatant", [{
              actorId: actor.id,
              tokenId: tokenDoc.id,
              sceneId: scene.id
            }]);
          }

          // Apply deploy effects
          const panel = game.starmercs?.deployPanel;
          if (panel) {
            await panel._applyDeployEffects(actor, tokenDoc, data.mode);
            await panel._removeFromPool(data.actorId, data.team);
          }
          break;
        }
      }
    }
  });

  // Data migration: rename entrenchment → fortification in existing scene structures
  if (game.user.isGM) {
    for (const scene of game.scenes) {
      const structures = scene.getFlag("star-mercs", "structures") ?? [];
      let changed = false;
      for (const s of structures) {
        if (s.type === "entrenchment") {
          s.type = "fortification";
          changed = true;
        }
      }
      if (changed) {
        await scene.setFlag("star-mercs", "structures", structures);
        console.log(`Star Mercs | Migrated entrenchment→fortification in scene "${scene.name}"`);
      }
    }
  }
});

/**
 * When a new unit actor is created, auto-populate default traits from the
 * traits compendium (all inactive by default).
 */
Hooks.on("createActor", async (actor, options, userId) => {
  if (actor.type !== "unit") return;
  if (game.user.id !== userId) return;

  // Only populate if the actor has no traits yet
  if (actor.items.filter(i => i.type === "trait").length > 0) return;

  const pack = game.packs.get("star-mercs.traits");
  if (!pack) return;

  const traitDocs = await pack.getDocuments();
  const traitData = traitDocs.map(t => ({
    name: t.name,
    type: "trait",
    img: t.img,
    system: {
      description: t.system.description,
      traitValue: t.system.traitValue,
      passive: t.system.passive,
      active: false
    }
  }));

  if (traitData.length > 0) {
    await actor.createEmbeddedDocuments("Item", traitData);
  }

  // Set default prototype token properties
  await actor.update({
    "prototypeToken.width": 0.5,
    "prototypeToken.height": 0.5,
    "prototypeToken.texture.anchorX": 0.5,
    "prototypeToken.texture.anchorY": 0.5,
    "prototypeToken.displayName": CONST.TOKEN_DISPLAY_MODES.OWNER,
    "prototypeToken.displayBars": CONST.TOKEN_DISPLAY_MODES.OWNER,
    "prototypeToken.lockRotation": true
  });
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

  // Comms link overlay
  const previousCommsLayer = game.starmercs.commsLinkLayer;
  if (previousCommsLayer) {
    previousCommsLayer.destroy({ children: true });
  }
  const commsLayer = new CommsLinkLayer();
  game.starmercs.commsLinkLayer = commsLayer;
  canvas.interface.addChild(commsLayer);
  commsLayer.drawLinks();

  // Terrain overlay
  const previousTerrainLayer = game.starmercs.terrainLayer;
  if (previousTerrainLayer) {
    previousTerrainLayer.destroy({ children: true });
  }
  const terrainLayer = new TerrainLayer();
  game.starmercs.terrainLayer = terrainLayer;
  canvas.interface.addChild(terrainLayer);
  terrainLayer.drawTerrain();

  // Detection overlay
  const previousDetectionLayer = game.starmercs.detectionLayer;
  if (previousDetectionLayer) {
    previousDetectionLayer.destroy({ children: true });
  }
  const detectionLayer = new DetectionLayer();
  game.starmercs.detectionLayer = detectionLayer;
  canvas.interface.addChild(detectionLayer);
  detectionLayer.drawDetection();

  // Movement path overlay
  const previousMovementPathLayer = game.starmercs.movementPathLayer;
  if (previousMovementPathLayer) {
    previousMovementPathLayer.destroy({ children: true });
  }
  const movementPathLayer = new MovementPathLayer();
  game.starmercs.movementPathLayer = movementPathLayer;
  canvas.interface.addChild(movementPathLayer);

  // Damage overlay
  const previousDamageOverlay = game.starmercs.damageOverlayLayer;
  if (previousDamageOverlay) {
    previousDamageOverlay.destroy({ children: true });
  }
  const damageOverlayLayer = new DamageOverlayLayer();
  game.starmercs.damageOverlayLayer = damageOverlayLayer;
  canvas.interface.addChild(damageOverlayLayer);
  damageOverlayLayer.drawDamageNumbers();

  // Altitude overlay (green number on flying tokens)
  const previousAltitudeOverlay = game.starmercs.altitudeOverlayLayer;
  if (previousAltitudeOverlay) {
    previousAltitudeOverlay.destroy({ children: true });
  }
  const altitudeOverlayLayer = new AltitudeOverlayLayer();
  game.starmercs.altitudeOverlayLayer = altitudeOverlayLayer;
  canvas.interface.addChild(altitudeOverlayLayer);
  altitudeOverlayLayer.drawAltitudeLabels();

  // Firing blip overlay
  const previousFiringBlipLayer = game.starmercs.firingBlipLayer;
  if (previousFiringBlipLayer) {
    previousFiringBlipLayer.destroy({ children: true });
  }
  const firingBlipLayer = new FiringBlipLayer();
  game.starmercs.firingBlipLayer = firingBlipLayer;
  canvas.interface.addChild(firingBlipLayer);
  firingBlipLayer.activateListeners();
  firingBlipLayer.drawFiringBlips();

  // Tactical marker overlay
  const previousTacticalMarkerLayer = game.starmercs.tacticalMarkerLayer;
  if (previousTacticalMarkerLayer) {
    previousTacticalMarkerLayer.destroy({ children: true });
  }
  const tacticalMarkerLayer = new TacticalMarkerLayer();
  game.starmercs.tacticalMarkerLayer = tacticalMarkerLayer;
  canvas.interface.addChild(tacticalMarkerLayer);
  tacticalMarkerLayer.activateListeners();
  tacticalMarkerLayer.drawMarkers();

  // Structure overlay
  const previousStructureLayer = game.starmercs.structureLayer;
  if (previousStructureLayer) {
    previousStructureLayer.destroy({ children: true });
  }
  const structureLayer = new StructureLayer();
  game.starmercs.structureLayer = structureLayer;
  canvas.interface.addChild(structureLayer);
  structureLayer.activateListeners();
  structureLayer.drawStructures();
});

/** Redraw arrows when a token is visually refreshed (position change, etc.). */
Hooks.on("refreshToken", () => {
  game.starmercs?.targetingArrowLayer?.drawArrows();
  game.starmercs?.commsLinkLayer?.drawLinks();
  game.starmercs?.damageOverlayLayer?.drawDamageNumbers();
  game.starmercs?.altitudeOverlayLayer?.drawAltitudeLabels();
});

/** Redraw firing blips and tactical markers when scene flags change. */
Hooks.on("updateScene", (scene, changes) => {
  if (scene.id !== canvas.scene?.id) return;
  const smFlags = changes?.flags?.["star-mercs"];
  if (!smFlags) return;

  if (smFlags.firingBlips !== undefined || smFlags["-=firingBlips"] !== undefined) {
    game.starmercs?.firingBlipLayer?.drawFiringBlips();
  }
  if (smFlags.tacticalMarkers !== undefined || smFlags["-=tacticalMarkers"] !== undefined) {
    game.starmercs?.tacticalMarkerLayer?.drawMarkers();
  }
  if (smFlags.structures !== undefined || smFlags["-=structures"] !== undefined) {
    game.starmercs?.structureLayer?.drawStructures();
    // Also redraw terrain (bridges affect road network)
    game.starmercs?.terrainLayer?.drawTerrain();
  }
});

/**
 * Enforce movement restrictions based on the current combat phase and order.
 * Blocks token position changes when movement is not allowed.
 */
Hooks.on("preUpdateToken", (tokenDoc, changes, options, userId) => {
  if (!("x" in changes) && !("y" in changes)) return true;

  // GM override: Alt+drag bypasses all movement restrictions
  if (game.user.isGM && game.keyboard?.isModifierActive(KeyboardManager.MODIFIER_KEYS.ALT)) {
    options._starMercsGMOverride = true;
    return true;
  }

  // Automated movement (system-driven): already validated, skip hook checks
  if (options._starMercsAutoMove) return true;

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

  // Tactical phase: enforce MP limit, terrain, elevation, and fuel checks
  if (combat.phase === "tactical") {
    const currentToken = canvas.tokens?.get(tokenDoc.id);
    if (!currentToken) return true;
    const currentCenter = currentToken.center;
    const newX = changes.x ?? tokenDoc.x;
    const newY = changes.y ?? tokenDoc.y;
    const newCenter = { x: newX + (currentToken.w / 2), y: newY + (currentToken.h / 2) };
    const destSnapped = hexUtils.snapToHexCenter(newCenter);

    // Compute hex path and validate (terrain, elevation, enemy occupancy)
    const path = hexUtils.computeHexPath(currentCenter, destSnapped);
    const pathValidation = hexUtils.validatePath(currentToken, path);
    if (!pathValidation.valid) {
      ui.notifications.warn(pathValidation.reason);
      return false;
    }

    // Cannot end in a hex occupied by another living unit
    const tokensAtDest = hexUtils.getTokensAtHex(destSnapped);
    const otherAtDest = tokensAtDest.filter(t => t !== currentToken);
    if (otherAtDest.length > 0) {
      ui.notifications.warn("Cannot move into a hex occupied by another unit.");
      return false;
    }

    // Calculate MP cost for the path
    const { totalCost, passable, reason: costReason } = hexUtils.calculatePathCost(currentCenter, path, actor);
    if (!passable) {
      ui.notifications.warn(costReason);
      return false;
    }

    const mpUsed = tokenDoc.getFlag("star-mercs", "movementUsed") ?? 0;
    let maxMP = actor.system.movement ?? 0;

    // Forced March and other orders with speedMultiplier
    const orderConfig = CONFIG.STARMERCS.orders?.[actor.system.currentOrder];
    if (orderConfig?.speedMultiplier) {
      maxMP *= orderConfig.speedMultiplier;
    }

    if (maxMP > 0 && (mpUsed + totalCost) > maxMP) {
      ui.notifications.warn(
        `Not enough MP: need ${totalCost}, have ${maxMP - mpUsed} remaining.`
      );
      return false;
    }

    // Check if unit has fuel to move
    const fuelPerMP = actor.system.fuelPerMP ?? 0;
    if (fuelPerMP > 0) {
      const fuelRemaining = actor.system.supply?.fuel?.current ?? 0;
      const fuelNeeded = (mpUsed + totalCost) * fuelPerMP;
      if (fuelNeeded > fuelRemaining) {
        ui.notifications.warn("Cannot move — not enough fuel remaining.");
        return false;
      }
    }

    // Pass computed MP cost to updateToken hook via options
    options._starMercsMPCost = totalCost;
  }

  return true;
});

/** Redraw arrows and track movement on token position changes. */
Hooks.on("updateToken", (tokenDoc, changes, options) => {
  // Redraw targeting arrows and comms links
  if ("x" in changes || "y" in changes || "elevation" in changes) {
    game.starmercs?.targetingArrowLayer?.drawArrows();
    game.starmercs?.commsLinkLayer?.drawLinks();
  }

  // Also redraw arrows when moveDestination or assaultTarget flags change
  if (foundry.utils.hasProperty(changes, "flags.star-mercs.moveDestination")
      || foundry.utils.hasProperty(changes, "flags.star-mercs.assaultTarget")) {
    game.starmercs?.targetingArrowLayer?.drawArrows();
  }

  // Redraw damage overlay when pending damage changes
  if (foundry.utils.hasProperty(changes, "flags.star-mercs.pendingDamage")) {
    game.starmercs?.damageOverlayLayer?.drawDamageNumbers();
  }

  // Track movement points spent during tactical phase (skip for GM override moves)
  if (("x" in changes || "y" in changes) && game.combat?.started
      && game.combat.phase === "tactical" && !options?._starMercsGMOverride) {
    const actor = tokenDoc.actor;
    if (actor?.type === "unit") {
      const mpCost = options?._starMercsMPCost ?? 1;
      const movementUsed = tokenDoc.getFlag("star-mercs", "movementUsed") ?? 0;
      tokenDoc.setFlag("star-mercs", "movementUsed", movementUsed + mpCost);
    }
  }

  // Deactivate Entrenched and Fortified traits when a unit moves
  if ("x" in changes || "y" in changes) {
    const actor = tokenDoc.actor;
    if (actor?.type === "unit") {
      const entrenchedTrait = actor.items.find(
        i => i.type === "trait" && i.name.toLowerCase() === "entrenched" && i.system.active
      );
      if (entrenchedTrait) {
        entrenchedTrait.update({ "system.active": false });
      }
      const fortifiedTrait = actor.items.find(
        i => i.type === "trait" && i.name.toLowerCase() === "fortified" && i.system.active
      );
      if (fortifiedTrait) {
        fortifiedTrait.update({ "system.active": false });
      }

      // Grant Fortified when moving INTO a hex with a completed structure that grantsFortified
      const newCenter = hexUtils.snapToHexCenter({ x: tokenDoc.x, y: tokenDoc.y });
      const structureAtHex = hexUtils.getStructureAtHex(newCenter);
      if (structureAtHex && structureAtHex.turnsBuilt >= structureAtHex.turnsRequired
          && structureAtHex.strength > 0) {
        const sConfig = CONFIG.STARMERCS.structures[structureAtHex.type];
        if (sConfig?.grantsFortified) {
          const ft = actor.items.find(
            i => i.type === "trait" && i.name.toLowerCase() === "fortified"
          );
          if (ft && !ft.system.active) {
            ft.update({ "system.active": true });
          }
        }
      }
    }
  }
});

/** Refresh engagement status effects on all tokens after any movement. */
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (!("x" in changes) && !("y" in changes)) return;
  if (!canvas?.tokens?.placeables) return;

  for (const token of canvas.tokens.placeables) {
    if (!token.actor || token.actor.type !== "unit") continue;
    if (token.actor.system.strength.value <= 0) continue;

    const engaged = hexUtils.isEngaged(token);
    const hasEffect = token.document.hasStatusEffect("engaged");
    if (engaged && !hasEffect) {
      token.actor.toggleStatusEffect("engaged", { active: true });
    } else if (!engaged && hasEffect) {
      token.actor.toggleStatusEffect("engaged", { active: false });
    }
  }
});

/** Sync "Breaking" status effect icon with the breaking token flag. */
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (foundry.utils.hasProperty(changes, "flags.star-mercs.breaking")) {
    const isBreaking = foundry.utils.getProperty(changes, "flags.star-mercs.breaking");
    const actor = tokenDoc.actor;
    if (actor) {
      const hasEffect = tokenDoc.hasStatusEffect("breaking");
      if (isBreaking && !hasEffect) {
        actor.toggleStatusEffect("breaking", { active: true });
      } else if (!isBreaking && hasEffect) {
        actor.toggleStatusEffect("breaking", { active: false });
      }
    }
  }
});

/** Redraw arrows when an embedded weapon item is updated, and comms links when traits change. */
Hooks.on("updateItem", (item, changes) => {
  if (item.type === "weapon") {
    if (foundry.utils.hasProperty(changes, "system.targetId")
        || foundry.utils.hasProperty(changes, "system.attackType")) {
      game.starmercs?.targetingArrowLayer?.drawArrows();
    }
  }
  if (item.type === "trait" && foundry.utils.hasProperty(changes, "system.active")) {
    game.starmercs?.commsLinkManager?.invalidate();
    game.starmercs?.commsLinkLayer?.drawLinks();

    // Sync "Entrenched" status effect icon with the trait's active state
    if (item.name.toLowerCase() === "entrenched") {
      const isActive = changes.system.active;
      const actor = item.parent;
      if (actor?.type === "unit") {
        const token = actor.getActiveTokens()?.[0]?.document;
        if (token) {
          const hasEffect = token.hasStatusEffect("entrenched");
          if (isActive && !hasEffect) {
            actor.toggleStatusEffect("entrenched", { active: true });
          } else if (!isActive && hasEffect) {
            actor.toggleStatusEffect("entrenched", { active: false });
          }
        }
      }
    }

    // Sync "Fortified" status effect icon with the trait's active state
    if (item.name.toLowerCase() === "fortified") {
      const isActive = changes.system.active;
      const actor = item.parent;
      if (actor?.type === "unit") {
        const token = actor.getActiveTokens()?.[0]?.document;
        if (token) {
          const hasEffect = token.hasStatusEffect("fortified");
          if (isActive && !hasEffect) {
            actor.toggleStatusEffect("fortified", { active: true });
          } else if (!isActive && hasEffect) {
            actor.toggleStatusEffect("fortified", { active: false });
          }
        }
      }
    }
  }
});

/** Redraw arrows when a weapon is created or deleted, and comms links when traits change. */
Hooks.on("createItem", async (item) => {
  if (item.type === "weapon") game.starmercs?.targetingArrowLayer?.drawArrows();
  if (item.type === "trait") {
    game.starmercs?.commsLinkManager?.invalidate();
    game.starmercs?.commsLinkLayer?.drawLinks();

    // When Flying trait is added, initialise flight flags
    if (item.name === "Flying" && item.parent) {
      const actor = item.parent;
      const token = actor.getActiveTokens()?.[0];
      const hexElev = token ? hexUtils.getHexElevation(hexUtils.snapToHexCenter(token.center)) : 0;
      await actor.setFlag("star-mercs", "altitude", hexElev);
      await actor.setFlag("star-mercs", "landed", false);
    }
  }
});

Hooks.on("deleteItem", async (item) => {
  if (item.type === "weapon") game.starmercs?.targetingArrowLayer?.drawArrows();
  if (item.type === "trait") {
    game.starmercs?.commsLinkManager?.invalidate();
    game.starmercs?.commsLinkLayer?.drawLinks();

    // When Flying trait is removed, clean up flight flags and status effect
    if (item.name === "Flying" && item.parent) {
      const actor = item.parent;
      try { await actor.unsetFlag("star-mercs", "altitude"); } catch (e) { /* flag may not exist */ }
      try { await actor.unsetFlag("star-mercs", "landed"); } catch (e) { /* flag may not exist */ }
      await actor.toggleStatusEffect("landed", { active: false });
    }
  }
});

/* ============================================ */
/*  Token Control — Show Planned Movement Path */
/* ============================================ */

/** When a token is selected, display its planned movement path (if any). */
Hooks.on("controlToken", (token, controlled) => {
  const pathLayer = game.starmercs?.movementPathLayer;
  if (!pathLayer) return;

  if (!controlled) {
    // Token deselected — clear path display
    pathLayer.clear();
    return;
  }

  const dest = token.document.getFlag("star-mercs", "moveDestination");
  if (!dest) {
    pathLayer.clear();
    return;
  }

  // Build waypoint array for the path layer
  const waypoints = token.document.getFlag("star-mercs", "moveWaypoints");
  const wpList = (waypoints && waypoints.length > 1)
    ? waypoints.map(wp => hexUtils.snapToHexCenter(wp))
    : [hexUtils.snapToHexCenter(dest)];

  pathLayer.drawPath(token, wpList, null);
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

  // Reset movement counters when entering preparation phase
  if (newPhase === "preparation") {
    for (const combatant of combat.combatants) {
      const token = combatant.token;
      if (token) {
        token.setFlag("star-mercs", "movementUsed", 0);
      }
    }
  }

  // Redraw arrows and comms links (movement destination arrows appear/disappear based on phase)
  game.starmercs?.targetingArrowLayer?.drawArrows();
  game.starmercs?.commsLinkLayer?.drawLinks();

  // Re-render all open unit sheets so phase indicators and order dropdown update
  for (const app of Object.values(ui.windows)) {
    if (app instanceof ActorSheet && app.actor?.type === "unit") {
      app.render(false);
    }
  }

  // Refresh turn control panel and deploy panel on any combat update
  game.starmercs?.turnControlPanel?.render(false);
  game.starmercs?.deployPanel?.render(false);
});

/** Refresh turn control panel when combat updates (tactical step changes, score changes, etc.). */
Hooks.on("updateCombat", (combat, changes) => {
  if (foundry.utils.hasProperty(changes, "flags.star-mercs.tacticalStep")
      || foundry.utils.hasProperty(changes, "flags.star-mercs.teamScores")) {
    game.starmercs?.turnControlPanel?.render(false);
  }
});

/** Refresh turn control panel when any user's ready flag changes. */
Hooks.on("updateUser", (user, changes) => {
  if (foundry.utils.hasProperty(changes, "flags.star-mercs.combatReady")) {
    game.starmercs?.turnControlPanel?.render(false);
  }
});

/** Refresh turn control panel when combat starts. */
Hooks.on("combatStart", () => {
  game.starmercs?.turnControlPanel?.render(false);
});

/** Close turn control panel when combat is deleted. */
Hooks.on("deleteCombat", () => {
  game.starmercs?.turnControlPanel?.render(false);
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

  // Insert after the combat tracker header (v13: html is a DOM element, not jQuery)
  const header = html.querySelector("#combat-round");
  if (header) {
    html.querySelectorAll(".star-mercs-phase-display").forEach(el => el.remove());
    header.insertAdjacentHTML("afterend", phaseHtml);
  }

  // Rename "Next Turn" button to "Next Phase"
  const nextTurnBtn = html.querySelector('a[data-control="nextTurn"]');
  if (nextTurnBtn) {
    nextTurnBtn.setAttribute("title", "Next Phase");
    const icon = nextTurnBtn.querySelector("i");
    if (icon) icon.setAttribute("title", "Next Phase");
  }

});

/* ============================================ */
/*  Chat Message Hooks                         */
/* ============================================ */

/** Handle chat message button clicks (v13: html is a DOM element, not jQuery). */
Hooks.on("renderChatMessageHTML", (message, html) => {
  // Morale button
  html.querySelectorAll(".roll-morale-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const combatId = btn.dataset.combatId;
      const combat = game.combats.get(combatId);
      if (!combat) return;
      btn.disabled = true;
      btn.textContent = "Rolling...";
      await combat.rollMoraleChecks();
      btn.textContent = "Morale Checks Complete";
    });
  });

  // Tactical sub-step: "Next Step" button
  html.querySelectorAll(".next-tactical-step-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const combatId = btn.dataset.combatId;
      const combat = game.combats.get(combatId);
      if (!combat) return;
      btn.disabled = true;
      btn.textContent = "Processing...";
      await combat.nextTurn();
    });
  });

  // Overwatch fire button
  html.querySelectorAll(".overwatch-fire-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const attackerDocId = btn.dataset.attackerId;
      const targetDocId = btn.dataset.targetId;

      const attackerToken = canvas.tokens.placeables.find(t => t.document.id === attackerDocId);
      const targetToken = canvas.tokens.placeables.find(t => t.document.id === targetDocId);
      if (!attackerToken?.actor || !targetToken?.actor) return;

      // Landed flying units cannot fire
      if (attackerToken.actor.hasTrait("Flying") && attackerToken.actor.getFlag("star-mercs", "landed")) {
        ui.notifications.warn(`${attackerToken.actor.name} is landed — must take off to fire weapons.`);
        return;
      }

      btn.disabled = true;
      btn.textContent = "Firing...";
      html.querySelectorAll(".overwatch-skip-btn").forEach(el => el.disabled = true);

      // Fire all in-range weapons at the target
      for (const weapon of attackerToken.actor.items) {
        if (weapon.type !== "weapon") continue;
        if (!weapon.system.range) continue;
        const dist = documents.StarMercsActor.getHexDistance(attackerToken, targetToken);
        if (dist <= weapon.system.range) {
          await attackerToken.actor.rollAttack(weapon, targetToken.actor);
        }
      }

      btn.textContent = "Fired!";
    });
  });

  // Overwatch skip button
  html.querySelectorAll(".overwatch-skip-btn").forEach(btn => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      btn.disabled = true;
      btn.textContent = "Held";
      html.querySelectorAll(".overwatch-fire-btn").forEach(el => {
        el.disabled = true;
        el.textContent = "Passed";
      });
    });
  });

  // Maneuver fire: fire only weapons that have assigned targets
  html.querySelectorAll(".maneuver-fire-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const tokenDocId = btn.dataset.tokenId;
      const combatId = btn.dataset.combatId;
      const combat = game.combats.get(combatId);
      if (!combat) return;

      const token = canvas.tokens.placeables.find(t => t.document.id === tokenDocId);
      if (!token?.actor) return;

      // Only the owning player or GM can fire
      if (!token.actor.isOwner && !game.user.isGM) return;

      // Landed flying units cannot fire
      if (token.actor.hasTrait("Flying") && token.actor.getFlag("star-mercs", "landed")) {
        ui.notifications.warn(`${token.actor.name} is landed — must take off to fire weapons.`);
        return;
      }

      btn.disabled = true;
      btn.textContent = "Firing...";

      let firedAny = false;
      for (const weapon of token.actor.items) {
        if (weapon.type !== "weapon") continue;
        if (weapon.system.artillery || weapon.system.aircraft) continue;
        if (!weapon.system.range) continue;

        // Only fire weapons that have an assigned target
        const targetId = weapon.system.targetId;
        if (!targetId) continue;

        const targetToken = canvas.tokens.placeables.find(t => t.document.id === targetId);
        if (!targetToken?.actor) continue;
        if (targetToken.actor.system.team === token.actor.system.team) continue;

        const dist = documents.StarMercsActor.getHexDistance(token, targetToken);
        if (dist <= weapon.system.range) {
          await token.actor.rollAttack(weapon, targetToken.actor);
          firedAny = true;
        }
      }

      if (!firedAny) {
        ui.notifications.info("No weapons had assigned targets in range.");
      }
      btn.textContent = "Fired!";
    });
  });

  // Chat card unit links: click to select token and pan camera
  html.querySelectorAll(".unit-link[data-token-id]").forEach(el => {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const tokenId = el.dataset.tokenId;
      if (!tokenId) return;
      const token = canvas.tokens.placeables.find(t => t.document.id === tokenId);
      if (!token) return;
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
    });
  });
});

/* ============================================ */
/*  Team Ownership Sync                        */
/* ============================================ */

/**
 * Sync a single actor's ownership based on team assignments.
 * Same-team players get Owner, opposing team gets None, spectators get Observer.
 * @param {Actor} actor
 */
async function syncActorOwnership(actor) {
  if (!game.user.isGM) return;
  if (!actor || actor.type !== "unit") return;
  if (!game.settings.get("star-mercs", "teamAssignmentsEnabled")) return;

  const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
  const actorTeam = actor.system.team ?? "a";
  const ownership = foundry.utils.deepClone(actor.ownership);
  let changed = false;

  for (const user of game.users) {
    if (user.isGM) continue;
    const userTeam = assignments[user.id];
    let level;

    if (!userTeam || userTeam === "spectator") {
      level = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
    } else if (userTeam === actorTeam) {
      level = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    } else {
      level = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
    }

    if (ownership[user.id] !== level) {
      ownership[user.id] = level;
      changed = true;
    }
  }

  if (changed) {
    await actor.update({ ownership });
  }
}

/**
 * Bulk-sync ownership for all unit actors.
 */
async function syncAllOwnership() {
  if (!game.user.isGM) return;
  for (const actor of game.actors) {
    if (actor.type === "unit") {
      await syncActorOwnership(actor);
    }
  }
}

// Expose sync functions on game.starmercs (set after init)
Hooks.once("ready", () => {
  game.starmercs.syncActorOwnership = syncActorOwnership;
  game.starmercs.syncAllOwnership = syncAllOwnership;
  game.starmercs.detection = detection;
});

/** Sync ownership when a unit's team changes. */
Hooks.on("updateActor", (actor, changes) => {
  if (foundry.utils.hasProperty(changes, "system.team")) {
    syncActorOwnership(actor);
  }
  // Redraw altitude overlay when flags change (altitude, landed)
  if (foundry.utils.hasProperty(changes, "flags.star-mercs")) {
    game.starmercs?.altitudeOverlayLayer?.drawAltitudeLabels();
  }
});

/** Sync ownership when a new unit is created. */
Hooks.on("createActor", (actor) => {
  if (actor.type === "unit") {
    syncActorOwnership(actor);
  }
});

/* ============================================ */
/*  Detection Visibility Enforcement           */
/* ============================================ */

/**
 * Enforce detection-based visibility on token refresh.
 * Enemy tokens are hidden, shown as blips, or fully visible based on detection.
 */
Hooks.on("refreshToken", (token) => {
  if (!canvas?.tokens?.placeables) return;
  if (game.user.isGM) return; // GM sees everything
  if (!game.settings.get("star-mercs", "teamAssignmentsEnabled")) return;

  const actor = token.actor;
  if (!actor || actor.type !== "unit") return;

  // Determine which team the current user is on
  const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
  const myTeam = assignments[game.user.id];
  if (!myTeam || myTeam === "spectator") return; // Spectators see all

  const tokenTeam = actor.system.team ?? "a";
  if (tokenTeam === myTeam) return; // Friendly token — always visible

  // Enemy token — compute detection level
  const level = detection.computeBestDetectionLevel(myTeam, token);

  if (level === "visible") {
    if (token.mesh) token.mesh.alpha = 1.0;
    token.visible = true;
  } else if (level === "blip") {
    // Dim the token and let the detection layer draw a "?" marker
    if (token.mesh) token.mesh.alpha = 0.15;
    token.visible = true;
  } else {
    // hidden
    if (token.mesh) token.mesh.alpha = 0;
    token.visible = false;
  }
});

/** Redraw detection overlay on token movement. */
Hooks.on("refreshToken", () => {
  game.starmercs?.detectionLayer?.drawDetection();
});

/** Reduce token nameplate font size (~1/3 of default) and shrink token bars (2/3 size). */
Hooks.on("refreshToken", (token) => {
  // Shrink nameplate text and reposition just below token
  if (token.nameplate) {
    token.nameplate.style.fontSize = 10;
    // Position nameplate just below the token graphic
    const tokenH = token.h ?? token.document.height * canvas.grid.size;
    token.nameplate.position.y = tokenH + 2;
  }

  // Shrink token bars to 2/3 size — scale each bar child individually
  // so that each bar stays at its Foundry-assigned Y position
  if (token.bars) {
    const scale = 0.67;
    const tokenW = token.w ?? token.document.width * canvas.grid.size;
    const xOffset = tokenW * (1 - scale) / 2;

    // Reset any container-level scaling from previous approach
    token.bars.scale.set(1, 1);

    for (const child of token.bars.children) {
      child.scale.set(scale, scale);
      // Store original X on first encounter to prevent accumulation
      if (child._smOrigX === undefined) child._smOrigX = child.position.x;
      child.position.x = child._smOrigX + xOffset;
    }
  }
});

/* ============================================ */
/*  Scene Control Buttons                      */
/* ============================================ */

/** Add the targeting arrows toggle button to the scene controls. */
Hooks.on("getSceneControlButtons", (controls) => {
  // v13: controls is an object keyed by name; v12: controls is an array
  const isV13 = !Array.isArray(controls);
  const tokenControls = isV13 ? controls.tokens : controls.find(c => c.name === "token");
  if (!tokenControls) return;

  const tool = {
    name: "targetingArrows",
    title: "Targeting Arrows",
    icon: "fas fa-location-arrow",
    visible: true,
    toggle: true,
    active: game.settings.get("star-mercs", "showTargetingArrows"),
    onChange: (event, active) => {
      game.settings.set("star-mercs", "showTargetingArrows", active);
    }
  };

  const commsTool = {
    name: "commsLinks",
    title: "Comms Links",
    icon: "fas fa-broadcast-tower",
    visible: true,
    toggle: true,
    active: game.settings.get("star-mercs", "showCommsLinks"),
    onChange: (event, active) => {
      game.settings.set("star-mercs", "showCommsLinks", active);
    }
  };

  const terrainTool = {
    name: "terrainOverlay",
    title: "Terrain Overlay",
    icon: "fas fa-map",
    visible: true,
    toggle: true,
    active: game.settings.get("star-mercs", "showTerrainOverlay"),
    onChange: (event, active) => {
      game.settings.set("star-mercs", "showTerrainOverlay", active);
    }
  };

  const terrainPaintTool = {
    name: "terrainPainter",
    title: "Terrain Painter",
    icon: "fas fa-paint-brush",
    visible: game.user.isGM,
    toggle: false,
    onChange: () => {
      new TerrainPainter().render(true);
    }
  };

  const detectionTool = {
    name: "detectionOverlay",
    title: "Detection Overlay",
    icon: "fas fa-satellite-dish",
    visible: true,
    toggle: true,
    active: game.settings.get("star-mercs", "showDetectionOverlay"),
    onChange: (event, active) => {
      game.settings.set("star-mercs", "showDetectionOverlay", active);
    }
  };

  const teamSettingsTool = {
    name: "teamSettings",
    title: "Team Settings",
    icon: "fas fa-users-cog",
    visible: game.user.isGM,
    toggle: false,
    onChange: () => {
      new TeamSettingsForm().render(true);
    }
  };

  const tacticalMarkerTool = {
    name: "tacticalMarkers",
    title: "Tactical Markers",
    icon: "fas fa-map-marker-alt",
    visible: true,
    toggle: false,
    onChange: () => {
      new TacticalMarkerPainter().render(true);
    }
  };

  const structureSettingsTool = {
    name: "structureSettings",
    title: "Structure Settings",
    icon: "fas fa-hard-hat",
    visible: game.user.isGM,
    toggle: false,
    onChange: () => {
      new StructureSettings().render(true);
    }
  };

  const turnControlTool = {
    name: "turnControl",
    title: "Turn Control",
    icon: "fas fa-flag-checkered",
    visible: true,
    toggle: true,
    active: game.starmercs?.turnControlPanel?.rendered ?? false,
    onChange: (event, active) => {
      if (active) {
        if (!game.starmercs.turnControlPanel) {
          game.starmercs.turnControlPanel = new TurnControlPanel();
        }
        game.starmercs.turnControlPanel.render(true);
      } else {
        game.starmercs.turnControlPanel?.close();
      }
    }
  };

  const deployPanelTool = {
    name: "deployPanel",
    title: "Deploy Panel",
    icon: "fas fa-parachute-box",
    visible: true,
    toggle: true,
    active: game.starmercs?.deployPanel?.rendered ?? false,
    onChange: (event, active) => {
      if (active) {
        if (!game.starmercs.deployPanel) {
          game.starmercs.deployPanel = new DeployPanel();
        }
        game.starmercs.deployPanel.render(true);
      } else {
        game.starmercs.deployPanel?.close();
      }
    }
  };

  if (isV13) {
    tool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.targetingArrows = tool;
    commsTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.commsLinks = commsTool;
    terrainTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.terrainOverlay = terrainTool;
    terrainPaintTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.terrainPainter = terrainPaintTool;
    detectionTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.detectionOverlay = detectionTool;
    teamSettingsTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.teamSettings = teamSettingsTool;
    tacticalMarkerTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.tacticalMarkers = tacticalMarkerTool;
    structureSettingsTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.structureSettings = structureSettingsTool;
    turnControlTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.turnControl = turnControlTool;
    deployPanelTool.order = Object.keys(tokenControls.tools).length;
    tokenControls.tools.deployPanel = deployPanelTool;
  } else {
    tokenControls.tools.push(tool);
    tokenControls.tools.push(commsTool);
    tokenControls.tools.push(terrainTool);
    tokenControls.tools.push(terrainPaintTool);
    tokenControls.tools.push(detectionTool);
    tokenControls.tools.push(teamSettingsTool);
    tokenControls.tools.push(tacticalMarkerTool);
    tokenControls.tools.push(structureSettingsTool);
    tokenControls.tools.push(turnControlTool);
    tokenControls.tools.push(deployPanelTool);
  }
});
