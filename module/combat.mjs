/**
 * Combat resolution engine for Star Mercs.
 *
 * Handles the full attack pipeline: validation, accuracy calculation,
 * hit determination, damage calculation, and result packaging.
 *
 * EWAR: Increases the accuracy threshold needed to hit (makes unit harder to hit).
 * Elevation: +1 to attack roll (−1 accuracy threshold) when firing from higher elevation.
 * Armored[X]: Reduces incoming damage by X.
 * Entrenched: Reduces incoming damage by 1.
 * Fortified: Reduces incoming damage by 2.
 * Heavy: Soft attacks only hit on natural 10.
 * APS/ZPS: Defensive weapon types that intercept ordnance-ammo attacks.
 */

import { getHexElevation, snapToHexCenter, getEffectiveElevation } from "./hex-utils.mjs";
import { getTerrainCoverMod, computeBestDetectionLevel } from "./detection.mjs";

/**
 * Validate whether a weapon can target a specific unit based on attack type
 * and target traits.
 *
 * @param {Item} weapon - The weapon being fired.
 * @param {StarMercsActor} target - The target unit.
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateAttack(weapon, target, attacker = null) {
  const attackType = weapon.system.attackType;

  // APS/ZPS are defensive-only — cannot target units
  if (attackType === "aps" || attackType === "zps") {
    return { valid: false, reason: `${weapon.name} is a defensive system — it cannot target units.`, softVsHeavy: false };
  }

  // Landed flying units cannot fire weapons
  if (attacker?.hasTrait("Flying") && attacker.getFlag("star-mercs", "landed")) {
    return { valid: false, reason: `${attacker.name} is landed — must take off to fire weapons.`, softVsHeavy: false };
  }

  // Packed Deploy-trait units cannot fire weapons
  if (attacker?.hasTrait("Deploy")) {
    const dState = attacker.getFlag("star-mercs", "deployState") ?? "packed";
    if (dState === "packed" || dState === "packing") {
      return { valid: false, reason: `${attacker.name} is packed — must deploy before firing.`, softVsHeavy: false };
    }
  }

  const isFlying = target.hasTrait("Flying");
  const isHovering = target.hasTrait("Hover");
  const isHeavy = target.hasTrait("Heavy");
  const isLanded = isFlying && target.getFlag("star-mercs", "landed");

  // Flying units can only be hit by anti-air or hybrid weapons (unless they are landed)
  if (isFlying && !isHovering && !isLanded && attackType !== "antiAir" && !weapon.system.hybrid) {
    return { valid: false, reason: `${target.name} is Flying — only Anti-Air or Hybrid weapons can target it.`, softVsHeavy: false };
  }

  // Anti-air weapons can only target units with the Flying trait (or Air Assault deployed)
  const targetTokenDoc = target.getActiveTokens(true)[0]?.document;
  const isAntiAirVulnerable = targetTokenDoc?.hasStatusEffect("air-assault") ?? false;
  if (attackType === "antiAir" && !isFlying && !isAntiAirVulnerable) {
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

  // Disordered target: -1 to threshold (easier to hit)
  let disorderedMod = 0;
  if (target) {
    const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (targetToken?.document?.getFlag("star-mercs", "disordered")) {
      disorderedMod = -1;
    }
  }

  // Stand Down target: -2 to threshold (much easier to hit)
  let standDownMod = 0;
  if (target?.system?.currentOrder === "stand_down") {
    standDownMod = -2;
  }

  // Order accuracy penalty (e.g., Maneuver = +1 to threshold)
  let orderAccuracyMod = 0;
  const orderKey = attacker.system.currentOrder;
  const orderConfig = CONFIG.STARMERCS.orders?.[orderKey];
  if (orderConfig?.accuracyPenalty) {
    orderAccuracyMod = orderConfig.accuracyPenalty;
  }

  // Resolve canvas tokens for attacker and target (used by multiple modifiers)
  const attackerToken = canvas?.tokens?.placeables.find(t => t.actor === attacker);
  const targetToken = target ? canvas?.tokens?.placeables.find(t => t.actor === target) : null;

  // Hot Disembark: cargo fires at -1 accuracy (Maneuver rules)
  if (attackerToken?.document?.getFlag("star-mercs", "hotDisembarked")) {
    orderAccuracyMod = Math.max(orderAccuracyMod, 1);
  }

  // Hot Disembark evasive: target transport has -1 to hit from attackers
  if (targetToken?.document?.getFlag("star-mercs", "hotDisembarkEvasive")) {
    orderAccuracyMod += 1;
  }

  // Area trait: -1 to threshold (easier to hit) for Soft and Anti-Air weapons
  let areaMod = 0;
  if (weapon.system.area && weapon.system.attackType !== "hard") {
    areaMod = -1;
  }

  // Elevation bonus: -1 to threshold (easier to hit) when firing from higher elevation
  // Uses effective elevation (accounts for flying unit altitude)
  let elevationMod = 0;
  if (attackerToken && targetToken) {
    const attackerElev = getEffectiveElevation(attackerToken);
    const targetElev = getEffectiveElevation(targetToken);
    if (attackerElev > targetElev) {
      elevationMod = -1;
    }
  }

  // Terrain cover: target's terrain provides defense based on Infantry/Vehicle trait
  // Does NOT apply during assault orders (for either attacker or defender)
  let terrainCoverMod = 0;
  const isAssault = attacker.system.currentOrder === "assault";
  const isTargetAssault = target?.system?.currentOrder === "assault";
  if (targetToken && !isAssault && !isTargetAssault) {
    const cover = getTerrainCoverMod(targetToken);
    terrainCoverMod = cover.mod;
  }

  // Ambush: -2 to threshold (easier to hit) when attacker is completely hidden from defender's team
  let ambushMod = 0;
  if (target && attackerToken) {
    const defenderTeam = target.system.team ?? "a";
    const detectionLevel = computeBestDetectionLevel(defenderTeam, attackerToken);
    if (detectionLevel === "hidden") {
      ambushMod = -2;
    }
  }

  // Combined Arms: +1 to threshold (harder to hit) when target has Combined Arms trait
  // Does not apply to indirect, artillery, or aircraft weapons
  let combinedArmsMod = 0;
  if (target?.hasTrait("Combined Arms") && !weapon.system.indirect && !weapon.system.artillery && !weapon.system.aircraft) {
    combinedArmsMod = 1;
  }

  // Advanced Recon Equipment: -1 to threshold (easier to hit) if target is designated
  let advReconMod = 0;
  if (target) {
    const targetTokenRecon = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (targetTokenRecon) {
      // Check if any enemy has designated this target via Advanced Recon Equipment
      for (const tok of canvas.tokens.placeables) {
        if (!tok.actor || tok.actor === attacker) continue;
        if (tok.document?.getFlag("star-mercs", "advReconTarget") === targetTokenRecon.id) {
          advReconMod = -1;
          break;
        }
      }
    }
  }

  const effective = Math.max(2, Math.min(10, base - accurateMod + inaccurateMod + readinessMod + ewarMod + disorderedMod + standDownMod + orderAccuracyMod + elevationMod + areaMod + terrainCoverMod + advReconMod + ambushMod + combinedArmsMod));

  return { effective, base, readinessMod, ewarMod, accurateMod, inaccurateMod, disorderedMod, standDownMod, orderAccuracyMod, elevationMod, areaMod, terrainCoverMod, advReconMod, ambushMod, combinedArmsMod };
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

  // Order damage penalty (e.g., Withdraw: -1 damage)
  const attackerOrderConfig = CONFIG.STARMERCS.orders?.[attacker.system.currentOrder];
  if (attackerOrderConfig?.damagePenalty) {
    const penalty = attackerOrderConfig.damagePenalty;
    damage -= penalty;
    modifiers.push({ label: `${attackerOrderConfig.label} Penalty`, value: -penalty });
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

  // Disordered target (failed withdraw morale): +1 damage
  const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
  if (targetToken?.document?.getFlag("star-mercs", "disordered")) {
    damage += 1;
    modifiers.push({ label: "Target disordered (+1)", value: +1 });
  }

  // Stand Down target: +2 damage
  if (target.system.currentOrder === "stand_down") {
    damage += 2;
    modifiers.push({ label: "Target standing down (+2)", value: +2 });
  }

  // Hard attack vs Infantry: half damage (rounded down) — unless weapon has Area trait
  if (weapon.system.attackType === "hard" && target.hasTrait("Infantry") && !weapon.system.area) {
    const before = damage;
    damage = Math.floor(damage / 2);
    const diff = damage - before;
    modifiers.push({ label: "Hard vs Infantry (half)", value: diff });
  }

  // Target Combined Arms: -1 damage (does not apply to indirect, artillery, or aircraft weapons)
  if (target.hasTrait("Combined Arms") && !weapon.system.indirect && !weapon.system.artillery && !weapon.system.aircraft) {
    damage -= 1;
    modifiers.push({ label: "Combined Arms", value: -1 });
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
 * Resolve APS/ZPS interception for an incoming attack.
 * Only ordnance-ammo attacks trigger interception.
 * Both APS and ZPS fire even if damage is already negated (they still consume ammo).
 * Each weapon's reduction diminishes by 1 per firing this turn (overloaded at 0).
 *
 * Does NOT consume ammo or update fire counts — that is the caller's responsibility.
 *
 * @param {Item} attackingWeapon - The weapon that fired.
 * @param {StarMercsActor} target - The unit being attacked.
 * @param {Map|null} ammoOverrides - actorId -> { ammoType -> remainingCount } for volley tracking
 * @param {Map|null} fireCountOverrides - actorId -> { weaponId -> count } for volley tracking
 * @returns {{ totalReduction: number, interceptors: Array<{actorId, weaponId, weaponName, actorName, reduction, baseDamage, fireCount, type, ammoType}> }}
 */
