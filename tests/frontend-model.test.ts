import { describe, expect, test } from "bun:test";
import {
  buildAction,
  changedRules,
  inputBarModel,
  missingField,
  needsInput,
  primaryAction,
  requestIdFactory,
  seatCount,
  setupProblem,
  startInput,
  type SetupDraft,
} from "../src/frontend-model";
import type { ActionDef, ChatGameState, GameView } from "../src/types";

const view: GameView = {
  gameId: "kings_cup",
  gameName: "Kings Cup",
  status: "active",
  turnNumber: 3,
  phase: "resolve",
  phaseLabel: "resolve",
  direction: "forward",
  currentPlayerId: "p1",
  nextPlayerId: "p2",
  players: [
    { id: "p1", name: "Sam", kind: "user", active: true, current: true, next: false, badges: [] },
    { id: "p2", name: "Riley", kind: "character", active: true, current: false, next: true, badges: [] },
  ],
  headline: "Sam drew 2♣ — You",
  facts: [],
  recent: [],
};

function stateWith(actions: ActionDef[]): ChatGameState {
  return {
    chatId: "c1",
    games: [],
    gameDefaults: {},
    settings: { autoInject: true, injectionDepth: 1 },
    game: { sessionId: "s1", view, actions, canUndo: true, prompt: "" },
    warnings: [],
  };
}

const pick: ActionDef = {
  type: "resolve",
  label: "Pick who drinks",
  primary: true,
  fields: [{ name: "target", kind: "player", label: "Who drinks", required: true, choices: [{ id: "p2", label: "Riley" }] }],
};
const rule: ActionDef = {
  type: "resolve",
  label: "Record the rule",
  primary: true,
  fields: [{ name: "text", kind: "text", label: "New rule", required: false }],
};

describe("frontend model", () => {
  test("input bar acts when the next step needs no choice", () => {
    expect(inputBarModel(stateWith([{ type: "draw", label: "Draw a card", primary: true }]))).toEqual({ label: "Kings Cup: Draw a card (Sam)", mode: "act" });
    expect(inputBarModel(stateWith([rule]))).toEqual({ label: "Kings Cup: Record the rule (Sam)", mode: "act" });
  });

  test("input bar opens the panel when a choice is needed, no game runs, or the game is over", () => {
    expect(inputBarModel(stateWith([pick])).mode).toBe("open");
    expect(inputBarModel(stateWith([pick])).label).toBe("Kings Cup: Pick who drinks… (Sam)");
    expect(inputBarModel(null)).toEqual({ label: "Party Games: start a game", mode: "open" });
    expect(inputBarModel(stateWith([]))).toEqual({ label: "Kings Cup: game over", mode: "open" });
  });

  test("primary action and required inputs", () => {
    expect(primaryAction(stateWith([{ type: "a", label: "A" }, { ...pick }]))?.type).toBe("resolve");
    expect(needsInput(pick)).toBe(true);
    expect(needsInput(rule)).toBe(false);
    expect(missingField(pick, {})?.label).toBe("Who drinks");
    expect(missingField(pick, { target: "p2" })).toBeNull();
  });

  test("buildAction sends only filled fields and presets", () => {
    expect(buildAction(pick, { target: "p2", text: "ignored" })).toEqual({ type: "resolve", target: "p2" });
    expect(buildAction(rule, { text: "  No names " })).toEqual({ type: "resolve", text: "No names" });
    expect(buildAction(rule, { text: "   " })).toEqual({ type: "resolve" });
    expect(buildAction({ type: "choose", label: "Truth", preset: { choice: "truth" } })).toEqual({ type: "choose", choice: "truth" });
  });

  test("setup counts {{user}} plus named participants", () => {
    const game = { id: "kings_cup", name: "Kings Cup", description: "", minPlayers: 2, available: true, usesTurnOrder: true };
    const draft = (includeUser: boolean, participants: string[]) => ({ includeUser, participants });
    expect(setupProblem(undefined, draft(true, []))).toBe("Choose a game.");
    expect(setupProblem({ ...game, available: false }, draft(true, ["Riley"]))).toContain("not available");
    expect(setupProblem(game, draft(false, []))).toBe("Kings Cup needs at least 2 players; add some participants.");
    expect(setupProblem(game, draft(true, [" "]))).toBe("Kings Cup needs at least 2 players; add another participant.");
    expect(setupProblem(game, draft(true, ["Riley"]))).toBeNull();
    expect(setupProblem(game, draft(false, ["Riley", "Alex"]))).toBeNull();
    expect(seatCount(draft(true, ["Riley", "", "Alex "]))).toBe(3);
  });

  test("startInput drops blank participant fields", () => {
    const draft: SetupDraft = { gameId: "kings_cup", includeUser: true, participants: [" Riley ", "", "Alex"], turnOrder: "random", options: { endOnFourthKing: false }, optionsGameId: "kings_cup" };
    expect(startInput(draft)).toEqual({ gameId: "kings_cup", includeUser: true, participants: ["Riley", "Alex"], turnOrder: "random", options: { endOnFourthKing: false } });
  });

  test("changedRules keeps only real, complete edits", () => {
    const current = [
      { id: "7", label: "7", title: "Heaven", rule: "Last to raise a hand drinks.", effect: "none" },
      { id: "8", label: "8", title: "Mate", rule: "Pick a mate.", effect: "mate" },
      { id: "9", label: "9", title: "Rhyme", rule: "Rhyme.", effect: "none" },
    ];
    expect(changedRules(current, {
      "7": { title: " Thumb War ", rule: "Loser drinks.", effect: "none" },
      "8": { title: "Mate", rule: "Pick a mate.", effect: "mate" },
      "9": { title: "", rule: "Rhyme.", effect: "none" },
    })).toEqual({ "7": { title: "Thumb War", rule: "Loser drinks.", effect: "none" } });
    expect(changedRules(current, { "8": { title: "Mate", rule: "Pick a mate.", effect: "target" } })).toEqual({
      "8": { title: "Mate", rule: "Pick a mate.", effect: "target" },
    });
  });

  test("request ids are unique without crypto.randomUUID", () => {
    const next = requestIdFactory("x");
    const ids = new Set(Array.from({ length: 200 }, () => next()));
    expect(ids.size).toBe(200);
    expect([...ids][0]).toStartWith("x-");
  });
});
