import type { ConditionalChatMetadataDTO, InterceptorResultDTO, LlmMessageDTO } from "lumiverse-spindle-types";
import { IllegalActionError, type AnyGameDefinition, type CoreState } from "../engine/core";
import { getGame, listGames, requireGame } from "../engine/registry";
import type { Rng } from "../engine/rng";
import {
  appendAction,
  createSession,
  deriveGame,
  emptyStoredGames,
  parseAction,
  parseStoredGames,
  Timeline,
  undoLast,
  type DerivedGame,
  type TimelineMessage,
} from "../engine/session";
import type {
  ChatGameState,
  GameAction,
  GameSession,
  PartyGamesSettings,
  PlayerInput,
  StoredChatGames,
  SuggestedPlayers,
} from "../types";
import { DEFAULT_SETTINGS, insertAtDepth, normalizeSettings, SETTINGS_PATH } from "./settings";

/** Chat metadata key. Matches the manifest identifier so it cannot collide. */
export const METADATA_KEY = "lumiverse_party_games";
export const CONDITIONAL_METADATA_CAPABILITY = "chat-conditional-metadata-v1";
export const REQUIRED_PERMISSIONS = ["chats", "chat_mutation"] as const;
const WRITE_ATTEMPTS = 4;

export interface ChatRecord {
  id: string;
  metadata: Record<string, unknown>;
}

/**
 * Everything the service needs from Lumiverse, kept small so tests can fake
 * it. `backend.ts` builds the real one from `spindle`.
 */
export interface HostPort {
  hasPermission(permission: string): boolean;
  hasCapability(capability: string): boolean;
  getChat(chatId: string, userId?: string): Promise<ChatRecord | null>;
  /** The chat's messages in order, reduced to id and selected swipe. */
  getTimeline(chatId: string): Promise<TimelineMessage[]>;
  compareAndSetMetadata(chatId: string, input: ConditionalChatMetadataDTO, userId?: string): Promise<ChatRecord | null>;
  replaceMetadata(chatId: string, metadata: Record<string, unknown>, userId?: string): Promise<void>;
  /** Dry macro resolve, used to suggest player names. */
  resolveMacros(template: string, chatId: string, userId?: string): Promise<string>;
  readSettings(userId?: string): Promise<unknown>;
  writeSettings(value: PartyGamesSettings, userId?: string): Promise<void>;
  newId(prefix: string): string;
  seed(): number;
  rng(): Rng;
  now(): number;
  warn(message: string): void;
}

export interface ActionOutcome {
  state: ChatGameState;
  /** The newest log line after the action, for toasts. */
  summary: string;
}

function missingPermissions(host: HostPort): string[] {
  return REQUIRED_PERMISSIONS.filter((permission) => !host.hasPermission(permission));
}

