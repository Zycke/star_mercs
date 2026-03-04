/**
 * Utility functions for the Deploy system.
 * Validates deployment hexes, computes deploy radius, and checks
 * special deployment requirements.
 */

import { snapToHexCenter, hexKey, getAdjacentHexCenters, getTokensAtHex } from "./hex-utils.mjs";
import { checkLOS } from "./detection.mjs";

/* ============================================ */
/*  Hex Radius Computation                      */
/* ============================================ */

/**
 * Get all hex center points within a given radius using BFS.
 * @param {{x: number, y: number}} center - Starting hex center.
 * @param {number} radius - Max hex distance.
 * @returns {{x: number, y: number}[]}
 */
export function getHexesWithinRadius(center, radius) {
  const snapped = snapToHexCenter(center);
  const visited = new Set();
  const result = [];
  const queue = [{ point: snapped, depth: 0 }];
  visited.add(hexKey(snapped));
  result.push(snapped);

  while (queue.length > 0) {
    const { point, depth } = queue.shift();
    if (depth >= radius) continue;

    const neighbors = getAdjacentHexCenters(point);
    for (const neighbor of neighbors) {
      const key = hexKey(neighbor);
      if (visited.has(key)) continue;
      visited.add(key);
      result.push(neighbor);
      queue.push({ point: neighbor, depth: depth + 1 });
    }
  }

  return result;
}

/* ============================================ */
/*  Standard Deployment Validation              */
/* ============================================ */

/**
 * Get all valid deploy hexes within HQ radius for a given team.
 * Returns a Map of hexKey → hex center point.
 * @param {string} team - "a" or "b"
 * @returns {Map<string, {x: number, y: number}>}
 */
export function getDeployableHexes(team) {
  const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
  const hq = structures.find(s => s.type === "headquarters" && s.team === team);
  if (!hq) return new Map();

  const config = CONFIG.STARMERCS.structures.headquarters;
  const radius = hq.deployRadius ?? config.defaultDeployRadius ?? 3;
  const hqCenter = { x: hq.x, y: hq.y };
  const hexesInRadius = getHexesWithinRadius(hqCenter, radius);

  const validHexes = new Map();
  for (const hex of hexesInRadius) {
    const key = hexKey(hex);
    // Exclude hexes occupied by another living token
    const tokensHere = getTokensAtHex(hex);
    if (tokensHere.length > 0) continue;
    validHexes.set(key, hex);
  }

  return validHexes;
}

/* ============================================ */
/*  Special Deployment Validation               */
/* ============================================ */

/**
 * Get valid spotters for special deployment: friendly tokens that are either
 * within comms range of the team's HQ or have Satellite Uplink.
 * @param {string} team - "a" or "b"
 * @returns {Token[]}
 */
export function getValidSpotters(team) {
  if (!canvas?.tokens?.placeables) return [];

  const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
  const hq = structures.find(s => s.type === "headquarters" && s.team === team);

  const spotters = [];
  for (const token of canvas.tokens.placeables) {
    const actor = token.actor;
    if (!actor || actor.type !== "unit") continue;
    if (actor.system.team !== team) continue;
    if (actor.system.strength.value <= 0) continue;

    // Satellite Uplink always qualifies
    if (actor.hasTrait("Satellite Uplink")) {
      spotters.push(token);
      continue;
    }

    // Within comms range of HQ
    if (hq) {
      const hqCenter = { x: hq.x, y: hq.y };
      const commsRange = hq.commsRange ?? CONFIG.STARMERCS.structures.headquarters.defaultCommsRange ?? 8;
      const dist = getHexDistancePoints(token.center, hqCenter);
      if (dist <= commsRange) {
        spotters.push(token);
      }
    }
  }

  return spotters;
}

/**
 * Check if a hex is valid for special deployment (Meteoric Assault, Air Assault, Air Drop).
 * Requires a valid spotter with LOS and sensor range to the target hex.
 * @param {{x: number, y: number}} hexCenter - Target deployment hex.
 * @param {string} team - "a" or "b"
 * @returns {boolean}
 */
export function canSpecialDeploy(hexCenter, team) {
  const snapped = snapToHexCenter(hexCenter);

  // Target hex must be unoccupied
  if (getTokensAtHex(snapped).length > 0) return false;

  const spotters = getValidSpotters(team);
  for (const spotter of spotters) {
    const sensors = spotter.actor.system.sensors ?? 0;
    // Use sensor range as max distance (sensor + some base detection range)
    const dist = getHexDistancePoints(spotter.center, snapped);
    if (dist > sensors) continue;

    // Check LOS from spotter to target hex
    if (checkLOS(spotter.center, snapped, spotter, null)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all special deployment hexes visible to any valid spotter.
 * This is expensive — used for overlay highlighting only.
 * Returns a Map of hexKey → hex center point (excludes standard deploy hexes).
 * @param {string} team - "a" or "b"
 * @returns {Map<string, {x: number, y: number}>}
 */
export function getSpecialDeployHexes(team) {
  const spotters = getValidSpotters(team);
  if (spotters.length === 0) return new Map();

  const validHexes = new Map();
  const standardHexes = getDeployableHexes(team);

  for (const spotter of spotters) {
    const sensors = spotter.actor.system.sensors ?? 0;
    if (sensors <= 0) continue;

    const hexesInRange = getHexesWithinRadius(spotter.center, sensors);
    for (const hex of hexesInRange) {
      const key = hexKey(hex);
      if (standardHexes.has(key)) continue; // Already a standard deploy hex
      if (validHexes.has(key)) continue;   // Already found

      // Check unoccupied
      if (getTokensAtHex(hex).length > 0) continue;

      // Check LOS
      if (checkLOS(spotter.center, hex, spotter, null)) {
        validHexes.set(key, hex);
      }
    }
  }

  return validHexes;
}

/**
 * Check if a hex is valid for deployment (standard or special).
 * @param {{x: number, y: number}} hexCenter - Target hex center.
 * @param {string} team - "a" or "b"
 * @param {string} mode - "standard", "meteoric_assault", "air_assault", or "air_drop"
 * @returns {boolean}
 */
export function isValidDeployHex(hexCenter, team, mode) {
  const snapped = snapToHexCenter(hexCenter);
  const key = hexKey(snapped);

  // Always check standard hexes first
  const standardHexes = getDeployableHexes(team);
  if (standardHexes.has(key)) return true;

  // Special modes can deploy beyond HQ radius
  if (mode !== "standard") {
    return canSpecialDeploy(snapped, team);
  }

  return false;
}

/* ============================================ */
/*  Helper: Point-to-point hex distance         */
/* ============================================ */

/**
 * Compute hex distance between two pixel points.
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @returns {number}
 */
export function getHexDistancePoints(from, to) {
  const result = canvas.grid.measurePath([from, to]);
  const gridDistance = canvas.scene.grid.distance || 1;
  return Math.round(result.distance / gridDistance);
}
