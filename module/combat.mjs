/**
 * Combat resolution engine for Star Mercs.
 *
 * Handles the full attack pipeline: validation, accuracy calculation,
 * hit determination, damage calculation, and result packaging.
 *
 * EWAR: Increases the accuracy threshold needed to hit (makes unit harder to hit).
 * Armored[X]: Reduces incoming damage by X.
 * Entrenched: Reduces incoming damage by 1.
 * Fortified: Reduces incoming damage by 2.
 * Heavy: Soft attacks only hit on natural 10.
 */

/**
 * Validate whether a weapon can target a specific unit based on attack type
 * and target traits.
 *
 * @param {Item} weapon - The weapon being fired.
 * @param {StarMercsActor} target - The target unit.
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateAttack(weapon, target) {
  const attackType = weapon.system.attackType;
  const isFlying = target.hasTrait("Flying");
  const isHovering = target.hasTrait("Hover");
  const isHeavy = target.hasTrait("Heavy");

  // Flying units can only be hit by anti-air
  if (isFlying && !isHovering && attackType !== "antiAir") {
    return { valid: false, reason: `${target.name} is Flying — only Anti-Air weapons can target it.`, softVsHeavy: false };
  }

  // Anti-air weapons can only target units with the Flying trait
  if (attackType === "antiAir" && !isFlying) {
    return { valid: false, reason: `${weapon.name} (Anti-Air) can only target units with the Flying trait.`, softVsHeavy: false };
  }

  // Soft attack vs Heavy: allowed, but only a natural 10 can hit
  const softVsHeavy = attackType === "soft" && isHeavy;

  return { valid: true, reason: null, softVsHeavy };
}

/**
 * Calculate the effective accuracy threshold for an attack,
 * based on the attacker's unit rating, weapon traits, readiness, and target EWAR.
 *
 * Rating thresholds: Green 7+, Trained 6+, Experienced 5+, Veteran 4+, Elite 3+
 * Accurate[X]: reduces threshold by X (easier to hit)
 * Inaccurate[X]: increases threshold by X (harder to hit)
 *
 * @param {Item} weapon - The weapon being fired.
 * @param {StarMercsActor} attacker - The attacking unit.
 * @param {StarMercsActor} [target] - The target unit (for EWAR).
 * @returns {{effective: number, base: number, readinessMod: number, ewarMod: number, accurateMod: number, inaccurateMod: number}}
 */
export function calculateAccuracy(weapon, attacker, target = null) {
  // Base accuracy from unit rating
  const ratingData = CONFIG.STARMERCS.ratings?.[attacker.system.rating];
  const base = ratingData?.accuracy ?? 7;

  // Weapon trait modifiers: Accurate reduces threshold, Inaccurate increases it
  const accurateMod = weapon.system.accurate ?? 0;
  const inaccurateMod = weapon.system.inaccurate ?? 0;

  // Readiness penalty: +1 to accuracy needed if readiness ≤ 70%
  const readinessMod = attacker.system.readinessPenalty?.accuracy ?? 0;

  // EWAR: target's EWAR increases the accuracy threshold (harder to hit)
  const ewarMod = target ? (target.system.ewar ?? 0) : 0;

  const effective = Math.max(2, Math.min(10, base - accurateMod + inaccurateMod + readinessMod + ewarMod));

  return { effective, base, readinessMod, ewarMod, accurateMod, inaccurateMod };
}

/**
 * Determine the hit result from a d10 roll against an accuracy threshold.
 *
 * @param {number} rollTotal - The d10 result.
 * @param {number} effectiveAccuracy - The target number to hit.
 * @returns {{hit: boolean, type: string}}
 *   type: "critical_miss" | "miss" | "partial" | "hit" | "critical_hit"
 */
export function determineHitResult(rollTotal, effectiveAccuracy) {
  if (rollTotal === 1) return { hit: false, type: "critical_miss" };
  if (rollTotal === 10) return { hit: true, type: "critical_hit" };
  if (rollTotal < effectiveAccuracy) return { hit: false, type: "miss" };
  if (rollTotal === effectiveAccuracy) return { hit: true, type: "partial" };
  return { hit: true, type: "hit" };
}

/**
 * Calculate final damage after all modifiers.
 *
 * Pipeline:
 * 1. Base damage from weapon
 * 2. +1 for critical, -1 for partial
 * 3. -N for attacker casualty penalty
 * 4. -1 for attacker readiness ≤ 4
 * 5. +1 for Area weapon vs Infantry
 * 6. Half for hard-vs-infantry (rounded down)
 * 7. -X for target Armored[X]
 * 8. -1 for target Entrenched
 * 9. -2 for target Fortified
 * 10. Floor at min 1
 *
 * @param {Item} weapon - The weapon used.
 * @param {StarMercsActor} attacker - The attacking unit.
 * @param {StarMercsActor} target - The target unit.
 * @param {string} hitType - The hit result type.
 * @returns {{final: number, base: number, modifiers: Array<{label: string, value: number}>}}
 */
