/**
 * Dice utility module for Star Mercs.
 * Provides skill checks and opposed roll mechanics.
 *
 * Skill checks: Roll d10 + rating bonus.
 * Opposed checks: Both sides roll skill checks; higher total wins.
 * A difference of 10+ is a Critical Success for the winner.
 */

/**
 * Perform a skill check for an actor.
 * @param {StarMercsActor} actor - The actor making the check.
 * @param {object} [options={}]
 * @param {string} [options.flavor] - Flavor text for the chat message.
 * @param {boolean} [options.toChat=true] - Whether to post to chat.
 * @returns {Promise<{roll: Roll, total: number, ratingBonus: number, rating: string}>}
 */
export async function skillCheck(actor, { flavor = null, toChat = true } = {}) {
  const ratingBonus = actor.system.ratingBonus ?? 0;
  const rating = actor.system.rating ?? "green";

  const roll = new Roll("1d10 + @bonus", { bonus: ratingBonus });
  await roll.evaluate();

  const result = {
    roll,
    total: roll.total,
    ratingBonus,
    rating,
    natural: roll.dice[0].total
  };

  if (toChat) {
    const label = flavor || `Skill Check (${rating}, +${ratingBonus})`;
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: label
    });
  }

  return result;
}

/**
 * Perform a skill check with the zero-supply penalty (roll twice, take lower).
 * @param {StarMercsActor} actor
 * @returns {Promise<object>} The worse of two skill check results.
 * @private
 */
async function _zeroSupplySkillCheck(actor) {
  const roll1 = await skillCheck(actor, { toChat: false });
  const roll2 = await skillCheck(actor, { toChat: false });
  return roll1.total <= roll2.total ? roll1 : roll2;
}

/**
 * Perform an opposed check between two actors.
 * Both roll d10 + rating bonus. Higher total wins.
 * Difference of 10+ = Critical Success for the winner.
 *
 * If an actor has 0 supply, they roll twice and take the lower result.
 *
 * @param {StarMercsActor} attacker - The initiating actor.
 * @param {StarMercsActor} defender - The opposing actor.
 * @param {object} [options={}]
 * @param {string} [options.attackerLabel] - Label for the attacker's action.
 * @param {string} [options.defenderLabel] - Label for the defender's action.
 * @returns {Promise<{attacker: object, defender: object, winner: string, isCritical: boolean, difference: number}>}
 */
export async function opposedCheck(attacker, defender, {
  attackerLabel = "Attacker",
  defenderLabel = "Defender"
} = {}) {
  // Check zero supply for each side
  const attackerNoSupply = attacker.type === "unit" && (attacker.system.supply?.current ?? 1) <= 0;
  const defenderNoSupply = defender.type === "unit" && (defender.system.supply?.current ?? 1) <= 0;

  const attackerResult = attackerNoSupply
    ? await _zeroSupplySkillCheck(attacker)
    : await skillCheck(attacker, { toChat: false });
  const defenderResult = defenderNoSupply
    ? await _zeroSupplySkillCheck(defender)
    : await skillCheck(defender, { toChat: false });

  const difference = Math.abs(attackerResult.total - defenderResult.total);
  let winner;
  if (attackerResult.total > defenderResult.total) winner = "attacker";
  else if (defenderResult.total > attackerResult.total) winner = "defender";
  else winner = "tie";

  const isCritical = difference >= 10;

  const result = {
    attacker: { ...attackerResult, label: attackerLabel, zeroSupply: attackerNoSupply },
    defender: { ...defenderResult, label: defenderLabel, zeroSupply: defenderNoSupply },
    winner,
    isCritical,
    difference
  };

  // Post opposed check result to chat
  const winnerName = winner === "attacker" ? attacker.name
    : winner === "defender" ? defender.name
    : "Tie";
  const critText = isCritical ? " (Critical!)" : "";

  const content = await renderTemplate(
    "systems/star-mercs/templates/chat/skill-check.hbs",
    {
      attackerName: attacker.name,
      attackerRoll: attackerResult.natural,
      attackerBonus: attackerResult.ratingBonus,
      attackerTotal: attackerResult.total,
      attackerRating: attackerResult.rating,
      attackerZeroSupply: attackerNoSupply,
      defenderName: defender.name,
      defenderRoll: defenderResult.natural,
      defenderBonus: defenderResult.ratingBonus,
      defenderTotal: defenderResult.total,
      defenderRating: defenderResult.rating,
      defenderZeroSupply: defenderNoSupply,
      winnerName,
      isCritical,
      critText,
      difference,
      isTie: winner === "tie"
    }
  );

  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor: attacker })
  });

  return result;
}
