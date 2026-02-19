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
 * Standard orders available to all units.
 * Special orders require a matching trait.
 *
 * readinessCost: readiness deducted during consolidation (negative = loss)
 * allowsMovement: unit may move during tactical phase
 * allowsAttack: unit may attack during tactical phase
 * supplyModifier: multiplier string for supply consumption
 */
STARMERCS.orders = {
  hold: {
    label: "STARMERCS.Order.Hold",
    category: "standard",
    allowsMovement: false,
    allowsAttack: true,
    readinessCost: 1,
    supplyModifier: "1x",
    description: "Unit holds position and engages targets. Recovers readiness."
  },
  move: {
    label: "STARMERCS.Order.Move",
    category: "standard",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: 0,
    supplyModifier: "1x",
    description: "Unit moves without engaging the enemy."
  },
  advance: {
    label: "STARMERCS.Order.Advance",
    category: "standard",
    allowsMovement: true,
    allowsAttack: true,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit moves toward the enemy and engages."
  },
  dig_in: {
    label: "STARMERCS.Order.DigIn",
    category: "standard",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: 1,
    supplyModifier: "1x",
    description: "Unit fortifies position and recovers readiness."
  },
  withdraw: {
    label: "STARMERCS.Order.Withdraw",
    category: "standard",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit retreats from combat. Movement away from enemy."
  },
  recon: {
    label: "STARMERCS.Order.Recon",
    category: "standard",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit scouts ahead. May reveal hidden enemies."
  },
  assault: {
    label: "STARMERCS.Order.Assault",
    category: "special",
    requiredTrait: "Assault",
    allowsMovement: true,
    allowsAttack: true,
    readinessCost: -2,
    supplyModifier: "2x",
    description: "Aggressive charge into enemy positions."
  },
  overwatch: {
    label: "STARMERCS.Order.Overwatch",
    category: "standard",
    allowsMovement: false,
    allowsAttack: true,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit watches an area and fires on enemies that enter."
  }
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
 * Ordered array of phase keys for sequencing.
 */
STARMERCS.phaseOrder = ["preparation", "orders", "tactical", "consolidation"];

/**
 * Terrain types — labels for dropdowns.
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
 * Terrain effects data table.
 * Encodes the rules for each terrain type's modifiers.
 *
 * movementCost: hex movement cost (default 1, road halves it to 0.5)
 * signatureMod: modifier to signature for Infantry units in this terrain
 * infantryCover: Infantry gains Entrenched trait (Cover)
 * infantryHeavyCover: Infantry gains Armored-like heavy cover (2 damage reduction)
 * maxFireRange: max range for non-Indirect weapons firing from/into this hex (null = unlimited)
 * damageToNonFlying: extra damage taken by non-Flying/non-Hovering units
 * impassableVehicle: Vehicle units cannot enter unless road present
 * noFortification: Entrenchments/fortifications cannot be built
 * hasRoad: always treated as having a road
 * elevationBonus: units gain +1 weapon range when firing downhill
 * blocksLOS: blocks line of sight for detection
 */
STARMERCS.terrain = {
  forest: {
    label: "STARMERCS.Terrain.Forest",
    movementCost: 2,
    signatureMod: -1,
    infantryCover: true,
    infantryHeavyCover: false,
    maxFireRange: 1,
    damageToNonFlying: 1,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    elevationBonus: false,
    blocksLOS: true
  },
  plain: {
    label: "STARMERCS.Terrain.Plain",
    movementCost: 1,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    elevationBonus: false,
    blocksLOS: false
  },
  hill: {
    label: "STARMERCS.Terrain.Hill",
    movementCost: 1,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    elevationBonus: true,
    blocksLOS: true
  },
  mountain: {
    label: "STARMERCS.Terrain.Mountain",
    movementCost: 3,
    signatureMod: -1,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: true,
    noFortification: false,
    hasRoad: false,
    elevationBonus: true,
    blocksLOS: true
  },
  swamp: {
    label: "STARMERCS.Terrain.Swamp",
    movementCost: 2,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: true,
    hasRoad: false,
    elevationBonus: false,
    blocksLOS: false
  },
  river: {
    label: "STARMERCS.Terrain.River",
    movementCost: 2,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    elevationBonus: false,
    blocksLOS: false
  },
  lake: {
    label: "STARMERCS.Terrain.Lake",
    movementCost: 2,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    elevationBonus: false,
    blocksLOS: false
  },
  ocean: {
    label: "STARMERCS.Terrain.Ocean",
    movementCost: 2,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    elevationBonus: false,
    blocksLOS: false
  },
  urbanDense: {
    label: "STARMERCS.Terrain.UrbanDense",
    movementCost: 1,
    signatureMod: -2,
    infantryCover: false,
    infantryHeavyCover: true,
    maxFireRange: 1,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: true,
    elevationBonus: false,
    blocksLOS: true
  },
  urbanLight: {
    label: "STARMERCS.Terrain.UrbanLight",
    movementCost: 1,
    signatureMod: -1,
    infantryCover: true,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: true,
    elevationBonus: false,
    blocksLOS: false
  }
};

/**
 * Arrow colors for the targeting overlay, keyed by weapon attack type.
 * Values are hex color numbers for PIXI.Graphics.
 */
STARMERCS.arrowColors = {
  soft: 0xFFFF00,     // Yellow
  hard: 0xFF3333,     // Red
  antiAir: 0x9933FF   // Purple
};

/**
 * Trait activation modes.
 */
STARMERCS.traitModes = {
  passive: "STARMERCS.TraitMode.Passive",
  active: "STARMERCS.TraitMode.Active",
  conditional: "STARMERCS.TraitMode.Conditional"
};
