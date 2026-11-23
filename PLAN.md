# Lumiverse Party Games Extension

## Summary

- Build a TypeScript Spindle extension (Bun backend + browser frontend) that runs party games inside a Lumiverse chat: **Kings Cup**, **Never Have I Ever**, and **Truth or Dare** first, with room for more games later.
- **The extension owns all game state; the model only narrates.** Turn order, the active player, the current phase, the deck, drawn cards, eliminations, and persistent roles are decided by deterministic extension code and injected into the prompt every generation. The model never draws cards, picks whose turn it is, or advances phases on its own authority.
- Follow the project layout and conventions of the existing extensions in `F:\server\Repos` (Waypoints, SuperDeduper): Bun, `src/backend.ts` + `src/frontend.ts`, shared `src/types.ts`, tests in `tests/`, committed `dist/` bundles, matching versions in `package.json` and `spindle.json`.

## Why not a SimTracker preset

Considered and rejected: building this as custom trackers for [Lumiverse-SimTracker](https://github.com/prolix-oc/Lumiverse-SimTracker) (local clone: `F:\server\Repos\Lumiverse-SimTracker`).

- SimTracker is a display layer. The model writes a `<tracker>{json}</tracker>` block in every reply; the extension parses it, renders it with a Handlebars template, and re-injects the last N trackers. A "custom tracker" is only a template + system prompt + field list. There is no hook for custom logic.
- That makes the model the source of truth. Models are unreliable at random draws and at drawing without replacement (repeat cards, a 5th King, drifting deck counts), and at advancing turn order and phases correctly every reply, especially with eliminations and persistent roles.
- SimTracker's own author hit this: its one extension-decided state change (the conception gate in `src/backend.ts`) has to mutate the stored payload, rewrite the in-flight messages, and inject a "do not revert" directive. Every draw and turn change here would need that workaround.
- What SimTracker gets right and this extension must keep: state lives with the message, so swipes and deletes roll it back naturally (see State and swipe safety).

## Implementation Changes

### Project structure and permissions

- Scaffold like `F:\server\Repos\LumiverseWaypoints`: `package.json` scripts `build` (`bun build` frontend → `dist/frontend.js`, backend → `dist/backend.js`), `typecheck` (`tsc --noEmit`), `test` (`bun test tests`).
- Use the current `lumiverse-spindle-types` (0.6.81 as of 2026-11-22; Waypoints is still on 0.6.32, which may lack APIs used below).
- `spindle.json` permissions, starting point (trim to what is actually used): `chats`, `chat_mutation`, `interceptor`, `ui_panels`. Add `generation` only if a feature needs it. Check whether tool registration needs its own permission before adding LLM tools.
- Add an `AGENTS.md` modelled on SuperDeduper's (Bun commands to run before handoff, version bump rule, commit `dist/`, forward `userId` through user-scoped calls, no `crypto.randomUUID()` in the frontend because LAN clients may be on insecure HTTP).

### Engine core (pure, deterministic, no Spindle imports)

Shared by every game:

- **Players:** ordered list with id, display name, kind (`user` | `character` | `npc`), and an `active` flag for eliminations. Defaults at setup: the user's persona plus the chat's characters; extra names can be added in the setup UI.
- **Turn rotation:** current turn index, skips inactive players, supports direction reversal and "skip next" effects if a game wants them.
- **Phase machine:** each game declares its phases and which actions are legal in each phase. Illegal actions are rejected with a clear message, not silently applied.
- **Deck / pool without replacement:** shuffled once at setup; drawing removes from the remaining list and appends to history. Works for playing cards (Kings Cup) and prompt pools (NHIE, ToD). The full shuffled order is stored in state, so replays are reproducible and nothing depends on re-seeding.
- **RNG:** injected into `setup`/`apply` so tests can pass a seeded RNG. The backend uses `crypto.getRandomValues`.
- **Event log:** every applied action is recorded (`{ action, actor, anchor, result }`), so state can be rebuilt from setup + events.

### Game modules

Each game implements one interface (see Internal Interfaces) and registers with the core.

1. **Kings Cup**
   - 52-card deck. The card → rule table is data, not code, with a default set and user overrides (house rules vary). Common default: A Waterfall, 2 You, 3 Me, 4 Floor, 5 Guys, 6 Chicks, 7 Heaven, 8 Mate, 9 Rhyme, 10 Categories, J Make a Rule, Q Question Master, K King's Cup.
   - Persistent state that outlives a turn: current mates, Question Master, active custom rules, kings drawn (0–4), cup contents. The 4th King ends the game.
   - Phases per turn: `draw` → `resolve` (card rule plays out) → `end_turn`.
2. **Never Have I Ever**
   - Statement pool without repeats; lives/fingers per player (default 10, configurable); players at 0 are eliminated and skipped in rotation; last player standing wins (or play until the pool runs out).
   - Phases: `statement` (active player says one, from the pool or their own) → `reactions` (who has done it; lose a life) → `end_turn`.
3. **Truth or Dare**
   - Separate truth and dare pools, no repeats, configurable intensity tiers.
   - Phases: `choose` (truth or dare) → `prompt` (drawn from the matching pool) → `perform` or `refuse` → optional penalty → `end_turn`.

Bundled pools ship as JSON data files; users can add or disable entries from the UI.

### State and swipe safety

- Store the game session per chat (chat metadata or chat variables; see how Waypoints persists chat state in `src/engine.ts`/`src/state.ts`). Use the conditional metadata update (`ConditionalChatMetadataDTO`, `expected_last_message_id`) so a stale write cannot clobber newer state.
- Each event is anchored to the message it happened after (message id, plus swipe index for actions taken during a generation).
- Current state = setup + events whose anchor message still exists and whose swipe is the currently selected one. Deleting messages or swiping therefore rolls game state back without special cases.
- Actions taken by the user between generations (Draw, Next turn) happen **before** the reply is generated, so swiping or regenerating the narration never draws a second card.
- Verify `chat.setSwipeVariables` (per-swipe variables, requires the `chat-swipe-variables-v1` capability) as an alternative to anchoring events by swipe index.

### Prompt injection

- `registerInterceptor` adds one compact system block per generation with the facts the model must narrate, for example: `Kings Cup, turn 14. Sam's turn. Sam drew 7♥ (Heaven: last to raise a hand drinks). Kings 2/4. Question Master: Alex. Mates: Sam ↔ Riley. Rules: no first names. Next up: Riley.`
- Include a short standing instruction: narrate only what the state block says; do not invent draws, change whose turn it is, or skip phases.
- Also expose a macro (`registerMacro`, e.g. `{{party_game_state}}`) for presets that want to place the block themselves.
- Inject nothing when no game is active in the chat.

### Actions and UI

- **Primary path (most reliable):** `registerInputBarAction` buttons for the actions legal in the current phase (Draw, Truth, Dare, Refuse, Next turn), plus slash commands for the same actions.
- **Panel:** a `createFloatWidget` or `registerDrawerTab` scoreboard: game, turn number, active player, next up, phase, last few draws, persistent roles/rules, lives. Includes game setup (pick game, players, options) and an End game control.
- **Optional, later:** `registerTool` with `inline_available: true` (`draw_card`, `choose`, `end_turn`) so the model can act for NPC players, handled via `spindle.on("TOOL_INVOCATION")`. Only works on connections that support tool calls, so it must never be the only way to advance the game.

## Internal Interfaces

```ts
interface GameDefinition<S> {
  id: string;
  name: string;
  setup(players: Player[], options: GameOptions, rng: Rng): S;
  legalActions(state: S): ActionDef[]; // S embeds the core's players/turn/phase state
  apply(state: S, action: GameAction, rng: Rng): S; // pure; throws on illegal action
  promptBlock(state: S): string;
  view(state: S): GameView; // what the UI renders
}

interface GameSession {
  gameId: string;
  setup: { players: Player[]; options: GameOptions; seedState: unknown };
  events: GameEvent[]; // anchored; current state is derived, never stored alone
}
```

## Milestones

1. Scaffold the project, `AGENTS.md`, build/test scripts, and an empty extension that loads in Lumiverse.
2. Engine core + Kings Cup as pure modules with unit tests.
3. Backend wiring: session storage, anchoring, state derivation, interceptor block, macro, slash commands.
4. Frontend: scoreboard panel, setup flow, input-bar actions.
5. Never Have I Ever and Truth or Dare modules + bundled pools.
6. Optional LLM tools for NPC turns.

## Test Plan

- Unit: deck never repeats a card and empties after exactly 52 draws; 4th King ends Kings Cup; turn rotation skips eliminated players; illegal actions are rejected per phase; pools never repeat within a game; state rebuilt from setup + events equals the live state.
- Anchoring: deleting the message an event is anchored to drops that event; switching swipes switches the derived state; regenerating a reply after a Draw keeps the same card.
- Prompt block snapshot tests per game and phase.
- Manual in Lumiverse: full Kings Cup game in one chat, swipe and delete mid-game, two chats with separate games, reload the app mid-game.
- Before handoff: `bun run typecheck`, `bun test`, `bun run build`, `git diff --check`.

## Open Questions

- Who decides for model-played characters (Truth vs Dare, who an "8 Mate" or "2 You" targets): weighted RNG in the extension, the model via a tool/tag, or the user?
- Single chats with one character vs group chats: does Lumiverse expose the group member list to extensions, or is the player list always configured by hand?
- Which Kings Cup house-rule set should be the default, and should the card table be editable per chat or globally?
- Content tiers for NHIE/ToD pools: what ships by default, and is intensity a per-game option?
