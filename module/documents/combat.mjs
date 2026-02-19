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
              <div class="summary-header"><i class="fas fa-box"></i> <strong>${token?.name ?? actor.name}</strong> — ${game.i18n.localize("STARMERCS.SupplyConsumed")}: ${totalConsumption}</div>
              <div class="status-update">${parts.join(" + ")} — ${newSupply}/${supply.capacity} remaining</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
          });
        }
      }
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

      // 2. Clear movement destination and tracking
      if (token) {
        await token.unsetFlag("star-mercs", "movementUsed");
        await token.unsetFlag("star-mercs", "moveDestination");
        // 3. Clear weapons fired counter
        await token.unsetFlag("star-mercs", "weaponsFired");
      }

      // 4. Clear current order
      await actor.update({ "system.currentOrder": "" });
    }
  }
}
