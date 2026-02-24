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
  const neighbors = canvas.grid.getAdjacentPositions?.(center);
  if (!neighbors || neighbors.length === 0) return [];
  return neighbors.map(pos => snapToHexCenter(pos));
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
 * @param {Token} token - The moving token.
 * @param {{x: number, y: number}[]} path - Array of hex centers along the path.
 * @returns {{ valid: boolean, blockedAt: {x: number, y: number}|null, reason: string|null }}
 */
export function validatePath(token, path) {
  if (!token.actor || path.length === 0) return { valid: true, blockedAt: null, reason: null };

  const myTeam = token.actor.system.team ?? "a";

  for (let i = 0; i < path.length; i++) {
    const hexCenter = path[i];
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
    } else {
      // Intermediate hex: no enemy units allowed
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
