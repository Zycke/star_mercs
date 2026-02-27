/**
 * Detection and spotting engine for Star Mercs.
 *
 * Detection range = observer's sensors + target's signature
 * If no LOS: sensors counts as floor(sensors / 2)
 * Negative signature = stealth unit, reduces detection range
 *
 * Detection levels:
 *   "visible" — within detection range (fully detected)
 *   "blip"    — beyond detection range but within 2x (partial contact)
 *   "hidden"  — beyond 2x detection range (invisible)
 *
 * Line of sight is blocked by terrain with blocksLOS: true and by
 * elevation differences (intermediate hex higher than both endpoints).
 */

import { snapToHexCenter, hexKey, computeHexPath,
  getHexTerrain, getHexTerrainConfig, getHexElevation } from "./hex-utils.mjs";
import StarMercsActor from "./documents/actor.mjs";

/**
 * Check hex-based line of sight between two hex positions.
 *
 * LOS blocking rules:
 * 1. Terrain with blocksLOS: true blocks vision through that hex.
 * 2. Higher elevation blocks LOS: if any hex along the path has elevation
 *    higher than the observer, it blocks vision to anything past it.
 *    The first higher-elevation hex encountered still counts as within LOS.
 *
 * @param {{x: number, y: number}} fromCenter - Observer hex center.
 * @param {{x: number, y: number}} toCenter - Target hex center.
 * @returns {boolean} True if LOS is clear.
 */
export function checkLOS(fromCenter, toCenter) {
  const from = snapToHexCenter(fromCenter);
  const to = snapToHexCenter(toCenter);

  // Same hex — always has LOS
  if (hexKey(from) === hexKey(to)) return true;

  const path = computeHexPath(from, to);
  if (path.length === 0) return true;

  const fromElev = getHexElevation(from);

  // Check intermediate hexes (exclude final destination).
  // path excludes start already; the last element IS the destination.
  let blocked = false;

  for (let i = 0; i < path.length - 1; i++) {
    const hex = path[i];

    // If a previous hex already blocked LOS, everything beyond is out of sight
    if (blocked) return false;

    const config = getHexTerrainConfig(hex);

    // Terrain-based LOS blocking
    if (config?.blocksLOS) {
      blocked = true;
      continue; // This hex itself is still "within LOS" but blocks beyond
    }

    // Elevation-based LOS blocking: hex higher than the observer blocks beyond
    const elev = getHexElevation(hex);
    if (elev > fromElev) {
      blocked = true;
      continue; // First higher hex is within LOS, but blocks past it
    }
  }

  // If blocked was set by the second-to-last intermediate hex,
  // the destination is still past the blocker
  if (blocked) return false;

  return true;
}

/**
 * Check if an observer token can detect a target token.
 * @param {Token} observerToken
 * @param {Token} targetToken
 * @returns {{ detected: boolean, distance: number, detectionRange: number, hasLOS: boolean }}
 */
export function canDetect(observerToken, targetToken) {
  if (!observerToken?.actor || !targetToken?.actor) {
    return { detected: false, distance: Infinity, detectionRange: 0, hasLOS: false };
  }

  const sensors = observerToken.actor.system.sensors ?? 0;
  const signature = targetToken.actor.system.signature ?? 0;

  // Check hex-based LOS
  const hasLOS = checkLOS(observerToken.center, targetToken.center);

  // Calculate detection range
  const effectiveSensors = hasLOS ? sensors : Math.floor(sensors / 2);
  const detectionRange = effectiveSensors + signature;

  // Calculate hex distance
  const distance = StarMercsActor.getHexDistance(observerToken, targetToken);

  return {
    detected: distance <= detectionRange,
    distance,
    detectionRange,
    hasLOS
  };
}

/**
 * Get the detection level of a target from a single observer.
 * @param {Token} observerToken
 * @param {Token} targetToken
 * @returns {"visible" | "blip" | "hidden"}
 */
export function getDetectionLevel(observerToken, targetToken) {
  const result = canDetect(observerToken, targetToken);

  if (result.detectionRange <= 0) {
    // If detection range is 0 or negative, only detect if literally adjacent
    if (result.distance <= 1) return "visible";
    if (result.distance <= 2) return "blip";
    return "hidden";
  }

  if (result.distance <= result.detectionRange) return "visible";
  if (result.distance <= result.detectionRange * 2) return "blip";
  return "hidden";
}

/**
 * Compute the best detection level for an enemy token from any friendly unit on a team.
 * Returns the best level (visible > blip > hidden).
 * @param {string} friendlyTeam - The friendly team key ("a" or "b").
 * @param {Token} enemyToken - The enemy token to check.
 * @returns {"visible" | "blip" | "hidden"}
 */
export function computeBestDetectionLevel(friendlyTeam, enemyToken) {
  if (!canvas?.tokens?.placeables) return "hidden";

  const levels = { visible: 3, blip: 2, hidden: 1 };
  let bestLevel = "hidden";

  for (const token of canvas.tokens.placeables) {
    if (!token.actor || token.actor.type !== "unit") continue;
    if (token.actor.system.strength.value <= 0) continue;
    if ((token.actor.system.team ?? "a") !== friendlyTeam) continue;

    const level = getDetectionLevel(token, enemyToken);
    if (levels[level] > levels[bestLevel]) {
      bestLevel = level;
      if (bestLevel === "visible") break; // Can't do better
    }
  }

  return bestLevel;
}

/**
 * Compute visibility map for all enemy tokens from a team's perspective.
 * @param {string} team - The observing team key.
 * @returns {Map<string, "visible" | "blip" | "hidden">} Token ID → detection level.
 */
export function computeTeamVisibility(team) {
  const visibilityMap = new Map();
  if (!canvas?.tokens?.placeables) return visibilityMap;

  for (const token of canvas.tokens.placeables) {
    if (!token.actor || token.actor.type !== "unit") continue;
    if (token.actor.system.strength.value <= 0) continue;
    if ((token.actor.system.team ?? "a") === team) continue; // Skip friendlies

    const level = computeBestDetectionLevel(team, token);
    visibilityMap.set(token.id, level);
  }

  return visibilityMap;
}
