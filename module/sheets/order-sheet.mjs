/**
 * Sheet class for Order items.
 */
export default class StarMercsOrderSheet extends ItemSheet {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["star-mercs", "sheet", "item", "order"],
      template: "systems/star-mercs/templates/items/order-sheet.hbs",
      width: 520,
      height: 520
    });
  }

  /** @override */
  async getData(options) {
    const context = await super.getData(options);
    context.system = this.item.system;
    context.categoryChoices = {
      standard: "Standard",
      special: "Special"
    };
    context.enrichedDescription = await TextEditor.enrichHTML(
      this.item.system.description, { async: true }
    );
    return context;
  }
}
