/**
 * PIXI.Container that renders team-visible tactical markers on the canvas.
 *
 * Players can place icons anywhere on the map that only their teammates
 * (and the GM) can see. Each marker has a type, a 3-digit serial number,
 * and optional custom text.
 *
 * Data stored in scene flag `star-mercs.tacticalMarkers` as an array of:
 *   { id, x, y, type, team, serialNumber, text, createdBy }
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class TacticalMarkerLayer extends PIXI.Container {

  constructor() {
    super();

    /** @type {PIXI.Container} — holds individual marker groups */
    this.markerContainer = new PIXI.Container();
    this.addChild(this.markerContainer);

    /** @type {boolean} — flag to suppress browser context menu after right-click */
    this._suppressContextMenu = false;

    this._contextMenuHandler = (e) => {
      if (this._suppressContextMenu) {
        e.preventDefault();
        this._suppressContextMenu = false;
      }
    };
    document.addEventListener("contextmenu", this._contextMenuHandler, true);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static MARKER_RADIUS = 12;
  static MARKER_BG_ALPHA = 0.6;
  static MARKER_BORDER_WIDTH = 2;
  static MARKER_FONT_SIZE = 14;
  static MARKER_SERIAL_FONT_SIZE = 9;
  static MARKER_SERIAL_OFFSET_Y = 16;

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all tactical markers for the current viewer.
   */
  drawMarkers() {
    this.markerContainer.removeChildren();
    this.markerContainer.eventMode = "passive";
    this.markerContainer.interactiveChildren = true;

    const markers = canvas.scene?.getFlag("star-mercs", "tacticalMarkers") ?? [];
    if (!markers.length) return;

    const isGM = game.user.isGM;
    const myTeam = this._getViewerTeam();

    // Non-GM players without a team see nothing
    if (!isGM && !myTeam) return;

    for (const marker of markers) {
      // Players only see their own team's markers; GM sees all
      if (!isGM && marker.team !== myTeam) continue;
      this._drawSingleMarker(marker, isGM);
    }
  }

  /* ---------------------------------------- */
  /*  Static Helpers                          */
  /* ---------------------------------------- */

  /**
   * Create a new tactical marker.
   * @param {object} data - Marker data { x, y, type, team, serialNumber, text, createdBy }
   * @returns {Promise<void>}
   */
  static async createMarker(data) {
    if (!canvas.scene) return;
    const existing = canvas.scene.getFlag("star-mercs", "tacticalMarkers") ?? [];
    const marker = {
      id: foundry.utils.randomID(),
      ...data
    };
    existing.push(marker);
    await canvas.scene.setFlag("star-mercs", "tacticalMarkers", existing);
  }

  /**
   * Remove a tactical marker by ID.
   * @param {string} markerId
   * @returns {Promise<void>}
   */
  static async removeMarker(markerId) {
    if (!canvas.scene) return;
    const existing = canvas.scene.getFlag("star-mercs", "tacticalMarkers") ?? [];
    const updated = existing.filter(m => m.id !== markerId);
    await canvas.scene.setFlag("star-mercs", "tacticalMarkers", updated);
  }

  /**
   * Update a tactical marker's properties.
   * @param {string} markerId
   * @param {object} changes - Properties to update (e.g. { serialNumber, text })
   * @returns {Promise<void>}
   */
  static async updateMarker(markerId, changes) {
    if (!canvas.scene) return;
    const existing = canvas.scene.getFlag("star-mercs", "tacticalMarkers") ?? [];
    const idx = existing.findIndex(m => m.id === markerId);
    if (idx === -1) return;
    Object.assign(existing[idx], changes);
    await canvas.scene.setFlag("star-mercs", "tacticalMarkers", existing);
  }

  /**
   * Clear all tactical markers for a specific team.
   * @param {string} team - Team key ("a" or "b")
   * @returns {Promise<void>}
   */
  static async clearTeamMarkers(team) {
    if (!canvas.scene) return;
    const existing = canvas.scene.getFlag("star-mercs", "tacticalMarkers") ?? [];
    const updated = existing.filter(m => m.team !== team);
    if (updated.length === 0) {
      await canvas.scene.unsetFlag("star-mercs", "tacticalMarkers");
    } else {
      await canvas.scene.setFlag("star-mercs", "tacticalMarkers", updated);
    }
  }

  /* ---------------------------------------- */
  /*  Drawing Helpers                         */
  /* ---------------------------------------- */

  /**
   * Get the current viewer's team key.
   * @returns {string|null}
   * @private
   */
  _getViewerTeam() {
    const enabled = game.settings.get("star-mercs", "teamAssignmentsEnabled");
    if (!enabled) return null;
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const team = assignments[game.user.id];
    return (team && team !== "spectator") ? team : null;
  }

  /**
   * Draw a single tactical marker.
   * @param {object} marker - The marker data object.
   * @param {boolean} isGM - Whether the viewer is a GM.
   * @private
   */
  _drawSingleMarker(marker, isGM) {
    const markerConfig = CONFIG.STARMERCS.tacticalMarkerTypes[marker.type];
    if (!markerConfig) return;

    const group = new PIXI.Container();
    group.position.set(marker.x, marker.y);

    const radius = TacticalMarkerLayer.MARKER_RADIUS;
    const color = markerConfig.color;

    // Dark circle background with colored border
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, TacticalMarkerLayer.MARKER_BG_ALPHA);
    bg.lineStyle(TacticalMarkerLayer.MARKER_BORDER_WIDTH, color, 1);
    bg.drawCircle(0, 0, radius);
    bg.endFill();
    group.addChild(bg);

    // Icon or custom text in center
    let iconText;
    if (marker.type === "text" && marker.text) {
      // For text markers, show custom text (truncated to fit)
      iconText = marker.text.length > 3 ? marker.text.substring(0, 3) : marker.text;
    } else {
      iconText = markerConfig.icon;
    }

    const iconDisplay = new PIXI.Text(iconText, {
      fontFamily: "Signika",
      fontSize: TacticalMarkerLayer.MARKER_FONT_SIZE,
      fill: color,
      stroke: 0x000000,
      strokeThickness: 2,
      fontWeight: "bold",
      align: "center"
    });
    iconDisplay.anchor.set(0.5, 0.5);
    iconDisplay.position.set(0, 0);
    group.addChild(iconDisplay);

    // Serial number below
    let serialLabel = marker.serialNumber || "---";
    if (isGM) {
      serialLabel += ` (${marker.team.toUpperCase()})`;
    }
    const serialText = new PIXI.Text(serialLabel, {
      fontFamily: "Signika",
      fontSize: TacticalMarkerLayer.MARKER_SERIAL_FONT_SIZE,
      fill: 0xFFFFFF,
      stroke: 0x000000,
      strokeThickness: 2,
      align: "center"
    });
    serialText.anchor.set(0.5, 0);
    serialText.position.set(0, TacticalMarkerLayer.MARKER_SERIAL_OFFSET_Y);
    group.addChild(serialText);

    // For text markers with longer text, show full text below serial
    if (marker.type === "text" && marker.text && marker.text.length > 3) {
      const fullText = new PIXI.Text(marker.text, {
        fontFamily: "Signika",
        fontSize: 8,
        fill: 0xFFFFFF,
        stroke: 0x000000,
        strokeThickness: 2,
        align: "center"
      });
      fullText.anchor.set(0.5, 0);
      fullText.position.set(0, TacticalMarkerLayer.MARKER_SERIAL_OFFSET_Y + 12);
      group.addChild(fullText);
    }

    // Make interactive for right-click edit/delete
    group.eventMode = "static";
    group.cursor = "pointer";
    group.hitArea = new PIXI.Circle(0, 0, radius + 6);

    group.on("rightdown", (event) => {
      event.stopPropagation();
      this._suppressContextMenu = true;

      // Permission check: same-team or GM
      const myTeam = this._getViewerTeam();
      if (!game.user.isGM && marker.team !== myTeam) return;

      this._showEditDialog(marker);
    });

    this.markerContainer.addChild(group);
  }

  /**
   * Show edit/delete dialog for a marker.
   * @param {object} marker - The marker data object.
   * @private
   */
  _showEditDialog(marker) {
    const markerConfig = CONFIG.STARMERCS.tacticalMarkerTypes[marker.type];
    const isTextType = marker.type === "text";

    const content = `
      <form>
        <div class="form-group">
          <label>Type: <strong>${markerConfig?.label ?? marker.type}</strong></label>
        </div>
        <div class="form-group">
          <label>Serial Number</label>
          <input type="text" name="serialNumber" value="${marker.serialNumber || ""}"
                 maxlength="3" placeholder="001" style="width: 60px;"/>
        </div>
        ${isTextType ? `
        <div class="form-group">
          <label>Text</label>
          <input type="text" name="text" value="${marker.text || ""}" maxlength="30"/>
        </div>` : ""}
      </form>
    `;

    new Dialog({
      title: `Edit Marker: ${markerConfig?.label ?? marker.type}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-save"></i>',
          label: "Save",
          callback: async (html) => {
            const form = html instanceof HTMLElement ? html : html[0];
            const serialInput = form.querySelector('[name="serialNumber"]');
            const textInput = form.querySelector('[name="text"]');
            const changes = {};
            if (serialInput) changes.serialNumber = serialInput.value;
            if (textInput) changes.text = textInput.value;
            await TacticalMarkerLayer.updateMarker(marker.id, changes);
          }
        },
        delete: {
          icon: '<i class="fas fa-trash"></i>',
          label: "Delete",
          callback: async () => {
            await TacticalMarkerLayer.removeMarker(marker.id);
          }
        }
      },
      default: "save"
    }).render(true);
  }
}
