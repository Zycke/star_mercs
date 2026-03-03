import { snapToHexCenter, hexKey, getAdjacentHexCenters, normalizeHexData } from "../hex-utils.mjs";
import StructureLayer from "../canvas/structure-layer.mjs";

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
    this._selectedObjective = "none";
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

    // Structure painting state
    this._selectedStructure = "";       // "" = terrain mode
    this._structureTeam = "a";
    this._mineSubType = "antiPersonnel";
  }

  /** @override */
  getData() {
    const terrainChoices = {};
    for (const [key, config] of Object.entries(CONFIG.STARMERCS.terrain)) {
      terrainChoices[key] = config.label;
    }
    // Add special brushes
    terrainChoices["road"] = "Road Only";
    terrainChoices["removeRoad"] = "Remove Road";
    terrainChoices["bridge"] = "Bridge (Water Only)";
    terrainChoices["removeBridge"] = "Remove Bridge";
    terrainChoices["removeObjective"] = "Remove Objective";

    return {
      terrainChoices,
      selectedTerrain: this._selectedTerrain,
      selectedElevation: this._selectedElevation,
      selectedRoad: this._selectedRoad,
      selectedObjective: this._selectedObjective,
      brushSize: this._brushSize,
      maxElevation: CONFIG.STARMERCS.maxElevation ?? 5,
      isActive: this._active,
      selectedStructure: this._selectedStructure,
      structureTeam: this._structureTeam,
      mineSubType: this._mineSubType,
      isStructureMode: !!this._selectedStructure,
      isMinefieldMode: this._selectedStructure === "minefield",
      isRemoveStructureMode: this._selectedStructure === "removeStructure"
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
    if (formData.selectedObjective != null) {
      this._selectedObjective = formData.selectedObjective;
    }
    if (formData.brushSize != null) {
      this._brushSize = Math.max(1, Math.min(5, Number(formData.brushSize) || 1));
    }
    if (formData.selectedStructure != null) {
      this._selectedStructure = formData.selectedStructure;
    }
    if (formData.structureTeam != null) {
      this._structureTeam = formData.structureTeam;
    }
    if (formData.mineSubType != null) {
      this._mineSubType = formData.mineSubType;
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

      // Structure mode: single click, no drag
      if (this._selectedStructure) {
        this._handleStructureClick(event);
        return;
      }

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

        const radius = this._selectedStructure ? 0 : this._brushSize - 1;
        const hexes = this._getHexesInRadius(center, radius);
        game.starmercs?.terrainLayer?.drawBrushPreview(hexes);
      }
    };

    this._onPointerUp = async () => {
      if (!this._isDragging) return;
      this._isDragging = false;

      if (this._pendingTerrainMap && this._dragVisitedKeys.size > 0) {
        // Build update object with proper deletion syntax for erased hexes.
        // setFlag() deep-merges, which silently preserves deleted keys.
        // scene.update() with Foundry's "-=key" convention actually removes them.
        const updateData = {};
        for (const key of this._dragVisitedKeys) {
          if (key in this._pendingTerrainMap) {
            updateData[`flags.star-mercs.terrainMap.${key}`] = this._pendingTerrainMap[key];
          } else {
            updateData[`flags.star-mercs.terrainMap.-=${key}`] = null;
          }
        }
        await canvas.scene.update(updateData);
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
      } else if (this._selectedTerrain === "removeRoad") {
        // Remove Road brush: clear road flag, keep everything else
        const existing = this._pendingTerrainMap[key];
        if (existing) {
          const normalized = (typeof existing === "string")
            ? { type: existing, elevation: 0, road: false }
            : { ...existing, road: false };
          this._pendingTerrainMap[key] = normalized;
        }
      } else if (this._selectedTerrain === "bridge") {
        // Bridge brush: add bridge flag to existing water terrain
        const existing = this._pendingTerrainMap[key];
        if (existing) {
          const normalized = (typeof existing === "string")
            ? { type: existing, elevation: 0, bridge: true }
            : { ...existing, bridge: true };
          // Only apply to water terrain
          const tConfig = CONFIG.STARMERCS?.terrain?.[normalized.type];
          if (tConfig?.waterTerrain) {
            this._pendingTerrainMap[key] = normalized;
          }
        }
      } else if (this._selectedTerrain === "removeBridge") {
        // Remove Bridge brush: clear bridge flag, keep everything else
        const existing = this._pendingTerrainMap[key];
        if (existing) {
          const normalized = (typeof existing === "string")
            ? { type: existing, elevation: 0, bridge: false }
            : { ...existing, bridge: false };
          this._pendingTerrainMap[key] = normalized;
        }
      } else if (this._selectedTerrain === "removeObjective") {
        // Remove Objective brush: clear objective, keep everything else
        const existing = this._pendingTerrainMap[key];
        if (existing) {
          const normalized = (typeof existing === "string")
            ? { type: existing, elevation: 0, objective: null }
            : { ...existing, objective: null };
          this._pendingTerrainMap[key] = normalized;
        }
      } else {
        const hexData = {
          type: this._selectedTerrain,
          elevation: this._selectedElevation,
          road: this._selectedRoad,
          objective: (this._selectedObjective && this._selectedObjective !== "none")
            ? this._selectedObjective
            : null
        };
        this._pendingTerrainMap[key] = hexData;
      }

      this._changedKeys.add(key);
    }

    // Only update the dynamic paint overlay if something actually changed
    if (anyNew) {
      game.starmercs?.terrainLayer?.drawPaintOverlay(this._changedKeys, this._pendingTerrainMap);
    }
  }

  /* ---------------------------------------- */
  /*  Structure Painting                      */
  /* ---------------------------------------- */

  /**
   * Handle a single click in structure mode (place or remove structure).
   * @param {PIXI.InteractionEvent} event
   * @private
   */
  async _handleStructureClick(event) {
    const pos = this._getEventPos?.(event);
    if (!pos) return;
    const center = snapToHexCenter(pos);
    const key = hexKey(center);

    if (this._selectedStructure === "removeStructure") {
      await this._removeStructureAtHex(key);
    } else {
      await this._placeStructureAtHex(center, key);
    }
  }

  /**
   * Place a fully-built structure at a hex.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {string} key - Hex key string.
   * @private
   */
  async _placeStructureAtHex(center, key) {
    // Check for existing structure at this hex
    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    const existing = structures.find(s => s.hexKey === key);
    if (existing) {
      ui.notifications.warn("This hex already has a structure. Remove it first.");
      return;
    }

    // Check terrain validity
    const terrainMap = canvas.scene?.getFlag("star-mercs", "terrainMap") ?? {};
    const rawEntry = terrainMap[key];
    const hexData = rawEntry ? normalizeHexData(rawEntry) : null;
    const terrainConfig = hexData ? (CONFIG.STARMERCS?.terrain?.[hexData.type] ?? null) : null;

    // Cannot place on water terrain
    if (terrainConfig?.waterTerrain) {
      ui.notifications.warn("Cannot place structures on water terrain.");
      return;
    }

    // Cannot place fortification/outpost on noFortification terrain
    if (terrainConfig?.noFortification &&
        (this._selectedStructure === "outpost" || this._selectedStructure === "fortification")) {
      ui.notifications.warn("Cannot place fortifications on this terrain type.");
      return;
    }

    const type = this._selectedStructure;
    const config = StructureLayer.getStructureConfig(type);
    if (!config) return;

    // Build fully-constructed structure data
    const structureData = {
      hexKey: key,
      x: center.x,
      y: center.y,
      type,
      name: null,
      team: this._structureTeam,
      strength: config.maxStrength,
      maxStrength: config.maxStrength,
      turnsBuilt: config.turnsRequired,
      turnsRequired: config.turnsRequired,
      revealed: false,
      builderId: null,
      subType: type === "minefield" ? this._mineSubType : null,
      supply: null,
      commsRange: null,
      supplyRange: null,
      autoSupply: true
    };

    // Outpost-specific fields (empty supply)
    if (type === "outpost") {
      structureData.commsRange = config.defaultCommsRange ?? 5;
      structureData.supplyRange = config.defaultSupplyRange ?? 3;
      const caps = config.defaultSupplyCapacity ?? {};
      structureData.supply = {};
      for (const cat of ["projectile", "ordnance", "energy", "fuel", "materials", "parts", "basicSupplies"]) {
        structureData.supply[cat] = { current: 0, capacity: caps[cat] ?? 0 };
      }
    }

    await StructureLayer.createStructure(structureData);
    game.starmercs?.structureLayer?.drawStructures();
    ui.notifications.info(`${config.label} placed at ${key}.`);
  }

  /**
   * Remove a structure from a hex.
   * @param {string} key - Hex key string.
   * @private
   */
  async _removeStructureAtHex(key) {
    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    const target = structures.find(s => s.hexKey === key);
    if (!target) {
      ui.notifications.warn("No structure at this hex.");
      return;
    }

    const config = CONFIG.STARMERCS.structures[target.type];
    await StructureLayer.removeStructure(target.id);

    // Clear bridge terrain flag if removing a bridge
    if (target.type === "bridge" && target.hexKey) {
      const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap") ?? {};
      if (terrainMap[target.hexKey]) {
        const hexData = typeof terrainMap[target.hexKey] === "string"
          ? { type: terrainMap[target.hexKey], elevation: 0 }
          : { ...terrainMap[target.hexKey] };
        delete hexData.bridge;
        terrainMap[target.hexKey] = hexData;
        await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
      }
    }

    game.starmercs?.structureLayer?.drawStructures();
    ui.notifications.info(`${config?.label ?? target.type} removed from ${key}.`);
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
