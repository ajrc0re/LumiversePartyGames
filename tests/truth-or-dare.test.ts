import { describe, expect, test } from "bun:test";
import { applyAction, createPlayers, currentPlayer, IllegalActionError } from "../src/engine/core";
import { mulberry32 } from "../src/engine/rng";
import { appendAction, createSession, deriveGame, Timeline } from "../src/engine/session";
import {
  BUNDLED_DARES,
  BUNDLED_TRUTHS,
  promptPool,
  promptText,
  truthOrDare,
  type TruthOrDareState,
} from "../src/games/truth-or-dare";
import type { GameAction } from "../src/types";

function game(options: unknown = {}, names = ["Sam", "Riley", "Alex"], seed = 1): TruthOrDareState {
  return truthOrDare.setup(
    createPlayers(names.map((name, index) => ({ name, kind: index === 0 ? "user" : "character" }))),
    truthOrDare.normalizeOptions(options),
    mulberry32(seed),
  );
}

function act(state: TruthOrDareState, action: GameAction, seed = 0): TruthOrDareState {
  return applyAction(truthOrDare, state, action, mulberry32(seed));
}

/** Only these prompts, in this order: makes draws predictable. */
function only(truths: string[], dares: string[], extra: Record<string, unknown> = {}): TruthOrDareState {
  const state = game({ tiers: [], customTruths: truths, customDares: dares, ...extra });
  const order = (list: string[], prefix: string) => list.map((text, index) => ({ id: prefix + String(index + 1), text, custom: true }));
  return { ...state, truths: { remaining: order(truths, "ct-"), drawn: [] }, dares: { remaining: order(dares, "cd-"), drawn: [] } };
}

describe("Truth or Dare bundled prompts", () => {
  test("ship with unique ids in every tier", () => {
    const ids = [...BUNDLED_TRUTHS, ...BUNDLED_DARES].map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tier of ["mild", "bold", "wild"]) {
      expect(BUNDLED_TRUTHS.filter((prompt) => prompt.tier === tier).length).toBeGreaterThanOrEqual(10);
      expect(BUNDLED_DARES.filter((prompt) => prompt.tier === tier).length).toBeGreaterThanOrEqual(10);
    }
  });

  test("pools follow the tiers, disabled ids, and custom prompts", () => {
    const options = truthOrDare.normalizeOptions({
      tiers: ["mild", "nope"],
      disabled: [BUNDLED_TRUTHS[0]!.id, "unknown-id"],
      customTruths: ["  Who here snores?  ", "who here snores?", "", 7],
    });
    expect(options.tiers).toEqual(["mild"]);
    expect(options.disabled).toEqual([BUNDLED_TRUTHS[0]!.id]);
    expect(options.customTruths).toEqual(["Who here snores?"]);
    const truths = promptPool(options, "truth");
    expect(truths.some((prompt) => prompt.id === BUNDLED_TRUTHS[0]!.id)).toBe(false);
    expect(truths.every((prompt) => prompt.custom || prompt.tier === "mild")).toBe(true);
    expect(truths.at(-1)).toEqual({ id: "ct-1", text: "Who here snores?", custom: true });
  });

  test("defaults are mild and bold with a drinking forfeit", () => {
    expect(truthOrDare.defaultOptions()).toMatchObject({ tiers: ["mild", "bold"], refusals: "forfeit", forfeit: "drinks", strikeLimit: 3 });
    expect(truthOrDare.normalizeOptions({ forfeit: "  takes a shot!  ", strikeLimit: 40, refusals: "maybe" })).toMatchObject({
      forfeit: "takes a shot",
      strikeLimit: 9,
      refusals: "forfeit",
    });
  });

  test("setup refuses a game with nothing to play", () => {
    expect(() => game({ tiers: [] })).toThrow("no prompts");
    expect(game({ tiers: [], customDares: ["Hop on one foot."] }).dares.remaining.length).toBe(1);
  });
});

