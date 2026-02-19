const { BooleanField, NumberField, StringField } = foundry.data.fields;

/**
 * Data model for weapon items.
 * Weapons have an attack type (soft/hard/anti-air), damage, range, and optional traits.
 * Attack roll is based on the firing unit's Rating, not the weapon itself.
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

      // --- Weapon Traits ---
      indirect: new BooleanField({ required: false, initial: false }),
      accurate: new NumberField({ required: false, integer: true, min: 0, initial: 0 }),
      inaccurate: new NumberField({ required: false, integer: true, min: 0, initial: 0 }),
      area: new BooleanField({ required: false, initial: false }),

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
    // Formatted attack string, e.g., "D3 R3"
    this.attackString = `D${this.damage}/R${this.range}`;
  }
}
