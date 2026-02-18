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

    // Organize embedded items by type
    this._prepareItems(context);

    // Phase-aware context
    const combat = game.combat;
    context.combatActive = combat?.started ?? false;
    context.currentPhase = combat?.phase ?? null;
    context.phaseLabel = combat?.phaseLabel ?? null;
    context.isOrdersPhase = combat?.phase === "orders";
    context.isTacticalPhase = combat?.phase === "tactical";

    // Available orders for dropdown (from embedded order items)
    context.availableOrders = this.actor.items
      .filter(i => i.type === "order")
      .map(order => ({
        id: order.id,
        name: order.name,
        category: order.system.category,
        allowsMovement: order.system.allowsMovement,
        allowsAttack: order.system.allowsAttack
      }));

    // Currently selected order
    context.currentOrderName = this.actor.system.currentOrder || "";
    context.currentOrderItem = this.actor.items.find(
      i => i.type === "order" && i.name === context.currentOrderName
    ) || null;

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
        const weaponData = {
          _id: item.id,
          img: item.img,
          name: item.name,
          system: item.system,
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
        traits.push(item);
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
   */
  async _onOrderSelect(event) {
    event.preventDefault();
    const selectedOrderName = event.currentTarget.value;
    await this.actor.update({ "system.currentOrder": selectedOrderName });
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
