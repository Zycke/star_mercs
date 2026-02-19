import StarMercsActor from "../documents/actor.mjs";

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

    // Available orders from config (filtered by trait requirements and supply)
    const allOrders = CONFIG.STARMERCS.orders ?? {};
    const hasNoSupply = (this.actor.system.supply?.current ?? 1) <= 0;
    const zeroSupplyOrders = ["hold", "move", "withdraw"];

    context.availableOrders = Object.entries(allOrders)
      .filter(([key, data]) => {
        // Special orders require a trait
        if (data.category === "special" && data.requiredTrait) {
          if (!this.actor.hasTrait(data.requiredTrait)) return false;
        }
        // Zero supply: only Hold, Move, Withdraw
        if (hasNoSupply && !zeroSupplyOrders.includes(key)) return false;
        return true;
      })
      .map(([key, data]) => ({
        key,
        label: game.i18n.localize(data.label),
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
        labelText: game.i18n.localize(rawOrderData.label)
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
        speed: this.actor.system.speed ?? 0
      };
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
    context.canTransferSupply = !combat?.started || combat?.phase === "preparation";
    context.supplyTransferRange = this.actor.getSupplyTransferRange();

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
        const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air" };
        const wTraits = [];
        if (item.system.indirect) wTraits.push("Indirect");
        if (item.system.area) wTraits.push("Area");
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
          targetId: null
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

    // Line of Sight check (unless weapon has Indirect trait)
    if (!item.system.indirect) {
      const myToken = this.actor.getActiveTokens()?.[0];
      if (myToken && !StarMercsActor.hasLineOfSight(myToken, targetToken)) {
        ui.notifications.warn(`${item.name} requires Line of Sight — target is not visible. (Indirect weapons bypass this.)`);
        return;
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
    return this.actor.rollAllAttacks();
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

    // Clear any previous assault target
    const token = this.actor.getActiveTokens()?.[0];
    if (token?.document) {
      await token.document.unsetFlag("star-mercs", "assaultTarget");
    }

    // If assault order selected, prompt for target selection
    if (selectedOrderKey === "assault") {
      this._promptAssaultTarget();
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

    const speed = this.actor.system.speed ?? 4;

    // Find enemy tokens within movement range
    const team = this.actor.system.team ?? "a";
    const validTargets = [];
    for (const token of canvas.tokens.placeables) {
      if (token === myToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;
      const otherTeam = token.actor.system.team ?? "a";
      if (otherTeam === team) continue;
      if (token.actor.system.strength.value <= 0) continue;

      const distance = StarMercsActor.getHexDistance(myToken, token);
      if (distance <= speed) {
        validTargets.push({ tokenId: token.id, name: token.name, distance });
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
          <label>Select assault target (within ${speed} hex range)</label>
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
   * Enter move destination selection mode.
   * The next canvas click sets the unit's planned movement hex.
   */
  _onSetMoveDestination(event) {
    event.preventDefault();

    // Find this actor's token on canvas
    const token = this.actor.getActiveTokens()?.[0];
    if (!token) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    ui.notifications.info("Click a hex on the map to set the movement destination.");

    const handler = (event) => {
      const pos = event.data.getLocalPosition(canvas.app.stage);
      // Snap to hex grid center
      const snapped = canvas.grid.getSnappedPoint(pos, { mode: CONST.GRID_SNAPPING_MODES.CENTER });
      const dest = snapped ?? pos;

      // Store destination on the token document
      token.document.setFlag("star-mercs", "moveDestination", { x: dest.x, y: dest.y });

      // Redraw arrows to show the green movement arrow
      game.starmercs?.targetingArrowLayer?.drawArrows();

      // Clean up listener
      canvas.stage.off("pointerdown", handler);
      ui.notifications.info("Movement destination set.");
    };

    canvas.stage.on("pointerdown", handler);
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
      ui.notifications.warn(game.i18n.localize("STARMERCS.TransferPrepOnly"));
      return;
    }

    const myToken = this.actor.getActiveTokens()?.[0];
    if (!myToken) {
      ui.notifications.warn("Place this unit's token on the canvas first.");
      return;
    }

    const transferRange = this.actor.getSupplyTransferRange();
    const currentSupply = this.actor.system.supply.current;
    if (currentSupply <= 0) {
      ui.notifications.warn("No supply available to transfer.");
      return;
    }

    // Find nearby friendly units within range
    const nearbyTargets = [];
    for (const token of canvas.tokens.placeables) {
      if (token === myToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;

      const distance = StarMercsActor.getHexDistance(myToken, token);
      if (distance <= transferRange) {
        const targetSupply = token.actor.system.supply;
        if (targetSupply.current < targetSupply.capacity) {
          nearbyTargets.push({
            tokenId: token.id,
            name: token.name,
            distance,
            actor: token.actor,
            spaceAvailable: targetSupply.capacity - targetSupply.current
          });
        }
      }
    }

    if (nearbyTargets.length === 0) {
      ui.notifications.warn(game.i18n.localize("STARMERCS.TransferNoTargets"));
      return;
    }

    // Build dialog content
    const targetOptions = nearbyTargets.map(t =>
      `<option value="${t.tokenId}">${t.name} (${t.distance} hex${t.distance > 1 ? "es" : ""}, space: ${t.spaceAvailable})</option>`
    ).join("");

    const dialogContent = `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize("STARMERCS.TransferSupplyTo")}</label>
          <select id="transfer-target">${targetOptions}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("STARMERCS.TransferAmount")} (max: ${currentSupply})</label>
          <input type="number" id="transfer-amount" value="1" min="1" max="${currentSupply}" />
        </div>
      </form>
    `;

    const actor = this.actor;
    new Dialog({
      title: game.i18n.localize("STARMERCS.TransferSupply"),
      content: dialogContent,
      buttons: {
        transfer: {
          icon: '<i class="fas fa-truck"></i>',
          label: game.i18n.localize("STARMERCS.TransferSupply"),
          callback: async (html) => {
            const targetTokenId = html.find("#transfer-target").val();
            const amount = parseInt(html.find("#transfer-amount").val()) || 0;
            if (amount <= 0) return;

            const targetToken = canvas.tokens.get(targetTokenId);
            if (!targetToken?.actor) return;

            await actor.transferSupply(targetToken.actor, amount);
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
}
