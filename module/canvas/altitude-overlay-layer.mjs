/**
 * PIXI.Container that renders altitude numbers on flying unit tokens.
 * Shows a small green number in the upper-right corner of the token.
 */
export default class AltitudeOverlayLayer extends PIXI.Container {

  constructor() {
    super();
    /** @type {Map<string, PIXI.Text>} Token ID → PIXI.Text */
    this._labels = new Map();
    // Ensure altitude labels render above tokens
    this.zIndex = 1000;
  }

  /**
   * Clear and redraw altitude labels for all flying unit tokens.
   */
  drawAltitudeLabels() {
    // Remove old labels
    for (const label of this._labels.values()) {
      this.removeChild(label);
      label.destroy();
    }
    this._labels.clear();

    if (!canvas?.tokens?.placeables) return;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.type !== "unit") continue;
      if (!token.actor.hasTrait("Flying")) continue;

      // Landed units show nothing (they're on the ground)
      if (token.actor.getFlag("star-mercs", "landed")) continue;

      // Skip hidden tokens for non-GM users
      if (token.document?.hidden && !game.user.isGM) continue;

      // Skip unrevealed enemy flying units for non-GM users
      if (!game.user.isGM) {
        const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
        const viewerTeam = assignments[game.user.id] ?? "a";
        const tokenTeam = token.actor?.system?.team ?? "a";
        if (tokenTeam !== viewerTeam) {
          if (!token.document?.hasStatusEffect?.("revealed")) continue;
        }
      }

      const altitude = token.actor.getFlag("star-mercs", "altitude") ?? 0;

      const label = new PIXI.Text(`${altitude}`, {
        fontFamily: "Roboto, Segoe UI, sans-serif",
        fontSize: 16,
        fontWeight: "bold",
        fill: 0x44DD44,
        stroke: 0x000000,
        strokeThickness: 3,
        align: "center"
      });

      // Position in the upper-right corner of the token
      label.anchor.set(1, 0);
      const tokenBounds = token.bounds;
      label.position.set(tokenBounds.right - 2, tokenBounds.top + 2);

      this.addChild(label);
      this._labels.set(token.id, label);
    }
  }

  /**
   * Clear all altitude labels.
   */
  clear() {
    for (const label of this._labels.values()) {
      this.removeChild(label);
      label.destroy();
    }
    this._labels.clear();
  }
}