export function calculateDamage(weapon, attacker, target, hitType) {
  const base = weapon.system.damage;
  const modifiers = [];
  let damage = base;

  // Critical / partial modifiers
  if (hitType === "critical_hit") {
    damage += 1;
    modifiers.push({ label: "Critical Hit", value: +1 });
  } else if (hitType === "partial") {
    damage -= 1;
    modifiers.push({ label: "Partial Success", value: -1 });
  }

  // Attacker casualty penalty
  const casualtyPenalty = attacker.system.casualtyPenalty ?? 0;
  if (casualtyPenalty > 0) {
    damage -= casualtyPenalty;
    modifiers.push({ label: "Casualty Penalty", value: -casualtyPenalty });
  }

  // Attacker readiness damage penalty (≤ 4)
  const readinessDmg = attacker.system.readinessPenalty?.damage ?? 0;
  if (readinessDmg !== 0) {
    damage += readinessDmg; // readinessDmg is already negative
    modifiers.push({ label: "Low Readiness", value: readinessDmg });
  }

  // Assault order: +1 damage dealt to assault target
  if (attacker.system.currentOrder === "assault") {
    const attackerToken = canvas?.tokens?.placeables.find(t => t.actor === attacker);
    const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
    const assaultTargetId = attackerToken?.document?.getFlag("star-mercs", "assaultTarget");
    if (assaultTargetId && targetToken?.id === assaultTargetId) {
      damage += 1;
      modifiers.push({ label: "Assault (+1 damage)", value: +1 });
    }
  }

  // Assault order on target: +1 damage received from all sources
  if (target.system.currentOrder === "assault") {
    damage += 1;
    modifiers.push({ label: "Target assaulting (+1 incoming)", value: +1 });
  }

  // Area weapon trait: +1 damage vs Infantry
  if (weapon.system.area && target.hasTrait("Infantry")) {
    damage += 1;
    modifiers.push({ label: "Area vs Infantry", value: +1 });
  }

  // Hard attack vs Infantry: half damage (rounded down)
  if (weapon.system.attackType === "hard" && target.hasTrait("Infantry")) {
    const before = damage;
    damage = Math.floor(damage / 2);
    const diff = damage - before;
    modifiers.push({ label: "Hard vs Infantry (half)", value: diff });
  }

  // Target Armored[X] damage reduction
  const armorValue = target.getTraitValue("Armored");
  if (armorValue > 0) {
    damage -= armorValue;
    modifiers.push({ label: `Armored[${armorValue}]`, value: -armorValue });
  }

  // Target Entrenched: -1 damage
  if (target.hasTrait("Entrenched")) {
    damage -= 1;
    modifiers.push({ label: "Entrenched", value: -1 });
  }

  // Target Fortified: -2 damage
  if (target.hasTrait("Fortified")) {
    damage -= 2;
    modifiers.push({ label: "Fortified", value: -2 });
  }

  // Floor at minimum 1 (if the attack hit, it always does at least 1)
  const final = Math.max(1, damage);

  return { final, base, modifiers };
}

/**
 * Resolve a full attack: validate, roll, calculate, and package results.
 * Does NOT apply damage — that is the caller's responsibility.
 *
 * @param {Item} weapon - The weapon being fired.
 * @param {StarMercsActor} attacker - The attacking unit.
 * @param {StarMercsActor} target - The target unit.
 * @returns {Promise<{
 *   valid: boolean,
 *   reason: string|null,
 *   roll: Roll|null,
 *   accuracy: object|null,
 *   hitResult: object|null,
 *   damage: object|null,
 *   weapon: Item,
 *   attacker: StarMercsActor,
 *   target: StarMercsActor
 * }>}
 */
export async function resolveAttack(weapon, attacker, target) {
  // Step 1: Validate
  const validation = validateAttack(weapon, target);
  if (!validation.valid) {
    return {
      valid: false,
      reason: validation.reason,
      roll: null,
      accuracy: null,
      hitResult: null,
      damage: null,
      weapon,
      attacker,
      target
    };
  }

  // Track soft-vs-Heavy flag for chat display
  const softVsHeavy = validation.softVsHeavy;

  // Step 2: Calculate accuracy
  const accuracy = calculateAccuracy(weapon, attacker, target);

  // Step 3: Roll
  const roll = new Roll("1d10");
  await roll.evaluate();

  // Step 4: Determine hit
  let hitResult = determineHitResult(roll.total, accuracy.effective);

  // Step 4b: Soft vs Heavy — only a natural 10 can hit
  if (softVsHeavy && roll.total !== 10) {
    hitResult = { hit: false, type: "miss" };
  }

  // Step 5: Calculate damage (only if hit)
  let damage = null;
  if (hitResult.hit) {
    if (softVsHeavy) {
      // Soft vs Heavy on natural 10: always exactly 1 damage
      damage = { final: 1, base: weapon.system.damage, modifiers: [{ label: "Soft vs Heavy (fixed)", value: null }] };
    } else {
      damage = calculateDamage(weapon, attacker, target, hitResult.type);
    }
  }

  return {
    valid: true,
    reason: null,
    roll,
    accuracy,
    hitResult,
    damage,
    softVsHeavy,
    weapon,
    attacker,
    target
  };
}

/**
 * Labels for hit result types.
 */
export const HIT_LABELS = {
  critical_miss: "Critical Miss",
  miss: "Miss",
  partial: "Partial Success",
  hit: "Hit",
  critical_hit: "Critical Hit"
};
