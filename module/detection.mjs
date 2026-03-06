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
 * elevation differences (intermediate hex at least as high as both endpoints).
 * Units at higher elevation can see over lower-elevation hexes.
 */

import { snapToHexCenter, hexKey, computeHexPath,
  getHexTerrain, getHexTerrainConfig, getHexElevation,
  getEffectiveElevation, isAirborne } from "./hex-utils.mjs";
import StarMercsActor from "./documents/actor.mjs";

/**
 * Check hex-based line of sight between two hex positions.
 *
 * LOS blocking rules (elevation-aware):
 * 1. Units at higher elevation can see OVER hexes at lower elevation,
 *    even if those hexes have terrain that normally blocks LOS.
 * 2. An intermediate hex only blocks LOS if its elevation is >= BOTH
 *    the observer's elevation AND the target's elevation.
 * 3. When blocking applies: terrain with blocksLOS: true blocks vision,
 *    and elevation strictly higher than both endpoints blocks vision.
 * 4. The first blocking hex encountered is still within LOS itself,
 *    but everything beyond it is blocked.
 *
 * @param {{x: number, y: number}} fromCenter - Observer hex center.
 * @param {{x: number, y: number}} toCenter - Target hex center.
 * @param {Token|null} [fromToken=null] - Observer token (for flying altitude).
 * @param {Token|null} [toToken=null] - Target token (for flying altitude).
 * @returns {boolean} True if LOS is clear.
 */
export function checkLOS(fromCenter, toCenter, fromToken = null, toToken = null) {
  const from = snapToHexCenter(fromCenter);
  const to = snapToHexCenter(toCenter);

  // Same hex — always has LOS
  if (hexKey(from) === hexKey(to)) return true;

  const path = computeHexPath(from, to);
  if (path.length === 0) return true;

  // Use effective elevation (accounts for flying altitude) when tokens are provided
  const fromElev = fromToken ? getEffectiveElevation(fromToken) : getHexElevation(from);
  const toElev = toToken ? getEffectiveElevation(toToken) : getHexElevation(to);
  const maxEndpointElev = Math.max(fromElev, toElev);

  // Max sight distance based on observer's effective elevation
  const maxSight = CONFIG.STARMERCS.maxSightDistance?.[fromElev] ?? 160;
  if (path.length > maxSight) return false;

  // Check intermediate hexes (exclude final destination).
  // path excludes start already; the last element IS the destination.
  let blocked = false;

  for (let i = 0; i < path.length - 1; i++) {
    const hex = path[i];

    // If a previous hex already blocked LOS, everything beyond is out of sight
    if (blocked) return false;

    const elev = getHexElevation(hex);

    // If the intermediate hex is lower than either endpoint, both endpoints
    // can see over it — skip all blocking checks for this hex
    if (elev < maxEndpointElev) continue;

    // Hex is at least as high as both endpoints — check for blocking
    const config = getHexTerrainConfig(hex);

    // Terrain-based LOS blocking
    if (config?.blocksLOS) {
      blocked = true;
      continue; // This hex itself is still "within LOS" but blocks beyond
    }

    // Elevation-based LOS blocking: hex strictly higher than both endpoints
    if (elev > maxEndpointElev) {
      blocked = true;
      continue;
    }
  }

  // If blocked was set by the second-to-last intermediate hex,
  // the destination is still past the blocker
  if (blocked) return false;

  return true;
}

/**
 * Compute a token's active signature, factoring in terrain modifiers.
 *
 * Infantry terrain modifiers:
 *   Woods, Hills, Swamp: -1
 *   Mountains, Urban (Light): -2
 *   Urban (Dense): -3
 *
 * Vehicle terrain modifiers:
 *   Urban (Light): -1
 *   Urban (Dense): -2
 *
 * @param {Token} token - The token whose signature to compute.
 * @returns {{ active: number, base: number, totalMod: number, modifiers: Array<{label: string, value: number}> }}
 */
export function getActiveSignature(token) {
  const actor = token?.actor;
  if (!actor) return { active: 0, base: 0, totalMod: 0, modifiers: [] };

  const baseSig = actor.system.signature ?? 0;

  // Deploy signature bonus (temporary, from special deployment status effects)
  let deploySigBonus = 0;
  if (token.document?.hasStatusEffect("meteoric-assault")) deploySigBonus = 2;
  else if (token.document?.hasStatusEffect("air-assault")) deploySigBonus = 5;

  // Airborne flying units get no terrain signature modifiers (exposed in the sky)
  if (isAirborne(token)) {
    const airMod = deploySigBonus;
    const airModifiers = deploySigBonus ? [{ label: "Deploy signature", value: deploySigBonus }] : [];
    return { active: baseSig + airMod, base: baseSig, totalMod: airMod, modifiers: airModifiers };
  }

  const modifiers = [];
  let totalMod = 0;

  // Terrain concealment from status effects (synced on hex entry)
  const doc = token.document;
  if (doc?.hasStatusEffect("heavy-concealment")) {
    totalMod += -3;
    modifiers.push({ label: "Heavy Concealment", value: -3 });
  } else if (doc?.hasStatusEffect("moderate-concealment")) {
    totalMod += -2;
    modifiers.push({ label: "Moderate Concealment", value: -2 });
  } else if (doc?.hasStatusEffect("light-concealment")) {
    totalMod += -1;
    modifiers.push({ label: "Light Concealment", value: -1 });
  }

  // Deploy signature bonus (special deployment)
  if (deploySigBonus) {
    totalMod += deploySigBonus;
    modifiers.push({ label: "Deploy signature", value: deploySigBonus });
  }

  return { active: baseSig + totalMod, base: baseSig, totalMod, modifiers };
}

