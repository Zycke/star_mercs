/**
 * PIXI.Container that renders terrain type overlays on hex cells.
 * Draws colored semi-transparent hex polygons for each hex that has assigned terrain.
 * Reads terrain data from the scene flag `star-mercs.terrainMap`.
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class TerrainLayer extends PIXI.Container {

  constructor() {
    super();
    /** @type {PIXI.Graphics} */
    this.terrainGraphics = new PIXI.Graphics();
    this.addChild(this.terrainGraphics);

    /** @type {PIXI.Container} */
    this.labelContainer = new PIXI.Container();
    this.addChild(this.labelContainer);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static HEX_FILL_ALPHA = 0.25;
  static HEX_BORDER_ALPHA = 0.5;
  static HEX_BORDER_WIDTH = 2;
  static LABEL_FONT_SIZE = 11;

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all terrain hex overlays from the scene's terrainMap flag.
   */
  drawTerrain() {
    this.terrainGraphics.clear();
    this.labelContainer.removeChildren();

    if (!game.settings.get("star-mercs", "showTerrainOverlay")) return;
    if (!canvas?.scene) return;

    const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap");
    if (!terrainMap || typeof terrainMap !== "object") return;

    const terrainConfig = CONFIG.STARMERCS?.terrain ?? {};
    const shape = canvas.grid.getShape();
    if (!shape || shape.length < 3) return;

    // Compute shape centroid for reliable center→top-left conversion
    const shapeCenterX = shape.reduce((sum, p) => sum + p.x, 0) / shape.length;
    const shapeCenterY = shape.reduce((sum, p) => sum + p.y, 0) / shape.length;

    for (const [key, terrainType] of Object.entries(terrainMap)) {
      const config = terrainConfig[terrainType];
      if (!config) continue;

      // Parse hex key back to coordinates
      const [xStr, yStr] = key.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };

      // Derive top-left from center minus shape centroid (self-consistent with shape vertices)
      const topLeft = { x: center.x - shapeCenterX, y: center.y - shapeCenterY };

      this._drawHexOverlay(topLeft, shape, config.color ?? 0x888888);
      this._drawLabel(center, config.label ?? terrainType);
    }
  }

  /* ---------------------------------------- */
  /*  Drawing Helpers                         */
  /* ---------------------------------------- */

  /**
   * Draw a filled hex polygon overlay.
   * @param {{x: number, y: number}} topLeft - Top-left corner of the hex cell.
   * @param {Array<{x: number, y: number}>} shape - Hex vertex offsets.
   * @param {number} color - PIXI hex color.
   * @private
   */
  _drawHexOverlay(topLeft, shape, color) {
    const g = this.terrainGraphics;
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
   * Draw a small text label at a hex center.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {string} label - Terrain type label.
   * @private
   */
  _drawLabel(center, label) {
    const text = new PIXI.Text(label, {
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
}
