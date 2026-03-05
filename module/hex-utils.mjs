/**
 * Hex grid utility functions for Star Mercs.
 * Provides adjacency, path computation, engagement checks, and movement validation.
 */

/**
 * Snap a point to the center of its hex cell.
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
export function snapToHexCenter(point) {
  return canvas.grid.getSnappedPoint(point, { mode: CONST.GRID_SNAPPING_MODES.CENTER });
}

/**
 * Convert a hex center coordinate to the top-left position expected by token.update().
 * @param {{x: number, y: number}} center - Hex center pixel coordinates.
 * @param {Token|TokenDocument} token - The token (for width/height).
 * @returns {{x: number, y: number}}
 */
export function hexCenterToTokenPosition(center, token) {
  const gridSize = canvas.grid.size || 100;
  // Support Canvas Token (.w/.h), TokenDocument (.width/.height in grid units),
  // or nested TokenDocument (token.document?.width).
  const tokenW = token.w ?? ((token.document?.width ?? token.width ?? 1) * gridSize);
  const tokenH = token.h ?? ((token.document?.height ?? token.height ?? 1) * gridSize);
  return { x: center.x - tokenW / 2, y: center.y - tokenH / 2 };
}

/**
 * Get a string key for a hex center point (for use in Maps/Sets).
 * @param {{x: number, y: number}} center
 * @returns {string}
 */
export function hexKey(center) {
  return `${Math.round(center.x)},${Math.round(center.y)}`;
}

/**
 * Get all adjacent hex centers around a given point.
 * @param {{x: number, y: number}} center - A hex center point.
 * @returns {{x: number, y: number}[]}
 */
export function getAdjacentHexCenters(center) {
  const offsets = canvas.grid.getAdjacentOffsets(center);
  if (!offsets || offsets.length === 0) return [];
  return offsets.map(offset => canvas.grid.getCenterPoint(offset));
}

/**
 * Get all living unit tokens occupying a specific hex.
 * @param {{x: number, y: number}} center - A snapped hex center.
 * @returns {Token[]}
 */
export function getTokensAtHex(center) {
  const key = hexKey(center);
  const results = [];
  for (const token of canvas.tokens.placeables) {
    if (!token.actor || token.actor.type !== "unit") continue;
    if (token.actor.system.strength.value <= 0) continue;
    const tokenCenter = snapToHexCenter(token.center);
    if (hexKey(tokenCenter) === key) results.push(token);
  }
  return results;
}

/**
 * Check if two tokens are in adjacent hexes (distance = 1 hex).
 * @param {Token} token1
 * @param {Token} token2
 * @returns {boolean}
 */
export function areAdjacent(token1, token2) {
  const center1 = snapToHexCenter(token1.center);
  const neighbors = getAdjacentHexCenters(center1);
  const key2 = hexKey(snapToHexCenter(token2.center));
  return neighbors.some(n => hexKey(n) === key2);
}

/**
 * Get all living enemy tokens adjacent to a given token.
 * @param {Token} token - The reference token.
 * @returns {Token[]}
 */
export function getAdjacentEnemies(token) {
  if (!token.actor) return [];
  const myTeam = token.actor.system.team ?? "a";
  const center = snapToHexCenter(token.center);
  const neighborKeys = new Set(getAdjacentHexCenters(center).map(hexKey));

  const enemies = [];
  for (const other of canvas.tokens.placeables) {
    if (other === token) continue;
    if (!other.actor || other.actor.type !== "unit") continue;
    if (other.actor.system.strength.value <= 0) continue;
    const otherTeam = other.actor.system.team ?? "a";
    if (otherTeam === myTeam) continue;
    const otherKey = hexKey(snapToHexCenter(other.center));
    if (neighborKeys.has(otherKey)) enemies.push(other);
  }
  return enemies;
}

/**
 * Check if a token is "Engaged" (adjacent to at least one living enemy).
 * @param {Token} token
 * @returns {boolean}
 */
export function isEngaged(token) {
  return getAdjacentEnemies(token).length > 0;
}

/**
 * Compute a hex-step path from one center to another.
 * Returns array of hex center points along the path (excluding the start, including the end).
 * Uses greedy neighbor-stepping: at each step, pick the adjacent hex closest to the target.
 * @param {{x: number, y: number}} fromCenter - Starting hex center.
 * @param {{x: number, y: number}} toCenter - Destination hex center.
 * @param {number} [maxSteps=50] - Safety limit.
 * @returns {{x: number, y: number}[]}
 */
