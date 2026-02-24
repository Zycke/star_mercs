/**
 * PIXI.Container that renders comms link lines on the canvas.
 * Draws colored dotted lines between units that have direct mutual comms links.
 * Each comms chain gets a unique color from a 10-color palette.
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class CommsLinkLayer extends PIXI.Container {

  constructor() {
    super();
    /** @type {PIXI.Graphics} */
    this.linkGraphics = new PIXI.Graphics();
    this.addChild(this.linkGraphics);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static LINE_WIDTH = 2;
  static LINE_ALPHA = 0.6;
  static DASH_LENGTH = 8;
  static GAP_LENGTH = 6;

  /** Palette of distinct colors for different chains. */
  static CHAIN_COLORS = [
    0x00BFFF,  // Deep sky blue
    0x00FF7F,  // Spring green
    0xFF6347,  // Tomato
    0xFFD700,  // Gold
    0xFF69B4,  // Hot pink
    0x7B68EE,  // Medium slate blue
    0x00CED1,  // Dark turquoise
    0xFF8C00,  // Dark orange
    0x32CD32,  // Lime green
    0xBA55D3   // Medium orchid
  ];

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all comms link lines based on current game state.
   */
  drawLinks() {
    this.linkGraphics.clear();

    // Bail if the toggle is off
    if (!game.settings.get("star-mercs", "showCommsLinks")) return;

    // Bail if canvas or tokens not ready
    if (!canvas?.tokens?.placeables) return;

    const manager = game.starmercs?.commsLinkManager;
    if (!manager) return;

    manager.refresh();
    const links = manager.getDirectLinks();

    for (const { token1Id, token2Id, chainIndex } of links) {
      const t1 = canvas.tokens.get(token1Id);
      const t2 = canvas.tokens.get(token2Id);
      if (!t1 || !t2) continue;

      const color = CommsLinkLayer.CHAIN_COLORS[chainIndex % CommsLinkLayer.CHAIN_COLORS.length];
      this._drawDottedLine(t1.center, t2.center, color);
    }
  }

  /* ---------------------------------------- */
  /*  Drawing                                 */
  /* ---------------------------------------- */

  /**
   * Draw a dotted/dashed line between two points.
   * @param {{x: number, y: number}} from - Start point
   * @param {{x: number, y: number}} to - End point
   * @param {number} color - Hex color for PIXI
   * @private
   */
  _drawDottedLine(from, to, color) {
    const g = this.linkGraphics;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const totalLength = Math.sqrt(dx * dx + dy * dy);
    if (totalLength < 1) return;

    const angle = Math.atan2(dy, dx);
    const dashLen = CommsLinkLayer.DASH_LENGTH;
    const gapLen = CommsLinkLayer.GAP_LENGTH;
    const segmentLen = dashLen + gapLen;

    g.lineStyle(CommsLinkLayer.LINE_WIDTH, color, CommsLinkLayer.LINE_ALPHA);

    let traveled = 0;
    while (traveled < totalLength) {
      const dashEnd = Math.min(traveled + dashLen, totalLength);
      const sx = from.x + Math.cos(angle) * traveled;
      const sy = from.y + Math.sin(angle) * traveled;
      const ex = from.x + Math.cos(angle) * dashEnd;
      const ey = from.y + Math.sin(angle) * dashEnd;

      g.moveTo(sx, sy);
      g.lineTo(ex, ey);

      traveled += segmentLen;
    }
  }
}
