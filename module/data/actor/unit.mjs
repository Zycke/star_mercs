const { ArrayField, SchemaField, NumberField, StringField } = foundry.data.fields;

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
        value: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
        max: new NumberField({ required: true, integer: true, min: 0, initial: 10 })
      }),

      // --- Movement (movement points available per turn) ---
      movement: new NumberField({ required: true, integer: true, min: 0, initial: 4, label: "STARMERCS.Movement" }),

      // --- Supply (7 categories) ---
      supply: new SchemaField({
        projectile: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 10 })
        }),
        ordnance: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 5 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 5 })
        }),
        energy: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
          rechargeRate: new NumberField({ required: true, integer: true, min: 0, initial: 2 })
        }),
        fuel: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 10 })
        }),
        materials: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
        }),
        parts: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
        }),
        basicSupplies: new SchemaField({
          current: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
          capacity: new NumberField({ required: true, integer: true, min: 0, initial: 10 })
        })
      }),

      // Fuel consumed per movement point spent
      fuelPerMP: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),

      // --- Detection ---
      sensors: new NumberField({ required: true, integer: true, min: 0, initial: 2, label: "STARMERCS.Sensors" }),
      // Signature can be negative (stealth units)
      signature: new NumberField({ required: true, integer: true, initial: 2, label: "STARMERCS.Signature" }),
      // Sight range in sight points (determines max LOS distance, modified by terrain elevation)
      sightRange: new NumberField({ required: true, integer: false, min: 1, initial: 5, label: "STARMERCS.SightRange" }),

      // --- Electronic Warfare ---
      ewar: new NumberField({ required: true, integer: true, min: 0, initial: 0, label: "STARMERCS.EWAR" }),

      // --- Communications ---
      comms: new NumberField({ required: true, integer: true, min: 0, initial: 3, label: "STARMERCS.Comms" }),

      // --- Current Order ---
      currentOrder: new StringField({ required: false, initial: "", label: "STARMERCS.CurrentOrder" }),

      // --- Team Assignment ---
      team: new StringField({ required: true, initial: "a", choices: { a: "Team A", b: "Team B" } }),

      // --- Notes ---
      notes: new StringField({ required: false, initial: "" }),

      // Unit log: history of events (damage, morale, orders, supply)
      log: new ArrayField(new SchemaField({
        turn: new NumberField({ integer: true, initial: 0 }),
        phase: new StringField({ initial: "" }),
        text: new StringField({ initial: "" }),
        type: new StringField({ initial: "info" })
      }), { initial: [] })
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
    const readinessPoolSizes = { green: 10, trained: 13, experienced: 15, veteran: 17, elite: 20 };
    const poolSize = readinessPoolSizes[this.rating] ?? 10;
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