/**
 * Compute terrain cover attack penalty for a target token.
 *
 * Infantry cover:
 *   Woods, Hills, Swamp, Mountains, Urban (Light): +1 to attacker accuracy (harder to hit)
 *   Urban (Dense): +2
 *
 * Vehicle cover:
 *   Urban (Dense): +1
 *
 * @param {Token} targetToken - The target being attacked.
 * @returns {{ mod: number, modifiers: Array<{label: string, value: number}> }}
 */
export function getTerrainCoverMod(targetToken) {
  const actor = targetToken?.actor;
  if (!actor) return { mod: 0, modifiers: [] };

  // Airborne flying units get no terrain cover (exposed in the sky)
  if (isAirborne(targetToken)) return { mod: 0, modifiers: [] };

  // Read cover from status effects (synced on hex entry)
  const doc = targetToken.document;
  if (doc?.hasStatusEffect("heavy-cover")) {
    return { mod: 2, modifiers: [{ label: "Heavy Cover", value: 2 }] };
  }
  if (doc?.hasStatusEffect("cover")) {
    return { mod: 1, modifiers: [{ label: "Cover", value: 1 }] };
  }
  return { mod: 0, modifiers: [] };
}

/**
 * Check if an observer token can detect a target token.
 * Uses active signature (base + terrain modifiers) for detection range.
 * @param {Token} observerToken
 * @param {Token} targetToken
 * @param {number} [sensorBonus=0] - Additional sensor bonus (e.g. from outpost comms relay).
 * @returns {{ detected: boolean, distance: number, detectionRange: number, hasLOS: boolean }}
 */
export function canDetect(observerToken, targetToken, sensorBonus = 0) {
  if (!observerToken?.actor || !targetToken?.actor) {
    return { detected: false, distance: Infinity, detectionRange: 0, hasLOS: false };
  }

  const sensors = (observerToken.actor.system.sensors ?? 0) + sensorBonus;
  const { active: signature } = getActiveSignature(targetToken);

  // Check hex-based LOS (pass tokens for altitude-aware elevation)
  const hasLOS = checkLOS(observerToken.center, targetToken.center, observerToken, targetToken);

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
 * @param {number} [sensorBonus=0] - Additional sensor bonus (e.g. from outpost comms relay).
 * @returns {"visible" | "blip" | "hidden"}
 */
export function getDetectionLevel(observerToken, targetToken, sensorBonus = 0) {
  const result = canDetect(observerToken, targetToken, sensorBonus);

  // Adjacent units (distance ≤ 1) always fully detect each other
  if (result.distance <= 1) return "visible";

  // No LOS = no detection at any range
  if (!result.hasLOS) return "hidden";

  // With LOS: normal detection range logic
  if (result.detectionRange <= 0) return "hidden";
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

  // Outpost/HQ comms relay: find friendly outposts and headquarters for sensor bonus
  const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
  const friendlyOutposts = structures.filter(s =>
    (s.type === "outpost" || s.type === "headquarters") && s.team === friendlyTeam
    && s.turnsBuilt >= s.turnsRequired && s.strength > 0
  );

  for (const token of canvas.tokens.placeables) {
    if (!token.actor || token.actor.type !== "unit") continue;
    if (token.actor.system.strength.value <= 0) continue;
    if ((token.actor.system.team ?? "a") !== friendlyTeam) continue;

    // Check if observer is within any friendly outpost comms range → +2 sensors
    let commsBonus = 0;
    if (friendlyOutposts.length > 0) {
      const obsCenter = snapToHexCenter(token.center);
      for (const op of friendlyOutposts) {
        const dx = obsCenter.x - op.x;
        const dy = obsCenter.y - op.y;
        const dist = Math.round(Math.sqrt(dx * dx + dy * dy) / (canvas.grid.size || 100));
        if (dist <= (op.commsRange ?? 5)) { commsBonus = 2; break; }
      }
    }

    const level = getDetectionLevel(token, enemyToken, commsBonus);
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
