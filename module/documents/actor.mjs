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
   * @param {string} traitName
   * @returns {boolean}
   */
  hasTrait(traitName) {
    return this.items.some(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
    );
  }

  /**
   * Get a trait's numeric value (the [X] parameter).
   * @param {string} traitName
   * @returns {number} The trait value, or 0 if not found.
   */
  getTraitValue(traitName) {
    const trait = this.items.find(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
    );
    return trait ? trait.system.traitValue : 0;
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
    const result = await resolveAttack(weapon, this, target);

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
            invalid: true,
            invalidReason: result.reason
          }
        ),
        speaker: ChatMessage.getSpeaker({ actor: this })
      });
    }

    // Apply damage to target if hit
    let damageApplied = null;
    if (result.hitResult.hit && result.damage) {
      damageApplied = await target.applyDamage(result.damage.final, this);
    }

    // Build chat card
    const templateData = {
      attackerName: this.name,
      targetName: target.name,
      weaponName: weapon.name,
      attackString: weapon.system.attackString,
      attackType: weapon.system.attackType,
      invalid: false,
      roll: result.roll.total,
      accuracyBase: result.accuracy.base,
      accuracyEffective: result.accuracy.effective,
      ewarMod: result.accuracy.ewarMod,
      readinessMod: result.accuracy.readinessMod,
      hasAccuracyMods: result.accuracy.ewarMod > 0 || result.accuracy.readinessMod > 0,
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
      // Damage application results
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
      invalid: false,
      roll: roll.total,
      accuracyBase: accuracy.base,
      accuracyEffective: accuracy.effective,
      ewarMod: 0,
      readinessMod: accuracy.readinessMod,
      hasAccuracyMods: accuracy.readinessMod > 0,
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
}
