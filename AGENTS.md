# Repository Instructions

## Project

Lumiverse Party Games is a TypeScript Spindle extension with a browser frontend and a Bun backend. It runs party games (Kings Cup first; Never Have I Ever and Truth or Dare next) inside a Lumiverse chat. Read `PLAN.md` before changing behavior. When a Lumiverse checkout is available, its `developer-docs/` folder is the primary API reference; the `lumiverse-spindle-types` declarations are the source of truth for signatures.

## The rule that shapes everything

**The extension owns all game state; the model only narrates.** Turn order, the active player, the phase, the deck, draws, eliminations, and roles are decided by deterministic code in `src/engine` and `src/games`, then injected into the prompt. Never add a path where model output changes game state. LLM tools, if added, must be optional and validated by the same `apply` as every other action.

## Layout

- `src/types.ts`: contracts shared by engine, backend, and frontend. No Spindle or DOM imports.
- `src/engine/`: pure, deterministic core (players, turn rotation, phase checks, decks, RNG, session anchoring). No Spindle imports.
- `src/games/`: one module per game implementing `GameDefinition`. Register new games in `src/engine/registry.ts`.
- `src/data/`: bundled prompt pools as JSON. Entry ids are stored in user settings (to disable entries), so never renumber or reuse an id; append new entries.
- `src/frontend-options.ts`: per-game setup panels. `src/dom.ts`: the DOM helper.
- `src/backend/`: Spindle-facing services (storage, prompt injection, requests). Keep Spindle calls behind the small interfaces there so tests can fake them.
- `src/backend.ts`, `src/frontend.ts`: entry points. Keep them thin.
- `tests/`: Bun tests. `tests/helpers.ts` has game-playing helpers.

## Development

Use Bun for dependencies, tests, and builds. Run all of these before handing off changes:

```bash
bun run typecheck
bun test
bun run build
git diff --check
```

## Versioning and bundles

- Bump the version in both `package.json` and `spindle.json` for every user-facing change (patch for fixes, minor for features). The values must match; Lumiverse uses the manifest version to notice updates.
- Lumiverse loads `dist/backend.js` and `dist/frontend.js` directly. Run `bun run build` after source changes and commit both bundles. Do not ignore `dist/`.

## Game engine rules

- `apply` is pure: clone first (`cloneState`), never mutate the input, and throw `IllegalActionError` with a readable message for anything not legal in the current phase. Never apply an illegal action partially or silently.
- All randomness goes through the injected `Rng`. Shuffle decks and pools once in `setup`; drawing takes the next item, so replays and rollbacks deal the same cards.
- State is never stored on its own. A session stores the setup state plus anchored events; current state is replayed from them (`src/engine/session.ts`). Keep it that way so swipes and deletes roll state back naturally.
- Actions any player can take in any game (such as `set_direction`) are table actions in `src/engine/core.ts`, applied through `applyAction`; games do not handle them.
- Prompt blocks state facts only and end with the shared standing instruction. Update the snapshot tests when wording changes on purpose.

## Spindle compatibility

- The extension may be installed operator-scoped and used by several users. Forward the originating `userId` through every user-scoped backend call and every `sendToFrontend`.
- Chat state lives in chat metadata under the extension's key. Write it with `chats.compareAndSetMetadata` when the host has `chat-conditional-metadata-v1` (retry on conflict), and fall back to a read-merge-write through `chats.update` otherwise. Serialize writes per chat.
- Feature-detect host capabilities (`spindle.host.capabilities`) and optional frontend APIs, and keep fallbacks for older hosts.
- LAN clients may run over insecure HTTP. Do not use secure-context-only browser APIs such as `crypto.randomUUID()` in the frontend; use the request-id helper.
- Treat missing permissions as a supported state: skip the feature and surface a warning instead of throwing.

## Tests

- Add or update unit tests for any change to rotation, phases, decks, a game's rules, anchoring, or prompt text.
- Anchoring tests must cover: deleting the anchor message drops the event, switching swipes switches state, regenerating a reply after an action keeps it.
