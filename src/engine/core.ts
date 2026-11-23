import type {
  ActionChoice,
  ActionDef,
  GameAction,
  GameOptions,
  GameView,
  Player,
  PlayerInput,
  PlayerKind,
} from "../types";
import { shuffle, type Rng } from "./rng";

// ─── Errors ─────────────────────────────────────────────────────────────────

/** Thrown by `apply` for an action that is not legal right now. Never applied silently. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

// ─── Shared state ───────────────────────────────────────────────────────────

export interface TurnState {
  /** Index into `players` of whoever's turn it is. */
  index: number;
  /** 1 for seat order, -1 when a game reverses play. */
  direction: 1 | -1;
  /** Active players to pass over on the next advance. */
  skips: number;
  /** 1-based count of turns started this game. */
  number: number;
}

export interface LogEntry {
  turn: number;
  text: string;
}

/** The part of every game's state the core owns. Game states extend it. */
export interface CoreState {
  players: Player[];
  turn: TurnState;
  phase: string;
  status: "active" | "ended";
  winners: string[];
  endReason: string | null;
  log: LogEntry[];
}

export interface GameDefinition<S extends CoreState = CoreState, O extends GameOptions = GameOptions> {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  /** False when the game picks who goes next itself; then seat order and reversal do not apply. */
  usesTurnOrder: boolean;
  /** Phase ids in play order, each with a label for the scoreboard. */
  phases: Readonly<Record<string, string>>;
  defaultOptions(): O;
  /** Turns untrusted input into complete options; unknown keys are dropped. */
  normalizeOptions(raw: unknown): O;
  setup(players: Player[], options: O, rng: Rng): S;
  legalActions(state: S): ActionDef[];
  /** Pure: returns a new state and never mutates its input. Throws IllegalActionError. */
  apply(state: S, action: GameAction, rng: Rng): S;
  promptBlock(state: S): string;
  view(state: S): GameView;
}

/** Erased form used by the registry and the session layer. */
export type AnyGameDefinition = GameDefinition<any, any>;

// ─── Players ────────────────────────────────────────────────────────────────

const PLAYER_KINDS: readonly PlayerKind[] = ["user", "character", "npc"];
export const MAX_PLAYERS = 16;
export const MAX_NAME_LENGTH = 60;

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
}

/**
 * Seats players in the given order with stable ids (p1, p2, ...). Blank names
 * are dropped and duplicate names get a number so every seat reads distinctly
 * in the prompt.
 */
export function createPlayers(inputs: readonly PlayerInput[]): Player[] {
  const players: Player[] = [];
  const seen = new Map<string, number>();
  for (const input of inputs) {
    const base = cleanName(input?.name);
    if (!base) continue;
    if (players.length >= MAX_PLAYERS) throw new IllegalActionError("A game can have at most " + String(MAX_PLAYERS) + " players.");
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const kind = PLAYER_KINDS.includes(input.kind as PlayerKind) ? input.kind as PlayerKind : "npc";
    players.push({
      id: "p" + String(players.length + 1),
      name: count > 1 ? base + " " + String(count) : base,
      kind,
      active: true,
    });
  }
  return players;
}

export function findPlayer(state: CoreState, id: string | undefined): Player | undefined {
  return id === undefined ? undefined : state.players.find((player) => player.id === id);
}

export function playerName(state: CoreState, id: string | null | undefined): string {
  return (id && findPlayer(state, id)?.name) || "Unknown player";
}

export function activePlayers(state: CoreState): Player[] {
  return state.players.filter((player) => player.active);
}

export function playerChoices(players: readonly Player[]): ActionChoice[] {
  return players.map((player) => ({ id: player.id, label: player.name }));
}

// ─── Core state and turn rotation ──────────────────────────────────────────

export function createCoreState(players: Player[], phase: string, minPlayers: number): CoreState {
  if (players.length < minPlayers) {
    throw new IllegalActionError("This game needs at least " + String(minPlayers) + " players.");
  }
  return {
    players: players.map((player) => ({ ...player })),
    turn: { index: 0, direction: 1, skips: 0, number: 1 },
    phase,
    status: "active",
    winners: [],
    endReason: null,
    log: [],
  };
}

