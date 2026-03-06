/**
 * Reference Tables — a floating window displaying unit traits, weapon traits, and orders.
 *
 * Accessible via the token controls sidebar. Singleton stored on game.starmercs.referenceTables.
 */
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export default class ReferenceTables extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "star-mercs-reference-tables",
    window: {
      title: "Star Mercs — Quick Reference",
      resizable: true
    },
    classes: ["star-mercs", "reference-tables"],
    position: {
      width: 720,
      height: 650
    }
  };

  static PARTS = {
    form: {
      template: "systems/star-mercs/templates/apps/reference-tables.hbs"
    }
  };

  constructor(options = {}) {
    super(options);
    this._activeTab = "unit-traits";
  }

  /* ---------------------------------------- */
  /*  Data Preparation                        */
  /* ---------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const unitTraits = this._buildUnitTraits();
    const weaponTraits = this._buildWeaponTraits();
    const orders = this._buildOrders();
    const terrainTypes = this._buildTerrain();
    const sightTable = this._buildSightTable();

    return {
      activeTab: this._activeTab,
      unitTraits,
      weaponTraits,
      orders,
      terrainTypes,
      sightTable
    };
  }

  _buildUnitTraits() {
    return [
      { name: "Advanced Recon Equipment", type: "Active", value: "", description: "Select a visible enemy unit. Friendly attacks against that target gain +1 to hit." },
      { name: "Air Drop", type: "Passive", value: "", description: "Unit can deploy via Air Drop from the deploy panel." },
      { name: "Amphibious", type: "Passive", value: "", description: "Can cross water at 2 MP per hex." },
      { name: "Armored[X]", type: "Passive", value: "X", description: "Reduce incoming damage by X." },
      { name: "Combined Arms", type: "Passive", value: "", description: "Attackers suffer -1 to hit and -1 damage. Does not apply to Indirect, Artillery, or Aircraft weapons." },
      { name: "Command", type: "Passive", value: "", description: "Friendly units within Comms range may re-roll failed Morale checks once per consolidation phase." },
      { name: "Deploy", type: "Passive", value: "", description: "Must spend 1 turn deploying before using weapons, abilities, or traits. Must pack up before moving." },
      { name: "Engineer", type: "Passive", value: "", description: "Can use the Construct and Demolish special orders." },
      { name: "Entrenched", type: "Conditional", value: "", description: "Unit is in defensive positions. Incoming damage reduced by 1 (min 1). Infantry auto-gain in urban terrain." },
      { name: "Flying", type: "Passive", value: "", description: "Unit can fly. Airborne units can only be targeted by Anti-Air weapons. Uses the unit's MP for flying movement." },
      { name: "Fortified", type: "Conditional", value: "", description: "Built by an Engineer. Incoming damage reduced by 2 (min 1)." },
      { name: "Heavy", type: "Passive", value: "", description: "Soft attacks can only hit on a natural 10." },
      { name: "Hover", type: "Passive", value: "", description: "Moves across any terrain including water. Terrain movement costs reduced by 1 (min 1). Can be hit by any weapon type." },
      { name: "Indirect", type: "Passive", value: "", description: "May fire at targets it cannot see if a friendly unit with Comms can spot for it." },
      { name: "Infantry", type: "Passive", value: "", description: "Can benefit from Entrenchments and Fortifications. Counts as Entrenched in urban zones." },
      { name: "Jump Capable", type: "Passive", value: "", description: "May traverse ±2 elevation when moving instead of the usual ±1." },
      { name: "Mech", type: "Passive", value: "", description: "Walking vehicle. Terrain movement costs reduced by 1 (min 1). Cannot enter water without Amphibious." },
      { name: "Meteoric Assault", type: "Passive", value: "", description: "Enables the Meteoric Assault special order (orbital/high-altitude drop assault)." },
      { name: "Powered", type: "Passive", value: "", description: "All movement costs reduced by 1 (min 1). Does not apply to water." },
      { name: "Satellite Uplink", type: "Passive", value: "", description: "Orbital satellite access. Aircraft weapons in comms chain may acquire any target. Auto-links to Command units." },
      { name: "Shock[X]", type: "Passive", value: "X", description: "When assaulting, if the defender lacks Shock, the defender suffers -X on their assault morale check." },
      { name: "Supply[X]", type: "Passive", value: "X", description: "Enables the Supply special order. May transfer supplies to friendly units within X hexes." },
      { name: "Transport", type: "Passive", value: "", description: "Flying unit can load and carry one Infantry unit. Must land adjacent to load/unload." },
      { name: "Vehicle", type: "Passive", value: "", description: "Unit is comprised primarily of vehicles. Gains reduced terrain cover benefits." }
    ];
  }

  _buildWeaponTraits() {
    return [
      { name: "Accurate[X]", description: "Reduces the accuracy threshold by X (easier to hit)." },
      { name: "Aircraft", description: "Fires during the Airstrikes tactical step. Excluded from Combined Arms penalty." },
      { name: "Area", description: "+1 damage and -1 to accuracy threshold vs Infantry targets." },
      { name: "Artillery", description: "Fires during the Artillery tactical step. Excluded from Combined Arms penalty." },
      { name: "Inaccurate[X]", description: "Increases the accuracy threshold by X (harder to hit)." },
      { name: "Indirect", description: "Can fire at targets without line of sight (requires friendly spotter with Comms). Excluded from Combined Arms penalty." },
      { name: "Ordnance", description: "Uses ordnance ammo type. Triggers APS/ZPS interception from defending units." }
    ];
  }

  _buildOrders() {
    const orders = CONFIG.STARMERCS.orders;
    return Object.entries(orders).map(([key, o]) => ({
      key,
      label: o.label,
      category: o.category === "special" ? "Special" : "Standard",
      move: o.allowsMovement ? "Yes" : "No",
      attack: o.allowsAttack ? "Yes" : "No",
      readiness: o.readinessCost > 0 ? `+${o.readinessCost}` : `${o.readinessCost}`,
      supply: o.supplyModifier ?? "1x",
      requiredTrait: o.requiredTrait ?? "—",
      description: o.description
    }));
  }

  _buildTerrain() {
    const terrain = CONFIG.STARMERCS.terrain;
    return Object.entries(terrain).map(([key, t]) => ({
      key,
      label: t.label,
      movementCost: t.movementCost,
      signatureMod: t.signatureMod !== 0 ? `${t.signatureMod > 0 ? "+" : ""}${t.signatureMod}` : "0",
      infantryCover: t.infantryCover ? "Cover" : (t.infantryHeavyCover ? "Heavy" : "—"),
      maxFireRange: t.maxFireRange !== null ? `${t.maxFireRange}` : "—",
      blocksLOS: t.blocksLOS ? "Yes" : "No",
      waterTerrain: t.waterTerrain ? "Yes" : "No",
      impassableVehicle: t.impassableVehicle ? "Yes" : "No",
      noFortification: t.noFortification ? "Yes" : "No"
    }));
  }

  _buildSightTable() {
    const table = CONFIG.STARMERCS.maxSightDistance;
    return Object.entries(table).map(([elev, dist]) => ({
      elevation: elev,
      maxSight: dist
    }));
  }

  /* ---------------------------------------- */
  /*  Event Listeners                         */
  /* ---------------------------------------- */

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    // Tab switching
    html.querySelectorAll(".ref-tab-btn").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        this._activeTab = ev.currentTarget.dataset.tab;
        this.render(false);
      });
    });
  }
}
