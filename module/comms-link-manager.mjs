import StarMercsActor from "./documents/actor.mjs";
import { checkLOS, getDetectionLevel } from "./detection.mjs";

/**
 * Manages communications link chains between units.
 *
 * Two units are linked if both are within each other's comms range (mutual).
 * Links chain transitively via Union-Find to form connected components.
 *
 * Special rule: Satellite Uplink units always link to Command units on the same team.
 *
 * Instantiated once on game.starmercs.commsLinkManager.
 */
export default class CommsLinkManager {

  constructor() {
    /** @private */
    this._cache = null;
    /** @private */
    this._cacheKey = null;
  }

  /* ---------------------------------------- */
  /*  Cache Management                        */
  /* ---------------------------------------- */

  /**
   * Rebuild the comms graph if the cache is stale.
   * Called automatically by all public query methods.
   */
  refresh() {
    const key = this._buildCacheKey();
    if (key === this._cacheKey) return;
    this._cacheKey = key;
    this._cache = this._buildGraph();
  }

  /**
   * Force a full cache rebuild on next query.
   */
  invalidate() {
    this._cacheKey = null;
    this._cache = null;
  }

  /**
   * Build a cache key from all unit token positions, comms values, and traits.
   * @returns {string}
   * @private
   */
  _buildCacheKey() {
    if (!canvas?.tokens?.placeables) return "";
    const parts = [];
    for (const token of canvas.tokens.placeables) {
      const actor = token.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;
      const hasCommand = actor.hasTrait("Command") ? 1 : 0;
      const hasSatUplink = actor.hasTrait("Satellite Uplink") ? 1 : 0;
      parts.push(`${token.id}:${Math.round(token.x)},${Math.round(token.y)}:${actor.system.comms}:${actor.system.team}:${hasCommand}:${hasSatUplink}`);
    }
    return parts.sort().join("|");
  }

  /* ---------------------------------------- */
  /*  Graph Building (Union-Find)             */
  /* ---------------------------------------- */

  /**
   * Build the full comms graph using Union-Find.
   * @returns {{
   *   directLinks: Array<{token1Id: string, token2Id: string, chainIndex: number}>,
   *   tokenChainMap: Map<string, number>,
   *   chainMembers: Map<number, Set<string>>,
   *   tokenTeamMap: Map<string, string>
   * }}
   * @private
   */
  _buildGraph() {
    const directLinks = [];
    const tokenChainMap = new Map();
    const chainMembers = new Map();
    const tokenTeamMap = new Map();

    if (!canvas?.tokens?.placeables) {
      return { directLinks, tokenChainMap, chainMembers, tokenTeamMap };
    }

    // Group tokens by team
    const tokensByTeam = new Map();
    for (const token of canvas.tokens.placeables) {
      const actor = token.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;
      const team = actor.system.team ?? "a";
      if (!tokensByTeam.has(team)) tokensByTeam.set(team, []);
      tokensByTeam.get(team).push(token);
      tokenTeamMap.set(token.id, team);
    }

    let globalChainIndex = 0;

    for (const [team, tokens] of tokensByTeam) {
      const n = tokens.length;

      // Union-Find initialization
      const parent = {};
      const rank = {};
      for (const t of tokens) {
        parent[t.id] = t.id;
        rank[t.id] = 0;
      }

      // Check all pairs for mutual comms range
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const tA = tokens[i];
          const tB = tokens[j];
          const commsA = tA.actor.system.comms ?? 0;
          const commsB = tB.actor.system.comms ?? 0;
          const distance = StarMercsActor.getHexDistance(tA, tB);

          // Mutual range: distance must be within BOTH units' comms range
          if (distance <= commsA && distance <= commsB) {
            directLinks.push({ token1Id: tA.id, token2Id: tB.id });
            this._ufUnion(parent, rank, tA.id, tB.id);
          }
        }
      }