export function computeHexPath(fromCenter, toCenter, maxSteps = 50) {
  const from = snapToHexCenter(fromCenter);
  const to = snapToHexCenter(toCenter);
  const destKey = hexKey(to);

  // If already at destination, return empty path
  if (hexKey(from) === destKey) return [];

  const path = [];
  let current = from;
  const visited = new Set();
  visited.add(hexKey(current));

  for (let i = 0; i < maxSteps; i++) {
    const neighbors = getAdjacentHexCenters(current);
    let bestNeighbor = null;
    let bestDist = Infinity;

    for (const neighbor of neighbors) {
      const nKey = hexKey(neighbor);

      // Check if we've reached the destination
      if (nKey === destKey) {
        path.push(neighbor);
        return path;
      }

      // Skip already-visited hexes (prevent loops)
      if (visited.has(nKey)) continue;

      // Calculate distance to target
      const dx = neighbor.x - to.x;
      const dy = neighbor.y - to.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < bestDist) {
        bestDist = dist;
        bestNeighbor = neighbor;
      }
    }

    if (!bestNeighbor) break; // No unvisited neighbors — stuck

    path.push(bestNeighbor);
    visited.add(hexKey(bestNeighbor));
    current = bestNeighbor;
  }

  return path;
}

/**
 * Validate a movement path for a token.
 * Checks that:
 * 1. No intermediate hex contains an enemy unit.
 * 2. The final hex is not occupied by any other living unit.
 * 3. Terrain is passable for this unit (water, vehicle restrictions).
 * 4. Elevation changes between adjacent hexes are ≤ 1 (unless Flying/Hover).
 * @param {Token} token - The moving token.
 * @param {{x: number, y: number}[]} path - Array of hex centers along the path.
 * @returns {{ valid: boolean, blockedAt: {x: number, y: number}|null, reason: string|null }}
 */
export function validatePath(token, path) {
  if (!token.actor || path.length === 0) return { valid: true, blockedAt: null, reason: null };

  const myTeam = token.actor.system.team ?? "a";
  const actor = token.actor;
  const isFlying = actor.hasTrait?.("Flying") ?? false;
  const isHover = actor.hasTrait?.("Hover") ?? false;
  const isJumpCapable = actor.hasTrait?.("Jump Capable") ?? false;
  const maxElevChange = isJumpCapable ? 2 : 1;
  const isUnitAirborne = isFlying && !(actor.getFlag?.("star-mercs", "landed") ?? false);

  // Landed flying units cannot move at all
  if (isFlying && !isUnitAirborne) {
    return { valid: false, blockedAt: path[0] ?? null, reason: "Landed flying units cannot move — take off first." };
  }

  let prevCenter = snapToHexCenter(token.center);

  for (let i = 0; i < path.length; i++) {
    const hexCenter = path[i];

    // Terrain passability check
    const { passable, reason: terrainReason } = getMovementCost(hexCenter, actor);
    if (!passable) {
      return { valid: false, blockedAt: hexCenter, reason: terrainReason };
    }

    // Elevation restriction (skip for airborne Flying; Hover and landed must obey)
    if (!isUnitAirborne) {
      const prevElev = getHexElevation(prevCenter);
      const nextElev = getHexElevation(hexCenter);
      if (Math.abs(nextElev - prevElev) > maxElevChange) {
        return {
          valid: false,
          blockedAt: hexCenter,
          reason: `Elevation change too steep (${prevElev} → ${nextElev}). Max difference is ${maxElevChange}.`
        };
      }
    }

    // Token occupation checks
    const tokensHere = getTokensAtHex(hexCenter);
    const isLastStep = i === path.length - 1;

    if (isLastStep) {
      // Final hex: no other living unit (ally or enemy) allowed
      const others = tokensHere.filter(t => t !== token);
      if (others.length > 0) {
        return {
          valid: false,
          blockedAt: hexCenter,
          reason: "Cannot end movement in a hex occupied by another unit."
        };
      }
    } else if (isUnitAirborne) {
      // Airborne flying units can fly over any occupied hex (intermediate only)
      // No blocking check — they fly over both allies and enemies
    } else {
      // Ground units: intermediate hex cannot contain enemy units
      const enemyHere = tokensHere.some(t =>
        t !== token && (t.actor.system.team ?? "a") !== myTeam
      );
      if (enemyHere) {
        return {
          valid: false,
          blockedAt: hexCenter,
          reason: "Cannot maneuver through a hex containing an enemy unit."
        };
      }
    }

    prevCenter = hexCenter;
  }

  return { valid: true, blockedAt: null, reason: null };
}

