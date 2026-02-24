import { snapToHexCenter, hexKey } from "../hex-utils.mjs";

/**
 * Terrain Painter — a floating panel that lets the GM paint terrain types onto hex cells.
 * When active, left-click a hex to assign the selected terrain type,
 * right-click to erase terrain from that hex.
 *
 * Terrain data is stored in the scene flag `star-mercs.terrainMap`.
 */
export default class TerrainPainter extends FormApplication {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "star-mercs-terrain-painter",
      title: "Terrain Painter",
      template: "systems/star-mercs/templates/apps/terrain-painter.hbs",
      classes: ["star-mercs", "terrain-painter"],
      width: 240,
      height: "auto",
      popOut: true,
      resizable: false,
      closeOnSubmit: false,
      submitOnChange: true
    });
  }

  constructor(...args) {
    super(...args);
    this._selectedTerrain = "plain";
    this._active = false;
    this._canvasClickHandler = null;
    this._canvasContextHandler = null;
  }

  /** @override */
  getData() {
    const terrainChoices = {};
    for (const [key, config] of Object.entries(CONFIG.STARMERCS.terrain)) {
      terrainChoices[key] = config.label;
    }
    return {
      terrainChoices,
      selectedTerrain: this._selectedTerrain,
      isActive: this._active
    };
  }

  /** @override */
  async _updateObject(event, formData) {
    if (formData.selectedTerrain) {
      this._selectedTerrain = formData.selectedTerrain;
    }
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find(".toggle-painting").on("click", () => {
      this._active = !this._active;
      if (this._active) {
        this._startPainting();
      } else {
        this._stopPainting();
      }
      this.render(false);
    });

    html.find(".clear-all-terrain").on("click", async () => {
      const confirm = await Dialog.confirm({
        title: "Clear All Terrain",
        content: "<p>Remove all terrain from this scene?</p>"
      });
      if (confirm) {
        await canvas.scene.unsetFlag("star-mercs", "terrainMap");
        game.starmercs?.terrainLayer?.drawTerrain();
      }
    });
  }

  /**
   * Activate painting mode: register canvas click handlers.
   * @private
   */
  _startPainting() {
    if (this._canvasClickHandler) return;

    this._canvasClickHandler = async (event) => {
      if (!this._active) return;
      const pos = event.data?.getLocalPosition(canvas.stage);
      if (!pos) return;
      const center = snapToHexCenter(pos);
      const key = hexKey(center);

      const terrainMap = foundry.utils.deepClone(
        canvas.scene.getFlag("star-mercs", "terrainMap") ?? {}
      );
      terrainMap[key] = this._selectedTerrain;
      await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
      game.starmercs?.terrainLayer?.drawTerrain();
    };

    this._canvasContextHandler = async (event) => {
      if (!this._active) return;
      event.preventDefault?.();
      const pos = event.data?.getLocalPosition(canvas.stage);
      if (!pos) return;
      const center = snapToHexCenter(pos);
      const key = hexKey(center);

      const terrainMap = foundry.utils.deepClone(
        canvas.scene.getFlag("star-mercs", "terrainMap") ?? {}
      );
      delete terrainMap[key];
      await canvas.scene.setFlag("star-mercs", "terrainMap", terrainMap);
      game.starmercs?.terrainLayer?.drawTerrain();
    };

    canvas.stage.on("pointerdown", this._canvasClickHandler);
    canvas.stage.on("rightdown", this._canvasContextHandler);
    ui.notifications.info("Terrain Painter active: left-click to paint, right-click to erase.");
  }

  /**
   * Deactivate painting mode: remove canvas click handlers.
   * @private
   */
  _stopPainting() {
    if (this._canvasClickHandler) {
      canvas.stage.off("pointerdown", this._canvasClickHandler);
      this._canvasClickHandler = null;
    }
    if (this._canvasContextHandler) {
      canvas.stage.off("rightdown", this._canvasContextHandler);
      this._canvasContextHandler = null;
    }
    ui.notifications.info("Terrain Painter deactivated.");
  }

  /** @override */
  async close(options) {
    this._stopPainting();
    return super.close(options);
  }
}
