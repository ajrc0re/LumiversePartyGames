import { describe, expect, test } from "bun:test";
import { IllegalActionError } from "../src/engine/core";
import { mulberry32 } from "../src/engine/rng";
import {
  appendAction,
  createSession,
  deriveGame,
  parseAction,
  parseStoredGames,
  replay,
  Timeline,
  undoLast,
  type TimelineMessage,
} from "../src/engine/session";
import { cardLabel, kingsCup, type KingsCupState } from "../src/games/kings-cup";
import type { GameAction, GameSession } from "../src/types";

const PLAYERS = [{ name: "Sam", kind: "user" as const }, { name: "Riley", kind: "character" as const }];

let ids = 0;
function newSession(): GameSession {
  return createSession(kingsCup, PLAYERS, {}, mulberry32(11), { id: "s1", now: 1 });
}

function act(session: GameSession, messages: TimelineMessage[], action: GameAction): GameSession {
  ids += 1;
  return appendAction(kingsCup, session, new Timeline(messages), action, { id: "e" + String(ids), seed: ids, now: ids }).session;
}

function stateOf(session: GameSession, messages: TimelineMessage[]): KingsCupState {
  return deriveGame<KingsCupState>(kingsCup, session, new Timeline(messages)).state;
}

/** Resolve the card in play without caring which it is. */
function resolveAny(session: GameSession, messages: TimelineMessage[]): GameAction {
  const state = stateOf(session, messages);
  const effect = state.rules[state.turnCard!.card.rank].effect;
  return effect === "target" || effect === "mate" ? { type: "resolve", target: "p2" } : { type: "resolve" };
}

const m = (id: string, swipeId = 0): TimelineMessage => ({ id, swipeId });

describe("state derivation", () => {
  test("state rebuilt from setup + events equals the live state", () => {
    let session = newSession();
    let live = session.setup.seedState as KingsCupState;
    const chat = [m("greeting")];
    for (let turn = 0; turn < 10; turn += 1) {
      for (const action of [{ type: "draw" }, null, { type: "end_turn" }]) {
        const resolved = action ?? resolveAny(session, chat);
        const result = appendAction<KingsCupState>(kingsCup, session, new Timeline(chat), resolved, { id: "x" + String(turn) + resolved.type, seed: turn, now: turn });
        session = result.session;
        live = result.state;
        if (live.status === "ended") break;
      }
      if (live.status === "ended") break;
    }
    expect(stateOf(session, chat)).toEqual(live);
    expect(replay(kingsCup, session, session.events).state).toEqual(live);
  });

  test("a fresh session derives to its setup state", () => {
    const session = newSession();
    expect(stateOf(session, [])).toEqual(session.setup.seedState as KingsCupState);
  });

  test("illegal actions are rejected and not recorded", () => {
    const session = newSession();
    expect(() => act(session, [m("a")], { type: "end_turn" })).toThrow(IllegalActionError);
    expect(session.events.length).toBe(0);
  });
});

