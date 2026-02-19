import StarMercsActor from "./actor.mjs";

/**
 * Extended Combat class for Star Mercs that implements phase-based rounds.
 *
 * Each round cycles through 4 phases:
 *   preparation → orders → tactical → consolidation
 *
 * Phase state is stored via flags for v12 compatibility.
 * The GM advances phases using the "Next Turn" button in the combat tracker.
 */
export default class StarMercsCombat extends Combat {

  /** Ordered phase keys. */
  static PHASES = ["preparation", "orders", "tactical", "consolidation"];

  /** Per-phase permission rules. */
  static PHASE_RULES = {
    preparation:   { allowsMovement: false, allowsAttack: false },
    orders:        { allowsMovement: false, allowsAttack: false },
    tactical:      { allowsMovement: true,  allowsAttack: true  },
    consolidation: { allowsMovement: true,  allowsAttack: false }
  };

  /* ---------------------------------------- */
  /*  Accessors                               */
  /* ---------------------------------------- */

  /** Current phase key (e.g. "preparation"). */
  get phase() {
    return this.getFlag("star-mercs", "phase") || "preparation";
  }

  /** Current phase index (0–3). */
  get phaseIndex() {
    return this.getFlag("star-mercs", "phaseIndex") ?? 0;
  }

  /** Localized display name of the current phase. */
  get phaseLabel() {
    const key = CONFIG.STARMERCS.phases[this.phase];
    return key ? game.i18n.localize(key) : this.phase;
  }

  /** Rules for the current phase. */
  get phaseRules() {
    return StarMercsCombat.PHASE_RULES[this.phase];
  }

  /* ---------------------------------------- */
  /*  Combat Lifecycle Overrides              */
  /* ---------------------------------------- */

  /** @override — Initialize phase to preparation when combat starts. */
  async startCombat() {
    await this.update({
      "flags.star-mercs.phase": "preparation",
      "flags.star-mercs.phaseIndex": 0
    });
    const result = await super.startCombat();
    this._announcePhase();
    return result;
  }

