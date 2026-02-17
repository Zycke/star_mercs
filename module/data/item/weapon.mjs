const { NumberField, StringField } = foundry.data.fields;

/**
 * Data model for weapon items.
 * Weapons have an attack type (soft/hard/anti-air), accuracy rating, damage, and range.
 * Attack format follows the rules notation: "accuracy+/damage" (e.g., "5+/3").
 */
export default class WeaponData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    return {
      // Attack type determines targeting rules
      attackType: new StringField({
        required: true,
        initial: "soft",
        choices: {
          soft: "STARMERCS.AttackType.Soft",
          hard: "STARMERCS.AttackType.Hard",
          antiAir: "STARMERCS.AttackType.AntiAir"
        },
        label: "STARMERCS.AttackType"
      }),

      // Accuracy: target number on d10 (e.g., 5 means 5+ to hit)
      accuracy: new NumberField({
        required: true, integer: true, min: 2, max: 10, initial: 5,
        label: "STARMERCS.Accuracy"
      }),

      // Base damage dealt on a hit
      damage: new NumberField({
        required: true, integer: true, min: 1, initial: 3,
        label: "STARMERCS.Damage"
      }),

      // Weapon range in hexes
      range: new NumberField({
        required: true, integer: true, min: 1, initial: 3,
        label: "STARMERCS.Range"
      }),

      // Description / notes
      description: new StringField({ required: false, initial: "" }),

      // Assigned target actor ID for pre-planned attacks
      targetId: new StringField({ required: false, initial: "" })
    };
  }

  /* ---------------------------------------- */
  /*  Derived Data                            */
  /* ---------------------------------------- */

  /** @override */
  prepareDerivedData() {
    // Formatted attack string, e.g., "5+/3"
    this.attackString = `${this.accuracy}+/${this.damage}`;
  }
}
