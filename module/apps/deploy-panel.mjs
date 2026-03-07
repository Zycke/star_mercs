/**
 * Deploy Panel — a per-team floating UI for managing unit deployment.
 *
 * Features:
 * - Shows units waiting in the deploy pool for the viewer's team
 * - GM can switch between teams and add units to the pool
 * - Pool supports multiple instances of the same actor with custom names
 * - Right-click context menu for deployment options:
 *   - Standard deploy during Deploy phase
 *   - Meteoric Assault / Air Drop designation during Orders phase
 * - Designated units land automatically during the Tactical phase
 *
 * Toggled from the token controls menu. Singleton stored on game.starmercs.deployPanel.
 */
import { getDeployableHexes, getSpecialDeployHexes, isValidDeployHex } from "../deploy-utils.mjs";
import { snapToHexCenter, hexKey, hexCenterToTokenPosition,
  getAdjacentHexCenters, getTokensAtHex } from "../hex-utils.mjs";

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

    // Auto-migrate old pool entries that lack instanceId
    let needsMigration = false;
    for (const entry of teamPool) {
      if (!entry.instanceId) {
        entry.instanceId = foundry.utils.randomID();
        entry.customName = entry.customName || null;
        needsMigration = true;
      }
    }
    if (needsMigration) {
      const updatedPool = foundry.utils.deepClone(deployPool);
      updatedPool[viewerTeam] = teamPool;
      await game.settings.set("star-mercs", "deployPool", updatedPool);
    }

    const combat = game.combat;
    const isDeployPhase = combat?.started && combat?.phase === "deploy";
    const isOrdersPhase = combat?.started && combat?.phase === "orders";

    // Get pending deploys from combat flags
    const pendingDeploys = combat?.getFlag("star-mercs", "pendingDeploys") ?? [];

    // Resolve actor data for each pool entry
    const poolEntries = [];
    for (const entry of teamPool) {
      const actor = game.actors.get(entry.actorId);
      if (!actor) continue;

      const specialTraits = [];
      if (actor.hasTrait("Meteoric Assault")) specialTraits.push("Meteoric Assault");
      if (actor.hasTrait("Air Assault")) specialTraits.push("Air Assault");
      if (actor.hasTrait("Air Drop")) specialTraits.push("Air Drop");

      // Check if this entry has a pending deployment
      const pending = pendingDeploys.find(p => p.instanceId === entry.instanceId);

      poolEntries.push({
        actorId: entry.actorId,
        instanceId: entry.instanceId,
        name: entry.customName || actor.name,
        img: actor.img,
        ratingLabel: actor.system.rating?.charAt(0).toUpperCase() + actor.system.rating?.slice(1) ?? "Unknown",
        strength: actor.system.strength?.value ?? 0,
        specialTraits: specialTraits.length > 0 ? specialTraits.join(", ") : null,
        isPending: !!pending,
        pendingMode: pending?.mode ?? null
      });
    }

    return {
      isGM,
      viewedTeam: viewerTeam,
      isDeployPhase,
      isOrdersPhase,
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
        const instanceId = btn.closest(".deploy-entry").dataset.instanceId;
        this._onRemoveUnit(instanceId);
      });
    });

    // Right-click context menu on deploy entries
    html.querySelectorAll(".deploy-entry").forEach(el => {
      el.addEventListener("contextmenu", (event) => this._onEntryContextMenu(event));
    });

    // Double-click to edit name (GM only)
    if (game.user.isGM) {
      html.querySelectorAll(".deploy-entry-name").forEach(el => {
        el.addEventListener("dblclick", (event) => this._onEditName(event));
      });
    }

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
    await this._addToPool(actor.id, team);
  }

  /**
   * Add an actor to the deploy pool for a team.
   * Multiple instances of the same actor are allowed — each gets a unique instanceId.
   * @param {string} actorId
   * @param {string} team
   */
  async _addToPool(actorId, team) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    if (!pool[team]) pool[team] = [];

    const actor = game.actors.get(actorId);
    const customName = actor?.name ?? "Unknown Unit";

    pool[team].push({
      actorId,
      addedBy: game.user.id,
      instanceId: foundry.utils.randomID(),
      customName
    });
    await game.settings.set("star-mercs", "deployPool", pool);
    this.render();
  }

  /**
   * Remove an entry from the deploy pool by instanceId.
   * @param {string} instanceId
   */
  async _onRemoveUnit(instanceId) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    const team = this._viewedTeam ?? "a";
    if (!pool[team]) return;

    pool[team] = pool[team].filter(e => e.instanceId !== instanceId);
    await game.settings.set("star-mercs", "deployPool", pool);

    // Also remove any pending deploy for this instance
    if (game.combat?.started) {
      const pending = game.combat.getFlag("star-mercs", "pendingDeploys") ?? [];
      const filtered = pending.filter(p => p.instanceId !== instanceId);
      if (filtered.length !== pending.length) {
        await game.combat.setFlag("star-mercs", "pendingDeploys", filtered);
      }
    }

    this.render();
  }

  /**
   * Inline-edit a pool entry's custom name on double-click.
   * @param {MouseEvent} event
   */
  _onEditName(event) {
    const nameEl = event.currentTarget;
    const entry = nameEl.closest(".deploy-entry");
    const instanceId = entry.dataset.instanceId;
    const currentName = nameEl.textContent;

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.classList.add("deploy-name-edit");
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const save = async () => {
      const newName = input.value.trim() || currentName;
      await this._updatePoolEntryName(instanceId, newName);
      this.render();
    };

    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = currentName; input.blur(); }
    });
  }

  /**
   * Update the customName of a pool entry.
   * @param {string} instanceId
   * @param {string} newName
   */
  async _updatePoolEntryName(instanceId, newName) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    const team = this._viewedTeam ?? "a";
    const entry = pool[team]?.find(e => e.instanceId === instanceId);
    if (entry) {
      entry.customName = newName;
      await game.settings.set("star-mercs", "deployPool", pool);
    }
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
    const isDeployPhase = combat?.started && combat?.phase === "deploy";
    const isOrdersPhase = combat?.started && combat?.phase === "orders";

    if (!isDeployPhase && !isOrdersPhase) {
      ui.notifications.info("Deployment is available during the Deploy or Orders phase.");
      return;
    }

    const instanceId = event.currentTarget.dataset.instanceId;
    const actorId = event.currentTarget.dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;

    // Check if this entry already has a pending deploy
    const pendingDeploys = combat?.getFlag("star-mercs", "pendingDeploys") ?? [];
    const isPending = pendingDeploys.some(p => p.instanceId === instanceId);

    // Check ownership
    if (!game.user.isGM && !actor.isOwner) {
      ui.notifications.warn("You don't have permission to deploy this unit.");
      return;
    }

    // Build menu options
    const menuItems = [];

    if (isPending) {
      // Already designated — offer cancel
      menuItems.push({ label: "Cancel Designation", icon: "fas fa-times", mode: "cancel_pending" });
    } else if (isDeployPhase) {
      // Deploy phase: standard deploy + air assault (immediate placement)
      menuItems.push({ label: "Deploy", icon: "fas fa-parachute-box", mode: "standard" });
      if (actor.hasTrait("Air Assault")) {
        menuItems.push({ label: "Air Assault", icon: "fas fa-helicopter", mode: "air_assault" });
      }
    } else if (isOrdersPhase) {
      // Orders phase: only meteoric assault and air drop designation
      if (actor.hasTrait("Meteoric Assault")) {
        menuItems.push({ label: "Meteoric Assault", icon: "fas fa-meteor", mode: "meteoric_assault" });
      }
      if (actor.hasTrait("Air Drop")) {
        menuItems.push({ label: "Air Drop", icon: "fas fa-parachute-box", mode: "air_drop" });
      }
    }

    if (menuItems.length === 0) {
      if (isOrdersPhase) {
        ui.notifications.info("This unit has no special deployment traits for the Orders phase.");
      }
      return;
    }

    this._showContextMenu(event.clientX, event.clientY, instanceId, actorId, menuItems);
  }

  /**
   * Render and position a context menu.
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {string} instanceId
   * @param {string} actorId
   * @param {Array} menuItems
   */
  _showContextMenu(x, y, instanceId, actorId, menuItems) {
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
        if (item.mode === "cancel_pending") {
          this._cancelPendingDeploy(instanceId);
        } else {
          this._startDeploy(instanceId, actorId, item.mode);
        }
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
   * @param {string} instanceId - Pool entry instance ID
   * @param {string} actorId
   * @param {string} mode - "standard", "meteoric_assault", "air_assault", "air_drop"
   */
  async _startDeploy(instanceId, actorId, mode) {
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

      // For orders-phase deployment, designate rather than place immediately
      if (mode === "meteoric_assault" || mode === "air_drop") {
        await this._designatePendingDeploy(instanceId, actorId, snapped, team, mode);
      } else {
        await this._executeDeploy(instanceId, actorId, snapped, team, mode);
      }
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
   * Designate a pending deployment (for meteoric assault / air drop during orders phase).
   * The unit is not placed yet — it will land during the appropriate tactical sub-step.
   * @param {string} instanceId
   * @param {string} actorId
   * @param {{x: number, y: number}} hexCenter
   * @param {string} team
   * @param {string} mode
   */
  async _designatePendingDeploy(instanceId, actorId, hexCenter, team, mode) {
    const combat = game.combat;
    if (!combat) return;

    // Get the pool entry's custom name
    const pool = game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] };
    const entry = pool[team]?.find(e => e.instanceId === instanceId);
    const customName = entry?.customName || game.actors.get(actorId)?.name || "Unknown";

    const pendingEntry = {
      instanceId,
      actorId,
      team,
      mode,
      hexKey: hexKey(hexCenter),
      hexCenter: { x: hexCenter.x, y: hexCenter.y },
      customName,
      assaultTargetTokenId: null
    };

    // For meteoric assault, prompt for assault target selection
    if (mode === "meteoric_assault") {
      const targetId = await this._promptAssaultTarget(hexCenter, team, actorId);
      if (targetId) {
        pendingEntry.assaultTargetTokenId = targetId;
      }
    }

    // Store pending deploy on combat
    const pending = foundry.utils.deepClone(combat.getFlag("star-mercs", "pendingDeploys") ?? []);
    pending.push(pendingEntry);
    await combat.setFlag("star-mercs", "pendingDeploys", pending);

    const modeLabel = mode === "meteoric_assault" ? "Meteoric Assault" : "Air Drop";
    ui.notifications.info(`${customName} designated for ${modeLabel} deployment.`);

    this.render();
  }

  /**
   * Prompt the deploying player to select an adjacent hostile unit to assault.
   * @param {{x: number, y: number}} hexCenter - The deployment hex
   * @param {string} team - Deploying team
   * @param {string} actorId - The deploying actor (for movement rule checks)
   * @returns {Promise<string|null>} The selected target token ID, or null
   */
  async _promptAssaultTarget(hexCenter, team, actorId) {
    const adjacentHexes = getAdjacentHexCenters(hexCenter);
    const hostileTokens = [];

    for (const adjHex of adjacentHexes) {
      const tokensHere = getTokensAtHex(adjHex);
      for (const token of tokensHere) {
        if (!token.actor || token.actor.type !== "unit") continue;
        if (token.actor.system.team === team) continue;
        if ((token.actor.system.strength?.value ?? 0) <= 0) continue;
        hostileTokens.push(token);
      }
    }

    if (hostileTokens.length === 0) {
      ui.notifications.info("No adjacent hostile units to assault. Unit will land without an assault target.");
      return null;
    }

    // Build dropdown options
    const options = hostileTokens.map(t =>
      `<option value="${t.document.id}">${t.document.name} (STR ${t.actor.system.strength?.value ?? 0})</option>`
    ).join("");

    const content = `<form><div class="form-group">
      <label>Select Assault Target</label>
      <select name="targetId">
        <option value="">— No Target —</option>
        ${options}
      </select>
    </div></form>`;

    const result = await Dialog.wait({
      title: "Meteoric Assault Target",
      content,
      buttons: {
        confirm: { label: "Confirm", icon: '<i class="fas fa-crosshairs"></i>', callback: (html) => {
          const el = html.querySelector ? html.querySelector("[name=targetId]") : html[0].querySelector("[name=targetId]");
          return el?.value || null;
        }},
        cancel: { label: "Skip" }
      },
      default: "confirm"
    });

    return result || null;
  }

  /**
   * Cancel a pending deployment designation.
   * @param {string} instanceId
   */
  async _cancelPendingDeploy(instanceId) {
    const combat = game.combat;
    if (!combat) return;

    const pending = foundry.utils.deepClone(combat.getFlag("star-mercs", "pendingDeploys") ?? []);
    const filtered = pending.filter(p => p.instanceId !== instanceId);
    await combat.setFlag("star-mercs", "pendingDeploys", filtered);

    ui.notifications.info("Deployment designation cancelled.");
    this.render();
  }

  /**
   * Execute the deployment: create token, apply effects, remove from pool.
   * @param {string} instanceId
   * @param {string} actorId
   * @param {{x: number, y: number}} hexCenter
   * @param {string} team
   * @param {string} mode
   */
  async _executeDeploy(instanceId, actorId, hexCenter, team, mode) {
    const actor = game.actors.get(actorId);
    if (!actor) return;

    // Get the custom name from the pool entry
    const pool = game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] };
    const poolEntry = pool[team]?.find(e => e.instanceId === instanceId);
    const customName = poolEntry?.customName || actor.name;

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
      actorLink: false,
      name: customName,
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
      await this._applyDeployEffects(tokenDoc, mode);

      // Update synthetic actor name to match custom name (unlinked token)
      if (tokenDoc.actor && customName !== actor.name) {
        await tokenDoc.actor.update({ name: customName });
      }

      // Remove from pool
      await this._removeFromPool(instanceId, team);
    } else {
      // Non-GM: relay via socket
      game.socket.emit("system.star-mercs", {
        action: "deploy",
        op: "place",
        actorId,
        instanceId,
        customName,
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
   * Uses the token's synthetic actor for unlinked tokens.
   * @param {TokenDocument} tokenDoc
   * @param {string} mode
   */
  async _applyDeployEffects(tokenDoc, mode) {
    const actor = tokenDoc.actor;
    if (!actor) return;

    if (mode === "meteoric_assault") {
      await actor.toggleStatusEffect("meteoric-assault", { active: true });
    } else if (mode === "air_drop") {
      await actor.toggleStatusEffect("air-drop", { active: true });
    } else if (mode === "air_assault") {
      await actor.toggleStatusEffect("air-assault", { active: true });
    }
  }

  /**
   * Remove a pool entry by instanceId (after successful deployment).
   * @param {string} instanceId
   * @param {string} team
   */
  async _removeFromPool(instanceId, team) {
    const pool = foundry.utils.deepClone(game.settings.get("star-mercs", "deployPool") ?? { a: [], b: [] });
    if (!pool[team]) return;
    pool[team] = pool[team].filter(e => e.instanceId !== instanceId);
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
