import { snapToHexCenter, hexKey, getStructureAtHex } from "../hex-utils.mjs";
import { esc } from "../helpers.mjs";

/**
 * PIXI.Container that renders constructable structures on the canvas.
 *
 * Structures are stored in scene flag `star-mercs.structures` as an array.
 * Visibility rules:
 *   - Minefields with hidden=true and revealed=false: owning team + GM only
 *   - All other structures: visible to all
 *
 * Added to canvas.interface during the canvasReady hook.
 */
export default class StructureLayer extends PIXI.Container {

  constructor() {
    super();

    /** @type {PIXI.Container} — holds individual structure groups */
    this.structureContainer = new PIXI.Container();
    this.addChild(this.structureContainer);

    /** @type {boolean} — flag to suppress browser context menu after right-click */
    this._suppressContextMenu = false;

    this._contextMenuHandler = (e) => {
      if (this._suppressContextMenu) {
        e.preventDefault();
        this._suppressContextMenu = false;
      }
    };
    document.addEventListener("contextmenu", this._contextMenuHandler, true);

    // Right-click handler on canvas.stage
    this._onCanvasRightDown = this._handleCanvasRightDown.bind(this);
  }

  /* ---------------------------------------- */
  /*  Constants                               */
  /* ---------------------------------------- */

  static ICON_RADIUS = 14;
  static BG_ALPHA = 0.7;
  static BORDER_WIDTH = 2;
  static ICON_FONT_SIZE = 14;
  static LABEL_FONT_SIZE = 8;
  static LABEL_OFFSET_Y = 18;
  static HEALTH_BAR_WIDTH = 24;
  static HEALTH_BAR_HEIGHT = 3;
  static HEALTH_BAR_OFFSET_Y = 26;
  static HIT_RADIUS = 20;

  /** Team color map */
  static TEAM_COLORS = {
    a: 0x3399FF,
    b: 0xFF3333,
    none: 0x999999
  };

  /* ---------------------------------------- */
  /*  Public API                              */
  /* ---------------------------------------- */

  /**
   * Clear and redraw all structures for the current viewer.
   */
  drawStructures() {
    this.structureContainer.removeChildren();

    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    if (!structures.length) return;

    const isGM = game.user.isGM;
    const myTeam = this._getViewerTeam();

    for (const structure of structures) {
      // Hidden minefields: only visible to owning team + GM
      if (structure.type === "minefield" && !structure.revealed) {
        if (!isGM && structure.team !== myTeam) continue;
      }
      this._drawSingleStructure(structure, isGM);
    }
  }

  /**
   * Register canvas.stage right-click handler. Called after the layer is added to canvas.
   */
  activateListeners() {
    canvas.stage.on("rightdown", this._onCanvasRightDown);
  }

  /* ---------------------------------------- */
  /*  Static Helpers                          */
  /* ---------------------------------------- */

  /**
   * Create a new structure.
   * Players relay through GM via socket; GM writes directly.
   * @param {object} data - Structure data
   * @returns {Promise<void>}
   */
  static async createStructure(data) {
    if (!canvas.scene) return;
    if (game.user.isGM) {
      const existing = canvas.scene.getFlag("star-mercs", "structures") ?? [];
      const structure = { id: foundry.utils.randomID(), ...data };
      existing.push(structure);
      await canvas.scene.setFlag("star-mercs", "structures", existing);
    } else {
      game.socket.emit("system.star-mercs", {
        action: "structure", op: "create", data, sceneId: canvas.scene.id
      });
    }
  }

  /**
   * Update a structure by ID.
   * @param {string} structureId - The structure ID.
   * @param {object} changes - Key-value changes to merge.
   * @returns {Promise<void>}
   */
  static async updateStructure(structureId, changes) {
    if (!canvas.scene) return;
    if (game.user.isGM) {
      const existing = canvas.scene.getFlag("star-mercs", "structures") ?? [];
      const idx = existing.findIndex(s => s.id === structureId);
      if (idx !== -1) {
        Object.assign(existing[idx], changes);
        await canvas.scene.setFlag("star-mercs", "structures", existing);
      }
    } else {
      // Include requesting team for server-side validation
      const existing = canvas.scene.getFlag("star-mercs", "structures") ?? [];
      const structure = existing.find(s => s.id === structureId);
      const team = structure?.team ?? null;
      game.socket.emit("system.star-mercs", {
        action: "structure", op: "update", structureId, changes, team, sceneId: canvas.scene.id
      });
    }
  }

