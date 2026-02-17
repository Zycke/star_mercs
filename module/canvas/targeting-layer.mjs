/**
 * PIXI.Container that renders targeting arrows on the canvas.
 * Draws colored arrows from each unit's token to the tokens of its weapon targets.
 *
 * Colors are keyed by weapon attackType via CONFIG.STARMERCS.arrowColors:
 *   soft = yellow, hard = red, antiAir = purple
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class TargetingArrowLayer extends PIXI.Container {

  constructor() {
    super();
    /** @type {PIXI.Graphics} */
    this.arrowGraphics = new PIXI.Graphics();
    this.addChild(this.arrowGraphics);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static LINE_WIDTH = 3;
  static ARROWHEAD_LENGTH = 18;
  static ARROWHEAD_ANGLE = Math.PI / 6; // 30 degrees
  static ARROW_ALPHA = 0.8;
  static MULTI_ARROW_OFFSET = 6; // Perpendicular pixel offset for stacked arrows

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all targeting arrows based on current game state.
   * This is the single entry point called by all hook handlers.
   */
  drawArrows() {
    this.arrowGraphics.clear();

    // Bail if the toggle is off
    if (!game.settings.get("star-mercs", "showTargetingArrows")) return;

    // Bail if canvas or tokens not ready
    if (!canvas?.tokens?.placeables) return;

    // Collect arrow data from all tokens on the scene
    const arrowData = this._collectArrowData();

    // Draw each arrow
    for (const { attackerCenter, targetCenter, color, offset } of arrowData) {
      this._drawArrow(attackerCenter, targetCenter, color, offset);
    }
  }

  /* ---------------------------------------- */
  /*  Data Collection                         */
  /* ---------------------------------------- */

  /**
   * Iterate all tokens on the canvas, check their weapons for targetIds,
   * resolve target tokens, and return arrow descriptors.
   * @returns {Array<{attackerCenter: {x,y}, targetCenter: {x,y}, color: number, offset: number}>}
   * @private
   */
  _collectArrowData() {
    const arrows = [];
    const colors = CONFIG.STARMERCS?.arrowColors ?? {};

    for (const token of canvas.tokens.placeables) {
      const actor = token.actor;
      if (!actor) continue;

      // Group weapons by targetId to compute perpendicular offsets
      const weaponsByTarget = new Map();

      for (const item of actor.items) {
        if (item.type !== "weapon" || !item.system.targetId) continue;

        const targetId = item.system.targetId;
        if (!weaponsByTarget.has(targetId)) {
          weaponsByTarget.set(targetId, []);
        }
        weaponsByTarget.get(targetId).push(item);
      }

      for (const [targetId, weapons] of weaponsByTarget) {
        const targetToken = canvas.tokens.get(targetId);
        if (!targetToken) continue;

        // Compute perpendicular offsets for multiple arrows to same target
        const count = weapons.length;
        for (let i = 0; i < count; i++) {
          const weapon = weapons[i];
          const color = colors[weapon.system.attackType] ?? 0xFFFFFF;
          // Center the group: offsets are symmetric around zero
          const offset = count > 1
            ? (i - (count - 1) / 2) * TargetingArrowLayer.MULTI_ARROW_OFFSET
            : 0;

          arrows.push({
            attackerCenter: token.center,
            targetCenter: targetToken.center,
            color,
            offset
          });
        }
      }
    }

    return arrows;
  }

  /* ---------------------------------------- */
  /*  Arrow Drawing                           */
  /* ---------------------------------------- */

  /**
   * Draw a single arrow from attacker to target with a triangular arrowhead.
   * @param {{x: number, y: number}} from - Attacker token center
   * @param {{x: number, y: number}} to - Target token center
   * @param {number} color - Hex color for PIXI
   * @param {number} offset - Perpendicular pixel offset (for stacking)
   * @private
   */
  _drawArrow(from, to, color, offset) {
    const g = this.arrowGraphics;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1) return; // Skip zero-length arrows

    const angle = Math.atan2(dy, dx);

    // Apply perpendicular offset
    const perpX = -Math.sin(angle) * offset;
    const perpY = Math.cos(angle) * offset;

    const startX = from.x + perpX;
    const startY = from.y + perpY;
    const endX = to.x + perpX;
    const endY = to.y + perpY;

    // Arrowhead dimensions
    const headLen = TargetingArrowLayer.ARROWHEAD_LENGTH;
    const headAngle = TargetingArrowLayer.ARROWHEAD_ANGLE;

    // Line ends at the base of the arrowhead
    const lineEndX = endX - Math.cos(angle) * headLen;
    const lineEndY = endY - Math.sin(angle) * headLen;

    // Draw line
    g.lineStyle(TargetingArrowLayer.LINE_WIDTH, color, TargetingArrowLayer.ARROW_ALPHA);
    g.moveTo(startX, startY);
    g.lineTo(lineEndX, lineEndY);

    // Draw filled arrowhead triangle
    const ax = endX;
    const ay = endY;
    const bx = endX - headLen * Math.cos(angle - headAngle);
    const by = endY - headLen * Math.sin(angle - headAngle);
    const cx = endX - headLen * Math.cos(angle + headAngle);
    const cy = endY - headLen * Math.sin(angle + headAngle);

    g.lineStyle(0);
    g.beginFill(color, TargetingArrowLayer.ARROW_ALPHA);
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.lineTo(cx, cy);
    g.closePath();
    g.endFill();
  }
}
