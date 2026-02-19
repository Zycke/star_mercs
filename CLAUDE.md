# Star Mercs - Foundry VTT Game System

## Project Overview

Star Mercs is a tabletop wargame built as a game system for Foundry VTT. The goal is to create a fully functional Foundry module that supports the Star Mercs ruleset.

## Version

**Current Version: 0.0.18**

- Increment the **patch** number (the last digit) with each update (e.g., 0.0.1 -> 0.0.2 -> 0.0.3).
- Do **not** roll to 0.1.0, 0.2.0, etc. unless explicitly instructed.

## Development References

Always consult the following resources when building and modifying this system:

1. **Context7 Library** - Always reference the Context7 MCP library for up-to-date documentation and code patterns.
2. **Foundry VTT API (v13)** - The official API documentation is the primary technical reference. Always use the **v13** docs (v12 is outdated):
   https://foundryvtt.com/api/index.html
3. **D&D 5e System** - A fully functional Foundry game system that serves as a real-world implementation reference:
   https://github.com/foundryvtt/dnd5e

## Map & Movement

- The game uses a **hex grid** as its map. All map scenes in Foundry should be configured with a hex grid overlay.
- **All movement values, weapon ranges, ability distances, and any other spatial measurements are expressed in number of hexes.**
- All map interactions (token movement, range calculations, area effects, line of sight, etc.) must be designed and implemented with Foundry's hex map overlay in mind.

## Development Guidelines

- **Ask clarifying questions** whenever requirements or implementation details are unclear. Do not assume — confirm first.
- **Roll the version number** with every update. No exceptions.
- Reference the Foundry API docs and the D&D 5e system source code to ensure patterns and conventions align with how Foundry VTT systems are built.
