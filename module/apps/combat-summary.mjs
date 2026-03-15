/**
 * Combat Summary — a floating panel showing per-unit status for the current/previous tactical phase.
 *
 * Displays: damage dealt, damage taken, remaining STR/RDY, supplies consumed.
 * Players see only their team; GM sees all units organized by team.
 * Updates live after each tactical sub-phase and after consolidation.
 *
 * Singleton stored on game.starmercs.combatSummary.
 */

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export default class CombatSummary extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "star-mercs-combat-summary",
    window: {
      title: "Combat Summary",
      resizable: true
    },
    classes: ["star-mercs", "combat-summary"],
    position: {
      width: 420,
      height: 500
    }
  };

  static PARTS = {
    form: {
      template: "systems/star-mercs/templates/apps/combat-summary.hbs"
    }
  };

  constructor(options = {}) {
    super(options);
    /** @type {string} Currently viewed team tab (GM can switch, defaults to "all") */
    this._viewedTeam = null;
  }

  /* ---------------------------------------- */
  /*  Data Preparation                        */
  /* ---------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const combat = game.combat;
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const playerTeam = assignments[game.user.id] ?? "a";

    // GM defaults to "all", players locked to their team
    const viewedTeam = isGM ? (this._viewedTeam ?? "all") : playerTeam;
    this._viewedTeam = viewedTeam;

    if (!combat) {
      return { isGM, viewedTeam, hasData: false, teams: [], turnNumber: 0 };
    }

    const turnNumber = combat.round ?? 0;
    const phase = combat.phase ?? "—";

    // Gather damage dealt/taken from previous turn for display
    const damageDealt = combat.getFlag("star-mercs", "damageDealtPrevTurn") ?? {};
    const damageTaken = combat.getFlag("star-mercs", "damageTakenPrevTurn") ?? {};

    // Build per-unit summaries
    const unitsByTeam = { a: [], b: [] };

    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "unit") continue;
      const token = combatant.token;
      const unitName = token?.name ?? actor.name;
      const team = actor.system.team ?? "a";

      // Filter by viewed team for non-GM
      if (!isGM && team !== playerTeam) continue;
      if (isGM && viewedTeam !== "all" && team !== viewedTeam) continue;

      const str = actor.system.strength;
      const rdy = actor.system.readiness;
      const supply = actor.system.supply ?? {};

      // Damage dealt (from previous turn, keyed by unit name)
      const dealt = damageDealt[unitName] ?? 0;

      // Damage taken (from previous turn, keyed by token ID)
      const taken = token ? (damageTaken[token.id] ?? 0) : 0;

      // Supply status
      const fuel = supply.fuel;
      const energy = supply.energy;
      const projectile = supply.projectile;
      const ordnance = supply.ordnance;
      const basicSupplies = supply.basicSupplies;

      // Determine if destroyed
      const destroyed = str.value <= 0;
      const order = actor.system.currentOrder;
      const orderLabel = CONFIG.STARMERCS.orders?.[order]?.label ?? "—";

      const unitData = {
        tokenId: token?.id ?? "",
        name: unitName,
        team,
        order: orderLabel,
        destroyed,
        str: str.value,
        strMax: str.max,
        rdy: rdy.value,
        rdyMax: rdy.max,
        damageDealt: dealt,
        damageTaken: taken
      };

      // Build per-supply-type data
      unitData.supplyColumns = {};
      if (fuel?.capacity > 0) unitData.supplyColumns.fuel = { current: fuel.current, capacity: fuel.capacity };
      if (energy?.capacity > 0) unitData.supplyColumns.energy = { current: energy.current, capacity: energy.capacity };
      if (projectile?.capacity > 0) unitData.supplyColumns.projectile = { current: projectile.current, capacity: projectile.capacity };
      if (ordnance?.capacity > 0) unitData.supplyColumns.ordnance = { current: ordnance.current, capacity: ordnance.capacity };
      if (basicSupplies?.capacity > 0) unitData.supplyColumns.basicSupplies = { current: basicSupplies.current, capacity: basicSupplies.capacity };

      if (!unitsByTeam[team]) unitsByTeam[team] = [];
      unitsByTeam[team].push(unitData);
    }

    // Collect all supply column keys across all units
    const supplyColumnLabels = {
      fuel: "Fuel", energy: "Energy",
      projectile: "Proj", ordnance: "Ord",
      basicSupplies: "Sup"
    };
    const allSupplyKeys = new Set();
    for (const team of Object.values(unitsByTeam)) {
      for (const unit of team) {
        if (unit.supplyColumns) {
          for (const key of Object.keys(unit.supplyColumns)) allSupplyKeys.add(key);
        }
      }
    }
    // Ordered supply columns
    const supplyKeyOrder = ["fuel", "energy", "projectile", "ordnance", "basicSupplies"];
    const activeSupplyColumns = supplyKeyOrder.filter(k => allSupplyKeys.has(k));

    // Sort each team: destroyed last, then alphabetical
    for (const team of Object.values(unitsByTeam)) {
      team.sort((a, b) => {
        if (a.destroyed !== b.destroyed) return a.destroyed ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    }

    // Build teams array for template
    const teams = [];
    if (viewedTeam === "all" || viewedTeam === "a") {
      if (unitsByTeam.a.length > 0) {
        teams.push({ label: "Team A", key: "a", units: unitsByTeam.a });
      }
    }
    if (viewedTeam === "all" || viewedTeam === "b") {
      if (unitsByTeam.b.length > 0) {
        teams.push({ label: "Team B", key: "b", units: unitsByTeam.b });
      }
    }

    return {
      isGM,
      viewedTeam,
      hasData: teams.length > 0,
      teams,
      turnNumber,
      phase,
      supplyColumns: activeSupplyColumns.map(k => ({ key: k, label: supplyColumnLabels[k] ?? k }))
    };
  }

  /* ---------------------------------------- */
  /*  Rendering & Event Listeners             */
  /* ---------------------------------------- */

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Team tab switching (GM only)
    html.querySelectorAll(".summary-team-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        this._viewedTeam = btn.dataset.team;
        this.render();
      });
    });

    // Click unit name to select token
    html.querySelectorAll(".summary-unit-row[data-token-id]").forEach(row => {
      row.addEventListener("click", () => {
        const tokenId = row.dataset.tokenId;
        if (!tokenId) return;
        const token = canvas.tokens?.get(tokenId);
        if (token) {
          token.control({ releaseOthers: true });
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 500 });
        }
      });
    });
  }
}
