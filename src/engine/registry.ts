import type { GameSummary } from "../types";
import { kingsCup } from "../games/kings-cup";
import { truthOrDare } from "../games/truth-or-dare";
import type { AnyGameDefinition } from "./core";

/** Every playable game. New games register here. */
const GAMES: readonly AnyGameDefinition[] = [kingsCup, truthOrDare];

/** Games on the roadmap, listed in setup so users know what is coming. */
const PLANNED: readonly GameSummary[] = [
  { id: "never_have_i_ever", name: "Never Have I Ever", description: "Take turns confessing; lose a life for everything you have done.", minPlayers: 2, available: false, usesTurnOrder: true },
];

export function listGameDefinitions(): readonly AnyGameDefinition[] {
  return GAMES;
}

export function getGame(id: string): AnyGameDefinition | undefined {
  return GAMES.find((game) => game.id === id);
}

export function requireGame(id: string): AnyGameDefinition {
  const game = getGame(id);
  if (!game) throw new Error('Unknown game "' + id + '".');
  return game;
}

export function listGames(): GameSummary[] {
  return [
    ...GAMES.map((game) => ({
      id: game.id,
      name: game.name,
      description: game.description,
      minPlayers: game.minPlayers,
      available: true,
      usesTurnOrder: game.usesTurnOrder,
    })),
    ...PLANNED.filter((planned) => !getGame(planned.id)),
  ];
}
