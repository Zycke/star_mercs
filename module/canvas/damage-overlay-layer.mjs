/**
 * PIXI.Container that renders pending damage numbers on tokens during tactical phase.
 * Shows "-X STR / -Y RDY" text above tokens that have pending damage.
 */
export default class DamageOverlayLayer extends PIXI.Container {

  constructor() {
    super();
    /** @type {Map<string, PIXI.Text>} Token ID → PIXI.Text */
    this._labels = new Map();
  }

  /**
   * Clear and redraw damage numbers for all tokens with pending damage.
   */
  drawDamageNumbers() {
    // Remove old labels
    for (const label of this._labels.values()) {
      label.destroy();
    }
    this._labels.clear();

    if (!canvas?.tokens?.placeables) return;

    // Only show during active combat (tactical/consolidation phases)
    const combat = game.combat;
    if (!combat?.started) return;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.type !== "unit") continue;

      const pending = token.document.getFlag("star-mercs", "pendingDamage");
      if (!pending || (pending.strength === 0 && pending.readiness === 0)) continue;

      const parts = [];
      if (pending.strength > 0) parts.push(`-${pending.strength} STR`);
      if (pending.readiness > 0) parts.push(`-${pending.readiness} RDY`);
      const text = parts.join(" / ");

      const label = new PIXI.Text({
        text,
        style: {
          fontFamily: "Roboto, Segoe UI, sans-serif",
          fontSize: 14,
          fontWeight: "bold",
          fill: 0xFF4444,
          stroke: { color: 0x000000, width: 3 },
          align: "center"
        }
      });

      label.anchor.set(0.5, 1);
      label.position.set(token.center.x, token.y - 4);

      this.addChild(label);
      this._labels.set(token.id, label);
    }
  }

  /**
   * Clear all damage number labels.
   */
  clear() {
    for (const label of this._labels.values()) {
      label.destroy();
    }
    this._labels.clear();
  }
}