/**
 * Find the best adjacent hex to a target token that is closest to the attacker.
 * Used for assault movement: the attacker moves to an adjacent hex of the defender.
 * Prefers unoccupied hexes.
 * @param {Token} targetToken - The target to move adjacent to.
 * @param {Token} attackerToken - The attacking unit.
 * @returns {{x: number, y: number}|null} The best hex center, or null if none available.
 */
export function findBestAdjacentHex(targetToken, attackerToken) {
  const targetCenter = snapToHexCenter(targetToken.center);
  const attackerCenter = snapToHexCenter(attackerToken.center);
  const neighbors = getAdjacentHexCenters(targetCenter);

  // Build set of occupied hex keys (exclude the attacker and the target)
  const occupiedKeys = new Set();
  for (const token of canvas.tokens.placeables) {
    if (token === attackerToken || token === targetToken) continue;
    if (!token.actor || token.actor.system?.strength?.value <= 0) continue;
    occupiedKeys.add(hexKey(snapToHexCenter(token.center)));
  }

  let best = null;
  let bestDist = Infinity;

  for (const neighbor of neighbors) {
    const nKey = hexKey(neighbor);
    // Skip occupied hexes
    if (occupiedKeys.has(nKey)) continue;

    const dx = neighbor.x - attackerCenter.x;
    const dy = neighbor.y - attackerCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < bestDist) {
      bestDist = dist;
      best = neighbor;
    }
  }

  return best;
}

/* ---------------------------------------- */
/*  Terrain Query Utilities                 */
/* ---------------------------------------- */

/**
 * Normalize a terrainMap entry from the scene flag.
 * Handles both the legacy string format ("forest") and new object format
 * ({type: "forest", elevation: 0, road: false}).
 * @param {string|object} entry - Raw terrainMap value.
 * @returns {{type: string, elevation: number, road: boolean}}
 */
export function normalizeHexData(entry) {
  if (typeof entry === "string") {
    return { type: entry, elevation: 0, road: false, objective: null };
  }
  if (entry && typeof entry === "object") {
    return {
      type: entry.type ?? "plain",
      elevation: entry.elevation ?? 0,
      road: entry.road ?? false,
      objective: entry.objective ?? null
    };
  }
  return { type: "plain", elevation: 0, road: false, objective: null };
}

/**
 * Get the full hex data (terrain type, elevation, road) for a hex.
 * @param {{x: number, y: number}} hexCenter - A hex center point (will be snapped).
 * @param {object} [overrideMap] - Optional terrain map to use instead of scene flag.
 * @returns {{type: string, elevation: number, road: boolean}|null} Hex data or null if none assigned.
 */
export function getHexData(hexCenter, overrideMap) {
  const terrainMap = overrideMap ?? canvas.scene?.getFlag("star-mercs", "terrainMap");
  if (!terrainMap) return null;
  const key = hexKey(snapToHexCenter(hexCenter));
  const entry = terrainMap[key];
  if (entry == null) return null;
  return normalizeHexData(entry);
}

/**
 * Get the terrain type key for a hex, reading from the scene's terrainMap flag.
 * @param {{x: number, y: number}} hexCenter - A hex center point (will be snapped).
 * @returns {string|null} Terrain type key (e.g., "forest") or null if none assigned.
 */
export function getHexTerrain(hexCenter) {
  const data = getHexData(hexCenter);
  return data?.type ?? null;
}

/**
 * Get the full terrain config object for a hex.
 * @param {{x: number, y: number}} hexCenter
 * @returns {object|null} Terrain config from CONFIG.STARMERCS.terrain, or null.
 */
export function getHexTerrainConfig(hexCenter) {
  const type = getHexTerrain(hexCenter);
  if (!type) return null;
  return CONFIG.STARMERCS.terrain[type] ?? null;
}

/**
 * Get the elevation level for a hex (independent per-hex property, 0–5).
 * @param {{x: number, y: number}} hexCenter
 * @returns {number} Elevation level (0–5).
 */
export function getHexElevation(hexCenter) {
  const data = getHexData(hexCenter);
  return data?.elevation ?? 0;
}

