import { describe, expect, test } from "bun:test";
import { IllegalActionError } from "../src/engine/core";
import { cardLabel, DEFAULT_RULES, kingsCup, normalizeRules } from "../src/games/kings-cup";
import { act, kingsCupGame, playTurn, resolveFor, stackDeck } from "./helpers";

describe("Kings Cup deck", () => {
  test("never repeats a card and empties after exactly 52 draws", () => {
    let state = kingsCupGame(["Sam", "Riley", "Alex"], 99, { endOnFourthKing: false });
    const seen = new Set<string>();
    for (let draw = 0; draw < 52; draw += 1) {
      expect(state.status).toBe("active");
      state = act(state, { type: "draw" });
      const label = cardLabel(state.turnCard!.card);
      expect(seen.has(label)).toBe(false);
      seen.add(label);
      state = act(state, resolveFor(state));
      state = act(state, { type: "end_turn" });
    }
    expect(seen.size).toBe(52);
    expect(state.deck.remaining.length).toBe(0);
    expect(state.status).toBe("ended");
    expect(state.endReason).toContain("deck ran out");
  });

  test("the shuffle is fixed at setup and reproducible from the seed", () => {
    expect(kingsCupGame(undefined, 5).deck.remaining).toEqual(kingsCupGame(undefined, 5).deck.remaining);
    expect(kingsCupGame(undefined, 5).deck.remaining).not.toEqual(kingsCupGame(undefined, 6).deck.remaining);
  });
});

describe("Kings Cup kings", () => {
  test("the 4th King ends the game and the first three fill the cup", () => {
    let state = stackDeck(kingsCupGame(), ["K", "K", "K", "K"]);
    state = playTurn(state);
    state = playTurn(state);
    state = playTurn(state);
    expect(state.kingsDrawn).toBe(3);
    expect(state.cup).toEqual(["p1", "p2", "p3"]);
    expect(state.status).toBe("active");
    state = act(state, { type: "draw" });
    expect(state.kingsDrawn).toBe(4);
    expect(state.status).toBe("ended");
    expect(state.phase).toBe("game_over");
    expect(state.endReason).toBe("Sam drew the 4th King and drinks the King's Cup.");
    expect(kingsCup.legalActions(state)).toEqual([]);
    expect(() => act(state, { type: "draw" })).toThrow(IllegalActionError);
  });
});

describe("Kings Cup persistent roles", () => {
  test("a Queen makes the drawer Question Master until the next Queen", () => {
    let state = stackDeck(kingsCupGame(), ["Q", "3", "Q"]);
    state = playTurn(state);
    expect(state.questionMaster).toBe("p1");
    state = playTurn(state);
    expect(state.questionMaster).toBe("p1");
    state = playTurn(state);
    expect(state.questionMaster).toBe("p3");
  });

  test("an 8 records a mate pair once", () => {
    let state = stackDeck(kingsCupGame(), ["8", "8"]);
    state = act(state, { type: "draw" });
    expect(() => act(state, { type: "resolve" })).toThrow("Choose a player");
    expect(() => act(state, { type: "resolve", target: "p1" })).toThrow("someone other than Sam");
    state = act(state, { type: "resolve", target: "p2" });
    state = act(state, { type: "end_turn" });
    state = act(state, { type: "draw" });
    state = act(state, { type: "resolve", target: "p1" });
    expect(state.mates).toEqual([["p1", "p2"]]);
  });

  test("a Jack records an optional rule", () => {
    let state = stackDeck(kingsCupGame(), ["J", "J"]);
    state = act(state, { type: "draw" });
    state = act(state, { type: "resolve", text: "  No   first names " });
    expect(state.customRules).toEqual([{ text: "No first names", by: "p1", turn: 1 }]);
    state = act(state, { type: "end_turn" });
    state = act(state, { type: "draw" });
    state = act(state, { type: "resolve" });
    expect(state.customRules.length).toBe(1);
    expect(state.turnCard?.resolved).toBe(true);
  });

  test("a 2 records who was picked to drink", () => {
    let state = stackDeck(kingsCupGame(), ["2"]);
    state = act(state, { type: "draw" });
    state = act(state, { type: "resolve", target: "p3" });
    expect(state.turnCard?.target).toBe("p3");
    expect(state.log.at(-1)?.text).toBe("Sam picked Alex to drink.");
  });
});

