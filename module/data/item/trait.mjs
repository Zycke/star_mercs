const { BooleanField, NumberField, StringField, HTMLField } = foundry.data.fields;

/**
 * Data model for trait items.
 * Traits define special abilities, categories, and rules interactions for units.
 * Many traits have a numeric parameter [X] (e.g., Armored[3], Flying[6], Supply[2]).
 */
export default class TraitData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    return {
      // Rules text for the trait
      description: new HTMLField({ required: false, initial: "" }),

      // Numeric value for parameterized traits (e.g., Armored[X], Flying[X])
      traitValue: new NumberField({
        required: false, integer: true, min: 0, initial: 0,
        label: "STARMERCS.TraitValue"
      }),

      // Second numeric value for dual-parameter traits (e.g., ZPS[X][Y])
      traitValue2: new NumberField({
        required: false, integer: true, min: 0, initial: 0,
        label: "STARMERCS.TraitValue2"
      }),

      // Whether this trait is always active, manually activated, or conditional
      passive: new StringField({
        required: true,
        initial: "passive",
        choices: {
          passive: "STARMERCS.TraitMode.Passive",
          active: "STARMERCS.TraitMode.Active",
          conditional: "STARMERCS.TraitMode.Conditional"
        },
        label: "STARMERCS.TraitMode"
      }),

      // Whether this trait is currently activated (toggled via checkbox on the unit sheet)
      active: new BooleanField({ required: true, initial: false, label: "STARMERCS.TraitActive" })
    };
  }

  /* ---------------------------------------- */
  /*  Derived Data                            */
  /* ---------------------------------------- */

  /** @override */
  prepareDerivedData() {
    // Display name with bracket value(s), e.g., "Armored[3]" or "ZPS[3][4]"
    if (this.traitValue > 0 && this.traitValue2 > 0) {
      this.displayName = `${this.parent.name}[${this.traitValue}][${this.traitValue2}]`;
    } else if (this.traitValue > 0) {
      this.displayName = `${this.parent.name}[${this.traitValue}]`;
    } else {
      this.displayName = this.parent.name;
    }
  }
}