export function currentPlayer(state: CoreState): Player {
  const player = state.players[state.turn.index];
  if (!player) throw new Error("Turn index is out of range.");
  return player;
}

/**
 * Index of the player after `fromIndex`, skipping inactive players and then
 * `skips` more active ones. Returns `fromIndex` when nobody else is active.
 */
export function nextActiveIndex(
  players: readonly Player[],
  fromIndex: number,
  direction: 1 | -1,
  skips = 0,
): number {
  const count = players.length;
  if (!count || !players.some((player) => player.active)) return fromIndex;
  let index = fromIndex;
  let toPass = Math.max(0, skips);
  for (let guard = 0; guard < count * (toPass + 2); guard += 1) {
    index = (((index + direction) % count) + count) % count;
    if (!players[index]?.active) continue;
    if (toPass === 0) return index;
    toPass -= 1;
  }
  return fromIndex;
}

export function nextPlayer(state: CoreState): Player | null {
  if (state.status !== "active") return null;
  const index = nextActiveIndex(state.players, state.turn.index, state.turn.direction, state.turn.skips);
  return state.players[index] ?? null;
}

/** Mutates a working copy: moves the turn to the next active player. */
export function advanceTurn(state: CoreState, phase: string): void {
  state.turn.index = nextActiveIndex(state.players, state.turn.index, state.turn.direction, state.turn.skips);
  state.turn.skips = 0;
  state.turn.number += 1;
  state.phase = phase;
}

export function reverseDirection(state: CoreState): void {
  state.turn.direction = state.turn.direction === 1 ? -1 : 1;
}

export function directionOf(state: CoreState): "forward" | "reversed" {
  return state.turn.direction === 1 ? "forward" : "reversed";
}

/** Active players in the order they will play, starting with whoever's turn it is. */
export function playOrder(state: CoreState): Player[] {
  const count = state.players.length;
  const order: Player[] = [];
  for (let step = 0; step < count; step += 1) {
    const index = (((state.turn.index + step * state.turn.direction) % count) + count) % count;
    const player = state.players[index];
    if (player?.active) order.push(player);
  }
  return order;
}

/** One prompt line naming the play order, flagged when it has been reversed. */
export function turnOrderLine(state: CoreState): string {
  const names = playOrder(state).map((player) => player.name);
  const reversed = state.turn.direction === -1 ? " (reversed)" : "";
  return state.status === "active"
    ? "Turn order" + reversed + ", from the current player: " + names.join(" → ") + "."
    : "Players: " + state.players.map((player) => player.name).join(", ") + ".";
}

export function skipNext(state: CoreState, count = 1): void {
  state.turn.skips += Math.max(0, count);
}

export function eliminate(state: CoreState, playerId: string): void {
  const player = state.players.find((entry) => entry.id === playerId);
  if (player) player.active = false;
}

export function endGame(state: CoreState, reason: string, winners: string[] = []): void {
  state.status = "ended";
  state.phase = "game_over";
  state.endReason = reason;
  state.winners = winners;
}

export function addLog(state: CoreState, text: string): void {
  state.log.push({ turn: state.turn.number, text });
}

// ─── Table actions (every game) ─────────────────────────────────────────────

/**
 * Actions any player can take in any phase of any game, handled here so game
 * modules do not repeat them:
 * - set_direction (choice "forward" | "reversed"): the turn order changes
 *   direction, e.g. when the group decides play goes the other way.
 */
export const TABLE_ACTIONS: readonly string[] = ["set_direction"];

function applyTableAction<S extends CoreState>(input: S, action: GameAction): S {
  requireActiveGame(input);
  const wanted = action.choice === "reversed" ? -1 : action.choice === "forward" ? 1 : 0;
  if (!wanted) throw new IllegalActionError('Choose "forward" or "reversed" for the turn order.');
  if (input.turn.direction === wanted) {
    throw new IllegalActionError("The turn order is already " + (wanted === 1 ? "forward" : "reversed") + ".");
  }
  const state = cloneState(input);
  state.turn.direction = wanted;
  const next = nextPlayer(state);
  addLog(state, (wanted === -1 ? "Turn order reversed." : "Turn order back to normal.") + (next ? " Next up: " + next.name + "." : ""));
  return state;
}