export function resolveInterception(attackingWeapon, target, ammoOverrides = null, fireCountOverrides = null) {
  const ammoType = attackingWeapon.system.ammoType || "projectile";
  if (ammoType !== "ordnance") return { totalReduction: 0, interceptors: [] };

  const interceptors = [];
  const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
  if (!targetToken) return { totalReduction: 0, interceptors: [] };

  // Helper: get effective ammo for an actor
  const getAmmo = (actor, aType) => {
    if (ammoOverrides?.has(actor.id)) return ammoOverrides.get(actor.id)[aType] ?? 0;
    return actor.system.supply?.[aType]?.current ?? 0;
  };

  // Helper: get fire count for a weapon (how many times it has intercepted this turn)
  const getFireCount = (actor, weaponId) => {
    if (fireCountOverrides?.has(actor.id)) return fireCountOverrides.get(actor.id)[weaponId] ?? 0;
    const counts = actor.getFlag("star-mercs", "interceptionCounts") ?? {};
    return counts[weaponId] ?? 0;
  };

  // APS: Check target's own APS weapons
  for (const weapon of target.items) {
    if (weapon.type !== "weapon" || weapon.system.attackType !== "aps") continue;
    const wpnAmmo = weapon.system.ammoType || "projectile";
    if (getAmmo(target, wpnAmmo) <= 0) continue;
    const fireCount = getFireCount(target, weapon.id);
    const effectiveReduction = weapon.system.damage - fireCount;
    if (effectiveReduction <= 0) continue; // Overloaded — doesn't fire
    interceptors.push({
      actorId: target.id, weaponId: weapon.id,
      weaponName: weapon.name, actorName: target.name,
      reduction: effectiveReduction, baseDamage: weapon.system.damage,
      fireCount, type: "aps", ammoType: wpnAmmo
    });
    break; // One APS weapon per unit per attack
  }

  // ZPS: Check nearby friendly units' ZPS weapons (including target's own unit)
  const targetTeam = target.system.team ?? "a";
  for (const token of (canvas?.tokens?.placeables ?? [])) {
    if (!token.actor || token.actor.type !== "unit") continue;
    if ((token.actor.system.team ?? "a") !== targetTeam) continue;
    for (const weapon of token.actor.items) {
      if (weapon.type !== "weapon" || weapon.system.attackType !== "zps") continue;
      // Range check: ZPS weapon's range stat (distance from ZPS carrier to target)
      const dist = canvas.grid.measurePath([token.center, targetToken.center]);
      const gridDist = canvas.scene.grid.distance || 1;
      const hexDist = Math.round(dist.distance / gridDist);
      if (hexDist > weapon.system.range) continue;
      // Ammo check
      const wpnAmmo = weapon.system.ammoType || "projectile";
      if (getAmmo(token.actor, wpnAmmo) <= 0) continue;
      // Diminishing returns
      const fireCount = getFireCount(token.actor, weapon.id);
      const effectiveReduction = weapon.system.damage - fireCount;
      if (effectiveReduction <= 0) continue; // Overloaded — doesn't fire
      interceptors.push({
        actorId: token.actor.id, weaponId: weapon.id,
        weaponName: weapon.name, actorName: token.actor.name,
        reduction: effectiveReduction, baseDamage: weapon.system.damage,
        fireCount, type: "zps", ammoType: wpnAmmo
      });
      break; // One ZPS weapon per friendly unit per attack
    }
  }

  const totalReduction = interceptors.reduce((sum, i) => sum + i.reduction, 0);
  return { totalReduction, interceptors };
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
export async function resolveAttack(weapon, attacker, target, interceptionAmmoOverrides = null, interceptionFireOverrides = null) {
  // Step 1: Validate
  const validation = validateAttack(weapon, target, attacker);
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

  // Step 6: Resolve APS/ZPS interception (only for ordnance-ammo hits)
  // Both APS and ZPS fire even if damage is already at minimum.
  let interception = { totalReduction: 0, interceptors: [] };
  if (hitResult.hit && damage) {
    interception = resolveInterception(weapon, target, interceptionAmmoOverrides, interceptionFireOverrides);
    if (interception.totalReduction > 0) {
      damage.final = Math.max(1, damage.final - interception.totalReduction);
      damage.modifiers.push(
        ...interception.interceptors.map(i => ({
          label: `${i.type.toUpperCase()} (${i.actorName})`,
          value: -i.reduction
        }))
      );
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
    interception,
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
