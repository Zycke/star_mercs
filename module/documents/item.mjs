/**
 * Extended Item class for Star Mercs items (weapons, traits, orders).
 */
export default class StarMercsItem extends Item {

  /**
   * Post this item's details to the chat log.
   * @returns {Promise<ChatMessage>}
   */
  async toChat() {
    const content = [
      `<h3>${this.name}</h3>`,
      this.system.description ? `<p>${this.system.description}</p>` : "",
      this.type === "weapon" ? `<p><strong>${this.system.attackString}</strong> | Range: ${this.system.range} hexes</p>` : ""
    ].filter(Boolean).join("");

    return ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content
    });
  }
}