describe("Truth or Dare turns", () => {
  test("choose, answer, next turn", () => {
    let state = only(["What scares you?"], ["Sing."]);
    expect(truthOrDare.legalActions(state).map((action) => action.label)).toEqual(["Truth", "Dare", "Random"]);
    state = act(state, { type: "choose", choice: "truth" });
    expect(state.phase).toBe("prompt");
    expect(state.current).toMatchObject({ kind: "truth", player: "p1", random: false, outcome: "pending" });
    expect(truthOrDare.legalActions(state).map((action) => action.type)).toEqual(["perform", "refuse"]);
    state = act(state, { type: "perform" });
    expect(state.log.at(-1)?.text).toBe("Sam answered the truth.");
    state = act(state, { type: "end_turn" });
    expect(currentPlayer(state).name).toBe("Riley");
    expect(state.previous?.outcome).toBe("done");
    expect(state.tally.p1).toEqual({ truths: 1, dares: 0, refused: 0 });
  });

  test("random picks only from pools that still have prompts, reproducibly", () => {
    const noTruths = only([], ["Sing.", "Dance."]);
    for (let seed = 0; seed < 20; seed += 1) {
      expect(act(noTruths, { type: "choose", choice: "random" }, seed).current?.kind).toBe("dare");
    }
    const both = only(["Q1", "Q2"], ["D1", "D2"]);
    const kinds = new Set(Array.from({ length: 30 }, (_, seed) => act(both, { type: "choose", choice: "random" }, seed).current?.kind));
    expect(kinds).toEqual(new Set(["truth", "dare"]));
    expect(act(both, { type: "choose", choice: "random" }, 7).current).toEqual(act(both, { type: "choose", choice: "random" }, 7).current);
    expect(act(both, { type: "choose", choice: "random" }, 7).current?.random).toBe(true);
  });

  test("an empty pool cannot be chosen", () => {
    const state = only([], ["Sing."]);
    expect(truthOrDare.legalActions(state).map((action) => action.label)).toEqual(["Dare", "Random"]);
    expect(() => act(state, { type: "choose", choice: "truth" })).toThrow("no truths left");
    expect(() => act(state, { type: "choose", choice: "maybe" })).toThrow(IllegalActionError);
  });

  test("{player} and {other} are filled in, and {other} is never the player", () => {
    const state = only([], ["{player} dances with {other}."]);
    for (let seed = 0; seed < 20; seed += 1) {
      const next = act(state, { type: "choose", choice: "dare" }, seed);
      expect(next.current?.other).not.toBe("p1");
      expect(next.current?.other).not.toBeNull();
      expect(promptText(next, next.current!)).toMatch(/^Sam dances with (Riley|Alex)\.$/);
    }
    expect(act(only(["Plain?"], []), { type: "choose", choice: "truth" }).current?.other).toBeNull();
  });

  test("prompts never repeat within a game", () => {
    let state = game({ tiers: ["mild", "bold", "wild"] }, ["Sam", "Riley"], 9);
    const total = state.truths.remaining.length + state.dares.remaining.length;
    const seen = new Set<string>();
    while (state.status === "active") {
      state = act(state, { type: "choose", choice: "random" }, seen.size);
      const id = state.current!.prompt.id;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      state = act(state, { type: "perform" });
      state = act(state, { type: "end_turn" });
    }
    expect(seen.size).toBe(total);
    expect(state.endReason).toContain("Out of prompts");
  });

  test("swap discards the prompt and draws another of the same kind", () => {
    let state = only([], ["D1", "D2"]);
    state = act(state, { type: "choose", choice: "dare" });
    expect(state.current?.prompt.text).toBe("D1");
    state = act(state, { type: "swap" });
    expect(state.current?.prompt.text).toBe("D2");
    expect(state.dares.drawn.map((prompt) => prompt.text)).toEqual(["D1", "D2"]);
    expect(truthOrDare.legalActions(state).some((action) => action.type === "swap")).toBe(false);
    expect(() => act(state, { type: "swap" })).toThrow("no other dares left");
  });

  test("illegal actions are rejected per phase and per player", () => {
    const state = only(["Q"], ["D"]);
    expect(() => act(state, { type: "perform" })).toThrow('"perform" is not allowed during the choose phase.');
    expect(() => act(state, { type: "choose", choice: "dare", actor: "p2" })).toThrow("It is Sam's turn, not Riley's.");
    const prompted = act(state, { type: "choose", choice: "dare" });
    expect(() => act(prompted, { type: "choose", choice: "truth" })).toThrow(IllegalActionError);
    expect(() => act(prompted, { type: "end_turn" })).toThrow(IllegalActionError);
    expect(() => act(prompted, { type: "draw" })).toThrow("is not an action in this game");
  });
});