  /**
   * Remove a structure by ID.
   * @param {string} structureId - The structure ID to remove.
   * @returns {Promise<void>}
   */
  static async removeStructure(structureId) {
    if (!canvas.scene) return;
    if (game.user.isGM) {
      const existing = canvas.scene.getFlag("star-mercs", "structures") ?? [];
      const updated = existing.filter(s => s.id !== structureId);
      if (updated.length === 0) {
        await canvas.scene.unsetFlag("star-mercs", "structures");
      } else {
        await canvas.scene.setFlag("star-mercs", "structures", updated);
      }
    } else {
      game.socket.emit("system.star-mercs", {
        action: "structure", op: "remove", structureId, sceneId: canvas.scene.id
      });
    }
  }

  /**
   * Get the effective config for a structure type, merging GM overrides.
   * @param {string} type - Structure type key.
   * @returns {object} Merged config.
   */
  static getStructureConfig(type) {
    const base = CONFIG.STARMERCS.structures[type];
    if (!base) return null;
    const overrides = game.settings.get("star-mercs", "structureOverrides")?.[type] ?? {};
    return foundry.utils.mergeObject(foundry.utils.deepClone(base), overrides);
  }

  /* ---------------------------------------- */
  /*  Internal Drawing                        */
  /* ---------------------------------------- */

  /**
   * Draw a single structure on the canvas.
   * @param {object} structure - The structure data object.
   * @param {boolean} isGM - Whether the viewer is GM.
   * @private
   */
  _drawSingleStructure(structure, isGM) {
    const config = CONFIG.STARMERCS.structures[structure.type];
    if (!config) return;

    const group = new PIXI.Container();
    group.position.set(structure.x, structure.y);

    const isComplete = structure.turnsBuilt >= structure.turnsRequired;
    const teamColor = StructureLayer.TEAM_COLORS[structure.team] ?? 0xCCCCCC;
    const alpha = isComplete ? StructureLayer.BG_ALPHA : 0.4;

    // Background circle
    const bg = new PIXI.Graphics();
    bg.beginFill(config.color ?? 0x888888, alpha);
    bg.lineStyle(StructureLayer.BORDER_WIDTH, teamColor, 1);
    if (!isComplete) {
      // Dashed effect for under-construction: draw partial border
      bg.lineStyle(StructureLayer.BORDER_WIDTH, teamColor, 0.5);
    }
    bg.drawCircle(0, 0, StructureLayer.ICON_RADIUS);
    bg.endFill();
    group.addChild(bg);

    // Icon text (FontAwesome unicode approximation — use label initial as fallback)
    const iconChar = this._getIconChar(structure.type);
    const iconText = new PIXI.Text(iconChar, {
      fontFamily: "Font Awesome 6 Free, Font Awesome 5 Free, FontAwesome, sans-serif",
      fontWeight: "900",
      fontSize: StructureLayer.ICON_FONT_SIZE,
      fill: 0xFFFFFF,
      align: "center"
    });
    iconText.anchor.set(0.5, 0.5);
    group.addChild(iconText);

    // Label below icon
    let labelStr = structure.name ?? config.label;
    if (!isComplete) {
      labelStr += ` (${structure.turnsBuilt}/${structure.turnsRequired})`;
    }
    if (structure.type === "minefield" && structure.subType && !structure.name) {
      const subConfig = config.subTypes?.[structure.subType];
      labelStr = subConfig?.label ?? labelStr;
      if (!isComplete) labelStr += ` (${structure.turnsBuilt}/${structure.turnsRequired})`;
    }
    // Truncate to prevent overflow into adjacent hexes
    if (labelStr.length > 14) labelStr = labelStr.slice(0, 13) + "\u2026";

    const label = new PIXI.Text(labelStr, {
      fontFamily: "Roboto, Segoe UI, sans-serif",
      fontSize: StructureLayer.LABEL_FONT_SIZE,
      fill: 0xFFFFFF,
      stroke: 0x000000,
      strokeThickness: 2,
      align: "center"
    });
    label.anchor.set(0.5, 0);
    label.position.set(0, StructureLayer.LABEL_OFFSET_Y);
    group.addChild(label);

    // Health bar (show if damaged or for minefields show strength)
    if (isComplete) {
      const showHealth = structure.strength < structure.maxStrength || structure.type === "minefield";
      if (showHealth) {
        this._drawHealthBar(group, structure.strength, structure.maxStrength);
      }
    }

    // Team indicator — visible to all users
    const teamStr = structure.team === "none" ? "Neutral" : `Team ${(structure.team ?? "none").toUpperCase()}`;
    const teamLabel = new PIXI.Text(teamStr, {
      fontFamily: "Roboto, Segoe UI, sans-serif",
      fontSize: 8,
      fill: teamColor,
      stroke: 0x000000,
      strokeThickness: 2,
      align: "center"
    });
    teamLabel.anchor.set(0.5, 1);
    teamLabel.position.set(0, -StructureLayer.ICON_RADIUS - 2);
    group.addChild(teamLabel);

    this.structureContainer.addChild(group);
  }

