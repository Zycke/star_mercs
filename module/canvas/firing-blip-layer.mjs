/**
 * PIXI.Container that renders hex-anchored firing blips on the canvas.
 *
 * When a completely hidden unit fires, a red "!" blip appears at that hex,
 * visible only to the opposing team. Blips show the round they were created
 * and can be clicked to dismiss by the team that sees them.
 *
 * Data stored in scene flag `star-mercs.firingBlips` as an array of:
 *   { id, hexKey, createdRound, visibleTo }
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class FiringBlipLayer extends PIXI.Container {

  constructor() {
    super();

    /** @type {PIXI.Container} — holds individual blip groups */
    this.blipContainer = new PIXI.Container();
    this.addChild(this.blipContainer);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static BLIP_COLOR = 0xFF0000;
  static BLIP_BG_COLOR = 0x000000;
  static BLIP_BG_ALPHA = 0.5;
  static BLIP_BG_RADIUS = 12;
  static BLIP_FONT_SIZE = 20;
  static BLIP_ROUND_FONT_SIZE = 9;
  static BLIP_ROUND_OFFSET_Y = 14;

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all firing blips for the current viewer.
   */
  drawFiringBlips() {
    this.blipContainer.removeChildren();

    const blips = canvas.scene?.getFlag("star-mercs", "firingBlips") ?? [];
    if (!blips.length) return;

    const isGM = game.user.isGM;
    const myTeam = this._getViewerTeam();

    // Non-GM players without a team see nothing
    if (!isGM && !myTeam) return;

    for (const blip of blips) {
      // Filter: players only see blips for their team; GM sees all
      if (!isGM && blip.visibleTo !== myTeam) continue;

      const [xStr, yStr] = blip.hexKey.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };

      this._drawSingleBlip(center, blip, isGM);
    }
  }

  /* ---------------------------------------- */
  /*  Static Helpers                          */
  /* ---------------------------------------- */

  /**
   * Create a new firing blip at an attacker's hex.
   * Deduplicates: same hex + same team + same round = one blip.
   * @param {Token} attackerToken - The token that fired.
   * @param {string} opposingTeam - Team key that can see this blip.
   * @returns {Promise<void>}
   */
  static async createFiringBlip(attackerToken, opposingTeam) {
    if (!canvas.scene) return;

    const { snapToHexCenter, hexKey } = await import("../hex-utils.mjs");
    const hexCenter = snapToHexCenter(attackerToken.center);
    const key = hexKey(hexCenter);
    const currentRound = game.combat?.round ?? 1;

    const existing = canvas.scene.getFlag("star-mercs", "firingBlips") ?? [];

    // Deduplicate: same hex + same team + same round
    const isDuplicate = existing.some(
      b => b.hexKey === key && b.visibleTo === opposingTeam && b.createdRound === currentRound
    );
    if (isDuplicate) return;

    const blip = {
      id: foundry.utils.randomID(),
      hexKey: key,
      createdRound: currentRound,
      visibleTo: opposingTeam
    };

    existing.push(blip);
    await canvas.scene.setFlag("star-mercs", "firingBlips", existing);
  }

  /**
   * Remove a firing blip by ID.
   * @param {string} blipId - The blip's unique ID.
   * @returns {Promise<void>}
   */
  static async removeFiringBlip(blipId) {
    if (!canvas.scene) return;
    const existing = canvas.scene.getFlag("star-mercs", "firingBlips") ?? [];
    const updated = existing.filter(b => b.id !== blipId);
    await canvas.scene.setFlag("star-mercs", "firingBlips", updated);
  }

  /**
   * Clear all firing blips from the scene.
   * @returns {Promise<void>}
   */
  static async clearAllFiringBlips() {
    if (!canvas.scene) return;
    await canvas.scene.unsetFlag("star-mercs", "firingBlips");
  }

  /* ---------------------------------------- */
  /*  Drawing Helpers                         */
  /* ---------------------------------------- */

  /**
   * Get the current viewer's team key.
   * @returns {string|null} Team key ("a" or "b") or null for spectators.
   * @private
   */
  _getViewerTeam() {
    const enabled = game.settings.get("star-mercs", "teamAssignmentsEnabled");
    if (!enabled) return null;
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const team = assignments[game.user.id];
    return (team && team !== "spectator") ? team : null;
  }

  /**
   * Draw a single firing blip at a hex center.
   * @param {{x: number, y: number}} center - Hex center coordinates.
   * @param {object} blip - The blip data object.
   * @param {boolean} isGM - Whether the viewer is a GM.
   * @private
   */
  _drawSingleBlip(center, blip, isGM) {
    const group = new PIXI.Container();
    group.position.set(center.x, center.y);

    // Dark circle background
    const bg = new PIXI.Graphics();
    bg.beginFill(FiringBlipLayer.BLIP_BG_COLOR, FiringBlipLayer.BLIP_BG_ALPHA);
    bg.drawCircle(0, 0, FiringBlipLayer.BLIP_BG_RADIUS);
    bg.endFill();
    group.addChild(bg);

    // Red "!" symbol
    const symbol = new PIXI.Text("!", {
      fontFamily: "Signika",
      fontSize: FiringBlipLayer.BLIP_FONT_SIZE,
      fill: FiringBlipLayer.BLIP_COLOR,
      stroke: 0x000000,
      strokeThickness: 3,
      fontWeight: "bold",
      align: "center"
    });
    symbol.anchor.set(0.5, 0.5);
    symbol.position.set(0, 0);
    group.addChild(symbol);

    // Round number text below
    let roundLabel = `R:${blip.createdRound}`;
    if (isGM) {
      // GM sees which team the blip is for
      roundLabel += ` (${blip.visibleTo.toUpperCase()})`;
    }
    const roundText = new PIXI.Text(roundLabel, {
      fontFamily: "Signika",
      fontSize: FiringBlipLayer.BLIP_ROUND_FONT_SIZE,
      fill: 0xFFFFFF,
      stroke: 0x000000,
      strokeThickness: 2,
      align: "center"
    });
    roundText.anchor.set(0.5, 0);
    roundText.position.set(0, FiringBlipLayer.BLIP_ROUND_OFFSET_Y);
    group.addChild(roundText);

    // Make interactive for dismissal
    group.eventMode = "static";
    group.cursor = "pointer";
    group.on("pointerdown", async (event) => {
      event.stopPropagation();

      // GM can dismiss any blip; players can only dismiss blips for their team
      const myTeam = this._getViewerTeam();
      if (!game.user.isGM && blip.visibleTo !== myTeam) return;

      await FiringBlipLayer.removeFiringBlip(blip.id);
    });

    this.blipContainer.addChild(group);
  }
}
