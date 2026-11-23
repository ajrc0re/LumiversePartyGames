import type {
  Anchor,
  GameAction,
  GameEvent,
  GameSession,
  PlayerInput,
  StoredChatGames,
} from "../types";
import { cloneState, createPlayers, IllegalActionError, type AnyGameDefinition, type CoreState } from "./core";
import { mulberry32, type Rng } from "./rng";

/**
 * Swipe-safe game history.
 *
 * Every applied action is stored as an event anchored to the message that was
 * last in the chat when it happened (plus which swipe of that message was
 * selected), and to the event it was applied on top of. Nothing else is
 * stored: the current state is always replayed from the setup state.
 *
 * The head is the most recent event whose anchor is live, meaning its message
 * still exists with the same swipe selected. The current state is the setup
 * state plus the head's ancestor chain. So deleting the message an action came
 * after, or swiping that message, rolls the game back to before the action,
 * and swiping back restores it. Regenerating a reply that came after an action
 * leaves the action alone, because the action is anchored to the message
 * before the reply.
 */

export const MAX_EVENTS = 2000;

// ─── Timeline ───────────────────────────────────────────────────────────────

export interface TimelineMessage {
  id: string;
  swipeId: number;
}

/** The chat's messages as they are right now, oldest first. */
export class Timeline {
  private readonly swipes = new Map<string, number>();
  readonly last: Anchor | null;

  constructor(messages: readonly TimelineMessage[]) {
    for (const message of messages) this.swipes.set(message.id, message.swipeId);
    const tail = messages[messages.length - 1];
    this.last = tail ? { messageId: tail.id, swipeId: tail.swipeId } : null;
  }

  /** Null anchors (actions taken in an empty chat) are always live. */
  isLive(anchor: Anchor | null): boolean {
    return anchor === null || this.swipes.get(anchor.messageId) === anchor.swipeId;
  }

  has(messageId: string): boolean {
    return this.swipes.has(messageId);
  }

  get size(): number {
    return this.swipes.size;
  }
}

// ─── Derivation ─────────────────────────────────────────────────────────────

export function headEvent(session: GameSession, timeline: Timeline): GameEvent | null {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event && timeline.isLive(event.anchor)) return event;
  }
  return null;
}

/** The head and its ancestors, oldest first. */
export function activeChain(session: GameSession, timeline: Timeline): GameEvent[] {
  const byId = new Map(session.events.map((event) => [event.id, event]));
  const chain: GameEvent[] = [];
  const seen = new Set<string>();
  let cursor = headEvent(session, timeline);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parent === null ? null : byId.get(cursor.parent) ?? null;
  }
  return chain.reverse();
}

export interface DerivedGame<S extends CoreState = CoreState> {
  state: S;
  /** Events applied to reach `state`, oldest first. */
  chain: GameEvent[];
  head: GameEvent | null;
  /** Set when a stored event no longer applies (for example after a rules change). */
  replayError?: string;
}

export function replay<S extends CoreState>(definition: AnyGameDefinition, session: GameSession, events: readonly GameEvent[]): DerivedGame<S> {
  let state = cloneState(session.setup.seedState) as S;
  const applied: GameEvent[] = [];
  for (const event of events) {
    try {
      state = definition.apply(state, event.action, mulberry32(event.seed)) as S;
      applied.push(event);
    } catch (error) {
      return {
        state,
        chain: applied,
        head: applied[applied.length - 1] ?? null,
        replayError: "Stopped replaying at a stored action: " + (error instanceof Error ? error.message : String(error)),
      };
    }
  }
  return { state, chain: applied, head: applied[applied.length - 1] ?? null };
}

export function deriveGame<S extends CoreState>(definition: AnyGameDefinition, session: GameSession, timeline: Timeline): DerivedGame<S> {
  return replay<S>(definition, session, activeChain(session, timeline));
}

// ─── Mutations (all return new sessions) ───────────────────────────────────

export function createSession(
  definition: AnyGameDefinition,
  players: readonly PlayerInput[],
  rawOptions: unknown,
  rng: Rng,
  meta: { id: string; now: number },
): GameSession {
  const seated = createPlayers(players);
  const options = definition.normalizeOptions(rawOptions);
  const seedState = definition.setup(seated, options, rng);
  return {
    version: 1,
    id: meta.id,
    gameId: definition.id,
    createdAt: meta.now,
    setup: { players: seated, options, seedState },
    events: [],
  };
}

