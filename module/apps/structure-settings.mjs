/**
 * GM Structure Settings Editor — allows the GM to override default values
 * for constructable structure types.
 *
 * Overrides are stored in world setting "star-mercs.structureOverrides".
 * Uses Foundry v13 ApplicationV2 framework.
 */
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export default class StructureSettings extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "star-mercs-structure-settings",
    window: {
      title: "Structure Settings",
      resizable: true
    },
    classes: ["star-mercs", "structure-settings"],
    position: {
      width: 420,
      height: "auto"
    }
  };

  static PARTS = {
    form: {
      template: "systems/star-mercs/templates/apps/structure-settings.hbs"
    }
  };

  /** @override */
  async _prepareContext(options) {
    const baseConfig = CONFIG.STARMERCS.structures;
    const overrides = game.settings.get("star-mercs", "structureOverrides") ?? {};

    const types = [];
    for (const [key, base] of Object.entries(baseConfig)) {
      const ov = overrides[key] ?? {};
      const merged = foundry.utils.mergeObject(foundry.utils.deepClone(base), ov);

      const entry = {
        key,
        label: base.label,
        icon: base.icon,
        maxStrength: merged.maxStrength,
        turnsRequired: merged.turnsRequired,
        materialsPerTurn: merged.materialsPerTurn,
        isOutpost: key === "outpost",
        isMinefield: key === "minefield"
      };

      if (key === "outpost") {
        entry.commsRange = merged.defaultCommsRange ?? 5;
        entry.supplyRange = merged.defaultSupplyRange ?? 3;
        const caps = merged.defaultSupplyCapacity ?? {};
        entry.supplySmallArms = caps.smallArms ?? 10;
        entry.supplyHeavyWeapons = caps.heavyWeapons ?? 10;
        entry.supplyOrdnance = caps.ordnance ?? 5;
        entry.supplyFuel = caps.fuel ?? 10;
        entry.supplyMaterials = caps.materials ?? 10;
        entry.supplyParts = caps.parts ?? 5;
        entry.supplyBasicSupplies = caps.basicSupplies ?? 10;
      }

      if (key === "minefield") {
        entry.maxStrength = merged.maxStrength ?? 10;
      }

      types.push(entry);
    }

    return { types };
  }

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Save button
    html.querySelector(".save-settings")?.addEventListener("click", async () => {
      await this._saveSettings();
      ui.notifications.info("Structure settings saved.");
      this.close();
    });

    // Reset to defaults button
    html.querySelector(".reset-defaults")?.addEventListener("click", async () => {
      await game.settings.set("star-mercs", "structureOverrides", {});
      ui.notifications.info("Structure settings reset to defaults.");
      this.render();
    });
  }

  /**
   * Read form inputs and save as overrides.
   * @private
   */
  async _saveSettings() {
    const html = this.element;
    const overrides = {};

    for (const key of Object.keys(CONFIG.STARMERCS.structures)) {
      const prefix = `${key}.`;
      const ov = {};

      const maxStr = html.querySelector(`[name="${prefix}maxStrength"]`);
      if (maxStr) ov.maxStrength = parseInt(maxStr.value) || 1;

      const turns = html.querySelector(`[name="${prefix}turnsRequired"]`);
      if (turns) ov.turnsRequired = parseInt(turns.value) || 1;

      const mats = html.querySelector(`[name="${prefix}materialsPerTurn"]`);
      if (mats) ov.materialsPerTurn = parseInt(mats.value) || 1;

      if (key === "outpost") {
        const comms = html.querySelector(`[name="${prefix}commsRange"]`);
        if (comms) ov.defaultCommsRange = parseInt(comms.value) || 1;

        const supRange = html.querySelector(`[name="${prefix}supplyRange"]`);
        if (supRange) ov.defaultSupplyRange = parseInt(supRange.value) || 1;

        ov.defaultSupplyCapacity = {};
        for (const cat of ["smallArms", "heavyWeapons", "ordnance", "fuel", "materials", "parts", "basicSupplies"]) {
          const input = html.querySelector(`[name="${prefix}supply.${cat}"]`);
          if (input) ov.defaultSupplyCapacity[cat] = parseInt(input.value) || 0;
        }
      }

      // Only store overrides that differ from defaults
      const base = CONFIG.STARMERCS.structures[key];
      const hasChanges = Object.keys(ov).some(k => {
        if (k === "defaultSupplyCapacity") return true; // Always store if outpost
        return ov[k] !== base[k];
      });
      if (hasChanges) overrides[key] = ov;
    }

    await game.settings.set("star-mercs", "structureOverrides", overrides);
  }
}
