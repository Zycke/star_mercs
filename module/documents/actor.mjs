import { resolveAttack, validateAttack, calculateAccuracy, determineHitResult, calculateDamage, HIT_LABELS } from "../combat.mjs";
import { skillCheck } from "../dice.mjs";

/**
 * Extended Actor class for Star Mercs units.
 * Provides convenience accessors for embedded items, trait checks,
 * targeted attack resolution, and damage application.
 */
export default class StarMercsActor extends Actor {

  /* ---------------------------------------- */
  /*  Item Accessors                          */
  /* ---------------------------------------- */

  /** Get all weapon items. */
  get weapons() {
    return this.items.filter(i => i.type === "weapon");
  }

  /** Get all trait items. */
  get traits() {
    return this.items.filter(i => i.type === "trait");
  }

  /** Get all order items. */
  get orders() {
    return this.items.filter(i => i.type === "order");
  }

  /* ---------------------------------------- */
  /*  Trait Helpers                            */
  /* ---------------------------------------- */

  /**
   * Check if the unit has a specific trait by name (case-insensitive).
   * Only returns true if the trait is activated (checkbox checked).
   * @param {string} traitName
   * @returns {boolean}
   */
  hasTrait(traitName) {
    return this.items.some(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
      && i.system.active
    );
  }

  /**
   * Get a trait's numeric value (the [X] parameter).
   * Only returns value if the trait is activated.
   * @param {string} traitName
   * @returns {number} The trait value, or 0 if not found/inactive.
   */
  getTraitValue(traitName) {
    const trait = this.items.find(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
      && i.system.active
    );
    return trait ? trait.system.traitValue : 0;
  }

  /** Get all active trait items. */
  get activeTraits() {
    return this.items.filter(i => i.type === "trait" && i.system.active);
  }

  /* ---------------------------------------- */
  /*  Combat: Phase Enforcement               */
  /* ---------------------------------------- */

  /**
   * Check whether this actor can attack in the current combat state.
   * @returns {{allowed: boolean, reason: string|null}}
   */
  _checkAttackAllowed() {
    // Zero supply: cannot attack
    if (this.type === "unit" && (this.system.supply?.current ?? 1) <= 0) {
      return {
        allowed: false,
        reason: game.i18n.localize("STARMERCS.NoSupplyAttack")
      };
    }

    const combat = game.combat;
    if (!combat?.started) return { allowed: true, reason: null };
    return combat.canAttack(this);
  }

  /* ---------------------------------------- */
  /*  Utility: Hex Distance & Line of Sight   */
  /* ---------------------------------------- */