/** Applies a table action or delegates to the game. The only entry point replays use. */
export function applyAction<S extends CoreState>(definition: GameDefinition<S, any>, state: S, action: GameAction, rng: Rng): S {
  if (action.type === "set_direction" && definition.usesTurnOrder === false) {
    throw new IllegalActionError(definition.name + " has no fixed turn order to reverse.");
  }
  if (TABLE_ACTIONS.includes(action.type)) return applyTableAction(state, action);
  return definition.apply(state, action, rng);
}

// ─── Phase machine ──────────────────────────────────────────────────────────

/** Copy a state before changing it so `apply` stays pure. */
export function cloneState<S>(state: S): S {
  return structuredClone(state);
}

export function requireActiveGame(state: CoreState): void {
  if (state.status !== "active") throw new IllegalActionError("The game is over. Start a new game to keep playing.");
}

export function requirePhase(state: CoreState, phases: Readonly<Record<string, string>>, allowed: readonly string[], action: GameAction): void {
  requireActiveGame(state);
  if (!allowed.includes(state.phase)) {
    const phaseLabel = phases[state.phase] ?? state.phase;
    throw new IllegalActionError('"' + action.type + '" is not allowed during the ' + phaseLabel + " phase.");
  }
}

/**
 * The player taking a turn action. Actions default to the current player and
 * may not be taken on someone else's behalf.
 */
export function requireCurrentActor(state: CoreState, action: GameAction): Player {
  const current = currentPlayer(state);
  if (action.actor !== undefined && action.actor !== current.id) {
    throw new IllegalActionError("It is " + current.name + "'s turn, not " + playerName(state, action.actor) + "'s.");
  }
  return current;
}

export function requireTarget(state: CoreState, action: GameAction, options: { excludeId?: string; label: string }): Player {
  const target = findPlayer(state, action.target);
  if (!target) throw new IllegalActionError("Choose a player for " + options.label + ".");
  if (!target.active) throw new IllegalActionError(target.name + " is out of the game.");
  if (options.excludeId && target.id === options.excludeId) {
    throw new IllegalActionError("Choose someone other than " + target.name + " for " + options.label + ".");
  }
  return target;
}

export function unknownAction(state: CoreState, phases: Readonly<Record<string, string>>, action: GameAction): never {
  requireActiveGame(state);
  throw new IllegalActionError('"' + String(action.type) + '" is not an action in this game (phase: ' + (phases[state.phase] ?? state.phase) + ").");
}

// ─── Decks and pools (draw without replacement) ────────────────────────────

export interface Deck<T> {
  /** Draw order, next card first. Fixed at shuffle time. */
  remaining: T[];
  /** Everything drawn so far, oldest first. */
  drawn: T[];
}

export function createDeck<T>(items: readonly T[], rng: Rng): Deck<T> {
  return { remaining: shuffle(items, rng), drawn: [] };
}

/** Mutates a working copy: moves the next card from remaining to drawn. */
export function drawFrom<T>(deck: Deck<T>): T {
  const card = deck.remaining.shift();
  if (card === undefined) throw new IllegalActionError("The deck is empty.");
  deck.drawn.push(card);
  return card;
}

// ─── Input helpers ──────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Collapses whitespace, trims, and caps the length; non-strings become "". */
export function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

// ─── Text helpers for prompt blocks ────────────────────────────────────────

export const STANDING_INSTRUCTION =
  "This block is the authoritative game state, maintained by the game. Narrate only what it says. " +
  "Do not draw cards, change whose turn it is, eliminate players, or move the game to a new phase yourself; " +
  "the game advances only when the players use the game controls. If an action is still pending, describe the moment and leave it pending.";

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

export function formatBlock(title: string, lines: readonly string[]): string {
  return "[" + title + "]\n" + lines.filter((line) => line.trim().length > 0).join("\n") + "\n" + STANDING_INSTRUCTION;
}

export function recentLog(state: CoreState, count: number, noun = "Turn"): string[] {
  return state.log.slice(-count).map((entry) => noun + " " + String(entry.turn) + ": " + entry.text);
}
