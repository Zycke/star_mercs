import StarMercsActor from "./actor.mjs";
import { esc } from "../helpers.mjs";
import { snapToHexCenter, hexKey, hexCenterFromKey, hexCenterToTokenPosition,
  getAdjacentHexCenters, getTokensAtHex, areAdjacent, getAdjacentEnemies, isEngaged,
  computeHexPath, validatePath, findBestAdjacentHex, getLastSafeHex,
  calculatePathCost, normalizeHexData, getStructureAtHex } from "../hex-utils.mjs";
import { getDetectionLevel, checkLOS } from "../detection.mjs";
import StructureLayer from "../canvas/structure-layer.mjs";

/**
 * Extended Combat class for Star Mercs that implements phase-based rounds.
 *
 * Each round cycles through 5 phases:
 *   deploy → preparation → orders → tactical → consolidation
 *
 * Phase state is stored via flags for v12 compatibility.
 * The GM advances phases using the "Next Turn" button in the combat tracker.
 */
export default class StarMercsCombat extends Combat {

  /** Ordered phase keys. */
  static PHASES = ["deploy", "preparation", "orders", "tactical", "consolidation"];

  /** Tactical sub-step definitions, executed in order during the tactical phase. */
  static TACTICAL_STEPS = [
    { key: "withdraw_morale",   label: "Withdraw Morale Checks" },
    { key: "artillery",         label: "Artillery Fire" },
    { key: "airstrikes",        label: "Air Strikes" },
    { key: "meteoric_landing",  label: "Meteoric Assault Landing" },
    { key: "weapons_fire",      label: "Weapons Fire" },
    { key: "assault_adjacent",  label: "Assault (Adjacent)" },
    { key: "movement",          label: "Unit Movement" },
    { key: "assault_move",      label: "Assault (Move & Attack)" },
    { key: "air_drop_landing",  label: "Air Drop Landing" },
    { key: "maneuver_fire",     label: "Maneuvering Unit Fire" }
  ];

  /** Per-phase permission rules. */
  static PHASE_RULES = {
    deploy:        { allowsMovement: false, allowsAttack: false },
    preparation:   { allowsMovement: false, allowsAttack: false },
    orders:        { allowsMovement: false, allowsAttack: false },
    tactical:      { allowsMovement: true,  allowsAttack: true  },
    consolidation: { allowsMovement: true,  allowsAttack: false }
  };

  /* ---------------------------------------- */
  /*  Accessors                               */
  /* ---------------------------------------- */

  /** Current phase key (e.g. "deploy"). */
  get phase() {
    return this.getFlag("star-mercs", "phase") || "deploy";
  }

  /** Current phase index (0–3). */
  get phaseIndex() {
    return this.getFlag("star-mercs", "phaseIndex") ?? 0;
  }

  /** Display name of the current phase. */
  get phaseLabel() {
    return CONFIG.STARMERCS.phases[this.phase] ?? this.phase;
  }

  /** Rules for the current phase. */
  get phaseRules() {
    return StarMercsCombat.PHASE_RULES[this.phase];
  }

  /* ---------------------------------------- */
  /*  Combat Lifecycle Overrides              */
  /* ---------------------------------------- */

  /** @override — Initialize phase to deploy when combat starts. */
  async startCombat() {
    await this.update({
      "flags.star-mercs.phase": "deploy",
      "flags.star-mercs.phaseIndex": 0
    });
    const result = await super.startCombat();
    this._announcePhase();
    this._refreshEngagementStatus();
    return result;
  }

  /** @override — Advance to the next phase; if all 4 done, advance round. */
  async nextTurn() {
    // Clear all player ready flags on phase/step advance
    for (const user of game.users) {
      if (user.getFlag("star-mercs", "combatReady")) {
        await user.unsetFlag("star-mercs", "combatReady");
      }
    }

    const currentIndex = this.phaseIndex;

    // If currently IN tactical, advance sub-step instead of phase
    if (currentIndex === 3) {
      const currentStep = this.getFlag("star-mercs", "tacticalStep") ?? 0;
      const nextStep = currentStep + 1;

      if (nextStep < StarMercsCombat.TACTICAL_STEPS.length) {
        await this.setFlag("star-mercs", "tacticalStep", nextStep);
        await this._executeTacticalStep(nextStep);
        return this;
      }

      // All tactical steps done — proceed to consolidation
      await this._runConsolidationEffects();
      await this.update({
        "flags.star-mercs.phase": "consolidation",
        "flags.star-mercs.phaseIndex": 4
      });
      this._announcePhase();
      return this;
    }

    const nextIndex = currentIndex + 1;

    // Entering preparation — run preparation effects
    if (nextIndex === 1) {
      await this._runPreparationEffects();
    }

    // Entering tactical — start sub-step sequence
    if (nextIndex === 3) {
      // Apply assault +1 incoming damage flag at the start of tactical phase
      await this._applyAssaultIncomingDamageFlags();

      // Save current turn's damage as "previous turn" for combat summary display
      const currentDealt = this.getFlag("star-mercs", "damageDealtThisTurn");
      const currentTaken = this.getFlag("star-mercs", "damageTakenThisTurn");
      if (currentDealt) await this.setFlag("star-mercs", "damageDealtPrevTurn", currentDealt);
      else await this.unsetFlag("star-mercs", "damageDealtPrevTurn");
      if (currentTaken) await this.setFlag("star-mercs", "damageTakenPrevTurn", currentTaken);
      else await this.unsetFlag("star-mercs", "damageTakenPrevTurn");

      // Clear damage dealt tracking from current turn
      await this.unsetFlag("star-mercs", "damageDealtThisTurn");

      await this.update({
        "flags.star-mercs.phase": "tactical",
        "flags.star-mercs.phaseIndex": 3,
        "flags.star-mercs.tacticalStep": 0
      });
      this._announcePhase();
      await this._executeTacticalStep(0);
      return this;
    }

    // Leaving consolidation — clear targets, destinations, orders
    if (currentIndex === 4) {
      await this._runConsolidationCleanup();
    }

    // Entering consolidation — apply damage, readiness costs, supply consumption
    if (nextIndex === 4) {
      await this._runConsolidationEffects();
    }

    // All phases done — next round resets to preparation
    if (nextIndex >= StarMercsCombat.PHASES.length) {
      return this.nextRound();
    }

    // Advance to next phase
    const nextPhase = StarMercsCombat.PHASES[nextIndex];
    await this.update({
      "flags.star-mercs.phase": nextPhase,
      "flags.star-mercs.phaseIndex": nextIndex
    });
    this._announcePhase();

    // Return the combat object (skip super.nextTurn which cycles combatant turns)
    return this;
  }

