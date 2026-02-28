# Implementation Plan: Turn Control Panel + Objective Scoring System

## Overview
Two features: (A) a toggleable Turn Control UI panel for managing combat phases without the GM or combat sidebar tab, and (B) Primary/Secondary Objective hexes with cumulative scoring.

---

## FEATURE A: Turn Control Panel

### A1. New File: `module/apps/turn-control.mjs`

A `FormApplication` (same pattern as `TerrainPainter` and `TeamSettingsForm`) that displays:

- **Current Round & Phase** — e.g. "Round 2 — Orders" with phase-colored styling
- **Tactical sub-step** — when in tactical phase, show which sub-step (e.g. "Artillery Fire")
- **Player Ready Checkmarks** — one row per non-GM, non-spectator player showing:
  - Player name + team color indicator
  - A checkbox. Only clickable by that specific player (disabled for everyone else). Uses **user flags** (`game.user.setFlag("star-mercs", "combatReady", true)`) so each player can only modify their own readiness. No permission issues since every user owns their own User document.
- **Team Scores** — displays cumulative score for each team, read from `combat.flags.star-mercs.teamScores`
- **Next Phase Button** — enabled for any player when ALL non-GM/non-spectator players are ready. Calls `game.combat.nextTurn()` (same method the combat tracker and chat card "Next Step" buttons use). On click, clears all ready flags before advancing. This means during tactical sub-phases, clicking "Next Phase" advances the sub-step, triggering artillery fire, movement, etc. — fully compatible with the existing chat card flow.
- **GM Override Next Button** — only visible to GM. Advances phase regardless of ready state. Also clears ready flags.
- **GM Previous Phase Button** — only visible to GM. Calls `game.combat.previousTurn()` (already exists in combat.mjs).

