/**
 * Sheet class for Star Mercs Unit actors.
 * Displays unit attributes, embedded weapons/traits/orders, and combat status.
 */
export default class StarMercsUnitSheet extends ActorSheet {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["star-mercs", "sheet", "actor", "unit"],
      template: "systems/star-mercs/templates/actors/unit-sheet.hbs",
      width: 680,
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

    return context;
  }

  /**
   * Categorize embedded items into typed arrays for the template.
   * @param {object} context - The template rendering context.
   */
  _prepareItems(context) {
    const weapons = [];
    const traits = [];
    const orders = [];

    for (const item of this.actor.items) {
      if (item.type === "weapon") weapons.push(item);
      else if (item.type === "trait") traits.push(item);
      else if (item.type === "order") orders.push(item);
    }

    context.weapons = weapons;
    context.traits = traits;
    context.orders = orders;
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

    // Weapon attack roll
    html.on("click", ".weapon-roll", this._onWeaponRoll.bind(this));

    // Post item to chat
    html.on("click", ".item-chat", this._onItemChat.bind(this));
  }

  /**
   * Create a new embedded item.
   * @param {Event} event
   */
  async _onItemCreate(event) {
    event.preventDefault();
    const type = event.currentTarget.dataset.type;
    const itemData = {
      name: `New ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      type: type
    };
    return this.actor.createEmbeddedDocuments("Item", [itemData]);
  }

  /**
   * Open an embedded item's sheet for editing.
   * @param {Event} event
   */
  _onItemEdit(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    item?.sheet.render(true);
  }

  /**
   * Delete an embedded item.
   * @param {Event} event
   */
  async _onItemDelete(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const itemId = li.dataset.itemId;
    return this.actor.deleteEmbeddedDocuments("Item", [itemId]);
  }

  /**
   * Roll a weapon attack using the actor's rollAttack method.
   * @param {Event} event
   */
  async _onWeaponRoll(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if (item) return this.actor.rollAttack(item);
  }

  /**
   * Post an item's details to chat.
   * @param {Event} event
   */
  async _onItemChat(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if (item) return item.toChat();
  }
}