  /**
   * Draw a health/strength bar below the structure icon.
   * @param {PIXI.Container} group - Parent container.
   * @param {number} current - Current strength.
   * @param {number} max - Maximum strength.
   * @private
   */
  _drawHealthBar(group, current, max) {
    const bar = new PIXI.Graphics();
    const w = StructureLayer.HEALTH_BAR_WIDTH;
    const h = StructureLayer.HEALTH_BAR_HEIGHT;
    const y = StructureLayer.HEALTH_BAR_OFFSET_Y;

    // Background
    bar.beginFill(0x333333, 0.8);
    bar.drawRect(-w / 2, y, w, h);
    bar.endFill();

    // Fill
    const pct = Math.max(0, Math.min(1, current / max));
    const fillColor = pct > 0.5 ? 0x44AA44 : pct > 0.25 ? 0xAAAA22 : 0xAA2222;
    bar.beginFill(fillColor, 0.9);
    bar.drawRect(-w / 2, y, w * pct, h);
    bar.endFill();

    group.addChild(bar);
  }

  /**
   * Get a unicode character to represent the structure type.
   * @param {string} type - Structure type key.
   * @returns {string}
   * @private
   */
  _getIconChar(type) {
    switch (type) {
      case "bridge": return "\u2229";          // ∩ (arch shape)
      case "minefield": return "\u2739";       // ✹ (starburst)
      case "outpost": return "\u2302";         // ⌂ (house)
      case "fortification": return "\u2591";    // ░ (shield-like)
      default: return "?";
    }
  }

  /* ---------------------------------------- */
  /*  Right-Click Handling                    */
  /* ---------------------------------------- */