**Data flow:**
1. Player clicks their Ready checkbox → `game.user.setFlag("star-mercs", "combatReady", true)`
2. `updateUser` hook fires on all clients → panel re-renders
3. Panel checks all relevant users' flags to determine if Next Phase should be enabled
4. Player clicks Next Phase → clears all ready flags (GM can update other users' flags) → calls `combat.nextTurn()`
5. `updateCombat` hook fires → panel re-renders with new phase + cleared checkboxes

**Singleton pattern:** Store the instance on `game.starmercs.turnControlPanel` so the toggle button can show/hide the same instance. Panel re-renders via hooks rather than polling.

### A2. New File: `templates/apps/turn-control.hbs`

Handlebars template rendered by the FormApplication. Structure:

```
┌─────────────────────────────┐
│ ⚔ TURN CONTROL              │
├─────────────────────────────┤
│ Round 2 — Orders            │  ← phase-colored bar
│ Sub-step: Artillery Fire    │  ← only visible during tactical
├─────────────────────────────┤
│ SCORES                      │
│ Team A: 6    Team B: 3      │
├─────────────────────────────┤
│ READY                       │
│ ☐ PlayerName (Team A)       │  ← only this player can check
│ ☑ PlayerName (Team B)       │
├─────────────────────────────┤
│ [◀ Prev Phase]  [Next ▶]   │  ← Prev is GM-only
│ [GM Override ▶]             │  ← GM-only, always enabled
└─────────────────────────────┘
```

### A3. Modify: `star-mercs.mjs` — Scene Control Toggle

Add a new tool to the `getSceneControlButtons` hook:

```js
const turnControlTool = {
  name: "turnControl",
  title: "Turn Control",
  icon: "fas fa-flag-checkered",
  visible: true,   // all players can see it
  toggle: true,
  active: false,
  onChange: (event, active) => {
    if (active) {
      if (!game.starmercs.turnControlPanel) {
        game.starmercs.turnControlPanel = new TurnControlPanel();
      }
      game.starmercs.turnControlPanel.render(true);
    } else {
      game.starmercs.turnControlPanel?.close();
    }
  }
};
```

### A4. Modify: `star-mercs.mjs` — Hooks for Panel Refresh

Add hooks to re-render the panel when relevant state changes:

- `Hooks.on("updateCombat", ...)` → re-render panel (phase changed)
- `Hooks.on("updateUser", ...)` → re-render panel (ready state changed)
- `Hooks.on("combatStart", ...)` → re-render panel
- `Hooks.on("deleteCombat", ...)` → close panel

### A5. Modify: `star-mercs.mjs` — Clear Ready Flags on Phase Advance

In the `updateCombat` hook (or inside the panel's "Next Phase" click handler), when the phase changes, clear all user `combatReady` flags. This is done by the panel's click handler before calling `nextTurn()`, so only the GM client (or the clicking player via `nextTurn()`) executes it.

**Important:** Non-GM users cannot clear other users' flags. So the "Next Phase" button handler should emit a socket event that the GM client listens for. The GM client then:
1. Clears all ready flags
2. Calls `combat.nextTurn()`

Alternatively, the `nextTurn()` method in combat.mjs can be extended to clear ready flags itself (since `nextTurn()` runs on the GM's client as a database update).

**Chosen approach:** Add a hook in `combat.nextTurn()` that clears ready flags. Since combat updates go through the GM, the GM always executes `nextTurn()`. Add a few lines at the top of `nextTurn()`:
```js
// Clear all player ready flags on phase advance
for (const user of game.users) {
  if (user.getFlag("star-mercs", "combatReady")) {
    await user.unsetFlag("star-mercs", "combatReady");
  }
}
```

---

## FEATURE B: Objective Hex System

### B1. Modify: `module/hex-utils.mjs` — Update `normalizeHexData`

Add `objective` field to the normalized hex data structure:

```js
return {
  type: entry.type ?? "plain",
  elevation: entry.elevation ?? 0,
  road: entry.road ?? false,
  objective: entry.objective ?? null  // "primary", "secondary", or null
};
```

### B2. Modify: `module/apps/terrain-painter.mjs` — Add Objective Option

Add `_selectedObjective` state (values: `"none"`, `"primary"`, `"secondary"`).

In `getData()`, add objective choices for the template.

In `_updateObject()`, handle `formData.selectedObjective`.

In `_applyToHex()`, when painting a hex, include the objective property:
```js
this._pendingTerrainMap[key] = {
  type: this._selectedTerrain,
  elevation: this._selectedElevation,
  road: this._selectedRoad,
  objective: this._selectedObjective === "none" ? undefined : this._selectedObjective
};
```

For the "road" brush, preserve existing objective. For erasing, objective is removed with the hex.

### B3. Modify: `templates/apps/terrain-painter.hbs` — Add Objective Selector

Add a form group after the road checkbox:

```hbs
<div class="form-group">
  <label>Objective</label>
  <select name="selectedObjective">
    <option value="none" {{#if (eq selectedObjective "none")}}selected{{/if}}>None</option>
    <option value="primary" {{#if (eq selectedObjective "primary")}}selected{{/if}}>Primary (3 pts)</option>
    <option value="secondary" {{#if (eq selectedObjective "secondary")}}selected{{/if}}>Secondary (1 pt)</option>
  </select>
</div>
```

### B4. Modify: `module/canvas/terrain-layer.mjs` — Render Star Icons

Add a new PIXI.Container child `objectiveContainer` for objective icons.

In `drawTerrain()`, after drawing hex overlays, draw a star icon at each objective hex center:
- **Primary Objective**: Gold star (0xFFD700), larger
- **Secondary Objective**: Silver star (0xC0C0C0), slightly smaller

The star is a 5-pointed polygon drawn with PIXI.Graphics, centered on the hex.

Also draw the star during `drawPaintOverlay()` for live preview while painting.

### B5. Modify: `module/documents/combat.mjs` — Scoring Logic

Add `_scoreObjectives()` method called at the end of `_runConsolidationEffects()`:

```
For each hex in terrainMap with an objective property:
  1. Find token at that hex (using getTokensAtHex)
  2. If no token → skip
  3. Determine team from token.actor.system.team
  4. Base points: primary = 3, secondary = 1
  5. If unit is Engaged (isEngaged(token) returns true): subtract 1 from points
     → Primary + Engaged = 2, Secondary + Engaged = 0
  6. If points > 0: add to team's cumulative score

Store scores in combat flag: flags.star-mercs.teamScores = { a: X, b: Y }
Post a scoring summary chat card.
```

### B6. Modify: `module/config.mjs` — Add Objective Config (Optional)

Add objective display config:
```js
STARMERCS.objectives = {
  primary: { label: "Primary Objective", points: 3, color: 0xFFD700 },
  secondary: { label: "Secondary Objective", points: 1, color: 0xC0C0C0 }
};
```

---

## CSS Additions (`star-mercs.css`)

### Turn Control Panel Styles
- `.star-mercs.turn-control` — dark bg panel matching existing theme
- `.turn-control-phase` — phase display bar (reuse phase colors from combat tracker)
- `.turn-control-scores` — score display section
- `.turn-control-ready` — ready player list
- `.turn-control-ready .ready-row` — individual player row with checkbox
- `.turn-control-actions` — button row for next/prev phase
- `.turn-control-actions button` — styled like existing chat card buttons

### Objective Styles
No CSS needed — objectives are rendered in PIXI, not HTML.

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `module/apps/turn-control.mjs` | **NEW** — FormApplication for turn control panel |
| `templates/apps/turn-control.hbs` | **NEW** — Handlebars template |
| `module/apps/terrain-painter.mjs` | Add `_selectedObjective`, update `_applyToHex()` |
| `templates/apps/terrain-painter.hbs` | Add objective `<select>` |
| `module/canvas/terrain-layer.mjs` | Add `objectiveContainer`, draw star icons |
| `module/documents/combat.mjs` | Add `_scoreObjectives()`, clear ready flags in `nextTurn()` |
| `module/hex-utils.mjs` | Add `objective` to `normalizeHexData()` |
| `module/config.mjs` | Add `STARMERCS.objectives` config |
| `star-mercs.mjs` | Add import, scene control toggle, refresh hooks |
| `star-mercs.css` | Turn control panel styles |
| `system.json` + `CLAUDE.md` | Version bump to 0.0.41 |

---

## Version
Bump from 0.0.40 → 0.0.41
