import { normalizeHexData, getAdjacentHexCenters, hexKey } from "../hex-utils.mjs";

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

  static HEX_FILL_ALPHA = 0.35;
  static HEX_BORDER_ALPHA = 0.5;
  static HEX_BORDER_WIDTH = 2;
  static ROAD_COLOR = 0x000000;
  static ROAD_LINE_WIDTH = 2;
  static ROAD_LINE_ALPHA = 0.7;
  static ROAD_DOT_RADIUS = 3;
  static ERASE_MASK_ALPHA = 0.6;
  static LABEL_FONT_SIZE = 10;
  static STAR_PRIMARY_RADIUS = 14;
  static STAR_SECONDARY_RADIUS = 10;
  static STAR_INNER_RATIO = 0.4;
  static STAR_ALPHA = 0.9;
  static STAR_VERTICAL_OFFSET = 14;

  // Pattern constants
  static PATTERN_LINE_WIDTH = 1;
  static PATTERN_ALPHA = 0.35;
  static PATTERN_SPACING = 10;
  static PATTERN_DOT_RADIUS = 2;

  // Group border constants
  static GROUP_BORDER_INNER_WIDTH = 1;
  static GROUP_BORDER_INNER_ALPHA = 0.15;
  static GROUP_BORDER_OUTER_WIDTH = 3;
  static GROUP_BORDER_OUTER_ALPHA = 0.7;

  // Elevation contour constants
  static CONTOUR_COLOR = 0x654321;
  static CONTOUR_WIDTH = 2;
  static CONTOUR_HEAVY_WIDTH = 3;
  static CONTOUR_ALPHA = 0.7;

  /* ---------------------------------------- */
  /*  Shape Cache                             */
  /* ---------------------------------------- */

  /**
   * Get the cached hex shape and centroid, computing if needed.
   * Also precomputes edge outward direction unit vectors for neighbor matching.
   * @returns {{shape: Array, centerX: number, centerY: number, edgeOutwardDirs: Array}|null}
   * @private
   */
  _ensureShapeCache() {
    if (this._cachedShape) return this._cachedShape;
    const shape = canvas.grid.getShape();
    if (!shape || shape.length < 3) return null;
    const centerX = shape.reduce((sum, p) => sum + p.x, 0) / shape.length;
    const centerY = shape.reduce((sum, p) => sum + p.y, 0) / shape.length;

    // Precompute unit outward direction for each edge (midpoint direction from centroid)
    const edgeOutwardDirs = [];
    for (let i = 0; i < shape.length; i++) {
      const next = (i + 1) % shape.length;
      const mx = (shape[i].x + shape[next].x) / 2 - centerX;
      const my = (shape[i].y + shape[next].y) / 2 - centerY;
      const len = Math.sqrt(mx * mx + my * my);
      edgeOutwardDirs.push(len > 0 ? { x: mx / len, y: my / len } : { x: 0, y: 0 });
    }

    this._cachedShape = { shape, centerX, centerY, edgeOutwardDirs };
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
    const { shape, centerX, centerY, edgeOutwardDirs } = cache;

    const terrainConfig = CONFIG.STARMERCS?.terrain ?? {};
    const objectiveConfig = CONFIG.STARMERCS?.objectives ?? {};

    // Pre-build lookup maps for terrain group borders, contour lines, and road network
    const typeByKey = new Map();
    const elevByKey = new Map();
    const roadByKey = new Set();
    for (const [key, rawEntry] of Object.entries(terrainMap)) {
      const hexData = normalizeHexData(rawEntry);
      typeByKey.set(key, hexData.type);
      elevByKey.set(key, hexData.elevation ?? 0);
      if (hexData.road || terrainConfig[hexData.type]?.hasRoad) roadByKey.add(key);
    }

    for (const [key, rawEntry] of Object.entries(terrainMap)) {
      const hexData = normalizeHexData(rawEntry);
      const config = terrainConfig[hexData.type];
      if (!config) continue;

      const [xStr, yStr] = key.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };
      const topLeft = { x: center.x - centerX, y: center.y - centerY };
      const color = config.color ?? 0x888888;
      const elevation = hexData.elevation ?? 0;

      // Draw hex fill with terrain group borders (bold at terrain transitions, thin within groups)
      this._drawHexWithGroupBorders(
        this.terrainGraphics, topLeft, shape, color,
        center, hexData.type, elevation,
        typeByKey, elevByKey, edgeOutwardDirs
      );

      // Draw fill pattern
      const pattern = config.pattern ?? "none";
      if (pattern !== "none") {
        this._drawPatternOnHex(this.terrainGraphics, topLeft, shape, pattern, color);
      }

      this._drawLabel(center, config.label ?? hexData.type, elevation, hexData.objective);

      // Draw objective star icon (offset below label)
      if (hexData.objective && objectiveConfig[hexData.objective]) {
        const objConf = objectiveConfig[hexData.objective];
        const radius = hexData.objective === "primary"
          ? TerrainLayer.STAR_PRIMARY_RADIUS
          : TerrainLayer.STAR_SECONDARY_RADIUS;
        const starCenter = { x: center.x, y: center.y + TerrainLayer.STAR_VERTICAL_OFFSET };
        this._drawStar(this.objectiveGraphics, starCenter, radius, objConf.color);
      }
    }

    // Draw road network lines (second pass — renders on top of all terrain fills/patterns)
    this._drawRoadNetwork(this.terrainGraphics, roadByKey, shape, centerX, centerY, edgeOutwardDirs);
  }

  /**
   * Draw only the changed hexes on the dynamic paint overlay.
   * Called during drag-painting instead of full drawTerrain().
   * Uses simple per-hex borders for performance (no group border computation).
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
        // Painted hex — draw overlay + pattern + road border (no label for performance)
        const hexData = normalizeHexData(rawEntry);
        const config = terrainConfig[hexData.type];
        if (!config) continue;

        const color = config.color ?? 0x888888;
        this._drawHexOnGraphics(g, topLeft, shape, color);

        // Draw fill pattern on paint overlay too
        const pattern = config.pattern ?? "none";
        if (pattern !== "none") {
          this._drawPatternOnHex(g, topLeft, shape, pattern, color);
        }

        // Draw road lines for this hex during paint overlay
        const hasRoad = hexData.road || config.hasRoad;
        if (hasRoad) {
          this._drawRoadLinesForHex(g, center, shape, centerX, centerY, cache.edgeOutwardDirs, (nKey) => {
            const nEntry = pendingMap[nKey];
            if (!nEntry) return false;
            const nData = normalizeHexData(nEntry);
            const nConfig = terrainConfig[nData.type];
            return nData.road || nConfig?.hasRoad || false;
          });
        }

        // Draw objective star on paint overlay (offset below center)
        if (hexData.objective && objectiveConfig[hexData.objective]) {
          const objConf = objectiveConfig[hexData.objective];
          const radius = hexData.objective === "primary"
            ? TerrainLayer.STAR_PRIMARY_RADIUS
            : TerrainLayer.STAR_SECONDARY_RADIUS;
          const starCenter = { x: center.x, y: center.y + TerrainLayer.STAR_VERTICAL_OFFSET };
          this._drawStar(g, starCenter, radius, objConf.color);
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
   * Draw a filled hex polygon overlay on a given graphics object (simple borders).
   * Used by the paint overlay for performance during drag.
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
   * Draw a hex fill with terrain group borders — bold at terrain type transitions,
   * thin within same-type groups. Also draws elevation contour lines.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} topLeft - Top-left corner of the hex cell.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @param {number} color - PIXI hex color.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {string} terrainType - Terrain type key.
   * @param {number} elevation - Hex elevation value.
   * @param {Map<string, string>} typeByKey - Map of hex keys to terrain types.
   * @param {Map<string, number>} elevByKey - Map of hex keys to elevation values.
   * @param {Array<{x: number, y: number}>} edgeOutwardDirs - Precomputed outward unit vectors per edge.
   * @private
   */
  _drawHexWithGroupBorders(g, topLeft, shape, color, center, terrainType, elevation, typeByKey, elevByKey, edgeOutwardDirs) {
    // Build absolute vertex positions
    const absVerts = shape.map(p => ({ x: topLeft.x + p.x, y: topLeft.y + p.y }));

    // Draw hex fill with no border
    g.lineStyle(0);
    g.beginFill(color, TerrainLayer.HEX_FILL_ALPHA);
    g.moveTo(absVerts[0].x, absVerts[0].y);
    for (let i = 1; i < absVerts.length; i++) {
      g.lineTo(absVerts[i].x, absVerts[i].y);
    }
    g.closePath();
    g.endFill();

    // Get neighbors for this hex
    const neighbors = getAdjacentHexCenters(center);

    // Match each neighbor to an edge via dot product with edge outward direction
    const neighborKeyByEdge = new Array(shape.length).fill(null);
    for (let edgeIdx = 0; edgeIdx < shape.length; edgeIdx++) {
      const dir = edgeOutwardDirs[edgeIdx];
      let bestKey = null;
      let bestDot = -Infinity;
      for (const n of neighbors) {
        const dx = n.x - center.x;
        const dy = n.y - center.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        const dot = (dx / len) * dir.x + (dy / len) * dir.y;
        if (dot > bestDot) {
          bestDot = dot;
          bestKey = hexKey(n);
        }
      }
      neighborKeyByEdge[edgeIdx] = bestKey;
    }

    // Draw each edge with appropriate weight based on terrain type match
    for (let edgeIdx = 0; edgeIdx < shape.length; edgeIdx++) {
      const nKey = neighborKeyByEdge[edgeIdx];
      const neighborType = nKey ? (typeByKey.get(nKey) ?? null) : null;
      const v1 = absVerts[edgeIdx];
      const v2 = absVerts[(edgeIdx + 1) % absVerts.length];

      if (neighborType === terrainType) {
        // Same terrain — thin, faded border
        g.lineStyle(TerrainLayer.GROUP_BORDER_INNER_WIDTH, color, TerrainLayer.GROUP_BORDER_INNER_ALPHA);
      } else {
        // Different terrain or empty — bold border
        g.lineStyle(TerrainLayer.GROUP_BORDER_OUTER_WIDTH, color, TerrainLayer.GROUP_BORDER_OUTER_ALPHA);
      }
      g.moveTo(v1.x, v1.y);
      g.lineTo(v2.x, v2.y);

      // Elevation contour lines
      const neighborElev = nKey ? (elevByKey.get(nKey) ?? 0) : 0;
      if (neighborElev !== elevation) {
        const diff = Math.abs(neighborElev - elevation);
        const contourWidth = diff >= 2 ? TerrainLayer.CONTOUR_HEAVY_WIDTH : TerrainLayer.CONTOUR_WIDTH;
        g.lineStyle(contourWidth, TerrainLayer.CONTOUR_COLOR, TerrainLayer.CONTOUR_ALPHA);
        g.moveTo(v1.x, v1.y);
        g.lineTo(v2.x, v2.y);
      }
    }
  }

  /**
   * Draw the full road network — lines from each road hex center to edge midpoints
   * facing adjacent road hexes, forming a connected road graph.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {Set<string>} roadByKey - Set of hex keys that have roads.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @param {number} centerX - Shape centroid X offset.
   * @param {number} centerY - Shape centroid Y offset.
   * @param {Array<{x: number, y: number}>} edgeOutwardDirs - Precomputed outward unit vectors per edge.
   * @private
   */
  _drawRoadNetwork(g, roadByKey, shape, centerX, centerY, edgeOutwardDirs) {
    for (const key of roadByKey) {
      const [xStr, yStr] = key.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };
      this._drawRoadLinesForHex(g, center, shape, centerX, centerY, edgeOutwardDirs, (nKey) => roadByKey.has(nKey));
    }
  }

  /**
   * Draw road lines for a single hex — from center to edge midpoints facing road neighbors.
   * If isolated (no adjacent roads), draws a small circle at center.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @param {number} centerX - Shape centroid X offset.
   * @param {number} centerY - Shape centroid Y offset.
   * @param {Array<{x: number, y: number}>} edgeOutwardDirs - Precomputed outward unit vectors per edge.
   * @param {function(string): boolean} isRoad - Predicate: does the given hex key have a road?
   * @private
   */
  _drawRoadLinesForHex(g, center, shape, centerX, centerY, edgeOutwardDirs, isRoad) {
    const topLeft = { x: center.x - centerX, y: center.y - centerY };
    const neighbors = getAdjacentHexCenters(center);

    // Match each neighbor to an edge via dot product
    let connectedEdges = 0;
    const edgeMidpoints = [];
    for (let edgeIdx = 0; edgeIdx < shape.length; edgeIdx++) {
      const dir = edgeOutwardDirs[edgeIdx];
      let bestKey = null;
      let bestDot = -Infinity;
      for (const n of neighbors) {
        const dx = n.x - center.x;
        const dy = n.y - center.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        const dot = (dx / len) * dir.x + (dy / len) * dir.y;
        if (dot > bestDot) {
          bestDot = dot;
          bestKey = hexKey(n);
        }
      }
      if (bestKey && isRoad(bestKey)) {
        const next = (edgeIdx + 1) % shape.length;
        const midX = topLeft.x + (shape[edgeIdx].x + shape[next].x) / 2;
        const midY = topLeft.y + (shape[edgeIdx].y + shape[next].y) / 2;
        edgeMidpoints.push({ x: midX, y: midY });
        connectedEdges++;
      }
    }

    g.lineStyle(TerrainLayer.ROAD_LINE_WIDTH, TerrainLayer.ROAD_COLOR, TerrainLayer.ROAD_LINE_ALPHA);

    if (connectedEdges === 0) {
      // Isolated road hex — draw a small circle indicator at center
      g.lineStyle(0);
      g.beginFill(TerrainLayer.ROAD_COLOR, TerrainLayer.ROAD_LINE_ALPHA);
      g.drawCircle(center.x, center.y, TerrainLayer.ROAD_DOT_RADIUS);
      g.endFill();
    } else {
      // Draw lines from center to each connected edge midpoint
      for (const mid of edgeMidpoints) {
        g.moveTo(center.x, center.y);
        g.lineTo(mid.x, mid.y);
      }
    }
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

  /* ---------------------------------------- */
  /*  Pattern Drawing                         */
  /* ---------------------------------------- */

  /**
   * Draw a fill pattern inside a hex polygon.
   * @param {PIXI.Graphics} g - Target graphics object.
   * @param {{x: number, y: number}} topLeft - Top-left corner of the hex cell.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @param {string} patternType - Pattern type: "dots", "horizontal", "diagonal", "crosshatch", "wave", "chevron", "zigzag".
   * @param {number} color - PIXI hex color for pattern lines/dots.
   * @private
   */
  _drawPatternOnHex(g, topLeft, shape, patternType, color) {
    // Build absolute polygon vertices
    const poly = shape.map(p => ({ x: topLeft.x + p.x, y: topLeft.y + p.y }));

    // Compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const spacing = TerrainLayer.PATTERN_SPACING;
    const lw = TerrainLayer.PATTERN_LINE_WIDTH;
    const alpha = TerrainLayer.PATTERN_ALPHA;

    switch (patternType) {
      case "dots":
        this._drawDotsPattern(g, poly, minX, minY, maxX, maxY, spacing, color, alpha);
        break;
      case "horizontal":
        this._drawHorizontalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        break;
      case "diagonal":
        this._drawDiagonalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        break;
      case "crosshatch":
        this._drawDiagonalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        this._drawAntiDiagonalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        break;
      case "wave":
        this._drawWavePattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        break;
      case "chevron":
        this._drawChevronPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        break;
      case "zigzag":
        this._drawZigzagPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha);
        break;
    }
  }

  /**
   * Draw scattered dot pattern inside hex.
   * @private
   */
  _drawDotsPattern(g, poly, minX, minY, maxX, maxY, spacing, color, alpha) {
    g.lineStyle(0);
    g.beginFill(color, alpha);
    const r = TerrainLayer.PATTERN_DOT_RADIUS;
    for (let x = minX + spacing / 2; x <= maxX; x += spacing) {
      for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
        if (this._pointInPolygon(x, y, poly)) {
          g.drawCircle(x, y, r);
        }
      }
    }
    g.endFill();
  }

  /**
   * Draw horizontal line pattern inside hex.
   * @private
   */
  _drawHorizontalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha) {
    g.lineStyle(lw, color, alpha);
    for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
      const clipped = this._clipLineToHex(minX, y, maxX, y, poly);
      if (clipped) {
        g.moveTo(clipped.x1, clipped.y1);
        g.lineTo(clipped.x2, clipped.y2);
      }
    }
  }

  /**
   * Draw diagonal (top-left to bottom-right, 45 degrees) line pattern inside hex.
   * @private
   */
  _drawDiagonalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha) {
    g.lineStyle(lw, color, alpha);
    const rangeStart = minX + minY;
    const rangeEnd = maxX + maxY;
    for (let c = rangeStart + spacing; c <= rangeEnd; c += spacing) {
      // Line: x + y = c  →  y = c - x
      const lx1 = minX;
      const ly1 = c - minX;
      const lx2 = maxX;
      const ly2 = c - maxX;
      const clipped = this._clipLineToHex(lx1, ly1, lx2, ly2, poly);
      if (clipped) {
        g.moveTo(clipped.x1, clipped.y1);
        g.lineTo(clipped.x2, clipped.y2);
      }
    }
  }

  /**
   * Draw anti-diagonal (top-right to bottom-left, 135 degrees) line pattern inside hex.
   * @private
   */
  _drawAntiDiagonalPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha) {
    g.lineStyle(lw, color, alpha);
    const rangeStart = minX - maxY;
    const rangeEnd = maxX - minY;
    for (let c = rangeStart + spacing; c <= rangeEnd; c += spacing) {
      // Line: x - y = c  →  y = x - c
      const lx1 = minX;
      const ly1 = minX - c;
      const lx2 = maxX;
      const ly2 = maxX - c;
      const clipped = this._clipLineToHex(lx1, ly1, lx2, ly2, poly);
      if (clipped) {
        g.moveTo(clipped.x1, clipped.y1);
        g.lineTo(clipped.x2, clipped.y2);
      }
    }
  }

  /**
   * Draw wavy horizontal line pattern inside hex.
   * @private
   */
  _drawWavePattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha) {
    g.lineStyle(lw, color, alpha);
    const amplitude = 2;
    const wavelength = 8;
    const step = 2;
    for (let baseY = minY + spacing / 2; baseY <= maxY; baseY += spacing) {
      let started = false;
      for (let x = minX; x <= maxX; x += step) {
        const y = baseY + amplitude * Math.sin((x - minX) * 2 * Math.PI / wavelength);
        if (this._pointInPolygon(x, y, poly)) {
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else {
            g.lineTo(x, y);
          }
        } else {
          started = false;
        }
      }
    }
  }

  /**
   * Draw chevron (V-shape) pattern inside hex to indicate flow direction.
   * @private
   */
  _drawChevronPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha) {
    g.lineStyle(lw, color, alpha);
    const chevronSize = 3;
    for (let x = minX + spacing / 2; x <= maxX; x += spacing) {
      for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
        if (this._pointInPolygon(x, y, poly)) {
          // Draw a small V shape pointing down
          const lx = x - chevronSize;
          const rx = x + chevronSize;
          const topY = y - chevronSize;
          const botY = y;
          if (this._pointInPolygon(lx, topY, poly) && this._pointInPolygon(rx, topY, poly)) {
            g.moveTo(lx, topY);
            g.lineTo(x, botY);
            g.lineTo(rx, topY);
          }
        }
      }
    }
  }

  /**
   * Draw zigzag (mountain peak) pattern inside hex.
   * @private
   */
  _drawZigzagPattern(g, poly, minX, minY, maxX, maxY, spacing, color, lw, alpha) {
    g.lineStyle(lw, color, alpha);
    const peakHeight = 4;
    const peakWidth = 6;
    for (let baseY = minY + spacing; baseY <= maxY; baseY += spacing) {
      let started = false;
      for (let x = minX; x <= maxX; x += peakWidth) {
        const midX = x + peakWidth / 2;
        const peakY = baseY - peakHeight;
        const baseEndX = x + peakWidth;

        // Draw upslope
        if (this._pointInPolygon(x, baseY, poly) && this._pointInPolygon(midX, peakY, poly)) {
          if (!started) {
            g.moveTo(x, baseY);
            started = true;
          } else {
            g.lineTo(x, baseY);
          }
          g.lineTo(midX, peakY);
        } else {
          started = false;
          continue;
        }

        // Draw downslope
        if (this._pointInPolygon(baseEndX, baseY, poly)) {
          g.lineTo(baseEndX, baseY);
        } else {
          started = false;
        }
      }
    }
  }

  /* ---------------------------------------- */
  /*  Geometry Helpers                        */
  /* ---------------------------------------- */

  /**
   * Test if a point is inside a convex polygon.
   * @param {number} px - Point X.
   * @param {number} py - Point Y.
   * @param {Array<{x: number, y: number}>} polygon - Convex polygon vertices.
   * @returns {boolean}
   * @private
   */
  _pointInPolygon(px, py, polygon) {
    const n = polygon.length;
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const cross = (polygon[j].x - polygon[i].x) * (py - polygon[i].y)
                   - (polygon[j].y - polygon[i].y) * (px - polygon[i].x);
      if (cross > 0) {
        if (sign < 0) return false;
        sign = 1;
      } else if (cross < 0) {
        if (sign > 0) return false;
        sign = -1;
      }
    }
    return true;
  }

  /**
   * Clip a line segment to a convex polygon. Returns the clipped segment or null.
   * @param {number} x1 - Line start X.
   * @param {number} y1 - Line start Y.
   * @param {number} x2 - Line end X.
   * @param {number} y2 - Line end Y.
   * @param {Array<{x: number, y: number}>} polygon - Convex polygon vertices.
   * @returns {{x1: number, y1: number, x2: number, y2: number}|null}
   * @private
   */
  _clipLineToHex(x1, y1, x2, y2, polygon) {
    let tMin = 0;
    let tMax = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;

    const n = polygon.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // Edge normal (inward for CCW polygon)
      const ex = polygon[j].x - polygon[i].x;
      const ey = polygon[j].y - polygon[i].y;
      const nx = -ey;
      const ny = ex;

      const denom = nx * dx + ny * dy;
      const num = nx * (x1 - polygon[i].x) + ny * (y1 - polygon[i].y);

      if (Math.abs(denom) < 1e-10) {
        // Line parallel to edge
        if (num < 0) return null; // Outside
      } else {
        const t = -num / denom;
        if (denom < 0) {
          // Entering half-plane
          if (t > tMin) tMin = t;
        } else {
          // Leaving half-plane
          if (t < tMax) tMax = t;
        }
        if (tMin > tMax) return null;
      }
    }

    if (tMin > tMax) return null;
    return {
      x1: x1 + dx * tMin,
      y1: y1 + dy * tMin,
      x2: x1 + dx * tMax,
      y2: y1 + dy * tMax
    };
  }

  /* ---------------------------------------- */
  /*  Label & Star Drawing                    */
  /* ---------------------------------------- */

  /**
   * Draw terrain label with elevation and objective indicators at a hex center.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {string} label - Terrain type label.
   * @param {number} elevation - Hex elevation (0–5).
   * @param {string|null} [objective=null] - Objective type ("primary", "secondary", or null).
   * @private
   */
  _drawLabel(center, label, elevation, objective = null) {
    const parts = [];
    if (elevation > 0) parts.push(`E:${elevation}`);
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
