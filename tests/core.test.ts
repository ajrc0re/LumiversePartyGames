import { describe, expect, test } from "bun:test";
import {
  advanceTurn,
  createCoreState,
  createDeck,
  createPlayers,
  drawFrom,
  eliminate,
  IllegalActionError,
  nextActiveIndex,
  nextPlayer,
  reverseDirection,
  skipNext,
} from "../src/engine/core";
import { mulberry32, randomInt, shuffle } from "../src/engine/rng";

const seats = (...names: string[]) => createPlayers(names.map((name) => ({ name, kind: "character" as const })));

describe("rng", () => {
  test("mulberry32 is deterministic per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test("randomInt stays in range", () => {
    const rng = mulberry32(7);
    for (let index = 0; index < 1000; index += 1) {
      const value = randomInt(rng, 6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
    }
    expect(() => randomInt(rng, 0)).toThrow();
  });

  test("shuffle is a permutation and leaves its input alone", () => {
    const items = Array.from({ length: 52 }, (_, index) => index);
    const shuffled = shuffle(items, mulberry32(1));
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(items[0]).toBe(0);
  });
});

describe("players", () => {
  test("seats players in order with stable ids and distinct names", () => {
    const players = createPlayers([
      { name: "  Sam ", kind: "user" },
      { name: "Riley", kind: "character" },
      { name: "" },
      { name: "sam" },
      { name: "Alex", kind: "bogus" as never },
    ]);
    expect(players.map((player) => [player.id, player.name, player.kind])).toEqual([
      ["p1", "Sam", "user"],
      ["p2", "Riley", "character"],
      ["p3", "sam 2", "npc"],
      ["p4", "Alex", "npc"],
    ]);
    expect(players.every((player) => player.active)).toBe(true);
  });

  test("rejects too few players", () => {
    expect(() => createCoreState(seats("Solo"), "draw", 2)).toThrow(IllegalActionError);
  });
});

describe("turn rotation", () => {
  test("advances in seat order and wraps", () => {
    const state = createCoreState(seats("A", "B", "C"), "draw", 2);
    const order: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      order.push(state.players[state.turn.index]!.name);
      advanceTurn(state, "draw");
    }
    expect(order).toEqual(["A", "B", "C", "A", "B"]);
    expect(state.turn.number).toBe(6);
  });

  test("skips eliminated players", () => {
    const state = createCoreState(seats("A", "B", "C", "D"), "draw", 2);
    eliminate(state, "p2");
    eliminate(state, "p3");
    expect(nextPlayer(state)?.name).toBe("D");
    advanceTurn(state, "draw");
    advanceTurn(state, "draw");
    expect(state.players[state.turn.index]?.name).toBe("A");
  });

  test("an eliminated current player still hands the turn on", () => {
    const state = createCoreState(seats("A", "B", "C"), "draw", 2);
    eliminate(state, "p1");
    advanceTurn(state, "draw");
    expect(state.players[state.turn.index]?.name).toBe("B");
  });

  test("supports reversal and skip-next", () => {
    const state = createCoreState(seats("A", "B", "C", "D"), "draw", 2);
    reverseDirection(state);
    expect(nextPlayer(state)?.name).toBe("D");
    skipNext(state);
    expect(nextPlayer(state)?.name).toBe("C");
    advanceTurn(state, "draw");
    expect(state.players[state.turn.index]?.name).toBe("C");
    expect(state.turn.skips).toBe(0);
  });

  test("returns the same seat when nobody else is active", () => {
    const players = seats("A", "B");
    players[1]!.active = false;
    expect(nextActiveIndex(players, 0, 1)).toBe(0);
    expect(nextActiveIndex(players, 0, 1, 3)).toBe(0);
  });
});

describe("decks", () => {
  test("draws without replacement until empty", () => {
    const deck = createDeck(["a", "b", "c"], mulberry32(3));
    const drawn = [drawFrom(deck), drawFrom(deck), drawFrom(deck)];
    expect([...drawn].sort()).toEqual(["a", "b", "c"]);
    expect(deck.drawn).toEqual(drawn);
    expect(deck.remaining).toEqual([]);
    expect(() => drawFrom(deck)).toThrow(IllegalActionError);
  });
});
