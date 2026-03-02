import { snapToHexCenter, hexKey, getHexData, getAdjacentHexCenters,
  getStructureAtHex, normalizeHexData } from "../hex-utils.mjs";
import StructureLayer from "../canvas/structure-layer.mjs";

/**
 * Construction Picker — dialog for selecting what structure to build
 * when taking the Construct order.
 *
 * Shows available structure types filtered by:
 *  - Terrain (bridge needs water, outpost/entrenchment blocked on noFortification)
 *  - Materials (unit needs materials >= cost for at least one turn)
 *  - Existing structures (one per hex)
 *
 * For bridges: also lets the player select which adjacent water hex to target.
 * For minefields: lets the player select Anti-Personnel or Anti-Armor sub-type.
 *
 * Uses Foundry v13 ApplicationV2 framework.
 */
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export default class ConstructionPicker extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "star-mercs-construction-picker",
    window: {
      title: "Select Construction",
      resizable: false
    },
    classes: ["star-mercs", "construction-picker"],
    position: {
      width: 340,
      height: "auto"
    }
  };

  static PARTS = {
    form: {
      template: "systems/star-mercs/templates/apps/construction-picker.hbs"
    }
  };

  /**
   * @param {Actor} actor - The Engineer unit actor.
   * @param {Token} token - The unit's canvas token.
   * @param {Function} onSelect - Callback(selection) when player picks.
   * @param {Function} onCancel - Callback when dialog is cancelled.
   * @param {object} [options] - ApplicationV2 options.
   */
  constructor(actor, token, onSelect, onCancel, options = {}) {
    super(options);
    this._actor = actor;
    this._token = token;
    this._onSelect = onSelect;
    this._onCancel = onCancel;
    this._selectedType = null;
    this._selectedSubType = null;
    this._selectedTargetHex = null;
  }

  /** @override */
  async _prepareContext(options) {
    const unitHex = snapToHexCenter(this._token.center);
    const unitHexKey = hexKey(unitHex);
    const hexData = getHexData(unitHex);
    const terrainConfig = hexData ? CONFIG.STARMERCS.terrain[hexData.type] ?? null : null;
    const materials = this._actor.system.supply?.materials?.current ?? 0;

    // Find adjacent water hexes for bridges
    const adjacentWaterHexes = [];
    const adjacents = getAdjacentHexCenters(unitHex);
    for (const adj of adjacents) {
      const adjData = getHexData(adj);
      if (!adjData) continue;
      const adjConfig = CONFIG.STARMERCS.terrain[adjData.type];
      if (!adjConfig?.waterTerrain) continue;
      // Check no existing structure on this water hex
      const existing = getStructureAtHex(adj);
      if (existing) continue;
      adjacentWaterHexes.push({ x: adj.x, y: adj.y, hexKey: hexKey(adj), label: adjData.type });
    }

    // Check if current hex already has a structure
    const currentHexStructure = getStructureAtHex(unitHex);

    // Build available structure choices
    const choices = [];
    for (const [typeKey, config] of Object.entries(CONFIG.STARMERCS.structures)) {
      const merged = StructureLayer.getStructureConfig(typeKey);
      const choice = {
        key: typeKey,
        label: merged.label,
        icon: merged.icon,
        description: merged.description,
        materialsPerTurn: merged.materialsPerTurn,
        turnsRequired: merged.turnsRequired,
        available: true,
        reason: null
      };

      // Check materials
      if (materials < merged.materialsPerTurn) {
        choice.available = false;
        choice.reason = `Needs ${merged.materialsPerTurn} materials (have ${materials})`;
      }

      // Terrain checks
      if (merged.requiresWater) {
        // Bridge: needs adjacent water hex
        if (adjacentWaterHexes.length === 0) {
          choice.available = false;
          choice.reason = "No adjacent water hex available";
        }
      } else {
        // Non-bridge: built on current hex
        if (currentHexStructure) {
          choice.available = false;
          choice.reason = "Hex already has a structure";
        }
        if (terrainConfig?.waterTerrain) {
          choice.available = false;
          choice.reason = "Cannot build on water terrain";
        }
        if (terrainConfig?.noFortification && (typeKey === "outpost" || typeKey === "fortification")) {
          choice.available = false;
          choice.reason = "Cannot fortify on this terrain";
        }
      }

      choices.push(choice);
    }

    // Minefield sub-types
    const mineSubTypes = CONFIG.STARMERCS.structures.minefield?.subTypes ?? {};

    return {
      choices,
      adjacentWaterHexes,
      mineSubTypes,
      hasAdjacentWater: adjacentWaterHexes.length > 0,
      materials
    };
  }

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Structure type selection
    html.querySelectorAll(".structure-choice").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const typeKey = btn.dataset.type;
        if (btn.classList.contains("disabled")) return;

        // Deselect others
        html.querySelectorAll(".structure-choice").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        this._selectedType = typeKey;

        // Show/hide sub-options
        html.querySelectorAll(".sub-options").forEach(el => el.style.display = "none");
        const subPanel = html.querySelector(`.sub-options[data-type="${typeKey}"]`);
        if (subPanel) subPanel.style.display = "block";
      });
    });

    // Minefield sub-type selection
    html.querySelectorAll('[name="mineSubType"]').forEach(radio => {
      radio.addEventListener("change", (e) => {
        this._selectedSubType = e.target.value;
      });
    });

    // Bridge target hex selection
    html.querySelector('[name="bridgeTarget"]')?.addEventListener("change", (e) => {
      this._selectedTargetHex = e.target.value;
    });

    // Confirm button
    html.querySelector(".confirm-construction")?.addEventListener("click", () => {
      if (!this._selectedType) {
        ui.notifications.warn("Select a structure type first.");
        return;
      }

      const config = CONFIG.STARMERCS.structures[this._selectedType];

      // Validate sub-type for minefields
      if (this._selectedType === "minefield" && !this._selectedSubType) {
        ui.notifications.warn("Select a minefield type (Anti-Personnel or Anti-Armor).");
        return;
      }

      // Validate target hex for bridges
      if (config?.requiresWater && !this._selectedTargetHex) {
        ui.notifications.warn("Select a target water hex for the bridge.");
        return;
      }

      const unitHex = snapToHexCenter(this._token.center);
      const selection = {
        type: this._selectedType,
        targetHexKey: config?.adjacentBuild ? this._selectedTargetHex : hexKey(unitHex),
        subType: this._selectedType === "minefield" ? this._selectedSubType : null
      };

      this._onSelect(selection);
      this.close();
    });

    // Cancel button
    html.querySelector(".cancel-construction")?.addEventListener("click", () => {
      this._onCancel();
      this.close();
    });
  }

  /** @override */
  async close(options) {
    return super.close(options);
  }
}
