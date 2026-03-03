const { BooleanField, NumberField, StringField } = foundry.data.fields;

/**
 * Data model for weapon items.
 * Weapons have an attack type (soft/hard/anti-air/aps/zps), damage, range, ammo type, and optional traits.
 * Attack roll is based on the firing unit's Rating, not the weapon itself.
 */
export default class WeaponData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    return {
      // Attack type determines targeting rules and weapon category
      attackType: new StringField({
        required: true,
        initial: "soft",
        choices: {
          soft: "STARMERCS.AttackType.Soft",
          hard: "STARMERCS.AttackType.Hard",
          antiAir: "STARMERCS.AttackType.AntiAir",
          aps: "STARMERCS.AttackType.APS",
          zps: "STARMERCS.AttackType.ZPS"
        },
        label: "STARMERCS.AttackType"
      }),

      // Ammo type consumed when this weapon fires
      ammoType: new StringField({
        required: true,
        initial: "projectile",
        choices: {
          projectile: "STARMERCS.AmmoType.Projectile",
          ordnance: "STARMERCS.AmmoType.Ordnance",
          energy: "STARMERCS.AmmoType.Energy"
        },
        label: "STARMERCS.AmmoType"
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
      artillery: new BooleanField({ required: false, initial: false }),
      aircraft: new BooleanField({ required: false, initial: false }),

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
