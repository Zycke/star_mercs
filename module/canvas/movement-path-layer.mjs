import { snapToHexCenter, hexKey, computeHexPath, calculatePathCost,
  getMovementCost, getHexElevation } from "../hex-utils.mjs";

/**
 * PIXI.Container that renders movement path previews on the hex grid.
 * Shows the path a unit would take from its current position through waypoints,
 * color-coded by viability, with MP cost labels.
 *
 * Colors:
 *   Green  — destination hex
 *   Yellow — viable intermediate hexes
 *   Red    — blocked hexes (impassable terrain, elevation too steep, etc.)
 *
 * Added to canvas.interface during canvasReady hook.
 */
export default class MovementPathLayer extends PIXI.Container {

  constructor() {
    super();

    /** @type {PIXI.Graphics} */
    this.pathGraphics = new PIXI.Graphics();
    this.addChild(this.pathGraphics);

    /** @type {PIXI.Container} */
    this.labelContainer = new PIXI.Container();
    this.addChild(this.labelContainer);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static COLOR_VIABLE = 0xFFFF00;      // Yellow
  static COLOR_BLOCKED = 0xFF3333;     // Red
  static COLOR_DESTINATION = 0x33FF33; // Green
  static COLOR_HOVER = 0x66CCFF;       // Light blue (hovered hex)
  static HEX_FILL_ALPHA = 0.3;
  static HEX_BORDER_ALPHA = 0.6;
  static HEX_BORDER_WIDTH = 2;

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /** Clear all path visuals. */
  clear() {
    this.pathGraphics.clear();
    this.labelContainer.removeChildren();
  }

  /**
   * Draw the movement path preview for a set of waypoints.
   *
   * @param {Token} token - The unit's canvas token.
   * @param {{x: number, y: number}[]} waypoints - Array of waypoint hex centers (snapped).
   * @param {{x: number, y: number}|null} [hoverHex=null] - Currently hovered hex (not yet committed).
   */
  drawPath(token, waypoints, hoverHex = null) {
    this.clear();
    if (!token?.actor || waypoints.length === 0 && !hoverHex) return;

    const actor = token.actor;
    const shape = canvas.grid.getShape();
    if (!shape || shape.length < 3) return;

    const shapeCX = shape.reduce((sum, p) => sum + p.x, 0) / shape.length;
    const shapeCY = shape.reduce((sum, p) => sum + p.y, 0) / shape.length;

    // Build full waypoint list including hover if present
    const allWaypoints = [...waypoints];
    if (hoverHex) allWaypoints.push(hoverHex);

    // Compute full path through all waypoints
    let startCenter = snapToHexCenter(token.center);
    const fullPath = [];
    const segmentBoundaries = []; // indices where each waypoint's segment starts

    for (const wp of allWaypoints) {
      segmentBoundaries.push(fullPath.length);
      const segment = computeHexPath(startCenter, wp);
      fullPath.push(...segment);
      if (segment.length > 0) {
        startCenter = segment[segment.length - 1];
      }
    }

    if (fullPath.length === 0) return;

    // Calculate cost and passability for each hex
    const isFlying = actor.hasTrait?.("Flying") ?? false;
    const isHover = actor.hasTrait?.("Hover") ?? false;
    let runningCost = 0;
    let blocked = false;
    let prevCenter = snapToHexCenter(token.center);
    const hexStates = []; // {center, cost, passable, reason, runningCost}

    for (let i = 0; i < fullPath.length; i++) {
      const hex = fullPath[i];

      if (blocked) {
        hexStates.push({ center: hex, cost: 0, passable: false, reason: "Path blocked earlier", runningCost });
        prevCenter = hex;
        continue;
      }

      // Check elevation restriction
      if (!isFlying && !isHover) {
        const prevElev = getHexElevation(prevCenter);
        const nextElev = getHexElevation(hex);
        if (Math.abs(nextElev - prevElev) > 1) {
          blocked = true;
          hexStates.push({ center: hex, cost: 0, passable: false, reason: "Elevation too steep", runningCost });
          prevCenter = hex;
          continue;
        }
      }

      const { cost, passable, reason } = getMovementCost(hex, actor);
      if (!passable) {
        blocked = true;
        hexStates.push({ center: hex, cost: 0, passable: false, reason, runningCost });
      } else {
        runningCost += cost;
        hexStates.push({ center: hex, cost, passable: true, reason: null, runningCost });
      }

      prevCenter = hex;
    }

    // Determine available MP
    const orderKey = actor.system.currentOrder;
    const orderConfig = CONFIG.STARMERCS.orders?.[orderKey];
    let maxMP = actor.system.movement ?? 0;
    if (orderConfig?.speedMultiplier) maxMP *= orderConfig.speedMultiplier;
    const mpUsed = token.document?.getFlag("star-mercs", "movementUsed") ?? 0;
    const mpRemaining = maxMP - mpUsed;

    // Build set of waypoint keys (for coloring destinations green)
    const waypointKeys = new Set(allWaypoints.map(wp => hexKey(snapToHexCenter(wp))));
    const lastHexKey = fullPath.length > 0 ? hexKey(fullPath[fullPath.length - 1]) : null;

    // Draw each hex
    for (let i = 0; i < hexStates.length; i++) {
      const state = hexStates[i];
      const topLeft = { x: state.center.x - shapeCX, y: state.center.y - shapeCY };

      let color;
      const hKey = hexKey(state.center);

      if (!state.passable || state.runningCost > mpRemaining) {
        color = MovementPathLayer.COLOR_BLOCKED;
      } else if (hoverHex && hKey === hexKey(hoverHex)) {
        color = MovementPathLayer.COLOR_HOVER;
      } else if (waypointKeys.has(hKey)) {
        color = MovementPathLayer.COLOR_DESTINATION;
      } else {
        color = MovementPathLayer.COLOR_VIABLE;
      }

      this._drawHex(topLeft, shape, color);
    }

    // Draw total MP cost label at the last hex
    if (hexStates.length > 0) {
      const lastState = hexStates[hexStates.length - 1];
      const totalCost = lastState.runningCost;
      const overBudget = totalCost > mpRemaining;
      const labelColor = overBudget ? 0xFF3333 : 0x33FF33;
      const labelText = `${totalCost} MP`;
      this._drawCostLabel(lastState.center, labelText, labelColor);
    }
  }

  /* ---------------------------------------- */
  /*  Drawing Helpers                         */
  /* ---------------------------------------- */

  /**
   * Draw a filled hex at a position.
   * @private
   */
  _drawHex(topLeft, shape, color) {
    const g = this.pathGraphics;
    g.lineStyle(MovementPathLayer.HEX_BORDER_WIDTH, color, MovementPathLayer.HEX_BORDER_ALPHA);
    g.beginFill(color, MovementPathLayer.HEX_FILL_ALPHA);
    g.moveTo(topLeft.x + shape[0].x, topLeft.y + shape[0].y);
    for (let i = 1; i < shape.length; i++) {
      g.lineTo(topLeft.x + shape[i].x, topLeft.y + shape[i].y);
    }
    g.closePath();
    g.endFill();
  }

  /**
   * Draw a cost label at a hex center.
   * @private
   */
  _drawCostLabel(center, text, color) {
    const label = new PIXI.Text(text, {
      fontFamily: "Signika",
      fontSize: 14,
      fontWeight: "bold",
      fill: color,
      stroke: 0x000000,
      strokeThickness: 3,
      align: "center"
    });
    label.anchor.set(0.5, -0.5); // Below center
    label.position.set(center.x, center.y);
    this.labelContainer.addChild(label);
  }
}
