import type { PartyChanged, PartyReply, PartyRequestAction, StartGameInput } from "../types";
import type { PartyGamesService } from "./service";

/** Requests that change a chat's game, so other open panels should refresh. */
const MUTATING: ReadonlySet<PartyRequestAction> = new Set(["start", "act", "undo", "end"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the setup screen's start request; unknown or mistyped fields fall back to safe values. */
export function parseStartInput(input: Record<string, unknown>): StartGameInput {
  const participants = Array.isArray(input.participants)
    ? input.participants.filter((name): name is string => typeof name === "string" && name.trim().length > 0).slice(0, 32)
    : [];
  return {
    gameId: typeof input.gameId === "string" ? input.gameId : "",
    includeUser: input.includeUser === true,
    participants,
    turnOrder: input.turnOrder === "random" ? "random" : "listed",
    options: record(input.options),
  };
}

export interface RequestOutcome {
  /** Null when the payload was not a Party Games request. */
  reply: PartyReply | null;
  /** Set after a successful change, so other open panels refresh. */
  changed: PartyChanged | null;
}

/** Routes one frontend request to the user's service. Never throws. */
export async function handlePartyRequest(raw: unknown, service: PartyGamesService): Promise<RequestOutcome> {
  const request = record(raw);
  if (request.type !== "party:request" || typeof request.requestId !== "string" || typeof request.action !== "string") {
    return { reply: null, changed: null };
  }
  const requestId = request.requestId;
  const action = request.action as PartyRequestAction;
  const input = record(request.input);
  const chatId = typeof input.chatId === "string" && input.chatId ? input.chatId : undefined;
  const requireChat = (): string => {
    if (!chatId) throw new Error("Open a chat to play.");
    return chatId;
  };
  try {
    let result: unknown;
    switch (action) {
      case "state":
        result = await service.state(requireChat());
        break;
      case "user-name":
        result = await service.userName(requireChat());
        break;
      case "start":
        result = await service.start(requireChat(), parseStartInput(input));
        break;
      case "act":
        result = (await service.act(requireChat(), input.action)).state;
        break;
      case "undo":
        result = await service.undo(requireChat());
        break;
      case "end":
        result = await service.end(requireChat());
        break;
      case "save-settings":
        await service.saveSettings(input.settings);
        result = chatId ? await service.state(chatId) : null;
        break;
      case "save-defaults":
        await service.saveDefaults(typeof input.gameId === "string" ? input.gameId : "", input.options);
        result = chatId ? await service.state(chatId) : null;
        break;
      default:
        throw new Error("Unknown Party Games action.");
    }
    return {
      reply: { type: "party:reply", requestId, result },
      changed: MUTATING.has(action) ? { type: "party:changed", chatId: chatId ?? null, reason: action } : null,
    };
  } catch (error) {
    return { reply: { type: "party:reply", requestId, error: errorMessage(error) }, changed: null };
  }
}
