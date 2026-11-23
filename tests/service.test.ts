import { describe, expect, test } from "bun:test";
import type { InterceptorResultDTO, LlmMessageDTO } from "lumiverse-spindle-types";
import { handlePartyRequest } from "../src/backend/requests";
import { METADATA_KEY, PartyGamesService } from "../src/backend/service";
import { FakeHost } from "./fake-host";

const PLAYERS = [{ name: "Sam", kind: "user" as const }, { name: "Riley", kind: "character" as const }];

async function started(host = new FakeHost(), userId?: string) {
  const chat = host.addChat("c1");
  const service = new PartyGamesService(host, userId);
  await service.start("c1", "kings_cup", PLAYERS, {});
  return { host, chat, service };
}

describe("PartyGamesService", () => {
  test("starts a game and keeps unrelated chat metadata", async () => {
    const { host, chat, service } = await started();
    expect(chat.metadata.unrelated).toBe("keep me");
    expect((chat.metadata[METADATA_KEY] as { session: { gameId: string } }).session.gameId).toBe("kings_cup");
    const state = await service.state("c1");
    expect(state.game?.view.currentPlayerId).toBe("p1");
    expect(state.game?.actions.map((action) => action.type)).toEqual(["draw"]);
    expect(state.game?.canUndo).toBe(false);
    expect(host.casCalls).toBe(1);
  });

  test("refuses to start a second game", async () => {
    const { service } = await started();
    await expect(service.start("c1", "kings_cup", PLAYERS, {})).rejects.toThrow("already running");
  });

  test("applies actions and reports the newest log line", async () => {
    const { service } = await started();
    const outcome = await service.act("c1", { type: "draw" });
    expect(outcome.summary).toMatch(/^Sam drew /);
    expect(outcome.state.game?.view.phase).toBe("resolve");
    expect(outcome.state.game?.canUndo).toBe(true);
  });

  test("rejects illegal actions without writing", async () => {
    const { host, service } = await started();
    const before = host.casCalls;
    await expect(service.act("c1", { type: "end_turn" })).rejects.toThrow("not allowed during the draw phase");
    expect(host.casCalls).toBe(before);
  });

  test("retries when the chat changes between read and write", async () => {
    const { host, chat, service } = await started();
    host.conflicts = 2;
    await service.act("c1", { type: "draw" });
    expect(chat.metadata.touched).toBeDefined();
    expect((await service.state("c1")).game?.view.phase).toBe("resolve");
  });

  test("gives up after repeated conflicts", async () => {
    const { host, service } = await started();
    host.conflicts = 10;
    await expect(service.act("c1", { type: "draw" })).rejects.toThrow("kept changing");
  });

  test("falls back to a full metadata write on hosts without conditional writes", async () => {
    const host = new FakeHost();
    host.capabilities.clear();
    const { chat, service } = await started(host);
    await service.act("c1", { type: "draw" });
    expect(host.casCalls).toBe(0);
    expect(host.replaceCalls).toBe(2);
    expect(chat.metadata.unrelated).toBe("keep me");
  });

  test("next runs the primary action and stops at required choices", async () => {
    const { service } = await started();
    let outcome = await service.next("c1");
    expect(outcome.state.game?.view.phase).toBe("resolve");
    const needsChoice = outcome.state.game?.actions[0]?.fields?.some((field) => field.required);
    if (needsChoice) {
      await expect(service.next("c1")).rejects.toThrow("needs a choice");
    } else {
      outcome = await service.next("c1");
      expect(outcome.state.game?.view.phase).toBe("end_turn");
    }
  });

  test("undo and end", async () => {
    const { chat, service } = await started();
    await service.act("c1", { type: "draw" });
    expect((await service.undo("c1")).game?.view.phase).toBe("draw");
    await expect(service.undo("c1")).rejects.toThrow("nothing to undo");
    expect((await service.end("c1")).game).toBeNull();
    expect(chat.metadata.unrelated).toBe("keep me");
  });

  test("swiping the message before a draw rolls the draw back", async () => {
    const { chat, service } = await started();
    await service.act("c1", { type: "draw" });
    chat.messages = [{ id: "greeting", swipeId: 1 }];
    expect((await service.state("c1")).game?.view.phase).toBe("draw");
    chat.messages = [{ id: "greeting", swipeId: 0 }, { id: "reply", swipeId: 3 }];
    expect((await service.state("c1")).game?.view.phase).toBe("resolve");
  });

  test("forwards the operator user id to every host call", async () => {
    const { host, service } = await started(new FakeHost(), "user-42");
    await service.act("c1", { type: "draw" });
    expect(host.userIds.length).toBeGreaterThan(0);
    expect(host.userIds.every((id) => id === "user-42")).toBe(true);
  });

  test("reports missing permissions instead of throwing", async () => {
    const host = new FakeHost();
    host.permissions.delete("chat_mutation");
    host.addChat("c1");
    const state = await new PartyGamesService(host).state("c1");
    expect(state.game).toBeNull();
    expect(state.warnings[0]).toContain("chat_mutation");
  });

  test("suggests the persona and characters as players", async () => {
    const host = new FakeHost();
    host.addChat("c1");
    const service = new PartyGamesService(host);
    expect((await service.suggestPlayers("c1")).players).toEqual([
      { name: "Sam", kind: "user" },
      { name: "Riley", kind: "character" },
    ]);
    host.macroText = "Sam␞Alex␞Alex, Jo, sam";
    expect((await service.suggestPlayers("c1")).players.map((player) => player.name)).toEqual(["Sam", "Alex", "Jo"]);
    host.macroText = "{{user}}␞{{char}}␞";
    expect((await service.suggestPlayers("c1")).players).toEqual([]);
  });
});

