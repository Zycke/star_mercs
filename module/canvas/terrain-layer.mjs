import { normalizeHexData } from "../hex-utils.mjs";

/**
 * PIXI.Container that renders terrain type overlays on hex cells.
 *
 * Uses a static/dynamic split for performance during painting:
 * - Static layer (terrainGraphics + labelContainer): Drawn once from saved scene data.
 *   Only redrawn on commit or settings changes.
 * - Dynamic paint overlay (paintGraphics): Only draws hexes changed during the current
 *   drag stroke. No labels — just colored hex fills and road borders.
 * - Preview layer (previewGraphics): Brush hover highlight, independent of both.
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class TerrainLayer extends PIXI.Container {

  constructor() {
    super();

    /** @type {PIXI.Graphics} — static terrain hex overlays */
    this.terrainGraphics = new PIXI.Graphics();
    this.addChild(this.terrainGraphics);

    /** @type {PIXI.Container} — static terrain labels */
    this.labelContainer = new PIXI.Container();
    this.addChild(this.labelContainer);

    /** @type {PIXI.Graphics} — dynamic paint overlay (only changed hexes during drag) */
    this.paintGraphics = new PIXI.Graphics();
    this.addChild(this.paintGraphics);

    /** @type {PIXI.Graphics} — brush preview highlight */
    this.previewGraphics = new PIXI.Graphics();
    this.addChild(this.previewGraphics);

    /** @type {PIXI.Graphics} — objective star icons */
    this.objectiveGraphics = new PIXI.Graphics();
    this.addChild(this.objectiveGraphics);

    /** @type {object|null} — cached shape + centroid to avoid recomputing per call */
    this._cachedShape = null;
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static HEX_FILL_ALPHA = 0.25;
  static HEX_BORDER_ALPHA = 0.5;
  static HEX_BORDER_WIDTH = 2;
  static ROAD_BORDER_WIDTH = 3;
  static ROAD_BORDER_ALPHA = 0.8;
  static ERASE_MASK_ALPHA = 0.6;
  static LABEL_FONT_SIZE = 10;
  static STAR_PRIMARY_RADIUS = 14;
  static STAR_SECONDARY_RADIUS = 10;
  static STAR_INNER_RATIO = 0.4;
  static STAR_ALPHA = 0.9;

  /* ---------------------------------------- */
  /*  Shape Cache                             */
  /* ---------------------------------------- */

  /**
   * Get the cached hex shape and centroid, computing if needed.
   * @returns {{shape: Array, centerX: number, centerY: number}|null}
   * @private
   */
  _ensureShapeCache() {
    if (this._cachedShape) return this._cachedShape;
    const shape = canvas.grid.getShape();
    if (!shape || shape.length < 3) return null;
    const centerX = shape.reduce((sum, p) => sum + p.x, 0) / shape.length;
    const centerY = shape.reduce((sum, p) => sum + p.y, 0) / shape.length;
    this._cachedShape = { shape, centerX, centerY };
    return this._cachedShape;
  }

  /**
   * Invalidate the shape cache (call on scene change).
   */
  invalidateCache() {
    this._cachedShape = null;
  }

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all terrain hex overlays from scene data (static layer).
   * Also clears the dynamic paint overlay.
   */
  drawTerrain() {
    this.terrainGraphics.clear();
    this.labelContainer.removeChildren();
    this.paintGraphics.clear();
    this.objectiveGraphics.clear();

    // Invalidate shape cache on full redraw (scene may have changed)
    this._cachedShape = null;

    if (!game.settings.get("star-mercs", "showTerrainOverlay")) return;
    if (!canvas?.scene) return;

    const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap");
    if (!terrainMap || typeof terrainMap !== "object") return;

    const cache = this._ensureShapeCache();
    if (!cache) return;
    const { shape, centerX, centerY } = cache;

    const terrainConfig = CONFIG.STARMERCS?.terrain ?? {};
    const objectiveConfig = CONFIG.STARMERCS?.objectives ?? {};

    for (const [key, rawEntry] of Object.entries(terrainMap)) {
      const hexData = normalizeHexData(rawEntry);
      const config = terrainConfig[hexData.type];
      if (!config) continue;

      const [xStr, yStr] = key.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };
      const topLeft = { x: center.x - centerX, y: center.y - centerY };

      this._drawHexOnGraphics(this.terrainGraphics, topLeft, shape, config.color ?? 0x888888);

      const hasRoad = hexData.road || config.hasRoad;
      if (hasRoad) {
        this._drawRoadBorderOnGraphics(this.terrainGraphics, topLeft, shape);
      }

      this._drawLabel(center, config.label ?? hexData.type, hexData.elevation, hexData.road, hexData.objective);

      // Draw objective star icon
      if (hexData.objective && objectiveConfig[hexData.objective]) {
        const objConf = objectiveConfig[hexData.objective];
        const radius = hexData.objective === "primary"
          ? TerrainLayer.STAR_PRIMARY_RADIUS
          : TerrainLayer.STAR_SECONDARY_RADIUS;
        this._drawStar(this.objectiveGraphics, center, radius, objConf.color);
      }
    }
  }

  /**
   * Draw only the changed hexes on the dynamic paint overlay.
   * Called during drag-painting instead of full drawTerrain().
   * @param {Set<string>} changedKeys - Hex keys modified in the current stroke.
   * @param {object} pendingMap - The full pending terrain map (for looking up hex data).
   */
  drawPaintOverlay(changedKeys, pendingMap) {
    this.paintGraphics.clear();
    if (!changedKeys || changedKeys.size === 0) return;

    const cache = this._ensureShapeCache();
    if (!cache) return;
    const { shape, centerX, centerY } = cache;

    const terrainConfig = CONFIG.STARMERCS?.terrain ?? {};
    const objectiveConfig = CONFIG.STARMERCS?.objectives ?? {};
    const g = this.paintGraphics;

    for (const key of changedKeys) {
      const [xStr, yStr] = key.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };
      const topLeft = { x: center.x - centerX, y: center.y - centerY };

      const rawEntry = pendingMap[key];
      if (rawEntry) {
        // Painted hex — draw overlay + road border (no label for performance)
        const hexData = normalizeHexData(rawEntry);
        const config = terrainConfig[hexData.type];
        if (!config) continue;

        this._drawHexOnGraphics(g, topLeft, shape, config.color ?? 0x888888);

        const hasRoad = hexData.road || config.hasRoad;
        if (hasRoad) {
          this._drawRoadBorderOnGraphics(g, topLeft, shape);
        }

        // Draw objective star on paint overlay
        if (hexData.objective && objectiveConfig[hexData.objective]) {
          const objConf = objectiveConfig[hexData.objective];
          const radius = hexData.objective === "primary"
            ? TerrainLayer.STAR_PRIMARY_RADIUS
            : TerrainLayer.STAR_SECONDARY_RADIUS;
          this._drawStar(g, center, radius, objConf.color);
        }
      } else {
        // Erased hex — draw dark mask to visually hide the static hex underneath
        this._drawEraseMask(g, topLeft, shape);
      }
    }
  }

  /**
   * Clear the dynamic paint overlay.
   */
  clearPaintOverlay() {
    this.paintGraphics.clear();
  }

  /**
   * Draw a brush preview highlight over the given hex centers.
   * @param {Array<{x: number, y: number}>} hexCenters - Array of hex center coordinates.
   */
  drawBrushPreview(hexCenters) {
    this.previewGraphics.clear();
    if (!hexCenters || hexCenters.length === 0) return;

    const cache = this._ensureShapeCache();
    if (!cache) return;
    const { shape, centerX, centerY } = cache;

    const g = this.previewGraphics;
    for (const center of hexCenters) {
      const topLeft = { x: center.x - centerX, y: center.y - centerY };
      g.lineStyle(2, 0xFFFF00, 0.7);
      g.beginFill(0xFFFF00, 0.2);
      g.moveTo(topLeft.x + shape[0].x, topLeft.y + shape[0].y);
      for (let i = 1; i < shape.length; i++) {
        g.lineTo(topLeft.x + shape[i].x, topLeft.y + shape[i].y);
      }
      g.closePath();
      g.endFill();
    }
  }

  /**
   * Clear the brush preview highlight.
   */
  clearBrushPreview() {
    this.previewGraphics.clear();
  }

  /* ---------------------------------------- */
  /*  Drawing Helpers                         */
  /* ---------------------------------------- */

  /**
   * Draw a filled hex polygon overlay on a given graphics object.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} topLeft - Top-left corner of the hex cell.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @param {number} color - PIXI hex color.
   * @private
   */
  _drawHexOnGraphics(g, topLeft, shape, color) {
    g.lineStyle(TerrainLayer.HEX_BORDER_WIDTH, color, TerrainLayer.HEX_BORDER_ALPHA);
    g.beginFill(color, TerrainLayer.HEX_FILL_ALPHA);
    g.moveTo(topLeft.x + shape[0].x, topLeft.y + shape[0].y);
    for (let i = 1; i < shape.length; i++) {
      g.lineTo(topLeft.x + shape[i].x, topLeft.y + shape[i].y);
    }
    g.closePath();
    g.endFill();
  }

  /**
   * Draw a black border on a hex to indicate a road on a given graphics object.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} topLeft - Top-left corner of the hex cell.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @private
   */
  _drawRoadBorderOnGraphics(g, topLeft, shape) {
    g.lineStyle(TerrainLayer.ROAD_BORDER_WIDTH, 0x000000, TerrainLayer.ROAD_BORDER_ALPHA);
    g.beginFill(0, 0);
    g.moveTo(topLeft.x + shape[0].x, topLeft.y + shape[0].y);
    for (let i = 1; i < shape.length; i++) {
      g.lineTo(topLeft.x + shape[i].x, topLeft.y + shape[i].y);
    }
    g.closePath();
    g.endFill();
  }

  /**
   * Draw a dark mask hex to visually cover an erased hex on the static layer.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} topLeft - Top-left corner of the hex cell.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @private
   */
  _drawEraseMask(g, topLeft, shape) {
    g.lineStyle(0, 0, 0);
    g.beginFill(0x12122e, TerrainLayer.ERASE_MASK_ALPHA);
    g.moveTo(topLeft.x + shape[0].x, topLeft.y + shape[0].y);
    for (let i = 1; i < shape.length; i++) {
      g.lineTo(topLeft.x + shape[i].x, topLeft.y + shape[i].y);
    }
    g.closePath();
    g.endFill();
  }

  /**
   * Draw terrain label with elevation, road, and objective indicators at a hex center.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {string} label - Terrain type label.
   * @param {number} elevation - Hex elevation (0–5).
   * @param {boolean} road - Whether the hex has a road.
   * @param {string|null} [objective=null] - Objective type ("primary", "secondary", or null).
   * @private
   */
  _drawLabel(center, label, elevation, road, objective = null) {
    const parts = [];
    if (elevation > 0) parts.push(`E:${elevation}`);
    if (road) parts.push("R");
    if (objective === "primary") parts.push("P");
    else if (objective === "secondary") parts.push("S");
    const subtitle = parts.join(" ");

    const displayText = subtitle ? `${label}\n${subtitle}` : label;

    const text = new PIXI.Text(displayText, {
      fontFamily: "Signika",
      fontSize: TerrainLayer.LABEL_FONT_SIZE,
      fill: 0xFFFFFF,
      stroke: 0x000000,
      strokeThickness: 2,
      align: "center"
    });
    text.anchor.set(0.5, 0.5);
    text.position.set(center.x, center.y);
    text.alpha = 0.7;
    this.labelContainer.addChild(text);
  }

  /**
   * Draw a 5-pointed star icon at a hex center.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {number} outerRadius - Outer radius of the star.
   * @param {number} color - PIXI hex color.
   * @private
   */
  _drawStar(g, center, outerRadius, color) {
    const innerRadius = outerRadius * TerrainLayer.STAR_INNER_RATIO;
    const points = 5;
    const step = Math.PI / points;
    const rotation = -Math.PI / 2; // Point upwards

    g.lineStyle(1, 0x000000, 0.6);
    g.beginFill(color, TerrainLayer.STAR_ALPHA);

    for (let i = 0; i < 2 * points; i++) {
      const r = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = rotation + i * step;
      const px = center.x + r * Math.cos(angle);
      const py = center.y + r * Math.sin(angle);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }

    g.closePath();
    g.endFill();
  }
}
