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
    readinessCost: 0,
    supplyModifier: "1x",
    description: "May fire weapons at enemies within range."
  },
  move: {
    label: "Maneuver",
    category: "standard",
    allowsMovement: true,
    allowsAttack: true,
    accuracyPenalty: 1,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit maneuvers to target hex. May stop and fire at -1 accuracy if enemies are in range."
  },
  entrench: {
    label: "Entrench",
    category: "standard",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: 1,
    supplyModifier: "1x",
    description: "Unit fortifies position. Gains Entrenched trait during Consolidation if it remains in the same hex."
  },
  forced_march: {
    label: "Forced March",
    category: "standard",
    allowsMovement: true,
    allowsAttack: false,
    readinessCost: -2,
    supplyModifier: "2x",
    speedMultiplier: 2,
    noReturnFire: true,
    description: "Unit moves at 2x movement. Cannot fire. Does not return fire if attacked."
  },
  withdraw: {
    label: "Withdraw",
    category: "standard",
    allowsMovement: true,
    allowsAttack: true,
    accuracyPenalty: 1,
    damagePenalty: 1,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Unit retreats from combat. May fire with -1 accuracy and -1 damage. Must pass morale check or become Disordered."
  },
  assault: {
    label: "Assault",
    category: "standard",
    allowsMovement: true,
    allowsAttack: true,
    readinessCost: -2,
    supplyModifier: "3x",
    description: "Attempt to displace an enemy unit. +1 damage dealt and received. -1 readiness per hex moved to target. Consumes extra fuel."
  },
  overwatch: {
    label: "Overwatch",
    category: "standard",
    allowsMovement: false,
    allowsAttack: true,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Engage any enemy that moves within weapon range."
  },
  stand_down: {
    label: "Stand Down",
    category: "standard",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: 3,
    supplyModifier: "0x",
    description: "Unit powers down and conserves resources. Recovers 3 readiness. Attackers gain +2 to hit and +2 damage. Vehicles do not consume baseline fuel."
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
  demolish: {
    label: "Demolish",
    category: "special",
    requiredTrait: "Engineer",
    allowsMovement: false,
    allowsAttack: false,
    readinessCost: -1,
    supplyModifier: "1x",
    description: "Engineer demolishes a structure at current or adjacent hex."
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
  forest: "Dense Woods",
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
 * movementCost: movement points required to enter the hex (road subtracts 1, min 1)
 * waterTerrain: impassable unless unit has Flying, Hover, or Amphibious trait
 * signatureMod: modifier to signature for Infantry units in this terrain
 * infantryCover: Infantry gains Entrenched trait (Cover)
 * infantryHeavyCover: Infantry gains Armored-like heavy cover (2 damage reduction)
 * maxFireRange: max range for non-Indirect weapons firing from/into this hex (null = unlimited)
 * damageToNonFlying: extra damage taken by non-Flying/non-Hovering units
 * impassableVehicle: Vehicle units cannot enter unless road present
 * noFortification: Entrenchments/fortifications cannot be built
 * hasRoad: always treated as having a road (urban terrain)
 * blocksLOS: blocks line of sight for detection
 *
 * NOTE: Elevation is now an independent per-hex property (0–5) stored in the terrainMap,
 * not a property of terrain types. The old "elevation" field is removed from terrain config.
 */
STARMERCS.terrain = {
  forest: {
    label: "Dense Woods",
    color: 0x228B22,
    pattern: "dots",
    icon: "fas fa-tree",
    movementCost: 3,
    waterTerrain: false,
    signatureMod: -1,
    infantryCover: true,
    infantryHeavyCover: false,
    maxFireRange: 1,
    damageToNonFlying: 1,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: true
  },
  plain: {
    label: "Plain",
    color: 0xC2B280,
    pattern: "none",
    icon: "fas fa-seedling",
    movementCost: 2,
    waterTerrain: false,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: false
  },
  hill: {
    label: "Hill",
    color: 0x8B7355,
    pattern: "horizontal",
    icon: "fas fa-mountain",
    movementCost: 3,
    waterTerrain: false,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: true
  },
  mountain: {
    label: "Mountain",
    color: 0x505050,
    pattern: "zigzag",
    icon: "fas fa-mountain",
    movementCost: 4,
    waterTerrain: false,
    signatureMod: -1,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: true,
    noFortification: false,
    hasRoad: false,
    blocksLOS: true
  },
  swamp: {
    label: "Swamp",
    color: 0x556B2F,
    pattern: "wave",
    icon: "fas fa-water",
    movementCost: 3,
    waterTerrain: false,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: true,
    hasRoad: false,
    blocksLOS: false
  },
  river: {
    label: "River",
    color: 0x4682B4,
    pattern: "chevron",
    icon: "fas fa-water",
    movementCost: 2,
    waterTerrain: true,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: false
  },
  lake: {
    label: "Lake",
    color: 0x1E90FF,
    pattern: "horizontal",
    icon: "fas fa-water",
    movementCost: 2,
    waterTerrain: true,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: false
  },
  ocean: {
    label: "Ocean",
    color: 0x000080,
    pattern: "wave",
    icon: "fas fa-water",
    movementCost: 2,
    waterTerrain: true,
    signatureMod: 0,
    infantryCover: false,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: false
  },
  urbanDense: {
    label: "Urban (Dense)",
    color: 0x606060,
    pattern: "crosshatch",
    icon: "fas fa-city",
    movementCost: 2,
    waterTerrain: false,
    signatureMod: -2,
    infantryCover: false,
    infantryHeavyCover: true,
    maxFireRange: 1,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: true
  },
  urbanLight: {
    label: "Urban (Light)",
    color: 0xBBBBBB,
    pattern: "diagonal",
    icon: "fas fa-building",
    movementCost: 2,
    waterTerrain: false,
    signatureMod: -1,
    infantryCover: true,
    infantryHeavyCover: false,
    maxFireRange: null,
    damageToNonFlying: 0,
    impassableVehicle: false,
    noFortification: false,
    hasRoad: false,
    blocksLOS: false
  }
};

/* ============================================ */
/*  Constructable Structures                   */
/* ============================================ */

/**
 * Structure type definitions for buildable map objects.
 * GM-overridable via world setting "star-mercs.structureOverrides".
 */
STARMERCS.structures = {
  bridge: {
    label: "Bridge",
    icon: "fas fa-archway",
    color: 0xA0522D,
    maxStrength: 3,
    turnsRequired: 2,
    materialsPerTurn: 2,
    canCapture: false,
    requiresWater: true,
    adjacentBuild: true,
    grantsEntrenched: false,
    description: "Allows non-aquatic units to cross water terrain."
  },
  minefield: {
    label: "Minefield",
    icon: "fas fa-bomb",
    color: 0xFF4444,
    maxStrength: 10,
    turnsRequired: 1,
    materialsPerTurn: 2,
    canCapture: false,
    hidden: true,
    grantsEntrenched: false,
    subTypes: {
      antiPersonnel: { label: "Anti-Personnel", damageType: "soft" },
      antiArmor: { label: "Anti-Armor", damageType: "hard" }
    },
    description: "Hidden explosives dealing damage to enemy units entering this hex."
  },
  outpost: {
    label: "Outpost",
    icon: "fas fa-fort-awesome",
    color: 0x4488FF,
    maxStrength: 5,
    turnsRequired: 3,
    materialsPerTurn: 3,
    canCapture: true,
    grantsFortified: true,
    defaultCommsRange: 5,
    defaultSupplyRange: 3,
    defaultSupplyCapacity: {
      smallArms: 10, heavyWeapons: 10, ordnance: 5,
      fuel: 10, materials: 10, parts: 5, basicSupplies: 10
    },
    description: "Fortified position providing cover, supplies, and comms relay."
  },
  fortification: {
    label: "Fortification",
    icon: "fas fa-shield-alt",
    color: 0x88AA44,
    maxStrength: 2,
    turnsRequired: 1,
    materialsPerTurn: 1,
    canCapture: false,
    grantsFortified: true,
    description: "Field fortifications granting Fortified trait to any occupying unit."
  }
};

/**
 * Maximum elevation value for the terrain painter.
 */
STARMERCS.maxElevation = 5;

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
 * Objective types for hex scoring.
 * points: base VP scored per consolidation when occupied
 * color: PIXI hex color for the star icon
 */
STARMERCS.objectives = {
  primary:   { label: "Primary Objective",   points: 3, color: 0xFFD700 },
  secondary: { label: "Secondary Objective", points: 1, color: 0xC0C0C0 }
};

/**
 * Trait activation modes.
 */
STARMERCS.traitModes = {
  passive: "Passive",
  active: "Active",
  conditional: "Conditional"
};

/**
 * Tactical marker types for the team marker painter.
 * icon: Unicode symbol or short text rendered on the marker
 * color: PIXI hex color for the marker background border
 * category: "command" or "spotted" for grouping in the dropdown
 */
STARMERCS.tacticalMarkerTypes = {
  text:                 { label: "Text",           icon: "T",    color: 0xFFFFFF, category: "command" },
  attack:               { label: "Attack Here",    icon: "\u2694",  color: 0xFF4444, category: "command" },
  defend:               { label: "Defend Here",    icon: "\u26E8",  color: 0x4488FF, category: "command" },
  move:                 { label: "Move Here",      icon: "\u279C",  color: 0x44DD44, category: "command" },
  vision:               { label: "Need Vision",    icon: "\u25C9",  color: 0xFFDD00, category: "command" },
  construct:            { label: "Construct Here", icon: "\u2692",  color: 0xFF8800, category: "command" },
  "spotted-artillery":  { label: "Artillery",      icon: "A",    color: 0xFFAA00, category: "spotted" },
  "spotted-infantry":   { label: "Infantry",       icon: "I",    color: 0xFFAA00, category: "spotted" },
  "spotted-tanks":      { label: "Tanks",          icon: "T",    color: 0xFFAA00, category: "spotted" },
  "spotted-mechs":      { label: "Mechs",          icon: "M",    color: 0xFFAA00, category: "spotted" },
  "spotted-logistics":  { label: "Logistics",      icon: "L",    color: 0xFFAA00, category: "spotted" },
  "spotted-unknown":    { label: "Unknown Unit",   icon: "?",    color: 0xFFAA00, category: "spotted" },
  "spotted-outpost":    { label: "Outpost",        icon: "OP",   color: 0xFFAA00, category: "spotted" },
  "spotted-base":       { label: "Base",           icon: "BS",   color: 0xFFAA00, category: "spotted" },
  "spotted-bridge":     { label: "Bridge",         icon: "BR",   color: 0xFFAA00, category: "spotted" },
  "spotted-minefield":  { label: "Minefield",      icon: "\u26A0",  color: 0xFF6600, category: "spotted" }
};
