const { StringField, HTMLField, BooleanField, NumberField } = foundry.data.fields;

/**
 * Data model for order items.
 * Orders define unit behavior during the tactical phase.
 * Standard orders are available to all units; special orders require a matching trait.
 */
export default class OrderData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    return {
      // Rules description of the order
      description: new HTMLField({ required: false, initial: "" }),

      // Standard vs. special order
      category: new StringField({
        required: true,
        initial: "standard",
        choices: {
          standard: "STARMERCS.OrderCategory.Standard",
          special: "STARMERCS.OrderCategory.Special"
        },
        label: "STARMERCS.OrderCategory"
      }),

      // Supply cost modifier (e.g., "2x", "0-2x", "3x")
      supplyModifier: new StringField({
        required: false, initial: "1x",
        label: "STARMERCS.SupplyModifier"
      }),

      // Readiness cost when using this order (negative number, e.g., -1, -2)
      readinessCost: new NumberField({
        required: false, integer: true, initial: 0,
        label: "STARMERCS.ReadinessCost"
      }),

      // Whether this order allows the unit to move
      allowsMovement: new BooleanField({ required: true, initial: true }),

      // Whether this order allows the unit to attack
      allowsAttack: new BooleanField({ required: true, initial: false }),

      // Required trait name for special orders (e.g., "Assault" order requires "Assault" trait)
      requiredTrait: new StringField({ required: false, initial: "" })
    };
  }
}
