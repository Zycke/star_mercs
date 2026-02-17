/**
 * Sheet class for Weapon items.
 */
export default class StarMercsWeaponSheet extends ItemSheet {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["star-mercs", "sheet", "item", "weapon"],
      template: "systems/star-mercs/templates/items/weapon-sheet.hbs",
      width: 480,
      height: 400
    });
  }

  /** @override */
  async getData(options) {
    const context = await super.getData(options);
    context.system = this.item.system;
    context.attackTypeChoices = {
      soft: "Soft Attack",
      hard: "Hard Attack",
      antiAir: "Anti-Air"
    };
    return context;
  }
}
