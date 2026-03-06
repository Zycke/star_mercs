import StarMercsActor from "../documents/actor.mjs";
import { snapToHexCenter, hexKey, computeHexPath, calculatePathCost,
  getHexData, getHexElevation, getAdjacentHexCenters, getStructureAtHex, normalizeHexData } from "../hex-utils.mjs";
import { checkLOS, getActiveSignature, getTerrainCoverMod } from "../detection.mjs";
import ConstructionPicker from "../apps/construction-picker.mjs";
import TransportPicker from "../apps/transport-picker.mjs";

/**
 * Sheet class for Star Mercs Unit actors.
 * Displays unit attributes, embedded weapons/traits/orders, and combat status.
 */
export default class StarMercsUnitSheet extends ActorSheet {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["star-mercs", "sheet", "actor", "unit"],
      template: "systems/star-mercs/templates/actors/unit-sheet.hbs",
      width: 720,
      height: 720,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "attributes" }],
      dragDrop: [{ dragSelector: ".item-list .item", dropSelector: null }]
    });
  }

  /* ---------------------------------------- */
  /*  Data Preparation                        */
  /* ---------------------------------------- */

  /** @override */
  async getData(options) {
    const context = await super.getData(options);
    const actorData = this.document.toObject(false);

    // Core data
    context.system = actorData.system;
    context.flags = actorData.flags;

    // Derived data from the TypeDataModel
    context.derived = {
      ratingBonus: this.actor.system.ratingBonus,
      casualtyPenalty: this.actor.system.casualtyPenalty,
      readinessPenalty: this.actor.system.readinessPenalty,
      isRouted: this.actor.system.isRouted,
      isDestroyed: this.actor.system.isDestroyed
    };

    // Ownership flag for template guards
    context.isOwner = this.actor.isOwner;

    // Deploy pool lock: unit in deploy pool is read-only for players
    const deployPool = game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] };
    const isInDeployPool = Object.values(deployPool).flat().some(e => e.actorId === this.actor.id);
    context.isInDeployPool = isInDeployPool;
    context.isDeployLocked = isInDeployPool && !game.user.isGM;

    // Detection range (derived): range vs configured target signature
    const sensors = this.actor.system.sensors ?? 0;
    const targetSig = game.settings.get("star-mercs", "detectionRingTargetSig") ?? 2;
    context.detectionRangeLOS = sensors + targetSig;
    context.detectionRangeNoLOS = Math.floor(sensors / 2) + targetSig;

    // Rating choices for the dropdown
    context.ratingChoices = {
      green: "Green (+0)",
      trained: "Trained (+1)",
      experienced: "Experienced (+2)",
      veteran: "Veteran (+3)",
      elite: "Elite (+5)"
    };

    // Team choices for the dropdown
    context.teamChoices = {
      a: "Team A",
      b: "Team B"
    };

    // Organize embedded items by type
    this._prepareItems(context);

    // Active traits for summary on Attributes tab
    context.activeTraits = this.actor.items.filter(i => i.type === "trait" && i.system.active);

    // Phase-aware context
    const combat = game.combat;
    context.combatActive = combat?.started ?? false;
    context.currentPhase = combat?.phase ?? null;
    context.phaseLabel = combat?.phaseLabel ?? null;
    context.isOrdersPhase = combat?.phase === "orders";
    context.isTacticalPhase = combat?.phase === "tactical";

    // Available orders from config (filtered by trait requirements, supply, and morale status)
    const allOrders = CONFIG.STARMERCS.orders ?? {};
    // Check if all ammo supply categories are empty
    const sup = this.actor.system.supply ?? {};
    const hasNoSupply = (sup.projectile?.current ?? 0) <= 0
      && (sup.ordnance?.current ?? 0) <= 0
      && (sup.energy?.current ?? 0) <= 0;
    const zeroSupplyOrders = ["hold", "move", "withdraw", "entrench", "stand_down", "forced_march", "fly", "change_altitude"];

    // Check Breaking/Broken status from token flags
    const activeToken = this.actor.getActiveTokens()?.[0];
    const isBreaking = activeToken?.document?.getFlag("star-mercs", "breaking") ?? false;
    const isBroken = activeToken?.document?.getFlag("star-mercs", "broken") ?? false;
    const breakingOrders = ["hold", "withdraw"];
    context.isBreaking = isBreaking;
    context.isBroken = isBroken;
    context.isDisordered = activeToken?.document?.getFlag("star-mercs", "disordered") ?? false;

    // Check engagement status (adjacent to enemies)
    const hUtils = game.starmercs?.hexUtils;
    const unitIsEngaged = activeToken && hUtils ? hUtils.isEngaged(activeToken) : false;
    context.isEngaged = unitIsEngaged;

    // Check if unit is aboard a transport (cargo units cannot receive orders)
    context.isAboardTransport = this.actor.isAboardTransport();

    // Orders that engaged units cannot take (movement orders except withdraw/assault)
    const engagedBlockedOrders = ["move", "forced_march", "fly"];

    // Flying units replace Maneuver/Forced March with Fly/Change Altitude
    const isFlying = this.actor.hasTrait("Flying");

    context.availableOrders = Object.entries(allOrders)
      .filter(([key, data]) => {
        // Cargo units aboard a transport cannot receive orders
        if (context.isAboardTransport) return false;
        // Breaking/Broken units can only Hold or Withdraw
        if ((isBreaking || isBroken) && !breakingOrders.includes(key)) return false;
        // Engaged units cannot Maneuver or Forced March
        if (unitIsEngaged && engagedBlockedOrders.includes(key)) return false;
        // All orders with requiredTrait need that trait
        if (data.requiredTrait) {
          if (!this.actor.hasTrait(data.requiredTrait)) return false;
        }
        // Flying units use Fly/Change Altitude instead of Maneuver/Forced March
        if (isFlying && (key === "move" || key === "forced_march")) return false;
        // Zero supply: only Hold, Move, Withdraw
        if (hasNoSupply && !zeroSupplyOrders.includes(key)) return false;
        return true;
      })
      .map(([key, data]) => ({
        key,
        label: data.label,
        category: data.category,
        allowsMovement: data.allowsMovement,
        allowsAttack: data.allowsAttack,
        readinessCost: data.readinessCost
      }));

    context.hasNoSupply = hasNoSupply;

    // Currently selected order key and its config data (add resolved labelText)
    context.currentOrderKey = this.actor.system.currentOrder || "";
    const rawOrderData = allOrders[context.currentOrderKey] || null;
    if (rawOrderData) {
      context.currentOrderData = Object.assign({}, rawOrderData, {
        labelText: rawOrderData.label
      });
    } else {
      context.currentOrderData = null;
    }

    // Order details for the selected order
    if (context.currentOrderData) {
      const od = context.currentOrderData;
      context.orderDetails = {
        allowsAttack: od.allowsAttack,
        allowsMovement: od.allowsMovement,
        readinessCost: od.readinessCost,
        supplyModifier: od.supplyModifier,
        movement: this.actor.system.movement ?? 0
      };
    }

    // Movement points: current/total (factoring in order multiplier)
    {
      let mpMax = this.actor.system.movement ?? 0;
      const currentOrderKey = this.actor.system.currentOrder;
      const curOrderConfig = CONFIG.STARMERCS.orders?.[currentOrderKey];
      if (curOrderConfig?.speedMultiplier) mpMax *= curOrderConfig.speedMultiplier;
      const mpUsed = activeToken?.document?.getFlag("star-mercs", "movementUsed") ?? 0;
      context.mpMax = mpMax;
      context.mpUsed = mpUsed;
      context.mpRemaining = Math.max(0, mpMax - mpUsed);
    }

    // Pending damage on this unit's token (if any)
    const token = this.actor.getActiveTokens()?.[0];
    if (token?.document) {
      const pending = token.document.getFlag("star-mercs", "pendingDamage");
      if (pending && (pending.strength > 0 || pending.readiness > 0)) {
        context.pendingDamage = pending;
      }
    }

    // Supply transfer: only during preparation phase
    context.isPreparationPhase = combat?.phase === "preparation";
    // Supply transfer: preparation phase only; airborne flying units need the Supply trait
    const isAirborneNoSupply = this.actor.hasTrait("Flying")
      && !this.actor.getFlag("star-mercs", "landed")
      && !this.actor.hasTrait("Supply");
    context.canTransferSupply = (!combat?.started || combat?.phase === "preparation") && !isAirborneNoSupply;
    context.supplyTransferRange = this.actor.getSupplyTransferRange();

    // Active Signature (base + terrain modifiers)
    if (activeToken) {
      const sigData = getActiveSignature(activeToken);
      context.activeSignature = sigData.active;
      context.baseSignature = sigData.base;
      context.signatureModifiers = sigData.modifiers;
      context.hasSignatureModifiers = sigData.modifiers.length > 0;
    } else {
      context.activeSignature = this.actor.system.signature ?? 0;
      context.baseSignature = this.actor.system.signature ?? 0;
      context.signatureModifiers = [];
      context.hasSignatureModifiers = false;
    }

    // Terrain cover (accuracy penalty for attackers targeting this unit)
    if (activeToken) {
      const coverData = getTerrainCoverMod(activeToken);
      context.terrainCoverMod = coverData.mod;
      context.terrainCoverModifiers = coverData.modifiers;
      context.hasTerrainCover = coverData.mod > 0;
    } else {
      context.terrainCoverMod = 0;
      context.terrainCoverModifiers = [];
      context.hasTerrainCover = false;
    }

    // Sensor ring controls (client settings)
    context.showDetectionRing = game.settings.get("star-mercs", "showDetectionRing");
    context.detectionRingTargetSig = game.settings.get("star-mercs", "detectionRingTargetSig");

    // LOS highlight control (client setting)
    context.showLOSHighlight = game.settings.get("star-mercs", "showLOSHighlight");

    // Advanced Recon Equipment: show targeting box if unit has the trait
    context.hasAdvancedRecon = this.actor.hasTrait("Advanced Recon Equipment");
    if (context.hasAdvancedRecon && activeToken) {
      const reconTargetId = activeToken.document?.getFlag("star-mercs", "advReconTarget") ?? "";
      context.advReconTargetId = reconTargetId;
      if (reconTargetId) {
        const reconTargetToken = canvas?.tokens?.get(reconTargetId);
        context.advReconTargetName = reconTargetToken?.name ?? "Unknown";
      } else {
        context.advReconTargetName = "";
      }
    }

    // GM overrides
    context.isGM = game.user.isGM;
    context.allOrders = allOrders;

    // Log tab data
    context.log = this.actor.system.log ?? [];

    // Flight status (altitude & landing) for Flying units
    context.isFlying = this.actor.hasTrait("Flying");
    if (context.isFlying) {
      context.isLanded = this.actor.getFlag("star-mercs", "landed") ?? false;
      context.isAirborne = !context.isLanded;

      // Get hex elevation for altitude bounds
      let hexElev = 0;
      if (activeToken) {
        hexElev = getHexElevation(snapToHexCenter(activeToken.center));
      }
      context.currentAltitude = this.actor.getFlag("star-mercs", "altitude") ?? hexElev;
      context.minAltitude = hexElev;
      context.maxAltitude = 5;
      context.canLandHere = this.actor.canLand();
      context.canTakeOff = this.actor.canTakeOff();

      // GM altitude override: always available for GMs when airborne
      const canClimb = context.isAirborne && context.currentAltitude < 5;
      const canDescend = context.isAirborne && context.currentAltitude > hexElev;
      context.canClimb = canClimb;
      context.canDescend = canDescend;

      // Show altitude target from Change Altitude or Fly orders
      const altTarget = activeToken?.document?.getFlag("star-mercs", "altitudeTarget");
      const flyAltTarget = activeToken?.document?.getFlag("star-mercs", "flyAltitudeTarget");
      if (altTarget != null) {
        context.altitudeTargetSet = true;
        context.altitudeTargetValue = altTarget;
      } else if (flyAltTarget != null) {
        context.altitudeTargetSet = true;
        context.altitudeTargetValue = flyAltTarget;
      }
    }

    return context;
  }

  /**
   * Categorize embedded items into typed arrays for the template.
   * Resolves weapon targetIds to actor names for display.
   * @param {object} context - The template rendering context.
   */
  _prepareItems(context) {
    const weapons = [];
    const traits = [];
    const orders = [];
    let hasTargetedWeapons = false;

    for (const item of this.actor.items) {
      if (item.type === "weapon") {
        // Build weapon display data with resolved target name
        // Resolve attack type label and weapon traits label
        const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air", aps: "APS", zps: "ZPS" };
        const wTraits = [];
        if (item.system.indirect) wTraits.push("Indirect");
        if (item.system.area) wTraits.push("Area");
        if (item.system.artillery) wTraits.push("Artillery");
        if (item.system.aircraft) wTraits.push("Aircraft");
        if (item.system.accurate > 0) wTraits.push(`Acc+${item.system.accurate}`);
        if (item.system.inaccurate > 0) wTraits.push(`Inacc-${item.system.inaccurate}`);
        const weaponData = {
          _id: item.id,
          img: item.img,
          name: item.name,
          system: item.system,
          attackTypeLabel: attackTypeLabels[item.system.attackType] ?? item.system.attackType,
          traitsLabel: wTraits.length > 0 ? wTraits.join(", ") : "—",
          targetName: null,
          targetId: null,
          isDefensive: (item.system.attackType === "aps" || item.system.attackType === "zps")
        };

        const targetId = item.system.targetId;
        if (targetId) {
          const targetToken = canvas?.tokens?.get(targetId);
          weaponData.targetName = targetToken?.name ?? "Unknown";
          weaponData.targetId = targetId;
          hasTargetedWeapons = true;
        }
        weapons.push(weaponData);
      } else if (item.type === "trait") {
        const modeLabels = { passive: "Passive", active: "Active", conditional: "Conditional" };
        const traitData = {
          _id: item.id,
          img: item.img,
          name: item.name,
          system: item.system,
          modeLabel: modeLabels[item.system.passive] ?? item.system.passive
        };
        traits.push(traitData);
      } else if (item.type === "order") {
        orders.push(item);
      }
    }

    context.weapons = weapons;
    context.traits = traits;
    context.orders = orders;
    context.hasTargetedWeapons = hasTargetedWeapons;
  }

  /* ---------------------------------------- */
  /*  Event Listeners                         */
  /* ---------------------------------------- */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    if (!this.isEditable) return;

    // Item CRUD
    html.on("click", ".item-create", this._onItemCreate.bind(this));
    html.on("click", ".item-edit", this._onItemEdit.bind(this));
    html.on("click", ".item-delete", this._onItemDelete.bind(this));

    // Weapon attack roll (single weapon)
    html.on("click", ".weapon-roll", this._onWeaponRoll.bind(this));

    // Weapon targeting
    html.on("click", ".weapon-assign-target", this._onAssignTarget.bind(this));
    html.on("click", ".weapon-clear-target", this._onClearTarget.bind(this));

    // Fire all targeted weapons
    html.on("click", ".fire-all-weapons", this._onFireAll.bind(this));

    // Clear all weapon targets
    html.on("click", ".clear-all-targets", this._onClearAllTargets.bind(this));

    // Post item to chat
    html.on("click", ".item-chat", this._onItemChat.bind(this));

    // Order assignment dropdown (Orders phase)
    html.on("change", ".order-select", this._onOrderSelect.bind(this));

    // Movement destination selection (Orders phase)
    html.on("click", ".set-move-destination", this._onSetMoveDestination.bind(this));

    // Trait activation toggle
    html.on("change", ".trait-active-toggle", this._onTraitToggle.bind(this));

    // Supply transfer
    html.on("click", ".transfer-supply-btn", this._onTransferSupply.bind(this));

    // Flight controls (landing, takeoff, altitude)
    html.on("click", ".flight-land-btn", this._onLand.bind(this));
    html.on("click", ".flight-takeoff-btn", this._onTakeOff.bind(this));
    html.on("click", ".altitude-up-btn", this._onAltitudeUp.bind(this));
    html.on("click", ".altitude-down-btn", this._onAltitudeDown.bind(this));

    // Log tab: clear log
    html.on("click", ".clear-log-btn", this._onClearLog.bind(this));

    // GM overrides
    html.on("change", ".gm-toggle-breaking", this._onGMToggleBreaking.bind(this));
    html.on("change", ".gm-order-override", this._onGMOrderOverride.bind(this));

    // Sensor ring controls
    html.on("change", ".sm-sheet-ring-toggle", (event) => {
      game.settings.set("star-mercs", "showDetectionRing", event.currentTarget.checked);
    });
    html.on("change", ".sm-sheet-ring-sig", (event) => {
      game.settings.set("star-mercs", "detectionRingTargetSig", Number(event.currentTarget.value));
    });

    // LOS highlight control
    html.on("change", ".sm-sheet-los-toggle", (event) => {
      game.settings.set("star-mercs", "showLOSHighlight", event.currentTarget.checked);
    });

    // Advanced Recon Equipment targeting
    html.on("click", ".set-recon-target", this._onSetReconTarget.bind(this));
    html.on("click", ".clear-recon-target", this._onClearReconTarget.bind(this));
  }

  /* ---------------------------------------- */
  /*  Item CRUD Handlers                      */
  /* ---------------------------------------- */

  async _onItemCreate(event) {
    event.preventDefault();
    const type = event.currentTarget.dataset.type;
    const itemData = {
      name: `New ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      type: type
    };
    return this.actor.createEmbeddedDocuments("Item", [itemData]);
  }

  _onItemEdit(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    item?.sheet.render(true);
  }

  async _onItemDelete(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const itemId = li.dataset.itemId;
    return this.actor.deleteEmbeddedDocuments("Item", [itemId]);
  }

  /* ---------------------------------------- */
  /*  Weapon Attack Handlers                  */
  /* ---------------------------------------- */

  /**
   * Roll a single weapon attack.
   * Uses the weapon's stored target if set, otherwise falls back to Foundry's targeting.
   */
  async _onWeaponRoll(event) {
    event.preventDefault();

    // Block weapon fire for landed flying units
    if (this.actor.hasTrait("Flying") && this.actor.getFlag("star-mercs", "landed")) {
      ui.notifications.warn("Landed units cannot fire weapons — take off first.");
      return;
    }

    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if (!item) return;

    // Prefer the weapon's stored target; fall back to Foundry targeting
    let target = null;
    const storedTargetId = item.system.targetId;
    if (storedTargetId) {
      const targetToken = canvas?.tokens?.get(storedTargetId);
      target = targetToken?.actor;
    } else {
      const targets = game.user.targets;
      if (targets.size > 0) {
        target = targets.first().actor;
      }
    }

    return this.actor.rollAttack(item, target);
  }

  /**
   * Assign the currently targeted Foundry token as this weapon's target.
   */
  async _onAssignTarget(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const itemId = li.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (!item) return;

    // APS/ZPS are defensive-only — cannot be assigned targets
    if (item.system.attackType === "aps" || item.system.attackType === "zps") {
      ui.notifications.warn(`${item.name} is a defensive system — it cannot be assigned targets.`);
      return;
    }

    const targets = game.user.targets;
    if (targets.size === 0) {
      ui.notifications.warn("Select a target token first (click a token while holding the target key).");
      return;
    }

    const targetToken = targets.first();
    if (!targetToken.actor) {
      ui.notifications.warn("Target token has no associated actor.");
      return;
    }

    // Ensure unit is on the map
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Unit must be placed on the map to assign targets.");
      return;
    }

    // Range check
    const distance = StarMercsActor.getHexDistance(myToken, targetToken);
    if (item.system.range > 0 && distance > item.system.range) {
      ui.notifications.warn(
        `${item.name} is out of range (${item.system.range} hex max, target is ${distance} hexes away).`
      );
      return;
    }

    // Detection check: unit must be able to detect the target (visible level)
    const det = game.starmercs?.detection;
    if (det) {
      const detLevel = det.getDetectionLevel(myToken, targetToken);
      if (detLevel !== "visible") {
        ui.notifications.warn(
          detLevel === "blip"
            ? `Cannot assign target — ${targetToken.name} is only a sensor blip (not positively identified).`
            : `Cannot assign target — ${targetToken.name} is beyond detection range.`
        );
        return;
      }
    }

    // Line of Sight / comms chain validation (uses terrain-based LOS)
    {
      const hasDirectLOS = checkLOS(myToken.center, targetToken.center);
      const manager = game.starmercs?.commsLinkManager;

      if (item.system.indirect) {
        // Indirect weapons: require LOS from firing unit OR any comms chain member
        if (!hasDirectLOS) {
          const canSeeViaChain = manager?.canSeeViaChainTerrain(myToken.id, targetToken.id) ?? false;
          if (!canSeeViaChain) {
            ui.notifications.warn(`${item.name} requires a spotter — no unit in comms chain has Line of Sight to target.`);
            return;
          }
        }
      } else if (item.system.aircraft) {
        // Aircraft weapons: require chain LOS OR Satellite Uplink in chain
        if (!hasDirectLOS) {
          const canSeeForAirstrike = manager?.canSeeForAirstrikeTerrain(myToken.id, targetToken.id) ?? false;
          if (!canSeeForAirstrike) {
            ui.notifications.warn(`${item.name} requires a spotter or Satellite Uplink in comms chain to acquire target.`);
            return;
          }
        }
      } else {
        // Standard weapons: require direct LOS
        if (!hasDirectLOS) {
          ui.notifications.warn(`${item.name} requires Line of Sight — target is not visible.`);
          return;
        }
      }
    }

    await item.update({ "system.targetId": targetToken.id });
  }

  /**
   * Clear a single weapon's assigned target.
   */
  async _onClearTarget(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const itemId = li.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (!item) return;

    await item.update({ "system.targetId": "" });
  }

  /**
   * Fire all weapons that have assigned targets simultaneously.
   */
  async _onFireAll(event) {
    event.preventDefault();
    // Block firing for landed flying units
    if (this.actor.hasTrait("Flying") && this.actor.getFlag("star-mercs", "landed")) {
      ui.notifications.warn("Landed units cannot fire weapons — take off first.");
      return;
    }
    return this.actor.rollAllAttacks();
  }

  /* ---------------------------------------- */
  /*  Flight Controls                         */
  /* ---------------------------------------- */

  async _onLand(event) {
    event.preventDefault();
    if (!this.actor.canLand()) {
      ui.notifications.warn("Cannot land here. Altitude must equal hex elevation.");
      return;
    }
    await this.actor.land();
    ui.notifications.info(`${this.actor.name} has landed.`);
  }

  async _onTakeOff(event) {
    event.preventDefault();
    if (!this.actor.canTakeOff()) {
      ui.notifications.warn("Cannot take off.");
      return;
    }
    await this.actor.takeOff();
    ui.notifications.info(`${this.actor.name} is now airborne.`);
  }

  async _onAltitudeUp(event) {
    event.preventDefault();
    const result = await this.actor.changeAltitude(1);
    if (!result.success) ui.notifications.warn(result.reason);
  }

  async _onAltitudeDown(event) {
    event.preventDefault();
    const result = await this.actor.changeAltitude(-1);
    if (!result.success) ui.notifications.warn(result.reason);
  }

  /**
   * Prompt the player to pick a target altitude for the Change Altitude order.
   * Validates fuel availability and stores the target on a token flag.
   * @private
   */
  _promptAltitudeTarget() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    const currentAlt = this.actor.getFlag("star-mercs", "altitude") ?? 0;
    const hexElev = getHexElevation(snapToHexCenter(myToken.center));
    const fuelAvailable = this.actor.system.supply?.fuel?.current ?? 0;
    const maxAlt = 5;

    // Build altitude options
    const options = [];
    for (let alt = hexElev; alt <= maxAlt; alt++) {
      if (alt === currentAlt) continue;
      const fuelCost = Math.abs(alt - currentAlt);
      const valid = fuelCost <= fuelAvailable;
      options.push(`<option value="${alt}" ${!valid ? "disabled" : ""}>${alt} (${fuelCost} fuel${!valid ? " — insufficient" : ""})</option>`);
    }

    if (options.length === 0) {
      ui.notifications.warn("No valid altitude changes available.");
      this.actor.update({ "system.currentOrder": "" });
      return;
    }

    const actor = this.actor;
    const dialogContent = `
      <form class="altitude-target-form">
        <p>Current Altitude: <strong>${currentAlt}</strong> | Fuel: <strong>${fuelAvailable}</strong></p>
        <div class="form-group">
          <label>Target Altitude</label>
          <select id="altitude-target">${options.join("")}</select>
        </div>
        <p class="notes">Costs 1 fuel per altitude level changed.</p>
      </form>
    `;

    new Dialog({
      title: "Change Altitude — Select Target",
      content: dialogContent,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-check"></i>',
          label: "Confirm",
          callback: async (html) => {
            const targetAlt = parseInt(html.find("#altitude-target").val());
            if (isNaN(targetAlt)) return;
            const fuelCost = Math.abs(targetAlt - currentAlt);
            if (fuelCost > fuelAvailable) {
              ui.notifications.warn("Not enough fuel for this altitude change.");
              return;
            }
            await myToken.document.setFlag("star-mercs", "altitudeTarget", targetAlt);
            ui.notifications.info(`Altitude target set: ${currentAlt} → ${targetAlt} (${fuelCost} fuel).`);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: async () => {
            await actor.update({ "system.currentOrder": "" });
            ui.notifications.info("Change Altitude order cancelled.");
          }
        }
      },
      default: "confirm"
    }).render(true);
  }

  /**
   * Clear all weapon targets at once.
   */
  async _onClearAllTargets(event) {
    event.preventDefault();
    const updates = [];
    for (const item of this.actor.items) {
      if (item.type === "weapon" && item.system.targetId) {
        updates.push({ _id: item.id, "system.targetId": "" });
      }
    }
    if (updates.length > 0) {
      await this.actor.updateEmbeddedDocuments("Item", updates);
    }
  }

  /* ---------------------------------------- */
  /*  Advanced Recon Equipment Targeting       */
  /* ---------------------------------------- */

  /**
   * Set the Advanced Recon Equipment target by clicking a visible enemy token.
   */
  async _onSetReconTarget(event) {
    event.preventDefault();
    const activeToken = this.actor.getActiveTokens()?.[0];
    if (!activeToken) {
      ui.notifications.warn("No active token found on canvas.");
      return;
    }

    ui.notifications.info("Click an enemy unit to designate as the Recon target.");

    const handler = async (event) => {
      canvas.stage.off("pointerdown", handler);
      const pos = event.getLocalPosition?.(canvas.stage)
        ?? canvas.stage.toLocal(event.global);
      const clicked = canvas.tokens.placeables.find(t => {
        const dx = pos.x - t.center.x;
        const dy = pos.y - t.center.y;
        return Math.sqrt(dx * dx + dy * dy) < t.w;
      });
      if (!clicked?.actor || clicked.actor.type !== "unit") {
        ui.notifications.warn("No valid unit clicked.");
        return;
      }
      // Must be an enemy
      const myTeam = this.actor.system.team ?? "a";
      const targetTeam = clicked.actor.system.team ?? "a";
      if (myTeam === targetTeam) {
        ui.notifications.warn("Cannot designate a friendly unit.");
        return;
      }
      // Must be visible-level detection
      const det = game.starmercs?.detection;
      if (det) {
        const detLevel = det.getDetectionLevel(activeToken, clicked);
        if (detLevel !== "visible") {
          ui.notifications.warn("Target must be fully detected (visible) to designate.");
          return;
        }
      }
      await activeToken.document.setFlag("star-mercs", "advReconTarget", clicked.id);
      ui.notifications.info(`Designated ${clicked.name} as Recon target.`);
      this.render(false);
    };

    canvas.stage.on("pointerdown", handler);
  }

  /**
   * Clear the Advanced Recon Equipment target.
   */
  async _onClearReconTarget(event) {
    event.preventDefault();
    const activeToken = this.actor.getActiveTokens()?.[0];
    if (activeToken?.document) {
      await activeToken.document.unsetFlag("star-mercs", "advReconTarget");
      this.render(false);
    }
  }

  /* ---------------------------------------- */
  /*  Order Assignment                        */
  /* ---------------------------------------- */

  /**
   * Handle order selection from the dropdown during Orders phase.
   * If the Assault order is selected, prompt user to pick a target within movement range.
   */
  async _onOrderSelect(event) {
    event.preventDefault();
    const selectedOrderKey = event.currentTarget.value;
    await this.actor.update({ "system.currentOrder": selectedOrderKey });

    // Log the order assignment
    const orderConfig = CONFIG.STARMERCS.orders?.[selectedOrderKey];
    if (orderConfig) {
      await this.actor.addLogEntry(`Order: ${orderConfig.label}`, "order");
    }

    // Clear any previous assault target, movement destination, and flight targets
    const token = this.actor.getActiveTokens()?.[0];
    if (token?.document) {
      await token.document.unsetFlag("star-mercs", "assaultTarget");
      await token.document.unsetFlag("star-mercs", "moveDestination");
      await token.document.unsetFlag("star-mercs", "altitudeTarget");
      await token.document.unsetFlag("star-mercs", "flyAltitudeTarget");
    }

    // Redraw arrows to remove stale movement arrows
    game.starmercs?.targetingArrowLayer?.drawArrows();

    // Clear construction/demolish flags (preserve constructionTarget for construct)
    if (token?.document) {
      if (selectedOrderKey !== "construct") {
        await token.document.unsetFlag("star-mercs", "constructionTarget");
      }
      await token.document.unsetFlag("star-mercs", "demolishTarget");
    }

    // If assault order selected, prompt for target selection
    if (selectedOrderKey === "assault") {
      this._promptAssaultTarget();
    }

    // If change_altitude order selected, prompt for target altitude
    if (selectedOrderKey === "change_altitude") {
      this._promptAltitudeTarget();
    }

    // If fly order selected, extend move destination to include altitude
    // (altitude is picked during move destination confirmation)

    // If construct order selected, open ConstructionPicker
    if (selectedOrderKey === "construct") {
      this._promptConstructionTarget();
    }

    // If demolish order selected, prompt for demolish target
    if (selectedOrderKey === "demolish") {
      this._promptDemolishTarget();
    }

    // If transport order selected, open TransportPicker
    if (selectedOrderKey === "transport") {
      this._promptTransportAction();
    }

    // If air_assault order selected, prompt for target hex
    if (selectedOrderKey === "air_assault") {
      this._promptAirAssaultTarget();
    }

    // If hot_disembark order selected, prompt for target hex
    if (selectedOrderKey === "hot_disembark") {
      this._promptHotDisembarkTarget();
    }
  }

  /**
   * Prompt the user to select an assault target within movement range.
   * @private
   */
  _promptAssaultTarget() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    const maxMP = this.actor.system.movement ?? 4;

    // Find enemy tokens within movement range (use hex distance as approximation)
    const team = this.actor.system.team ?? "a";
    const validTargets = [];
    for (const token of canvas.tokens.placeables) {
      if (token === myToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;
      const otherTeam = token.actor.system.team ?? "a";
      if (otherTeam === team) continue;
      if (token.actor.system.strength.value <= 0) continue;

      const distance = StarMercsActor.getHexDistance(myToken, token);
      if (distance <= maxMP) {
        validTargets.push({ tokenId: token.id, name: token.name, distance });
      }
    }

    // Engaged units can only assault adjacent enemies
    const hUtils = game.starmercs?.hexUtils;
    if (hUtils && hUtils.isEngaged(myToken)) {
      const adjacentOnly = validTargets.filter(t => {
        const tToken = canvas.tokens.get(t.tokenId);
        return tToken && hUtils.areAdjacent(myToken, tToken);
      });
      validTargets.length = 0;
      adjacentOnly.forEach(t => validTargets.push(t));
      if (validTargets.length === 0) {
        ui.notifications.warn("Engaged units can only assault adjacent enemies.");
        return;
      }
    }

    if (validTargets.length === 0) {
      ui.notifications.warn("No enemy units within movement range for assault.");
      return;
    }

    const targetOptions = validTargets.map(t =>
      `<option value="${t.tokenId}">${t.name} (${t.distance} hex${t.distance > 1 ? "es" : ""})</option>`
    ).join("");

    const dialogContent = `
      <form>
        <div class="form-group">
          <label>Select assault target (within ${maxMP} MP range)</label>
          <select id="assault-target">${targetOptions}</select>
        </div>
      </form>
    `;

    const actor = this.actor;
    new Dialog({
      title: "Select Assault Target",
      content: dialogContent,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-crosshairs"></i>',
          label: "Confirm Target",
          callback: async (html) => {
            const targetTokenId = html.find("#assault-target").val();
            const token = actor.getActiveTokens()?.[0];
            if (token?.document && targetTokenId) {
              await token.document.setFlag("star-mercs", "assaultTarget", targetTokenId);
              const targetToken = canvas.tokens.get(targetTokenId);
              ui.notifications.info(`Assault target set: ${targetToken?.name ?? "Unknown"}`);
            }
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel"
        }
      },
      default: "confirm"
    }).render(true);
  }

  /**
   * Open the ConstructionPicker dialog when the Construct order is selected.
   * @private
   */
  async _promptConstructionTarget() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    // Check for an in-progress structure built by this token
    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    const inProgress = structures.find(
      s => s.builderId === myToken.id && s.turnsBuilt < s.turnsRequired
    );
    if (inProgress) {
      // Auto-resume: set the flag and skip the picker
      const config = CONFIG.STARMERCS.structures[inProgress.type];
      await myToken.document.setFlag("star-mercs", "constructionTarget", {
        type: inProgress.type,
        targetHexKey: inProgress.hexKey,
        subType: inProgress.subType ?? null
      });
      ui.notifications.info(
        `Resuming construction: ${config?.label ?? inProgress.type} (${inProgress.turnsBuilt}/${inProgress.turnsRequired} turns)`
      );
      return;
    }

    const actor = this.actor;
    new ConstructionPicker(
      actor,
      myToken,
      async (selection) => {
        // selection = { type, targetHexKey, subType }
        await myToken.document.setFlag("star-mercs", "constructionTarget", selection);
        const config = CONFIG.STARMERCS.structures[selection.type];
        ui.notifications.info(`Construction target set: ${config?.label ?? selection.type}`);
      },
      async () => {
        // Cancelled — revert order
        await actor.update({ "system.currentOrder": "" });
        ui.notifications.info("Construction order cancelled.");
      }
    ).render(true);
  }

  /**
   * Prompt the user to select a demolish target from available structures.
   * @private
   */
  _promptDemolishTarget() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    const unitHex = snapToHexCenter(myToken.center);
    const unitHK = hexKey(unitHex);
    const validTargets = [];

    for (const s of structures) {
      if (s.hexKey === unitHK) {
        // Structure on same hex — always valid
        const config = CONFIG.STARMERCS.structures[s.type];
        validTargets.push({ id: s.id, label: `${config?.label ?? s.type} (current hex)` });
        continue;
      }

      // Check adjacent hexes with no units
      const adjacents = getAdjacentHexCenters(unitHex);
      for (const adj of adjacents) {
        if (hexKey(adj) === s.hexKey) {
          // Check no units on that hex
          const tokensAtHex = canvas.tokens.placeables.filter(t => {
            const tc = snapToHexCenter(t.center);
            return hexKey(tc) === s.hexKey;
          });
          if (tokensAtHex.length === 0) {
            const config = CONFIG.STARMERCS.structures[s.type];
            validTargets.push({ id: s.id, label: `${config?.label ?? s.type} (adjacent hex)` });
          }
          break;
        }
      }
    }

    if (validTargets.length === 0) {
      ui.notifications.warn("No valid structures to demolish nearby.");
      this.actor.update({ "system.currentOrder": "" });
      return;
    }

    const optionsHtml = validTargets.map(t =>
      `<option value="${t.id}">${t.label}</option>`
    ).join("");

    const actor = this.actor;
    new Dialog({
      title: "Select Demolish Target",
      content: `<form><div class="form-group">
        <label>Select structure to demolish</label>
        <select id="demolish-target">${optionsHtml}</select>
      </div></form>`,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-hammer"></i>',
          label: "Confirm",
          callback: async (html) => {
            const structureId = html.find("#demolish-target").val();
            const token = actor.getActiveTokens()?.[0];
            if (token?.document && structureId) {
              await token.document.setFlag("star-mercs", "demolishTarget", { structureId });
              ui.notifications.info("Demolish target set.");
            }
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: async () => {
            await actor.update({ "system.currentOrder": "" });
          }
        }
      },
      default: "confirm"
    }).render(true);
  }

  /**
   * Open the Transport Picker dialog for the Transport order.
   * @private
   */
  async _promptTransportAction() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    // Must be landed
    if (!this.actor.getFlag("star-mercs", "landed")) {
      ui.notifications.warn("Transport must be landed to load or unload cargo.");
      await this.actor.update({ "system.currentOrder": "" });
      return;
    }

    const actor = this.actor;
    new TransportPicker(
      actor,
      myToken,
      async (selection) => {
        // selection = { action: "load"|"unload", targetId: tokenId|hexKey }
        await myToken.document.setFlag("star-mercs", "transportAction", selection.action);
        await myToken.document.setFlag("star-mercs", "transportTargetId", selection.targetId);

        if (selection.action === "load") {
          const cargoToken = canvas.tokens.get(selection.targetId);
          ui.notifications.info(`Transport: will load ${cargoToken?.name ?? "unit"}.`);
        } else {
          ui.notifications.info("Transport: will unload cargo at selected hex.");
        }
      },
      async () => {
        await actor.update({ "system.currentOrder": "" });
        ui.notifications.info("Transport order cancelled.");
      }
    ).render(true);
  }

  /**
   * Prompt for Air Assault target hex (must have cargo, enemy at target).
   * @private
   */
  _promptAirAssaultTarget() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    if (!this.actor.hasCargoAboard()) {
      ui.notifications.warn("Must have cargo aboard to perform Air Assault.");
      this.actor.update({ "system.currentOrder": "" });
      return;
    }

    const flySpeed = this.actor.system.movement ?? 4;
    const team = this.actor.system.team ?? "a";
    const validTargets = [];

    for (const token of canvas.tokens.placeables) {
      if (token === myToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;
      if ((token.actor.system.team ?? "a") === team) continue;
      if (token.actor.system.strength.value <= 0) continue;
      if (token.actor.isAboardTransport()) continue;

      const distance = StarMercsActor.getHexDistance(myToken, token);
      if (distance <= flySpeed) {
        validTargets.push({ tokenId: token.id, name: token.name, distance });
      }
    }

    if (validTargets.length === 0) {
      ui.notifications.warn("No enemy units within flying range for Air Assault.");
      this.actor.update({ "system.currentOrder": "" });
      return;
    }

    const optionsHtml = validTargets.map(t =>
      `<option value="${t.tokenId}">${t.name} (${t.distance} hex${t.distance > 1 ? "es" : ""})</option>`
    ).join("");

    const actor = this.actor;
    new Dialog({
      title: "Air Assault — Select Target",
      content: `<form><div class="form-group">
        <label>Select enemy unit to assault</label>
        <select id="air-assault-target">${optionsHtml}</select>
      </div>
      <p class="notes">Cargo will be unloaded and assault the target hex.</p>
      </form>`,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-fighter-jet"></i>',
          label: "Confirm Air Assault",
          callback: async (html) => {
            const targetTokenId = html.find("#air-assault-target").val();
            const token = actor.getActiveTokens()?.[0];
            if (token?.document && targetTokenId) {
              const targetToken = canvas.tokens.get(targetTokenId);
              const targetHex = targetToken ? hexKey(snapToHexCenter(targetToken.center)) : null;
              await token.document.setFlag("star-mercs", "airAssaultTargetHex", targetHex);
              await token.document.setFlag("star-mercs", "airAssaultTargetTokenId", targetTokenId);
              ui.notifications.info(`Air Assault target set: ${targetToken?.name ?? "enemy"}.`);
            }
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: async () => {
            await actor.update({ "system.currentOrder": "" });
          }
        }
      },
      default: "confirm"
    }).render(true);
  }

  /**
   * Prompt for Hot Disembark target hex (must have cargo).
   * @private
   */
  _promptHotDisembarkTarget() {
    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    if (!this.actor.hasCargoAboard()) {
      ui.notifications.warn("Must have cargo aboard to perform Hot Disembark.");
      this.actor.update({ "system.currentOrder": "" });
      return;
    }

    const flySpeed = this.actor.system.movement ?? 4;
    const actor = this.actor;

    // For Hot Disembark, allow player to type/pick any hex within flying range.
    // Use a simple dialog asking for a move destination (similar to Fly order).
    // The actual hex selection will happen through the standard move destination flow.
    ui.notifications.info("Hot Disembark: Set a move destination within flying range. Cargo will be unloaded to an adjacent hex on arrival.");

    // Mark the order as hot_disembark — the move destination flow and
    // consolidation phase handle the rest.
    // No additional flag needed beyond the order itself; the movement
    // destination (moveTarget) is set via the standard move path UI.
  }

  /**
   * Enter waypoint-based move destination selection mode.
   * Left-click to add waypoints, right-click to remove last waypoint.
   * A "Confirm Path" dialog finalizes the route.
   * Path is visualized live on the movement path layer.
   */
  _onSetMoveDestination(event) {
    event.preventDefault();

    const token = this.actor.getActiveTokens()?.[0];
    if (!token) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    const actor = this.actor;
    let maxMP = actor.system.movement ?? 0;
    const orderKey = actor.system.currentOrder;
    const orderConfig = CONFIG.STARMERCS.orders?.[orderKey];
    if (orderConfig?.speedMultiplier) maxMP *= orderConfig.speedMultiplier;

    const mpUsed = token.document?.getFlag("star-mercs", "movementUsed") ?? 0;
    const mpRemaining = maxMP - mpUsed;

    const waypoints = [];
    const pathLayer = game.starmercs?.movementPathLayer;

    const updatePreview = (hoverHex = null) => {
      pathLayer?.drawPath(token, waypoints, hoverHex);
    };

    ui.notifications.info("Left-click to add waypoints. Right-click to remove last. Press Escape to cancel.");

    // Helper: extract canvas position from PIXI event (compatible with v5–v8 / Foundry v12–v13)
    const _getEventPos = (event) => {
      if (typeof event.getLocalPosition === 'function') return event.getLocalPosition(canvas.stage);
      if (event.data?.getLocalPosition) return event.data.getLocalPosition(canvas.stage);
      if (event.global) return canvas.stage.toLocal(event.global);
      return null;
    };

    // Hover handler: show live preview of path to hovered hex
    const moveHandler = (event) => {
      const pos = _getEventPos(event);
      if (!pos) return;
      const snapped = snapToHexCenter(pos);
      updatePreview(snapped);
    };

    // Left-click handler: add waypoint
    const clickHandler = (event) => {
      const button = event.button ?? event.data?.button ?? 0;
      if (button !== 0) return;
      const pos = _getEventPos(event);
      if (!pos) return;
      const snapped = snapToHexCenter(pos);

      // Calculate total path cost with this new waypoint
      const testWaypoints = [...waypoints, snapped];
      let startCenter = snapToHexCenter(token.center);
      const fullPath = [];
      for (const wp of testWaypoints) {
        const segment = computeHexPath(startCenter, wp);
        fullPath.push(...segment);
        if (segment.length > 0) startCenter = segment[segment.length - 1];
      }

      const { totalCost, passable } = calculatePathCost(snapToHexCenter(token.center), fullPath, actor);

      if (!passable) {
        ui.notifications.warn("Path is blocked. Try a different waypoint.");
        return;
      }

      if (totalCost > mpRemaining) {
        ui.notifications.warn(`Path costs ${totalCost} MP but only ${mpRemaining} MP remaining.`);
        return;
      }

      waypoints.push(snapped);
      updatePreview();
    };

    // Right-click handler: remove last waypoint
    const rightClickHandler = (event) => {
      event.preventDefault?.();
      if (waypoints.length > 0) {
        waypoints.pop();
        updatePreview();
        ui.notifications.info(`Waypoint removed. ${waypoints.length} waypoint(s) remaining.`);
      }
    };

    // ESC handler: cancel
    const keyHandler = (event) => {
      if (event.key === "Escape") {
        cleanup();
        ui.notifications.info("Movement destination cancelled.");
      } else if (event.key === "Enter") {
        confirmPath();
      }
    };

    const confirmPath = async () => {
      if (waypoints.length === 0) {
        ui.notifications.warn("No waypoints set. Add at least one waypoint.");
        return;
      }

      // Calculate full path through all waypoints for final validation
      let startCenter = snapToHexCenter(token.center);
      const fullPath = [];
      for (const wp of waypoints) {
        const segment = computeHexPath(startCenter, wp);
        fullPath.push(...segment);
        if (segment.length > 0) startCenter = segment[segment.length - 1];
      }

      const { totalCost, passable, reason } = calculatePathCost(snapToHexCenter(token.center), fullPath, actor);
      if (!passable) {
        ui.notifications.warn(reason ?? "Path is blocked.");
        return;
      }
      if (totalCost > mpRemaining) {
        ui.notifications.warn(`Path costs ${totalCost} MP but only ${mpRemaining} MP remaining.`);
        return;
      }

      // Store the final destination (last waypoint) and the full waypoint chain
      const finalDest = waypoints[waypoints.length - 1];
      await token.document.setFlag("star-mercs", "moveDestination", { x: finalDest.x, y: finalDest.y });
      if (waypoints.length > 1) {
        await token.document.setFlag("star-mercs", "moveWaypoints", waypoints.map(wp => ({ x: wp.x, y: wp.y })));
      } else {
        await token.document.unsetFlag("star-mercs", "moveWaypoints");
      }

      game.starmercs?.targetingArrowLayer?.drawArrows();
      cleanup();

      // Fly order: prompt for target altitude after path is confirmed
      if (orderKey === "fly") {
        const currentAlt = actor.getFlag("star-mercs", "altitude") ?? 0;
        const destHexElev = getHexElevation(snapToHexCenter(finalDest));
        const fuelAvailable = actor.system.supply?.fuel?.current ?? 0;
        const fuelPerMP = actor.system.fuelPerMP ?? 0;
        const moveFuel = totalCost * fuelPerMP;
        const maxAlt = 5;

        // Build altitude option list
        const altOptions = [];
        for (let alt = destHexElev; alt <= maxAlt; alt++) {
          const altFuel = Math.abs(alt - currentAlt);
          const totalFuel = moveFuel + altFuel;
          const valid = totalFuel <= fuelAvailable;
          const label = alt === currentAlt ? `${alt} (no change)` : `${alt} (+${altFuel} fuel for altitude)`;
          altOptions.push(`<option value="${alt}" ${alt === currentAlt ? "selected" : ""} ${!valid ? "disabled" : ""}>${label}${!valid ? " — insufficient fuel" : ""}</option>`);
        }

        const altContent = `
          <form class="fly-altitude-form">
            <p>Path: ${totalCost} MP (${moveFuel} fuel) | Current Altitude: <strong>${currentAlt}</strong> | Fuel: <strong>${fuelAvailable}</strong></p>
            <div class="form-group">
              <label>Altitude at Destination</label>
              <select id="fly-altitude-target">${altOptions.join("")}</select>
            </div>
          </form>
        `;

        new Dialog({
          title: "Fly — Select Destination Altitude",
          content: altContent,
          buttons: {
            confirm: {
              icon: '<i class="fas fa-check"></i>',
              label: "Confirm",
              callback: async (html) => {
                const targetAlt = parseInt(html.find("#fly-altitude-target").val());
                if (isNaN(targetAlt)) return;
                const altFuel = Math.abs(targetAlt - currentAlt);
                const totalFuel = moveFuel + altFuel;
                if (totalFuel > fuelAvailable) {
                  ui.notifications.warn("Not enough fuel for movement + altitude change.");
                  return;
                }
                await token.document.setFlag("star-mercs", "flyAltitudeTarget", targetAlt);
                ui.notifications.info(`Fly path confirmed (${totalCost} MP). Altitude: ${currentAlt} → ${targetAlt}.`);
              }
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: "Keep Current Altitude",
              callback: async () => {
                // Keep the move destination but no altitude change
                ui.notifications.info(`Fly path confirmed (${totalCost} MP). Altitude unchanged.`);
              }
            }
          },
          default: "confirm"
        }).render(true);
      } else {
        ui.notifications.info(`Movement path confirmed (${totalCost} MP).`);
      }
    };

    const cleanup = () => {
      canvas.stage.off("pointermove", moveHandler);
      canvas.stage.off("pointerdown", clickHandler);
      canvas.stage.off("rightdown", rightClickHandler);
      document.removeEventListener("keydown", keyHandler);
      pathLayer?.clear();
      if (confirmDialog) {
        confirmDialog.close();
        confirmDialog = null;
      }
    };

    // Show a floating "Confirm Path" dialog
    let confirmDialog = new Dialog({
      title: "Movement Path",
      content: "<p>Add waypoints by left-clicking hexes.<br/>Right-click to undo. Enter to confirm.</p>",
      buttons: {
        confirm: {
          icon: '<i class="fas fa-check"></i>',
          label: "Confirm Path",
          callback: () => confirmPath()
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => {
            cleanup();
            ui.notifications.info("Movement destination cancelled.");
          }
        }
      },
      default: "confirm",
      close: () => {
        // If closed via X button, clean up
        canvas.stage.off("pointermove", moveHandler);
        canvas.stage.off("pointerdown", clickHandler);
        canvas.stage.off("rightdown", rightClickHandler);
        document.removeEventListener("keydown", keyHandler);
        pathLayer?.clear();
        confirmDialog = null;
      }
    }, { top: 60, left: 10, width: 260 });

    confirmDialog.render(true);

    canvas.stage.on("pointermove", moveHandler);
    canvas.stage.on("pointerdown", clickHandler);
    canvas.stage.on("rightdown", rightClickHandler);
    document.addEventListener("keydown", keyHandler);
  }

  /* ---------------------------------------- */
  /*  Trait Handlers                          */
  /* ---------------------------------------- */

  /**
   * Toggle a trait's active state via its checkbox.
   */
  async _onTraitToggle(event) {
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    await item.update({ "system.active": event.currentTarget.checked });
  }

  /* ---------------------------------------- */
  /*  Supply Transfer                         */
  /* ---------------------------------------- */

  /**
   * Open a dialog to transfer supply to a nearby friendly unit.
   */
  async _onTransferSupply(event) {
    event.preventDefault();

    // Only allow supply transfer during preparation phase
    const combat = game.combat;
    if (combat?.started && combat.phase !== "preparation") {
      ui.notifications.warn("Supply transfers are only allowed during the Preparation phase.");
      return;
    }

    // Airborne flying units without Supply trait cannot transfer supplies
    if (this.actor.hasTrait("Flying") && !this.actor.getFlag("star-mercs", "landed") && !this.actor.hasTrait("Supply")) {
      ui.notifications.warn("Airborne units must land to transfer supplies (unless they have the Supply trait).");
      return;
    }

    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    const transferRange = this.actor.getSupplyTransferRange();

    // Check if we have any supply to transfer
    const mySup = this.actor.system.supply;
    const cats = StarMercsActor.SUPPLY_CATEGORIES;
    const hasAnySupply = cats.some(c => (mySup[c]?.current ?? 0) > 0);
    if (!hasAnySupply) {
      ui.notifications.warn("No supply available to transfer.");
      return;
    }

    // Find nearby friendly units within range (same team) that have space for at least one category
    const myTeam = this.actor.system.team ?? "a";
    const nearbyTargets = [];
    for (const token of canvas.tokens.placeables) {
      if (token === myToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;

      // Only allow transfer to same-team units
      const otherTeam = token.actor.system.team ?? "a";
      if (otherTeam !== myTeam) continue;

      const distance = StarMercsActor.getHexDistance(myToken, token);
      if (distance <= transferRange) {
        const targetSup = token.actor.system.supply;
        const hasSpace = cats.some(c => (targetSup[c]?.current ?? 0) < (targetSup[c]?.capacity ?? 0));
        if (hasSpace) {
          nearbyTargets.push({
            tokenId: token.id,
            name: token.name,
            distance,
            actor: token.actor
          });
        }
      }
    }

    if (nearbyTargets.length === 0) {
      ui.notifications.warn("No friendly units within transfer range with available capacity.");
      return;
    }

    // Build dialog content with per-category inputs
    const targetOptions = nearbyTargets.map(t =>
      `<option value="${t.tokenId}">${t.name} (${t.distance} hex${t.distance > 1 ? "es" : ""})</option>`
    ).join("");

    const labels = StarMercsActor.SUPPLY_LABELS;
    const categoryInputs = cats.map(cat => {
      const available = mySup[cat]?.current ?? 0;
      if (available <= 0) return "";
      return `<div class="form-group transfer-category">
        <label>${labels[cat]} (have: ${available})</label>
        <input type="number" data-category="${cat}" value="0" min="0" max="${available}" />
      </div>`;
    }).filter(s => s).join("");

    const dialogContent = `
      <form class="supply-transfer-form">
        <div class="form-group">
          <label>Transfer To</label>
          <select id="transfer-target">${targetOptions}</select>
        </div>
        <hr/>
        <h4>Amounts to Transfer</h4>
        ${categoryInputs}
      </form>
    `;

    const actor = this.actor;
    new Dialog({
      title: "Transfer Supply",
      content: dialogContent,
      buttons: {
        transfer: {
          icon: '<i class="fas fa-truck"></i>',
          label: "Transfer",
          callback: async (html) => {
            const targetTokenId = html.find("#transfer-target").val();
            const targetToken = canvas.tokens.get(targetTokenId);
            if (!targetToken?.actor) return;

            const transfers = {};
            html.find("input[data-category]").each(function() {
              const cat = this.dataset.category;
              const val = parseInt(this.value) || 0;
              if (val > 0) transfers[cat] = val;
            });

            if (Object.keys(transfers).length === 0) return;
            await actor.transferSupply(targetToken.actor, transfers);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel"
        }
      },
      default: "transfer"
    }).render(true);
  }

  /* ---------------------------------------- */
  /*  Chat Handlers                           */
  /* ---------------------------------------- */

  async _onItemChat(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if (item) return item.toChat();
  }

  /* ---------------------------------------- */
  /*  Log Handlers                            */
  /* ---------------------------------------- */

  async _onClearLog(event) {
    event.preventDefault();
    await this.actor.update({ "system.log": [] });
  }

  /* ---------------------------------------- */
  /*  GM Override Handlers                    */
  /* ---------------------------------------- */

  async _onGMToggleBreaking(event) {
    if (!game.user.isGM) return;
    const checked = event.currentTarget.checked;
    const token = this.actor.getActiveTokens()?.[0]?.document;
    if (token) await token.setFlag("star-mercs", "breaking", checked);
  }

  async _onGMOrderOverride(event) {
    if (!game.user.isGM) return;
    const selectedOrderKey = event.currentTarget.value;
    if (!selectedOrderKey) return;
    await this.actor.update({ "system.currentOrder": selectedOrderKey });
    const orderConfig = CONFIG.STARMERCS.orders?.[selectedOrderKey];
    if (orderConfig) {
      await this.actor.addLogEntry(`GM Override: Order set to ${orderConfig.label}`, "order");
    }
  }
}