  /**
   * Handle right-click on canvas.stage — check if any structure was hit.
   * @param {FederatedPointerEvent} event
   * @private
   */
  _handleCanvasRightDown(event) {
    const pos = event.getLocalPosition?.(canvas.stage)
      ?? event.data?.getLocalPosition(canvas.stage)
      ?? canvas.stage.toLocal(event.global);
    if (!pos) return;

    const structures = canvas.scene?.getFlag("star-mercs", "structures") ?? [];
    if (!structures.length) return;

    const isGM = game.user.isGM;
    const myTeam = this._getViewerTeam();
    const hitRadius = StructureLayer.HIT_RADIUS;

    for (const structure of structures) {
      // Hidden minefields only clickable by owning team / GM
      if (structure.type === "minefield" && !structure.revealed) {
        if (!isGM && structure.team !== myTeam) continue;
      }

      const dx = pos.x - structure.x;
      const dy = pos.y - structure.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        this._suppressContextMenu = true;
        this._showStructureContextMenu(structure, pos);
        return;
      }
    }
  }

  /**
   * Show a context menu for a structure (inspect, attack, etc.).
   * @param {object} structure - The clicked structure.
   * @param {{x: number, y: number}} pos - Click position.
   * @private
   */
  _showStructureContextMenu(structure, pos) {
    const config = CONFIG.STARMERCS.structures[structure.type];
    if (!config) return;

    const displayName = structure.name ?? config.label;
    const isComplete = structure.turnsBuilt >= structure.turnsRequired;
    const isGM = game.user.isGM;
    const myTeam = this._getViewerTeam();
    const isEnemy = structure.team !== myTeam;
    const isFriendly = !isEnemy && myTeam;

    // Build info HTML
    let statusText = isComplete ? "Complete" : `Under Construction (${structure.turnsBuilt}/${structure.turnsRequired})`;
    let healthText = `Strength: ${structure.strength}/${structure.maxStrength}`;
    if (structure.type === "minefield" && structure.subType) {
      const sub = config.subTypes?.[structure.subType];
      healthText += ` | Type: ${sub?.label ?? structure.subType}`;
    }

    const content = `<div class="star-mercs sm-dialog structure-inspect">
      <h3>${esc(displayName)}</h3>
      <p><strong>Team:</strong> ${structure.team === "none" ? "Neutral" : "Team " + (structure.team ?? "none").toUpperCase()}</p>
      <p><strong>Status:</strong> ${statusText}</p>
      <p><strong>${healthText}</strong></p>
      <p><em>${esc(config.description)}</em></p>
    </div>`;

    // Build dialog buttons
    const buttons = {
      close: { icon: '<i class="fas fa-times"></i>', label: "Close" }
    };

    // Attack button for enemy structures (or GM attacking any structure)
    if (isGM || (isEnemy && myTeam)) {
      const myUnits = this._getPlayerUnitsInRange(structure);
      if (myUnits.length > 0) {
        buttons.attack = {
          icon: '<i class="fas fa-crosshairs"></i>',
          label: "Attack Structure",
          callback: () => this._openStructureAttackDialog(structure, myUnits)
        };
      }
    }

    // Rename button — GM or owning-team player
    if (isGM || isFriendly) {
      buttons.rename = {
        icon: '<i class="fas fa-pen"></i>',
        label: "Rename",
        callback: () => this._openRenameDialog(structure)
      };
    }

    // Edit Properties button — GM only
    if (isGM) {
      buttons.edit = {
        icon: '<i class="fas fa-edit"></i>',
        label: "Edit Properties",
        callback: () => this._openStructureEditDialog(structure)
      };
    }

    // Delete button — GM only
    if (isGM) {
      buttons.delete = {
        icon: '<i class="fas fa-trash"></i>',
        label: "Delete",
        callback: async () => {
          const confirmed = await Dialog.confirm({
            title: "Delete Structure",
            content: `<p>Delete <strong>${esc(displayName)}</strong>?</p>`,
            defaultYes: false
          });
          if (!confirmed) return;

          // Clean up bridge terrain flag if deleting a bridge
          if (structure.type === "bridge" && structure.hexKey) {
            const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap") ?? {};
            if (terrainMap[structure.hexKey]) {
              const hexData = typeof terrainMap[structure.hexKey] === "string"
                ? { type: terrainMap[structure.hexKey], elevation: 0 }
                : { ...terrainMap[structure.hexKey] };
              delete hexData.bridge;
              terrainMap[structure.hexKey] = hexData;
              await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
            }
          }

          await StructureLayer.removeStructure(structure.id);
          game.starmercs?.structureLayer?.drawStructures();
          ui.notifications.info(`${displayName} deleted.`);
        }
      };
    }

    // Outpost supply buttons — completed friendly outposts
    if (structure.type === "outpost" && isComplete && (isGM || isFriendly)) {
      const autoLabel = structure.autoSupply === false ? "Enable Auto-Supply" : "Disable Auto-Supply";
      buttons.toggleSupply = {
        icon: '<i class="fas fa-toggle-on"></i>',
        label: autoLabel,
        callback: () => {
          const newVal = structure.autoSupply === false ? true : false;
          StructureLayer.updateStructure(structure.id, { autoSupply: newVal });
          ui.notifications.info(`Auto-supply ${newVal ? "enabled" : "disabled"}.`);
        }
      };
      // Manual transfer — only during Preparation phase
      const phase = game.combat?.getFlag?.("star-mercs", "phase") ?? null;
      if (phase === "preparation" || !game.combat?.started) {
        buttons.transfer = {
          icon: '<i class="fas fa-exchange-alt"></i>',
          label: "Transfer Supply",
          callback: () => this._openOutpostSupplyTransfer(structure)
        };
      }
    }

    new Dialog({
      title: `${displayName} — Inspect`,
      content,
      buttons,
      default: "close"
    }).render(true);
  }

  /**
   * Open a rename dialog for a structure.
   * @param {object} structure - The structure to rename.
   * @private
   */
  _openRenameDialog(structure) {
    const config = CONFIG.STARMERCS.structures[structure.type];
    const currentName = structure.name ?? "";
    new Dialog({
      title: "Rename Structure",
      content: `<div class="star-mercs sm-dialog"><form><div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${esc(currentName)}" placeholder="${esc(config?.label ?? "")}" maxlength="24" autofocus />
      </div></form></div>`,
      buttons: {
        save: {
          icon: '<i class="fas fa-check"></i>',
          label: "Save",
          callback: (html) => {
            const el = html instanceof HTMLElement ? html : html[0] ?? html;
            const name = el.querySelector('[name="name"]').value.trim() || null;
            StructureLayer.updateStructure(structure.id, { name });
          }
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
      },
      default: "save"
    }).render(true);
  }

  /**
   * Open the GM edit-properties dialog for a structure.
   * @param {object} structure - The structure to edit.
   * @private
   */
  _openStructureEditDialog(structure) {
    const config = CONFIG.STARMERCS.structures[structure.type];
    if (!config) return;
    const merged = StructureLayer.getStructureConfig(structure.type);
    const isOutpost = structure.type === "outpost";
    const supplyCats = ["smallArms", "heavyWeapons", "ordnance", "fuel", "materials", "parts", "basicSupplies"];
    const supplyLabels = {
      smallArms: "S.Arms", heavyWeapons: "H.Wpns", ordnance: "Ord",
      fuel: "Fuel", materials: "Mats", parts: "Parts", basicSupplies: "Basic"
    };

    let supplyHtml = "";
    if (isOutpost && structure.supply) {
      supplyHtml = `<hr><h4>Supply (Current / Max)</h4><div class="sm-supply-grid">`;
      for (const cat of supplyCats) {
        const cur = structure.supply[cat]?.current ?? 0;
        const cap = structure.supply[cat]?.capacity ?? 0;
        supplyHtml += `<div class="form-group">
          <label>${supplyLabels[cat]}</label>
          <input type="number" name="supply-${cat}" value="${cur}" min="0" max="${cap}" />
          <span class="hint">/</span>
          <input type="number" name="supply-cap-${cat}" value="${cap}" min="0" />
        </div>`;
      }
      supplyHtml += `</div>`;
    }

    const content = `<div class="star-mercs sm-dialog"><form>
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${esc(structure.name ?? "")}" placeholder="${esc(config.label)}" maxlength="24" />
      </div>
      <div class="sm-stats-row">
        <div class="form-group">
          <label>STR</label>
          <input type="number" name="strength" value="${structure.strength}" min="0" max="${structure.maxStrength}" />
          <span class="hint">/ ${structure.maxStrength}</span>
        </div>
        <div class="form-group">
          <label>Built</label>
          <input type="number" name="turnsBuilt" value="${structure.turnsBuilt}" min="0" max="${structure.turnsRequired}" />
          <span class="hint">/ ${structure.turnsRequired}</span>
        </div>
      </div>
      ${supplyHtml}
    </form></div>`;

    new Dialog({
      title: `Edit — ${structure.name ?? config.label}`,
      content,
      buttons: {
        autocomplete: {
          icon: '<i class="fas fa-fast-forward"></i>',
          label: "Auto-Complete",
          callback: () => {
            const changes = {
              turnsBuilt: structure.turnsRequired,
              builderId: null
            };
            StructureLayer.updateStructure(structure.id, changes);
            ui.notifications.info("Structure auto-completed.");
          }
        },
        save: {
          icon: '<i class="fas fa-check"></i>',
          label: "Save",
          callback: (html) => {
            const el = html instanceof HTMLElement ? html : html[0] ?? html;
            const changes = {};
            const nameVal = el.querySelector('[name="name"]').value.trim();
            changes.name = nameVal || null;
            changes.strength = Math.clamped(
              parseInt(el.querySelector('[name="strength"]').value) || 0,
              0, structure.maxStrength
            );
            const newTurns = Math.clamped(
              parseInt(el.querySelector('[name="turnsBuilt"]').value) || 0,
              0, structure.turnsRequired
            );
            changes.turnsBuilt = newTurns;
            // If now complete, clear builderId
            if (newTurns >= structure.turnsRequired) {
              changes.builderId = null;
            }

            if (isOutpost && structure.supply) {
              const supply = foundry.utils.deepClone(structure.supply);
              for (const cat of supplyCats) {
                const newCap = Math.max(
                  parseInt(el.querySelector(`[name="supply-cap-${cat}"]`).value) || 0,
                  0
                );
                supply[cat].capacity = newCap;
                supply[cat].current = Math.clamped(
                  parseInt(el.querySelector(`[name="supply-${cat}"]`).value) || 0,
                  0, newCap
                );
              }
              changes.supply = supply;
            }

            StructureLayer.updateStructure(structure.id, changes);
            ui.notifications.info("Structure properties updated.");
          }
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
      },
      default: "save"
    }).render(true);
  }

  /**
   * Open a bi-directional supply transfer dialog for an outpost.
   * @param {object} structure - The outpost structure.
   * @private
   */
  _openOutpostSupplyTransfer(structure) {
    if (structure.type !== "outpost" || !structure.supply) return;

    const supplyCats = ["smallArms", "heavyWeapons", "ordnance", "fuel", "materials", "parts", "basicSupplies"];
    const supplyLabels = {
      smallArms: "Small Arms", heavyWeapons: "Heavy Weapons", ordnance: "Ordnance",
      fuel: "Fuel", materials: "Materials", parts: "Parts", basicSupplies: "Basic Supplies"
    };
    const gridSize = canvas.grid.size || 100;
    const range = structure.supplyRange ?? 3;

    // Find friendly units within outpost supply range
    const myTeam = structure.team;
    const nearbyUnits = [];
    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.type !== "unit") continue;
      if ((token.actor.system.team ?? "a") !== myTeam) continue;
      const tc = snapToHexCenter(token.center);
      const dx = tc.x - structure.x;
      const dy = tc.y - structure.y;
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy) / gridSize);
      if (dist <= range) {
        nearbyUnits.push({ tokenId: token.id, name: token.name, actor: token.actor, distance: dist });
      }
    }

    if (nearbyUnits.length === 0) {
      ui.notifications.warn("No friendly units within outpost supply range.");
      return;
    }

    const unitOptions = nearbyUnits.map(u =>
      `<option value="${u.tokenId}">${esc(u.name)} (${u.distance} hex${u.distance > 1 ? "es" : ""})</option>`
    ).join("");

    const catInputs = supplyCats.map(cat => {
      const outpostHas = structure.supply[cat]?.current ?? 0;
      return `<div class="form-group">
        <label>${supplyLabels[cat]} (outpost: ${outpostHas})</label>
        <input type="number" data-category="${cat}" value="0" min="0" />
      </div>`;
    }).join("");

    const content = `<div class="star-mercs sm-dialog"><form>
      <div class="form-group">
        <label>Direction</label>
        <select name="direction">
          <option value="toUnit">Outpost \u2192 Unit</option>
          <option value="toOutpost">Unit \u2192 Outpost</option>
        </select>
      </div>
      <div class="form-group">
        <label>Unit</label>
        <select name="unit">${unitOptions}</select>
      </div>
      <hr/><h4>Amounts</h4>
      ${catInputs}
    </form></div>`;

    const displayName = structure.name ?? "Outpost";
    new Dialog({
      title: `Transfer Supply — ${esc(displayName)}`,
      content,
      buttons: {
        transfer: {
          icon: '<i class="fas fa-truck"></i>',
          label: "Transfer",
          callback: async (html) => {
            const el = html instanceof HTMLElement ? html : html[0] ?? html;
            const dir = el.querySelector('[name="direction"]').value;
            const tokenId = el.querySelector('[name="unit"]').value;
            const targetToken = canvas.tokens.get(tokenId);
            if (!targetToken?.actor) return;

            const structures = canvas.scene.getFlag("star-mercs", "structures") ?? [];
            const s = structures.find(st => st.id === structure.id);
            if (!s || !s.supply) return;

            let anyTransferred = false;
            const actorUpdates = {};

            for (const cat of supplyCats) {
              const inputVal = parseInt(el.querySelector(`[data-category="${cat}"]`).value) || 0;
              if (inputVal <= 0) continue;

              const outpostCur = s.supply[cat]?.current ?? 0;
              const outpostCap = s.supply[cat]?.capacity ?? 0;
              const unitCur = targetToken.actor.system.supply?.[cat]?.current ?? 0;
              const unitCap = targetToken.actor.system.supply?.[cat]?.capacity ?? 0;

              if (dir === "toUnit") {
                // Outpost → Unit: clamp by outpost availability and unit remaining capacity
                const actual = Math.min(inputVal, outpostCur, unitCap - unitCur);
                if (actual <= 0) continue;
                s.supply[cat].current -= actual;
                actorUpdates[`system.supply.${cat}.current`] = unitCur + actual;
              } else {
                // Unit → Outpost: clamp by unit availability and outpost remaining capacity
                const actual = Math.min(inputVal, unitCur, outpostCap - outpostCur);
                if (actual <= 0) continue;
                s.supply[cat].current += actual;
                actorUpdates[`system.supply.${cat}.current`] = unitCur - actual;
              }
              anyTransferred = true;
            }

            if (!anyTransferred) {
              ui.notifications.warn("Nothing to transfer.");
              return;
            }

            await targetToken.actor.update(actorUpdates);
            await canvas.scene.setFlag("star-mercs", "structures", structures);
            ui.notifications.info("Supply transferred.");
          }
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
      },
      default: "transfer"
    }).render(true);
  }

  /**
   * Find the current player's units that have weapons in range of a structure.
   * @param {object} structure - The target structure.
   * @returns {Array<{token: Token, weapons: Item[]}>}
   * @private
   */
  _getPlayerUnitsInRange(structure) {
    const results = [];
    const isGM = game.user.isGM;
    const myTeam = this._getViewerTeam();
    const structPos = { x: structure.x, y: structure.y };
    const gridSize = canvas.grid.size || 100;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.type !== "unit") continue;
      if (token.actor.system.strength.value <= 0) continue;

      // Must be player's team (or GM can use any unit)
      const tokenTeam = token.actor.system.team ?? "a";
      if (!isGM && tokenTeam !== myTeam) continue;
      if (tokenTeam === structure.team) continue; // Can't attack own structures

      // Check combat order allows attacks
      if (game.combat?.started) {
        const order = token.actor.system.currentOrder;
        const orderConfig = CONFIG.STARMERCS.orders?.[order];
        if (orderConfig && !orderConfig.allowsAttack) continue;
      }

      const tokenCenter = snapToHexCenter(token.center);
      const dx = tokenCenter.x - structPos.x;
      const dy = tokenCenter.y - structPos.y;
      const hexDist = Math.round(Math.sqrt(dx * dx + dy * dy) / gridSize);

      // Find weapons in range that haven't fired yet
      const firedWeapons = token.document.getFlag("star-mercs", "firedWeapons") ?? [];
      const weapons = token.actor.items.filter(w => {
        if (w.type !== "weapon") return false;
        if (w.system.range < hexDist) return false;
        if (firedWeapons.includes(w.id)) return false;
        return true;
      });

      if (weapons.length > 0) {
        results.push({ token, weapons });
      }
    }
    return results;
  }

  /**
   * Open a dialog to select attacker unit and weapon to fire at a structure.
   * @param {object} structure - The target structure.
   * @param {Array<{token: Token, weapons: Item[]}>} units - Available units with weapons.
   * @private
   */
  _openStructureAttackDialog(structure, units) {
    const sConfig = CONFIG.STARMERCS.structures[structure.type];

    // Build selection HTML
    let optionsHtml = "";
    for (const { token, weapons } of units) {
      for (const weapon of weapons) {
        const label = `${esc(token.name)} — ${esc(weapon.name)} (D${weapon.system.damage}/R${weapon.system.range})`;
        optionsHtml += `<option value="${token.document.id}|${weapon.id}">${label}</option>`;
      }
    }

    const content = `<div class="star-mercs sm-dialog structure-attack">
      <p>Select unit and weapon to attack <strong>${esc(sConfig?.label ?? structure.type)}</strong>
        (Strength: ${structure.strength}/${structure.maxStrength})</p>
      <div class="form-group">
        <label>Attacker / Weapon</label>
        <select name="attackChoice">${optionsHtml}</select>
      </div>
    </div>`;

    new Dialog({
      title: `Attack ${sConfig?.label ?? "Structure"}`,
      content,
      buttons: {
        fire: {
          icon: '<i class="fas fa-crosshairs"></i>',
          label: "Fire",
          callback: (html) => {
            const el = html instanceof HTMLElement ? html : html[0];
            const choice = el.querySelector('[name="attackChoice"]')?.value;
            if (choice) {
              const [tokenId, weaponId] = choice.split("|");
              this._resolveStructureAttack(structure, tokenId, weaponId);
            }
          }
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
      },
      default: "fire"
    }).render(true);
  }

  /**
   * Resolve a weapon attack against a structure.
   * Structures have no defense roll — weapon damage is applied directly to strength.
   * @param {object} structure - The target structure.
   * @param {string} tokenId - Attacker token document ID.
   * @param {string} weaponId - Weapon item ID.
   * @private
   */
  async _resolveStructureAttack(structure, tokenId, weaponId) {
    const token = canvas.tokens.get(tokenId);
    if (!token?.actor) return;

    const weapon = token.actor.items.get(weaponId);
    if (!weapon) return;

    const sConfig = CONFIG.STARMERCS.structures[structure.type];

    // Roll weapon damage
    const damage = weapon.system.damage ?? 1;
    const roll = await new Roll(`${damage}d6`).evaluate();
    const totalDamage = roll.total;

    // Mark weapon as fired
    const firedWeapons = token.document.getFlag("star-mercs", "firedWeapons") ?? [];
    if (!firedWeapons.includes(weaponId)) {
      firedWeapons.push(weaponId);
      await token.document.setFlag("star-mercs", "firedWeapons", firedWeapons);
    }

    // Apply damage to structure strength
    const structures = canvas.scene.getFlag("star-mercs", "structures") ?? [];
    const target = structures.find(s => s.id === structure.id);
    if (!target) return;

    target.strength = Math.max(0, target.strength - totalDamage);
    const destroyed = target.strength <= 0;

    if (destroyed) {
      // Clear bridge terrain flag when bridge is destroyed by attack
      if (structure.type === "bridge" && structure.hexKey) {
        const terrainMap = canvas.scene.getFlag("star-mercs", "terrainMap") ?? {};
        if (terrainMap[structure.hexKey]) {
          const hexData = typeof terrainMap[structure.hexKey] === "string"
            ? { type: terrainMap[structure.hexKey], elevation: 0 }
            : { ...terrainMap[structure.hexKey] };
          delete hexData.bridge;
          terrainMap[structure.hexKey] = hexData;
          await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
        }
      }
      const updated = structures.filter(s => s.id !== structure.id);
      if (updated.length === 0) {
        await canvas.scene.unsetFlag("star-mercs", "structures");
      } else {
        await canvas.scene.setFlag("star-mercs", "structures", updated);
      }
    } else {
      await canvas.scene.setFlag("star-mercs", "structures", structures);
    }

    // Post chat card
    await ChatMessage.create({
      content: `<div class="star-mercs chat-card structure-attack">
        <div class="summary-header"><i class="fas fa-crosshairs"></i> Structure Attack</div>
        <div class="status-update"><strong>${esc(token.name)}</strong> fires <strong>${esc(weapon.name)}</strong>
          at ${esc(sConfig?.label ?? structure.type)}.
          Rolled ${roll.total} → <strong>${totalDamage} damage</strong> dealt.
          ${destroyed
            ? "<strong>Structure destroyed!</strong>"
            : `Structure strength: ${target.strength}/${target.maxStrength}`}</div>
      </div>`,
      speaker: { alias: "Star Mercs" }
    });
  }

  /* ---------------------------------------- */
  /*  Helpers                                 */
  /* ---------------------------------------- */

  /**
   * Get the viewing player's team.
   * @returns {string|null}
   * @private
   */
  _getViewerTeam() {
    const enabled = game.settings.get("star-mercs", "teamAssignmentsEnabled");
    if (!enabled) return null;
    const assignments = game.settings.get("star-mercs", "teamAssignments") ?? {};
    const team = assignments[game.user.id];
    return (team && team !== "spectator") ? team : null;
  }

  /**
   * Clean up event listeners before destroying the layer.
   * @param {object} [options] - PIXI destroy options.
   */
  destroy(options) {
    document.removeEventListener("contextmenu", this._contextMenuHandler, true);
    canvas?.stage?.off("rightdown", this._onCanvasRightDown);
    super.destroy(options);
  }
}
