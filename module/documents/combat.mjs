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

    // Leaving consolidation — run cleanup
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
  /*  Internal Helpers                        */
  /* ---------------------------------------- */

  /**
   * Look up the actor's currently assigned order item.
   * @param {StarMercsActor} actor
   * @returns {Item|null}
   * @private
   */
  _getActorOrder(actor) {
    const orderName = actor.system.currentOrder;
    if (!orderName) return null;
    return actor.items.find(i => i.type === "order" && i.name === orderName) || null;
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
   * End-of-round cleanup: clear weapon targets and movement flags.
   * @private
   */
  async _runConsolidationCleanup() {
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;

      // Clear weapon targets
      const clearUpdates = [];
      for (const item of actor.items) {
        if (item.type === "weapon" && item.system.targetId) {
          clearUpdates.push({ _id: item.id, "system.targetId": "" });
        }
      }
      if (clearUpdates.length > 0) {
        await actor.updateEmbeddedDocuments("Item", clearUpdates);
      }

      // Reset movement tracking
      const token = combatant.token;
      if (token) {
        await token.unsetFlag("star-mercs", "movementUsed");
      }
    }
  }
}