  /** @override — New round resets to deploy phase, or skips it if pool is empty. */
  async nextRound() {
    // Check if deploy pool has any entries
    const pool = game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] };
    const poolHasEntries = (pool.a?.length > 0) || (pool.b?.length > 0);

    // After round 1, skip deploy phase if pool is empty
    const nextRoundNum = this.round + 1;
    if (nextRoundNum > 1 && !poolHasEntries) {
      await this.update({
        "flags.star-mercs.phase": "preparation",
        "flags.star-mercs.phaseIndex": 1
      });
      const result = await super.nextRound();
      // Run preparation effects
      await this._runPreparationEffects();
      this._announcePhase();
      this._refreshEngagementStatus();
      return result;
    }

    await this.update({
      "flags.star-mercs.phase": "deploy",
      "flags.star-mercs.phaseIndex": 0
    });
    const result = await super.nextRound();
    this._announcePhase();
    this._refreshEngagementStatus();
    return result;
  }

  /** @override — Previous round resets to deploy phase. */
  async previousRound() {
    await this.update({
      "flags.star-mercs.phase": "deploy",
      "flags.star-mercs.phaseIndex": 0
    });
    return super.previousRound();
  }

  /** @override — Go back one phase within the current round. */
  async previousTurn() {
    const currentIndex = this.phaseIndex;
    if (currentIndex <= 0) return this;

    const prevIndex = currentIndex - 1;
    const prevPhase = StarMercsCombat.PHASES[prevIndex];
    await this.update({
      "flags.star-mercs.phase": prevPhase,
      "flags.star-mercs.phaseIndex": prevIndex
    });
    this._announcePhase();
    return this;
  }

  /** @override — Clean up firing blips when combat ends. */
  async endCombat() {
    const { default: FiringBlipLayer } = await import("../canvas/firing-blip-layer.mjs");
    await FiringBlipLayer.clearAllFiringBlips();
    return super.endCombat();
  }

  /* ---------------------------------------- */
  /*  Phase Enforcement                       */
  /* ---------------------------------------- */

  /**
   * Check whether movement is allowed for a given actor.
   * @param {StarMercsActor} actor
   * @returns {{allowed: boolean, reason: string|null}}
   */
  canMove(actor) {
    const rules = this.phaseRules;

    if (!rules.allowsMovement) {
      return {
        allowed: false,
        reason: `Movement is not allowed during the ${this.phaseLabel} phase.`
      };
    }

    // Deploy-trait units: deployed or deploying cannot move
    if (actor?.type === "unit" && actor.hasTrait("Deploy")) {
      const dState = actor.deployState;
      if (dState === "deployed" || dState === "deploying") {
        return {
          allowed: false,
          reason: "Deployed units cannot move. Must pack up first."
        };
      }
    }

    // Tactical phase: check the unit's current order
    if (this.phase === "tactical" && actor?.type === "unit") {
      const order = this._getActorOrder(actor);
      if (order && !order.system.allowsMovement) {
        return {
          allowed: false,
          reason: `${order.name} order does not allow movement.`
        };
      }
    }

    // Consolidation phase: only withdraw and assault retreat movement allowed
    if (this.phase === "consolidation" && actor?.type === "unit") {
      const order = actor.system.currentOrder;
      const token = actor.getActiveTokens()?.[0]?.document;
      const isAssaultRetreat = token?.getFlag("star-mercs", "assaultRetreat") ?? false;
      if (order !== "withdraw" && !isAssaultRetreat) {
        return {
          allowed: false,
          reason: "Only withdraw and assault retreat movement allowed during consolidation."
        };
      }
    }

    return { allowed: true, reason: null };
  }

  /**
   * Check whether attacks are allowed for a given actor.
   * @param {StarMercsActor} actor
   * @returns {{allowed: boolean, reason: string|null}}
   */
  canAttack(actor) {
    const rules = this.phaseRules;

    if (!rules.allowsAttack) {
      return {
        allowed: false,
        reason: `Attacks are not allowed during the ${this.phaseLabel} phase.`
      };
    }

    // Deploy-trait units: packed or packing cannot fire
    if (actor?.type === "unit" && actor.hasTrait("Deploy")) {
      const dState = actor.deployState;
      if (dState === "packed" || dState === "packing") {
        return {
          allowed: false,
          reason: "Packed units cannot fire. Must deploy first."
        };
      }
    }

    // Tactical phase: check the unit's current order
    if (this.phase === "tactical" && actor?.type === "unit") {
      const order = this._getActorOrder(actor);
      if (order && !order.system.allowsAttack) {
        return {
          allowed: false,
          reason: `${order.name} order does not allow attacks.`
        };
      }
    }

    return { allowed: true, reason: null };
  }

  /* ---------------------------------------- */
  /*  Pending Damage                          */
  /* ---------------------------------------- */

  /**
   * Add pending damage to a token (deferred until consolidation).
   * @param {TokenDocument} tokenDoc - The target token document.
   * @param {number} strengthDamage - Strength damage to apply.
   * @param {number} readinessLoss - Readiness loss to apply.
   * @param {string} sourceName - Name of the attacking unit (for display).
   * @param {string} weaponName - Name of the weapon (for display).
   */
  async addPendingDamage(tokenDoc, strengthDamage, readinessLoss, sourceName, weaponName) {
    const existing = tokenDoc.getFlag("star-mercs", "pendingDamage") ?? {
      strength: 0, readiness: 0, hits: []
    };
    existing.strength += strengthDamage;
    existing.readiness += readinessLoss;
    existing.hits.push({ source: sourceName, weapon: weaponName, damage: strengthDamage, readinessLoss });
    await tokenDoc.setFlag("star-mercs", "pendingDamage", existing);

    // Track damage dealt by attacker for combat summary
    if (strengthDamage > 0) {
      const dealt = foundry.utils.deepClone(this.getFlag("star-mercs", "damageDealtThisTurn") ?? {});
      dealt[sourceName] = (dealt[sourceName] ?? 0) + strengthDamage;
      await this.setFlag("star-mercs", "damageDealtThisTurn", dealt);
    }
  }

  /* ---------------------------------------- */
  /*  Internal Helpers                        */
  /* ---------------------------------------- */

  /**
   * Look up the actor's currently assigned order from config.
   * Returns a shape compatible with the previous item-based lookup.
   * @param {StarMercsActor} actor
   * @returns {{key: string, name: string, system: object}|null}
   * @private
   */
  _getActorOrder(actor) {
    const orderKey = actor.system.currentOrder;
    if (!orderKey) return null;
    const orderData = CONFIG.STARMERCS.orders?.[orderKey];
    if (!orderData) return null;
    return {
      key: orderKey,
      name: orderData.label,
      system: orderData
    };
  }

  /**
   * Get user IDs to whisper a chat message to for a given team.
   * Includes GM users and all players assigned to the specified team.
   * @param {string} team - Team key ("a" or "b").
   * @returns {string[]} Array of user IDs.
   */
  static getTeamWhisperIds(team) {
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    return game.users.filter(u => u.isGM || assignments[u.id] === team).map(u => u.id);
  }

  /**
   * Get user IDs to whisper a chat message to for both teams (e.g. attack results).
   * @param {string} teamA - First team key.
   * @param {string} teamB - Second team key.
   * @returns {string[]} Array of user IDs.
   */
  static getBothTeamsWhisperIds(teamA, teamB) {
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    return game.users.filter(u => u.isGM || assignments[u.id] === teamA || assignments[u.id] === teamB).map(u => u.id);
  }

  /**
   * Post a chat message announcing the current phase.
   * @private
   */
  _announcePhase() {
    ChatMessage.create({
      content: `<div class="star-mercs phase-announcement">
        <h3><i class="fas fa-flag"></i> Round ${this.round} &mdash; ${this.phaseLabel}</h3>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /**
   * Parse a supply modifier string (e.g., "1x", "2x") into a numeric multiplier.
   * @param {string} mod - The modifier string.
   * @returns {number} The numeric multiplier.
   * @private
   */
  _parseSupplyMultiplier(mod) {
    if (!mod) return 1;
    const match = mod.match(/^(\d+)x$/i);
    return match ? parseInt(match[1]) : 1;
  }

  /**
   * Preparation phase effects: runs at the start of each new round.
   * - Recharge energy for all units (increase by rechargeRate, cap at capacity).
   * @private
   */
  async _runPreparationEffects() {
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;

      // Energy recharge
      const energy = actor.system.supply?.energy;
      if (energy) {
        const rate = energy.rechargeRate ?? 0;
        if (rate > 0 && energy.current < energy.capacity) {
          const newEnergy = Math.min(energy.current + rate, energy.capacity);
          await actor.update({ "system.supply.energy.current": newEnergy });

          const recharged = newEnergy - energy.current;
          const token = combatant.token;
          const unitName = token?.name ?? actor.name;
          const unitTeam = actor.system.team ?? "a";
          await ChatMessage.create({
            content: `<div class="star-mercs chat-card"><div class="summary-header"><i class="fas fa-bolt"></i> <strong>${unitName}</strong> — Energy recharged +${recharged} (${newEnergy}/${energy.capacity})</div></div>`,
            speaker: { alias: "Star Mercs" },
            whisper: StarMercsCombat.getTeamWhisperIds(unitTeam)
          });
        }
      }

      // Reset APS/ZPS interception fire counts (diminishing returns reset each turn)
      if (actor.getFlag("star-mercs", "interceptionCounts")) {
        await actor.unsetFlag("star-mercs", "interceptionCounts");
      }

      // (Auto-landing for 0 fuel now happens in consolidation phase, after fuel consumption)
    }
  }

  /**
   * Consolidation effects: runs at the BEGINNING of consolidation phase.
   * 1. Apply all pending damage to targets (track damage taken per token)
   * 2. Deduct readiness costs from orders
   * 3. Extra -1 readiness for Disordered units (failed withdraw morale)
   * 4. Consume supply (fuel + basic supplies; ammo consumed on fire)
   * 5. Morale checks for units with readiness < 10
   * 6. Assault morale resolution
   * @private
   */
  async _runConsolidationEffects() {
    // Track damage taken per token ID for morale modifiers
    const damageTakenMap = new Map();

    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const token = combatant.token;
      const unitName = token?.name ?? actor.name;

      // Accumulate HTML sections for this unit's combined card
      const sections = [];

      // 1. Apply pending damage and record how much each unit took
      if (token) {
        const pending = token.getFlag("star-mercs", "pendingDamage");
        if (pending && (pending.strength > 0 || pending.readiness > 0)) {
          const newStrength = Math.max(0, actor.system.strength.value - pending.strength);
          const newReadiness = Math.max(0, actor.system.readiness.value - pending.readiness);
          await actor.update({
            "system.strength.value": newStrength,
            "system.readiness.value": newReadiness
          });

          // Record damage taken for morale modifier
          damageTakenMap.set(token.id, pending.strength);

          const destroyed = newStrength <= 0;
          let statusText = `STR ${newStrength} | RDY ${newReadiness}`;
          if (destroyed) statusText = "DESTROYED";

          // Log damage to unit's history
          const hitsDesc = pending.hits?.map(h => `${h.source} (${h.weapon})`).join(", ") ?? "unknown";
          await actor.addLogEntry(`Took -${pending.strength} STR, -${pending.readiness} RDY from: ${hitsDesc}`, "damage");

          // Damage applied section removed from chat (visible in combat summary)

          await token.unsetFlag("star-mercs", "pendingDamage");
        }
      }

      // 1a-post. Cargo rout prevention: cargo aboard a transport cannot rout (readiness floor = 1)
      if (actor.isAboardTransport() && actor.system.readiness.value <= 0 && actor.system.strength.value > 0) {
        await actor.update({ "system.readiness.value": 1 });
      }

      // 1b. Transport cargo damage propagation
      // If this unit is a transport with cargo, propagate proportional damage to cargo
      if (token && actor.hasCargoAboard()) {
        const preStrength = token.getFlag("star-mercs", "preTransportStrength");
        if (preStrength && preStrength > 0) {
          const currentStrength = actor.system.strength.value;
          const pctLost = (preStrength - currentStrength) / preStrength;

          if (currentStrength <= 0) {
            // Transport destroyed — cargo is completely destroyed
            await actor.destroyCargo();
            sections.push(`<div class="consolidation-section damage">
              <div class="consolidation-section-header"><i class="fas fa-skull-crossbones"></i> Cargo Destroyed</div>
              <div class="status-update">Transport destroyed — cargo unit destroyed with it.</div>
            </div>`);
          } else if (pctLost > 0) {
            // Proportional damage to cargo
            const cargoActor = actor.getCargoActor();
            if (cargoActor) {
              const cargoDamage = Math.floor(cargoActor.system.strength.max * pctLost);
              if (cargoDamage > 0) {
                const newCargoStr = Math.max(0, cargoActor.system.strength.value - cargoDamage);
                await cargoActor.update({ "system.strength.value": newCargoStr });
                sections.push(`<div class="consolidation-section damage">
                  <div class="consolidation-section-header"><i class="fas fa-box"></i> Cargo Damaged</div>
                  <div class="status-update">${esc(cargoActor.name)}: -${cargoDamage} STR (${Math.round(pctLost * 100)}% transport damage)</div>
                </div>`);
              }
            }
          }

          // Update preTransportStrength for next turn
          if (currentStrength > 0) {
            await token.setFlag("star-mercs", "preTransportStrength", currentStrength);
          }
        }
      }

      // 1c. Execute transport load/unload orders
      if (token && actor.system.currentOrder === "transport") {
        const transportAction = token.getFlag("star-mercs", "transportAction");
        const transportTargetId = token.getFlag("star-mercs", "transportTargetId");

        if (transportAction === "load" && transportTargetId) {
          const cargoToken = canvas?.tokens?.get(transportTargetId);
          if (cargoToken) {
            const success = await actor.loadCargo(cargoToken);
            if (success) {
              sections.push(`<div class="consolidation-section supply">
                <div class="consolidation-section-header"><i class="fas fa-arrow-down"></i> Cargo Loaded</div>
                <div class="status-update">${esc(cargoToken.name)} loaded aboard ${esc(unitName)}.</div>
              </div>`);
            }
          }
        } else if (transportAction === "unload" && transportTargetId) {
          // transportTargetId is a hex key — resolve to canvas coordinates
          {
            const targetCenter = hexCenterFromKey(transportTargetId);
            if (targetCenter) {
              const cargoActor = actor.getCargoActor();
              const cargoName = cargoActor?.name ?? "cargo";
              // Offset to top-left for token placement
              const gridSize = canvas.grid.size ?? 100;
              const targetPos = { x: targetCenter.x - gridSize / 2, y: targetCenter.y - gridSize / 2 };
              const success = await actor.unloadCargo(targetPos);
              if (success) {
                sections.push(`<div class="consolidation-section supply">
                  <div class="consolidation-section-header"><i class="fas fa-arrow-up"></i> Cargo Unloaded</div>
                  <div class="status-update">${esc(cargoName)} unloaded from ${esc(unitName)}.</div>
                </div>`);
              }
            }
          }
        }

        // Clean up transport order flags
        await token.unsetFlag("star-mercs", "transportAction");
        await token.unsetFlag("star-mercs", "transportTargetId");
      }

      // 1d. Execute Air Assault order
      if (token && actor.system.currentOrder === "air_assault") {
        const targetHex = token.getFlag("star-mercs", "airAssaultTargetHex");
        const targetTokenId = token.getFlag("star-mercs", "airAssaultTargetTokenId");

        if (targetHex && actor.hasCargoAboard()) {
          const targetCenter = hexCenterFromKey(targetHex);
          if (targetCenter) {
            // Land the transport adjacent to the target hex
            await actor.land();

            // Unload cargo into the target hex
            const cargoActor = actor.getCargoActor();
            const cargoName = cargoActor?.name ?? "cargo";
            const gridSize = canvas.grid.size ?? 100;
            const targetPos = { x: targetCenter.x - gridSize / 2, y: targetCenter.y - gridSize / 2 };
            const success = await actor.unloadCargo(targetPos);

            if (success && cargoActor) {
              // Apply air-assault status effect for shock bonus
              const airAssaultEffect = cargoActor.effects.find(e => e.statuses?.has("air-assault"));
              if (!airAssaultEffect) {
                await cargoActor.createEmbeddedDocuments("ActiveEffect", [{
                  name: "Air Assault",
                  img: "icons/svg/combat.svg",
                  statuses: ["air-assault"]
                }]);
              }

              // Set cargo's order to assault and store the assault target
              await cargoActor.update({ "system.currentOrder": "assault" });
              const cargoToken = cargoActor.getActiveTokens()?.[0];
              if (cargoToken && targetTokenId) {
                await cargoToken.document.setFlag("star-mercs", "assaultTarget", targetTokenId);
              }

              sections.push(`<div class="consolidation-section supply">
                <div class="consolidation-section-header"><i class="fas fa-fighter-jet"></i> Air Assault</div>
                <div class="status-update">${esc(cargoName)} deployed via Air Assault! Assaulting target hex.</div>
              </div>`);
            }
          }
        }

        // Clean up air assault flags
        await token.unsetFlag("star-mercs", "airAssaultTargetHex");
        await token.unsetFlag("star-mercs", "airAssaultTargetTokenId");
      }

      // 1e. Execute Hot Disembark order
      if (token && actor.system.currentOrder === "hot_disembark" && actor.hasCargoAboard()) {
        // Transport should have already moved to destination via movement phase
        // Now unload cargo to adjacent empty hex
        const myCenter = snapToHexCenter(token.center ?? { x: token.x, y: token.y });
        const adjacentCenters = getAdjacentHexCenters(myCenter);

        // Find first adjacent empty hex
        const occupiedKeys = new Set();
        for (const t of canvas.tokens.placeables) {
          if (!t.actor || t.actor.type !== "unit") continue;
          if (t.actor.system.strength.value <= 0) continue;
          const cargoTokenId = token.getFlag("star-mercs", "cargoTokenId");
          if (t.id === cargoTokenId) continue;
          occupiedKeys.add(hexKey(snapToHexCenter(t.center)));
        }

        const emptyAdj = adjacentCenters.find(adj => !occupiedKeys.has(hexKey(adj)));
        if (emptyAdj) {
          const cargoActor = actor.getCargoActor();
          const cargoName = cargoActor?.name ?? "cargo";
          const gridSize = canvas.grid.size ?? 100;
          const targetPos = { x: emptyAdj.x - gridSize / 2, y: emptyAdj.y - gridSize / 2 };
          const success = await actor.unloadCargo(targetPos);

          if (success && cargoActor) {
            // Apply readiness penalty to cargo (-3)
            const cargoRdy = cargoActor.system.readiness.value;
            await cargoActor.update({
              "system.readiness.value": Math.max(0, cargoRdy - 3)
            });

            // Set hotDisembarked flag so cargo can fire at -1 accuracy
            const cargoToken = cargoActor.getActiveTokens()?.[0];
            if (cargoToken) {
              await cargoToken.document.setFlag("star-mercs", "hotDisembarked", true);
            }

            sections.push(`<div class="consolidation-section supply">
              <div class="consolidation-section-header"><i class="fas fa-parachute-box"></i> Hot Disembark</div>
              <div class="status-update">${esc(cargoName)} hot-disembarked! -3 RDY, may fire at -1 accuracy.</div>
            </div>`);
          }
        } else {
          sections.push(`<div class="consolidation-section damage">
            <div class="consolidation-section-header"><i class="fas fa-exclamation-triangle"></i> Hot Disembark Failed</div>
            <div class="status-update">No adjacent empty hexes — cargo remains aboard.</div>
          </div>`);
        }

        // Hot Disembark transport effects: extra consumable (+1 MP worth)
        const fuelPerMP = actor.system.fuelPerMP ?? 0;
        const hotConsumableType = actor.system.movementConsumable ?? "fuel";
        if (fuelPerMP > 0 && hotConsumableType !== "none") {
          const hotConsumableKey = hotConsumableType; // "fuel" or "energy"
          const hotConsumableLabel = hotConsumableType === "energy" ? "Energy" : "Fuel";
          const currentVal = actor.system.supply?.[hotConsumableKey]?.current ?? 0;
          if (currentVal > 0) {
            await actor.update({
              [`system.supply.${hotConsumableKey}.current`]: Math.max(0, currentVal - fuelPerMP)
            });
            sections.push(`<div class="consolidation-section supply">
              <div class="consolidation-section-header"><i class="fas fa-gas-pump"></i> Evasive Maneuver ${hotConsumableLabel}</div>
              <div class="status-update">-${fuelPerMP} ${hotConsumableLabel.toLowerCase()} (evasive maneuvers)</div>
            </div>`);
          }
        }

        // Set evasive flag on transport (attackers -1 to hit)
        await token.setFlag("star-mercs", "hotDisembarkEvasive", true);

        // Land the transport
        await actor.land();
      }

      // 2. Deduct readiness cost from the unit's current order
      // Airborne flying units cannot gain readiness (positive cost) from orders
      const order = this._getActorOrder(actor);
      const supplyMod = order ? this._parseSupplyMultiplier(order.system.supplyModifier) : 1;
      if (order && order.system.readinessCost !== 0) {
        const cost = order.system.readinessCost;
        // Block positive readiness gains for airborne units
        if (cost > 0 && actor.isAirborne) {
          // Airborne readiness block — no chat card (visible in combat summary)
        } else {
          const currentRdy = actor.system.readiness.value;
          const newRdy = Math.max(0, Math.min(actor.system.readiness.max, currentRdy + cost));
          if (newRdy !== currentRdy) {
            await actor.update({ "system.readiness.value": newRdy });
            // Readiness update removed from chat (visible in combat summary)
          }
        }
      }

      // 2b. Entrench: grant Entrenched trait if unit stayed in same hex
      if (order && order.key === "entrench") {
        const movementUsed = token ? (token.getFlag("star-mercs", "movementUsed") ?? 0) : 0;
        if (movementUsed === 0) {
          const entrenchedTrait = actor.items.find(
            i => i.type === "trait" && i.name.toLowerCase() === "entrenched"
          );
          if (entrenchedTrait && !entrenchedTrait.system.active) {
            await entrenchedTrait.update({ "system.active": true });
            sections.push(`<div class="consolidation-section entrench">
              <div class="consolidation-section-header"><i class="fas fa-shield-alt"></i> Gained Entrenched</div>
            </div>`);
          }
        }
      }

      // 2c. Structure Fortified: grant Fortified from completed structures
      if (token) {
        const tokenHex = snapToHexCenter(canvas.tokens.get(token.id)?.center ?? { x: 0, y: 0 });
        const structureAtHex = getStructureAtHex(tokenHex);
        if (structureAtHex && structureAtHex.turnsBuilt >= structureAtHex.turnsRequired
            && structureAtHex.strength > 0) {
          const sConfig = CONFIG.STARMERCS.structures[structureAtHex.type];
          if (sConfig?.grantsFortified) {
            const fortifiedTrait = actor.items.find(
              i => i.type === "trait" && i.name.toLowerCase() === "fortified"
            );
            if (fortifiedTrait && !fortifiedTrait.system.active) {
              await fortifiedTrait.update({ "system.active": true });
              sections.push(`<div class="consolidation-section entrench">
                <div class="consolidation-section-header"><i class="fas fa-shield-alt"></i> Fortified (${esc(sConfig.label)})</div>
              </div>`);
            }
          }
        }
      }

      // 2c. Deploy/Pack timer: decrement and finalize transitions
      if (actor.hasTrait("Deploy")) {
        const dState = actor.getFlag("star-mercs", "deployState");
        const dTimer = actor.getFlag("star-mercs", "deployTimer") ?? 0;

        if ((dState === "deploying" || dState === "packing") && dTimer > 0) {
          const newTimer = dTimer - 1;
          if (newTimer <= 0) {
            // Transition complete
            const newState = dState === "deploying" ? "deployed" : "packed";
            await actor.setFlag("star-mercs", "deployState", newState);
            await actor.setFlag("star-mercs", "deployTimer", 0);
            // Swap status effects
            const removeEffect = newState === "deployed" ? "packed" : "deployed";
            await actor.toggleStatusEffect(removeEffect, { active: false });
            await actor.toggleStatusEffect(newState, { active: true });
            const dLabel = newState === "deployed" ? "Deployment complete" : "Packing complete";
            sections.push(`<div class="consolidation-section deploy-state">
              <div class="consolidation-section-header"><i class="fas fa-cog"></i> ${dLabel}</div>
            </div>`);
          } else {
            await actor.setFlag("star-mercs", "deployTimer", newTimer);
            const verb = dState === "deploying" ? "Deploying" : "Packing";
            sections.push(`<div class="consolidation-section deploy-state">
              <div class="consolidation-section-header"><i class="fas fa-hourglass-half"></i> ${verb}: ${newTimer} turn${newTimer > 1 ? "s" : ""} remaining</div>
            </div>`);
          }
        }
      }

      // 2d. Construction progress (construct order)
      if (token && order && order.key === "construct") {
        const movementUsed = token.getFlag("star-mercs", "movementUsed") ?? 0;
        if (movementUsed === 0) {
          const target = token.getFlag("star-mercs", "constructionTarget");
          if (target) {
            const merged = StructureLayer.getStructureConfig(target.type);
            if (merged) {
              const matCost = merged.materialsPerTurn ?? 1;
              const currentMats = actor.system.supply?.materials?.current ?? 0;

              if (currentMats < matCost) {
                sections.push(`<div class="consolidation-section construction">
                  <div class="consolidation-section-header"><i class="fas fa-exclamation-triangle"></i> Construction Paused</div>
                  <div class="status-update">Insufficient materials (need ${matCost}, have ${currentMats}).</div>
                </div>`);
              } else {
                // Deduct materials
                await actor.update({ "system.supply.materials.current": currentMats - matCost });

                // Find or create the structure
                const structures = canvas.scene.getFlag("star-mercs", "structures") ?? [];
                let structure = structures.find(
                  s => s.hexKey === target.targetHexKey && s.builderId === token.id
                );
                if (!structure) {
                  // Create new structure
                  const [xStr, yStr] = target.targetHexKey.split(",");
                  structure = {
                    id: foundry.utils.randomID(),
                    hexKey: target.targetHexKey,
                    x: parseFloat(xStr),
                    y: parseFloat(yStr),
                    type: target.type,
                    name: null,
                    team: actor.system.team ?? "a",
                    strength: merged.maxStrength,
                    maxStrength: merged.maxStrength,
                    turnsBuilt: 0,
                    turnsRequired: merged.turnsRequired,
                    revealed: false,
                    builderId: token.id,
                    subType: target.subType ?? null,
                    supply: null,
                    commsRange: null,
                    supplyRange: null,
                    autoSupply: true
                  };
                  // Outpost-specific fields
                  if (target.type === "outpost") {
                    structure.commsRange = merged.defaultCommsRange ?? 5;
                    structure.supplyRange = merged.defaultSupplyRange ?? 3;
                    const caps = merged.defaultSupplyCapacity ?? {};
                    structure.supply = {};
                    for (const cat of ["projectile", "ordnance", "energy", "fuel", "materials", "parts", "basicSupplies"]) {
                      structure.supply[cat] = { current: 0, capacity: caps[cat] ?? 0 };
                    }
                  }
                  structures.push(structure);
                }

                // Increment build progress
                structure.turnsBuilt = (structure.turnsBuilt ?? 0) + 1;

                if (structure.turnsBuilt >= structure.turnsRequired) {
                  // Construction complete
                  structure.builderId = null;
                  await token.unsetFlag("star-mercs", "constructionTarget");
                  const sLabel = structure.name ?? CONFIG.STARMERCS.structures[target.type]?.label ?? target.type;
                  sections.push(`<div class="consolidation-section construction">
                    <div class="consolidation-section-header"><i class="fas fa-check-circle"></i> Construction Complete!</div>
                    <div class="status-update">${esc(sLabel)} built at ${target.targetHexKey}.</div>
                  </div>`);

                  // Bridge completion: set bridge flag on terrain hex data
                  if (target.type === "bridge") {
                    const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap") ?? {};
                    const tKey = target.targetHexKey;
                    if (terrainMap[tKey]) {
                      terrainMap[tKey] = typeof terrainMap[tKey] === "string"
                        ? { type: terrainMap[tKey], elevation: 0, bridge: true }
                        : { ...terrainMap[tKey], bridge: true };
                      await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
                    }
                  }
                } else {
                  sections.push(`<div class="consolidation-section construction">
                    <div class="consolidation-section-header"><i class="fas fa-hammer"></i> Construction Progress</div>
                    <div class="status-update">${structure.turnsBuilt}/${structure.turnsRequired} turns complete.</div>
                  </div>`);
                }

                await canvas.scene.setFlag("star-mercs", "structures", structures);
              }
            }
          }
        } else {
          sections.push(`<div class="consolidation-section construction">
            <div class="consolidation-section-header"><i class="fas fa-exclamation-triangle"></i> Construction Paused</div>
            <div class="status-update">Unit moved this turn — no construction progress.</div>
          </div>`);
        }
      }

      // 2e. Demolish order execution
      if (token && order && order.key === "demolish") {
        const movementUsed = token.getFlag("star-mercs", "movementUsed") ?? 0;
        if (movementUsed === 0) {
          const demolishTarget = token.getFlag("star-mercs", "demolishTarget");
          if (demolishTarget?.structureId) {
            const structures = canvas.scene.getFlag("star-mercs", "structures") ?? [];
            const idx = structures.findIndex(s => s.id === demolishTarget.structureId);
            if (idx !== -1) {
              const demolished = structures[idx];
              const sConfig = CONFIG.STARMERCS.structures[demolished.type];
              structures.splice(idx, 1);
              if (structures.length === 0) {
                await canvas.scene.unsetFlag("star-mercs", "structures");
              } else {
                await canvas.scene.setFlag("star-mercs", "structures", structures);
              }
              // Clear bridge terrain flag when bridge is demolished
              if (demolished.type === "bridge" && demolished.hexKey) {
                const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap") ?? {};
                if (terrainMap[demolished.hexKey]) {
                  const hexData = typeof terrainMap[demolished.hexKey] === "string"
                    ? { type: terrainMap[demolished.hexKey], elevation: 0 }
                    : { ...terrainMap[demolished.hexKey] };
                  delete hexData.bridge;
                  terrainMap[demolished.hexKey] = hexData;
                  await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
                }
              }
              await token.unsetFlag("star-mercs", "demolishTarget");
              sections.push(`<div class="consolidation-section demolish">
                <div class="consolidation-section-header"><i class="fas fa-hammer"></i> Structure Demolished</div>
                <div class="status-update">${esc(sConfig?.label ?? demolished.type)} destroyed.</div>
              </div>`);
            }
          }
        }
      }

      // 2f. Advanced Sensors — reveal hidden minefields within range
      if (token) {
        const advSensors = actor.items.find(
          i => i.type === "trait" && /^Advanced Sensors/i.test(i.name)
        );
        if (advSensors) {
          const match = advSensors.name.match(/\[(\d+)\]/);
          const revealRange = match ? parseInt(match[1]) : 0;
          if (revealRange > 0) {
            const unitCenter = snapToHexCenter(canvas.tokens.get(token.id)?.center ?? { x: 0, y: 0 });
            const sensorStructures = canvas.scene.getFlag("star-mercs", "structures") ?? [];
            let revealedAny = false;
            for (const s of sensorStructures) {
              if (s.type !== "minefield" || s.revealed) continue;
              if (s.turnsBuilt < s.turnsRequired) continue;
              const dx = unitCenter.x - s.x;
              const dy = unitCenter.y - s.y;
              const pixelDist = Math.sqrt(dx * dx + dy * dy);
              const hexDist = Math.round(pixelDist / (canvas.grid.size || 100));
              if (hexDist <= revealRange) {
                s.revealed = true;
                revealedAny = true;
              }
            }
            if (revealedAny) {
              await canvas.scene.setFlag("star-mercs", "structures", sensorStructures);
              sections.push(`<div class="consolidation-section sensors">
                <div class="consolidation-section-header"><i class="fas fa-satellite-dish"></i> Minefield Detected!</div>
                <div class="status-update">Advanced Sensors revealed nearby minefields.</div>
              </div>`);
            }
          }
        }
      }

      // 2g. Outpost capture — enemy unit on capturable structure with no defenders
      if (token) {
        const unitTeam = actor.system.team ?? "a";
        const unitCenter = snapToHexCenter(canvas.tokens.get(token.id)?.center ?? { x: 0, y: 0 });
        const captureStructures = canvas.scene.getFlag("star-mercs", "structures") ?? [];
        const capturable = captureStructures.find(s => {
          if (!s.hexKey || s.hexKey !== hexKey(unitCenter)) return false;
          const cfg = CONFIG.STARMERCS.structures[s.type];
          return cfg?.canCapture && s.turnsBuilt >= s.turnsRequired && s.team !== unitTeam;
        });
        if (capturable) {
          const tokensHere = getTokensAtHex(unitCenter);
          const defenders = tokensHere.filter(t =>
            t.actor && t.actor.system.strength.value > 0
            && (t.actor.system.team ?? "a") === capturable.team
          );
          if (defenders.length === 0) {
            capturable.team = unitTeam;
            await canvas.scene.setFlag("star-mercs", "structures", captureStructures);
            const capConfig = CONFIG.STARMERCS.structures[capturable.type];
            sections.push(`<div class="consolidation-section capture">
              <div class="consolidation-section-header"><i class="fas fa-flag"></i> Structure Captured!</div>
              <div class="status-update">${esc(capConfig?.label ?? capturable.type)} captured by Team ${unitTeam.toUpperCase()}.</div>
            </div>`);
          }
        }
      }

      // 2h. Outpost supply distribution — outposts transfer supply to nearby friendlies
      // Airborne flying units cannot receive resupply (must land first)
      if (token && actor.isAirborne) {
        sections.push(`<div class="consolidation-section supply">
          <div class="consolidation-section-header"><i class="fas fa-plane"></i> Airborne — Cannot Resupply</div>
          <div class="status-update">Must land to receive outpost supplies.</div>
        </div>`);
      } else if (token) {
        const supTeam = actor.system.team ?? "a";
        const supCenter = snapToHexCenter(canvas.tokens.get(token.id)?.center ?? { x: 0, y: 0 });
        const supStructures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];

        for (const s of supStructures) {
          if ((s.type !== "outpost" && s.type !== "headquarters") || s.team !== supTeam) continue;
          if (s.turnsBuilt < s.turnsRequired || s.strength <= 0) continue;
          if (!s.supply) continue;
          if (s.autoSupply === false) continue;

          const dx = supCenter.x - s.x;
          const dy = supCenter.y - s.y;
          const dist = Math.round(Math.sqrt(dx * dx + dy * dy) / (canvas.grid.size || 100));
          if (dist > (s.supplyRange ?? 3)) continue;

          const supplyUpdate = {};
          let transferred = false;
          for (const cat of ["projectile", "ordnance", "energy", "fuel", "materials", "parts", "basicSupplies"]) {
            const unitCurrent = actor.system.supply?.[cat]?.current ?? 0;
            const unitCapacity = actor.system.supply?.[cat]?.capacity ?? 0;
            const outpostCurrent = s.supply[cat]?.current ?? 0;
            const deficit = unitCapacity - unitCurrent;
            if (deficit > 0 && outpostCurrent > 0) {
              const xfer = Math.min(deficit, outpostCurrent);
              supplyUpdate[`system.supply.${cat}.current`] = unitCurrent + xfer;
              s.supply[cat].current -= xfer;
              transferred = true;
            }
          }
          if (transferred) {
            await actor.update(supplyUpdate);
            await canvas.scene.setFlag("star-mercs", "structures", supStructures);
            sections.push(`<div class="consolidation-section supply">
              <div class="consolidation-section-header"><i class="fas fa-box-open"></i> Resupplied from Outpost</div>
            </div>`);
            break; // One outpost per unit per round
          }
        }
      }

      // 3. Disordered units lose 1 additional readiness
      if (token) {
        const isDisordered = token.getFlag("star-mercs", "disordered") ?? false;
        if (isDisordered) {
          const currentRdy = actor.system.readiness.value;
          const newRdy = Math.max(0, currentRdy - 1);
          if (newRdy !== currentRdy) {
            await actor.update({ "system.readiness.value": newRdy });
            // Disordered readiness update removed from chat (visible in combat summary)
          }
        }
      }

      // 4. Consume supply by category (ammo is consumed on fire, only fuel/basic here)
      //    Skip supply consumption for cargo units aboard a transport
      if (actor.isAboardTransport()) {
        // Cargo aboard transport does not consume own supplies
        // (transport handles fuel; cargo can't act)
      } else {
      const supply = actor.system.supply;
      const supplyUpdate = {};
      const consumedParts = [];

      // 4a. (Ammo is now consumed immediately when weapons fire — no deferred consumption)

      // 4b. Movement consumable: MP spent × fuelPerMP + altitude change + assault surcharge + Vehicle baseline
      //     Landed flying units consume nothing. Airborne flying units have a minimum of 1/turn.
      //     consumableType determines which supply pool is used (fuel, energy, or none).
      //     Vehicle baseline uses the unit's consumable type. Stand-down skips all consumption.
      {
        const mpSpent = token ? (token.getFlag("star-mercs", "movementUsed") ?? 0) : 0;
        const fuelPerMP = actor.system.fuelPerMP ?? 0;
        const orderKey = actor.system.currentOrder;
        const consumableType = actor.system.movementConsumable ?? "fuel";
        const consumableKey = consumableType === "none" ? "fuel" : consumableType;
        const consumableLabel = consumableKey === "energy" ? "Energy" : "Fuel";
        const isLandedFlying = actor.hasTrait("Flying") && actor.getFlag("star-mercs", "landed");
        const isAirborneFlying = actor.hasTrait("Flying") && !actor.getFlag("star-mercs", "landed");

        // Landed flying units spend no consumable at all
        // Stand-down order: vehicles consume nothing
        if (isLandedFlying || orderKey === "stand_down") {
          // No consumable used
        } else {
          // Vehicle trait baseline: 1 per turn from the unit's consumable type
          const vehicleBaseline = actor.hasTrait("Vehicle") ? 1 : 0;

          // Movement consumable (skip if type is "none", but vehicle baseline still applies)
          let moveCost = 0;
          if (consumableType !== "none") {
            // Base movement (MP spent × per MP) + assault surcharge
            moveCost = mpSpent * fuelPerMP;
            if (orderKey === "assault" && fuelPerMP > 0) {
              moveCost += fuelPerMP;
            }

            // Apply supply modifier to movement/assault cost
            moveCost = moveCost * supplyMod;

            // Altitude change (1 per level changed)
            const altChanged = token ? (token.getFlag("star-mercs", "altitudeChanged") ?? 0) : 0;
            moveCost += altChanged * supplyMod;
          }

          let totalCost = moveCost + vehicleBaseline;

          // Airborne flying units always consume at least 1 per turn (hovering)
          if (isAirborneFlying && totalCost < 1) {
            totalCost = 1;
          }

          if (totalCost > 0 && supply[consumableKey].current > 0) {
            const used = Math.min(totalCost, supply[consumableKey].current);
            supplyUpdate[`system.supply.${consumableKey}.current`] = supply[consumableKey].current - used;
            const details = [];
            if (mpSpent > 0 && consumableType !== "none") details.push(`${mpSpent} MP × ${fuelPerMP}`);
            if (orderKey === "assault" && fuelPerMP > 0 && consumableType !== "none") details.push(`+${fuelPerMP} assault`);
            const altChanged = token ? (token.getFlag("star-mercs", "altitudeChanged") ?? 0) : 0;
            if (altChanged > 0 && consumableType !== "none") details.push(`+${altChanged} altitude`);
            if (supplyMod > 1 && consumableType !== "none") details.push(`×${supplyMod} supply mod`);
            if (vehicleBaseline > 0) details.push("+1 vehicle baseline");
            if (isAirborneFlying && moveCost + vehicleBaseline < 1) details.push("min 1 airborne");
            consumedParts.push(`${consumableLabel}: -${used} (${details.join(", ")})`);
          }
        }
      }

      // 4c. Basic supplies: 1 per unit per turn (Drone units skip this)
      if (!actor.hasTrait("Drone") && supply.basicSupplies.current > 0) {
        supplyUpdate["system.supply.basicSupplies.current"] = Math.max(0, supply.basicSupplies.current - 1);
        consumedParts.push("Basic: -1");
      }

      // Apply all supply updates at once
      if (Object.keys(supplyUpdate).length > 0) {
        await actor.update(supplyUpdate);
        // Supply consumed section removed from chat (visible in combat summary)
      }

      } // end supply consumption (skipped for cargo aboard transport)

      // Clean up altitude change tracking flags
      if (token) {
        if (token.getFlag("star-mercs", "altitudeChanged") != null) {
          await token.unsetFlag("star-mercs", "altitudeChanged");
        }
        if (token.getFlag("star-mercs", "altitudeTarget") != null) {
          await token.unsetFlag("star-mercs", "altitudeTarget");
        }
        if (token.getFlag("star-mercs", "flyAltitudeTarget") != null) {
          await token.unsetFlag("star-mercs", "flyAltitudeTarget");
        }
      }

      // 4d. Auto-land airborne flying units with 0 movement consumable (emergency landing)
      if (actor.isAirborne) {
        const postConsumableType = actor.system.movementConsumable ?? "fuel";
        const postConsumableKey = postConsumableType === "none" ? "fuel" : postConsumableType;
        const postFuel = actor.system.supply?.[postConsumableKey]?.current ?? 0;
        if (postFuel <= 0) {
          await actor.setFlag("star-mercs", "landed", true);
          if (token) {
            const tokenObj = canvas?.tokens?.get(token.id);
            if (tokenObj) {
              const { getHexElevation: ghElev, snapToHexCenter: shc } = game.starmercs?.hexUtils ?? {};
              if (ghElev) {
                const hexElev = ghElev(shc(tokenObj.center));
                await actor.setFlag("star-mercs", "altitude", hexElev);
              }
            }
          }
          const existingEffect = actor.effects.find(e => e.statuses?.has("landed"));
          if (!existingEffect) {
            await actor.createEmbeddedDocuments("ActiveEffect", [{
              name: "Landed",
              img: "icons/svg/downgrade.svg",
              statuses: ["landed"]
            }]);
          }
          // Remove airborne status on emergency landing
          await actor.toggleStatusEffect("airborne", { active: false });
          sections.push(`<div class="consolidation-section supply">
            <div class="consolidation-section-header"><i class="fas fa-exclamation-triangle"></i> Emergency Landing — No Fuel!</div>
            <div class="status-update">Unit has been forced to land. Cannot take off until refueled.</div>
          </div>`);
        }
      }

      // Post ONE combined chat card for this unit (if there are any sections)
      if (sections.length > 0) {
        const unitTeam = actor.system.team ?? "a";
        await ChatMessage.create({
          content: `<div class="star-mercs chat-card consolidation-combined" data-token-id="${token?.id ?? ""}">
            <div class="summary-header unit-link" data-token-id="${token?.id ?? ""}"><i class="fas fa-cog"></i> <strong>${esc(unitName)}</strong> — Consolidation</div>
            ${sections.join("\n")}
          </div>`,
          speaker: { alias: "Star Mercs" },
          whisper: StarMercsCombat.getTeamWhisperIds(unitTeam)
        });
      }
    }

    // 5. Score objectives
    await this._scoreObjectives();

    // 6. Store damage-taken map as a combat flag so the morale button can access it
    const dmgMapObj = {};
    for (const [tokenId, dmg] of damageTakenMap) {
      dmgMapObj[tokenId] = dmg;
    }
    await this.setFlag("star-mercs", "damageTakenThisTurn", dmgMapObj);

    // 7. Post morale button chat card instead of auto-running morale
    const moraleContent = await foundry.applications.handlebars.renderTemplate(
      "systems/star-mercs/templates/chat/morale-button.hbs",
      { combatId: this.id }
    );
    await ChatMessage.create({
      content: moraleContent,
      speaker: { alias: "Star Mercs" }
    });

    // Refresh combat summary after consolidation
    game.starmercs?.combatSummary?.render();
  }

  /* ---------------------------------------- */
  /*  Morale: Public API (Button-triggered)   */
  /* ---------------------------------------- */

  /**
   * Run morale checks and assault morale resolution.
   * Called by the morale button in the consolidation chat card.
   */
  async rollMoraleChecks() {
    // Retrieve persisted damage-taken map
    const dmgMapObj = this.getFlag("star-mercs", "damageTakenThisTurn") ?? {};
    const damageTakenMap = new Map(Object.entries(dmgMapObj).map(([k, v]) => [k, Number(v)]));

    await this._runMoraleChecks(damageTakenMap);
    await this._runAssaultMorale(damageTakenMap);

    // Clean up the stored damage map
    await this.unsetFlag("star-mercs", "damageTakenThisTurn");
  }

  /* ---------------------------------------- */
  /*  Morale Helpers                          */
  /* ---------------------------------------- */

  /**
   * Get comms chain status for a unit using the CommsLinkManager.
   * @param {string} tokenId - The token's ID.
   * @returns {{isIsolated: boolean, hasCommandInChain: boolean}}
   * @private
   */
  _getCommsChainStatus(tokenId) {
    const manager = game.starmercs?.commsLinkManager;
    if (!manager) return { isIsolated: true, hasCommandInChain: false };
    manager.refresh();
    return {
      isIsolated: manager.isIsolated(tokenId),
      hasCommandInChain: manager.hasCommandInChain(tokenId)
    };
  }

  /**
   * Evaluate a morale roll with all modifiers applied.
   * Roll-under system: roll d10 + damage taken, must be ≤ readiness to pass.
   * Lower rolls are better (natural 1 is the best possible roll).
   * @param {number} dieResult - Raw d10 result.
   * @param {number} damageTaken - Strength damage taken this turn.
   * @param {number} readiness - Current readiness value.
   * @returns {{total: number, passed: boolean}}
   * @private
   */
  _evaluateMoraleRoll(dieResult, damageTaken, readiness) {
    const total = dieResult + damageTaken;
    const passed = total <= readiness;
    return { total, passed };
  }

  /* ---------------------------------------- */
  /*  Morale: Standard Consolidation Checks   */
  /* ---------------------------------------- */

  /**
   * Run morale checks for all units with readiness < 10 (non-assault).
   *
   * Status progression:
   *   Normal → fail → Breaking (can only Hold/Withdraw)
   *   Breaking (no damage taken) → auto-recover
   *   Breaking + succeed morale → recover
   *   Breaking + fail morale → Surrender (removed from game)
   *
   * Comms chain effects:
   *   - Isolated (chain size 1): re-roll successful morale (forced to use worse result)
   *   - Command in chain: re-roll failed morale (get a second chance)
   *   - Isolation: if passed, forced re-roll (use worse result)
   *
   * @param {Map<string, number>} damageTakenMap - Token ID → strength damage taken this turn.
   * @private
   */
  async _runMoraleChecks(damageTakenMap) {
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const token = combatant.token;
      if (!token) continue;

      // Skip destroyed or surrendered units
      if (actor.system.strength.value <= 0) continue;

      // Skip units with Assault order — they use _runAssaultMorale instead
      if (actor.system.currentOrder === "assault") continue;

      const damageTaken = damageTakenMap.get(token.id) ?? 0;
      const isBreaking = token.getFlag("star-mercs", "breaking") ?? false;
      const isBroken = token.getFlag("star-mercs", "broken") ?? false;

      // --- Breaking/Broken unit recovery or escalation ---
      if (isBreaking || isBroken) {
        // If the unit took no damage this turn, they recover automatically
        if (damageTaken === 0) {
          await token.setFlag("star-mercs", "breaking", false);
          await token.setFlag("star-mercs", "broken", false);
          await ChatMessage.create({
            content: `<div class="star-mercs chat-card morale-recovery">
              <div class="summary-header unit-link" data-token-id="${token.id}"><i class="fas fa-shield-alt"></i> <strong>${esc(token.name)}</strong> — Morale Recovered</div>
              <div class="status-update">No damage taken — ${isBreaking ? "Breaking" : "Broken"} status removed.</div>
            </div>`,
            speaker: { alias: "Star Mercs" },
            whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
          });
          continue;
        }

        // They took damage while Breaking/Broken — must roll morale again
        const currentReadiness = actor.system.readiness.value;
        const { isIsolated, hasCommandInChain } = this._getCommsChainStatus(token.id);

        const roll = new Roll("1d10");
        await roll.evaluate();
        const result = this._evaluateMoraleRoll(roll.total, damageTaken, currentReadiness);

        const allRolls = [roll];
        let rerollType = null;
        let rerollRollObj = null;
        let rerollEval = null;
        let finalPassed = result.passed;

        // Isolation re-roll: if passed but isolated, forced re-roll (use re-roll result)
        if (result.passed && isIsolated) {
          rerollType = "isolation";
          rerollRollObj = new Roll("1d10");
          await rerollRollObj.evaluate();
          allRolls.push(rerollRollObj);
          rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, damageTaken, currentReadiness);
          finalPassed = rerollEval.passed;
        }
        // Command re-roll: if failed and Command in chain, re-roll (use re-roll if it passes)
        else if (!result.passed && hasCommandInChain) {
          rerollType = "command";
          rerollRollObj = new Roll("1d10");
          await rerollRollObj.evaluate();
          allRolls.push(rerollRollObj);
          rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, damageTaken, currentReadiness);
          finalPassed = rerollEval.passed;
        }

        const statusLabel = isBreaking ? "Breaking" : "Broken";

        let html = `<div class="star-mercs chat-card morale-check">`;
        html += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${esc(token.name)}</strong> — Morale Check (${statusLabel})</div>`;
        html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
        if (damageTaken > 0) html += ` +${damageTaken} dmg`;
        html += ` = ${result.total} vs RDY ${currentReadiness} — ${result.passed ? "Passed" : "Failed"}</div>`;

        if (rerollType === "isolation") {
          html += `<div class="morale-reroll isolation">Isolation re-roll (no comms link): ${rerollRollObj.total}`;
          if (damageTaken > 0) html += ` +${damageTaken}`;
          html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
        } else if (rerollType === "command") {
          html += `<div class="morale-reroll command">Command re-roll: ${rerollRollObj.total}`;
          if (damageTaken > 0) html += ` +${damageTaken}`;
          html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
        }

        if (finalPassed) {
          await token.setFlag("star-mercs", "breaking", false);
          await token.setFlag("star-mercs", "broken", false);
          await token.unsetFlag("star-mercs", "breakingTurn");
          html += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Morale restored — ${statusLabel} status removed!</div>`;
        } else {
          // Second failure while Breaking/Broken → SURRENDER
          await actor.update({ "system.strength.value": 0 });
          await token.setFlag("star-mercs", "breaking", false);
          await token.setFlag("star-mercs", "broken", false);
          await token.unsetFlag("star-mercs", "breakingTurn");
          html += `<div class="status-alert morale-failed"><i class="fas fa-flag"></i> SURRENDERED — ${esc(token.name)} is removed from the game!</div>`;
        }
        html += `</div>`;

        await ChatMessage.create({
          content: html,
          speaker: { alias: "Star Mercs" },
          rolls: allRolls,
          whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
        });
        continue;
      }

      // --- Normal units: morale check if fired at or damaged this turn ---
      const currentReadiness = actor.system.readiness.value;
      const wasFiredAt = token.getFlag("star-mercs", "firedAtThisTurn") ?? false;

      // Skip units that were not engaged this turn
      if (!wasFiredAt && damageTaken === 0) continue;

      // Skip if it's mathematically impossible to fail (max d10 + damage can't exceed readiness)
      if (10 + damageTaken <= currentReadiness) continue;

      const { isIsolated, hasCommandInChain } = this._getCommsChainStatus(token.id);

      const roll = new Roll("1d10");
      await roll.evaluate();
      const result = this._evaluateMoraleRoll(roll.total, damageTaken, currentReadiness);

      const allRolls = [roll];
      let rerollType = null;
      let rerollRollObj = null;
      let rerollEval = null;
      let finalPassed = result.passed;

      // Isolation re-roll: if passed but isolated, forced re-roll
      if (result.passed && isIsolated) {
        rerollType = "isolation";
        rerollRollObj = new Roll("1d10");
        await rerollRollObj.evaluate();
        allRolls.push(rerollRollObj);
        rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, damageTaken, currentReadiness);
        finalPassed = rerollEval.passed;
      }
      // Command re-roll: if failed and Command in chain, re-roll
      else if (!result.passed && hasCommandInChain) {
        rerollType = "command";
        rerollRollObj = new Roll("1d10");
        await rerollRollObj.evaluate();
        allRolls.push(rerollRollObj);
        rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, damageTaken, currentReadiness);
        finalPassed = rerollEval.passed;
      }

      let html = `<div class="star-mercs chat-card morale-check">`;
      html += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${esc(token.name)}</strong> — Morale Check</div>`;
      html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
      if (damageTaken > 0) html += ` +${damageTaken} dmg`;
      html += ` = ${result.total} vs RDY ${currentReadiness} — ${result.passed ? "Passed" : "Failed"}</div>`;

      if (rerollType === "isolation") {
        html += `<div class="morale-reroll isolation">Isolation re-roll (no comms link): ${rerollRollObj.total}`;
        if (damageTaken > 0) html += ` +${damageTaken}`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (rerollType === "command") {
        html += `<div class="morale-reroll command">Command re-roll: ${rerollRollObj.total}`;
        if (damageTaken > 0) html += ` +${damageTaken}`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      // Determine trigger reason for log entry
      const reason = wasFiredAt && damageTaken > 0 ? "fired at, took damage"
        : wasFiredAt ? "fired at" : "took damage";

      if (finalPassed) {
        html += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Morale holds!</div>`;
      } else {
        // Check for double-breaking: already Breaking from a previous turn
        const alreadyBreaking = token.getFlag("star-mercs", "breaking") ?? false;
        const breakingTurn = token.getFlag("star-mercs", "breakingTurn") ?? -1;

        if (alreadyBreaking && breakingTurn !== this.round) {
          // Second Breaking on a different turn → ROUTED (destroyed)
          html += `<div class="status-alert morale-failed"><i class="fas fa-flag"></i> ROUTED — ${esc(token.name)} was already Breaking and failed morale again! Removed from game.</div>`;
        } else {
          html += `<div class="status-alert morale-failed"><i class="fas fa-heartbeat"></i> BREAKING — unit can only Hold or Withdraw!</div>`;
        }
      }
      html += `</div>`;

      await ChatMessage.create({
        content: html,
        speaker: { alias: "Star Mercs" },
        rolls: allRolls,
        whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
      });

      // Apply status and log
      if (!finalPassed) {
        const alreadyBreaking = token.getFlag("star-mercs", "breaking") ?? false;
        const breakingTurn = token.getFlag("star-mercs", "breakingTurn") ?? -1;

        if (alreadyBreaking && breakingTurn !== this.round) {
          // Double Breaking → ROUTED
          await actor.update({ "system.strength.value": 0 });
          await token.setFlag("star-mercs", "breaking", false);
          await token.unsetFlag("star-mercs", "breakingTurn");
          await actor.addLogEntry(`ROUTED (${reason}): Already Breaking, failed morale again — destroyed`, "morale");
        } else {
          await token.setFlag("star-mercs", "breaking", true);
          await token.setFlag("star-mercs", "breakingTurn", this.round);
          await actor.addLogEntry(`Morale FAILED (${reason}): rolled ${roll.total} +${damageTaken} dmg = ${result.total} vs RDY ${currentReadiness} — BREAKING`, "morale");
        }
      } else {
        await actor.addLogEntry(`Morale passed (${reason}): rolled ${roll.total} +${damageTaken} dmg = ${result.total} vs RDY ${currentReadiness}`, "morale");
      }
    }
  }

  /* ---------------------------------------- */
  /*  Morale: Assault Resolution              */
  /* ---------------------------------------- */

  /**
   * Run assault-specific morale resolution.
   *
   * Both the assaulting unit and the defender roll morale.
   * Modifiers: damage taken this turn.
   *
   * Comms chain effects apply to both sides:
   *   - Isolated: re-roll successful morale
   *   - Command in chain: re-roll failed morale
   *
   * Outcomes:
   *   - Attacker fails → gains Breaking, loses 2 readiness
   *   - Defender fails → gains Breaking, loses 2 readiness
   *   - Defender fails AND attacker passes → Routing: must move 1 hex away.
   *     If they can move → Broken status. If not → Surrender.
   *   - Both fail → both gain Breaking, each loses 2 readiness
   *   - Both pass → nothing
   *
   * @param {Map<string, number>} damageTakenMap
   * @private
   */
  async _runAssaultMorale(damageTakenMap) {
    const processedPairs = new Set();

    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "assault") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const assaultTargetId = token.getFlag("star-mercs", "assaultTarget");
      if (!assaultTargetId) continue;

      // Check if this pair was already processed as a mutual assault
      const pairKey = [token.id, assaultTargetId].sort().join("-");
      if (processedPairs.has(pairKey)) continue;

      const attackerCanvasToken = canvas?.tokens?.get(token.id);
      const targetCanvasToken = canvas?.tokens?.get(assaultTargetId);
      if (!targetCanvasToken?.actor) continue;
      const targetActor = targetCanvasToken.actor;
      if (targetActor.system.strength.value <= 0) continue;

      // Detect mutual assault
      const targetCombatant = this.combatants.find(c => c.token?.id === assaultTargetId);
      const isMutual = targetCombatant?.actor?.system?.currentOrder === "assault"
        && targetCombatant?.token?.getFlag("star-mercs", "assaultTarget") === token.id;
      if (isMutual) processedPairs.add(pairKey);

      // Find defender's token document
      const defenderToken = targetCanvasToken.document;

      // Assault readiness cost: lose 1 readiness per hex moved to reach adjacency
      if (attackerCanvasToken && targetCanvasToken) {
        const distanceToTarget = StarMercsActor.getHexDistance(attackerCanvasToken, targetCanvasToken);
        const hexesMoved = Math.max(0, distanceToTarget - 1);
        if (hexesMoved > 0) {
          const newRdy = Math.max(0, actor.system.readiness.value - hexesMoved);
          await actor.update({ "system.readiness.value": newRdy });
          await actor.addLogEntry(`Assault movement: -${hexesMoved} readiness (${hexesMoved} hex${hexesMoved > 1 ? "es" : ""} to target)`, "damage");
          await ChatMessage.create({
            content: `<div class="star-mercs chat-card consolidation-readiness">
              <div class="summary-header unit-link" data-token-id="${token.id}"><i class="fas fa-fist-raised"></i> <strong>${esc(token.name)}</strong> — Assault Movement: -${hexesMoved} readiness (${distanceToTarget} hex${distanceToTarget > 1 ? "es" : ""} to target)</div>
            </div>`,
            speaker: { alias: "Star Mercs" },
            whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
          });
        }
      }

      // Get damage taken this turn
      const attackerDmg = damageTakenMap.get(token.id) ?? 0;
      const defenderDmg = damageTakenMap.get(defenderToken?.id ?? assaultTargetId) ?? 0;

      const attackerReadiness = actor.system.readiness.value;
      const defenderReadiness = targetActor.system.readiness.value;

      // Get comms chain status for both sides
      const attackerComms = this._getCommsChainStatus(token.id);
      const defenderComms = this._getCommsChainStatus(defenderToken?.id ?? assaultTargetId);

      // Shock trait: attacker's Shock [X] value applies as defender penalty (if defender lacks Shock)
      const attackerShockBase = actor.getTraitValue?.("Shock") ?? 0;
      let attackerShockBonus = 0;
      if (token.hasStatusEffect("meteoric-assault")) attackerShockBonus = 3;
      else if (token.hasStatusEffect("air-assault")) attackerShockBonus = 2;
      else if (token.hasStatusEffect("air-drop")) attackerShockBonus = 1;
      const attackerShockValue = attackerShockBase + attackerShockBonus;
      const defenderHasShock = targetActor.hasTrait?.("Shock") ?? false;
      const shockPenalty = (!defenderHasShock && attackerShockValue > 0) ? attackerShockValue : 0;

      // Roll morale for both
      const assaultRoll = new Roll("1d10");
      await assaultRoll.evaluate();
      const aResult = this._evaluateMoraleRoll(assaultRoll.total, attackerDmg, attackerReadiness);

      const defenderRoll = new Roll("1d10");
      await defenderRoll.evaluate();
      const dResult = this._evaluateMoraleRoll(defenderRoll.total, defenderDmg + shockPenalty, defenderReadiness);

      const allRolls = [assaultRoll, defenderRoll];

      // Apply isolation/command re-rolls for attacker
      let aRerollType = null;
      let aRerollObj = null;
      let aRerollEval = null;
      let aFinalPassed = aResult.passed;

      if (aResult.passed && attackerComms.isIsolated) {
        aRerollType = "isolation";
        aRerollObj = new Roll("1d10");
        await aRerollObj.evaluate();
        allRolls.push(aRerollObj);
        aRerollEval = this._evaluateMoraleRoll(aRerollObj.total, attackerDmg, attackerReadiness);
        aFinalPassed = aRerollEval.passed;
      } else if (!aResult.passed && attackerComms.hasCommandInChain) {
        aRerollType = "command";
        aRerollObj = new Roll("1d10");
        await aRerollObj.evaluate();
        allRolls.push(aRerollObj);
        aRerollEval = this._evaluateMoraleRoll(aRerollObj.total, attackerDmg, attackerReadiness);
        aFinalPassed = aRerollEval.passed;
      }

      // Apply isolation/command re-rolls for defender
      let dRerollType = null;
      let dRerollObj = null;
      let dRerollEval = null;
      let dFinalPassed = dResult.passed;

      if (dResult.passed && defenderComms.isIsolated) {
        dRerollType = "isolation";
        dRerollObj = new Roll("1d10");
        await dRerollObj.evaluate();
        allRolls.push(dRerollObj);
        dRerollEval = this._evaluateMoraleRoll(dRerollObj.total, defenderDmg + shockPenalty, defenderReadiness);
        dFinalPassed = dRerollEval.passed;
      } else if (!dResult.passed && defenderComms.hasCommandInChain) {
        dRerollType = "command";
        dRerollObj = new Roll("1d10");
        await dRerollObj.evaluate();
        allRolls.push(dRerollObj);
        dRerollEval = this._evaluateMoraleRoll(dRerollObj.total, defenderDmg + shockPenalty, defenderReadiness);
        dFinalPassed = dRerollEval.passed;
      }

      // Build chat message
      const headerLabel = isMutual ? "Mutual Assault" : "Assault Resolution";
      let html = `<div class="star-mercs chat-card assault-morale">`;
      html += `<div class="summary-header"><i class="fas fa-fist-raised"></i> ${headerLabel}: <strong>${esc(token.name)}</strong> vs <strong>${esc(targetCanvasToken.name)}</strong></div>`;

      // Attacker roll details
      html += `<div class="morale-details">${esc(token.name)}: Roll ${assaultRoll.total}`;
      if (attackerDmg > 0) html += ` +${attackerDmg} dmg`;
      html += ` = ${aResult.total} vs RDY ${attackerReadiness} — ${aResult.passed ? "Passed" : "Failed"}</div>`;
      if (aRerollType === "isolation") {
        html += `<div class="morale-reroll isolation">${esc(token.name)} Isolation re-roll: ${aRerollObj.total}`;
        if (attackerDmg > 0) html += ` +${attackerDmg}`;
        html += ` = ${aRerollEval.total} — ${aRerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (aRerollType === "command") {
        html += `<div class="morale-reroll command">${esc(token.name)} Command re-roll: ${aRerollObj.total}`;
        if (attackerDmg > 0) html += ` +${attackerDmg}`;
        html += ` = ${aRerollEval.total} — ${aRerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      // Defender roll details
      html += `<div class="morale-details">${esc(targetCanvasToken.name)}: Roll ${defenderRoll.total}`;
      if (defenderDmg > 0) html += ` +${defenderDmg} dmg`;
      if (shockPenalty > 0) html += ` +${shockPenalty} Shock`;
      html += ` = ${dResult.total} vs RDY ${defenderReadiness} — ${dResult.passed ? "Passed" : "Failed"}</div>`;
      if (dRerollType === "isolation") {
        html += `<div class="morale-reroll isolation">${esc(targetCanvasToken.name)} Isolation re-roll: ${dRerollObj.total}`;
        if (defenderDmg > 0) html += ` +${defenderDmg}`;
        html += ` = ${dRerollEval.total} — ${dRerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (dRerollType === "command") {
        html += `<div class="morale-reroll command">${esc(targetCanvasToken.name)} Command re-roll: ${dRerollObj.total}`;
        if (defenderDmg > 0) html += ` +${defenderDmg}`;
        html += ` = ${dRerollEval.total} — ${dRerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      // Helper to apply Breaking with double-breaking check
      const applyBreaking = async (tkn, act, label) => {
        const alreadyBreaking = tkn.getFlag("star-mercs", "breaking") ?? false;
        const breakingTurn = tkn.getFlag("star-mercs", "breakingTurn") ?? -1;
        if (alreadyBreaking && breakingTurn !== this.round) {
          // Double Breaking → ROUTED
          await act.update({ "system.strength.value": 0 });
          await tkn.setFlag("star-mercs", "breaking", false);
          await tkn.unsetFlag("star-mercs", "breakingTurn");
          await act.addLogEntry(`ROUTED: Already Breaking, failed assault morale — destroyed`, "morale");
          return `<div class="status-alert morale-failed"><i class="fas fa-flag"></i> ROUTED — ${label} was already Breaking! Removed from game.</div>`;
        } else {
          await tkn.setFlag("star-mercs", "breaking", true);
          await tkn.setFlag("star-mercs", "breakingTurn", this.round);
          return null;
        }
      };

      if (aFinalPassed && dFinalPassed) {
        // Both pass: stalemate
        html += `<div class="status-update morale-passed"><i class="fas fa-handshake"></i> Stalemate — both sides hold their ground.</div>`;
      } else if (!aFinalPassed && dFinalPassed) {
        // Attacker fails, defender passes: attacker Breaking, loses 2 RDY
        const newRdy = Math.max(0, actor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newRdy });
        const routedHtml = await applyBreaking(token, actor, token.name);
        if (routedHtml) {
          html += routedHtml;
        } else {
          html += `<div class="status-alert morale-failed"><i class="fas fa-shield-alt"></i> Assault repelled! ${esc(token.name)} is Breaking, loses 2 readiness.</div>`;
        }
      } else if (aFinalPassed && !dFinalPassed) {
        // Attacker passes, defender fails → Routing → must move 1 hex or surrender
        const newRdy = Math.max(0, targetActor.system.readiness.value - 2);
        await targetActor.update({ "system.readiness.value": newRdy });

        // For mutual assault, the passing unit is the "attacker" (winner)
        const routedHtml = await applyBreaking(defenderToken, targetActor, targetCanvasToken.name);
        if (routedHtml) {
          html += routedHtml;
        } else {
          // Check if defender can move 1 hex away
          const canRetreat = this._canRetreatFromAssault(targetCanvasToken, token.id);
          if (canRetreat) {
            if (defenderToken) await defenderToken.setFlag("star-mercs", "broken", true);
            html += `<div class="status-alert morale-failed"><i class="fas fa-running"></i> ${isMutual ? "Loser routs!" : "Defender routs!"} ${esc(targetCanvasToken.name)} must fall back 1 hex — BROKEN. Loses 2 readiness.</div>`;
          } else {
            await targetActor.update({ "system.strength.value": 0 });
            html += `<div class="status-alert morale-failed"><i class="fas fa-flag"></i> ${esc(targetCanvasToken.name)} cannot retreat — SURRENDERED! Removed from game.</div>`;
          }
        }
      } else {
        // Both fail: each gains Breaking, loses 2 RDY
        const newAtkRdy = Math.max(0, actor.system.readiness.value - 2);
        const newDefRdy = Math.max(0, targetActor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newAtkRdy });
        await targetActor.update({ "system.readiness.value": newDefRdy });
        const atkRoutedHtml = await applyBreaking(token, actor, token.name);
        const defRoutedHtml = await applyBreaking(defenderToken, targetActor, targetCanvasToken.name);
        if (atkRoutedHtml) {
          html += atkRoutedHtml;
        }
        if (defRoutedHtml) {
          html += defRoutedHtml;
        }
        if (!atkRoutedHtml && !defRoutedHtml) {
          html += `<div class="status-alert morale-failed"><i class="fas fa-exchange-alt"></i> Both sides falter! Each is Breaking, loses 2 readiness.</div>`;
        }
      }
      html += `</div>`;

      const atkTeam = actor.system.team ?? "a";
      const defTeam = targetActor.system.team ?? "a";
      await ChatMessage.create({
        content: html,
        speaker: { alias: "Star Mercs" },
        rolls: allRolls,
        whisper: StarMercsCombat.getBothTeamsWhisperIds(atkTeam, defTeam)
      });
    }
  }

  /**
   * Check if a token can retreat 1 hex away from the attacker into an empty hex.
   * "Empty" means no other unit tokens occupy it.
   * @param {Token} retreatingToken - The token that needs to retreat.
   * @param {string} attackerTokenDocId - The attacker's TokenDocument ID.
   * @returns {boolean}
   * @private
   */
  _canRetreatFromAssault(retreatingToken, attackerTokenDocId) {
    // Simple check: look for at least one adjacent grid position that is not occupied
    // For now, return true as a default — the GM will manually move the token.
    // A full hex-adjacency check would require grid topology analysis.
    // We just check if there are fewer enemy tokens adjacent than total adjacent hexes.
    const offsets = canvas?.grid?.getAdjacentOffsets?.(retreatingToken.center);
    const neighbors = offsets?.map(offset => canvas.grid.getCenterPoint(offset));
    if (!neighbors || neighbors.length === 0) return true;

    // Count occupied adjacent positions
    const occupiedPositions = new Set();
    for (const otherToken of canvas.tokens.placeables) {
      if (otherToken === retreatingToken) continue;
      if (!otherToken.actor || otherToken.actor.system?.strength?.value <= 0) continue;
      occupiedPositions.add(`${Math.round(otherToken.center.x)},${Math.round(otherToken.center.y)}`);
    }

    // Check if any adjacent hex center is unoccupied
    for (const pos of neighbors) {
      const snapped = canvas.grid.getSnappedPoint(pos, { mode: CONST.GRID_SNAPPING_MODES.CENTER });
      const key = `${Math.round(snapped.x)},${Math.round(snapped.y)}`;
      if (!occupiedPositions.has(key)) return true;
    }
    return false;
  }

  /* ---------------------------------------- */
  /*  Morale: Withdraw Test (Tactical Phase)  */
  /* ---------------------------------------- */

  /**
   * Run morale tests for all units with the Withdraw order.
   * Called at the start of the tactical phase before movement.
   *
   * On success: withdraw normally.
   * On failure: Disordered — enemies get +1 to hit, +1 damage, and unit
   * loses 1 extra readiness in consolidation.
   *
   * Comms chain effects:
   *   - Isolated: re-roll successful morale
   *   - Command in chain: re-roll failed morale
   *
   * @private
   */
  async _runWithdrawMorale() {
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "withdraw") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const currentReadiness = actor.system.readiness.value;
      const { isIsolated, hasCommandInChain } = this._getCommsChainStatus(token.id);

      const roll = new Roll("1d10");
      await roll.evaluate();

      // No damage modifier for withdraw test (damage hasn't happened yet this turn)
      const result = this._evaluateMoraleRoll(roll.total, 0, currentReadiness);

      const allRolls = [roll];
      let rerollType = null;
      let rerollRollObj = null;
      let rerollEval = null;
      let finalPassed = result.passed;

      // Isolation re-roll: if passed but isolated, forced re-roll
      if (result.passed && isIsolated) {
        rerollType = "isolation";
        rerollRollObj = new Roll("1d10");
        await rerollRollObj.evaluate();
        allRolls.push(rerollRollObj);
        rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, 0, currentReadiness);
        finalPassed = rerollEval.passed;
      }
      // Command re-roll: if failed and Command in chain, re-roll
      else if (!result.passed && hasCommandInChain) {
        rerollType = "command";
        rerollRollObj = new Roll("1d10");
        await rerollRollObj.evaluate();
        allRolls.push(rerollRollObj);
        rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, 0, currentReadiness);
        finalPassed = rerollEval.passed;
      }

      let html = `<div class="star-mercs chat-card morale-check withdraw-morale">`;
      html += `<div class="summary-header"><i class="fas fa-running"></i> <strong>${esc(token.name)}</strong> — Withdraw Morale Test</div>`;
      html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
      html += ` = ${result.total} vs RDY ${currentReadiness} — ${result.passed ? "Passed" : "Failed"}</div>`;

      if (rerollType === "isolation") {
        html += `<div class="morale-reroll isolation">Isolation re-roll (no comms link): ${rerollRollObj.total}`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (rerollType === "command") {
        html += `<div class="morale-reroll command">Command re-roll: ${rerollRollObj.total}`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      if (finalPassed) {
        html += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Orderly withdrawal — may move normally.</div>`;
      } else {
        await token.setFlag("star-mercs", "disordered", true);
        html += `<div class="status-alert morale-failed"><i class="fas fa-dizzy"></i> DISORDERED — enemies get +1 to hit, +1 damage, -1 extra readiness!</div>`;
      }
      html += `</div>`;

      await ChatMessage.create({
        content: html,
        speaker: { alias: "Star Mercs" },
        rolls: allRolls,
        whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
      });
    }
  }

  /* ---------------------------------------- */
  /*  Tactical Sub-Step System                */
  /* ---------------------------------------- */

  /**
   * Check if a tactical sub-step has any work to do (units to process).
   * Used by auto-skip to avoid pausing on empty sub-phases.
   * @param {string} key - The step key from TACTICAL_STEPS.
   * @returns {boolean} True if the step has work to do.
   * @private
   */
  _hasWorkForStep(key) {
    switch (key) {
      case "withdraw_morale":
        return this.combatants.some(c => {
          const a = c.actor;
          return a?.type === "unit" && a.system.currentOrder === "withdraw"
            && a.system.strength.value > 0;
        });

      case "artillery":
        return this.combatants.some(c => {
          const a = c.actor;
          if (!a || a.type !== "unit" || a.system.strength.value <= 0) return false;
          if (a.hasTrait("Flying") && a.getFlag("star-mercs", "landed")) return false;
          return a.items.some(i => i.type === "weapon" && i.system.artillery);
        });

      case "airstrikes":
        return this.combatants.some(c => {
          const a = c.actor;
          if (!a || a.type !== "unit" || a.system.strength.value <= 0) return false;
          if (a.hasTrait("Flying") && a.getFlag("star-mercs", "landed")) return false;
          return a.items.some(i => i.type === "weapon" && i.system.aircraft);
        });

      case "weapons_fire":
        return this.combatants.some(c => {
          const a = c.actor;
          if (!a || a.type !== "unit" || a.system.strength.value <= 0) return false;
          if (a.hasTrait("Flying") && a.getFlag("star-mercs", "landed")) return false;
          const order = this._getActorOrder(a);
          if (order && !order.system.allowsAttack) return false;
          const curOrder = a.system.currentOrder;
          if (curOrder === "move" || curOrder === "fly" || curOrder === "overwatch") return false;
          return a.items.some(i => i.type === "weapon"
            && !i.system.artillery && !i.system.aircraft);
        });

      case "assault_adjacent":
      case "assault_move":
        return this.combatants.some(c => {
          const a = c.actor;
          return a?.type === "unit" && a.system.currentOrder === "assault"
            && a.system.strength.value > 0 && c.token?.getFlag("star-mercs", "assaultTarget");
        });

      case "movement":
        return this.combatants.some(c => {
          const a = c.actor;
          if (!a || a.type !== "unit" || a.system.strength.value <= 0) return false;
          const order = a.system.currentOrder;
          const orderConfig = CONFIG.STARMERCS.orders?.[order];
          if (!orderConfig?.allowsMovement) return false;
          if (order === "assault" || order === "withdraw") return false;
          return !!c.token?.getFlag("star-mercs", "moveDestination");
        }) || this.combatants.some(c => {
          const a = c.actor;
          return a?.type === "unit" && a.system.strength.value > 0
            && a.system.currentOrder === "change_altitude"
            && c.token?.getFlag("star-mercs", "altitudeTarget") != null;
        });

      case "maneuver_fire":
        return this.combatants.some(c => {
          const a = c.actor;
          if (!a || a.type !== "unit" || a.system.strength.value <= 0) return false;
          const mfOrder = a.system.currentOrder;
          if (mfOrder !== "move" && mfOrder !== "fly") return false;
          // Check if unit has any non-artillery, non-aircraft weapons (could fire)
          return a.items.some(i => i.type === "weapon" && !i.system.artillery && !i.system.aircraft);
        });

      case "meteoric_landing": {
        const pending = this.getFlag("star-mercs", "pendingDeploys") ?? [];
        return pending.some(p => p.mode === "meteoric_assault");
      }

      case "air_drop_landing": {
        const pending = this.getFlag("star-mercs", "pendingDeploys") ?? [];
        return pending.some(p => p.mode === "air_drop");
      }

      default:
        return true;
    }
  }

  /**
   * Dispatch execution to the appropriate tactical sub-step handler.
   * Auto-skips sub-phases with nothing to do and posts a combined skip message.
   * After execution, posts a "Next Step" chat button or advances to consolidation.
   * @param {number} stepIndex - Index into TACTICAL_STEPS.
   * @private
   */
  async _executeTacticalStep(stepIndex) {
    const steps = StarMercsCombat.TACTICAL_STEPS;

    // Auto-skip empty sub-phases
    const skippedLabels = [];
    while (stepIndex < steps.length && !this._hasWorkForStep(steps[stepIndex].key)) {
      skippedLabels.push(steps[stepIndex].label);
      stepIndex++;
    }

    // Post combined skip message if any were skipped
    if (skippedLabels.length > 0) {
      await ChatMessage.create({
        content: `<div class="star-mercs chat-card tactical-step">
          <div class="summary-header"><i class="fas fa-forward"></i> Skipped</div>
          <div class="status-update">${skippedLabels.join(", ")} — nothing to resolve.</div>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
    }

    // If all remaining steps were skipped, proceed to consolidation
    if (stepIndex >= steps.length) {
      await this._postStepComplete();
      return;
    }

    // Update the step index
    await this.setFlag("star-mercs", "tacticalStep", stepIndex);

    // Refresh combat summary if open
    game.starmercs?.combatSummary?.render();

    const step = steps[stepIndex];

    switch (step.key) {
      case "withdraw_morale":
        await this._runWithdrawMorale();
        break;
      case "artillery":
        await this._runArtilleryFire();
        break;
      case "airstrikes":
        await this._runAirStrikeFire();
        break;
      case "weapons_fire":
        await this._runStandardWeaponsFire();
        break;
      case "assault_adjacent":
        await this._runAssaultStep("adjacent");
        break;
      case "assault_move":
        await this._runAssaultStep("move");
        break;
      case "movement":
        await this._runMovementStep();
        break;
      case "maneuver_fire":
        await this._runManeuverFire();
        break;
      case "meteoric_landing":
        if (await this._runPendingLanding("meteoric_assault")) return;
        break;
      case "air_drop_landing":
        if (await this._runPendingLanding("air_drop")) return;
        break;
    }

    // Refresh combat summary after step execution
    game.starmercs?.combatSummary?.render();

    // Post "Next Step" button if more steps remain
    if (stepIndex < steps.length - 1) {
      await this._postNextStepButton(stepIndex);
    } else {
      await this._postStepComplete();
    }
  }

  /**
   * Execute pending landings for a given deployment mode.
   * If no pending deploys match, auto-advances to the next tactical step.
   * @param {string} mode - "meteoric_assault" or "air_drop"
   * @returns {boolean} True if auto-advanced (caller should return early).
   * @private
   */
  async _runPendingLanding(mode) {
    const pending = this.getFlag("star-mercs", "pendingDeploys") ?? [];
    const matching = pending.filter(p => p.mode === mode);

    // Auto-skip if no units are landing
    if (matching.length === 0) {
      const stepIndex = this.getFlag("star-mercs", "tacticalStep") ?? 0;
      const nextStep = stepIndex + 1;
      if (nextStep < StarMercsCombat.TACTICAL_STEPS.length) {
        await this.setFlag("star-mercs", "tacticalStep", nextStep);
        await this._executeTacticalStep(nextStep);
      } else {
        await this._runConsolidationEffects();
        await this.update({
          "flags.star-mercs.phase": "consolidation",
          "flags.star-mercs.phaseIndex": 4
        });
        this._announcePhase();
      }
      return true;
    }

    const modeLabel = mode === "meteoric_assault" ? "Meteoric Assault" : "Air Drop";
    const statusId = mode === "meteoric_assault" ? "meteoric-assault" : "air-drop";
    const landedNames = [];

    for (const entry of matching) {
      const actor = game.actors.get(entry.actorId);
      if (!actor) continue;

      const hexCenter = entry.hexCenter;
      if (!hexCenter) continue;

      // Create token from prototype
      const protoToken = actor.prototypeToken;
      const gridSize = canvas.grid.size || 100;
      const tokenW = (protoToken.width ?? 1) * gridSize;
      const tokenH = (protoToken.height ?? 1) * gridSize;
      const tokenPosition = {
        x: hexCenter.x - tokenW / 2,
        y: hexCenter.y - tokenH / 2
      };

      const tokenData = foundry.utils.mergeObject(protoToken.toObject(), {
        actorId: actor.id,
        actorLink: false,
        name: entry.customName || actor.name,
        x: tokenPosition.x,
        y: tokenPosition.y
      });

      const created = await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
      const tokenDoc = created[0];
      if (!tokenDoc) continue;

      // Add combatant
      await this.createEmbeddedDocuments("Combatant", [{
        actorId: actor.id,
        tokenId: tokenDoc.id,
        sceneId: canvas.scene.id
      }]);

      // Apply status effect and update synthetic actor name
      const tokenActor = tokenDoc.actor;
      if (tokenActor) {
        await tokenActor.toggleStatusEffect(statusId, { active: true });
        const unitName = entry.customName || actor.name;
        if (unitName !== actor.name) {
          await tokenActor.update({ name: unitName });
        }
      }

      // For meteoric assault, set assault target if designated
      if (mode === "meteoric_assault" && entry.assaultTargetTokenId) {
        await tokenDoc.setFlag("star-mercs", "assaultTarget", entry.assaultTargetTokenId);
      }

      // Remove from deploy pool
      const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
      const team = entry.team;
      if (pool[team]) {
        pool[team] = pool[team].filter(e => e.instanceId !== entry.instanceId);
        await game.settings.set("star-mercs", "deployPool", pool);
      }

      landedNames.push(entry.customName || actor.name);
    }

    // Remove processed entries from pending
    const remaining = pending.filter(p => p.mode !== mode);
    await this.setFlag("star-mercs", "pendingDeploys", remaining);

    // Announce landing
    if (landedNames.length > 0) {
      await ChatMessage.create({
        content: `<div class="star-mercs chat-card tactical-step">
          <h4><i class="fas fa-${mode === "meteoric_assault" ? "meteor" : "parachute-box"}"></i> ${modeLabel} Landing</h4>
          <p>${landedNames.map(n => `<strong>${n}</strong>`).join(", ")} ${landedNames.length === 1 ? "lands" : "land"} via ${modeLabel}!</p>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
    }

    // Re-render deploy panel
    game.starmercs?.deployPanel?.render();

    return false;
  }

  /**
   * At the start of the tactical phase, flag all assaulting units so they
   * take +1 damage from all sources (checked in calculateDamage via currentOrder).
   * The assault order is already set on the actor, so the damage modifier
   * in combat.mjs (line "target.system.currentOrder === 'assault'") will apply
   * to all incoming fire during the entire tactical phase.
   * This method posts a chat notification for each assaulting unit.
   * @private
   */
  async _applyAssaultIncomingDamageFlags() {
    const assaultingUnits = [];
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "assault") continue;
      if (actor.system.strength.value <= 0) continue;
      assaultingUnits.push(combatant.token?.name ?? actor.name);
    }

    if (assaultingUnits.length > 0) {
      await ChatMessage.create({
        content: `<div class="star-mercs chat-card tactical-step">
          <div class="summary-header"><i class="fas fa-fist-raised"></i> Assault Modifier Active</div>
          <div class="status-update">The following units take <strong>+1 damage from all sources</strong> this phase:</div>
          <div class="status-update">${assaultingUnits.join(", ")}</div>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
    }
  }

  /* ---------------------------------------- */
  /*  Tactical Steps: Auto-Fire               */
  /* ---------------------------------------- */

  /**
   * Auto-fire all artillery weapons with assigned targets.
   * @private
   */
  async _runArtilleryFire() {
    let firedCount = 0;
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;
      // Landed flying units cannot fire weapons
      if (actor.hasTrait("Flying") && actor.getFlag("star-mercs", "landed")) continue;

      const artilleryWeapons = actor.items.filter(
        i => i.type === "weapon" && i.system.artillery && i.system.targetId
      );
      if (artilleryWeapons.length === 0) continue;

      for (const weapon of artilleryWeapons) {
        const targetToken = canvas.tokens.get(weapon.system.targetId);
        if (!targetToken?.actor) continue;
        const result = await actor.rollAttack(weapon, targetToken.actor);
        if (result) firedCount++;
      }
    }

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-bullseye"></i> Artillery Fire Complete</div>
        <div class="status-update">${firedCount} artillery weapon${firedCount !== 1 ? "s" : ""} fired.</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /**
   * Auto-fire all aircraft weapons with assigned targets.
   * @private
   */
  async _runAirStrikeFire() {
    let firedCount = 0;
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;
      // Landed flying units cannot fire weapons
      if (actor.hasTrait("Flying") && actor.getFlag("star-mercs", "landed")) continue;

      const aircraftWeapons = actor.items.filter(
        i => i.type === "weapon" && i.system.aircraft && i.system.targetId
      );
      if (aircraftWeapons.length === 0) continue;

      for (const weapon of aircraftWeapons) {
        const targetToken = canvas.tokens.get(weapon.system.targetId);
        if (!targetToken?.actor) continue;
        const result = await actor.rollAttack(weapon, targetToken.actor);
        if (result) firedCount++;
      }
    }

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-plane"></i> Air Strikes Complete</div>
        <div class="status-update">${firedCount} aircraft weapon${firedCount !== 1 ? "s" : ""} fired.</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /**
   * Auto-fire all non-artillery, non-aircraft weapons with assigned targets,
   * for units whose order allows attacking (excluding Maneuver — they fire later).
   * @private
   */
  async _runStandardWeaponsFire() {
    let firedCount = 0;
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;
      // Landed flying units cannot fire weapons
      if (actor.hasTrait("Flying") && actor.getFlag("star-mercs", "landed")) continue;

      const order = this._getActorOrder(actor);
      if (order && !order.system.allowsAttack) continue;

      // Maneuver/Fly units fire in the maneuver_fire step; Overwatch fires reactively during movement
      const curOrder = actor.system.currentOrder;
      if (curOrder === "move" || curOrder === "fly" || curOrder === "overwatch") continue;

      const weapons = actor.items.filter(
        i => i.type === "weapon" && i.system.targetId
          && !i.system.artillery && !i.system.aircraft
      );
      if (weapons.length === 0) continue;

      for (const weapon of weapons) {
        const targetToken = canvas.tokens.get(weapon.system.targetId);
        if (!targetToken?.actor) continue;
        const result = await actor.rollAttack(weapon, targetToken.actor);
        if (result) firedCount++;
      }
    }

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-crosshairs"></i> Weapons Fire Complete</div>
        <div class="status-update">${firedCount} weapon${firedCount !== 1 ? "s" : ""} fired.</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /* ---------------------------------------- */
  /*  Tactical Steps: Assault                 */
  /* ---------------------------------------- */

  /**
   * Execute the assault step for a given mode.
   * @param {"adjacent"|"move"} mode - "adjacent" for pre-movement assaults (already adjacent),
   *   "move" for post-movement assaults (need to move to reach target).
   * @private
   */
  async _runAssaultStep(mode = "adjacent") {
    let assaultCount = 0;
    const processedPairs = new Set();

    // Helper: fire weapons at a target
    const fireAssaultWeapons = async (firingActor, firingToken, targetTkn) => {
      const weapons = firingActor.items.filter(
        i => i.type === "weapon" && !i.system.artillery && !i.system.aircraft
      );
      for (const weapon of weapons) {
        const currentToken = canvas.tokens.get(firingToken.id ?? firingToken.document?.id);
        if (!currentToken) break;
        const dist = StarMercsActor.getHexDistance(currentToken, targetTkn);
        if (dist <= weapon.system.range) {
          await firingActor.rollAttack(weapon, targetTkn.actor);
        }
      }
    };

    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "assault") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const assaultTargetId = token.getFlag("star-mercs", "assaultTarget");
      if (!assaultTargetId) continue;

      // Check if this pair was already processed as a mutual assault
      const pairKey = [token.id, assaultTargetId].sort().join("-");
      if (processedPairs.has(pairKey)) {
        assaultCount++;
        continue;
      }

      const attackerToken = canvas.tokens.get(token.id);
      const targetToken = canvas.tokens.get(assaultTargetId);
      if (!attackerToken || !targetToken) continue;

      // Detect mutual assault (target is also assaulting this unit)
      const targetCombatant = this.combatants.find(c => c.token?.id === assaultTargetId);
      const isMutual = targetCombatant?.actor?.system?.currentOrder === "assault"
        && targetCombatant?.token?.getFlag("star-mercs", "assaultTarget") === token.id;

      const adjacent = areAdjacent(attackerToken, targetToken);

      // Filter by mode: "adjacent" only handles already-adjacent assaults,
      // "move" only handles assaults that require movement
      if (mode === "adjacent" && !adjacent) continue;
      if (mode === "move" && adjacent) continue;

      if (isMutual) {
        processedPairs.add(pairKey);
      }

      if (adjacent) {
        // Already adjacent — no movement needed, fire weapons
        await fireAssaultWeapons(actor, attackerToken, targetToken);
        if (isMutual && targetCombatant?.actor && targetCombatant.actor.system.strength.value > 0) {
          await fireAssaultWeapons(targetCombatant.actor, targetToken, attackerToken);
        }
        assaultCount++;
        continue;
      }

      // Move-mode: find adjacent hex, move there, then fire
      const adjacentHex = findBestAdjacentHex(targetToken, attackerToken);
      if (!adjacentHex) {
        await ChatMessage.create({
          content: `<div class="star-mercs chat-card tactical-step">
            <div class="status-alert"><i class="fas fa-exclamation-triangle"></i> <strong>${esc(token.name)}</strong> cannot reach assault target — all adjacent hexes blocked.</div>
          </div>`,
          speaker: { alias: "Star Mercs" },
          whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
        });
        continue;
      }

      // Calculate hex distance moved
      const distance = StarMercsActor.getHexDistance(attackerToken, targetToken);
      const hexesMoved = Math.max(0, distance - 1);

      // Snap to hex center and offset to token top-left for proper positioning
      const snapped = snapToHexCenter(adjacentHex);
      const pos = hexCenterToTokenPosition(snapped, canvas.tokens.get(token.id) ?? token);
      await token.update({ x: pos.x, y: pos.y }, { _starMercsAutoMove: true });

      // Track movement for fuel consumption
      await token.setFlag("star-mercs", "movementUsed", hexesMoved);

      // Deduct readiness: -1 per hex moved
      if (hexesMoved > 0) {
        const newRdy = Math.max(0, actor.system.readiness.value - hexesMoved);
        await actor.update({ "system.readiness.value": newRdy });

        await ChatMessage.create({
          content: `<div class="star-mercs chat-card tactical-step">
            <div class="summary-header unit-link" data-token-id="${token.id}"><i class="fas fa-fist-raised"></i> <strong>${esc(token.name)}</strong> — Assault Movement</div>
            <div class="status-update">Moved ${hexesMoved} hex${hexesMoved > 1 ? "es" : ""} to assault target. -${hexesMoved} readiness.</div>
          </div>`,
          speaker: { alias: "Star Mercs" },
          whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
        });
      }

      // Fire weapons at the assault target
      await fireAssaultWeapons(actor, attackerToken, targetToken);

      // If mutual assault, the target also fires
      if (isMutual && targetCombatant?.actor && targetCombatant.actor.system.strength.value > 0) {
        await fireAssaultWeapons(targetCombatant.actor, targetToken, attackerToken);
      }

      assaultCount++;
    }

    // Refresh engagement status after assault movements
    this._refreshEngagementStatus();

    const stepLabel = mode === "adjacent" ? "Assault (Adjacent)" : "Assault (Move & Attack)";
    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-fist-raised"></i> ${stepLabel} Complete</div>
        <div class="status-update">${assaultCount} assault${assaultCount !== 1 ? "s" : ""} resolved.</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /* ---------------------------------------- */
  /*  Tactical Steps: Movement                */
  /* ---------------------------------------- */

  /**
   * Auto-move all maneuvering units to their set destinations.
   * Handles overwatch triggers, hex contest detection/resolution.
   * @private
   */
  async _runMovementStep() {
    // 1. Collect all units that need to move
    const movers = [];
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const order = actor.system.currentOrder;
      const orderConfig = CONFIG.STARMERCS.orders?.[order];
      if (!orderConfig?.allowsMovement) continue;
      if (order === "assault") continue; // Already handled
      if (order === "withdraw") continue; // Withdraw movement is manual

      const dest = token.getFlag("star-mercs", "moveDestination");
      if (!dest) continue;

      movers.push({ combatant, actor, token, dest, contestLost: false });
    }

    // Also process Change Altitude orders (no movement, just altitude change)
    let altitudeChanges = 0;
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.strength.value <= 0) continue;
      if (actor.system.currentOrder !== "change_altitude") continue;

      const token = combatant.token;
      if (!token) continue;

      const altTarget = token.getFlag("star-mercs", "altitudeTarget");
      if (altTarget == null) continue;

      const currentAlt = actor.getFlag("star-mercs", "altitude") ?? 0;
      const altDelta = Math.abs(altTarget - currentAlt);
      if (altDelta > 0) {
        await actor.setFlag("star-mercs", "altitude", altTarget);
        await token.setFlag("star-mercs", "altitudeChanged", altDelta);
        const unitName = token.name ?? actor.name;
        const unitTeam = actor.system.team ?? "a";
        await ChatMessage.create({
          content: `<div class="star-mercs chat-card tactical-step">
            <div class="summary-header unit-link" data-token-id="${token.id}"><i class="fas fa-helicopter"></i> <strong>${esc(unitName)}</strong> — Altitude Changed</div>
            <div class="status-update">ALT ${currentAlt} → ${altTarget} (${altDelta} fuel)</div>
          </div>`,
          speaker: { alias: "Star Mercs" },
          whisper: StarMercsCombat.getTeamWhisperIds(unitTeam)
        });
        altitudeChanges++;
      }
    }

    if (movers.length === 0) {
      await ChatMessage.create({
        content: `<div class="star-mercs chat-card tactical-step">
          <div class="summary-header"><i class="fas fa-arrows-alt"></i> Movement Complete</div>
          <div class="status-update">No units to move.${altitudeChanges > 0 ? ` ${altitudeChanges} altitude change${altitudeChanges !== 1 ? "s" : ""}.` : ""}</div>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
      return;
    }

    // 2. Detect hex contests (two opposing units targeting the same hex)
    const destMap = new Map();
    for (const m of movers) {
      const snapped = snapToHexCenter(m.dest);
      const key = hexKey(snapped);
      if (!destMap.has(key)) destMap.set(key, []);
      destMap.get(key).push(m);
    }

    // 3. Resolve contests
    for (const [, contestants] of destMap) {
      if (contestants.length < 2) continue;

      // Group by team
      const teams = {};
      for (const m of contestants) {
        const team = m.actor.system.team ?? "a";
        if (!teams[team]) teams[team] = [];
        teams[team].push(m);
      }
      const teamKeys = Object.keys(teams);

      if (teamKeys.length >= 2) {
        // Opposing teams contesting same hex
        const unitA = teams[teamKeys[0]][0];
        const unitB = teams[teamKeys[1]][0];

        const canvasTokenA = canvas.tokens.get(unitA.token.id);
        const canvasTokenB = canvas.tokens.get(unitB.token.id);

        if (canvasTokenA && canvasTokenB) {
          const { loser } = await this._resolveHexContest(canvasTokenA, canvasTokenB);
          // Mark the loser so they stop early
          const loserMover = (loser === canvasTokenA) ? unitA : unitB;
          loserMover.contestLost = true;
        }
      }

      // Same-team conflict: block all but the first mover to that hex
      for (const teamKey of teamKeys) {
        const teamMovers = teams[teamKey];
        for (let i = 1; i < teamMovers.length; i++) {
          teamMovers[i].contestLost = true;
        }
      }
    }

    // 4. Execute movements with overwatch checks
    let movedCount = 0;
    for (const mover of movers) {
      const canvasToken = canvas.tokens.get(mover.token.id);
      if (!canvasToken) continue;

      // Build full path through waypoints (if any) or direct to destination
      const waypoints = mover.token.getFlag("star-mercs", "moveWaypoints");
      const snappedDest = snapToHexCenter(mover.dest);
      let path = [];

      if (waypoints && waypoints.length > 1) {
        // Multi-waypoint path
        let start = canvasToken.center;
        for (const wp of waypoints) {
          const segment = computeHexPath(start, snapToHexCenter(wp));
          path.push(...segment);
          if (segment.length > 0) start = segment[segment.length - 1];
        }
      } else {
        path = computeHexPath(canvasToken.center, snappedDest);
      }

      // Skip if path is empty (already at destination)
      if (path.length === 0) {
        movedCount++;
        continue;
      }

      // Calculate MP cost
      const { totalCost } = calculatePathCost(canvasToken.center, path, mover.actor);

      if (mover.contestLost) {
        // Move to last hex before the contested destination
        const safePath = path.slice(0, -1);
        if (safePath.length > 0) {
          const safeHex = safePath[safePath.length - 1];
          const snapped = snapToHexCenter(safeHex);
          const safePos = hexCenterToTokenPosition(snapped, canvasToken);
          await mover.token.update({ x: safePos.x, y: safePos.y }, { _starMercsAutoMove: true });
          const { totalCost: safeCost } = calculatePathCost(canvasToken.center, safePath, mover.actor);
          await mover.token.setFlag("star-mercs", "movementUsed", safeCost);
        }
        movedCount++;
        continue;
      }

      // Check each step for overwatch triggers, minefield triggers, and terrain effects
      for (const step of path) {
        // Sync terrain cover/concealment at each hex entered (before overwatch fires)
        const stepCenter = snapToHexCenter(step);
        game.starmercs?.syncTerrainCover?.(mover.actor, stepCenter);
        game.starmercs?.syncTerrainConcealment?.(mover.actor, stepCenter);

        const overwatchTriggers = this._checkOverwatchTriggers(canvasToken, step);
        for (const owToken of overwatchTriggers) {
          await this._executeOverwatchFire(owToken, canvasToken);
        }

        // Minefield trigger check at each step
        const stepKey = hexKey(snapToHexCenter(step));
        const allStructures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
        const minefield = allStructures.find(s => s.type === "minefield" && s.hexKey === stepKey
          && s.turnsBuilt >= s.turnsRequired && s.strength > 0);
        if (minefield && minefield.team !== (canvasToken.actor?.system?.team ?? "a")) {
          // Roll d6 damage, capped by remaining strength
          const roll = await new Roll("1d6").evaluate();
          const dmg = Math.min(roll.total, minefield.strength);
          const subConfig = CONFIG.STARMERCS.structures.minefield?.subTypes?.[minefield.subType];
          const damageType = subConfig?.damageType ?? "soft";

          // Reveal the minefield
          if (!minefield.revealed) minefield.revealed = true;

          // Reduce minefield strength
          minefield.strength -= dmg;
          if (minefield.strength <= 0) {
            const updatedStructures = allStructures.filter(s => s.id !== minefield.id);
            if (updatedStructures.length === 0) {
              await canvas.scene.unsetFlag("star-mercs", "structures");
            } else {
              await canvas.scene.setFlag("star-mercs", "structures", updatedStructures);
            }
          } else {
            await canvas.scene.setFlag("star-mercs", "structures", allStructures);
          }

          // Apply pending damage to unit
          await this.addPendingDamage(canvasToken.document, dmg, 0,
            `Minefield (${damageType})`, minefield.subType ?? "minefield");

          // Post chat card
          const mfMaxStr = minefield.strength + dmg; // original before reduction
          await ChatMessage.create({
            content: `<div class="star-mercs chat-card minefield-trigger">
              <div class="summary-header"><i class="fas fa-burst"></i> Minefield Triggered!</div>
              <div class="status-update"><strong>${esc(canvasToken.name)}</strong> entered a minefield.
                Rolled ${roll.total} → <strong>${dmg} ${damageType} damage</strong> applied.
                ${minefield.strength <= 0 ? "Minefield depleted and removed." : `Minefield strength: ${minefield.strength}/${minefield.maxStrength ?? 10}`}</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });
        }
      }

      // Move token through waypoints for visible step-by-step movement
      const moveWaypoints = mover.token.getFlag("star-mercs", "moveWaypoints");
      if (moveWaypoints && moveWaypoints.length > 1) {
        // Animate through each waypoint with brief pauses
        for (const wp of moveWaypoints) {
          const wpSnapped = snapToHexCenter(wp);
          const wpPos = hexCenterToTokenPosition(wpSnapped, canvasToken);
          await mover.token.update({ x: wpPos.x, y: wpPos.y }, { _starMercsAutoMove: true });
          await new Promise(r => setTimeout(r, 800));
        }
      } else {
        // Single destination — move directly
        const finalHex = path[path.length - 1];
        const snapped = snapToHexCenter(finalHex);
        const finalPos = hexCenterToTokenPosition(snapped, canvasToken);
        await mover.token.update({ x: finalPos.x, y: finalPos.y }, { _starMercsAutoMove: true });
      }
      await mover.token.setFlag("star-mercs", "movementUsed", totalCost);

      // Fly order: apply altitude change after movement
      if (mover.actor.system.currentOrder === "fly") {
        const flyAltTarget = mover.token.getFlag("star-mercs", "flyAltitudeTarget");
        if (flyAltTarget != null) {
          const currentAlt = mover.actor.getFlag("star-mercs", "altitude") ?? 0;
          const altDelta = Math.abs(flyAltTarget - currentAlt);
          if (altDelta > 0) {
            await mover.actor.setFlag("star-mercs", "altitude", flyAltTarget);
            await mover.token.setFlag("star-mercs", "altitudeChanged", altDelta);
            altitudeChanges++;
          }
        }
      }

      movedCount++;
    }

    // 5. Refresh engagement status for all tokens
    this._refreshEngagementStatus();

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-arrows-alt"></i> Movement Complete</div>
        <div class="status-update">${movedCount} unit${movedCount !== 1 ? "s" : ""} moved.${altitudeChanges > 0 ? ` ${altitudeChanges} altitude change${altitudeChanges !== 1 ? "s" : ""}.` : ""}</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /**
   * Check for overwatch-capable units that can see a moving token at a given position.
   * @param {Token} movingToken - The moving unit.
   * @param {{x: number, y: number}} stepPosition - The hex center the mover is passing through.
   * @returns {Token[]} Array of overwatch tokens that can fire.
   * @private
   */
  /**
   * Get the list of eligible overwatch weapons for a given attacker and target.
   * Filters by weapon mode (all/appropriate), target traits, and already-fired status.
   * @param {StarMercsActor} actor - The overwatch unit's actor.
   * @param {StarMercsActor} targetActor - The target being fired upon.
   * @param {string} weaponMode - "all" or "appropriate"
   * @param {string[]} firedWeapons - Array of weapon IDs already fired this phase.
   * @returns {Item[]} Array of eligible weapon items.
   * @private
   */
  _getEligibleOverwatchWeapons(actor, targetActor, weaponMode, firedWeapons) {
    const targetIsFlying = targetActor.hasTrait("Flying") && !targetActor.getFlag("star-mercs", "landed") && !targetActor.hasTrait("Hover");
    const targetIsInfantry = targetActor.hasTrait("Infantry");
    const targetIsHeavy = targetActor.hasTrait("Heavy");
    const targetIsVehicle = targetActor.hasTrait("Vehicle");

    return actor.items.filter(w => {
      if (w.type !== "weapon") return false;
      if (firedWeapons.includes(w.id)) return false;
      const at = w.system.attackType;
      // Skip defensive systems
      if (at === "aps" || at === "zps") return false;
      // Skip artillery and aircraft weapons
      if (w.system.artillery || w.system.aircraft) return false;
      // Anti-air can only hit flying targets
      if (at === "antiAir" && !targetIsFlying) return false;
      // Non-anti-air cannot hit flying targets
      if (at !== "antiAir" && targetIsFlying) return false;

      if (weaponMode === "appropriate") {
        if (targetIsFlying) return at === "antiAir";
        if (targetIsInfantry) return at === "soft";
        if (targetIsHeavy) return at === "hard";
        if (targetIsVehicle) return at === "soft" || at === "hard";
        // Default: fire all eligible
        return true;
      }
      return true;
    });
  }

  _checkOverwatchTriggers(movingToken, stepPosition) {
    const triggers = [];
    const movingTeam = movingToken.actor?.system?.team ?? "a";

    for (const token of canvas.tokens.placeables) {
      if (token === movingToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;
      if (token.actor.system.strength.value <= 0) continue;
      if (token.actor.system.currentOrder !== "overwatch") continue;
      // Landed flying units cannot fire
      if (token.actor.hasTrait("Flying") && token.actor.getFlag("star-mercs", "landed")) continue;

      const owTeam = token.actor.system.team ?? "a";
      if (owTeam === movingTeam) continue;

      const owCenter = snapToHexCenter(token.center);
      const stepSnapped = snapToHexCenter(stepPosition);
      const dx = owCenter.x - stepSnapped.x;
      const dy = owCenter.y - stepSnapped.y;
      const pixelDist = Math.sqrt(dx * dx + dy * dy);
      const gridSize = canvas.grid.size || 100;
      const hexDist = Math.round(pixelDist / gridSize);

      // Get overwatch settings
      const rangeMode = token.document.getFlag("star-mercs", "overwatchRange") ?? "max";
      const weaponMode = token.document.getFlag("star-mercs", "overwatchWeapons") ?? "all";
      const firedWeapons = token.document.getFlag("star-mercs", "firedWeapons") ?? [];

      // Get eligible weapons for this target
      const eligible = this._getEligibleOverwatchWeapons(token.actor, movingToken.actor, weaponMode, firedWeapons);
      if (eligible.length === 0) continue;

      // Range check based on mode
      let inRange = false;
      if (rangeMode === "max") {
        inRange = eligible.some(w => w.system.range >= hexDist);
      } else {
        // "min": fire only when shortest-range eligible weapon can reach
        const minRange = Math.min(...eligible.map(w => w.system.range));
        inRange = minRange >= hexDist;
      }
      if (!inRange) continue;

      // Detection gate
      if (hexDist > 1) {
        const hasLOS = checkLOS(owCenter, stepSnapped);
        if (!hasLOS) continue;
        const sensors = token.actor.system.sensors ?? 0;
        const baseSig = movingToken.actor.system.signature ?? 0;
        const detRange = sensors + baseSig;
        if (detRange <= 0 || hexDist > detRange) continue;
      }
      // hexDist ≤ 1: adjacent units always detect each other
      triggers.push(token);
    }
    return triggers;
  }

  /**
   * Execute automatic overwatch fire from an overwatch unit against a moving target.
   * @param {Token} overwatchToken - The overwatch unit's canvas token.
   * @param {Token} movingToken - The moving enemy unit's canvas token.
   * @private
   */
  async _executeOverwatchFire(overwatchToken, movingToken) {
    const actor = overwatchToken.actor;
    const targetActor = movingToken.actor;
    if (!actor || !targetActor) return;

    const weaponMode = overwatchToken.document.getFlag("star-mercs", "overwatchWeapons") ?? "all";
    const firedWeapons = overwatchToken.document.getFlag("star-mercs", "firedWeapons") ?? [];

    // Get hex distance
    const hexDist = StarMercsActor.getHexDistance(overwatchToken, movingToken);

    // Get eligible weapons that are also in range
    const eligible = this._getEligibleOverwatchWeapons(actor, targetActor, weaponMode, firedWeapons);
    const inRangeWeapons = eligible.filter(w => w.system.range >= hexDist);
    if (inRangeWeapons.length === 0) return;

    // Fire each eligible weapon
    let firedCount = 0;
    const newFired = [...firedWeapons];
    for (const weapon of inRangeWeapons) {
      await actor.rollAttack(weapon, targetActor);
      newFired.push(weapon.id);
      firedCount++;
    }

    // Track fired weapons so they don't fire again at subsequent targets
    await overwatchToken.document.setFlag("star-mercs", "firedWeapons", newFired);

    // Post summary chat card
    const owTeam = actor.system.team ?? "a";
    await ChatMessage.create({
      content: `<div class="star-mercs chat-card overwatch-trigger">
        <div class="summary-header"><i class="fas fa-eye"></i> Overwatch Fire!</div>
        <div class="status-update"><strong>${esc(actor.name)}</strong> fires at
          <strong>${esc(targetActor.name)}</strong> — ${firedCount} weapon${firedCount !== 1 ? "s" : ""} engaged.</div>
      </div>`,
      speaker: { alias: "Star Mercs" },
      whisper: StarMercsCombat.getTeamWhisperIds(owTeam)
    });
  }

  /**
   * Resolve a contested hex: two opposing units both trying to move into the same hex.
   * Both roll morale (d10 vs readiness). Larger margin (readiness - roll) wins.
   * Ties are re-rolled up to 10 rounds.
   * @param {Token} token1 - First unit's canvas token.
   * @param {Token} token2 - Second unit's canvas token.
   * @returns {Promise<{winner: Token, loser: Token}>}
   * @private
   */
  async _resolveHexContest(token1, token2) {
    let winner = null;
    let loser = null;
    const allRolls = [];
    let rounds = 0;
    let roundDetails = [];

    while (!winner && rounds < 10) {
      rounds++;
      const roll1 = new Roll("1d10");
      await roll1.evaluate();
      const roll2 = new Roll("1d10");
      await roll2.evaluate();
      allRolls.push(roll1, roll2);

      const rdy1 = token1.actor.system.readiness.value;
      const rdy2 = token2.actor.system.readiness.value;
      const margin1 = rdy1 - roll1.total;
      const margin2 = rdy2 - roll2.total;

      roundDetails.push(`Round ${rounds}: ${esc(token1.name)} (RDY ${rdy1} - ${roll1.total} = ${margin1}) vs ${esc(token2.name)} (RDY ${rdy2} - ${roll2.total} = ${margin2})`);

      if (margin1 > margin2) { winner = token1; loser = token2; }
      else if (margin2 > margin1) { winner = token2; loser = token1; }
    }

    // Fallback if still tied after 10 rounds
    if (!winner) {
      if (Math.random() < 0.5) { winner = token1; loser = token2; }
      else { winner = token2; loser = token1; }
      roundDetails.push("Tiebreaker: random pick");
    }

    // Post chat result
    let html = `<div class="star-mercs chat-card hex-contest">`;
    html += `<div class="summary-header"><i class="fas fa-flag"></i> Hex Contest!</div>`;
    html += `<div class="status-update"><strong>${esc(token1.name)}</strong> vs <strong>${esc(token2.name)}</strong> both target the same hex.</div>`;
    for (const detail of roundDetails) {
      html += `<div class="morale-details">${detail}</div>`;
    }
    html += `<div class="status-alert"><strong>${esc(winner.name)}</strong> wins the hex! <strong>${esc(loser.name)}</strong> stops short.</div>`;
    html += `</div>`;

    await ChatMessage.create({
      content: html,
      speaker: { alias: "Star Mercs" },
      rolls: allRolls
    });

    return { winner, loser };
  }

  /**
   * Refresh engagement status effects on all tokens.
   * @private
   */
  _refreshEngagementStatus() {
    if (!canvas?.tokens?.placeables) return;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.type !== "unit") continue;
      if (token.actor.system.strength.value <= 0) continue;

      const engaged = isEngaged(token);
      const hasEffect = token.document.hasStatusEffect("engaged");
      if (engaged && !hasEffect) {
        token.actor.toggleStatusEffect("engaged", { active: true });
      } else if (!engaged && hasEffect) {
        token.actor.toggleStatusEffect("engaged", { active: false });
      }
    }
  }

  /* ---------------------------------------- */
  /*  Tactical Steps: Maneuver Fire           */
  /* ---------------------------------------- */

  /**
   * Post chat cards for maneuvering units that may fire after movement.
   * Per user requirement, maneuvering units choose targets AFTER moving,
   * so this posts a card with a "Fire" button for each eligible unit.
   * @private
   */
  async _runManeuverFire() {
    let eligibleCount = 0;
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const mfOrder = actor.system.currentOrder;
      if (mfOrder !== "move" && mfOrder !== "fly") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      // Check if this unit has non-artillery, non-aircraft weapons
      const weapons = actor.items.filter(
        i => i.type === "weapon" && !i.system.artillery && !i.system.aircraft
      );
      if (weapons.length === 0) continue;

      // Post a chat card with a fire button for this unit
      const weaponList = weapons.map(w => `${esc(w.name)} (D${w.system.damage}/R${w.system.range})`).join(", ");
      const mfOrderLabel = mfOrder === "fly" ? "Fly" : "Maneuver";
      const mfIcon = mfOrder === "fly" ? "fa-helicopter" : "fa-running";

      await ChatMessage.create({
        content: `<div class="star-mercs chat-card maneuver-fire-card">
          <div class="summary-header unit-link" data-token-id="${token.id}"><i class="fas ${mfIcon}"></i> <strong>${esc(token.name)}</strong> — ${mfOrderLabel} Fire</div>
          <div class="status-update">Weapons: ${weaponList}</div>
          <div class="status-update">Fires weapons with assigned targets. Accuracy penalty: +1 (${mfOrderLabel} order)</div>
          <button class="maneuver-fire-btn"
            data-token-id="${token.id}"
            data-combat-id="${this.id}">
            <i class="fas fa-crosshairs"></i> Fire Weapons
          </button>
        </div>`,
        speaker: { alias: "Star Mercs" },
        whisper: StarMercsCombat.getTeamWhisperIds(actor.system.team ?? "a")
      });

      eligibleCount++;
    }

    if (eligibleCount === 0) {
      await ChatMessage.create({
        content: `<div class="star-mercs chat-card tactical-step">
          <div class="summary-header"><i class="fas fa-running"></i> Maneuver Fire Complete</div>
          <div class="status-update">No maneuvering units eligible to fire.</div>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
    }
  }

  /* ---------------------------------------- */
  /*  Tactical Steps: Chat Navigation         */
  /* ---------------------------------------- */

  /**
   * Post a "Next Step" button to chat for the GM to advance.
   * @param {number} currentStepIndex
   * @private
   */
  async _postNextStepButton(currentStepIndex) {
    const nextStep = StarMercsCombat.TACTICAL_STEPS[currentStepIndex + 1];
    const totalSteps = StarMercsCombat.TACTICAL_STEPS.length;

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step-nav">
        <div class="summary-header"><i class="fas fa-forward"></i> Tactical Phase</div>
        <div class="status-update">Step ${currentStepIndex + 1}/${totalSteps} complete.</div>
        <div class="status-update">Next: <strong>${nextStep.label}</strong></div>
        <button class="next-tactical-step-btn" data-combat-id="${this.id}">
          <i class="fas fa-play"></i> Execute: ${nextStep.label}
        </button>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /**
   * Post a completion message and advance to consolidation.
   * @private
   */
  async _postStepComplete() {
    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step-nav">
        <div class="summary-header"><i class="fas fa-check-circle"></i> Tactical Phase Complete</div>
        <div class="status-update">All tactical steps resolved. Click "Next Phase" to advance to Consolidation.</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /* ---------------------------------------- */
  /*  Helpers                                 */
  /* ---------------------------------------- */

  /* ---------------------------------------- */
  /*  Objective Scoring                       */
  /* ---------------------------------------- */

  /**
   * Score objective hexes at the end of the consolidation phase.
   * Primary objectives score 3 VP, secondary objectives score 1 VP.
   * Engaged units (enemy adjacent) score 1 less point.
   * Scores are cumulative across rounds.
   * @private
   */
  async _scoreObjectives() {
    if (!canvas?.scene) return;

    const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap");
    if (!terrainMap || typeof terrainMap !== "object") return;

    const objectiveConfig = CONFIG.STARMERCS?.objectives ?? {};
    const currentScores = this.getFlag("star-mercs", "teamScores") ?? {};
    const roundScores = {};
    const scoringDetails = [];

    for (const [key, rawEntry] of Object.entries(terrainMap)) {
      const hexData = normalizeHexData(rawEntry);
      if (!hexData.objective || !objectiveConfig[hexData.objective]) continue;

      const [xStr, yStr] = key.split(",");
      const center = { x: parseFloat(xStr), y: parseFloat(yStr) };

      // Find token occupying this hex
      const tokens = getTokensAtHex(center);
      if (tokens.length === 0) continue;

      const token = tokens[0];
      const team = token.actor?.system?.team;
      if (!team) continue;

      // Airborne flying units cannot score objectives (must land)
      if (token.actor?.isAirborne) continue;

      const basePoints = objectiveConfig[hexData.objective].points;
      const engaged = isEngaged(token);
      const points = Math.max(0, basePoints - (engaged ? 1 : 0));

      if (points <= 0) continue;

      if (!roundScores[team]) roundScores[team] = 0;
      roundScores[team] += points;

      const unitName = token.document?.name ?? token.actor?.name ?? "Unknown";
      const objLabel = objectiveConfig[hexData.objective].label;
      const engagedNote = engaged ? " (Engaged: -1)" : "";
      scoringDetails.push(`${unitName} holds ${objLabel}: +${points} VP${engagedNote} (${team === "a" ? "Team A" : "Team B"})`);
    }

    // Update cumulative scores
    const updatedScores = { ...currentScores };
    for (const [team, pts] of Object.entries(roundScores)) {
      updatedScores[team] = (updatedScores[team] ?? 0) + pts;
    }
    await this.setFlag("star-mercs", "teamScores", updatedScores);

    // Post scoring summary to chat
    if (scoringDetails.length > 0) {
      const teamSummary = Object.entries(updatedScores)
        .map(([t, s]) => `${t === "a" ? "Team A" : "Team B"}: ${s} VP`)
        .join(" | ");

      await ChatMessage.create({
        content: `<div class="star-mercs chat-card consolidation-combined">
          <div class="summary-header"><i class="fas fa-star"></i> Objective Scoring</div>
          <div class="consolidation-section">
            <div class="status-update">${scoringDetails.join("<br/>")}</div>
          </div>
          <div class="consolidation-section">
            <div class="consolidation-section-header"><i class="fas fa-trophy"></i> Total Scores</div>
            <div class="status-update"><strong>${teamSummary}</strong></div>
          </div>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
    } else {
      const teamSummary = Object.entries(updatedScores)
        .filter(([, s]) => s > 0)
        .map(([t, s]) => `${t === "a" ? "Team A" : "Team B"}: ${s} VP`)
        .join(" | ") || "No points scored yet";

      await ChatMessage.create({
        content: `<div class="star-mercs chat-card consolidation-combined">
          <div class="summary-header"><i class="fas fa-star"></i> Objective Scoring</div>
          <div class="status-update">No objectives held this round.</div>
          <div class="consolidation-section">
            <div class="consolidation-section-header"><i class="fas fa-trophy"></i> Total Scores</div>
            <div class="status-update"><strong>${teamSummary}</strong></div>
          </div>
        </div>`,
        speaker: { alias: "Star Mercs" }
      });
    }
  }

  /**
   * End-of-consolidation cleanup: runs when LEAVING consolidation phase.
   * 1. Clear weapon targets
   * 2. Clear movement destinations, tracking, assault target
   * 3. Clear weapons fired counter
   * 4. Clear disordered flag (per-turn)
   * 5. Clear current orders
   * @private
   */
  async _runConsolidationCleanup() {
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const token = combatant.token;

      // 1. Clear weapon targets
      const clearUpdates = [];
      for (const item of actor.items) {
        if (item.type === "weapon" && item.system.targetId) {
          clearUpdates.push({ _id: item.id, "system.targetId": "" });
        }
      }
      if (clearUpdates.length > 0) {
        await actor.updateEmbeddedDocuments("Item", clearUpdates);
      }

      // 2. Clear movement destination, tracking, assault target
      if (token) {
        await token.unsetFlag("star-mercs", "movementUsed");
        await token.unsetFlag("star-mercs", "moveDestination");
        await token.unsetFlag("star-mercs", "moveWaypoints");
        await token.unsetFlag("star-mercs", "assaultTarget");
        // 2b. Clear Advanced Recon Equipment target
        await token.unsetFlag("star-mercs", "advReconTarget");
        // 3. (Ammo consumed on fire — no per-type counters to clear)
        // 4. Clear disordered flag (resets each turn)
        await token.unsetFlag("star-mercs", "disordered");
        // 4b. Clear APS/ZPS interception fire counts (reset on actor, not token)
        if (actor?.getFlag("star-mercs", "interceptionCounts")) {
          await actor.unsetFlag("star-mercs", "interceptionCounts");
        }
        // 5. Clear firedAtThisTurn flag
        await token.unsetFlag("star-mercs", "firedAtThisTurn");
        // 6. Clear per-weapon fired list and "Fired" status effect
        await token.unsetFlag("star-mercs", "firedWeapons");
        if (token.hasStatusEffect("fired") && actor) {
          await actor.toggleStatusEffect("fired", { active: false });
        }
      }

      // 7. Clear current order (but not for cargo or mid-deploy/pack units)
      if (!actor.isAboardTransport() && !actor.isDeployTransitioning) {
        await actor.update({ "system.currentOrder": "" });
      }

      // 8. Clear deployment status effects
      for (const effectId of ["meteoric-assault", "air-drop", "air-assault"]) {
        if (token.hasStatusEffect(effectId) && actor) {
          await actor.toggleStatusEffect(effectId, { active: false });
        }
      }

      // 9. Clear transport per-turn flags
      await token.unsetFlag("star-mercs", "hotDisembarked");
      await token.unsetFlag("star-mercs", "hotDisembarkEvasive");
    }

    // Clear tactical step counter
    await this.unsetFlag("star-mercs", "tacticalStep");
  }
}