describe("prompt injection", () => {
  const prompt: LlmMessageDTO[] = [
    { role: "system", content: "You are a narrator." },
    { role: "assistant", content: "Welcome!" },
    { role: "user", content: "Let's play." },
  ];

  test("injects one block at the configured depth with a breakdown entry", async () => {
    const { service } = await started();
    const result = await service.intercept(prompt, { chatId: "c1", generationType: "normal" }) as InterceptorResultDTO;
    expect(result.messages.length).toBe(4);
    expect(result.messages[2]?.role).toBe("system");
    expect(String(result.messages[2]?.content)).toContain("[Kings Cup — turn 1]");
    expect(result.breakdown).toEqual([{ messageIndex: 2, name: "Party Games: game state" }]);
    await service.saveSettings({ injectionDepth: 0 });
    const atEnd = await service.intercept(prompt, { chatId: "c1" }) as InterceptorResultDTO;
    expect(atEnd.messages.at(-1)?.role).toBe("system");
  });

  test("injects nothing without a game, for quiet generations, or when turned off", async () => {
    const host = new FakeHost();
    host.addChat("empty");
    const service = new PartyGamesService(host);
    expect(await service.intercept(prompt, { chatId: "empty" })).toBe(prompt);
    const { service: playing } = await started();
    expect(await playing.intercept(prompt, { chatId: "c1", generationType: "quiet" })).toBe(prompt);
    await playing.saveSettings({ autoInject: false });
    expect(await playing.intercept(prompt, { chatId: "c1" })).toBe(prompt);
  });

  test("the message being regenerated does not count as an anchor", async () => {
    const { chat, service } = await started();
    chat.messages = [{ id: "greeting", swipeId: 0 }, { id: "reply", swipeId: 0 }];
    await service.act("c1", { type: "draw" });
    // Regenerating "reply", which the draw came after: the draw must not be narrated.
    expect(await service.promptFor("c1", "reply")).toContain("has not drawn a card yet");
    // Regenerating a later narration keeps it.
    chat.messages.push({ id: "narration", swipeId: 0 });
    expect(await service.promptFor("c1", "narration")).toContain("Sam drew");
  });

  test("never breaks generation when something fails", async () => {
    const { host, service } = await started();
    host.chats.clear();
    expect(await service.intercept(prompt, { chatId: "c1" })).toBe(prompt);
    expect(host.warnings.at(-1)).toContain("prompt injection skipped");
  });
});

describe("frontend request routing", () => {
  test("replies with state and announces changes only for mutations", async () => {
    const host = new FakeHost();
    host.addChat("c1");
    const service = new PartyGamesService(host);
    const read = await handlePartyRequest({ type: "party:request", requestId: "r1", action: "state", input: { chatId: "c1" } }, service);
    expect(read.reply).toMatchObject({ type: "party:reply", requestId: "r1" });
    expect(read.changed).toBeNull();
    const start = await handlePartyRequest({
      type: "party:request",
      requestId: "r2",
      action: "start",
      input: { chatId: "c1", gameId: "kings_cup", players: [{ name: "Sam", kind: "user" }, { name: "Riley" }, { name: "  " }, 5] },
    }, service);
    expect(start.reply?.error).toBeUndefined();
    expect(start.changed).toEqual({ type: "party:changed", chatId: "c1", reason: "start" });
    const players = (start.reply?.result as { game: { view: { players: Array<{ name: string; kind: string }> } } }).game.view.players;
    expect(players.map((player) => [player.name, player.kind])).toEqual([["Sam", "user"], ["Riley", "npc"]]);
  });

  test("turns failures into error replies and ignores foreign payloads", async () => {
    const host = new FakeHost();
    host.addChat("c1");
    const service = new PartyGamesService(host);
    const failed = await handlePartyRequest({ type: "party:request", requestId: "r3", action: "act", input: { chatId: "c1", action: { type: "draw" } } }, service);
    expect(failed.reply).toEqual({ type: "party:reply", requestId: "r3", error: "No game is running in this chat." });
    expect(failed.changed).toBeNull();
    const noChat = await handlePartyRequest({ type: "party:request", requestId: "r4", action: "state", input: {} }, service);
    expect(noChat.reply?.error).toBe("Open a chat to play.");
    expect(await handlePartyRequest({ type: "other" }, service)).toEqual({ reply: null, changed: null });
  });
});
