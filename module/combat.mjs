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
 * Ordnance: Weapon consumes ordnance supply; triggers APS/ZPS defense.
 * APS[X]: Active Protection System — rolls d6+X to reduce ordnance damage.
 * ZPS[X][Y]: Zone Protection System — provides APS-like coverage to friendlies within Y hexes.
 */

import { getHexElevation, snapToHexCenter } from "./hex-utils.mjs";
import { getTerrainCoverMod } from "./detection.mjs";

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

  // Area weapon vs Infantry: -1 to threshold (easier to hit)
  let areaVsInfantryMod = 0;
  if (weapon.system.area && target?.hasTrait("Infantry")) {
    areaVsInfantryMod = -1;
  }

  // Elevation bonus: -1 to threshold (easier to hit) when firing from higher elevation
  let elevationMod = 0;
  if (target) {
    const attackerToken = canvas?.tokens?.placeables.find(t => t.actor === attacker);
    const targetTokenElev = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (attackerToken && targetTokenElev) {
      const attackerElev = getHexElevation(snapToHexCenter(attackerToken.center));
      const targetElev = getHexElevation(snapToHexCenter(targetTokenElev.center));
      if (attackerElev > targetElev) {
        elevationMod = -1;
      }
    }
  }

  // Terrain cover: target's terrain provides defense based on Infantry/Vehicle trait
  // Does NOT apply during assault orders (for either attacker or defender)
  let terrainCoverMod = 0;
  const isAssault = attacker.system.currentOrder === "assault";
  const isTargetAssault = target?.system?.currentOrder === "assault";
  if (target && !isAssault && !isTargetAssault) {
    const targetTokenCover = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (targetTokenCover) {
      const cover = getTerrainCoverMod(targetTokenCover);
      terrainCoverMod = cover.mod;
    }
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

  const effective = Math.max(2, Math.min(10, base - accurateMod + inaccurateMod + readinessMod + ewarMod + disorderedMod + standDownMod + orderAccuracyMod + elevationMod + areaVsInfantryMod + terrainCoverMod + advReconMod));

  return { effective, base, readinessMod, ewarMod, accurateMod, inaccurateMod, disorderedMod, standDownMod, orderAccuracyMod, elevationMod, areaVsInfantryMod, terrainCoverMod, advReconMod };
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
 * Check whether a weapon is classified as ordnance (triggers APS/ZPS defense).
 * A weapon is ordnance if it has the ordnance trait, is artillery/aircraft, or is anti-air.
 *
 * @param {Item} weapon - The weapon to check.
 * @returns {boolean}
 */
export function isOrdnanceWeapon(weapon) {
  return !!(weapon.system.ordnance || weapon.system.artillery || weapon.system.aircraft
    || weapon.system.attackType === "antiAir");
}

/**
 * Measure hex distance between two tokens (avoids circular import with actor.mjs).
 * @param {Token} token1
 * @param {Token} token2
 * @returns {number} Distance in hexes.
 */
function _hexDistance(token1, token2) {
  const result = canvas.grid.measurePath([token1.center, token2.center]);
  const gridDistance = canvas.scene?.grid?.distance || 1;
  return Math.round(result.distance / gridDistance);
}

/**
 * Apply Active Protection Systems (APS) and Zone Protection Systems (ZPS)
 * against an incoming ordnance attack. Both fire independently and their
 * damage reductions stack.
 *
 * APS: Defender rolls d6 + X − cumulative penalty. Tracked on defender's token.
 * ZPS: Best nearby friendly ZPS unit rolls d6 + X − cumulative penalty.
 *      Tracked on the ZPS owner's token.
 *
 * @param {Item} weapon - The ordnance weapon being fired.
 * @param {StarMercsActor} attacker - The attacking unit.
 * @param {StarMercsActor} target - The target unit.
 * @param {{final: number, base: number, modifiers: Array}} damage - The calculated damage object.
 * @returns {Promise<{systems: Array, totalReduction: number}|null>}
 */
async function applyProtectionSystems(weapon, attacker, target, damage) {
  const systems = [];
  let totalReduction = 0;

  // 1. Check if target has APS trait
  const apsValue = target.getTraitValue("APS");
  if (apsValue > 0) {
    const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
    const fireCount = targetToken?.document?.getFlag("star-mercs", "apsFireCount") ?? 0;
    const penalty = fireCount;

    const roll = new Roll("1d6");
    await roll.evaluate();
    const reduction = Math.max(0, roll.total + apsValue - penalty);
    totalReduction += reduction;

    if (targetToken?.document) {
      await targetToken.document.setFlag("star-mercs", "apsFireCount", fireCount + 1);
    }

    systems.push({
      type: "APS", unitName: target.name,
      roll: roll.total, bonus: apsValue, penalty, reduction
    });
  }

  // 2. Check for nearby friendly ZPS units (fires even if APS also fired)
  const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
  if (targetToken) {
    const targetTeam = target.system.team ?? "a";

    // Find the best ZPS unit in range (highest effective bonus)
    let bestZPS = null;
    for (const tok of canvas.tokens.placeables) {
      if (!tok.actor) continue;
      if ((tok.actor.system.team ?? "a") !== targetTeam) continue;
      if (tok.actor.system.strength?.value <= 0) continue;

      const zpsItem = tok.actor.getTraitItem?.("ZPS");
      if (!zpsItem) continue;

      const zpsBonus = zpsItem.system.traitValue;   // X
      const zpsRange = zpsItem.system.traitValue2;  // Y
      if (zpsBonus <= 0 || zpsRange <= 0) continue;

      const distance = _hexDistance(tok, targetToken);
      if (distance > zpsRange) continue;

      const fireCount = tok.document?.getFlag("star-mercs", "zpsFireCount") ?? 0;
      const effectiveBonus = zpsBonus - fireCount;

      if (!bestZPS || effectiveBonus > bestZPS.effectiveBonus) {
        bestZPS = {
          token: tok, actor: tok.actor, item: zpsItem,
          bonus: zpsBonus, range: zpsRange, fireCount, effectiveBonus
        };
      }
    }

    if (bestZPS) {
      const roll = new Roll("1d6");
      await roll.evaluate();
      const reduction = Math.max(0, roll.total + bestZPS.bonus - bestZPS.fireCount);
      totalReduction += reduction;

      await bestZPS.token.document.setFlag("star-mercs", "zpsFireCount", bestZPS.fireCount + 1);

      systems.push({
        type: "ZPS", unitName: bestZPS.actor.name,
        roll: roll.total, bonus: bestZPS.bonus, penalty: bestZPS.fireCount, reduction
      });
    }
  }

  if (systems.length === 0) return null;
  return { systems, totalReduction };
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

  // Step 6: Apply APS/ZPS protection (only if hit and weapon is ordnance)
  let protectionResult = null;
  if (damage && isOrdnanceWeapon(weapon)) {
    protectionResult = await applyProtectionSystems(weapon, attacker, target, damage);
    if (protectionResult && protectionResult.totalReduction > 0) {
      damage.final = Math.max(0, damage.final - protectionResult.totalReduction);
      // Add each system as a separate damage modifier
      for (const sys of protectionResult.systems) {
        damage.modifiers.push({
          label: `${sys.type}[${sys.bonus}] (d6:${sys.roll}${sys.penalty > 0 ? ` -${sys.penalty} penalty` : ""})`,
          value: -sys.reduction
        });
      }
    }
  }

  return {
    valid: true,
    reason: null,
    roll,
    accuracy,
    hitResult,
    damage,
    protectionResult,
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