/**
 * Get the effective elevation for a token, accounting for flying unit altitude.
 * - Non-flying units: returns hex terrain elevation
 * - Landed flying units: returns hex terrain elevation
 * - Airborne flying units: returns their altitude (clamped to [hexElev, 5])
 *
 * @param {Token} token - The token to check.
 * @returns {number} Effective elevation (0–5).
 */
export function getEffectiveElevation(token) {
  const actor = token?.actor;
  const hexElev = getHexElevation(snapToHexCenter(token.center));
  if (!actor?.hasTrait?.("Flying")) return hexElev;
  if (actor.getFlag("star-mercs", "landed")) return hexElev;
  const altitude = actor.getFlag("star-mercs", "altitude") ?? hexElev;
  return Math.max(hexElev, Math.min(altitude, 5));
}

/**
 * Check if a token represents an airborne flying unit (Flying trait, not landed).
 * @param {Token} token
 * @returns {boolean}
 */
export function isAirborne(token) {
  const actor = token?.actor;
  if (!actor?.hasTrait?.("Flying")) return false;
  return !actor.getFlag("star-mercs", "landed");
}

/**
 * Check if a hex has a road.
 * A hex has a road if it has the road flag set, OR if its terrain type
 * has hasRoad: true (e.g., urban terrain).
 * @param {{x: number, y: number}} hexCenter
 * @returns {boolean}
 */
export function getHexRoad(hexCenter) {
  const data = getHexData(hexCenter);
  if (!data) return false;
  if (data.road) return true;
  const config = CONFIG.STARMERCS.terrain[data.type];
  return config?.hasRoad ?? false;
}

/**
 * Get a completed structure at a hex (if any).
 * Returns the first structure found, or null.
 * @param {{x: number, y: number}} hexCenter - The hex center to check.
 * @returns {object|null} The structure data object, or null.
 */
export function getStructureAtHex(hexCenter) {
  const snapped = snapToHexCenter(hexCenter);
  const key = hexKey(snapped);
  const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
  return structures.find(s => s.hexKey === key) ?? null;
}

/**
 * Calculate the movement point cost to enter a hex.
 * Flying and Hover units always pay 1 MP regardless of terrain.
 * Water terrain is impassable unless the unit has Flying, Hover, or Amphibious.
 * Road reduces cost by 1 (minimum 1).
 *
 * @param {{x: number, y: number}} hexCenter - The hex to enter.
 * @param {Actor|null} [actor=null] - The moving actor (for trait checks).
 * @returns {{cost: number, passable: boolean, reason: string|null}}
 */
export function getMovementCost(hexCenter, actor = null) {
  const data = getHexData(hexCenter);
  const config = data ? CONFIG.STARMERCS.terrain[data.type] ?? null : null;

  // Unpainted hex: treat as open terrain (1 MP)
  if (!data || !config) return { cost: 1, passable: true, reason: null };

  const isFlying = actor?.hasTrait?.("Flying") ?? false;
  const isHover = actor?.hasTrait?.("Hover") ?? false;
  const isAmphibious = actor?.hasTrait?.("Amphibious") ?? false;

  // Flying units: airborne always cost 1 MP; landed cannot move
  if (isFlying) {
    const landed = actor?.getFlag?.("star-mercs", "landed") ?? false;
    if (landed) return { cost: Infinity, passable: false, reason: "Landed flying units cannot move — take off first." };
    return { cost: 1, passable: true, reason: null };
  }

  // Hover units can cross any terrain including water at terrain cost - 1 (min 1)
  if (isHover) {
    const terrainCost = config.movementCost ?? 1;
    const hasRoad = data.road || config.hasRoad;
    let cost = Math.max(1, terrainCost - 1);
    if (hasRoad) cost = Math.max(1, cost - 1);
    return { cost, passable: true, reason: null };
  }

  // Bridge (terrain flag or structure): makes water passable at 1 MP
  if (config.waterTerrain) {
    // Check terrain bridge flag first
    if (data.bridge) {
      return { cost: 1, passable: true, reason: null };
    }
    // Check completed bridge structures
    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    const bKey = hexKey(snapToHexCenter(hexCenter));
    const bridge = structures.find(s => s.type === "bridge" && s.hexKey === bKey
      && s.turnsBuilt >= s.turnsRequired && s.strength > 0);
    if (bridge) {
      return { cost: 1, passable: true, reason: null };
    }
  }

  // Water terrain check
  if (config.waterTerrain) {
    if (!isAmphibious) {
      return { cost: Infinity, passable: false, reason: "Water terrain is impassable without Flying, Hover, or Amphibious." };
    }
    // Amphibious units can enter water at normal cost
  }

  // Vehicle impassable check (mountains without road)
  const isVehicle = actor?.hasTrait?.("Vehicle") ?? false;
  const hasRoad = data.road || config.hasRoad;
  if (config.impassableVehicle && isVehicle && !hasRoad) {
    return { cost: Infinity, passable: false, reason: "Vehicles cannot enter this terrain without a road." };
  }

  // Base cost from terrain config
  let cost = config.movementCost ?? 1;

  // Road discount: -1 MP (minimum 1)
  if (hasRoad) {
    cost = Math.max(1, cost - 1);
  }

  // Mech trait: -1 MP for all non-water terrain (min 1)
  const isMech = actor?.hasTrait?.("Mech") ?? false;
  if (isMech && !config.waterTerrain) {
    cost = Math.max(1, cost - 1);
  }

  // Powered trait: -1 MP for all non-water terrain (min 1)
  const isPowered = actor?.hasTrait?.("Powered") ?? false;
  if (isPowered && !config.waterTerrain) {
    cost = Math.max(1, cost - 1);
  }

  return { cost, passable: true, reason: null };
}