describe("Kings Cup phases", () => {
  test("illegal actions are rejected per phase", () => {
    const start = stackDeck(kingsCupGame(), ["7"]);
    expect(() => act(start, { type: "resolve" })).toThrow('"resolve" is not allowed during the draw phase.');
    expect(() => act(start, { type: "end_turn" })).toThrow(IllegalActionError);
    const drawn = act(start, { type: "draw" });
    expect(() => act(drawn, { type: "draw" })).toThrow('"draw" is not allowed during the resolve phase.');
    expect(() => act(drawn, { type: "end_turn" })).toThrow(IllegalActionError);
    expect(() => act(drawn, { type: "resolve", target: "p2" })).toThrow("does not take a choice");
    expect(() => act(drawn, { type: "shuffle" })).toThrow("is not an action in this game");
  });

  test("only the current player can act", () => {
    const state = kingsCupGame();
    expect(() => act(state, { type: "draw", actor: "p2" })).toThrow("It is Sam's turn, not Riley's.");
    expect(act(state, { type: "draw", actor: "p1" }).phase).toBe("resolve");
  });

  test("apply never mutates its input", () => {
    const state = kingsCupGame();
    const before = JSON.stringify(state);
    playTurn(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  test("legal actions follow the phase and the card's effect", () => {
    let state = stackDeck(kingsCupGame(), ["2", "7"]);
    expect(kingsCup.legalActions(state).map((action) => action.type)).toEqual(["draw"]);
    state = act(state, { type: "draw" });
    const [resolve] = kingsCup.legalActions(state);
    expect(resolve?.fields?.[0]).toMatchObject({ name: "target", required: true });
    expect(resolve?.fields?.[0]?.choices?.map((choice) => choice.id)).toEqual(["p2", "p3"]);
    state = act(state, { type: "resolve", target: "p2" });
    expect(kingsCup.legalActions(state)).toEqual([
      { type: "end_turn", label: "Next turn", primary: true, description: "Pass the deck to Riley." },
    ]);
    state = act(state, { type: "end_turn" });
    state = act(state, { type: "draw" });
    expect(kingsCup.legalActions(state)[0]?.fields).toBeUndefined();
  });
});

describe("Kings Cup options", () => {
  test("rule overrides are cleaned and Kings stay King's Cup", () => {
    const rules = normalizeRules({
      "7": { title: "  Thumb  War ", rule: "Loser drinks." },
      "3": { effect: "kings_cup" },
      K: { effect: "none", title: "Big Cup" },
      Z: { title: "nope" },
    });
    expect(rules["7"]).toEqual({ title: "Thumb War", rule: "Loser drinks.", effect: "none" });
    expect(rules["3"].effect).toBe("none");
    expect(rules.K).toEqual({ title: "Big Cup", rule: DEFAULT_RULES.K.rule, effect: "kings_cup" });
    expect(Object.keys(rules)).toHaveLength(13);
  });
});

describe("Kings Cup prompt block", () => {
  test("draw phase", () => {
    const state = kingsCupGame();
    expect(kingsCup.promptBlock(state)).toMatchSnapshot();
  });

  test("resolve phase with roles and rules", () => {
    let state = stackDeck(kingsCupGame(), ["Q", "8", "J", "K", "7"]);
    state = playTurn(state); // Sam: Queen
    state = act(state, { type: "draw" }); // Riley: 8
    state = act(state, { type: "resolve", target: "p1" });
    state = act(state, { type: "end_turn" });
    state = act(state, { type: "draw" }); // Alex: Jack
    state = act(state, { type: "resolve", text: "No first names" });
    state = act(state, { type: "end_turn" });
    state = playTurn(state); // Sam: King
    state = act(state, { type: "draw" }); // Riley: 7
    const block = kingsCup.promptBlock(state);
    expect(block).toContain("Riley drew 7");
    expect(block).toContain("(Heaven): Last to raise a hand drinks.");
    expect(block).toContain("Kings drawn: 1/4. The King's Cup holds pours from Sam.");
    expect(block).toContain("Question Master: Sam.");
    expect(block).toContain("Mates: Riley ↔ Sam.");
    expect(block).toContain("Rules in play: 1. No first names (Alex)");
    expect(block).toContain("Next up: Alex.");
    expect(block).toMatchSnapshot();
  });

  test("pending choice and end of turn", () => {
    let state = stackDeck(kingsCupGame(), ["2"]);
    state = act(state, { type: "draw" });
    expect(kingsCup.promptBlock(state)).toContain("Waiting for Sam to pick who drinks. Do not pick for them.");
    state = act(state, { type: "resolve", target: "p2" });
    expect(kingsCup.promptBlock(state)).toMatchSnapshot();
  });

  test("game over", () => {
    let state = stackDeck(kingsCupGame(["Sam", "Riley"]), ["K", "K", "K", "K"]);
    for (let turn = 0; turn < 3; turn += 1) state = playTurn(state);
    state = act(state, { type: "draw" });
    expect(kingsCup.promptBlock(state)).toMatchSnapshot();
  });
});

describe("Kings Cup view", () => {
  test("shows the active player, next up, and badges", () => {
    let state = stackDeck(kingsCupGame(), ["Q", "8"]);
    state = playTurn(state);
    state = act(state, { type: "draw" });
    state = act(state, { type: "resolve", target: "p3" });
    const view = kingsCup.view(state);
    expect(view.currentPlayerId).toBe("p2");
    expect(view.nextPlayerId).toBe("p3");
    expect(view.phaseLabel).toBe("end of turn");
    expect(view.headline).toMatch(/^Riley drew 8. — Mate$/);
    expect(view.players.find((player) => player.id === "p1")?.badges).toEqual(["Question Master"]);
    expect(view.players.find((player) => player.id === "p3")?.badges).toEqual(["Mate: Riley"]);
    expect(view.facts.find((fact) => fact.label === "Cards left")?.value).toBe("50");
  });
});
