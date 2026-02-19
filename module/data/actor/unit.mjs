const { SchemaField, NumberField, StringField } = foundry.data.fields;

/**
 * Data model for Star Mercs Unit actors.
 * Units are the core entity — infantry squads, vehicle platoons, aircraft, etc.
 * Differentiation between unit categories is handled via traits (Infantry, Vehicle, Flying, etc.).
 */
export default class UnitData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    return {
      // --- Unit Rating ---
      rating: new StringField({
        required: true,
        initial: "green",
        choices: {
          green: "STARMERCS.Rating.Green",
          trained: "STARMERCS.Rating.Trained",
          experienced: "STARMERCS.Rating.Experienced",
          veteran: "STARMERCS.Rating.Veteran",
          elite: "STARMERCS.Rating.Elite"
        },
        label: "STARMERCS.Rating"
      }),

      // --- Durability ---
      strength: new SchemaField({
        value: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
        max: new NumberField({ required: true, integer: true, min: 1, initial: 10 })
      }),
      readiness: new SchemaField({
        value: new NumberField({ required: true, integer: true, min: 0, initial: 5 }),
        max: new NumberField({ required: true, integer: true, min: 0, initial: 5 })
      }),

      // --- Movement ---
      speed: new NumberField({ required: true, integer: true, min: 0, initial: 4, label: "STARMERCS.Speed" }),

      // --- Supply ---
      supply: new SchemaField({
        capacity: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
        usage: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
        current: new NumberField({ required: true, integer: true, min: 0, initial: 10 })
      }),

      // --- Detection ---
      sensors: new NumberField({ required: true, integer: true, min: 0, initial: 2, label: "STARMERCS.Sensors" }),
      // Signature can be negative (stealth units)
      signature: new NumberField({ required: true, integer: true, initial: 2, label: "STARMERCS.Signature" }),

      // --- Electronic Warfare ---
      ewar: new NumberField({ required: true, integer: true, min: 0, initial: 0, label: "STARMERCS.EWAR" }),

      // --- Communications ---
      comms: new NumberField({ required: true, integer: true, min: 0, initial: 3, label: "STARMERCS.Comms" }),

      // --- Current Order ---
      currentOrder: new StringField({ required: false, initial: "", label: "STARMERCS.CurrentOrder" }),

      // --- Notes ---
      notes: new StringField({ required: false, initial: "" })
    };
  }

  /* ---------------------------------------- */
  /*  Derived Data                            */
  /* ---------------------------------------- */

  /** @override */
  prepareDerivedData() {
    // Rating bonus lookup
    const ratingBonuses = { green: 0, trained: 1, experienced: 2, veteran: 3, elite: 5 };
    this.ratingBonus = ratingBonuses[this.rating] ?? 0;

    // Readiness pool size determined by rank
    const readinessPoolSizes = { green: 5, trained: 8, experienced: 10, veteran: 12, elite: 15 };
    const poolSize = readinessPoolSizes[this.rating] ?? 5;
    this.readiness.max = poolSize;

    // Cap current readiness to max
    if (this.readiness.value > this.readiness.max) {
      this.readiness.value = this.readiness.max;
    }

    // Casualty penalty: for every 20% of strength lost, -1 to damage rolls (min 1 on actual rolls)
    const strengthPct = this.strength.max > 0
      ? this.strength.value / this.strength.max
      : 0;
    this.casualtyPenalty = Math.floor((1 - strengthPct) * 5);

    // Readiness penalties (thresholds scale with pool size)
    const rdyPct = poolSize > 0 ? this.readiness.value / poolSize : 0;
    this.readinessPenalty = {
      accuracy: rdyPct <= 0.7 ? 1 : 0,
      damage: rdyPct <= 0.4 ? -1 : 0
    };

    // Status flags
    this.isRouted = this.readiness.value <= 0;
    this.isDestroyed = this.strength.value <= 0;
  }
}