describe("Truth or Dare refusals", () => {
  test("free and forfeit refusals are narrated, not scored", () => {
    let free = only(["Q"], ["D"], { refusals: "free" });
    free = act(act(free, { type: "choose", choice: "dare" }), { type: "refuse" });
    expect(free.log.at(-1)?.text).toBe("Sam refused the dare.");
    let forfeit = only(["Q"], ["D"], { refusals: "forfeit", forfeit: "takes a shot" });
    forfeit = act(forfeit, { type: "choose", choice: "truth" });
    expect(truthOrDare.legalActions(forfeit).find((action) => action.type === "refuse")?.description).toBe("If Sam refuses, Sam takes a shot.");
    forfeit = act(forfeit, { type: "refuse" });
    expect(forfeit.log.at(-1)?.text).toBe("Sam refused the truth and takes a shot.");
    expect(forfeit.tally.p1?.refused).toBe(1);
    expect(forfeit.phase).toBe("end_turn");
  });

  test("strikes eliminate at the limit and the last player standing wins", () => {
    let state = only(["Q1", "Q2", "Q3", "Q4"], [], { refusals: "strikes", strikeLimit: 1 });
    state = act(act(state, { type: "choose", choice: "truth" }), { type: "refuse" });
    expect(state.log.at(-1)?.text).toBe("Sam refused the truth: strike 1 of 1. Sam is out.");
    expect(state.players[0]?.active).toBe(false);
    state = act(state, { type: "end_turn" });
    expect(currentPlayer(state).name).toBe("Riley");
    state = act(act(state, { type: "choose", choice: "truth" }), { type: "refuse" });
    expect(state.status).toBe("ended");
    expect(state.winners).toEqual(["p3"]);
    expect(state.endReason).toBe("Alex is the last player standing.");
    const view = truthOrDare.view(state);
    expect(view.players.find((player) => player.id === "p3")?.badges).toContain("Winner");
    expect(view.players.find((player) => player.id === "p1")?.badges).toContain("Out");
  });

  test("strikes accumulate across turns", () => {
    let state = only(["Q1", "Q2", "Q3", "Q4"], [], { refusals: "strikes", strikeLimit: 2 }, );
    state = { ...state, players: state.players.slice(0, 2) };
    for (let turn = 0; turn < 2; turn += 1) {
      state = act(act(state, { type: "choose", choice: "truth" }), { type: "refuse" });
      if (state.status === "active") state = act(state, { type: "end_turn" });
    }
    expect(state.strikes).toEqual({ p1: 1, p2: 1 });
    expect(truthOrDare.promptBlock(state)).toContain("Strikes: Sam 1/2, Riley 1/2.");
    state = act(state, { type: "choose", choice: "truth" });
    expect(truthOrDare.legalActions(state).find((action) => action.type === "refuse")?.description).toBe("If Sam refuses, that is strike 2 of 2 and Sam is out.");
  });
});

describe("Truth or Dare prompt block", () => {
  test("choose phase", () => {
    expect(truthOrDare.promptBlock(only(["What scares you?"], ["Sing."]))).toMatchSnapshot();
  });

  test("a pending dare names the exact prompt", () => {
    const state = act(only([], ["{player} serenades {other}."]), { type: "choose", choice: "random" }, 3);
    const block = truthOrDare.promptBlock(state);
    expect(block).toContain("Sam picked dare (chosen at random by the game).");
    expect(block).toContain("Use this exact dare; do not replace it.");
    expect(block).toMatchSnapshot();
  });

  test("after a refusal with strikes", () => {
    let state = only(["What scares you?", "Q2"], ["Sing."], { refusals: "strikes", strikeLimit: 3 });
    state = act(act(state, { type: "choose", choice: "truth" }), { type: "refuse" });
    expect(truthOrDare.promptBlock(state)).toMatchSnapshot();
    state = act(state, { type: "end_turn" });
    expect(truthOrDare.promptBlock(state)).toContain('Last turn: Sam\'s truth was "What scares you?". Sam refused the truth: strike 1 of 3.');
  });
});

describe("Truth or Dare in a session", () => {
  test("regenerating the narration keeps the same prompt; swiping the message before it rolls back", () => {
    const players = [{ name: "Sam", kind: "user" as const }, { name: "Riley", kind: "character" as const }];
    let session = createSession(truthOrDare, players, {}, mulberry32(4), { id: "s", now: 0 });
    const before = [{ id: "m1", swipeId: 0 }];
    session = appendAction(truthOrDare, session, new Timeline(before), { type: "choose", choice: "random" }, { id: "e1", seed: 99, now: 1 }).session;
    const chosen = deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline(before)).state.current;
    for (const swipe of [0, 1, 2]) {
      const after = [...before, { id: "m2", swipeId: swipe }];
      expect(deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline(after)).state.current).toEqual(chosen);
    }
    expect(deriveGame<TruthOrDareState>(truthOrDare, session, new Timeline([{ id: "m1", swipeId: 1 }])).state.phase).toBe("choose");
  });
});
