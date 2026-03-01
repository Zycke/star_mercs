import TacticalMarkerLayer from "../canvas/tactical-marker-layer.mjs";

/**
 * Tactical Marker Painter — a floating panel that lets any player place
 * team-visible markers on the map. Markers are visible only to teammates
 * and the GM.
 *
 * Left-click on the canvas places a marker at the click position.
 * Right-click on an existing marker opens an edit/delete dialog.
 *
 * Data stored in scene flag `star-mercs.tacticalMarkers`.
 */
export default class TacticalMarkerPainter extends FormApplication {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "star-mercs-tactical-marker-painter",
      title: "Tactical Markers",
      template: "systems/star-mercs/templates/apps/tactical-marker-painter.hbs",
      classes: ["star-mercs", "tactical-marker-painter"],
      width: 260,
      height: "auto",
      popOut: true,
      resizable: false,
      closeOnSubmit: false,
      submitOnChange: true
    });
  }

  constructor(...args) {
    super(...args);
    this._selectedType = "attack";
    this._serialNumber = "001";
    this._customText = "";
    this._active = false;

    // For GM: which team to place markers for
    this._selectedTeam = this._getPlayerTeam() ?? "a";

    // Bound event handlers
    this._onPointerDown = null;
  }

  /** @override */
  getData() {
    const markerTypes = CONFIG.STARMERCS.tacticalMarkerTypes;

    // Build grouped choices for the select dropdown
    const commandChoices = {};
    const spottedChoices = {};
    for (const [key, config] of Object.entries(markerTypes)) {
      if (config.category === "command") {
        commandChoices[key] = config.label;
      } else if (config.category === "spotted") {
        spottedChoices[key] = config.label;
      }
    }

    return {
      commandChoices,
      spottedChoices,
      selectedType: this._selectedType,
      serialNumber: this._serialNumber,
      customText: this._customText,
      isTextType: this._selectedType === "text",
      isActive: this._active,
      isGM: game.user.isGM,
      selectedTeam: this._selectedTeam,
      playerTeam: this._getPlayerTeam()
    };
  }

  /** @override */
  async _updateObject(event, formData) {
    if (formData.selectedType) {
      this._selectedType = formData.selectedType;
    }
    if (formData.serialNumber != null) {
      this._serialNumber = formData.serialNumber;
    }
    if (formData.customText != null) {
      this._customText = formData.customText;
    }
    if (formData.selectedTeam) {
      this._selectedTeam = formData.selectedTeam;
    }
    // Re-render to toggle text input visibility
    this.render(false);
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find(".toggle-placing").on("click", () => {
      this._active = !this._active;
      if (this._active) {
        this._startPlacing();
      } else {
        this._stopPlacing();
      }
      this.render(false);
    });

    html.find(".clear-team-markers").on("click", async () => {
      const team = game.user.isGM ? this._selectedTeam : this._getPlayerTeam();
      if (!team) return;

      const confirm = await Dialog.confirm({
        title: "Clear Team Markers",
        content: `<p>Remove all markers for Team ${team.toUpperCase()} on this scene?</p>`
      });
      if (confirm) {
        await TacticalMarkerLayer.clearTeamMarkers(team);
      }
    });
  }

  /* ---------------------------------------- */
  /*  Placing Mode                            */
  /* ---------------------------------------- */

  /**
   * Get the current player's team.
   * @returns {string|null}
   * @private
   */
  _getPlayerTeam() {
    const enabled = game.settings.get("star-mercs", "teamAssignmentsEnabled");
    if (!enabled) return null;
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const team = assignments[game.user.id];
    return (team && team !== "spectator") ? team : null;
  }

  /**
   * Helper: extract canvas position from PIXI event.
   * @private
   */
  _getEventPos(e) {
    if (typeof e.getLocalPosition === "function") return e.getLocalPosition(canvas.stage);
    if (e.data?.getLocalPosition) return e.data.getLocalPosition(canvas.stage);
    if (e.global) return canvas.stage.toLocal(e.global);
    return null;
  }

  /**
   * Activate placing mode: register canvas click handler.
   * @private
   */
  _startPlacing() {
    if (this._onPointerDown) return;

    this._onPointerDown = async (event) => {
      const button = event.button ?? event.data?.button ?? 0;
      if (!this._active || button !== 0) return;

      const pos = this._getEventPos(event);
      if (!pos) return;

      // Determine team
      const team = game.user.isGM ? this._selectedTeam : this._getPlayerTeam();
      if (!team) {
        ui.notifications.warn("You are not assigned to a team.");
        return;
      }

      const markerData = {
        x: pos.x,
        y: pos.y,
        type: this._selectedType,
        team,
        serialNumber: this._serialNumber || "001",
        text: this._selectedType === "text" ? this._customText : "",
        createdBy: game.user.id
      };

      await TacticalMarkerLayer.createMarker(markerData);
    };

    canvas.stage.on("pointerdown", this._onPointerDown);
    ui.notifications.info("Tactical Marker placement active: left-click to place markers.");
  }

  /**
   * Deactivate placing mode.
   * @private
   */
  _stopPlacing() {
    if (this._onPointerDown) {
      canvas.stage.off("pointerdown", this._onPointerDown);
      this._onPointerDown = null;
    }
    ui.notifications.info("Tactical Marker placement deactivated.");
  }

  /** @override */
  async close(options) {
    this._stopPlacing();
    return super.close(options);
  }
}
