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
 * Perform an opposed check between two actors.
 * Both roll d10 + rating bonus. Higher total wins.
 * Difference of 10+ = Critical Success for the winner.
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
  const attackerResult = await skillCheck(attacker, { toChat: false });
  const defenderResult = await skillCheck(defender, { toChat: false });

  const difference = Math.abs(attackerResult.total - defenderResult.total);
  let winner;
  if (attackerResult.total > defenderResult.total) winner = "attacker";
  else if (defenderResult.total > attackerResult.total) winner = "defender";
  else winner = "tie";

  const isCritical = difference >= 10;

  const result = {
    attacker: { ...attackerResult, label: attackerLabel },
    defender: { ...defenderResult, label: defenderLabel },
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
      defenderName: defender.name,
      defenderRoll: defenderResult.natural,
      defenderBonus: defenderResult.ratingBonus,
      defenderTotal: defenderResult.total,
      defenderRating: defenderResult.rating,
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
