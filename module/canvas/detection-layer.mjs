import { snapToHexCenter, hexKey, getAdjacentHexCenters } from "../hex-utils.mjs";
import * as detection from "../detection.mjs";

/**
 * PIXI.Container that renders detection-related overlays on the canvas.
 *
 * Features:
 * 1. Detection range rings for the selected friendly token (faint hex outlines)
 * 2. Blip markers ("?") at positions where enemies are at blip detection level
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class DetectionLayer extends PIXI.Container {

  constructor() {
    super();
    /** @type {PIXI.Graphics} */
    this.rangeGraphics = new PIXI.Graphics();
    this.addChild(this.rangeGraphics);

    /** @type {PIXI.Container} */
    this.blipContainer = new PIXI.Container();
    this.addChild(this.blipContainer);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static RANGE_RING_COLOR = 0x00CCFF;
  static RANGE_RING_ALPHA = 0.3;
  static RANGE_RING_WIDTH = 2;
  static BLIP_COLOR = 0xFF6600;
  static BLIP_FONT_SIZE = 24;

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all detection overlays.
   */
  drawDetection() {
    this.rangeGraphics.clear();
    this.blipContainer.removeChildren();

    if (!game.settings.get("star-mercs", "showDetectionOverlay")) return;
    if (!canvas?.tokens?.placeables) return;

    // Only draw blips for non-GM users with team enforcement
    const enabled = game.settings.get("star-mercs", "teamAssignmentsEnabled");
    if (!game.user.isGM && enabled) {
      this._drawBlipMarkers();
    }

    // Draw detection range ring for the controlled token (any user)
    this._drawDetectionRangeRing();
  }

  /* ---------------------------------------- */
  /*  Blip Markers                            */
  /* ---------------------------------------- */

  /**
   * Draw "?" blip markers for enemy tokens at blip detection level.
   * @private
   */
  _drawBlipMarkers() {
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const myTeam = assignments[game.user.id];
    if (!myTeam || myTeam === "spectator") return;

    const visMap = detection.computeTeamVisibility(myTeam);

    for (const [tokenId, level] of visMap) {
      if (level !== "blip") continue;

      const token = canvas.tokens.get(tokenId);
      if (!token) continue;

      const text = new PIXI.Text("?", {
        fontFamily: "Signika",
        fontSize: DetectionLayer.BLIP_FONT_SIZE,
        fill: DetectionLayer.BLIP_COLOR,
        stroke: 0x000000,
        strokeThickness: 3,
        fontWeight: "bold",
        align: "center"
      });
      text.anchor.set(0.5, 0.5);
      text.position.set(token.center.x, token.center.y);
      this.blipContainer.addChild(text);
    }
  }

  /* ---------------------------------------- */
  /*  Detection Range Ring                    */
  /* ---------------------------------------- */

  /**
   * Draw a faint hex ring showing the detection range of the currently controlled token.
   * @private
   */
  _drawDetectionRangeRing() {
    const controlled = canvas.tokens.controlled;
    if (!controlled?.length) return;

    const token = controlled[0];
    if (!token?.actor || token.actor.type !== "unit") return;

    const sensors = token.actor.system.sensors ?? 0;
    const defaultSig = 2; // Show range against a standard signature-2 target
    const detRange = sensors + defaultSig;
    if (detRange <= 0) return;

    const g = this.rangeGraphics;
    const shape = canvas.grid.getShape();
    if (!shape || shape.length < 3) return;

    const center = snapToHexCenter(token.center);

    // BFS flood-fill to find all hex centers within detection range
    const visited = new Set();
    visited.add(hexKey(center));
    let frontier = [center];
    const allInRange = [center];

    for (let d = 0; d < detRange; d++) {
      const nextFrontier = [];
      for (const hex of frontier) {
        const neighbors = getAdjacentHexCenters(hex);
        for (const n of neighbors) {
          const k = hexKey(n);
          if (visited.has(k)) continue;
          visited.add(k);
          nextFrontier.push(n);
          allInRange.push(n);
        }
      }
      frontier = nextFrontier;
    }

    // The "ring" = outermost layer (frontier from last BFS step)
    // Draw subtle fill on frontier hexes
    g.lineStyle(DetectionLayer.RANGE_RING_WIDTH, DetectionLayer.RANGE_RING_COLOR, DetectionLayer.RANGE_RING_ALPHA);
    for (const hex of frontier) {
      const topLeft = canvas.grid.getTopLeftPoint(hex);
      g.beginFill(DetectionLayer.RANGE_RING_COLOR, 0.05);
      g.moveTo(topLeft.x + shape[0].x, topLeft.y + shape[0].y);
      for (let i = 1; i < shape.length; i++) {
        g.lineTo(topLeft.x + shape[i].x, topLeft.y + shape[i].y);
      }
      g.closePath();
      g.endFill();
    }
  }
}
