/**
 * System-wide configuration constants for Star Mercs.
 */
export const STARMERCS = {};

/**
 * Unit rating levels and their associated skill check bonuses.
 */
STARMERCS.ratings = {
  green: { label: "STARMERCS.Rating.Green", bonus: 0 },
  trained: { label: "STARMERCS.Rating.Trained", bonus: 1 },
  experienced: { label: "STARMERCS.Rating.Experienced", bonus: 2 },
  veteran: { label: "STARMERCS.Rating.Veteran", bonus: 3 },
  elite: { label: "STARMERCS.Rating.Elite", bonus: 5 }
};

/**
 * Weapon attack types and their targeting rules.
 */
STARMERCS.attackTypes = {
  soft: "STARMERCS.AttackType.Soft",
  hard: "STARMERCS.AttackType.Hard",
  antiAir: "STARMERCS.AttackType.AntiAir"
};

/**
 * Order categories.
 */
STARMERCS.orderCategories = {
  standard: "STARMERCS.OrderCategory.Standard",
  special: "STARMERCS.OrderCategory.Special"
};

/**
 * Turn phases.
 */
STARMERCS.phases = {
  preparation: "STARMERCS.Phase.Preparation",
  orders: "STARMERCS.Phase.Orders",
  tactical: "STARMERCS.Phase.Tactical",
  consolidation: "STARMERCS.Phase.Consolidation"
};

/**
 * Terrain types and their effects.
 */
STARMERCS.terrainTypes = {
  forest: "STARMERCS.Terrain.Forest",
  plain: "STARMERCS.Terrain.Plain",
  hill: "STARMERCS.Terrain.Hill",
  mountain: "STARMERCS.Terrain.Mountain",
  swamp: "STARMERCS.Terrain.Swamp",
  river: "STARMERCS.Terrain.River",
  lake: "STARMERCS.Terrain.Lake",
  ocean: "STARMERCS.Terrain.Ocean",
  urbanDense: "STARMERCS.Terrain.UrbanDense",
  urbanLight: "STARMERCS.Terrain.UrbanLight"
};

/**
 * Trait activation modes.
 */
STARMERCS.traitModes = {
  passive: "STARMERCS.TraitMode.Passive",
  active: "STARMERCS.TraitMode.Active",
  conditional: "STARMERCS.TraitMode.Conditional"
};
