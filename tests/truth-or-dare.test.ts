import { describe, expect, test } from "bun:test";
import { applyAction, createPlayers, currentPlayer, IllegalActionError } from "../src/engine/core";
import { mulberry32 } from "../src/engine/rng";
import { appendAction, createSession, deriveGame, Timeline, undoLast } from "../src/engine/session";
import { pickPlayer, truthOrDare, type TruthOrDareState } from "../src/games/truth-or-dare";
import type { GameAction } from "../src/types";

function game(names = ["Sam", "Riley", "Alex", "Jo"], seed = 1, userFirst = true): TruthOrDareState {
  return truthOrDare.setup(
    createPlayers(names.map((name, index) => ({ name, kind: userFirst && index === 0 ? "user" : "character" }))),
    truthOrDare.normalizeOptions({}),
    mulberry32(seed),
  );
}

function act(state: TruthOrDareState, action: GameAction, seed = 0): TruthOrDareState {
  return applyAction(truthOrDare, state, action, mulberry32(seed));
}

const next = (state: TruthOrDareState, seed = 0) => act(state, { type: "next_round" }, seed);
const answering = (state: TruthOrDareState) => currentPlayer(state).id;

describe("Truth or Dare roles", () => {
  test("setup picks a random asker and a different player to answer, reproducibly", () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const state = game(undefined, seed);
      expect(state.asker).not.toBe(answering(state));
      expect(game(undefined, seed)).toEqual(state);
    }
    const askers = new Set(Array.from({ length: 40 }, (_, seed) => game(undefined, seed).asker));
    expect(askers.size).toBe(4);
  });

  test("whoever answered asks next, and the new player is never the asker", () => {
    let state = game();
    for (let round = 1; round <= 40; round += 1) {
      const answered = answering(state);
      state = next(state);
      expect(state.asker).toBe(answered);
      expect(answering(state)).not.toBe(state.asker);
      expect(state.turn.number).toBe(round + 1);
    }
  });

  test("everyone gets picked to answer over time", () => {
    let state = game();
    const answered = new Set<string>();
    for (let round = 0; round < 60; round += 1) {
      answered.add(answering(state));
      state = next(state);
    }
    expect(answered).toEqual(new Set(["p1", "p2", "p3", "p4"]));
  });

  test("with two players they take turns asking each other", () => {
    let state = game(["Sam", "Riley"]);
    const first = state.asker;
    state = next(state);
    expect(state.asker).not.toBe(first);
    state = next(state);
    expect(state.asker).toBe(first);
  });

  test("each round's pick depends only on the round, not on the event seed", () => {
    const state = game();
    expect(answering(next(state, 1))).toBe(answering(next(state, 999)));
    expect(pickPlayer(state, "p1", 7)).toEqual(pickPlayer(state, "p1", 7));
  });

  test("only next_round is an action, and the turn order cannot be reversed", () => {
    const state = game();
    expect(truthOrDare.legalActions(state)).toEqual([{
      type: "next_round",
      label: "Next round",
      description: currentPlayer(state).name + " asks next; the game picks who answers.",
      primary: true,
    }]);
    expect(() => act(state, { type: "draw" })).toThrow("is not an action in this game");
    expect(() => act(state, { type: "set_direction", choice: "reversed" })).toThrow("Truth or Dare has no fixed turn order to reverse.");
    const other = state.players.find((player) => player.id !== answering(state))!;
    expect(() => act(state, { type: "next_round", actor: other.id })).toThrow(IllegalActionError);
  });

  test("apply never mutates its input", () => {
    const state = game();
    const before = JSON.stringify(state);
    next(next(state));
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("Truth or Dare view and prompt", () => {
  test("the view names who asks and who answers", () => {
    const state = game();
    const view = truthOrDare.view(state);
    const asker = state.players.find((player) => player.id === state.asker)!.name;
    const player = currentPlayer(state).name;
    expect(view.roles).toEqual([{ label: "Asking", playerId: state.asker }, { label: "Answering", playerId: answering(state) }]);
    expect(view.headline).toBe(asker + " asks " + player);
    expect(view.turnNoun).toBe("Round");
    expect(view.direction).toBeUndefined();
    expect(view.players.find((entry) => entry.id === state.asker)?.badges).toEqual(["Asking"]);
    expect(view.players.find((entry) => entry.current)?.badges).toEqual(["Answering"]);
    expect(view.recent).toEqual(["Round 1: " + asker + " asks " + player + "."]);
  });

  test("the prompt leaves the content to the story and protects the user's choices", () => {
    // The first seed where Sam (the user) answers in round 1.
    const seed = Array.from({ length: 100 }, (_, index) => index).find((candidate) => currentPlayer(game(undefined, candidate)).name === "Sam")!;
    const state = game(undefined, seed);
    expect(currentPlayer(state).name).toBe("Sam");
    const block = truthOrDare.promptBlock(state);
    expect(block).toContain("Sam is played by the user: let them choose and answer; do not decide for them.");
    expect(block).toMatchSnapshot();
  });

  test("a later round mentions the last one", () => {
    const state = next(next(game(undefined, 2, false)));
    const block = truthOrDare.promptBlock(state);
    expect(block).not.toContain("played by the user");
    expect(block).toMatchSnapshot();
  });
});

describe("Truth or Dare in a session", () => {
  const players = ["Sam", "Riley", "Alex", "Jo"].map((name) => ({ name, kind: "character" as const }));

  test("rolling back a round and replaying it picks the same player", () => {
    let session = createSession(truthOrDare, players, {}, mulberry32(4), { id: "s", now: 0 });
    session = appendAction(truthOrDare, session, new Timeline([{ id: "m1", swipeId: 0 }]), { type: "next_round" }, { id: "e1", seed: 11, now: 1 }).session;
    const first = deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline([{ id: "m1", swipeId: 0 }])).state;
    // Swiping m1 rolls the round back; advancing again on the new swipe lands on the same pick.
    const swiped = [{ id: "m1", swipeId: 1 }];
    expect(deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline(swiped)).state.turn.number).toBe(1);
    session = appendAction(truthOrDare, session, new Timeline(swiped), { type: "next_round" }, { id: "e2", seed: 77, now: 2 }).session;
    const replayed = deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline(swiped)).state;
    expect(answering(replayed)).toBe(answering(first));
    expect(replayed.asker).toBe(first.asker);
    // Undo does the same.
    const undone = undoLast(truthOrDare, session, new Timeline(swiped))!;
    expect(deriveGame<TruthOrDareState>(truthOrDare, undone, new Timeline(swiped)).state.turn.number).toBe(1);
  });

  test("regenerating the narration keeps the round", () => {
    let session = createSession(truthOrDare, players, {}, mulberry32(5), { id: "s", now: 0 });
    session = appendAction(truthOrDare, session, new Timeline([{ id: "m1", swipeId: 0 }]), { type: "next_round" }, { id: "e1", seed: 1, now: 1 }).session;
    const states = [0, 1, 2].map((swipe) =>
      deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline([{ id: "m1", swipeId: 0 }, { id: "m2", swipeId: swipe }])).state);
    expect(states[1]).toEqual(states[0]!);
    expect(states[2]).toEqual(states[0]!);
    expect(states[0]!.turn.number).toBe(2);
  });
});
