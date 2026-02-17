/**
 * Extended Actor class for Star Mercs units.
 * Provides convenience accessors for embedded items and trait checks.
 */
export default class StarMercsActor extends Actor {

  /** Convenience: get all weapon items. */
  get weapons() {
    return this.items.filter(i => i.type === "weapon");
  }

  /** Convenience: get all trait items. */
  get traits() {
    return this.items.filter(i => i.type === "trait");
  }

  /** Convenience: get all order items. */
  get orders() {
    return this.items.filter(i => i.type === "order");
  }

  /**
   * Check if the unit has a specific trait by name (case-insensitive).
   * @param {string} traitName - The trait name to check for.
   * @returns {boolean}
   */
  hasTrait(traitName) {
    return this.items.some(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
    );
  }

  /**
   * Get a trait's numeric value (the [X] parameter).
   * @param {string} traitName - The trait name to look up.
   * @returns {number} The trait value, or 0 if not found.
   */
  getTraitValue(traitName) {
    const trait = this.items.find(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
    );
    return trait ? trait.system.traitValue : 0;
  }

  /**
   * Roll a d10 attack with a weapon item, applying all modifiers.
   * @param {Item} weapon - The weapon item to attack with.
   * @returns {Promise<ChatMessage>}
   */
  async rollAttack(weapon) {
    const roll = new Roll("1d10");
    await roll.evaluate();

    const baseAccuracy = weapon.system.accuracy;
    const baseDamage = weapon.system.damage;

    // Apply readiness penalty to accuracy
    const accuracyPenalty = this.system.readinessPenalty?.accuracy ?? 0;
    const effectiveAccuracy = baseAccuracy + accuracyPenalty;

    // Determine hit result
    let result, finalDamage;
    if (roll.total === 1) {
      result = "Critical Miss";
      finalDamage = 0;
    } else if (roll.total === 10) {
      result = "Critical Hit";
      finalDamage = baseDamage + 1;
    } else if (roll.total === effectiveAccuracy) {
      result = "Partial Success";
      finalDamage = Math.max(1, baseDamage - 1);
    } else if (roll.total > effectiveAccuracy) {
      result = "Hit";
      finalDamage = baseDamage;
    } else {
      result = "Miss";
      finalDamage = 0;
    }

    // Apply casualty penalty and readiness damage penalty
    if (finalDamage > 0) {
      const casualtyPenalty = this.system.casualtyPenalty ?? 0;
      const readinessDmgPenalty = this.system.readinessPenalty?.damage ?? 0;
      finalDamage = Math.max(1, finalDamage - casualtyPenalty + readinessDmgPenalty);
    }

    // Apply EWAR note (EWAR reduces incoming damage, not outgoing — note for future)
    const flavor = [
      `<strong>${weapon.name}</strong> (${weapon.system.attackString})`,
      `<em>${result}</em>`,
      finalDamage > 0 ? `Damage: ${finalDamage}` : ""
    ].filter(Boolean).join(" — ");

    return roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor
    });
  }
}
