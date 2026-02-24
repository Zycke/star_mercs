/**
 * System-wide configuration constants for Star Mercs.
 */
export const STARMERCS = {};

/**
 * Unit rating levels and their associated skill check bonuses.
 */
STARMERCS.ratings = {
  green: { label: "Green", bonus: 0, accuracy: 7 },
  trained: { label: "Trained", bonus: 1, accuracy: 6 },
  experienced: { label: "Experienced", bonus: 2, accuracy: 5 },
  veteran: { label: "Veteran", bonus: 3, accuracy: 4 },
  elite: { label: "Elite", bonus: 5, accuracy: 3 }
};

/**
 * Weapon attack types and their targeting rules.
 */
STARMERCS.attackTypes = {
  soft: "Soft Attack",
  hard: "Hard Attack",
  antiAir: "Anti-Air"
};

/**
 * Order categories.
 */
STARMERCS.orderCategories = {
  standard: "Standard",
  special: "Special"
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
    label: "Hold",
    category: "standard",
    allowsMovement: false,
    allowsAttack: true,
    readinessCost: 1,
    supplyModifier: "1x",
    description: "Unit holds position and engages targets. Recovers readiness."
  },
  move: {
    label: "Maneuver",
    category: "standard",
    allowsMovement: true,
    allowsAttack: true,
    accuracyPenalty: 1,
    readinessCost: 0,
    supplyModifier: "1x",
    description: "Unit maneuvers and may fire at -1 accuracy penalty."
  },
  advance: {
    label: "Advance",
    category: "standard",
    allowsMovement: true,
    allowsAttack: true,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit moves toward the enemy and engages."
  },
  dig_in: {
    label: "Dig In",
    category: "standard",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: 1,
    supplyModifier: "1x",
    description: "Unit fortifies position and recovers readiness."
  },
  withdraw: {
    label: "Withdraw",
    category: "standard",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit retreats from combat. Movement away from enemy."
  },
  recon: {
    label: "Recon",
    category: "standard",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit scouts ahead. May reveal hidden enemies."
  },
  assault: {
    label: "Assault",
    category: "special",
    requiredTrait: "Assault",
    allowsMovement: true,
    allowsAttack: true,
    readinessCost: -2,
    supplyModifier: "2x",
    description: "Aggressive charge into enemy positions."
  },
  overwatch: {
    label: "Overwatch",
    category: "standard",
    allowsMovement: false,
    allowsAttack: true,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit watches an area and fires on enemies that enter."
  },
  fortify: {
    label: "Fortify",
    category: "special",
    requiredTrait: "Engineer",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Engineer unit constructs fortifications at its position."
  },
  construct: {
    label: "Construct",
    category: "special",
    requiredTrait: "Engineer",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Engineer unit constructs field structures."
  },
  meteoric_assault: {
    label: "Meteoric Assault",
    category: "special",
    requiredTrait: "Meteoric Assault",
    allowsMovement: true,
    allowsAttack: true,
    readinessCost: -2,
    supplyModifier: "2x",
    description: "Unit performs a devastating drop assault from orbit or high altitude."
  },
  supply_order: {
    label: "Supply",
    category: "special",
    requiredTrait: "Supply",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: 0,
    supplyModifier: "0x",
    description: "Unit focuses on supply distribution to nearby friendlies."
  },
  deploy: {
    label: "Deploy",
    category: "special",
    requiredTrait: "Deploy",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit deploys into combat readiness, enabling abilities and weapons."
  },
  stand_down: {
    label: "Stand Down",
    category: "standard",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: 3,
    supplyModifier: "0x",
    description: "Unit powers down and conserves resources. Recovers 3 readiness. Attackers gain +2 to hit and +2 damage against this unit. Vehicles do not consume baseline fuel."
  }
};

/**
 * Turn phases.
 */
STARMERCS.phases = {
  preparation: "Preparation",
  orders: "Orders",
  tactical: "Tactical",
  consolidation: "Consolidation"
};

/**
 * Ordered array of phase keys for sequencing.
 */
STARMERCS.phaseOrder = ["preparation", "orders", "tactical", "consolidation"];

/**
 * Terrain types — labels for dropdowns.
 */
STARMERCS.terrainTypes = {
  forest: "Forest",
  plain: "Plain",
  hill: "Hill",
  mountain: "Mountain",
  swamp: "Swamp",
  river: "River",
  lake: "Lake",
  ocean: "Ocean",
  urbanDense: "Urban (Dense)",
  urbanLight: "Urban (Light)"
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
    label: "Forest",
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
    label: "Plain",
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
    label: "Hill",
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
    label: "Mountain",
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
    label: "Swamp",
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
    label: "River",
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
    label: "Lake",
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
    label: "Ocean",
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
    label: "Urban (Dense)",
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
    label: "Urban (Light)",
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
  passive: "Passive",
  active: "Active",
  conditional: "Conditional"
};
