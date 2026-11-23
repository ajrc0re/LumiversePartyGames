import type { ActionDef, GameAction, GameView, Player } from "../types";
import {
  activePlayers,
  addLog,
  cloneState,
  createCoreState,
  currentPlayer,
  findPlayer,
  formatBlock,
  playerName,
  recentLog,
  requireCurrentActor,
  requirePhase,
  unknownAction,
  type CoreState,
  type GameDefinition,
} from "../engine/core";
import { mulberry32, randomInt, type Rng } from "../engine/rng";

/**
 * Truth or Dare keeps track of roles only. Each round one player asks and
 * another answers; what is asked, whether they pick truth or dare, and what
 * they do are left to the roleplay. When a round ends, the player who
 * answered asks next and the game picks a new player to answer at random.
 *
 * `turn.index` points at the answering player, so the shared "whose turn"
 * helpers mean "who answers this round".
 */

export type TruthOrDareOptions = Record<string, unknown>;

export interface RoundRoles {
  asker: string;
  player: string;
}

export interface TruthOrDareState extends CoreState {
  game: "truth_or_dare";
  /** Who asks this round. */
  asker: string;
  /**
   * Fixed at setup. Each round's random pick is derived from it and the round
   * number, so undoing or swiping a round and replaying it picks the same
   * player again instead of re-rolling.
   */
  rollSeed: number;
  previous: RoundRoles | null;
}

const PHASES = {
  round: "asking",
  game_over: "game over",
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The random pick for `round`: any active player except the asker. */
export function pickPlayer(state: Pick<TruthOrDareState, "players" | "rollSeed">, askerId: string, round: number): Player {
  const candidates = state.players.filter((player) => player.active && player.id !== askerId);
  if (!candidates.length) throw new Error("Truth or Dare needs someone besides the asker.");
  const rng = mulberry32((state.rollSeed + Math.imul(round, 0x9e3779b1)) >>> 0);
  return candidates[randomInt(rng, candidates.length)]!;
}

function seatIndex(state: CoreState, playerId: string): number {
  return state.players.findIndex((player) => player.id === playerId);
}

function roundLine(state: TruthOrDareState): string {
  return playerName(state, state.asker) + " asks " + currentPlayer(state).name + ".";
}

// ─── Game definition ────────────────────────────────────────────────────────

function setup(players: Player[], _options: TruthOrDareOptions, rng: Rng): TruthOrDareState {
  const core = createCoreState(players, "round", 2);
  const rollSeed = Math.floor(rng.next() * 4294967296) >>> 0;
  const asker = core.players[randomInt(rng, core.players.length)]!;
  const state: TruthOrDareState = { ...core, game: "truth_or_dare", asker: asker.id, rollSeed, previous: null };
  state.turn.index = seatIndex(state, pickPlayer(state, asker.id, 1).id);
  addLog(state, roundLine(state));
  return state;
}

function legalActions(state: TruthOrDareState): ActionDef[] {
  if (state.status !== "active" || state.phase !== "round") return [];
  const player = currentPlayer(state);
  return [{
    type: "next_round",
    label: "Next round",
    description: player.name + " asks next; the game picks who answers.",
    primary: true,
  }];
}

function apply(input: TruthOrDareState, action: GameAction, _rng: Rng): TruthOrDareState {
  const state = cloneState(input);
  switch (action.type) {
    case "next_round": {
      requirePhase(state, PHASES, ["round"], action);
      const player = requireCurrentActor(state, action);
      state.previous = { asker: state.asker, player: player.id };
      // Whoever just answered asks next.
      state.asker = player.id;
      state.turn.number += 1;
      state.turn.index = seatIndex(state, pickPlayer(state, player.id, state.turn.number).id);
      addLog(state, roundLine(state));
      return state;
    }
    default:
      return unknownAction(state, PHASES, action);
  }
}

function promptBlock(state: TruthOrDareState): string {
  const lines: string[] = ["Players: " + activePlayers(state).map((player) => player.name).join(", ") + "."];
  const asker = findPlayer(state, state.asker);
  const player = currentPlayer(state);
  const askerName = asker?.name ?? "Someone";
  lines.push("This round, " + askerName + " asks " + player.name + ': "Truth or dare?"');
  lines.push(player.name + " picks truth or dare, then answers the truth or does the dare. What " + askerName + " asks and what " + player.name + " does are up to the story.");
  if (asker?.kind === "user") lines.push(askerName + " is played by the user: let them ask; do not ask for them.");
  if (player.kind === "user") lines.push(player.name + " is played by the user: let them choose and answer; do not decide for them.");
  lines.push("Nobody else asks or answers this round. Afterwards " + player.name + " asks next and the game picks who answers; do not start the next round yourself.");
  if (state.previous) {
    lines.push("Last round: " + playerName(state, state.previous.asker) + " asked " + playerName(state, state.previous.player) + ".");
  }
  return formatBlock("Truth or Dare — round " + String(state.turn.number), lines);
}

function view(state: TruthOrDareState): GameView {
  const player = currentPlayer(state);
  const askerName = playerName(state, state.asker);
  return {
    gameId: "truth_or_dare",
    gameName: "Truth or Dare",
    status: state.status,
    turnNumber: state.turn.number,
    turnNoun: "Round",
    phase: state.phase,
    phaseLabel: PHASES[state.phase as keyof typeof PHASES] ?? state.phase,
    currentPlayerId: player.id,
    nextPlayerId: null,
    roles: [
      { label: "Asking", playerId: state.asker },
      { label: "Answering", playerId: player.id },
    ],
    players: state.players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      active: entry.active,
      current: entry.id === player.id,
      next: false,
      badges: entry.id === state.asker ? ["Asking"] : entry.id === player.id ? ["Answering"] : [],
    })),
    headline: askerName + " asks " + player.name,
    detail: "Truth or dare? What " + askerName + " asks and what " + player.name + " does are up to the story.",
    facts: [
      { label: "Next asker", value: player.name },
      { label: "Rounds played", value: String(state.turn.number - 1) },
    ],
    recent: recentLog(state, 6, "Round"),
  };
}

export const truthOrDare: GameDefinition<TruthOrDareState, TruthOrDareOptions> = {
  id: "truth_or_dare",
  name: "Truth or Dare",
  description: "The game picks who asks and who answers; the story decides the truths and dares. Whoever answers asks next.",
  minPlayers: 2,
  usesTurnOrder: false,
  phases: PHASES,
  defaultOptions: () => ({}),
  normalizeOptions: () => ({}),
  setup,
  legalActions,
  apply,
  promptBlock,
  view,
};
