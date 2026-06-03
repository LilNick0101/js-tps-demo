# Mode Extension Points

This document describes how to add new game modes without branching ad hoc logic across systems.

## Current architecture

The active mode flow is centralized in:

- `shared/config/modes.json`
- `server/systems/MatchSystem.js`
- `server/systems/TeamSystem.js`
- `server/GameState.js`
- `server/systems/DamageSystem.js`

## Source of truth for mode config

`shared/config/modes.json` is the canonical mode catalog.

Required fields for each mode entry:

- `active` (optional): set `false` for inactive/planned modes.
- `teamBased`: boolean.
- `teamCount`: integer, at least `2` for team modes.
- `winCondition`: object.
- `friendlyFire`: boolean.
- `postMatchRestartMs`: positive integer.

`winCondition` schema:

- `type`: one of `teamKills`, `timeLimit`, `objective`.
- `target`: positive integer for `teamKills` (optional for others).
- `durationMs`: positive integer for `timeLimit`.

## Match flow hooks

`MatchSystem` owns mode-agnostic state and transitions:

- `registerKill(killerEid, victimEid)`
- `checkWin()`
- `beginPostMatch(winnerTeam, reason)`
- `resetMatch()`
- `update()`

`GameState` integrates match transitions and events:

- emits `matchStarted`, `matchEnded`, `matchReset`
- broadcasts top-level `match` payload in state snapshots

`DamageSystem` is responsible for combat-side scoring hook:

- blocks friendly fire when mode config says so
- calls `gameState.registerKill(killerEid, victimEid)` on valid deaths

## How to add a new mode

1. Add a mode entry in `shared/config/modes.json`.
2. Implement/extend win logic in `MatchSystem.checkWin()` for the new `winCondition.type`.
3. Keep team assignment logic in `TeamSystem` (do not duplicate in other systems).
4. If extra scoring events are needed, route them through `MatchSystem` APIs instead of mutating scores directly.
5. Expose any additional match fields in the `match` snapshot and update client HUD consumption.

## Guardrails

`MatchSystem` validates mode config and logs warnings for:

- unknown mode key
- missing mode config
- invalid `teamCount`
- invalid `winCondition`
- invalid `postMatchRestartMs`

On invalid config, safe defaults are applied so the server can continue running.
