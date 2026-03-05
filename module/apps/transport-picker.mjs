import { snapToHexCenter, hexKey, getAdjacentHexCenters, areAdjacent, isEngaged } from "../hex-utils.mjs";

/**
 * Transport Picker — dialog for selecting Load or Unload action
 * when taking the Transport order.
 *
 * Load: shows adjacent friendly Infantry units to pick up.
 * Unload: shows adjacent empty hexes to drop cargo into.
 *
 * Uses Foundry v13 ApplicationV2 framework.
 */
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export default class TransportPicker extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "star-mercs-transport-picker",
    window: {
      title: "Transport — Choose Action",
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
      template: "systems/star-mercs/templates/apps/transport-picker.hbs"
    }
  };

  /**
   * @param {Actor} actor - The Transport unit actor.
   * @param {Token} token - The unit's canvas token.
   * @param {Function} onSelect - Callback({ action, targetId }) when player picks.
   * @param {Function} onCancel - Callback when dialog is cancelled.
   * @param {object} [options] - ApplicationV2 options.
   */
  constructor(actor, token, onSelect, onCancel, options = {}) {
    super(options);
    this._actor = actor;
    this._token = token;
    this._onSelect = onSelect;
    this._onCancel = onCancel;
    this._selectedAction = null;
  }

  /** @override */
  async _prepareContext(options) {
    const hasCargo = this._actor.hasCargoAboard();
    const team = this._actor.system.team ?? "a";
    const myCenter = snapToHexCenter(this._token.center);
    const adjacentCenters = getAdjacentHexCenters(myCenter);

    // Find adjacent friendly Infantry units that can be loaded
    const loadableUnits = [];
    if (!hasCargo) {
      for (const token of canvas.tokens.placeables) {
        if (token === this._token) continue;
        if (!token.actor || token.actor.type !== "unit") continue;
        const otherTeam = token.actor.system.team ?? "a";
        if (otherTeam !== team) continue;
        if (!token.actor.hasTrait("Infantry")) continue;
        if (token.actor.isAboardTransport()) continue;
        if (token.actor.system.strength.value <= 0) continue;
        if (isEngaged(token)) continue;
        if (!areAdjacent(this._token, token)) continue;

        loadableUnits.push({
          tokenId: token.id,
          name: token.name,
          strength: token.actor.system.strength.value
        });
      }
    }

    // Find adjacent empty hexes for unloading
    const unloadHexes = [];
    if (hasCargo) {
      const occupiedKeys = new Set();
      for (const token of canvas.tokens.placeables) {
        if (token.actor?.type !== "unit") continue;
        if (token.actor.system.strength.value <= 0) continue;
        // Don't count the cargo token itself as occupying a hex
        const cargoTokenId = this._token.document.getFlag("star-mercs", "cargoTokenId");
        if (token.id === cargoTokenId) continue;
        occupiedKeys.add(hexKey(snapToHexCenter(token.center)));
      }

      for (const adj of adjacentCenters) {
        const key = hexKey(adj);
        if (!occupiedKeys.has(key)) {
          unloadHexes.push({ hexKey: key, x: adj.x, y: adj.y });
        }
      }
    }

    const canLoad = !hasCargo && loadableUnits.length > 0;
    const canUnload = hasCargo && unloadHexes.length > 0;

    let loadReason = "";
    if (hasCargo) loadReason = "Already carrying cargo";
    else if (loadableUnits.length === 0) loadReason = "No adjacent friendly Infantry units";

    let unloadReason = "";
    if (!hasCargo) unloadReason = "No cargo aboard";
    else if (unloadHexes.length === 0) unloadReason = "No adjacent empty hexes";

    // Get cargo name if loaded
    const cargoActor = this._actor.getCargoActor();
    const cargoName = cargoActor?.name ?? null;

    return {
      transportName: this._actor.name,
      canLoad,
      canUnload,
      loadReason,
      unloadReason,
      loadableUnits,
      unloadHexes,
      singleUnloadHex: unloadHexes.length === 1 ? unloadHexes[0].hexKey : null,
      cargoName
    };
  }

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Action selection (Load / Unload)
    html.querySelectorAll(".transport-action").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("disabled")) return;

        html.querySelectorAll(".transport-action").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        this._selectedAction = btn.dataset.action;

        // Show/hide sub-options
        html.querySelectorAll(".sub-options").forEach(el => el.style.display = "none");
        const subPanel = html.querySelector(`.sub-options[data-action="${this._selectedAction}"]`);
        if (subPanel) subPanel.style.display = "block";
      });
    });

    // Confirm button
    html.querySelector(".confirm-transport")?.addEventListener("click", () => {
      if (!this._selectedAction) {
        ui.notifications.warn("Select Load or Unload first.");
        return;
      }

      if (this._selectedAction === "load") {
        const targetId = html.querySelector('[name="loadTarget"]')?.value;
        if (!targetId) {
          ui.notifications.warn("Select an Infantry unit to load.");
          return;
        }
        this._onSelect({ action: "load", targetId });
      } else if (this._selectedAction === "unload") {
        const targetHex = html.querySelector('[name="unloadTarget"]')?.value;
        if (!targetHex) {
          ui.notifications.warn("Select a hex to unload to.");
          return;
        }
        this._onSelect({ action: "unload", targetId: targetHex });
      }

      this.close();
    });

    // Cancel button
    html.querySelector(".cancel-transport")?.addEventListener("click", () => {
      this._onCancel();
      this.close();
    });
  }
}
