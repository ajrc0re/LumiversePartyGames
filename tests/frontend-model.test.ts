import { describe, expect, test } from "bun:test";
import { buildAction, inputBarModel, missingField, needsInput, primaryAction, requestIdFactory, setupProblem } from "../src/frontend-model";
import type { ActionDef, ChatGameState, GameView } from "../src/types";

const view: GameView = {
  gameId: "kings_cup",
  gameName: "Kings Cup",
  status: "active",
  turnNumber: 3,
  phase: "resolve",
  phaseLabel: "resolve",
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

  test("setup validation", () => {
    const game = { id: "kings_cup", name: "Kings Cup", description: "", minPlayers: 2, available: true };
    expect(setupProblem(undefined, [])).toBe("Choose a game.");
    expect(setupProblem({ ...game, available: false }, [])).toContain("not available");
    expect(setupProblem(game, [{ name: "Sam" }, { name: " " }])).toContain("at least 2");
    expect(setupProblem(game, [{ name: "Sam" }, { name: "Riley" }])).toBeNull();
  });

  test("request ids are unique without crypto.randomUUID", () => {
    const next = requestIdFactory("x");
    const ids = new Set(Array.from({ length: 200 }, () => next()));
    expect(ids.size).toBe(200);
    expect([...ids][0]).toStartWith("x-");
  });
});