export interface AppendResult<S extends CoreState = CoreState> {
  session: GameSession;
  event: GameEvent;
  state: S;
}

/** Applies an action to the current state and records it. Throws IllegalActionError. */
export function appendAction<S extends CoreState>(
  definition: AnyGameDefinition,
  session: GameSession,
  timeline: Timeline,
  action: GameAction,
  meta: { id: string; seed: number; now: number },
): AppendResult<S> {
  if (session.events.length >= MAX_EVENTS) {
    throw new IllegalActionError("This game has reached its limit of " + String(MAX_EVENTS) + " recorded actions. Start a new game.");
  }
  const current = deriveGame<S>(definition, session, timeline);
  const state = definition.apply(current.state, action, mulberry32(meta.seed)) as S;
  const event: GameEvent = {
    id: meta.id,
    parent: current.head?.id ?? null,
    anchor: timeline.last,
    action,
    seed: meta.seed >>> 0,
    at: meta.now,
  };
  return { session: { ...session, events: [...session.events, event] }, event, state };
}

/**
 * Removes the current head and every event built on it (they sit on swipes
 * that are not selected). Returns null when there is nothing to undo.
 */
export function undoLast(definition: AnyGameDefinition, session: GameSession, timeline: Timeline): GameSession | null {
  const head = deriveGame(definition, session, timeline).head;
  if (!head) return null;
  const removed = new Set<string>([head.id]);
  for (const event of session.events) {
    if (event.parent !== null && removed.has(event.parent)) removed.add(event.id);
  }
  return { ...session, events: session.events.filter((event) => !removed.has(event.id)) };
}

// ─── Parsing untrusted input ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shortString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

/** Keeps only known action fields with the right types. */
export function parseAction(raw: unknown): GameAction {
  const source = isRecord(raw) ? raw : {};
  const type = shortString(source.type, 40);
  if (!type) throw new IllegalActionError("Choose an action.");
  const action: GameAction = { type };
  const actor = shortString(source.actor, 40);
  const target = shortString(source.target, 40);
  const text = typeof source.text === "string" ? source.text.slice(0, 500) : undefined;
  const choice = shortString(source.choice, 40);
  if (actor) action.actor = actor;
  if (target) action.target = target;
  if (text !== undefined && text.trim()) action.text = text;
  if (choice) action.choice = choice;
  if (Array.isArray(source.players)) {
    action.players = [...new Set(source.players.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 40))].slice(0, 32);
  }
  return action;
}

function parseAnchor(value: unknown): Anchor | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.messageId !== "string" || !Number.isInteger(value.swipeId)) return undefined;
  return { messageId: value.messageId, swipeId: Number(value.swipeId) };
}

function parseEvent(value: unknown): GameEvent | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const anchor = parseAnchor(value.anchor);
  if (anchor === undefined) return null;
  if (value.parent !== null && typeof value.parent !== "string") return null;
  let action: GameAction;
  try {
    action = parseAction(value.action);
  } catch {
    return null;
  }
  return {
    id: value.id,
    parent: value.parent as string | null,
    anchor,
    action,
    seed: Number.isInteger(value.seed) ? Number(value.seed) >>> 0 : 0,
    at: Number.isFinite(value.at) ? Number(value.at) : 0,
  };
}

export function emptyStoredGames(): StoredChatGames {
  return { version: 1, session: null };
}

/** Reads the stored value defensively; anything unrecognisable reads as "no game". */
export function parseStoredGames(value: unknown): StoredChatGames {
  if (!isRecord(value) || value.version !== 1) return emptyStoredGames();
  const raw = value.session;
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.id !== "string" || typeof raw.gameId !== "string") return emptyStoredGames();
  const setup = isRecord(raw.setup) ? raw.setup : null;
  if (!setup || !Array.isArray(setup.players) || !isRecord(setup.seedState)) return emptyStoredGames();
  const events = Array.isArray(raw.events)
    ? raw.events.map(parseEvent).filter((event): event is GameEvent => event !== null)
    : [];
  return {
    version: 1,
    session: {
      version: 1,
      id: raw.id,
      gameId: raw.gameId,
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : 0,
      setup: {
        players: setup.players as GameSession["setup"]["players"],
        options: isRecord(setup.options) ? setup.options : {},
        seedState: setup.seedState,
      },
      events,
    },
  };
}