  /** @override — Advance to the next phase; if all 4 done, advance round. */
  async nextTurn() {
    const currentIndex = this.phaseIndex;
    const nextIndex = currentIndex + 1;

    // Entering tactical — run withdraw morale tests
    if (nextIndex === 2) {
      await this._runWithdrawMorale();
    }

    // Entering consolidation — apply damage, readiness costs, supply consumption
    if (nextIndex === 3) {
      await this._runConsolidationEffects();
    }

    // Leaving consolidation — clear targets, destinations, orders
    if (currentIndex === 3) {
      await this._runConsolidationCleanup();
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

  /** @override — New round resets to preparation. */
  async nextRound() {
    await this.update({
      "flags.star-mercs.phase": "preparation",
      "flags.star-mercs.phaseIndex": 0
    });
    const result = await super.nextRound();
    this._announcePhase();
    return result;
  }

  /** @override — Previous round resets to preparation. */
  async previousRound() {
    await this.update({
      "flags.star-mercs.phase": "preparation",
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
        reason: game.i18n.format("STARMERCS.Phase.NoMovement", { phase: this.phaseLabel })
      };
    }

    // Tactical phase: check the unit's current order
    if (this.phase === "tactical" && actor?.type === "unit") {
      const order = this._getActorOrder(actor);
      if (order && !order.system.allowsMovement) {
        return {
          allowed: false,
          reason: game.i18n.format("STARMERCS.Phase.OrderBlocksMovement", { order: order.name })
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
        reason: game.i18n.format("STARMERCS.Phase.NoAttack", { phase: this.phaseLabel })
      };
    }

    // Tactical phase: check the unit's current order
    if (this.phase === "tactical" && actor?.type === "unit") {
      const order = this._getActorOrder(actor);
      if (order && !order.system.allowsAttack) {
        return {
          allowed: false,
          reason: game.i18n.format("STARMERCS.Phase.OrderBlocksAttack", { order: order.name })
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
      name: game.i18n.localize(orderData.label),
      system: orderData
    };
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
   * Consolidation effects: runs at the BEGINNING of consolidation phase.
   * 1. Apply all pending damage to targets (track damage taken per token)
   * 2. Deduct readiness costs from orders
   * 3. Extra -1 readiness for Disordered units (failed withdraw morale)
   * 4. Consume supply (usage × order multiplier + weapons fired)
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

          await ChatMessage.create({
            content: `<div class="star-mercs chat-card consolidation-damage">
              <div class="summary-header"><i class="fas fa-skull"></i> <strong>${token.name}</strong> — Damage Applied</div>
              <div class="summary-damage">-${pending.strength} STR, -${pending.readiness} RDY</div>
              <div class="status-update">${statusText}</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });

          await token.unsetFlag("star-mercs", "pendingDamage");
        }
      }

      // 2. Deduct readiness cost from the unit's current order
      const order = this._getActorOrder(actor);
      if (order && order.system.readinessCost !== 0) {
        const cost = order.system.readinessCost;
        const currentRdy = actor.system.readiness.value;
        const newRdy = Math.max(0, Math.min(actor.system.readiness.max, currentRdy + cost));
        if (newRdy !== currentRdy) {
          await actor.update({ "system.readiness.value": newRdy });
          const label = cost > 0 ? `+${cost}` : `${cost}`;
          await ChatMessage.create({
            content: `<div class="star-mercs chat-card consolidation-readiness">
              <div class="summary-header"><i class="fas fa-battery-half"></i> <strong>${token?.name ?? actor.name}</strong> — Order Readiness: ${label} (${order.name})</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });
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
            await ChatMessage.create({
              content: `<div class="star-mercs chat-card consolidation-readiness">
                <div class="summary-header"><i class="fas fa-dizzy"></i> <strong>${token.name}</strong> — Disordered Withdrawal: -1 readiness</div>
              </div>`,
              speaker: { alias: "Star Mercs" }
            });
          }
        }
      }

      // 4. Consume supply: (usage × order multiplier) + weapons fired
      const supply = actor.system.supply;
      if (supply && supply.current > 0) {
        const baseUsage = supply.usage ?? 0;
        const multiplier = order ? this._parseSupplyMultiplier(order.system.supplyModifier) : 1;
        const weaponsFired = token ? (token.getFlag("star-mercs", "weaponsFired") ?? 0) : 0;
        const totalConsumption = (baseUsage * multiplier) + weaponsFired;

        if (totalConsumption > 0) {
          const newSupply = Math.max(0, supply.current - totalConsumption);
          await actor.update({ "system.supply.current": newSupply });

          const parts = [];
          if (baseUsage > 0) parts.push(`${baseUsage * multiplier} base${multiplier > 1 ? ` (×${multiplier})` : ""}`);
          if (weaponsFired > 0) parts.push(`${weaponsFired} weapon${weaponsFired > 1 ? "s" : ""} fired`);

          await ChatMessage.create({
            content: `<div class="star-mercs chat-card consolidation-supply">
              <div class="summary-header"><i class="fas fa-box"></i> <strong>${token?.name ?? actor.name}</strong> — Supply Consumed: ${totalConsumption}</div>
              <div class="status-update">${parts.join(" + ")} — ${newSupply}/${supply.capacity} remaining</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });
        }
      }
    }

    // 5. Morale checks (after all damage and readiness changes)
    await this._runMoraleChecks(damageTakenMap);

    // 6. Assault morale resolution
    await this._runAssaultMorale(damageTakenMap);
  }

  /* ---------------------------------------- */
  /*  Morale Helpers                          */
  /* ---------------------------------------- */

  /**
   * Build a Map of combatant tokens grouped by team.
   * @returns {Map<string, Array<{token: TokenDocument, actor: StarMercsActor}>>}
   * @private
   */
  _buildTokensByTeam() {
    const tokensByTeam = new Map();
    for (const combatant of this.combatants) {
      const a = combatant.actor;
      if (!a || a.type !== "unit") continue;
      const t = combatant.token;
      if (!t) continue;
      const team = a.system.team ?? "a";
      if (!tokensByTeam.has(team)) tokensByTeam.set(team, []);
      tokensByTeam.get(team).push({ token: t, actor: a });
    }
    return tokensByTeam;
  }

  /**
   * Check comms range and Command trait proximity for a unit.
   * @param {TokenDocument} token
   * @param {StarMercsActor} actor
   * @param {Map} tokensByTeam
   * @returns {{withinCommsRange: boolean, hasCommandNearby: boolean}}
   * @private
   */
  _checkCommsStatus(token, actor, tokensByTeam) {
    const team = actor.system.team ?? "a";
    const friendlies = tokensByTeam.get(team) ?? [];
    const commsRange = actor.system.comms ?? 3;
    let withinCommsRange = false;
    let hasCommandNearby = false;

    const myCanvasToken = canvas?.tokens?.get(token.id);
    for (const { token: friendlyToken, actor: friendlyActor } of friendlies) {
      if (friendlyToken.id === token.id) continue;
      if (friendlyActor.system.strength.value <= 0) continue;
      const friendlyCanvasToken = canvas?.tokens?.get(friendlyToken.id);
      if (!myCanvasToken || !friendlyCanvasToken) continue;

      const distance = StarMercsActor.getHexDistance(myCanvasToken, friendlyCanvasToken);
      const friendlyComms = friendlyActor.system.comms ?? 3;
      if (distance <= Math.max(commsRange, friendlyComms)) {
        withinCommsRange = true;
        if (friendlyActor.hasTrait("Command")) {
          hasCommandNearby = true;
        }
      }
    }
    return { withinCommsRange, hasCommandNearby };
  }

  /**
   * Evaluate a morale roll with all modifiers applied.
   * Natural 1 on the die always fails regardless of modifiers.
   * @param {number} dieResult - Raw d10 result.
   * @param {number} damageTaken - Strength damage taken this turn.
   * @param {boolean} commsIsolated - True if no friendly units in comms range.
   * @param {number} readiness - Current readiness value.
   * @returns {{total: number, passed: boolean, autoFail: boolean}}
   * @private
   */
  _evaluateMoraleRoll(dieResult, damageTaken, commsIsolated, readiness) {
    // Natural 1 always fails
    if (dieResult === 1) {
      return { total: dieResult, passed: false, autoFail: true };
    }
    let total = dieResult;
    total -= damageTaken;
    if (commsIsolated) total -= 2;
    const passed = total > readiness;
    return { total, passed, autoFail: false };
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
   * Modifiers:
   *   - Subtract damage taken this turn from roll
   *   - -2 if comms isolated
   *   - Natural 1 always fails
   *   - Command trait nearby allows one re-roll
   *
   * @param {Map<string, number>} damageTakenMap - Token ID → strength damage taken this turn.
   * @private
   */
  async _runMoraleChecks(damageTakenMap) {
    const tokensByTeam = this._buildTokensByTeam();

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
              <div class="summary-header"><i class="fas fa-shield-alt"></i> <strong>${token.name}</strong> — Morale Recovered</div>
              <div class="status-update">No damage taken — ${isBreaking ? "Breaking" : "Broken"} status removed.</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });
          continue;
        }

        // They took damage while Breaking/Broken — must roll morale again
        const currentReadiness = actor.system.readiness.value;
        const { withinCommsRange, hasCommandNearby } = this._checkCommsStatus(token, actor, tokensByTeam);
        const commsIsolated = !withinCommsRange;

        const roll = new Roll("1d10");
        await roll.evaluate();
        const result = this._evaluateMoraleRoll(roll.total, damageTaken, commsIsolated, currentReadiness);

        // Command re-roll if failed
        let rerolled = false;
        let rerollRollObj = null;
        let rerollEval = null;
        if (!result.passed && hasCommandNearby) {
          rerolled = true;
          rerollRollObj = new Roll("1d10");
          await rerollRollObj.evaluate();
          rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, damageTaken, commsIsolated, currentReadiness);
        }

        const finalPassed = result.passed || (rerolled && rerollEval?.passed);
        const statusLabel = isBreaking ? "Breaking" : "Broken";

        let html = `<div class="star-mercs chat-card morale-check">`;
        html += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${token.name}</strong> — Morale Check (${statusLabel})</div>`;
        html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
        if (damageTaken > 0) html += ` -${damageTaken} dmg`;
        if (commsIsolated) html += ` -2 isolated`;
        if (result.autoFail) html += ` (NAT 1 AUTO-FAIL)`;
        html += ` = ${result.total} vs ${currentReadiness}+</div>`;

        if (rerolled) {
          html += `<div class="morale-reroll">Command re-roll: ${rerollRollObj.total}`;
          if (damageTaken > 0) html += ` -${damageTaken}`;
          if (commsIsolated) html += ` -2`;
          if (rerollEval.autoFail) html += ` (NAT 1)`;
          html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
        }

        if (finalPassed) {
          await token.setFlag("star-mercs", "breaking", false);
          await token.setFlag("star-mercs", "broken", false);
          html += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Morale restored — ${statusLabel} status removed!</div>`;
        } else {
          // Second failure while Breaking/Broken → SURRENDER
          await actor.update({ "system.strength.value": 0 });
          await token.setFlag("star-mercs", "breaking", false);
          await token.setFlag("star-mercs", "broken", false);
          html += `<div class="status-alert morale-failed"><i class="fas fa-flag"></i> SURRENDERED — ${token.name} is removed from the game!</div>`;
        }
        html += `</div>`;

        await ChatMessage.create({
          content: html,
          speaker: { alias: "Star Mercs" },
          rolls: rerolled && rerollRollObj ? [roll, rerollRollObj] : [roll]
        });
        continue;
      }

      // --- Normal units: morale check if readiness < 10 ---
      const currentReadiness = actor.system.readiness.value;
      if (currentReadiness >= 10) continue;

      const { withinCommsRange, hasCommandNearby } = this._checkCommsStatus(token, actor, tokensByTeam);
      const commsIsolated = !withinCommsRange;

      const roll = new Roll("1d10");
      await roll.evaluate();
      const result = this._evaluateMoraleRoll(roll.total, damageTaken, commsIsolated, currentReadiness);

      // Command re-roll if failed
      let rerolled = false;
      let rerollRollObj = null;
      let rerollEval = null;
      if (!result.passed && hasCommandNearby) {
        rerolled = true;
        rerollRollObj = new Roll("1d10");
        await rerollRollObj.evaluate();
        rerollEval = this._evaluateMoraleRoll(rerollRollObj.total, damageTaken, commsIsolated, currentReadiness);
      }

      const finalPassed = result.passed || (rerolled && rerollEval?.passed);

      let html = `<div class="star-mercs chat-card morale-check">`;
      html += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${token.name}</strong> — Morale Check</div>`;
      html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
      if (damageTaken > 0) html += ` -${damageTaken} dmg`;
      if (commsIsolated) html += ` -2 isolated`;
      if (result.autoFail) html += ` (NAT 1 AUTO-FAIL)`;
      html += ` = ${result.total} vs ${currentReadiness}+</div>`;

      if (rerolled) {
        html += `<div class="morale-reroll">Command re-roll: ${rerollRollObj.total}`;
        if (damageTaken > 0) html += ` -${damageTaken}`;
        if (commsIsolated) html += ` -2`;
        if (rerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      if (finalPassed) {
        html += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Morale holds!</div>`;
      } else {
        html += `<div class="status-alert morale-failed"><i class="fas fa-heartbeat"></i> BREAKING — unit can only Hold or Withdraw!</div>`;
      }
      html += `</div>`;

      await ChatMessage.create({
        content: html,
        speaker: { alias: "Star Mercs" },
        rolls: rerolled && rerollRollObj ? [roll, rerollRollObj] : [roll]
      });

      // Apply Breaking status
      if (!finalPassed) {
        await token.setFlag("star-mercs", "breaking", true);
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
   * Modifiers: damage taken this turn, natural 1 auto-fail.
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
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "assault") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const assaultTargetId = token.getFlag("star-mercs", "assaultTarget");
      if (!assaultTargetId) continue;

      const targetCanvasToken = canvas?.tokens?.get(assaultTargetId);
      if (!targetCanvasToken?.actor) continue;
      const targetActor = targetCanvasToken.actor;
      if (targetActor.system.strength.value <= 0) continue;

      // Find defender's token document
      const defenderToken = targetCanvasToken.document;

      // Get damage taken this turn
      const attackerDmg = damageTakenMap.get(token.id) ?? 0;
      const defenderDmg = damageTakenMap.get(defenderToken?.id ?? assaultTargetId) ?? 0;

      const attackerReadiness = actor.system.readiness.value;
      const defenderReadiness = targetActor.system.readiness.value;

      // Roll morale for both
      const assaultRoll = new Roll("1d10");
      await assaultRoll.evaluate();
      const aResult = this._evaluateMoraleRoll(assaultRoll.total, attackerDmg, false, attackerReadiness);

      const defenderRoll = new Roll("1d10");
      await defenderRoll.evaluate();
      const dResult = this._evaluateMoraleRoll(defenderRoll.total, defenderDmg, false, defenderReadiness);

      // Build chat message
      let html = `<div class="star-mercs chat-card assault-morale">`;
      html += `<div class="summary-header"><i class="fas fa-fist-raised"></i> Assault Resolution: <strong>${token.name}</strong> vs <strong>${targetCanvasToken.name}</strong></div>`;
      html += `<div class="morale-details">${token.name}: Roll ${assaultRoll.total}`;
      if (attackerDmg > 0) html += ` -${attackerDmg} dmg`;
      if (aResult.autoFail) html += ` (NAT 1)`;
      html += ` = ${aResult.total} vs ${attackerReadiness}+ — ${aResult.passed ? "Passed" : "Failed"}</div>`;
      html += `<div class="morale-details">${targetCanvasToken.name}: Roll ${defenderRoll.total}`;
      if (defenderDmg > 0) html += ` -${defenderDmg} dmg`;
      if (dResult.autoFail) html += ` (NAT 1)`;
      html += ` = ${dResult.total} vs ${defenderReadiness}+ — ${dResult.passed ? "Passed" : "Failed"}</div>`;

      if (aResult.passed && dResult.passed) {
        // Both pass: stalemate
        html += `<div class="status-update morale-passed"><i class="fas fa-handshake"></i> Stalemate — both sides hold their ground.</div>`;
      } else if (!aResult.passed && dResult.passed) {
        // Attacker fails, defender passes: attacker Breaking, loses 2 RDY
        const newRdy = Math.max(0, actor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newRdy });
        await token.setFlag("star-mercs", "breaking", true);
        html += `<div class="status-alert morale-failed"><i class="fas fa-shield-alt"></i> Assault repelled! ${token.name} is Breaking, loses 2 readiness.</div>`;
      } else if (aResult.passed && !dResult.passed) {
        // Attacker passes, defender fails → Routing → must move 1 hex or surrender
        const newRdy = Math.max(0, targetActor.system.readiness.value - 2);
        await targetActor.update({ "system.readiness.value": newRdy });

        // Check if defender can move 1 hex away (any adjacent hex without enemies)
        const canRetreat = this._canRetreatFromAssault(targetCanvasToken, token.id);

        if (canRetreat) {
          // Defender routes 1 hex, gains Broken status
          if (defenderToken) await defenderToken.setFlag("star-mercs", "broken", true);
          html += `<div class="status-alert morale-failed"><i class="fas fa-running"></i> Defender routs! ${targetCanvasToken.name} must fall back 1 hex — BROKEN. Loses 2 readiness.</div>`;
        } else {
          // No valid hex — SURRENDER
          await targetActor.update({ "system.strength.value": 0 });
          html += `<div class="status-alert morale-failed"><i class="fas fa-flag"></i> ${targetCanvasToken.name} cannot retreat — SURRENDERED! Removed from game.</div>`;
        }
      } else {
        // Both fail: each gains Breaking, loses 2 RDY
        const newAtkRdy = Math.max(0, actor.system.readiness.value - 2);
        const newDefRdy = Math.max(0, targetActor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newAtkRdy });
        await targetActor.update({ "system.readiness.value": newDefRdy });
        await token.setFlag("star-mercs", "breaking", true);
        if (defenderToken) await defenderToken.setFlag("star-mercs", "breaking", true);
        html += `<div class="status-alert morale-failed"><i class="fas fa-exchange-alt"></i> Both sides falter! Each is Breaking, loses 2 readiness.</div>`;
      }
      html += `</div>`;

      await ChatMessage.create({
        content: html,
        speaker: { alias: "Star Mercs" },
        rolls: [assaultRoll, defenderRoll]
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
    const neighbors = canvas?.grid?.getAdjacentPositions?.(retreatingToken.center);
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

      const roll = new Roll("1d10");
      await roll.evaluate();

      // No damage modifier for withdraw test (damage hasn't happened yet this turn)
      const result = this._evaluateMoraleRoll(roll.total, 0, false, currentReadiness);

      let html = `<div class="star-mercs chat-card morale-check withdraw-morale">`;
      html += `<div class="summary-header"><i class="fas fa-running"></i> <strong>${token.name}</strong> — Withdraw Morale Test</div>`;
      html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
      if (result.autoFail) html += ` (NAT 1 AUTO-FAIL)`;
      html += ` = ${result.total} vs ${currentReadiness}+</div>`;

      if (result.passed) {
        html += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Orderly withdrawal — may move normally.</div>`;
      } else {
        await token.setFlag("star-mercs", "disordered", true);
        html += `<div class="status-alert morale-failed"><i class="fas fa-dizzy"></i> DISORDERED — enemies get +1 to hit, +1 damage, -1 extra readiness!</div>`;
      }
      html += `</div>`;

      await ChatMessage.create({
        content: html,
        speaker: { alias: "Star Mercs" },
        rolls: [roll]
      });
    }
  }

  /* ---------------------------------------- */
  /*  Helpers                                 */
  /* ---------------------------------------- */

  /**
   * Check if a token is adjacent (1 hex) to any enemy unit.
   * @param {TokenDocument} token
   * @param {StarMercsActor} actor
   * @param {Map} tokensByTeam
   * @returns {boolean}
   * @private
   */
  _isAdjacentToEnemy(token, actor, tokensByTeam) {
    const team = actor.system.team ?? "a";
    const myCanvasToken = canvas?.tokens?.get(token.id);
    if (!myCanvasToken) return false;

    for (const [otherTeam, members] of tokensByTeam) {
      if (otherTeam === team) continue;
      for (const { token: enemyToken, actor: enemyActor } of members) {
        if (enemyActor.system.strength.value <= 0) continue;
        const enemyCanvasToken = canvas?.tokens?.get(enemyToken.id);
        if (!enemyCanvasToken) continue;
        const distance = StarMercsActor.getHexDistance(myCanvasToken, enemyCanvasToken);
        if (distance <= 1) return true;
      }
    }
    return false;
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
        await token.unsetFlag("star-mercs", "assaultTarget");
        // 3. Clear weapons fired counter
        await token.unsetFlag("star-mercs", "weaponsFired");
        // 4. Clear disordered flag (resets each turn)
        await token.unsetFlag("star-mercs", "disordered");
      }

      // 5. Clear current order
      await actor.update({ "system.currentOrder": "" });
    }
  }
}