  /**
   * Check Line of Sight between two tokens using wall collision.
   * @param {Token} token1
   * @param {Token} token2
   * @returns {boolean} True if token1 can see token2.
   */
  static hasLineOfSight(token1, token2) {
    if (!token1 || !token2) return true;
    const ray = new Ray(token1.center, token2.center);
    // Check if any walls with sight restriction block the ray
    const walls = canvas.walls?.placeables ?? [];
    for (const wall of walls) {
      if (wall.document.sight === CONST.WALL_SENSE_TYPES.NONE) continue;
      const wallRay = new Ray(
        { x: wall.document.c[0], y: wall.document.c[1] },
        { x: wall.document.c[2], y: wall.document.c[3] }
      );
      if (foundry.utils.lineSegmentIntersects(ray.A, ray.B, wallRay.A, wallRay.B)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Calculate hex distance between two tokens.
   * @param {Token} token1
   * @param {Token} token2
   * @returns {number} Distance in hexes.
   */
  static getHexDistance(token1, token2) {
    const ray = new Ray(token1.center, token2.center);
    const segments = [{ ray }];
    const distance = canvas.grid.measureDistances(segments, { gridSpaces: true })[0];
    const gridDistance = canvas.scene.grid.distance || 1;
    return Math.round(distance / gridDistance);
  }

  /* ---------------------------------------- */
  /*  Combat: Attack Roll                     */
  /* ---------------------------------------- */

  /**
   * Roll a weapon attack, optionally against a targeted unit.
   *
   * If a target is provided, the full combat pipeline runs:
   * validation → accuracy (with EWAR) → roll → damage → apply.
   *
   * If no target, performs a standalone roll and posts to chat.
   *
   * @param {Item} weapon - The weapon item to attack with.
   * @param {StarMercsActor} [target=null] - The target unit actor.
   * @returns {Promise<ChatMessage>}
   */
  async rollAttack(weapon, target = null) {
    // Phase/order enforcement
    const attackCheck = this._checkAttackAllowed();
    if (!attackCheck.allowed) {
      ui.notifications.warn(attackCheck.reason);
      return null;
    }

    // --- Targeted attack: full pipeline ---
    if (target) {
      return this._rollTargetedAttack(weapon, target);
    }

    // --- Untargeted: standalone roll for display ---
    return this._rollStandaloneAttack(weapon);
  }

  /**
   * Full targeted attack pipeline using CombatResolver.
   * @private
   */
  async _rollTargetedAttack(weapon, target) {
    // Range check: find both tokens and measure hex distance
    const attackerToken = canvas?.tokens?.placeables.find(t => t.actor === this);
    const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (attackerToken && targetToken && weapon.system.range > 0) {
      const distance = StarMercsActor.getHexDistance(attackerToken, targetToken);
      if (distance > weapon.system.range) {
        ui.notifications.warn(
          game.i18n.format("STARMERCS.OutOfRange", { range: weapon.system.range, distance })
        );
        return null;
      }
    }

    const result = await resolveAttack(weapon, this, target);
    const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air" };

    // Attack was invalid (wrong weapon type, etc.)
    if (!result.valid) {
      return ChatMessage.create({
        content: await renderTemplate(
          "systems/star-mercs/templates/chat/attack-result.hbs",
          {
            attackerName: this.name,
            targetName: target.name,
            weaponName: weapon.name,
            attackString: weapon.system.attackString,
            attackType: weapon.system.attackType,
            attackTypeLabel: attackTypeLabels[weapon.system.attackType] ?? weapon.system.attackType,
            invalid: true,
            invalidReason: result.reason
          }
        ),
        speaker: ChatMessage.getSpeaker({ actor: this })
      });
    }

    // Determine whether to defer damage (active combat) or apply immediately (sandbox)
    let damageApplied = null;
    const deferDamage = game.combat?.started;

    if (result.hitResult.hit && result.damage) {
      if (deferDamage) {
        // Store as pending — will be applied during consolidation
        const maxStr = target.system.strength.max;
        const threshold = maxStr * 0.25;
        const readinessLoss = result.damage.final > threshold ? 2 : 1;

        // Find the target's token document
        const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
        if (targetToken) {
          await game.combat.addPendingDamage(
            targetToken.document, result.damage.final, readinessLoss,
            this.name, weapon.name
          );
        }
        damageApplied = { pending: true, damage: result.damage.final, readinessLost: readinessLoss };
      } else {
        damageApplied = await target.applyDamage(result.damage.final, this);
      }
    }

    // Build chat card
    const templateData = {
      attackerName: this.name,
      targetName: target.name,
      weaponName: weapon.name,
      attackString: weapon.system.attackString,
      attackType: weapon.system.attackType,
      attackTypeLabel: attackTypeLabels[weapon.system.attackType] ?? weapon.system.attackType,
      invalid: false,
      roll: result.roll.total,
      accuracyBase: result.accuracy.base,
      accuracyEffective: result.accuracy.effective,
      ewarMod: result.accuracy.ewarMod,
      readinessMod: result.accuracy.readinessMod,
      accurateMod: result.accuracy.accurateMod ?? 0,
      inaccurateMod: result.accuracy.inaccurateMod ?? 0,
      disorderedMod: result.accuracy.disorderedMod ?? 0,
      hasAccuracyMods: (result.accuracy.ewarMod > 0 || result.accuracy.readinessMod > 0 || (result.accuracy.accurateMod ?? 0) > 0 || (result.accuracy.inaccurateMod ?? 0) > 0 || (result.accuracy.disorderedMod ?? 0) !== 0),
      hitType: result.hitResult.type,
      hitLabel: HIT_LABELS[result.hitResult.type],
      isHit: result.hitResult.hit,
      isCriticalHit: result.hitResult.type === "critical_hit",
      isCriticalMiss: result.hitResult.type === "critical_miss",
      isPartial: result.hitResult.type === "partial",
      damage: result.damage?.final ?? 0,
      damageBase: result.damage?.base ?? 0,
      damageModifiers: result.damage?.modifiers ?? [],
      hasDamageModifiers: (result.damage?.modifiers?.length ?? 0) > 0,
      // Soft vs Heavy indicator
      softVsHeavy: result.softVsHeavy ?? false,
      // Damage application results
      damagePending: damageApplied?.pending ?? false,
      targetDestroyed: damageApplied?.destroyed ?? false,
      targetRouted: damageApplied?.routed ?? false,
      targetNewStrength: damageApplied?.newStrength ?? null,
      targetNewReadiness: damageApplied?.newReadiness ?? null,
      readinessLost: damageApplied?.readinessLost ?? 0
    };

    const content = await renderTemplate(
      "systems/star-mercs/templates/chat/attack-result.hbs",
      templateData
    );

    // Track weapons fired for supply consumption
    if (game.combat?.started && attackerToken) {
      const fired = attackerToken.document.getFlag("star-mercs", "weaponsFired") ?? 0;
      await attackerToken.document.setFlag("star-mercs", "weaponsFired", fired + 1);
    }

    return ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor: this }),
      rolls: [result.roll]
    });
  }

  /**
   * Standalone (untargeted) attack roll.
   * Uses the same accuracy and damage calculations but without target-specific modifiers.
   * @private
   */
  async _rollStandaloneAttack(weapon) {
    const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air" };
    const accuracy = calculateAccuracy(weapon, this);
    const roll = new Roll("1d10");
    await roll.evaluate();
    const hitResult = determineHitResult(roll.total, accuracy.effective);

    let damage = null;
    if (hitResult.hit) {
      // Standalone: no target, so only attacker-side modifiers apply
      const base = weapon.system.damage;
      let dmg = base;
      const modifiers = [];

      if (hitResult.type === "critical_hit") {
        dmg += 1;
        modifiers.push({ label: "Critical Hit", value: +1 });
      } else if (hitResult.type === "partial") {
        dmg -= 1;
        modifiers.push({ label: "Partial Success", value: -1 });
      }
      const casualtyPenalty = this.system.casualtyPenalty ?? 0;
      if (casualtyPenalty > 0) {
        dmg -= casualtyPenalty;
        modifiers.push({ label: "Casualty Penalty", value: -casualtyPenalty });
      }
      const readinessDmg = this.system.readinessPenalty?.damage ?? 0;
      if (readinessDmg !== 0) {
        dmg += readinessDmg;
        modifiers.push({ label: "Low Readiness", value: readinessDmg });
      }
      damage = { final: Math.max(1, dmg), base, modifiers };
    }

    const templateData = {
      attackerName: this.name,
      targetName: null,
      weaponName: weapon.name,
      attackString: weapon.system.attackString,
      attackType: weapon.system.attackType,
      attackTypeLabel: attackTypeLabels[weapon.system.attackType] ?? weapon.system.attackType,
      invalid: false,
      roll: roll.total,
      accuracyBase: accuracy.base,
      accuracyEffective: accuracy.effective,
      ewarMod: 0,
      readinessMod: accuracy.readinessMod,
      accurateMod: accuracy.accurateMod ?? 0,
      inaccurateMod: accuracy.inaccurateMod ?? 0,
      disorderedMod: 0,
      hasAccuracyMods: (accuracy.readinessMod > 0 || (accuracy.accurateMod ?? 0) > 0 || (accuracy.inaccurateMod ?? 0) > 0),
      hitType: hitResult.type,
      hitLabel: HIT_LABELS[hitResult.type],
      isHit: hitResult.hit,
      isCriticalHit: hitResult.type === "critical_hit",
      isCriticalMiss: hitResult.type === "critical_miss",
      isPartial: hitResult.type === "partial",
      damage: damage?.final ?? 0,
      damageBase: damage?.base ?? 0,
      damageModifiers: damage?.modifiers ?? [],
      hasDamageModifiers: (damage?.modifiers?.length ?? 0) > 0,
      targetDestroyed: false,
      targetRouted: false,
      targetNewStrength: null,
      targetNewReadiness: null,
      readinessLost: 0
    };

    const content = await renderTemplate(
      "systems/star-mercs/templates/chat/attack-result.hbs",
      templateData
    );

    return ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor: this }),
      rolls: [roll]
    });
  }

  /* ---------------------------------------- */
  /*  Combat: Fire All Targeted Weapons       */
  /* ---------------------------------------- */

  /**
   * Fire all weapons that have assigned targets simultaneously.
   *
   * Simultaneous resolution per the rules:
   * 1. All attacks are rolled and damage calculated.
   * 2. All damage is applied after all rolls are resolved.
   * 3. Weapon targets are cleared after firing.
   *
   * @returns {Promise<void>}
   */
  async rollAllAttacks() {
    // Phase/order enforcement
    const attackCheck = this._checkAttackAllowed();
    if (!attackCheck.allowed) {
      ui.notifications.warn(attackCheck.reason);
      return;
    }

    // Collect weapons with assigned targets (targetId stores token IDs)
    const attackerToken = canvas?.tokens?.placeables.find(t => t.actor === this);
    const targetedWeapons = [];
    for (const item of this.items) {
      if (item.type === "weapon" && item.system.targetId) {
        const targetToken = canvas?.tokens?.get(item.system.targetId);
        if (targetToken?.actor) {
          // Range check
          if (attackerToken && item.system.range > 0) {
            const distance = StarMercsActor.getHexDistance(attackerToken, targetToken);
            if (distance > item.system.range) {
              ui.notifications.warn(
                game.i18n.format("STARMERCS.OutOfRange", { range: item.system.range, distance })
                + ` (${item.name})`
              );
              continue;
            }
          }
          targetedWeapons.push({ weapon: item, target: targetToken.actor, targetToken });
        }
      }
    }

    if (targetedWeapons.length === 0) {
      ui.notifications.warn("No weapons have assigned targets.");
      return;
    }

    // Phase 1: Resolve all attacks (roll dice + calculate damage, no application yet)
    const results = [];
    for (const { weapon, target, targetToken } of targetedWeapons) {
      const result = await resolveAttack(weapon, this, target);
      result.targetTokenId = targetToken.id;
      result.targetTokenName = targetToken.name;
      results.push(result);
    }

    // Phase 2: Group damage by target token for simultaneous application
    const damageByTarget = new Map();
    for (const result of results) {
      if (result.valid && result.hitResult.hit && result.damage) {
        const tokenId = result.targetTokenId;
        if (!damageByTarget.has(tokenId)) {
          damageByTarget.set(tokenId, {
            target: result.target,
            targetName: result.targetTokenName,
            totalDamage: 0,
            hitDamages: []
          });
        }
        const entry = damageByTarget.get(tokenId);
        entry.totalDamage += result.damage.final;
        entry.hitDamages.push(result.damage.final);
      }
    }

    // Determine whether to defer damage (active combat) or apply immediately
    const deferDamage = game.combat?.started;

    // Apply or defer accumulated damage to each target
    const damageResults = new Map();
    for (const [targetId, { target, targetName, totalDamage, hitDamages }] of damageByTarget) {
      const maxStrength = target.system.strength.max;
      const threshold = maxStrength * 0.25;
      let totalReadinessLoss = 0;
      for (const dmg of hitDamages) {
        totalReadinessLoss += dmg > threshold ? 2 : 1;
      }

      if (deferDamage) {
        // Store as pending damage on the token
        const targetToken = canvas?.tokens?.get(targetId);
        if (targetToken) {
          await game.combat.addPendingDamage(
            targetToken.document, totalDamage, totalReadinessLoss,
            this.name, `${hitDamages.length} weapon(s)`
          );
        }
        damageResults.set(targetId, {
          pending: true,
          totalDamage,
          readinessLost: totalReadinessLoss
        });
      } else {
        const newStrength = Math.max(0, target.system.strength.value - totalDamage);
        const newReadiness = Math.max(0, target.system.readiness.value - totalReadinessLoss);

        await target.update({
          "system.strength.value": newStrength,
          "system.readiness.value": newReadiness
        });

        damageResults.set(targetId, {
          pending: false,
          newStrength,
          newReadiness,
          readinessLost: totalReadinessLoss,
          destroyed: newStrength <= 0,
          routed: newStrength > 0 && newReadiness <= 0
        });
      }
    }

    // Phase 3: Post individual attack results to chat
    const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air" };
    for (const result of results) {
      if (!result.valid) {
        await ChatMessage.create({
          content: await renderTemplate(
            "systems/star-mercs/templates/chat/attack-result.hbs",
            {
              attackerName: this.name,
              targetName: result.targetTokenName,
              weaponName: result.weapon.name,
              attackString: result.weapon.system.attackString,
              attackType: result.weapon.system.attackType,
              attackTypeLabel: attackTypeLabels[result.weapon.system.attackType] ?? result.weapon.system.attackType,
              invalid: true,
              invalidReason: result.reason
            }
          ),
          speaker: ChatMessage.getSpeaker({ actor: this })
        });
        continue;
      }

      const templateData = {
        attackerName: this.name,
        targetName: result.targetTokenName,
        weaponName: result.weapon.name,
        attackString: result.weapon.system.attackString,
        attackType: result.weapon.system.attackType,
        attackTypeLabel: attackTypeLabels[result.weapon.system.attackType] ?? result.weapon.system.attackType,
        invalid: false,
        roll: result.roll.total,
        accuracyBase: result.accuracy.base,
        accuracyEffective: result.accuracy.effective,
        ewarMod: result.accuracy.ewarMod,
        readinessMod: result.accuracy.readinessMod,
        accurateMod: result.accuracy.accurateMod ?? 0,
        inaccurateMod: result.accuracy.inaccurateMod ?? 0,
        hasAccuracyMods: (result.accuracy.ewarMod > 0 || result.accuracy.readinessMod > 0 || (result.accuracy.accurateMod ?? 0) > 0 || (result.accuracy.inaccurateMod ?? 0) > 0),
        hitType: result.hitResult.type,
        hitLabel: HIT_LABELS[result.hitResult.type],
        isHit: result.hitResult.hit,
        isCriticalHit: result.hitResult.type === "critical_hit",
        isCriticalMiss: result.hitResult.type === "critical_miss",
        isPartial: result.hitResult.type === "partial",
        damage: result.damage?.final ?? 0,
        damageBase: result.damage?.base ?? 0,
        damageModifiers: result.damage?.modifiers ?? [],
        hasDamageModifiers: (result.damage?.modifiers?.length ?? 0) > 0,
        softVsHeavy: result.softVsHeavy ?? false,
        damagePending: deferDamage,
        targetDestroyed: false,
        targetRouted: false,
        targetNewStrength: null,
        targetNewReadiness: null,
        readinessLost: 0
      };

      await ChatMessage.create({
        content: await renderTemplate(
          "systems/star-mercs/templates/chat/attack-result.hbs",
          templateData
        ),
        speaker: ChatMessage.getSpeaker({ actor: this }),
        rolls: [result.roll]
      });
    }

    // Phase 4: Post damage summary for each target that took hits
    for (const [tokenId, dmgResult] of damageResults) {
      const entry = damageByTarget.get(tokenId);
      if (!entry) continue;
      const targetName = entry.targetName;

      let statusHtml = `<div class="star-mercs chat-card fire-all-summary">`;
      statusHtml += `<div class="summary-header"><i class="fas fa-crosshairs"></i> <strong>${this.name}</strong> &rarr; <strong>${targetName}</strong></div>`;
      statusHtml += `<div class="summary-damage">Total Damage: <strong>${entry.totalDamage}</strong> (${entry.hitDamages.length} hit${entry.hitDamages.length > 1 ? "s" : ""})</div>`;

      if (dmgResult.pending) {
        statusHtml += `<div class="status-update pending"><i class="fas fa-clock"></i> Damage pending — applied in Consolidation</div>`;
      } else if (dmgResult.destroyed) {
        statusHtml += `<div class="status-alert destroyed"><i class="fas fa-skull-crossbones"></i> ${targetName} DESTROYED</div>`;
      } else if (dmgResult.routed) {
        statusHtml += `<div class="status-alert routed"><i class="fas fa-running"></i> ${targetName} ROUTED</div>`;
      } else {
        statusHtml += `<div class="status-update">${targetName}: STR ${dmgResult.newStrength} | RDY ${dmgResult.newReadiness} <span class="readiness-loss">(-${dmgResult.readinessLost} readiness)</span></div>`;
      }
      statusHtml += `</div>`;

      await ChatMessage.create({
        content: statusHtml,
        speaker: ChatMessage.getSpeaker({ actor: this })
      });
    }

    // Track weapons fired for supply consumption
    const validResults = results.filter(r => r.valid);
    if (game.combat?.started && attackerToken && validResults.length > 0) {
      const fired = attackerToken.document.getFlag("star-mercs", "weaponsFired") ?? 0;
      await attackerToken.document.setFlag("star-mercs", "weaponsFired", fired + validResults.length);
    }

    // Phase 5: Clear all weapon targets after firing
    const clearUpdates = [];
    for (const { weapon } of targetedWeapons) {
      clearUpdates.push({ _id: weapon.id, "system.targetId": "" });
    }
    if (clearUpdates.length > 0) {
      await this.updateEmbeddedDocuments("Item", clearUpdates);
    }
  }

  /* ---------------------------------------- */
  /*  Combat: Damage Application              */
  /* ---------------------------------------- */

  /**
   * Apply damage to this unit, reducing strength and readiness.
   *
   * Rules:
   * - Strength reduced by damage amount.
   * - Readiness reduced by 1. If single hit > 25% of max strength, lose 2 instead.
   * - If strength reaches 0, unit is destroyed.
   * - If readiness reaches 0, unit is routed.
   *
   * @param {number} damage - The final damage to apply.
   * @param {StarMercsActor} [source=null] - The actor that dealt the damage (for chat).
   * @returns {Promise<{newStrength: number, newReadiness: number, readinessLost: number, destroyed: boolean, routed: boolean}>}
   */
  async applyDamage(damage, source = null) {
    const currentStrength = this.system.strength.value;
    const maxStrength = this.system.strength.max;
    const currentReadiness = this.system.readiness.value;

    // Calculate new strength
    const newStrength = Math.max(0, currentStrength - damage);

    // Readiness loss: 1 normally, 2 if single hit > 25% of max strength
    const threshold = maxStrength * 0.25;
    const readinessLost = damage > threshold ? 2 : 1;
    const newReadiness = Math.max(0, currentReadiness - readinessLost);

    // Apply updates
    await this.update({
      "system.strength.value": newStrength,
      "system.readiness.value": newReadiness
    });

    const destroyed = newStrength <= 0;
    const routed = !destroyed && newReadiness <= 0;

    return {
      newStrength,
      newReadiness,
      readinessLost,
      destroyed,
      routed
    };
  }

  /* ---------------------------------------- */
  /*  Skill Checks                            */
  /* ---------------------------------------- */

  /**
   * Perform a skill check for this unit.
   * @param {object} [options] - Options passed to skillCheck.
   * @returns {Promise<object>}
   */
  async rollSkillCheck(options = {}) {
    return skillCheck(this, options);
  }

  /* ---------------------------------------- */
  /*  Supply Transfer                         */
  /* ---------------------------------------- */

  /**
   * Get the supply transfer range for this unit.
   * Base range is 1 hex (adjacent), extended by Supply[X] trait.
   * @returns {number}
   */
  getSupplyTransferRange() {
    const supplyTraitValue = this.getTraitValue("Supply");
    return 1 + supplyTraitValue;
  }

  /**
   * Transfer supply to another unit.
   * @param {StarMercsActor} targetActor - The target unit to receive supply.
   * @param {number} amount - Amount of supply to transfer.
   * @returns {Promise<boolean>} True if transfer succeeded.
   */
  async transferSupply(targetActor, amount) {
    if (!targetActor || targetActor.type !== "unit") return false;

    const currentSupply = this.system.supply.current;
    const targetSupply = targetActor.system.supply.current;
    const targetCapacity = targetActor.system.supply.capacity;

    // Clamp amount to what we have and what they can receive
    const actualAmount = Math.min(amount, currentSupply, targetCapacity - targetSupply);
    if (actualAmount <= 0) return false;

    // Execute transfer
    await this.update({ "system.supply.current": currentSupply - actualAmount });
    await targetActor.update({ "system.supply.current": targetSupply + actualAmount });

    // Post to chat
    await ChatMessage.create({
      content: `<div class="star-mercs chat-card supply-transfer">
        <div class="summary-header"><i class="fas fa-truck"></i> <strong>${this.name}</strong> &rarr; <strong>${targetActor.name}</strong></div>
        <div class="summary-damage">${game.i18n.format("STARMERCS.TransferSuccess", { amount: actualAmount, target: targetActor.name })}</div>
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor: this })
    });

    return true;
  }
}