      // Special rule: Satellite Uplink units auto-link to Command units
      const satUplinkTokens = tokens.filter(t => t.actor.hasTrait("Satellite Uplink"));
      const commandTokens = tokens.filter(t => t.actor.hasTrait("Command"));
      for (const sat of satUplinkTokens) {
        for (const cmd of commandTokens) {
          if (sat.id === cmd.id) continue;
          // Check if they're already linked (avoid duplicate direct links)
          const rootSat = this._ufFind(parent, sat.id);
          const rootCmd = this._ufFind(parent, cmd.id);
          if (rootSat !== rootCmd) {
            directLinks.push({ token1Id: sat.id, token2Id: cmd.id });
            this._ufUnion(parent, rank, sat.id, cmd.id);
          }
        }
      }

      // Extract connected components
      const components = new Map();
      for (const t of tokens) {
        const root = this._ufFind(parent, t.id);
        if (!components.has(root)) components.set(root, new Set());
        components.get(root).add(t.id);
      }

      for (const [, members] of components) {
        chainMembers.set(globalChainIndex, members);
        for (const memberId of members) {
          tokenChainMap.set(memberId, globalChainIndex);
        }
        globalChainIndex++;
      }
    }

    // Annotate direct links with their chain index
    const annotatedLinks = directLinks.map(link => ({
      ...link,
      chainIndex: tokenChainMap.get(link.token1Id) ?? 0
    }));

    return { directLinks: annotatedLinks, tokenChainMap, chainMembers, tokenTeamMap };
  }

  /* ---------------------------------------- */
  /*  Union-Find Helpers                      */
  /* ---------------------------------------- */

  /** @private */
  _ufFind(parent, x) {
    if (parent[x] !== x) parent[x] = this._ufFind(parent, parent[x]);
    return parent[x];
  }

  /** @private */
  _ufUnion(parent, rank, x, y) {
    const rx = this._ufFind(parent, x);
    const ry = this._ufFind(parent, y);
    if (rx === ry) return;
    if (rank[rx] < rank[ry]) {
      parent[rx] = ry;
    } else if (rank[rx] > rank[ry]) {
      parent[ry] = rx;
    } else {
      parent[ry] = rx;
      rank[rx]++;
    }
  }

  /* ---------------------------------------- */
  /*  Public Query API                        */
  /* ---------------------------------------- */

  /**
   * Get the set of all token IDs in the same comms chain as the given token.
   * @param {string} tokenId
   * @returns {Set<string>}
   */
  getChainForToken(tokenId) {
    this.refresh();
    if (!this._cache) return new Set([tokenId]);
    const chainIdx = this._cache.tokenChainMap.get(tokenId);
    if (chainIdx === undefined) return new Set([tokenId]);
    return this._cache.chainMembers.get(chainIdx) ?? new Set([tokenId]);
  }

  /**
   * Check if two tokens are in the same comms chain.
   * @param {string} tokenId1
   * @param {string} tokenId2
   * @returns {boolean}
   */
  isInChainWith(tokenId1, tokenId2) {
    this.refresh();
    if (!this._cache) return false;
    const c1 = this._cache.tokenChainMap.get(tokenId1);
    const c2 = this._cache.tokenChainMap.get(tokenId2);
    return c1 !== undefined && c1 === c2;
  }

  /**
   * Check if a token is isolated (no comms link to any other friendly unit).
   * @param {string} tokenId
   * @returns {boolean}
   */
  isIsolated(tokenId) {
    return this.getChainForToken(tokenId).size <= 1;
  }

  /**
   * Check if there is a Command unit anywhere in this token's comms chain.
   * @param {string} tokenId
   * @returns {boolean}
   */
  hasCommandInChain(tokenId) {
    const chain = this.getChainForToken(tokenId);
    for (const memberId of chain) {
      const memberToken = canvas?.tokens?.get(memberId);
      if (memberToken?.actor?.hasTrait("Command")) return true;
    }
    return false;
  }

  /**
   * Check if the target is visible to any unit in the firing unit's comms chain.
   * Uses StarMercsActor.hasLineOfSight() for each chain member.
   * @param {string} firingTokenId
   * @param {string} targetTokenId
   * @returns {boolean}
   */
  canSeeViaChain(firingTokenId, targetTokenId) {
    this.refresh();
    const chain = this.getChainForToken(firingTokenId);
    const targetCanvasToken = canvas?.tokens?.get(targetTokenId);
    if (!targetCanvasToken) return false;

    for (const memberId of chain) {
      const memberToken = canvas?.tokens?.get(memberId);
      if (!memberToken) continue;
      if (StarMercsActor.hasLineOfSight(memberToken, targetCanvasToken)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check airstrike visibility: comms chain LOS OR Satellite Uplink in chain.
   * Satellite Uplink grants unrestricted target acquisition for the chain.
   * @param {string} firingTokenId
   * @param {string} targetTokenId
   * @returns {boolean}
   */
  canSeeForAirstrike(firingTokenId, targetTokenId) {
    // Check if any unit in chain has Satellite Uplink (unrestricted targeting)
    const chain = this.getChainForToken(firingTokenId);
    for (const memberId of chain) {
      const memberToken = canvas?.tokens?.get(memberId);
      if (memberToken?.actor?.hasTrait("Satellite Uplink")) {
        return true;
      }
    }

    // Fall back to standard chain LOS check
    return this.canSeeViaChain(firingTokenId, targetTokenId);
  }

  /**
   * Check terrain-based LOS through comms chain (uses elevation/terrain blocking).
   * @param {string} firingTokenId
   * @param {string} targetTokenId
   * @returns {boolean}
   */
  canSeeViaChainTerrain(firingTokenId, targetTokenId) {
    this.refresh();
    const chain = this.getChainForToken(firingTokenId);
    const targetCanvasToken = canvas?.tokens?.get(targetTokenId);
    if (!targetCanvasToken) return false;

    for (const memberId of chain) {
      const memberToken = canvas?.tokens?.get(memberId);
      if (!memberToken) continue;
      if (checkLOS(memberToken.center, targetCanvasToken.center)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any unit in the comms chain can detect the target at "visible" level.
   * Used for indirect weapons: firing unit doesn't need personal detection if a
   * chain member can see the target.
   * @param {string} firingTokenId
   * @param {string} targetTokenId
   * @returns {boolean}
   */
  canDetectViaChain(firingTokenId, targetTokenId) {
    this.refresh();
    const chain = this.getChainForToken(firingTokenId);
    const targetCanvasToken = canvas?.tokens?.get(targetTokenId);
    if (!targetCanvasToken) return false;

    for (const memberId of chain) {
      if (memberId === firingTokenId) continue; // Skip the firing unit itself
      const memberToken = canvas?.tokens?.get(memberId);
      if (!memberToken) continue;
      const level = getDetectionLevel(memberToken, targetCanvasToken);
      if (level === "visible") return true;
    }
    return false;
  }

  /**
   * Check airstrike visibility using terrain-based LOS: chain LOS OR Satellite Uplink.
   * @param {string} firingTokenId
   * @param {string} targetTokenId
   * @returns {boolean}
   */
  canSeeForAirstrikeTerrain(firingTokenId, targetTokenId) {
    const chain = this.getChainForToken(firingTokenId);
    for (const memberId of chain) {
      const memberToken = canvas?.tokens?.get(memberId);
      if (memberToken?.actor?.hasTrait("Satellite Uplink")) {
        return true;
      }
    }
    return this.canSeeViaChainTerrain(firingTokenId, targetTokenId);
  }

  /**
   * Get all direct links for rendering.
   * @returns {Array<{token1Id: string, token2Id: string, chainIndex: number}>}
   */
  getDirectLinks() {
    this.refresh();
    return this._cache?.directLinks ?? [];
  }

  /**
   * Get the chain index for a given token (for color coding).
   * @param {string} tokenId
   * @returns {number}
   */
  getChainIndex(tokenId) {
    this.refresh();
    return this._cache?.tokenChainMap?.get(tokenId) ?? 0;
  }
}
