import StarMercsCombat from "../documents/combat.mjs";

/**
 * Turn Control Panel — a floating UI for managing combat phases.
 *
 * Features:
 * - Displays current round, phase, and tactical sub-step
 * - Per-player "Ready" checkmarks (each player can only toggle their own)
 * - "Next Phase" button (enabled when all players are ready)
 * - GM-only "Previous Phase" and "GM Override" buttons
 * - Team scores display
 *
 * Toggled from the token controls menu. Singleton stored on game.starmercs.turnControlPanel.
 */
export default class TurnControlPanel extends FormApplication {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "star-mercs-turn-control",
      title: "Turn Control",
      template: "systems/star-mercs/templates/apps/turn-control.hbs",
      classes: ["star-mercs", "turn-control"],
      width: 280,
      height: "auto",
      popOut: true,
      resizable: false,
      closeOnSubmit: false,
      submitOnChange: false
    });
  }

  /** @override */
  getData() {
    const combat = game.combat;
    const hasCombat = combat?.started && (combat instanceof StarMercsCombat);

    if (!hasCombat) return { hasCombat: false };

    const phase = combat.phase;
    const phaseIndex = combat.phaseIndex;
    const round = combat.round;
    const phaseLabel = combat.phaseLabel;

    // Tactical sub-step label
    let tacticalStepLabel = null;
    if (phaseIndex === 3) {
      const stepIdx = combat.getFlag("star-mercs", "tacticalStep") ?? 0;
      const step = StarMercsCombat.TACTICAL_STEPS[stepIdx];
      if (step) tacticalStepLabel = step.label;
    }

    // Team assignments and scores
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const teamScores = hasCombat ? (combat.getFlag("star-mercs", "teamScores") ?? {}) : {};
    const teams = [
      { key: "a", label: "Team A", score: teamScores.a ?? 0 },
      { key: "b", label: "Team B", score: teamScores.b ?? 0 }
    ];

    // Build player ready list (non-GM, non-spectator users)
    const players = [];
    for (const user of game.users) {
      if (user.isGM) continue;
      const team = assignments[user.id];
      if (!team || team === "spectator") continue;

      players.push({
        id: user.id,
        name: user.name,
        team,
        teamLabel: team === "a" ? "Team A" : "Team B",
        ready: user.getFlag("star-mercs", "combatReady") ?? false,
        canToggle: user.id === game.user.id
      });
    }

    // "Next Phase" is enabled when ALL listed players are ready (or there are no players)
    const allReady = players.length === 0 || players.every(p => p.ready);

    return {
      hasCombat,
      phase,
      round,
      phaseLabel,
      tacticalStepLabel,
      teams,
      players,
      canAdvance: allReady,
      isGM: game.user.isGM
    };
  }

  /** @override — no-op, this form doesn't submit data. */
  async _updateObject() {}

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // Ready checkboxes — each player can only toggle their own
    html.find(".ready-checkbox").on("change", async (event) => {
      const checkbox = event.currentTarget;
      const userId = checkbox.dataset.userId;
      if (userId !== game.user.id) {
        event.preventDefault();
        return;
      }
      await game.user.setFlag("star-mercs", "combatReady", checkbox.checked);
    });

    // Next Phase button — any player can press when all are ready
    html.find(".next-phase-btn").on("click", async () => {
      const combat = game.combat;
      if (!combat?.started) return;
      if (game.user.isGM) {
        await combat.nextTurn();
      } else {
        // Non-GM: request the GM client to advance via socket
        game.socket.emit("system.star-mercs", { action: "nextPhase" });
      }
    });

    // GM Previous Phase
    html.find(".prev-phase-btn").on("click", async () => {
      if (!game.user.isGM) return;
      const combat = game.combat;
      if (!combat?.started) return;
      await combat.previousTurn();
    });

    // GM Override — advance regardless of ready state
    html.find(".gm-override-btn").on("click", async () => {
      if (!game.user.isGM) return;
      const combat = game.combat;
      if (!combat?.started) return;
      // Clear ready flags manually then advance
      for (const user of game.users) {
        if (user.getFlag("star-mercs", "combatReady")) {
          await user.unsetFlag("star-mercs", "combatReady");
        }
      }
      await combat.nextTurn();
    });
  }
}
