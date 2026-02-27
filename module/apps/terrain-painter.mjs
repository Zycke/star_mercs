import { snapToHexCenter, hexKey } from "../hex-utils.mjs";

/**
 * Terrain Painter — a floating panel that lets the GM paint terrain types onto hex cells.
 * When active, left-click a hex to assign the selected terrain type,
 * right-click to erase terrain from that hex.
 *
 * Terrain data is stored in the scene flag `star-mercs.terrainMap`.
 */
export default class TerrainPainter extends FormApplication {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "star-mercs-terrain-painter",
      title: "Terrain Painter",
      template: "systems/star-mercs/templates/apps/terrain-painter.hbs",
      classes: ["star-mercs", "terrain-painter"],
      width: 240,
      height: "auto",
      popOut: true,
      resizable: false,
      closeOnSubmit: false,
      submitOnChange: true
    });
  }

  constructor(...args) {
    super(...args);
    this._selectedTerrain = "plain";
    this._active = false;

    // Bound event handlers (assigned in _startPainting, removed in _stopPainting)
    this._onPointerDown = null;
    this._onRightDown = null;
    this._onPointerMove = null;
    this._onPointerUp = null;

    // Drag state
    this._isDragging = false;
    this._isErasing = false;
    this._dragVisitedKeys = new Set();
    this._pendingTerrainMap = null;
  }

  /** @override */
  getData() {
    const terrainChoices = {};
    for (const [key, config] of Object.entries(CONFIG.STARMERCS.terrain)) {
      terrainChoices[key] = config.label;
    }
    return {
      terrainChoices,
      selectedTerrain: this._selectedTerrain,
      isActive: this._active
    };
  }

  /** @override */
  async _updateObject(event, formData) {
    if (formData.selectedTerrain) {
      this._selectedTerrain = formData.selectedTerrain;
    }
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find(".toggle-painting").on("click", () => {
      this._active = !this._active;
      if (this._active) {
        this._startPainting();
      } else {
        this._stopPainting();
      }
      this.render(false);
    });

    html.find(".clear-all-terrain").on("click", async () => {
      const confirm = await Dialog.confirm({
        title: "Clear All Terrain",
        content: "<p>Remove all terrain from this scene?</p>"
      });
      if (confirm) {
        await canvas.scene.unsetFlag("star-mercs", "terrainMap");
        game.starmercs?.terrainLayer?.drawTerrain();
      }
    });
  }

  /**
   * Activate painting mode: register canvas event handlers for click-and-drag painting.
   * Left-click/drag paints terrain, right-click/drag erases terrain.
   * Changes are batched and flushed to the scene flag on pointer-up.
   * @private
   */
  _startPainting() {
    if (this._onPointerDown) return;

    this._onPointerDown = (event) => {
      if (!this._active || event.data?.button !== 0) return;
      this._beginDrag(event, false);
    };

    this._onRightDown = (event) => {
      if (!this._active) return;
      event.preventDefault?.();
      this._beginDrag(event, true);
    };

    this._onPointerMove = (event) => {
      if (!this._active || !this._isDragging) return;
      const pos = event.data?.getLocalPosition(canvas.stage);
      if (!pos) return;
      this._applyToHex(pos);
    };

    this._onPointerUp = async () => {
      if (!this._isDragging) return;
      this._isDragging = false;

      if (this._pendingTerrainMap && this._dragVisitedKeys.size > 0) {
        await canvas.scene.setFlag("star-mercs", "terrainMap", this._pendingTerrainMap);
        game.starmercs?.terrainLayer?.drawTerrain();
      }

      this._dragVisitedKeys.clear();
      this._pendingTerrainMap = null;
    };

    canvas.stage.on("pointerdown", this._onPointerDown);
    canvas.stage.on("rightdown", this._onRightDown);
    canvas.stage.on("pointermove", this._onPointerMove);
    canvas.stage.on("pointerup", this._onPointerUp);
    canvas.stage.on("pointerupoutside", this._onPointerUp);
    ui.notifications.info("Terrain Painter active: click/drag to paint, right-click/drag to erase.");
  }

  /**
   * Begin a drag operation (paint or erase).
   * @param {PIXI.InteractionEvent} event
   * @param {boolean} erasing - True if erasing, false if painting.
   * @private
   */
  _beginDrag(event, erasing) {
    this._isDragging = true;
    this._isErasing = erasing;
    this._dragVisitedKeys.clear();
    this._pendingTerrainMap = foundry.utils.deepClone(
      canvas.scene.getFlag("star-mercs", "terrainMap") ?? {}
    );

    const pos = event.data?.getLocalPosition(canvas.stage);
    if (pos) this._applyToHex(pos);
  }

  /**
   * Paint or erase a single hex during a drag operation.
   * Skips hexes already visited in the current drag stroke.
   * @param {{x: number, y: number}} pos - Canvas position.
   * @private
   */
  _applyToHex(pos) {
    const center = snapToHexCenter(pos);
    const key = hexKey(center);
    if (this._dragVisitedKeys.has(key)) return;

    this._dragVisitedKeys.add(key);

    if (this._isErasing) {
      delete this._pendingTerrainMap[key];
    } else {
      this._pendingTerrainMap[key] = this._selectedTerrain;
    }

    // Live preview using the pending map (not yet saved to the scene flag)
    game.starmercs?.terrainLayer?.drawTerrain(this._pendingTerrainMap);
  }

  /**
   * Deactivate painting mode: remove canvas event handlers.
   * @private
   */
  _stopPainting() {
    if (this._onPointerDown) {
      canvas.stage.off("pointerdown", this._onPointerDown);
      this._onPointerDown = null;
    }
    if (this._onRightDown) {
      canvas.stage.off("rightdown", this._onRightDown);
      this._onRightDown = null;
    }
    if (this._onPointerMove) {
      canvas.stage.off("pointermove", this._onPointerMove);
      this._onPointerMove = null;
    }
    if (this._onPointerUp) {
      canvas.stage.off("pointerup", this._onPointerUp);
      canvas.stage.off("pointerupoutside", this._onPointerUp);
      this._onPointerUp = null;
    }
    this._isDragging = false;
    this._pendingTerrainMap = null;
    this._dragVisitedKeys.clear();
    ui.notifications.info("Terrain Painter deactivated.");
  }

  /** @override */
  async close(options) {
    this._stopPainting();
    return super.close(options);
  }
}
