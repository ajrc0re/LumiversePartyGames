import { createPlayers } from "../src/engine/core";
import { mulberry32 } from "../src/engine/rng";
import { kingsCup, ruleFor, type Card, type KingsCupState, type Rank } from "../src/games/kings-cup";
import type { GameAction } from "../src/types";

export function kingsCupGame(names: string[] = ["Sam", "Riley", "Alex"], seed = 1, options: unknown = {}): KingsCupState {
  return kingsCup.setup(
    createPlayers(names.map((name, index) => ({ name, kind: index === 0 ? "user" : "character" }))),
    kingsCup.normalizeOptions(options),
    mulberry32(seed),
  );
}

export function act(state: KingsCupState, action: GameAction): KingsCupState {
  return kingsCup.apply(state, action, mulberry32(0));
}

/** The resolve action a careful player would send for the card in play. */
export function resolveFor(state: KingsCupState): GameAction {
  const turnCard = state.turnCard;
  if (!turnCard) throw new Error("No card in play.");
  const effect = ruleFor(state, turnCard.card).effect;
  if (effect === "target" || effect === "mate") {
    const other = state.players.find((player) => player.active && player.id !== turnCard.drawer);
    return { type: "resolve", target: other?.id };
  }
  if (effect === "make_rule") return { type: "resolve", text: "Rule " + String(state.turn.number) };
  return { type: "resolve" };
}

/** Draw, resolve, and end one turn. Returns early if the game ends. */
export function playTurn(state: KingsCupState): KingsCupState {
  let next = act(state, { type: "draw" });
  if (next.status === "ended") return next;
  next = act(next, resolveFor(next));
  return act(next, { type: "end_turn" });
}

/** Rearranges the deck so the next draws are these ranks (suits as found). */
export function stackDeck(state: KingsCupState, ranks: Rank[]): KingsCupState {
  const remaining = [...state.deck.remaining];
  const front: Card[] = [];
  for (const rank of ranks) {
    const index = remaining.findIndex((card) => card.rank === rank);
    if (index < 0) throw new Error("No " + rank + " left to stack.");
    front.push(...remaining.splice(index, 1));
  }
  return { ...state, deck: { ...state.deck, remaining: [...front, ...remaining] } };
}
