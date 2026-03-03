import { resolveAttack, validateAttack, calculateAccuracy, determineHitResult, calculateDamage, HIT_LABELS } from "../combat.mjs";
import { skillCheck } from "../dice.mjs";
import { computeBestDetectionLevel } from "../detection.mjs";
import FiringBlipLayer from "../canvas/firing-blip-layer.mjs";
import { esc } from "../helpers.mjs";

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

  /**
   * Get the full trait item by name (needed for dual-parameter traits like ZPS[X][Y]).
   * Only returns the item if the trait is activated.
   * @param {string} traitName
   * @returns {Item|undefined} The trait item, or undefined if not found/inactive.
   */
  getTraitItem(traitName) {
    return this.items.find(i =>
      i.type === "trait" && i.name.toLowerCase() === traitName.toLowerCase()
      && i.system.active
    );
  }

  /** Get all active trait items. */
  get activeTraits() {
    return this.items.filter(i => i.type === "trait" && i.system.active);
  }

  /**
   * Determine which supply category a weapon consumes.
   * @param {Item} weapon - A weapon item.
   * @returns {"smallArms"|"heavyWeapons"|"ordnance"}
   */
  _getWeaponSupplyType(weapon) {
    if (weapon.system.ordnance || weapon.system.attackType === "antiAir" || weapon.system.artillery || weapon.system.aircraft) {
      return "ordnance";
    }
    if (weapon.system.attackType === "hard") return "heavyWeapons";
    return "smallArms";
  }

  /* ---------------------------------------- */
  /*  Combat: Phase Enforcement               */
  /* ---------------------------------------- */

  /**
   * Check whether this actor can attack in the current combat state.
   * @returns {{allowed: boolean, reason: string|null}}
   */
  _checkAttackAllowed() {
    // Zero ammo supply: cannot attack if all ammo categories are empty
    if (this.type === "unit") {
      const sup = this.system.supply ?? {};
      const totalAmmo = (sup.smallArms?.current ?? 0) + (sup.heavyWeapons?.current ?? 0) + (sup.ordnance?.current ?? 0);
      if (totalAmmo <= 0) {
        return {
          allowed: false,
          reason: "Cannot attack — no ammunition supply remaining."
        };
      }
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
    const result = canvas.grid.measurePath([token1.center, token2.center]);
    const gridDistance = canvas.scene.grid.distance || 1;
    return Math.round(result.distance / gridDistance);
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
    // Check if this weapon has already fired this tactical phase
    const attackerToken = canvas?.tokens?.placeables.find(t => t.actor === this);
    if (game.combat?.started && attackerToken?.document) {
      const firedWeapons = attackerToken.document.getFlag("star-mercs", "firedWeapons") ?? [];
      if (firedWeapons.includes(weapon.id)) {
        ui.notifications.warn(`${weapon.name} has already fired this tactical phase.`);
        return null;
      }
    }

    // Range check: find both tokens and measure hex distance
    const targetToken = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (attackerToken && targetToken && weapon.system.range > 0) {
      const distance = StarMercsActor.getHexDistance(attackerToken, targetToken);
      if (distance > weapon.system.range) {
        ui.notifications.warn(
          `Out of range — ${weapon.name} has ${weapon.system.range} hex range, target is ${distance} hexes away.`
        );
        return null;
      }
    }

    const result = await resolveAttack(weapon, this, target);
    const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air" };

    // Compute whisper IDs for both attacker and target teams
    const atkTeam = this.system.team ?? "a";
    const defTeam = target.system.team ?? "a";
    const whisperIds = game.combat?.constructor?.getBothTeamsWhisperIds
      ? game.combat.constructor.getBothTeamsWhisperIds(atkTeam, defTeam)
      : [];

    // Attack was invalid (wrong weapon type, etc.)
    if (!result.valid) {
      return ChatMessage.create({
        content: await foundry.applications.handlebars.renderTemplate(
          "systems/star-mercs/templates/chat/attack-result.hbs",
          {
            attackerName: this.name,
            targetName: target.name,
            weaponName: weapon.name,
            attackString: weapon.system.attackString ?? `D${weapon.system.damage}/R${weapon.system.range}`,
            attackType: weapon.system.attackType,
            attackTypeLabel: attackTypeLabels[weapon.system.attackType] ?? weapon.system.attackType,
            invalid: true,
            invalidReason: result.reason
          }
        ),
        speaker: ChatMessage.getSpeaker({ actor: this }),
        whisper: whisperIds.length > 0 ? whisperIds : undefined
      });
    }

    // Determine whether to defer damage (active combat) or apply immediately (sandbox)
    let damageApplied = null;
    const deferDamage = game.combat?.started;

    if (result.hitResult.hit && result.damage && result.damage.final > 0) {
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

    // Mark the target as having been fired at this turn (for morale triggers)
    const targetTokenForFlag = canvas?.tokens?.placeables.find(t => t.actor === target);
    if (targetTokenForFlag?.document) {
      await targetTokenForFlag.document.setFlag("star-mercs", "firedAtThisTurn", true);
    }

    // Log the attack result
    const hitLabel = result.hitResult.hit ? `HIT (${result.damage?.final ?? 0} dmg)` : `MISS (${HIT_LABELS[result.hitResult.type]})`;
    await this.addLogEntry(`Attacked ${target.name} with ${weapon.name}: ${hitLabel}`, "info");

    // Build chat card
    const templateData = {
      attackerName: this.name,
      targetName: target.name,
      weaponName: weapon.name,
      attackString: weapon.system.attackString ?? `D${weapon.system.damage}/R${weapon.system.range}`,
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
      standDownMod: result.accuracy.standDownMod ?? 0,
      orderAccuracyMod: result.accuracy.orderAccuracyMod ?? 0,
      areaVsInfantryMod: result.accuracy.areaVsInfantryMod ?? 0,
      terrainCoverMod: result.accuracy.terrainCoverMod ?? 0,
      advReconMod: result.accuracy.advReconMod ?? 0,
      hasAccuracyMods: (result.accuracy.ewarMod > 0 || result.accuracy.readinessMod > 0 || (result.accuracy.accurateMod ?? 0) > 0 || (result.accuracy.inaccurateMod ?? 0) > 0 || (result.accuracy.disorderedMod ?? 0) !== 0 || (result.accuracy.standDownMod ?? 0) !== 0 || (result.accuracy.orderAccuracyMod ?? 0) !== 0 || (result.accuracy.areaVsInfantryMod ?? 0) !== 0 || (result.accuracy.terrainCoverMod ?? 0) !== 0 || (result.accuracy.advReconMod ?? 0) !== 0),
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
      // Protection systems (APS/ZPS)
      protectionSystems: result.protectionResult?.systems ?? null,
      damageIntercepted: result.hitResult.hit && result.damage && result.damage.final <= 0,
      // Damage application results
      damagePending: damageApplied?.pending ?? false,
      targetDestroyed: damageApplied?.destroyed ?? false,
      targetRouted: damageApplied?.routed ?? false,
      targetNewStrength: damageApplied?.newStrength ?? null,
      targetNewReadiness: damageApplied?.newReadiness ?? null,
      readinessLost: damageApplied?.readinessLost ?? 0
    };

    const content = await foundry.applications.handlebars.renderTemplate(
      "systems/star-mercs/templates/chat/attack-result.hbs",
      templateData
    );

    // Track weapons fired by supply category and per-weapon fired list
    if (game.combat?.started && attackerToken) {
      const supplyType = this._getWeaponSupplyType(weapon);
      const flagKey = `weaponsFired_${supplyType}`;
      const fired = attackerToken.document.getFlag("star-mercs", flagKey) ?? 0;
      await attackerToken.document.setFlag("star-mercs", flagKey, fired + 1);

      // Track this specific weapon as fired
      const firedWeapons = attackerToken.document.getFlag("star-mercs", "firedWeapons") ?? [];
      if (!firedWeapons.includes(weapon.id)) {
        firedWeapons.push(weapon.id);
        await attackerToken.document.setFlag("star-mercs", "firedWeapons", firedWeapons);
      }

      // Toggle "Fired" visual status effect on the token
      if (attackerToken.actor && !attackerToken.document.hasStatusEffect("fired")) {
        await attackerToken.actor.toggleStatusEffect("fired", { active: true });
      }

      // Create firing blip if attacker is hidden from the defending team
      const defTeam = target.system.team ?? "a";
      const attackerDetLevel = computeBestDetectionLevel(defTeam, attackerToken);
      if (attackerDetLevel === "hidden") {
        const blip = await FiringBlipLayer.createFiringBlip(attackerToken, defTeam);

        // Hidden attacker: send two separate chat messages
        // Attacking team sees real name, defending team sees "Unknown Attacker ###"
        if (blip?.serialNumber) {
          const serialStr = String(blip.serialNumber).padStart(3, "0");
          const unknownName = `Unknown Attacker ${serialStr}`;

          // Defender team message with hidden attacker name
          const defTemplateData = { ...templateData, attackerName: unknownName };
          const defContent = await foundry.applications.handlebars.renderTemplate(
            "systems/star-mercs/templates/chat/attack-result.hbs",
            defTemplateData
          );
          const defWhisperIds = game.combat?.constructor?.getTeamWhisperIds
            ? game.combat.constructor.getTeamWhisperIds(defTeam)
            : [];

          // Attacker team message with real name
          const atkWhisperIds = game.combat?.constructor?.getTeamWhisperIds
            ? game.combat.constructor.getTeamWhisperIds(atkTeam)
            : [];

          await ChatMessage.create({
            content: defContent,
            speaker: { alias: unknownName },
            rolls: [result.roll],
            whisper: defWhisperIds.length > 0 ? defWhisperIds : undefined
          });

          return ChatMessage.create({
            content,
            speaker: ChatMessage.getSpeaker({ actor: this }),
            rolls: [result.roll],
            whisper: atkWhisperIds.length > 0 ? atkWhisperIds : undefined
          });
        }
      }
    }

    return ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor: this }),
      rolls: [result.roll],
      whisper: whisperIds.length > 0 ? whisperIds : undefined
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
      attackString: weapon.system.attackString ?? `D${weapon.system.damage}/R${weapon.system.range}`,
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
      standDownMod: 0,
      orderAccuracyMod: accuracy.orderAccuracyMod ?? 0,
      areaVsInfantryMod: accuracy.areaVsInfantryMod ?? 0,
      terrainCoverMod: accuracy.terrainCoverMod ?? 0,
      advReconMod: accuracy.advReconMod ?? 0,
      hasAccuracyMods: (accuracy.readinessMod > 0 || (accuracy.accurateMod ?? 0) > 0 || (accuracy.inaccurateMod ?? 0) > 0 || (accuracy.orderAccuracyMod ?? 0) !== 0 || (accuracy.areaVsInfantryMod ?? 0) !== 0 || (accuracy.terrainCoverMod ?? 0) !== 0 || (accuracy.advReconMod ?? 0) !== 0),
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

    const content = await foundry.applications.handlebars.renderTemplate(
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
    const firedWeapons = (game.combat?.started && attackerToken?.document)
      ? (attackerToken.document.getFlag("star-mercs", "firedWeapons") ?? [])
      : [];
    const targetedWeapons = [];
    for (const item of this.items) {
      if (item.type === "weapon" && item.system.targetId) {
        // Skip weapons that have already fired this tactical phase
        if (firedWeapons.includes(item.id)) {
          ui.notifications.warn(`${item.name} has already fired this tactical phase.`);
          continue;
        }
        const targetToken = canvas?.tokens?.get(item.system.targetId);
        if (targetToken?.actor) {
          // Range check
          if (attackerToken && item.system.range > 0) {
            const distance = StarMercsActor.getHexDistance(attackerToken, targetToken);
            if (distance > item.system.range) {
              ui.notifications.warn(
                `Out of range — ${item.name} has ${item.system.range} hex range, target is ${distance} hexes away.`
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
      if (result.valid && result.hitResult.hit && result.damage && result.damage.final > 0) {
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

    // Mark each targeted unit as having been fired at this turn (for morale triggers)
    const flaggedTargets = new Set();
    for (const result of results) {
      if (!result.valid || !result.target) continue;
      const tokenId = result.targetTokenId;
      if (flaggedTargets.has(tokenId)) continue;
      flaggedTargets.add(tokenId);
      const tToken = canvas?.tokens?.get(tokenId);
      if (tToken?.document) {
        await tToken.document.setFlag("star-mercs", "firedAtThisTurn", true);
      }
    }

    // Phase 3: Post individual attack results to chat
    const attackTypeLabels = { soft: "Soft", hard: "Hard", antiAir: "Anti-Air" };
    const myTeam = this.system.team ?? "a";

    for (const result of results) {
      // Compute whisper for each attack (attacker + target teams)
      const targetActor = result.target;
      const tgtTeam = targetActor?.system?.team ?? "a";
      const atkWhisper = game.combat?.constructor?.getBothTeamsWhisperIds
        ? game.combat.constructor.getBothTeamsWhisperIds(myTeam, tgtTeam)
        : [];

      if (!result.valid) {
        await ChatMessage.create({
          content: await foundry.applications.handlebars.renderTemplate(
            "systems/star-mercs/templates/chat/attack-result.hbs",
            {
              attackerName: this.name,
              targetName: result.targetTokenName,
              weaponName: result.weapon.name,
              attackString: result.weapon.system.attackString ?? `D${result.weapon.system.damage}/R${result.weapon.system.range}`,
              attackType: result.weapon.system.attackType,
              attackTypeLabel: attackTypeLabels[result.weapon.system.attackType] ?? result.weapon.system.attackType,
              invalid: true,
              invalidReason: result.reason
            }
          ),
          speaker: ChatMessage.getSpeaker({ actor: this }),
          whisper: atkWhisper.length > 0 ? atkWhisper : undefined
        });
        continue;
      }

      // Log attack result
      const hitLabel = result.hitResult.hit ? `HIT (${result.damage?.final ?? 0} dmg)` : `MISS (${HIT_LABELS[result.hitResult.type]})`;
      await this.addLogEntry(`Attacked ${result.targetTokenName} with ${result.weapon.name}: ${hitLabel}`, "info");

      const templateData = {
        attackerName: this.name,
        targetName: result.targetTokenName,
        weaponName: result.weapon.name,
        attackString: result.weapon.system.attackString ?? `D${result.weapon.system.damage}/R${result.weapon.system.range}`,
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
        orderAccuracyMod: result.accuracy.orderAccuracyMod ?? 0,
        areaVsInfantryMod: result.accuracy.areaVsInfantryMod ?? 0,
        terrainCoverMod: result.accuracy.terrainCoverMod ?? 0,
        advReconMod: result.accuracy.advReconMod ?? 0,
        hasAccuracyMods: (result.accuracy.ewarMod > 0 || result.accuracy.readinessMod > 0 || (result.accuracy.accurateMod ?? 0) > 0 || (result.accuracy.inaccurateMod ?? 0) > 0 || (result.accuracy.orderAccuracyMod ?? 0) !== 0 || (result.accuracy.areaVsInfantryMod ?? 0) !== 0 || (result.accuracy.terrainCoverMod ?? 0) !== 0 || (result.accuracy.advReconMod ?? 0) !== 0),
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
        // Protection systems (APS/ZPS)
        protectionSystems: result.protectionResult?.systems ?? null,
        damageIntercepted: result.hitResult.hit && result.damage && result.damage.final <= 0,
        damagePending: deferDamage,
        targetDestroyed: false,
        targetRouted: false,
        targetNewStrength: null,
        targetNewReadiness: null,
        readinessLost: 0
      };

      await ChatMessage.create({
        content: await foundry.applications.handlebars.renderTemplate(
          "systems/star-mercs/templates/chat/attack-result.hbs",
          templateData
        ),
        speaker: ChatMessage.getSpeaker({ actor: this }),
        rolls: [result.roll],
        whisper: atkWhisper.length > 0 ? atkWhisper : undefined
      });
    }

    // Phase 4: Post damage summary for each target that took hits
    for (const [tokenId, dmgResult] of damageResults) {
      const entry = damageByTarget.get(tokenId);
      if (!entry) continue;
      const targetName = entry.targetName;

      const safeName = esc(this.name);
      const safeTarget = esc(targetName);
      let statusHtml = `<div class="star-mercs chat-card fire-all-summary">`;
      statusHtml += `<div class="summary-header"><i class="fas fa-crosshairs"></i> <strong>${safeName}</strong> &rarr; <strong>${safeTarget}</strong></div>`;
      statusHtml += `<div class="summary-damage">Total Damage: <strong>${entry.totalDamage}</strong> (${entry.hitDamages.length} hit${entry.hitDamages.length > 1 ? "s" : ""})</div>`;

      if (dmgResult.pending) {
        statusHtml += `<div class="status-update pending"><i class="fas fa-clock"></i> Damage pending — applied in Consolidation</div>`;
      } else if (dmgResult.destroyed) {
        statusHtml += `<div class="status-alert destroyed"><i class="fas fa-skull-crossbones"></i> ${safeTarget} DESTROYED</div>`;
      } else if (dmgResult.routed) {
        statusHtml += `<div class="status-alert routed"><i class="fas fa-running"></i> ${safeTarget} ROUTED</div>`;
      } else {
        statusHtml += `<div class="status-update">${safeTarget}: STR ${dmgResult.newStrength} | RDY ${dmgResult.newReadiness} <span class="readiness-loss">(-${dmgResult.readinessLost} readiness)</span></div>`;
      }
      statusHtml += `</div>`;

      // Whisper to both attacker and target teams
      const tgtToken = canvas?.tokens?.get(tokenId);
      const dmgTgtTeam = tgtToken?.actor?.system?.team ?? "a";
      const dmgWhisper = game.combat?.constructor?.getBothTeamsWhisperIds
        ? game.combat.constructor.getBothTeamsWhisperIds(myTeam, dmgTgtTeam)
        : [];

      await ChatMessage.create({
        content: statusHtml,
        speaker: ChatMessage.getSpeaker({ actor: this }),
        whisper: dmgWhisper.length > 0 ? dmgWhisper : undefined
      });
    }

    // Track weapons fired by supply category and per-weapon fired list
    const validResults = results.filter(r => r.valid);
    if (game.combat?.started && attackerToken && validResults.length > 0) {
      // Count per supply type
      const counts = { smallArms: 0, heavyWeapons: 0, ordnance: 0 };
      for (const r of validResults) {
        const supplyType = this._getWeaponSupplyType(r.weapon);
        counts[supplyType]++;
      }
      for (const [type, count] of Object.entries(counts)) {
        if (count > 0) {
          const flagKey = `weaponsFired_${type}`;
          const prev = attackerToken.document.getFlag("star-mercs", flagKey) ?? 0;
          await attackerToken.document.setFlag("star-mercs", flagKey, prev + count);
        }
      }

      // Track each weapon as fired this phase
      const updatedFiredWeapons = attackerToken.document.getFlag("star-mercs", "firedWeapons") ?? [];
      for (const r of validResults) {
        if (!updatedFiredWeapons.includes(r.weapon.id)) {
          updatedFiredWeapons.push(r.weapon.id);
        }
      }
      await attackerToken.document.setFlag("star-mercs", "firedWeapons", updatedFiredWeapons);

      // Toggle "Fired" visual status effect on the token
      if (attackerToken.actor && !attackerToken.document.hasStatusEffect("fired")) {
        await attackerToken.actor.toggleStatusEffect("fired", { active: true });
      }
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
   * Add an entry to the unit's history log.
   * @param {string} text - The log message.
   * @param {string} [type="info"] - Log type: info, damage, morale, order, supply.
   */
  async addLogEntry(text, type = "info") {
    const combat = game.combat;
    const turn = combat?.round ?? 0;
    const phase = combat?.phase ?? "";
    const log = foundry.utils.deepClone(this.system.log ?? []);
    log.push({ turn, phase, text, type });
    await this.update({ "system.log": log });
  }

  /**
   * Supply category keys for iteration.
   */
  static SUPPLY_CATEGORIES = ["smallArms", "heavyWeapons", "ordnance", "fuel", "materials", "parts", "basicSupplies"];

  /**
   * Supply category display labels.
   */
  static SUPPLY_LABELS = {
    smallArms: "Small Arms",
    heavyWeapons: "Heavy Weapons",
    ordnance: "Ordnance",
    fuel: "Fuel",
    materials: "Materials",
    parts: "Parts",
    basicSupplies: "Basic Supplies"
  };

  /**
   * Transfer supply to another unit, per category.
   * @param {StarMercsActor} targetActor - The target unit to receive supply.
   * @param {Object} transfers - Amounts per category, e.g. { smallArms: 5, fuel: 3 }.
   * @returns {Promise<boolean>} True if any transfer succeeded.
   */
  async transferSupply(targetActor, transfers) {
    if (!targetActor || targetActor.type !== "unit") return false;

    // Team check: can only transfer to same-team units
    const myTeam = this.system.team ?? "a";
    const targetTeam = targetActor.system.team ?? "a";
    if (myTeam !== targetTeam) {
      ui.notifications.warn("Cannot transfer supply to a unit on a different team.");
      return false;
    }

    const sourceUpdate = {};
    const targetUpdate = {};
    const transferredParts = [];

    for (const cat of StarMercsActor.SUPPLY_CATEGORIES) {
      const amount = transfers[cat] ?? 0;
      if (amount <= 0) continue;

      const sourceCat = this.system.supply[cat];
      const targetCat = targetActor.system.supply[cat];
      if (!sourceCat || !targetCat) continue;

      const actual = Math.min(amount, sourceCat.current, targetCat.capacity - targetCat.current);
      if (actual <= 0) continue;

      sourceUpdate[`system.supply.${cat}.current`] = sourceCat.current - actual;
      targetUpdate[`system.supply.${cat}.current`] = targetCat.current + actual;
      transferredParts.push(`${StarMercsActor.SUPPLY_LABELS[cat]}: ${actual}`);
    }

    if (transferredParts.length === 0) return false;

    await this.update(sourceUpdate);
    await targetActor.update(targetUpdate);

    await ChatMessage.create({
      content: `<div class="star-mercs chat-card supply-transfer">
        <div class="summary-header"><i class="fas fa-truck"></i> <strong>${esc(this.name)}</strong> &rarr; <strong>${esc(targetActor.name)}</strong></div>
        <div class="status-update">${transferredParts.join(" | ")}</div>
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor: this })
    });

    return true;
  }
}
