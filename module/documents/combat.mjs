import StarMercsActor from "./actor.mjs";
import { snapToHexCenter, hexKey, getAdjacentHexCenters, getTokensAtHex,
  areAdjacent, getAdjacentEnemies, isEngaged, computeHexPath,
  validatePath, findBestAdjacentHex, getLastSafeHex } from "../hex-utils.mjs";

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

  /** Tactical sub-step definitions, executed in order during the tactical phase. */
  static TACTICAL_STEPS = [
    { key: "withdraw_morale", label: "Withdraw Morale Checks" },
    { key: "artillery",       label: "Artillery Fire" },
    { key: "airstrikes",      label: "Air Strikes" },
    { key: "weapons_fire",    label: "Weapons Fire" },
    { key: "assault",         label: "Assault Resolution" },
    { key: "movement",        label: "Unit Movement" },
    { key: "maneuver_fire",   label: "Maneuvering Unit Fire" }
  ];

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

    // If currently IN tactical, advance sub-step instead of phase
    if (currentIndex === 2) {
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
        "flags.star-mercs.phaseIndex": 3
      });
      this._announcePhase();
      return this;
    }

    const nextIndex = currentIndex + 1;

    // Entering tactical — start sub-step sequence
    if (nextIndex === 2) {
      // Apply assault +1 incoming damage flag at the start of tactical phase
      await this._applyAssaultIncomingDamageFlags();

      await this.update({
        "flags.star-mercs.phase": "tactical",
        "flags.star-mercs.phaseIndex": 2,
        "flags.star-mercs.tacticalStep": 0
      });
      this._announcePhase();
      await this._executeTacticalStep(0);
      return this;
    }

    // Leaving consolidation — clear targets, destinations, orders
    if (currentIndex === 3) {
      await this._runConsolidationCleanup();
    }

    // Entering consolidation — apply damage, readiness costs, supply consumption
    if (nextIndex === 3) {
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
        reason: `Movement is not allowed during the ${this.phaseLabel} phase.`
      };
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

          // Log damage to unit's history
          const hitsDesc = pending.hits?.map(h => `${h.source} (${h.weapon})`).join(", ") ?? "unknown";
          await actor.addLogEntry(`Took -${pending.strength} STR, -${pending.readiness} RDY from: ${hitsDesc}`, "damage");

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
      const supplyMod = order ? this._parseSupplyMultiplier(order.system.supplyModifier) : 1;
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

      // 2b. Entrench: grant Entrenched trait if unit stayed in same hex
      if (order && order.key === "entrench") {
        const movementUsed = token ? (token.getFlag("star-mercs", "movementUsed") ?? 0) : 0;
        if (movementUsed === 0) {
          const entrenchedTrait = actor.items.find(
            i => i.type === "trait" && i.name.toLowerCase() === "entrenched"
          );
          if (entrenchedTrait && !entrenchedTrait.system.active) {
            await entrenchedTrait.update({ "system.active": true });
            await ChatMessage.create({
              content: `<div class="star-mercs chat-card consolidation-readiness">
                <div class="summary-header"><i class="fas fa-shield-alt"></i> <strong>${token?.name ?? actor.name}</strong> — Gained Entrenched</div>
              </div>`,
              speaker: { alias: "Star Mercs" }
            });
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
            await ChatMessage.create({
              content: `<div class="star-mercs chat-card consolidation-readiness">
                <div class="summary-header"><i class="fas fa-dizzy"></i> <strong>${token.name}</strong> — Disordered Withdrawal: -1 readiness</div>
              </div>`,
              speaker: { alias: "Star Mercs" }
            });
          }
        }
      }

      // 4. Consume supply by category
      const supply = actor.system.supply;
      const supplyUpdate = {};
      const consumedParts = [];

      // 4a. Ammo consumption based on weapons fired (multiplied by order supply modifier)
      if (token) {
        const smallArmsFired = token.getFlag("star-mercs", "weaponsFired_smallArms") ?? 0;
        const heavyFired = token.getFlag("star-mercs", "weaponsFired_heavyWeapons") ?? 0;
        const ordnanceFired = token.getFlag("star-mercs", "weaponsFired_ordnance") ?? 0;

        const smallArmsUse = smallArmsFired * supplyMod;
        const heavyUse = heavyFired * supplyMod;
        const ordnanceUse = ordnanceFired * supplyMod;

        if (smallArmsUse > 0 && supply.smallArms.current > 0) {
          const used = Math.min(smallArmsUse, supply.smallArms.current);
          supplyUpdate["system.supply.smallArms.current"] = supply.smallArms.current - used;
          consumedParts.push(`Small Arms: -${used}${supplyMod > 1 ? ` (${smallArmsFired}×${supplyMod})` : ""}`);
        }
        if (heavyUse > 0 && supply.heavyWeapons.current > 0) {
          const used = Math.min(heavyUse, supply.heavyWeapons.current);
          supplyUpdate["system.supply.heavyWeapons.current"] = supply.heavyWeapons.current - used;
          consumedParts.push(`Heavy Wpns: -${used}${supplyMod > 1 ? ` (${heavyFired}×${supplyMod})` : ""}`);
        }
        if (ordnanceUse > 0 && supply.ordnance.current > 0) {
          const used = Math.min(ordnanceUse, supply.ordnance.current);
          supplyUpdate["system.supply.ordnance.current"] = supply.ordnance.current - used;
          consumedParts.push(`Ordnance: -${used}${supplyMod > 1 ? ` (${ordnanceFired}×${supplyMod})` : ""}`);
        }
      }

      // 4b. Fuel consumption: movement + assault surcharge + Vehicle baseline
      {
        const movementUsed = token ? (token.getFlag("star-mercs", "movementUsed") ?? 0) : 0;
        const fuelPerHex = actor.system.fuelPerHex ?? 0;
        const orderKey = actor.system.currentOrder;

        // Base movement fuel + assault surcharge (flat fuelPerHex extra for assault)
        let moveFuel = movementUsed * fuelPerHex;
        if (orderKey === "assault" && fuelPerHex > 0) {
          moveFuel += fuelPerHex;
        }

        // Apply supply modifier to movement/assault fuel
        const modifiedMoveFuel = moveFuel * supplyMod;

        // Vehicle trait baseline: 1 fuel/turn unless Stand Down order (not modified by supply multiplier)
        const vehicleBaseline = (actor.hasTrait("Vehicle") && orderKey !== "stand_down") ? 1 : 0;
        const fuelUsed = modifiedMoveFuel + vehicleBaseline;

        if (fuelUsed > 0 && supply.fuel.current > 0) {
          const used = Math.min(fuelUsed, supply.fuel.current);
          supplyUpdate["system.supply.fuel.current"] = supply.fuel.current - used;
          const fuelDetails = [];
          if (movementUsed > 0) fuelDetails.push(`${movementUsed} hex × ${fuelPerHex}`);
          if (orderKey === "assault" && fuelPerHex > 0) fuelDetails.push(`+${fuelPerHex} assault`);
          if (supplyMod > 1) fuelDetails.push(`×${supplyMod} supply mod`);
          if (vehicleBaseline > 0) fuelDetails.push("+1 vehicle baseline");
          consumedParts.push(`Fuel: -${used} (${fuelDetails.join(", ")})`);
        }
      }

      // 4c. Basic supplies: 1 per unit per turn
      if (supply.basicSupplies.current > 0) {
        supplyUpdate["system.supply.basicSupplies.current"] = Math.max(0, supply.basicSupplies.current - 1);
        consumedParts.push("Basic: -1");
      }

      // Apply all supply updates at once
      if (Object.keys(supplyUpdate).length > 0) {
        await actor.update(supplyUpdate);

        await ChatMessage.create({
          content: `<div class="star-mercs chat-card consolidation-supply">
            <div class="summary-header"><i class="fas fa-box"></i> <strong>${token?.name ?? actor.name}</strong> — Supply Consumed</div>
            <div class="status-update">${consumedParts.join(" | ")}</div>
          </div>`,
          speaker: { alias: "Star Mercs" }
        });
      }
    }

    // 5. Store damage-taken map as a combat flag so the morale button can access it
    const dmgMapObj = {};
    for (const [tokenId, dmg] of damageTakenMap) {
      dmgMapObj[tokenId] = dmg;
    }
    await this.setFlag("star-mercs", "damageTakenThisTurn", dmgMapObj);

    // 6. Post morale button chat card instead of auto-running morale
    const moraleContent = await renderTemplate(
      "systems/star-mercs/templates/chat/morale-button.hbs",
      { combatId: this.id }
    );
    await ChatMessage.create({
      content: moraleContent,
      speaker: { alias: "Star Mercs" }
    });
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
   * Natural 1 on the die always fails regardless of modifiers.
   * @param {number} dieResult - Raw d10 result.
   * @param {number} damageTaken - Strength damage taken this turn.
   * @param {number} readiness - Current readiness value.
   * @returns {{total: number, passed: boolean, autoFail: boolean}}
   * @private
   */
  _evaluateMoraleRoll(dieResult, damageTaken, readiness) {
    // Natural 1 always fails
    if (dieResult === 1) {
      return { total: dieResult, passed: false, autoFail: true };
    }
    let total = dieResult;
    total += damageTaken;
    const passed = total <= readiness;
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
   * Comms chain effects:
   *   - Isolated (chain size 1): re-roll successful morale (forced to use worse result)
   *   - Command in chain: re-roll failed morale (get a second chance)
   *   - Natural 1 always fails (no re-roll can save it for isolation; Command still re-rolls)
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
              <div class="summary-header"><i class="fas fa-shield-alt"></i> <strong>${token.name}</strong> — Morale Recovered</div>
              <div class="status-update">No damage taken — ${isBreaking ? "Breaking" : "Broken"} status removed.</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
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
        html += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${token.name}</strong> — Morale Check (${statusLabel})</div>`;
        html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
        if (damageTaken > 0) html += ` +${damageTaken} dmg`;
        if (result.autoFail) html += ` (NAT 1 AUTO-FAIL)`;
        html += ` = ${result.total} vs RDY ${currentReadiness} — ${result.passed ? "Passed" : "Failed"}</div>`;

        if (rerollType === "isolation") {
          html += `<div class="morale-reroll isolation">Isolation re-roll (no comms link): ${rerollRollObj.total}`;
          if (damageTaken > 0) html += ` +${damageTaken}`;
          if (rerollEval.autoFail) html += ` (NAT 1)`;
          html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
        } else if (rerollType === "command") {
          html += `<div class="morale-reroll command">Command re-roll: ${rerollRollObj.total}`;
          if (damageTaken > 0) html += ` +${damageTaken}`;
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
          rolls: allRolls
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
      html += `<div class="summary-header"><i class="fas fa-brain"></i> <strong>${token.name}</strong> — Morale Check</div>`;
      html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
      if (damageTaken > 0) html += ` +${damageTaken} dmg`;
      if (result.autoFail) html += ` (NAT 1 AUTO-FAIL)`;
      html += ` = ${result.total} vs RDY ${currentReadiness} — ${result.passed ? "Passed" : "Failed"}</div>`;

      if (rerollType === "isolation") {
        html += `<div class="morale-reroll isolation">Isolation re-roll (no comms link): ${rerollRollObj.total}`;
        if (damageTaken > 0) html += ` +${damageTaken}`;
        if (rerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (rerollType === "command") {
        html += `<div class="morale-reroll command">Command re-roll: ${rerollRollObj.total}`;
        if (damageTaken > 0) html += ` +${damageTaken}`;
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
        rolls: allRolls
      });

      // Apply Breaking status and log
      if (!finalPassed) {
        await token.setFlag("star-mercs", "breaking", true);
        await actor.addLogEntry(`Morale FAILED: rolled ${roll.total} +${damageTaken} dmg = ${result.total} vs RDY ${currentReadiness} — BREAKING`, "morale");
      } else {
        await actor.addLogEntry(`Morale passed: rolled ${roll.total} +${damageTaken} dmg = ${result.total} vs RDY ${currentReadiness}`, "morale");
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
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "assault") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const assaultTargetId = token.getFlag("star-mercs", "assaultTarget");
      if (!assaultTargetId) continue;

      const attackerCanvasToken = canvas?.tokens?.get(token.id);
      const targetCanvasToken = canvas?.tokens?.get(assaultTargetId);
      if (!targetCanvasToken?.actor) continue;
      const targetActor = targetCanvasToken.actor;
      if (targetActor.system.strength.value <= 0) continue;

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
              <div class="summary-header"><i class="fas fa-fist-raised"></i> <strong>${token.name}</strong> — Assault Movement: -${hexesMoved} readiness (${distanceToTarget} hex${distanceToTarget > 1 ? "es" : ""} to target)</div>
            </div>`,
            speaker: { alias: "Star Mercs" }
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

      // Roll morale for both
      const assaultRoll = new Roll("1d10");
      await assaultRoll.evaluate();
      const aResult = this._evaluateMoraleRoll(assaultRoll.total, attackerDmg, attackerReadiness);

      const defenderRoll = new Roll("1d10");
      await defenderRoll.evaluate();
      const dResult = this._evaluateMoraleRoll(defenderRoll.total, defenderDmg, defenderReadiness);

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
        dRerollEval = this._evaluateMoraleRoll(dRerollObj.total, defenderDmg, defenderReadiness);
        dFinalPassed = dRerollEval.passed;
      } else if (!dResult.passed && defenderComms.hasCommandInChain) {
        dRerollType = "command";
        dRerollObj = new Roll("1d10");
        await dRerollObj.evaluate();
        allRolls.push(dRerollObj);
        dRerollEval = this._evaluateMoraleRoll(dRerollObj.total, defenderDmg, defenderReadiness);
        dFinalPassed = dRerollEval.passed;
      }

      // Build chat message
      let html = `<div class="star-mercs chat-card assault-morale">`;
      html += `<div class="summary-header"><i class="fas fa-fist-raised"></i> Assault Resolution: <strong>${token.name}</strong> vs <strong>${targetCanvasToken.name}</strong></div>`;

      // Attacker roll details
      html += `<div class="morale-details">${token.name}: Roll ${assaultRoll.total}`;
      if (attackerDmg > 0) html += ` +${attackerDmg} dmg`;
      if (aResult.autoFail) html += ` (NAT 1)`;
      html += ` = ${aResult.total} vs RDY ${attackerReadiness} — ${aResult.passed ? "Passed" : "Failed"}</div>`;
      if (aRerollType === "isolation") {
        html += `<div class="morale-reroll isolation">${token.name} Isolation re-roll: ${aRerollObj.total}`;
        if (attackerDmg > 0) html += ` +${attackerDmg}`;
        if (aRerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${aRerollEval.total} — ${aRerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (aRerollType === "command") {
        html += `<div class="morale-reroll command">${token.name} Command re-roll: ${aRerollObj.total}`;
        if (attackerDmg > 0) html += ` +${attackerDmg}`;
        if (aRerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${aRerollEval.total} — ${aRerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      // Defender roll details
      html += `<div class="morale-details">${targetCanvasToken.name}: Roll ${defenderRoll.total}`;
      if (defenderDmg > 0) html += ` +${defenderDmg} dmg`;
      if (dResult.autoFail) html += ` (NAT 1)`;
      html += ` = ${dResult.total} vs RDY ${defenderReadiness} — ${dResult.passed ? "Passed" : "Failed"}</div>`;
      if (dRerollType === "isolation") {
        html += `<div class="morale-reroll isolation">${targetCanvasToken.name} Isolation re-roll: ${dRerollObj.total}`;
        if (defenderDmg > 0) html += ` +${defenderDmg}`;
        if (dRerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${dRerollEval.total} — ${dRerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (dRerollType === "command") {
        html += `<div class="morale-reroll command">${targetCanvasToken.name} Command re-roll: ${dRerollObj.total}`;
        if (defenderDmg > 0) html += ` +${defenderDmg}`;
        if (dRerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${dRerollEval.total} — ${dRerollEval.passed ? "Passed" : "Failed"}</div>`;
      }

      if (aFinalPassed && dFinalPassed) {
        // Both pass: stalemate
        html += `<div class="status-update morale-passed"><i class="fas fa-handshake"></i> Stalemate — both sides hold their ground.</div>`;
      } else if (!aFinalPassed && dFinalPassed) {
        // Attacker fails, defender passes: attacker Breaking, loses 2 RDY
        const newRdy = Math.max(0, actor.system.readiness.value - 2);
        await actor.update({ "system.readiness.value": newRdy });
        await token.setFlag("star-mercs", "breaking", true);
        html += `<div class="status-alert morale-failed"><i class="fas fa-shield-alt"></i> Assault repelled! ${token.name} is Breaking, loses 2 readiness.</div>`;
      } else if (aFinalPassed && !dFinalPassed) {
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
        rolls: allRolls
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
      html += `<div class="summary-header"><i class="fas fa-running"></i> <strong>${token.name}</strong> — Withdraw Morale Test</div>`;
      html += `<div class="morale-details">RDY: ${currentReadiness} | Roll: ${roll.total}`;
      if (result.autoFail) html += ` (NAT 1 AUTO-FAIL)`;
      html += ` = ${result.total} vs RDY ${currentReadiness} — ${result.passed ? "Passed" : "Failed"}</div>`;

      if (rerollType === "isolation") {
        html += `<div class="morale-reroll isolation">Isolation re-roll (no comms link): ${rerollRollObj.total}`;
        if (rerollEval.autoFail) html += ` (NAT 1)`;
        html += ` = ${rerollEval.total} — ${rerollEval.passed ? "Passed" : "Failed"}</div>`;
      } else if (rerollType === "command") {
        html += `<div class="morale-reroll command">Command re-roll: ${rerollRollObj.total}`;
        if (rerollEval.autoFail) html += ` (NAT 1)`;
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
        rolls: allRolls
      });
    }
  }

  /* ---------------------------------------- */
  /*  Tactical Sub-Step System                */
  /* ---------------------------------------- */

  /**
   * Dispatch execution to the appropriate tactical sub-step handler.
   * After execution, posts a "Next Step" chat button or advances to consolidation.
   * @param {number} stepIndex - Index into TACTICAL_STEPS.
   * @private
   */
  async _executeTacticalStep(stepIndex) {
    const step = StarMercsCombat.TACTICAL_STEPS[stepIndex];

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
      case "assault":
        await this._runAssaultStep();
        break;
      case "movement":
        await this._runMovementStep();
        break;
      case "maneuver_fire":
        await this._runManeuverFire();
        break;
    }

    // Post "Next Step" button if more steps remain
    if (stepIndex < StarMercsCombat.TACTICAL_STEPS.length - 1) {
      await this._postNextStepButton(stepIndex);
    } else {
      await this._postStepComplete();
    }
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

      const artilleryWeapons = actor.items.filter(
        i => i.type === "weapon" && i.system.artillery && i.system.targetId
      );
      if (artilleryWeapons.length === 0) continue;

      for (const weapon of artilleryWeapons) {
        const targetToken = canvas.tokens.get(weapon.system.targetId);
        if (!targetToken?.actor) continue;
        await actor.rollAttack(weapon, targetToken.actor);
        firedCount++;
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

      const aircraftWeapons = actor.items.filter(
        i => i.type === "weapon" && i.system.aircraft && i.system.targetId
      );
      if (aircraftWeapons.length === 0) continue;

      for (const weapon of aircraftWeapons) {
        const targetToken = canvas.tokens.get(weapon.system.targetId);
        if (!targetToken?.actor) continue;
        await actor.rollAttack(weapon, targetToken.actor);
        firedCount++;
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

      const order = this._getActorOrder(actor);
      if (order && !order.system.allowsAttack) continue;

      // Maneuver units fire in the maneuver_fire step (after movement)
      if (actor.system.currentOrder === "move") continue;

      const weapons = actor.items.filter(
        i => i.type === "weapon" && i.system.targetId
          && !i.system.artillery && !i.system.aircraft
      );
      if (weapons.length === 0) continue;

      for (const weapon of weapons) {
        const targetToken = canvas.tokens.get(weapon.system.targetId);
        if (!targetToken?.actor) continue;
        await actor.rollAttack(weapon, targetToken.actor);
        firedCount++;
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
   * Execute the assault step: move assaulting units adjacent to their targets.
   * Deducts -1 readiness per hex moved.
   * @private
   */
  async _runAssaultStep() {
    let assaultCount = 0;
    for (const combatant of this.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      if (actor.system.currentOrder !== "assault") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      const assaultTargetId = token.getFlag("star-mercs", "assaultTarget");
      if (!assaultTargetId) continue;

      const attackerToken = canvas.tokens.get(token.id);
      const targetToken = canvas.tokens.get(assaultTargetId);
      if (!attackerToken || !targetToken) continue;

      // Already adjacent — no movement needed
      if (areAdjacent(attackerToken, targetToken)) {
        assaultCount++;
        continue;
      }

      // Find the best adjacent hex to the target
      const adjacentHex = findBestAdjacentHex(targetToken, attackerToken);
      if (!adjacentHex) {
        await ChatMessage.create({
          content: `<div class="star-mercs chat-card tactical-step">
            <div class="status-alert"><i class="fas fa-exclamation-triangle"></i> <strong>${token.name}</strong> cannot reach assault target — all adjacent hexes blocked.</div>
          </div>`,
          speaker: { alias: "Star Mercs" }
        });
        continue;
      }

      // Calculate hex distance moved
      const distance = StarMercsActor.getHexDistance(attackerToken, targetToken);
      const hexesMoved = Math.max(0, distance - 1);

      // Move the token
      const topLeft = canvas.grid.getTopLeftPoint(adjacentHex);
      await token.update({ x: topLeft.x, y: topLeft.y });

      // Track movement for fuel consumption
      await token.setFlag("star-mercs", "movementUsed", hexesMoved);

      // Deduct readiness: -1 per hex moved
      if (hexesMoved > 0) {
        const newRdy = Math.max(0, actor.system.readiness.value - hexesMoved);
        await actor.update({ "system.readiness.value": newRdy });

        await ChatMessage.create({
          content: `<div class="star-mercs chat-card tactical-step">
            <div class="summary-header"><i class="fas fa-fist-raised"></i> <strong>${token.name}</strong> — Assault Movement</div>
            <div class="status-update">Moved ${hexesMoved} hex${hexesMoved > 1 ? "es" : ""} to assault target. -${hexesMoved} readiness.</div>
          </div>`,
          speaker: { alias: "Star Mercs" }
        });
      }

      // Fire weapons at the assault target
      const weapons = actor.items.filter(
        i => i.type === "weapon" && !i.system.artillery && !i.system.aircraft
      );
      for (const weapon of weapons) {
        // Check range from new position
        const newAttackerToken = canvas.tokens.get(token.id);
        if (!newAttackerToken) break;
        const dist = StarMercsActor.getHexDistance(newAttackerToken, targetToken);
        if (dist <= weapon.system.range) {
          await actor.rollAttack(weapon, targetToken.actor);
        }
      }

      assaultCount++;
    }

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-fist-raised"></i> Assault Step Complete</div>
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

    if (movers.length === 0) {
      await ChatMessage.create({
        content: `<div class="star-mercs chat-card tactical-step">
          <div class="summary-header"><i class="fas fa-arrows-alt"></i> Movement Complete</div>
          <div class="status-update">No units to move.</div>
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

      const path = computeHexPath(canvasToken.center, mover.dest);

      if (mover.contestLost) {
        // Move to last hex before the contested destination
        const safePath = path.slice(0, -1);
        if (safePath.length > 0) {
          const safeHex = safePath[safePath.length - 1];
          const topLeft = canvas.grid.getTopLeftPoint(safeHex);
          await mover.token.update({ x: topLeft.x, y: topLeft.y });
          await mover.token.setFlag("star-mercs", "movementUsed", safePath.length);
        }
        movedCount++;
        continue;
      }

      // Check each step for overwatch triggers
      for (const step of path) {
        const overwatchTriggers = this._checkOverwatchTriggers(canvasToken, step);
        for (const owToken of overwatchTriggers) {
          await this._postOverwatchCard(owToken, canvasToken, step);
        }
      }

      // Move token to final destination
      if (path.length > 0) {
        const finalHex = path[path.length - 1];
        const topLeft = canvas.grid.getTopLeftPoint(finalHex);
        await mover.token.update({ x: topLeft.x, y: topLeft.y });
        await mover.token.setFlag("star-mercs", "movementUsed", path.length);
      }
      movedCount++;
    }

    // 5. Refresh engagement status for all tokens
    this._refreshEngagementStatus();

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card tactical-step">
        <div class="summary-header"><i class="fas fa-arrows-alt"></i> Movement Complete</div>
        <div class="status-update">${movedCount} unit${movedCount !== 1 ? "s" : ""} moved.</div>
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
  _checkOverwatchTriggers(movingToken, stepPosition) {
    const triggers = [];
    const movingTeam = movingToken.actor?.system?.team ?? "a";

    for (const token of canvas.tokens.placeables) {
      if (token === movingToken) continue;
      if (!token.actor || token.actor.type !== "unit") continue;
      if (token.actor.system.strength.value <= 0) continue;
      if (token.actor.system.currentOrder !== "overwatch") continue;

      const owTeam = token.actor.system.team ?? "a";
      if (owTeam === movingTeam) continue;

      // Check if any weapon is in range of the step position
      const owCenter = snapToHexCenter(token.center);
      const stepSnapped = snapToHexCenter(stepPosition);
      const dx = owCenter.x - stepSnapped.x;
      const dy = owCenter.y - stepSnapped.y;
      const pixelDist = Math.sqrt(dx * dx + dy * dy);
      const gridSize = canvas.grid.size || 100;
      const hexDist = Math.round(pixelDist / gridSize);

      const hasWeaponInRange = token.actor.items.some(
        w => w.type === "weapon" && w.system.range >= hexDist
      );

      if (hasWeaponInRange) {
        triggers.push(token);
      }
    }
    return triggers;
  }

  /**
   * Post an overwatch trigger chat card with Fire/Hold buttons.
   * @param {Token} overwatchToken - The overwatch unit.
   * @param {Token} movingToken - The unit triggering overwatch.
   * @param {{x: number, y: number}} triggerPosition - Where the trigger occurred.
   * @private
   */
  async _postOverwatchCard(overwatchToken, movingToken, triggerPosition) {
    const html = `<div class="star-mercs chat-card overwatch-trigger">
      <div class="summary-header"><i class="fas fa-eye"></i> Overwatch Triggered!</div>
      <div class="status-update"><strong>${overwatchToken.name}</strong> spots
        <strong>${movingToken.name}</strong> entering weapon range.</div>
      <div class="overwatch-actions">
        <button class="overwatch-fire-btn"
          data-attacker-id="${overwatchToken.document.id}"
          data-target-id="${movingToken.document.id}"
          data-combat-id="${this.id}">
          <i class="fas fa-crosshairs"></i> Fire Overwatch
        </button>
        <button class="overwatch-skip-btn">
          <i class="fas fa-hand-paper"></i> Hold Fire
        </button>
      </div>
    </div>`;

    await ChatMessage.create({ content: html, speaker: { alias: "Star Mercs" } });
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

      roundDetails.push(`Round ${rounds}: ${token1.name} (RDY ${rdy1} - ${roll1.total} = ${margin1}) vs ${token2.name} (RDY ${rdy2} - ${roll2.total} = ${margin2})`);

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
    html += `<div class="status-update"><strong>${token1.name}</strong> vs <strong>${token2.name}</strong> both target the same hex.</div>`;
    for (const detail of roundDetails) {
      html += `<div class="morale-details">${detail}</div>`;
    }
    html += `<div class="status-alert"><strong>${winner.name}</strong> wins the hex! <strong>${loser.name}</strong> stops short.</div>`;
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
    const engagedEffect = CONFIG.statusEffects.find(e => e.id === "engaged");
    if (!engagedEffect || !canvas?.tokens?.placeables) return;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.type !== "unit") continue;
      if (token.actor.system.strength.value <= 0) continue;

      const engaged = isEngaged(token);
      const hasEffect = token.document.hasStatusEffect("engaged");
      if (engaged && !hasEffect) {
        token.document.toggleActiveEffect(engagedEffect, { active: true });
      } else if (!engaged && hasEffect) {
        token.document.toggleActiveEffect(engagedEffect, { active: false });
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
      if (actor.system.currentOrder !== "move") continue;
      if (actor.system.strength.value <= 0) continue;

      const token = combatant.token;
      if (!token) continue;

      // Check if this unit has non-artillery, non-aircraft weapons
      const weapons = actor.items.filter(
        i => i.type === "weapon" && !i.system.artillery && !i.system.aircraft
      );
      if (weapons.length === 0) continue;

      // Post a chat card with a fire button for this unit
      const weaponList = weapons.map(w => `${w.name} (D${w.system.damage}/R${w.system.range})`).join(", ");

      await ChatMessage.create({
        content: `<div class="star-mercs chat-card maneuver-fire-card">
          <div class="summary-header"><i class="fas fa-running"></i> <strong>${token.name}</strong> — Maneuver Fire</div>
          <div class="status-update">Weapons: ${weaponList}</div>
          <div class="status-update">Select targets using Foundry targeting (T + click), then click Fire.</div>
          <div class="status-update"><em>Accuracy penalty: +1 (Maneuver order)</em></div>
          <button class="maneuver-fire-btn"
            data-token-id="${token.id}"
            data-combat-id="${this.id}">
            <i class="fas fa-crosshairs"></i> Fire Weapons
          </button>
        </div>`,
        speaker: { alias: "Star Mercs" }
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
        // 3. Clear per-type weapons fired counters
        await token.unsetFlag("star-mercs", "weaponsFired_smallArms");
        await token.unsetFlag("star-mercs", "weaponsFired_heavyWeapons");
        await token.unsetFlag("star-mercs", "weaponsFired_ordnance");
        // 4. Clear disordered flag (resets each turn)
        await token.unsetFlag("star-mercs", "disordered");
        // 5. Clear firedAtThisTurn flag
        await token.unsetFlag("star-mercs", "firedAtThisTurn");
        // 6. Clear per-weapon fired list and "Fired" status effect
        await token.unsetFlag("star-mercs", "firedWeapons");
        if (token.hasStatusEffect("fired")) {
          const firedEffect = CONFIG.statusEffects.find(e => e.id === "fired");
          if (firedEffect) await token.toggleActiveEffect(firedEffect, { active: false });
        }
      }

      // 7. Clear current order
      await actor.update({ "system.currentOrder": "" });
    }

    // Clear tactical step counter
    await this.unsetFlag("star-mercs", "tacticalStep");
  }
}
