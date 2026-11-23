/**
 * Contracts shared by the engine, the backend worker, and the frontend bundle.
 * Nothing in this file may import Spindle or touch the DOM.
 */

// ─── Players ────────────────────────────────────────────────────────────────

export type PlayerKind = "user" | "character" | "npc";

export interface Player {
  id: string;
  name: string;
  kind: PlayerKind;
  /** False once a player is eliminated. Inactive players are skipped in rotation. */
  active: boolean;
}

/** What the setup UI sends for one seat. Ids are assigned by the engine. */
export interface PlayerInput {
  name: string;
  kind?: PlayerKind;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type GameOptions = Record<string, unknown>;

export interface GameAction {
  type: string;
  /** Player taking the action. Defaults to the current player. */
  actor?: string;
  /** A single chosen player, e.g. who drinks for a 2 or who becomes a mate for an 8. */
  target?: string;
  /** Several chosen players, e.g. who reacted to a Never Have I Ever statement. */
  players?: string[];
  /** Free text, e.g. a new Kings Cup rule or a custom statement. */
  text?: string;
  /** A fixed choice such as "truth" or "dare". */
  choice?: string;
}

export interface ActionChoice {
  id: string;
  label: string;
}

export interface ActionField {
  name: "target" | "players" | "text";
  kind: "player" | "players" | "text";
  label: string;
  required: boolean;
  placeholder?: string;
  /** Allowed values for player fields. */
  choices?: ActionChoice[];
}

/** One action that is legal right now, as the UI should offer it. */
export interface ActionDef {
  type: string;
  label: string;
  description?: string;
  /** The action the input-bar button and the "next action" command perform. */
  primary?: boolean;
  fields?: ActionField[];
  /** Values the UI sends unchanged with this action, e.g. `{ choice: "truth" }`. */
  preset?: Partial<GameAction>;
}

// ─── Sessions and anchoring ─────────────────────────────────────────────────

/** The message an event happened after, and which swipe of it was selected. */
export interface Anchor {
  messageId: string;
  swipeId: number;
}

export interface GameEvent {
  id: string;
  /** The event this one was applied on top of; null when applied to the setup state. */
  parent: string | null;
  /** Null when the chat had no messages at the time. Null anchors are always live. */
  anchor: Anchor | null;
  action: GameAction;
  /** Seed for any randomness `apply` uses, so replays are exact. */
  seed: number;
  at: number;
}

export interface GameSession {
  version: 1;
  id: string;
  gameId: string;
  createdAt: number;
  setup: {
    players: Player[];
    options: GameOptions;
    /** The full state right after setup, including the shuffled deck order. */
    seedState: unknown;
  };
  /**
   * Every event ever applied in this chat, including ones on swipes that are
   * not selected right now. Current state is derived from these, never stored.
   */
  events: GameEvent[];
}

/** The value stored under the extension's key in chat metadata. */
export interface StoredChatGames {
  version: 1;
  session: GameSession | null;
}

// ─── Views ──────────────────────────────────────────────────────────────────

export interface PlayerView {
  id: string;
  name: string;
  kind: PlayerKind;
  active: boolean;
  current: boolean;
  next: boolean;
  /** Short role or score labels, e.g. "Question Master" or "7 lives". */
  badges: string[];
}

export interface GameFact {
  label: string;
  value: string;
}

/** Everything the scoreboard renders. Built by the game, never by the UI. */
export interface GameView {
  gameId: string;
  gameName: string;
  status: "active" | "ended";
  turnNumber: number;
  phase: string;
  phaseLabel: string;
  currentPlayerId: string | null;
  nextPlayerId: string | null;
  players: PlayerView[];
  /** One line for the most important thing right now, e.g. "Sam drew 7♥ — Heaven". */
  headline: string;
  /** The rule or prompt that goes with the headline. */
  detail?: string;
  facts: GameFact[];
  /** Most recent log lines, newest last. */
  recent: string[];
  endSummary?: string;
}

export interface GameSummary {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  available: boolean;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface PartyGamesSettings {
  /** Inject the state block automatically. Turn off when a preset uses the macro instead. */
  autoInject: boolean;
  /** Messages from the end of the prompt where the block is inserted (0 = last). */
  injectionDepth: number;
}

// ─── Frontend ↔ backend ─────────────────────────────────────────────────────

export interface ChatGameState {
  chatId: string;
  games: GameSummary[];
  settings: PartyGamesSettings;
  /** Null when no game is running in this chat. */
  game: {
    sessionId: string;
    view: GameView;
    actions: ActionDef[];
    canUndo: boolean;
    prompt: string;
  } | null;
  /** Problems the UI should show, such as a missing permission. */
  warnings: string[];
}

export interface SuggestedPlayers {
  players: PlayerInput[];
}

export type PartyRequestAction =
  | "state"
  | "suggest-players"
  | "start"
  | "act"
  | "undo"
  | "end"
  | "save-settings";

export interface PartyRequest {
  type: "party:request";
  requestId: string;
  action: PartyRequestAction;
  input?: Record<string, unknown>;
}

export interface PartyReply {
  type: "party:reply";
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface PartyChanged {
  type: "party:changed";
  chatId: string | null;
  reason: string;
}
