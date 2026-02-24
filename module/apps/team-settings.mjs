/**
 * GM form application for assigning players to teams.
 * Manages the `teamAssignments` and `teamAssignmentsEnabled` world settings.
 */
export default class TeamSettingsForm extends FormApplication {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "star-mercs-team-settings",
      title: "Team Settings",
      template: "systems/star-mercs/templates/apps/team-settings.hbs",
      classes: ["star-mercs", "team-settings"],
      width: 400,
      height: "auto",
      popOut: true,
      closeOnSubmit: false,
      submitOnChange: false
    });
  }

  /** @override */
  getData() {
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const enabled = game.settings.get("star-mercs", "teamAssignmentsEnabled") ?? false;

    const users = game.users
      .filter(u => !u.isGM)
      .map(u => ({
        id: u.id,
        name: u.name,
        team: assignments[u.id] ?? "spectator"
      }));

    return {
      users,
      enabled
    };
  }

  /** @override */
  async _updateObject(event, formData) {
    const assignments = {};
    for (const user of game.users) {
      if (user.isGM) continue;
      const key = `team-${user.id}`;
      if (formData[key]) {
        assignments[user.id] = formData[key];
      }
    }

    await game.settings.set("star-mercs", "teamAssignments", assignments);
    await game.settings.set("star-mercs", "teamAssignmentsEnabled", formData.enabled === true || formData.enabled === "true");

    // Bulk sync ownership
    await game.starmercs?.syncAllOwnership?.();
    ui.notifications.info("Team assignments saved and ownership synced.");
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);
  }
}
