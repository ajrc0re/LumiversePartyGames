import type { MacroDefinitionDTO, SpindleAPI, SpindleCommandDTO } from "lumiverse-spindle-types";
import { cryptoRng, cryptoSeed } from "./engine/rng";
import type { TimelineMessage } from "./engine/session";
import { handlePartyRequest } from "./backend/requests";
import { PartyGamesService, type HostPort } from "./backend/service";
import type { PartyChanged } from "./types";

declare const spindle: SpindleAPI;

const LOG_PREFIX = "[Party Games] ";
const LEAN_MESSAGES_CAPABILITY = "chat-lean-messages-v1";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// ─── Host port ──────────────────────────────────────────────────────────────

let idCounter = 0;

const host: HostPort = {
  hasPermission: (permission) => spindle.permissions.has(permission),
  hasCapability: (capability) => (spindle.host?.capabilities?.[capability] ?? 0) > 0,
  getChat: async (chatId, userId) => {
    const chat = await spindle.chats.get(chatId, userId);
    return chat ? { id: chat.id, metadata: chat.metadata ?? {} } : null;
  },
  getTimeline: async (chatId) => {
    const messages: Array<{ id: string; swipe_id: number }> = host.hasCapability(LEAN_MESSAGES_CAPABILITY)
      ? await spindle.chat.getMessages(chatId, { light: true, includeExtra: false })
      : await spindle.chat.getMessages(chatId);
    return messages.map((message): TimelineMessage => ({
      id: message.id,
      swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : 0,
    }));
  },
  compareAndSetMetadata: async (chatId, input, userId) => {
    const chat = await spindle.chats.compareAndSetMetadata(chatId, input, userId);
    return chat ? { id: chat.id, metadata: chat.metadata ?? {} } : null;
  },
  replaceMetadata: async (chatId, metadata, userId) => {
    await spindle.chats.update(chatId, { metadata }, userId);
  },
  resolveMacros: async (template, chatId, userId) => {
    const { text } = await spindle.macros.resolve(template, { chatId, commit: false, ...(userId ? { userId } : {}) });
    return text;
  },
  readJson: (path, userId) => spindle.userStorage.getJson<unknown>(path, { fallback: null, ...(userId ? { userId } : {}) }),
  writeJson: (path, value, userId) => spindle.userStorage.setJson(path, value, userId ? { userId } : {}),
  newId: (prefix) => prefix + Date.now().toString(36) + (++idCounter).toString(36) + cryptoSeed().toString(36),
  seed: cryptoSeed,
  rng: cryptoRng,
  now: () => Date.now(),
  warn: (message) => spindle.log.warn(LOG_PREFIX + message),
};

// ─── Per-user services ──────────────────────────────────────────────────────

const services = new Map<string, PartyGamesService>();

function service(userId?: string): PartyGamesService {
  const key = userId || "owner";
  let current = services.get(key);
  if (!current) {
    current = new PartyGamesService(host, userId);
    services.set(key, current);
  }
  return current;
}

function notifyChanged(chatId: string | null, reason: string, userId?: string): void {
  const message: PartyChanged = { type: "party:changed", chatId, reason };
  spindle.sendToFrontend(message, userId);
}

// ─── Frontend requests ──────────────────────────────────────────────────────

spindle.onFrontendMessage((payload, userId) => {
  void handlePartyRequest(payload, service(userId)).then(({ reply, changed }) => {
    // Replies and change notices go only to the user who made the request.
    if (reply) spindle.sendToFrontend(reply, userId);
    if (changed) spindle.sendToFrontend(changed, userId);
  });
});

// ─── Prompt injection ───────────────────────────────────────────────────────

let interceptorDisposer: (() => void) | undefined;

/** Registers the interceptor while the permission is granted; follows grants and revokes. */
function syncInterceptor(): void {
  const granted = spindle.permissions.has("interceptor");
  if (granted && !interceptorDisposer) {
    interceptorDisposer = spindle.registerInterceptor((messages, context) => service(context.userId).intercept(messages, context), 100);
  } else if (!granted && interceptorDisposer) {
    interceptorDisposer();
    interceptorDisposer = undefined;
  }
  if (!granted) {
    spindle.log.warn(LOG_PREFIX + "interceptor permission not granted; the game state block is only available through {{party_game_state}}.");
  }
}

syncInterceptor();

function macroIdentity(context: unknown): { chatId?: string; userId?: string } {
  const value = record(context);
  const env = record(value.env);
  const chat = record(env.chat);
  const extra = record(env.extra);
  return {
    chatId: nonEmpty(value.chatId) ?? nonEmpty(chat.id),
    userId: nonEmpty(value.userId) ?? nonEmpty(extra.userId),
  };
}

function registerMacro(name: string, description: string, returnType: "string" | "boolean", select: (block: string | null) => string): void {
  const definition = {
    name,
    category: "extension:lumiverse_party_games",
    description,
    returnType,
    // State changes with every action, swipe, and delete; never cache it.
    volatile: true,
    handler: async (context: unknown) => {
      const { chatId, userId } = macroIdentity(context);
      if (!chatId) return select(null);
      try {
        return select(await service(userId).promptFor(chatId));
      } catch {
        return select(null);
      }
    },
  };
  // The published declaration types handlers as strings; the worker accepts functions.
  spindle.registerMacro(definition as unknown as MacroDefinitionDTO);
}

registerMacro(
  "party_game_state",
  "The current party game's state block for this chat, or nothing when no game is running. Turn off automatic injection in the Party Games panel if your preset places this itself.",
  "string",
  (block) => block ?? "",
);
registerMacro(
  "party_game_active",
  "True when a party game is running in this chat.",
  "boolean",
  (block) => block ? "true" : "false",
);

// ─── Command palette ────────────────────────────────────────────────────────

const COMMANDS: SpindleCommandDTO[] = [
  { id: "next", label: "Party Games: Next action", description: "Draw, finish the card, or pass the turn, whichever comes next.", keywords: ["party", "game", "draw", "next", "turn"], scope: "chat" },
  { id: "undo", label: "Party Games: Undo last action", description: "Take back the most recent game action in this chat.", keywords: ["party", "game", "undo"], scope: "chat" },
];

spindle.commands.register(COMMANDS);
spindle.commands.onInvoked(async (commandId, context, origin) => {
  const userId = origin?.userId;
  const chatId = context.chatId;
  const toastOptions = userId ? { title: "Party Games", userId } : { title: "Party Games" };
  if (!chatId) {
    spindle.toast.warning("Open a chat to play.", toastOptions);
    return;
  }
  try {
    if (commandId === "next") {
      const outcome = await service(userId).next(chatId);
      spindle.toast.success(outcome.summary || "Done.", toastOptions);
      notifyChanged(chatId, "act", userId);
    } else if (commandId === "undo") {
      await service(userId).undo(chatId);
      spindle.toast.info("Undid the last action.", toastOptions);
      notifyChanged(chatId, "undo", userId);
    }
  } catch (error) {
    spindle.toast.warning(errorMessage(error), toastOptions);
  }
});

spindle.permissions.onChanged(() => {
  syncInterceptor();
  notifyChanged(null, "permissions");
});

spindle.log.info(LOG_PREFIX + "backend ready");
