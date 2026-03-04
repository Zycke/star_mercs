/**
 * Deploy Panel — a per-team floating UI for managing unit deployment.
 *
 * Features:
 * - Shows units waiting in the deploy pool for the viewer's team
 * - GM can switch between teams and add units to the pool
 * - Right-click context menu for deployment options during Deploy phase
 * - Supports standard deployment (within HQ radius) and special deployment
 *   (Meteoric Assault, Air Assault, Air Drop)
 *
 * Toggled from the token controls menu. Singleton stored on game.starmercs.deployPanel.
 */
import { getDeployableHexes, getSpecialDeployHexes, isValidDeployHex } from "../deploy-utils.mjs";
import { snapToHexCenter, hexKey, hexCenterToTokenPosition } from "../hex-utils.mjs";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export default class DeployPanel extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "star-mercs-deploy-panel",
    window: {
      title: "Deploy Panel",
      resizable: true
    },
    classes: ["star-mercs", "deploy-panel"],
    position: {
      width: 340,
      height: 500
    }
  };

  static PARTS = {
    form: {
      template: "systems/star-mercs/templates/apps/deploy-panel.hbs"
    }
  };

  constructor(options = {}) {
    super(options);
    /** @type {string} Currently viewed team tab (GM can switch) */
    this._viewedTeam = null;
    /** @type {PIXI.Graphics|null} Canvas overlay for deploy hex highlights */
    this._deployOverlay = null;
    /** @type {Function|null} Canvas click handler during deployment */
    this._deployClickHandler = null;
  }

  /* ---------------------------------------- */
  /*  Data Preparation                        */
  /* ---------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const viewerTeam = isGM ? (this._viewedTeam ?? "a") : (assignments[game.user.id] ?? "a");
    this._viewedTeam = viewerTeam;

    const deployPool = game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] };
    const teamPool = deployPool[viewerTeam] ?? [];

    const combat = game.combat;
    const isDeployPhase = combat?.started && combat?.phase === "deploy";

    // Resolve actor data for each pool entry
    const poolEntries = [];
    for (const entry of teamPool) {
      const actor = game.actors.get(entry.actorId);
      if (!actor) continue;

      const specialTraits = [];
      if (actor.hasTrait("Meteoric Assault")) specialTraits.push("Meteoric Assault");
      if (actor.hasTrait("Air Assault")) specialTraits.push("Air Assault");
      if (actor.hasTrait("Air Drop")) specialTraits.push("Air Drop");

      poolEntries.push({
        actorId: entry.actorId,
        name: actor.name,
        img: actor.img,
        ratingLabel: actor.system.rating?.charAt(0).toUpperCase() + actor.system.rating?.slice(1) ?? "Unknown",
        strength: actor.system.strength?.value ?? 0,
        specialTraits: specialTraits.length > 0 ? specialTraits.join(", ") : null
      });
    }

    return {
      isGM,
      viewedTeam: viewerTeam,
      isDeployPhase,
      poolEntries,
      canAdd: isGM,
      canRemove: isGM
    };
  }

  /* ---------------------------------------- */
  /*  Rendering & Event Listeners             */
  /* ---------------------------------------- */

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Team tab switching (GM only)
    html.querySelectorAll(".team-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        this._viewedTeam = btn.dataset.team;
        this.render();
      });
    });

    // Add unit button (GM only)
    html.querySelector(".add-unit-btn")?.addEventListener("click", () => this._onAddUnit());

    // Remove buttons (GM only)
    html.querySelectorAll(".remove-btn").forEach(btn => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const actorId = btn.closest(".deploy-entry").dataset.actorId;
        this._onRemoveUnit(actorId);
      });
    });

    // Right-click context menu on deploy entries
    html.querySelectorAll(".deploy-entry").forEach(el => {
      el.addEventListener("contextmenu", (event) => this._onEntryContextMenu(event));
    });

    // Drop zone: accept actor drops from sidebar
    const poolList = html.querySelector(".deploy-pool-list");
    if (poolList && game.user.isGM) {
      poolList.addEventListener("dragover", (event) => event.preventDefault());
      poolList.addEventListener("drop", (event) => this._onDropActor(event));
    }
  }

  /* ---------------------------------------- */
  /*  Pool Management                         */
  /* ---------------------------------------- */

  /**
   * Open a dialog for the GM to select an actor to add to the deploy pool.
   */
  async _onAddUnit() {
    const team = this._viewedTeam ?? "a";
    const teamActors = game.actors.filter(a => a.type === "unit" && a.system.team === team);

    if (teamActors.length === 0) {
      ui.notifications.warn(`No ${team === "a" ? "Team A" : "Team B"} actors found.`);
      return;
    }

    // Build actor selection dialog
    const options = teamActors.map(a =>
      `<option value="${a.id}">${a.name} (STR ${a.system.strength?.value ?? 0})</option>`
    ).join("");

    const content = `<form><div class="form-group">
      <label>Select Unit</label>
      <select name="actorId">${options}</select>
    </div></form>`;

    const result = await Dialog.wait({
      title: "Add Unit to Deploy Pool",
      content,
      buttons: {
        add: { label: "Add", icon: '<i class="fas fa-plus"></i>', callback: (html) => {
          return html.querySelector ? html.querySelector("[name=actorId]")?.value : html[0].querySelector("[name=actorId]")?.value;
        }},
        cancel: { label: "Cancel" }
      },
      default: "add"
    });

    if (!result) return;
    await this._addToPool(result, team);
  }

  /**
   * Handle an actor drop from the sidebar.
   * @param {DragEvent} event
   */
  async _onDropActor(event) {
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch { return; }

    if (data.type !== "Actor") return;
    const actor = await fromUuid(data.uuid);
    if (!actor || actor.type !== "unit") {
      ui.notifications.warn("Only unit actors can be added to the deploy pool.");
      return;
    }

    const team = this._viewedTeam ?? "a";
    if (actor.system.team !== team) {
      ui.notifications.warn(`This actor belongs to ${actor.system.team === "a" ? "Team A" : "Team B"}, not the currently viewed team.`);
      return;
    }

    await this._addToPool(actor.id, team);
  }

  /**
   * Add an actor to the deploy pool for a team.
   * @param {string} actorId
   * @param {string} team
   */
  async _addToPool(actorId, team) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    if (!pool[team]) pool[team] = [];

    // Check for duplicates
    if (pool[team].some(e => e.actorId === actorId)) {
      ui.notifications.warn("This unit is already in the deploy pool.");
      return;
    }

    pool[team].push({ actorId, addedBy: game.user.id });
    await game.settings.set("star-mercs", "deployPool", pool);
    this.render();
  }

  /**
   * Remove an actor from the deploy pool.
   * @param {string} actorId
   */
  async _onRemoveUnit(actorId) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    const team = this._viewedTeam ?? "a";
    if (!pool[team]) return;

    pool[team] = pool[team].filter(e => e.actorId !== actorId);
    await game.settings.set("star-mercs", "deployPool", pool);
    this.render();
  }

  /* ---------------------------------------- */
  /*  Right-Click Context Menu                */
  /* ---------------------------------------- */

  /**
   * Show a context menu with deploy options on right-click.
   * @param {MouseEvent} event
   */
  _onEntryContextMenu(event) {
    event.preventDefault();

    const combat = game.combat;
    if (!combat?.started || combat.phase !== "deploy") {
      ui.notifications.info("Deployment is only available during the Deploy phase.");
      return;
    }

    const actorId = event.currentTarget.dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;

    // Check ownership
    if (!game.user.isGM && !actor.isOwner) {
      ui.notifications.warn("You don't have permission to deploy this unit.");
      return;
    }

    // Build menu options
    const menuItems = [
      { label: "Deploy", icon: "fas fa-parachute-box", mode: "standard" }
    ];

    if (actor.hasTrait("Meteoric Assault")) {
      menuItems.push({ label: "Meteoric Assault", icon: "fas fa-meteor", mode: "meteoric_assault" });
    }
    if (actor.hasTrait("Air Assault")) {
      menuItems.push({ label: "Air Assault", icon: "fas fa-helicopter", mode: "air_assault" });
    }
    if (actor.hasTrait("Air Drop")) {
      menuItems.push({ label: "Air Drop", icon: "fas fa-parachute-box", mode: "air_drop" });
    }

    this._showContextMenu(event.clientX, event.clientY, actorId, menuItems);
  }

  /**
   * Render and position a context menu.
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {string} actorId
   * @param {Array} menuItems
   */
  _showContextMenu(x, y, actorId, menuItems) {
    // Remove any existing context menu
    document.querySelector(".deploy-context-menu")?.remove();

    const menu = document.createElement("div");
    menu.classList.add("deploy-context-menu");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    for (const item of menuItems) {
      const el = document.createElement("div");
      el.classList.add("menu-item");
      el.innerHTML = `<i class="${item.icon}"></i> <span>${item.label}</span>`;
      el.addEventListener("click", () => {
        menu.remove();
        this._startDeploy(actorId, item.mode);
      });
      menu.appendChild(el);
    }

    document.body.appendChild(menu);

    // Close menu on outside click
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);
  }

  /* ---------------------------------------- */
  /*  Deploy Execution                        */
  /* ---------------------------------------- */

  /**
   * Begin the deploy placement flow.
   * @param {string} actorId
   * @param {string} mode - "standard", "meteoric_assault", "air_assault", "air_drop"
   */
  async _startDeploy(actorId, mode) {
    const team = this._viewedTeam ?? "a";

    // Calculate valid hexes
    const standardHexes = getDeployableHexes(team);
    let specialHexes = new Map();

    if (mode !== "standard") {
      specialHexes = getSpecialDeployHexes(team);
    }

    if (standardHexes.size === 0 && specialHexes.size === 0) {
      ui.notifications.warn("No valid deployment hexes available.");
      return;
    }

    // Draw overlay
    this._drawDeployOverlay(standardHexes, specialHexes);

    // Notify user
    ui.notifications.info("Click a highlighted hex to deploy the unit. Press Escape to cancel.");

    // Register canvas click handler
    this._deployClickHandler = async (event) => {
      // Get click position on canvas
      const pos = event.getLocalPosition?.(canvas.stage)
        ?? event.data?.getLocalPosition?.(canvas.stage)
        ?? canvas.stage.toLocal(event.global);

      const snapped = snapToHexCenter(pos);

      if (!isValidDeployHex(snapped, team, mode)) {
        ui.notifications.warn("Invalid deployment hex.");
        return;
      }

      // Execute deployment
      this._clearDeployOverlay();
      canvas.stage.off("pointerdown", this._deployClickHandler);
      document.removeEventListener("keydown", this._deployCancelHandler);
      this._deployClickHandler = null;
      this._deployCancelHandler = null;

      await this._executeDeploy(actorId, snapped, team, mode);
    };

    // Register Escape cancel handler
    this._deployCancelHandler = (event) => {
      if (event.key === "Escape") {
        this._clearDeployOverlay();
        canvas.stage.off("pointerdown", this._deployClickHandler);
        document.removeEventListener("keydown", this._deployCancelHandler);
        this._deployClickHandler = null;
        this._deployCancelHandler = null;
        ui.notifications.info("Deployment cancelled.");
      }
    };

    canvas.stage.on("pointerdown", this._deployClickHandler);
    document.addEventListener("keydown", this._deployCancelHandler);
  }

  /**
   * Execute the deployment: create token, apply effects, remove from pool.
   * @param {string} actorId
   * @param {{x: number, y: number}} hexCenter
   * @param {string} team
   * @param {string} mode
   */
  async _executeDeploy(actorId, hexCenter, team, mode) {
    const actor = game.actors.get(actorId);
    if (!actor) return;

    // Create token from prototype
    const protoToken = actor.prototypeToken;
    const gridSize = canvas.grid.size || 100;
    const tokenW = (protoToken.width ?? 1) * gridSize;
    const tokenH = (protoToken.height ?? 1) * gridSize;
    const tokenPosition = {
      x: hexCenter.x - tokenW / 2,
      y: hexCenter.y - tokenH / 2
    };

    const tokenData = foundry.utils.mergeObject(protoToken.toObject(), {
      actorId: actor.id,
      x: tokenPosition.x,
      y: tokenPosition.y
    });

    // GM creates token directly; players relay via socket
    if (game.user.isGM) {
      const created = await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
      const tokenDoc = created[0];

      // Add combatant if combat is active
      if (game.combat?.started) {
        await game.combat.createEmbeddedDocuments("Combatant", [{
          actorId: actor.id,
          tokenId: tokenDoc.id,
          sceneId: canvas.scene.id
        }]);
      }

      // Apply deploy effects
      await this._applyDeployEffects(actor, tokenDoc, mode);

      // Remove from pool
      await this._removeFromPool(actorId, team);
    } else {
      // Non-GM: relay via socket
      game.socket.emit("system.star-mercs", {
        action: "deploy",
        op: "place",
        actorId,
        sceneId: canvas.scene.id,
        x: tokenPosition.x,
        y: tokenPosition.y,
        team,
        mode
      });
    }

    this.render();
  }

  /**
   * Apply mode-specific temporary effects to a deployed unit.
   * Effects are stored as actor flags and cleared during consolidation.
   * @param {Actor} actor
   * @param {TokenDocument} tokenDoc
   * @param {string} mode
   */
  async _applyDeployEffects(actor, tokenDoc, mode) {
    const updates = {};

    switch (mode) {
      case "meteoric_assault":
        updates["flags.star-mercs.deploySignatureBonus"] = 2;
        updates["flags.star-mercs.deployShockBonus"] = 3;
        updates["flags.star-mercs.deployMode"] = "meteoric_assault";
        break;

      case "air_drop":
        updates["flags.star-mercs.deployShockBonus"] = 1;
        updates["flags.star-mercs.deployMode"] = "air_drop";
        break;

      case "air_assault":
        updates["flags.star-mercs.deploySignatureBonus"] = 5;
        updates["flags.star-mercs.deployShockBonus"] = 2;
        updates["flags.star-mercs.deployAntiAirVulnerable"] = true;
        updates["flags.star-mercs.deployMode"] = "air_assault";
        // Immediate -1 readiness
        const currentReadiness = actor.system.readiness?.value ?? 10;
        updates["system.readiness.value"] = Math.max(0, currentReadiness - 1);
        break;
    }

    if (Object.keys(updates).length > 0) {
      await actor.update(updates);
    }
  }

  /**
   * Remove an actor from the deploy pool (after successful deployment).
   * @param {string} actorId
   * @param {string} team
   */
  async _removeFromPool(actorId, team) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    if (!pool[team]) return;
    pool[team] = pool[team].filter(e => e.actorId !== actorId);
    await game.settings.set("star-mercs", "deployPool", pool);
  }

  /* ---------------------------------------- */
  /*  Canvas Deploy Overlay                   */
  /* ---------------------------------------- */

  /**
   * Draw hex highlights on the canvas showing valid deployment hexes.
   * @param {Map<string, {x: number, y: number}>} standardHexes - Green hexes (HQ radius)
   * @param {Map<string, {x: number, y: number}>} specialHexes - Orange hexes (spotter range)
   */
  _drawDeployOverlay(standardHexes, specialHexes) {
    this._clearDeployOverlay();

    const overlay = new PIXI.Graphics();
    const gridSize = canvas.grid.size || 100;
    const hexRadius = gridSize / 2;

    // Draw standard deploy hexes (green)
    for (const [, hex] of standardHexes) {
      this._drawHexHighlight(overlay, hex, 0x44DD44, 0.2);
    }

    // Draw special deploy hexes (orange)
    for (const [, hex] of specialHexes) {
      this._drawHexHighlight(overlay, hex, 0xFF8800, 0.15);
    }

    canvas.interface.addChild(overlay);
    this._deployOverlay = overlay;
  }

  /**
   * Draw a single highlighted hex.
   * @param {PIXI.Graphics} graphics
   * @param {{x: number, y: number}} center
   * @param {number} color
   * @param {number} alpha
   */
  _drawHexHighlight(graphics, center, color, alpha) {
    const vertices = canvas.grid.getVertices(center);
    if (!vertices || vertices.length === 0) return;

    graphics.beginFill(color, alpha);
    graphics.lineStyle(2, color, 0.6);
    graphics.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      graphics.lineTo(vertices[i].x, vertices[i].y);
    }
    graphics.closePath();
    graphics.endFill();
  }

  /**
   * Remove the deploy overlay from the canvas.
   */
  _clearDeployOverlay() {
    if (this._deployOverlay) {
      this._deployOverlay.destroy({ children: true });
      this._deployOverlay = null;
    }
  }

  /** @override */
  async close(options) {
    this._clearDeployOverlay();
    if (this._deployClickHandler) {
      canvas.stage?.off("pointerdown", this._deployClickHandler);
      this._deployClickHandler = null;
    }
    if (this._deployCancelHandler) {
      document.removeEventListener("keydown", this._deployCancelHandler);
      this._deployCancelHandler = null;
    }
    return super.close(options);
  }
}