/**
 * Calculate total movement point cost for a path.
 * Also checks elevation restrictions (can't move >1 elevation difference between adjacent hexes).
 *
 * @param {{x: number, y: number}} fromCenter - Starting hex center.
 * @param {{x: number, y: number}[]} path - Array of hex centers (excluding start).
 * @param {Actor|null} [actor=null] - The moving actor.
 * @returns {{totalCost: number, costs: number[], passable: boolean, blockedIndex: number, reason: string|null}}
 */
export function calculatePathCost(fromCenter, path, actor = null) {
  if (path.length === 0) return { totalCost: 0, costs: [], passable: true, blockedIndex: -1, reason: null };

  const isFlying = actor?.hasTrait?.("Flying") ?? false;
  const isHover = actor?.hasTrait?.("Hover") ?? false;
  const isJumpCapable = actor?.hasTrait?.("Jump Capable") ?? false;
  const maxElevChange = isJumpCapable ? 2 : 1;
  const isUnitAirborne = isFlying && !(actor?.getFlag?.("star-mercs", "landed") ?? false);

  // Landed flying units cannot move
  if (isFlying && !isUnitAirborne) {
    return { totalCost: Infinity, costs: [], passable: false, blockedIndex: 0, reason: "Landed flying units cannot move — take off first." };
  }

  let totalCost = 0;
  const costs = [];
  let prevCenter = snapToHexCenter(fromCenter);

  for (let i = 0; i < path.length; i++) {
    const hexCenter = path[i];

    // Elevation restriction (airborne Flying exempt; Jump Capable allows ±2)
    if (!isUnitAirborne) {
      const prevElev = getHexElevation(prevCenter);
      const nextElev = getHexElevation(hexCenter);
      if (Math.abs(nextElev - prevElev) > maxElevChange) {
        return {
          totalCost,
          costs,
          passable: false,
          blockedIndex: i,
          reason: `Elevation change too steep (${prevElev} → ${nextElev}). Max difference is ${maxElevChange}.`
        };
      }
    }

    const { cost, passable, reason } = getMovementCost(hexCenter, actor);
    if (!passable) {
      return { totalCost, costs, passable: false, blockedIndex: i, reason };
    }

    costs.push(cost);
    totalCost += cost;
    prevCenter = hexCenter;
  }

  return { totalCost, costs, passable: true, blockedIndex: -1, reason: null };
}

/**
 * Get the last safe hex along a path (for losers of hex contests).
 * Returns the hex just before the contested hex.
 * @param {{x: number, y: number}[]} path - The full path.
 * @param {{x: number, y: number}} contestedHex - The contested destination.
 * @returns {{x: number, y: number}|null}
 */
export function getLastSafeHex(path, contestedHex) {
  const contestedKey = hexKey(snapToHexCenter(contestedHex));
  for (let i = path.length - 1; i >= 0; i--) {
    if (hexKey(path[i]) !== contestedKey) return path[i];
  }
  return null;
}