function permissionError(missing: readonly string[]): Error {
  return new Error("Party Games needs the " + missing.join(" and ") + " permission" + (missing.length === 1 ? "" : "s") + " to keep score in this chat.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One instance per user; every host call carries that user's id. */
export class PartyGamesService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private settingsCache: PartyGamesSettings | null = null;

  constructor(
    private readonly host: HostPort,
    private readonly userId?: string,
  ) {}

  // ─── Settings ─────────────────────────────────────────────────────────────

  async settings(): Promise<PartyGamesSettings> {
    if (!this.settingsCache) {
      try {
        this.settingsCache = normalizeSettings(await this.host.readSettings(this.userId));
      } catch (error) {
        this.host.warn("settings read failed: " + errorMessage(error));
        return { ...DEFAULT_SETTINGS };
      }
    }
    return { ...this.settingsCache };
  }

  async saveSettings(raw: unknown): Promise<PartyGamesSettings> {
    const settings = normalizeSettings(raw);
    await this.host.writeSettings(settings, this.userId);
    this.settingsCache = settings;
    return { ...settings };
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  private serial<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.queues.set(chatId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async load(chatId: string, excludeMessageId?: string): Promise<{ chat: ChatRecord; stored: StoredChatGames; timeline: Timeline; messages: TimelineMessage[] }> {
    const missing = missingPermissions(this.host);
    if (missing.length) throw permissionError(missing);
    const chat = await this.host.getChat(chatId, this.userId);
    if (!chat) throw new Error("That chat no longer exists.");
    const all = await this.host.getTimeline(chatId);
    const messages = excludeMessageId ? all.filter((message) => message.id !== excludeMessageId) : all;
    return { chat, stored: parseStoredGames(chat.metadata?.[METADATA_KEY]), timeline: new Timeline(messages), messages };
  }

  private derive(session: GameSession, timeline: Timeline): { definition: AnyGameDefinition; derived: DerivedGame<CoreState> } | null {
    const definition = getGame(session.gameId);
    if (!definition) return null;
    return { definition, derived: deriveGame<CoreState>(definition, session, timeline) };
  }

  private async buildState(chatId: string, stored: StoredChatGames, timeline: Timeline): Promise<ChatGameState> {
    const warnings: string[] = [];
    const settings = await this.settings();
    let game: ChatGameState["game"] = null;
    if (stored.session) {
      const result = this.derive(stored.session, timeline);
      if (!result) {
        warnings.push('This chat has a game this version does not know ("' + stored.session.gameId + '"). End it to start a new one.');
      } else {
        const { definition, derived } = result;
        if (derived.replayError) warnings.push(derived.replayError);
        game = {
          sessionId: stored.session.id,
          view: definition.view(derived.state),
          actions: definition.legalActions(derived.state),
          canUndo: derived.head !== null,
          prompt: definition.promptBlock(derived.state),
        };
      }
    }
    return { chatId, games: listGames(), settings, game, warnings };
  }

  async state(chatId: string): Promise<ChatGameState> {
    const missing = missingPermissions(this.host);
    if (missing.length) {
      return { chatId, games: listGames(), settings: await this.settings(), game: null, warnings: [permissionError(missing).message] };
    }
    const { stored, timeline } = await this.load(chatId);
    return this.buildState(chatId, stored, timeline);
  }

  /** The state block for a generation, or null when no game is running. */
  async promptFor(chatId: string, excludeMessageId?: string): Promise<string | null> {
    if (missingPermissions(this.host).length) return null;
    const { stored, timeline } = await this.load(chatId, excludeMessageId);
    if (!stored.session) return null;
    const result = this.derive(stored.session, timeline);
    return result ? result.definition.promptBlock(result.derived.state) : null;
  }

  async suggestPlayers(chatId: string): Promise<SuggestedPlayers> {
    const separator = "␞";
    let user = "";
    let char = "";
    let group = "";
    try {
      const resolved = await this.host.resolveMacros(["{{user}}", "{{char}}", "{{group}}"].join(separator), chatId, this.userId);
      [user = "", char = "", group = ""] = resolved.split(separator).map((part) => part.trim());
    } catch (error) {
      this.host.warn("player suggestion failed: " + errorMessage(error));
    }
    const players: PlayerInput[] = [];
    const seen = new Set<string>();
    const add = (name: string, kind: PlayerInput["kind"]) => {
      const clean = name.trim();
      // Unresolved macros come back verbatim; never seat "{{char}}".
      if (!clean || clean.includes("{{") || seen.has(clean.toLowerCase())) return;
      seen.add(clean.toLowerCase());
      players.push({ name: clean, kind });
    };
    add(user, "user");
    const members = group.split(",").map((name) => name.trim()).filter(Boolean);
    for (const name of members.length ? members : [char]) add(name, "character");
    return { players };
  }

  // ─── Writing ──────────────────────────────────────────────────────────────

  /**
   * Read-modify-write under the chat queue. With conditional metadata the
   * write only lands if neither the metadata nor the last message changed
   * since the read; otherwise it is retried against fresh state.
   */
  private async mutate<T>(
    chatId: string,
    change: (stored: StoredChatGames, timeline: Timeline) => { next: StoredChatGames; result: T },
  ): Promise<T> {
    return this.serial(chatId, async () => {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const { chat, stored, timeline } = await this.load(chatId);
        const { next, result } = change(stored, timeline);
        const metadata = { ...(chat.metadata ?? {}), [METADATA_KEY]: next };
        if (!this.host.hasCapability(CONDITIONAL_METADATA_CAPABILITY)) {
          await this.host.replaceMetadata(chatId, metadata, this.userId);
          return result;
        }
        const written = await this.host.compareAndSetMetadata(chatId, {
          expected_metadata: chat.metadata ?? {},
          metadata,
          expected_last_message_id: timeline.last?.messageId ?? null,
        }, this.userId);
        if (written) return result;
      }
      throw new Error("The chat kept changing while the game was saving. Try again.");
    });
  }

  async start(chatId: string, gameId: string, players: readonly PlayerInput[], options: unknown): Promise<ChatGameState> {
    const definition = requireGame(gameId);
    await this.mutate(chatId, (stored) => {
      if (stored.session && getGame(stored.session.gameId)) {
        throw new IllegalActionError("A game is already running in this chat. End it before starting another.");
      }
      const session = createSession(definition, players, options, this.host.rng(), { id: this.host.newId("s"), now: this.host.now() });
      return { next: { version: 1, session }, result: undefined };
    });
    return this.state(chatId);
  }

  async act(chatId: string, rawAction: unknown): Promise<ActionOutcome> {
    const action: GameAction = parseAction(rawAction);
    const summary = await this.mutate(chatId, (stored, timeline) => {
      if (!stored.session) throw new IllegalActionError("No game is running in this chat.");
      const definition = requireGame(stored.session.gameId);
      const appended = appendAction(definition, stored.session, timeline, action, {
        id: this.host.newId("e"),
        seed: this.host.seed(),
        now: this.host.now(),
      });
      return { next: { version: 1, session: appended.session }, result: appended.state.log.at(-1)?.text ?? "" };
    });
    return { state: await this.state(chatId), summary };
  }

  /** Runs the primary action when it needs no input. */
  async next(chatId: string): Promise<ActionOutcome> {
    const current = await this.state(chatId);
    if (!current.game) throw new IllegalActionError("No game is running in this chat.");
    const primary = current.game.actions.find((action) => action.primary) ?? current.game.actions[0];
    if (!primary) throw new IllegalActionError("There is nothing to do; the game is over.");
    if (primary.fields?.some((field) => field.required)) {
      throw new IllegalActionError(primary.label + " needs a choice. Open the Party Games panel to make it.");
    }
    return this.act(chatId, { ...primary.preset, type: primary.type });
  }

  async undo(chatId: string): Promise<ChatGameState> {
    await this.mutate(chatId, (stored, timeline) => {
      if (!stored.session) throw new IllegalActionError("No game is running in this chat.");
      const undone = undoLast(requireGame(stored.session.gameId), stored.session, timeline);
      if (!undone) throw new IllegalActionError("There is nothing to undo.");
      return { next: { version: 1, session: undone }, result: undefined };
    });
    return this.state(chatId);
  }

  async end(chatId: string): Promise<ChatGameState> {
    await this.mutate(chatId, () => ({ next: emptyStoredGames(), result: undefined }));
    return this.state(chatId);
  }

  // ─── Prompt injection ─────────────────────────────────────────────────────

  async intercept(
    messages: LlmMessageDTO[],
    context: { chatId: string; generationType?: string; excludeMessageId?: string },
  ): Promise<LlmMessageDTO[] | InterceptorResultDTO> {
    try {
      if (context.generationType === "quiet") return messages;
      const settings = await this.settings();
      if (!settings.autoInject || !context.chatId) return messages;
      const block = await this.promptFor(context.chatId, context.excludeMessageId);
      if (!block) return messages;
      const injected: LlmMessageDTO = { role: "system", content: block };
      const result = insertAtDepth(messages, injected, settings.injectionDepth);
      return { messages: result, breakdown: [{ messageIndex: result.indexOf(injected), name: "Party Games: game state" }] };
    } catch (error) {
      this.host.warn("prompt injection skipped: " + errorMessage(error));
      return messages;
    }
  }
}
