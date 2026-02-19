/**
 * Register custom Handlebars helpers for Star Mercs templates.
 */
export function registerHandlebarsHelpers() {
  // Format attack string "5+/3"
  Handlebars.registerHelper("attackString", function(accuracy, damage) {
    return `${accuracy}+/${damage}`;
  });

  // Pluralize "hex" / "hexes"
  Handlebars.registerHelper("hexLabel", function(value) {
    return value === 1 ? "hex" : "hexes";
  });

  // Equality check
  Handlebars.registerHelper("eq", function(a, b) {
    return a === b;
  });

  // Greater than
  Handlebars.registerHelper("gt", function(a, b) {
    return a > b;
  });

  // Less than or equal
  Handlebars.registerHelper("lte", function(a, b) {
    return a <= b;
  });

  // Localize a config enum value (e.g., "soft" → "Soft Attack")
  Handlebars.registerHelper("localizeConfig", function(configKey, value) {
    const map = CONFIG.STARMERCS?.[configKey];
    if (!map || !value) return value;
    const i18nKey = map[value];
    if (!i18nKey) return value;
    return game.i18n.localize(i18nKey);
  });
}

/**
 * Preload Handlebars template partials.
 * @returns {Promise}
 */
export async function preloadHandlebarsTemplates() {
  const templatePaths = [
    // Actor sheet partials
    "systems/star-mercs/templates/actors/parts/unit-attributes.hbs",
    "systems/star-mercs/templates/actors/parts/unit-combat.hbs",
    "systems/star-mercs/templates/actors/parts/unit-weapons.hbs",
    "systems/star-mercs/templates/actors/parts/unit-traits.hbs",
    "systems/star-mercs/templates/actors/parts/unit-orders.hbs",
    "systems/star-mercs/templates/actors/parts/unit-supply.hbs",
    // Chat card templates
    "systems/star-mercs/templates/chat/attack-result.hbs",
    "systems/star-mercs/templates/chat/skill-check.hbs"
  ];
  return loadTemplates(templatePaths);
}