describe("anchoring", () => {
  test("deleting the message an event is anchored to drops that event", () => {
    let session = act(newSession(), [m("a")], { type: "draw" });
    session = act(session, [m("a"), m("b")], resolveAny(session, [m("a"), m("b")]));
    expect(stateOf(session, [m("a"), m("b")]).phase).toBe("end_turn");
    // Deleting "b" drops the resolve but keeps the draw.
    expect(stateOf(session, [m("a")]).phase).toBe("resolve");
    // Deleting "a" as well drops the draw.
    expect(stateOf(session, []).phase).toBe("draw");
  });

  test("regenerating a reply after a Draw keeps the same card", () => {
    const before = [m("greeting")];
    const session = act(newSession(), before, { type: "draw" });
    const card = cardLabel(stateOf(session, before).turnCard!.card);
    // The narration reply arrives, then is swiped twice.
    for (const swipe of [0, 1, 2]) {
      const after = [...before, m("narration", swipe)];
      expect(cardLabel(stateOf(session, after).turnCard!.card)).toBe(card);
      expect(stateOf(session, after).deck.drawn.length).toBe(1);
    }
  });

  test("switching swipes switches the derived state", () => {
    let session = newSession();
    const first = [m("a", 0)];
    session = act(session, first, { type: "draw" });
    session = act(session, first, resolveAny(session, first));
    // Swipe "a" to a new reply: the draw and resolve came after the old reply, so they roll back.
    const second = [m("a", 1)];
    expect(stateOf(session, second).phase).toBe("draw");
    session = act(session, second, { type: "draw" });
    expect(stateOf(session, second).phase).toBe("resolve");
    expect(stateOf(session, second).turn.number).toBe(1);
    // Swiping back restores the first branch exactly.
    expect(stateOf(session, first).phase).toBe("end_turn");
    expect(stateOf(session, first).deck.drawn.length).toBe(1);
    // And the second branch is still there.
    expect(stateOf(session, second).phase).toBe("resolve");
  });

  test("redrawing after a rollback deals the same card, because the deck order is fixed", () => {
    let session = act(newSession(), [m("a", 0)], { type: "draw" });
    const card = cardLabel(stateOf(session, [m("a", 0)]).turnCard!.card);
    session = act(session, [m("a", 1)], { type: "draw" });
    expect(cardLabel(stateOf(session, [m("a", 1)]).turnCard!.card)).toBe(card);
  });

  test("deleting an older message does not roll back later events", () => {
    let session = act(newSession(), [m("a"), m("b")], { type: "draw" });
    const chat = [m("a"), m("b"), m("c")];
    session = act(session, chat, resolveAny(session, chat));
    // "b" is deleted but "c" remains, so both events stay in the timeline.
    expect(stateOf(session, [m("a"), m("c")]).phase).toBe("end_turn");
  });

  test("events in an empty chat are always live", () => {
    const session = act(newSession(), [], { type: "draw" });
    expect(session.events[0]?.anchor).toBeNull();
    expect(stateOf(session, [m("later")]).phase).toBe("resolve");
  });
});

describe("undo", () => {
  test("removes the head and anything built on it", () => {
    let session = act(newSession(), [m("a")], { type: "draw" });
    session = act(session, [m("a"), m("b", 0)], resolveAny(session, [m("a")]));
    // A sibling branch on another swipe of "b".
    const undone = undoLast(kingsCup, session, new Timeline([m("a")]));
    expect(undone?.events.length).toBe(0);
    expect(undoLast(kingsCup, newSession(), new Timeline([]))).toBeNull();
  });

  test("undoes only the most recent live action", () => {
    let session = act(newSession(), [m("a")], { type: "draw" });
    session = act(session, [m("a")], resolveAny(session, [m("a")]));
    const undone = undoLast(kingsCup, session, new Timeline([m("a")]))!;
    expect(stateOf(undone, [m("a")]).phase).toBe("resolve");
  });
});

describe("parsing", () => {
  test("parseAction keeps only known, well-typed fields", () => {
    expect(parseAction({ type: "resolve", target: "p2", text: "  ", extra: 1, players: ["p1", "p1", 3] })).toEqual({
      type: "resolve",
      target: "p2",
      players: ["p1"],
    });
    expect(() => parseAction({})).toThrow(IllegalActionError);
  });

  test("parseStoredGames round-trips a session and rejects junk", () => {
    const session = act(newSession(), [m("a")], { type: "draw" });
    const stored = JSON.parse(JSON.stringify({ version: 1, session }));
    expect(parseStoredGames(stored)).toEqual({ version: 1, session });
    expect(parseStoredGames(null)).toEqual({ version: 1, session: null });
    expect(parseStoredGames({ version: 2, session })).toEqual({ version: 1, session: null });
    const broken = { version: 1, session: { ...stored.session, events: [{ id: "bad" }, ...stored.session.events] } };
    expect(parseStoredGames(broken).session?.events).toEqual(session.events);
  });
});
