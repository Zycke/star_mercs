import { snapToHexCenter, hexKey, getAdjacentHexCenters } from "../hex-utils.mjs";

/**
 * Terrain Painter — a floating panel that lets the GM paint terrain types onto hex cells.
 * When active, left-click a hex to assign the selected terrain type,
 * right-click to erase terrain from that hex.
 *
 * Performance: During drag-painting, only changed hexes are drawn on a dynamic overlay
 * (no full map redraw). The full static layer is redrawn once on pointer-up (commit).
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
    this._selectedElevation = 0;
    this._selectedRoad = false;
    this._brushSize = 1;
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
    this._changedKeys = new Set();
    this._pendingTerrainMap = null;

    // Hover deduplication
    this._lastPreviewKey = null;
  }

  /** @override */
  getData() {
    const terrainChoices = {};
    for (const [key, config] of Object.entries(CONFIG.STARMERCS.terrain)) {
      terrainChoices[key] = config.label;
    }
    // Add special "Road Only" brush
    terrainChoices["road"] = "Road Only";

    return {
      terrainChoices,
      selectedTerrain: this._selectedTerrain,
      selectedElevation: this._selectedElevation,
      selectedRoad: this._selectedRoad,
      brushSize: this._brushSize,
      maxElevation: CONFIG.STARMERCS.maxElevation ?? 5,
      isActive: this._active
    };
  }

  /** @override */
  async _updateObject(event, formData) {
    if (formData.selectedTerrain) {
      this._selectedTerrain = formData.selectedTerrain;
    }
    if (formData.selectedElevation != null) {
      this._selectedElevation = Math.max(0, Math.min(CONFIG.STARMERCS.maxElevation ?? 5, Number(formData.selectedElevation) || 0));
    }
    this._selectedRoad = !!formData.selectedRoad;
    if (formData.brushSize != null) {
      this._brushSize = Math.max(1, Math.min(5, Number(formData.brushSize) || 1));
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

  /* ---------------------------------------- */
  /*  Hex Radius Helpers                      */
  /* ---------------------------------------- */

  /**
   * Get all hex centers within a given radius of a center hex using BFS.
   * @param {{x: number, y: number}} center - Center hex coordinates.
   * @param {number} radius - Radius in hexes (0 = just the center).
   * @returns {Array<{x: number, y: number}>}
   * @private
   */
  _getHexesInRadius(center, radius) {
    const visited = new Set();
    visited.add(hexKey(center));
    let frontier = [center];
    const all = [center];
    for (let d = 0; d < radius; d++) {
      const next = [];
      for (const hex of frontier) {
        for (const n of getAdjacentHexCenters(hex)) {
          const k = hexKey(n);
          if (visited.has(k)) continue;
          visited.add(k);
          next.push(n);
          all.push(n);
        }
      }
      frontier = next;
    }
    return all;
  }

  /* ---------------------------------------- */
  /*  Painting Mode                           */
  /* ---------------------------------------- */

  /**
   * Activate painting mode: register canvas event handlers for click-and-drag painting.
   * Left-click/drag paints terrain, right-click/drag erases terrain.
   * Changes are batched and flushed to the scene flag on pointer-up.
   * @private
   */
  _startPainting() {
    if (this._onPointerDown) return;

    // Helper: extract canvas position from PIXI event (compatible with v5–v8 / Foundry v12–v13)
    this._getEventPos = (e) => {
      if (typeof e.getLocalPosition === 'function') return e.getLocalPosition(canvas.stage);
      if (e.data?.getLocalPosition) return e.data.getLocalPosition(canvas.stage);
      if (e.global) return canvas.stage.toLocal(e.global);
      return null;
    };

    this._onPointerDown = (event) => {
      const button = event.button ?? event.data?.button ?? 0;
      if (!this._active || button !== 0) return;
      this._beginDrag(event, false);
    };

    this._onRightDown = (event) => {
      if (!this._active) return;
      event.preventDefault?.();
      this._beginDrag(event, true);
    };

    this._onPointerMove = (event) => {
      if (!this._active) return;
      const pos = this._getEventPos(event);
      if (!pos) return;

      if (this._isDragging) {
        // Painting/erasing — apply to hex under cursor (dynamic overlay only)
        this._applyToHex(pos);
      } else {
        // Hovering — show brush preview (skip if same hex as last event)
        const center = snapToHexCenter(pos);
        const key = hexKey(center);
        if (key === this._lastPreviewKey) return;
        this._lastPreviewKey = key;

        const radius = this._brushSize - 1;
        const hexes = this._getHexesInRadius(center, radius);
        game.starmercs?.terrainLayer?.drawBrushPreview(hexes);
      }
    };

    this._onPointerUp = async () => {
      if (!this._isDragging) return;
      this._isDragging = false;

      if (this._pendingTerrainMap && this._dragVisitedKeys.size > 0) {
        // Commit to scene flag, then do one full static redraw
        await canvas.scene.setFlag("star-mercs", "terrainMap", this._pendingTerrainMap);
        game.starmercs?.terrainLayer?.drawTerrain();
      } else {
        // No changes — just clear the paint overlay
        game.starmercs?.terrainLayer?.clearPaintOverlay();
      }

      this._dragVisitedKeys.clear();
      this._changedKeys.clear();
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
    this._changedKeys.clear();
    this._pendingTerrainMap = foundry.utils.deepClone(
      canvas.scene.getFlag("star-mercs", "terrainMap") ?? {}
    );

    // Clear hover preview while dragging
    game.starmercs?.terrainLayer?.clearBrushPreview();

    const pos = this._getEventPos?.(event);
    if (pos) this._applyToHex(pos);
  }

  /**
   * Paint or erase hexes within the brush radius during a drag operation.
   * Only draws changed hexes on the dynamic overlay (not a full redraw).
   * @param {{x: number, y: number}} pos - Canvas position.
   * @private
   */
  _applyToHex(pos) {
    const center = snapToHexCenter(pos);
    const radius = this._brushSize - 1;
    const hexes = this._getHexesInRadius(center, radius);

    let anyNew = false;
    for (const hex of hexes) {
      const key = hexKey(hex);
      if (this._dragVisitedKeys.has(key)) continue;
      this._dragVisitedKeys.add(key);
      anyNew = true;

      if (this._isErasing) {
        delete this._pendingTerrainMap[key];
      } else if (this._selectedTerrain === "road") {
        // Road Only brush: add road to existing terrain without changing type/elevation
        const existing = this._pendingTerrainMap[key];
        if (existing) {
          const normalized = (typeof existing === "string")
            ? { type: existing, elevation: 0, road: true }
            : { ...existing, road: true };
          this._pendingTerrainMap[key] = normalized;
        }
        // Skip hexes with no existing terrain — road needs a terrain base
      } else {
        this._pendingTerrainMap[key] = {
          type: this._selectedTerrain,
          elevation: this._selectedElevation,
          road: this._selectedRoad
        };
      }

      this._changedKeys.add(key);
    }

    // Only update the dynamic paint overlay if something actually changed
    if (anyNew) {
      game.starmercs?.terrainLayer?.drawPaintOverlay(this._changedKeys, this._pendingTerrainMap);
    }
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
    this._changedKeys.clear();
    this._lastPreviewKey = null;
    game.starmercs?.terrainLayer?.clearPaintOverlay();
    game.starmercs?.terrainLayer?.clearBrushPreview();
    ui.notifications.info("Terrain Painter deactivated.");
  }

  /** @override */
  async close(options) {
    this._stopPainting();
    return super.close(options);
  }
}
