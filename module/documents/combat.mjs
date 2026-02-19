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
   * 1. Apply all pending damage to targets
   * 2. Deduct readiness costs from orders
   * 3. Consume supply (usage × order multiplier + weapons fired)
   * 4. Morale checks for units with readiness < 10
   * @private
   */
  async _runConsolidationEffects() {
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const token = combatant.token;

      // 1. Apply pending damage
      if (token) {
        const pending = token.getFlag("star-mercs", "pendingDamage");
        if (pending && (pending.strength > 0 || pending.readiness > 0)) {
          const newStrength = Math.max(0, actor.system.strength.value - pending.strength);
          const newReadiness = Math.max(0, actor.system.readiness.value - pending.readiness);
          await actor.update({
            "system.strength.value": newStrength,
            "system.readiness.value": newReadiness
          });

          // Post damage application summary to chat
          const destroyed = newStrength <= 0;
          const routed = !destroyed && newReadiness <= 0;
          let statusText = `STR ${newStrength} | RDY ${newReadiness}`;
          if (destroyed) statusText = "DESTROYED";
          else if (routed) statusText = "ROUTED";

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
        // Positive cost = recovery, negative = loss
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

      // 3. Consume supply: (usage × order multiplier) + weapons fired
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

    // 4. Morale checks (after all damage and readiness changes)
    await this._runMoraleChecks();

    // 5. Assault morale resolution
    await this._runAssaultMorale();
  }

  /**
   * Run morale checks for all units with readiness < 10.
   * Roll d10: must roll > current readiness to pass.
   * Modifiers:
   *   -2 if not within comms range of any friendly unit
   *   Re-roll allowed if within comms range of a friendly Command unit
   * Failure: unit gains Routing status, loses 3 readiness.
   * @private
   */
  async _runMoraleChecks() {
    // Build a list of all token positions by team for comms range checks
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

    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const token = combatant.token;
      if (!token) continue;

      // Skip destroyed units
      if (actor.system.strength.value <= 0) continue;

      // Already routing units: check if they recover (not adjacent to enemies)
      const isRouting = token.getFlag("star-mercs", "routing") ?? false;
      if (isRouting) {
        const adjacentToEnemy = this._isAdjacentToEnemy(token, actor, tokensByTeam);
        if (!adjacentToEnemy) {
          await token.setFlag("star-mercs", "routing", false);
          await ChatMessage.create({
            content: `<div class="star-mercs chat-card morale-recovery">
              <div class="summary-header"><i class="fas fa-shield-alt"></i> <strong>${token.name}</strong> — Morale Recovered</div>
              <div class="status-update">No longer routing — not adjacent to enemies.</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });
        }
        continue;
      }

      // Only check morale if readiness < 10
      const currentReadiness = actor.system.readiness.value;
      if (currentReadiness >= 10) continue;

      // Check comms isolation: is this unit within comms range of any friendly unit?
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
          // Check if this friendly has the Command trait
          if (friendlyActor.hasTrait("Command")) {
            hasCommandNearby = true;
          }
        }
      }

      // Roll morale check: d10, need to roll > readiness to pass
      const roll = new Roll("1d10");
      await roll.evaluate();
      let total = roll.total;

      // Apply comms isolation penalty
      const commsIsolation = !withinCommsRange;
      if (commsIsolation) {
        total -= 2;
      }

      const passed = total > currentReadiness;

      // If failed and Command trait nearby, allow re-roll
      let rerolled = false;
      let rerollResult = null;
      let rerollRollObj = null;
      if (!passed && hasCommandNearby) {
        rerolled = true;
        rerollRollObj = new Roll("1d10");
        await rerollRollObj.evaluate();
        let rerollTotal = rerollRollObj.total;
        if (commsIsolation) rerollTotal -= 2;
        rerollResult = { roll: rerollRollObj.total, total: rerollTotal, passed: rerollTotal > currentReadiness };
      }

      const finalPassed = passed || (rerolled && rerollResult?.passed);

      // Build morale check chat message
      let moraleHtml = `<div class="star-mercs chat-card morale-check">`;
      moraleHtml += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${token.name}</strong> — Morale Check</div>`;
      moraleHtml += `<div class="morale-details">Readiness: ${currentReadiness}/10 | Roll: ${roll.total}`;
      if (commsIsolation) moraleHtml += ` (-2 comms isolation = ${total})`;
      moraleHtml += ` vs ${currentReadiness}+</div>`;

      if (rerolled) {
        moraleHtml += `<div class="morale-reroll">Command re-roll: ${rerollResult.roll}`;
        if (commsIsolation) moraleHtml += ` (-2 = ${rerollResult.total})`;
        moraleHtml += ` — ${rerollResult.passed ? "Passed" : "Failed"}</div>`;
      }

      if (finalPassed) {
        moraleHtml += `<div class="status-update morale-passed"><i class="fas fa-check"></i> Morale holds!</div>`;
      } else {
        moraleHtml += `<div class="status-alert morale-failed"><i class="fas fa-running"></i> ROUTING — loses 3 readiness, must withdraw!</div>`;
      }
      moraleHtml += `</div>`;

      await ChatMessage.create({
        content: moraleHtml,
        speaker: { alias: "Star Mercs" },
        rolls: rerolled && rerollRollObj ? [roll, rerollRollObj] : [roll]
      });

      // Apply routing effects
      if (!finalPassed) {
        const newRdy = Math.max(0, actor.system.readiness.value - 3);
        await actor.update({ "system.readiness.value": newRdy });
        await token.setFlag("star-mercs", "routing", true);
      }
    }
  }

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
   * Run assault-specific morale resolution for units with the Assault order.
   * Both the assaulting unit and its target roll d10 morale checks.
   * Results:
   *   - Assault fails, Defender passes: Assaulter stays, loses 2 readiness
   *   - Assault passes, Defender fails: Defender falls back, loses 2 readiness
   *   - Both fail: Each loses 2 readiness, stay in place
   *   - Both pass: Nothing happens, stay in place
   * @private
   */
  async _runAssaultMorale() {
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

      // Roll morale for both units (d10, need > readiness to pass)
      const assaultRoll = new Roll("1d10");
      await assaultRoll.evaluate();
      const assaultReadiness = actor.system.readiness.value;
      const assaultPassed = assaultRoll.total > assaultReadiness;

      const defenderRoll = new Roll("1d10");
      await defenderRoll.evaluate();
      const defenderReadiness = targetActor.system.readiness.value;
      const defenderPassed = defenderRoll.total > defenderReadiness;

      // Build chat message
      let html = `<div class="star-mercs chat-card assault-morale">`;
      html += `<div class="summary-header"><i class="fas fa-fist-raised"></i> Assault Resolution: <strong>${token.name}</strong> vs <strong>${targetCanvasToken.name}</strong></div>`;
      html += `<div class="morale-details">${token.name}: Roll ${assaultRoll.total} vs ${assaultReadiness}+ — ${assaultPassed ? "Passed" : "Failed"}</div>`;
      html += `<div class="morale-details">${targetCanvasToken.name}: Roll ${defenderRoll.total} vs ${defenderReadiness}+ — ${defenderPassed ? "Passed" : "Failed"}</div>`;

      if (!assaultPassed && defenderPassed) {
        // Assault failed: attacker stays, loses 2 readiness
        const newRdy = Math.max(0, actor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newRdy });
        html += `<div class="status-alert morale-failed"><i class="fas fa-shield-alt"></i> Assault repelled! ${token.name} loses 2 readiness.</div>`;
      } else if (assaultPassed && !defenderPassed) {
        // Defender failed: falls back, loses 2 readiness
        const newRdy = Math.max(0, targetActor.system.readiness.value - 2);
        await targetActor.update({ "system.readiness.value": newRdy });
        html += `<div class="status-alert morale-failed"><i class="fas fa-running"></i> Defender breaks! ${targetCanvasToken.name} must fall back, loses 2 readiness.</div>`;
      } else if (!assaultPassed && !defenderPassed) {
        // Both failed: each loses 2 readiness
        const newAttackerRdy = Math.max(0, actor.system.readiness.value - 2);
        const newDefenderRdy = Math.max(0, targetActor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newAttackerRdy });
        await targetActor.update({ "system.readiness.value": newDefenderRdy });
        html += `<div class="status-alert morale-failed"><i class="fas fa-exchange-alt"></i> Both sides falter! Each loses 2 readiness.</div>`;
      } else {
        // Both passed: nothing happens
        html += `<div class="status-update morale-passed"><i class="fas fa-handshake"></i> Stalemate — both sides hold their ground.</div>`;
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
   * End-of-consolidation cleanup: runs when LEAVING consolidation phase.
   * 1. Clear weapon targets
   * 2. Clear movement destinations and movement tracking
   * 3. Clear weapons fired counter
   * 4. Clear current orders
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

      // 2. Clear movement destination, tracking, and assault target
      if (token) {
        await token.unsetFlag("star-mercs", "movementUsed");
        await token.unsetFlag("star-mercs", "moveDestination");
        await token.unsetFlag("star-mercs", "assaultTarget");
        // 3. Clear weapons fired counter
        await token.unsetFlag("star-mercs", "weaponsFired");
      }

      // 4. Clear current order
      await actor.update({ "system.currentOrder": "" });
    }
  }
}
