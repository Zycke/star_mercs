/**
 * Sheet class for Trait items.
 */
export default class StarMercsTraitSheet extends ItemSheet {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["star-mercs", "sheet", "item", "trait"],
      template: "systems/star-mercs/templates/items/trait-sheet.hbs",
      width: 480,
      height: 440
    });
  }

  /** @override */
  async getData(options) {
    const context = await super.getData(options);
    context.system = this.item.system;
    context.modeChoices = {
      passive: "Passive",
      active: "Active",
      conditional: "Conditional"
    };
    context.enrichedDescription = await TextEditor.enrichHTML(
      this.item.system.description, { async: true }
    );
    return context;
  }
}
