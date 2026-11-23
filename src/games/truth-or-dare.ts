import bundled from "../data/truth-or-dare.json";
import type { ActionDef, GameAction, GameView, Player } from "../types";
import {
  activePlayers,
  addLog,
  advanceTurn,
  cleanText,
  cloneState,
  createCoreState,
  createDeck,
  currentPlayer,
  directionOf,
  drawFrom,
  eliminate,
  endGame,
  formatBlock,
  IllegalActionError,
  isRecord,
  joinNames,
  nextPlayer,
  playerName,
  recentLog,
  requireCurrentActor,
  requirePhase,
  turnOrderLine,
  unknownAction,
  type CoreState,
  type Deck,
  type GameDefinition,
} from "../engine/core";
import { randomInt, type Rng } from "../engine/rng";

// ─── Prompts ────────────────────────────────────────────────────────────────

export const TIERS = ["mild", "bold", "wild"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Readonly<Record<Tier, { label: string; description: string }>> = {
  mild: { label: "Mild", description: "Friendly questions and silly stunts" },
  bold: { label: "Bold", description: "Embarrassing confessions and flirty dares" },
  wild: { label: "Wild", description: "Deep secrets and daring stunts" },
};

export type PromptKind = "truth" | "dare";

export interface PromptCard {
  id: string;
  /** `{player}` is whoever is taking the turn; `{other}` is another player picked when the prompt is drawn. */
  text: string;
  tier?: Tier;
  custom?: boolean;
}

export interface BundledPrompt {
  id: string;
  tier: Tier;
  text: string;
}

function bundledList(value: unknown): BundledPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.text !== "string") return [];
    if (!TIERS.includes(entry.tier as Tier)) return [];
    return [{ id: entry.id, tier: entry.tier as Tier, text: entry.text }];
  });
}

export const BUNDLED_TRUTHS: readonly BundledPrompt[] = bundledList((bundled as Record<string, unknown>).truths);
export const BUNDLED_DARES: readonly BundledPrompt[] = bundledList((bundled as Record<string, unknown>).dares);
const BUNDLED_IDS = new Set([...BUNDLED_TRUTHS, ...BUNDLED_DARES].map((prompt) => prompt.id));

export const MAX_CUSTOM_PROMPTS = 100;
export const MAX_PROMPT_TEXT = 200;
export const MAX_FORFEIT_TEXT = 80;
export const MAX_STRIKE_LIMIT = 9;

// ─── Options ────────────────────────────────────────────────────────────────

/** What refusing a prompt costs: nothing, a named forfeit, or a strike toward elimination. */
export const REFUSAL_RULES = ["free", "forfeit", "strikes"] as const;
export type RefusalRule = (typeof REFUSAL_RULES)[number];

export interface TruthOrDareOptions {
  [key: string]: unknown;
  tiers: Tier[];
  refusals: RefusalRule;
  /** Completes "Riley refused and …", e.g. "drinks". */
  forfeit: string;
  /** With strikes, a player is out on reaching this many. */
  strikeLimit: number;
  customTruths: string[];
  customDares: string[];
  /** Ids of bundled prompts the user switched off. */
  disabled: string[];
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry, MAX_PROMPT_TEXT);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
    if (result.length >= MAX_CUSTOM_PROMPTS) break;
  }
  return result;
}

function defaultOptions(): TruthOrDareOptions {
  return {
    tiers: ["mild", "bold"],
    refusals: "forfeit",
    forfeit: "drinks",
    strikeLimit: 3,
    customTruths: [],
    customDares: [],
    disabled: [],
  };
}

function normalizeOptions(raw: unknown): TruthOrDareOptions {
  const source = isRecord(raw) ? raw : {};
  const base = defaultOptions();
  const limit = Number(source.strikeLimit);
  return {
    tiers: Array.isArray(source.tiers) ? TIERS.filter((tier) => (source.tiers as unknown[]).includes(tier)) : base.tiers,
    refusals: REFUSAL_RULES.includes(source.refusals as RefusalRule) ? source.refusals as RefusalRule : base.refusals,
    forfeit: cleanText(source.forfeit, MAX_FORFEIT_TEXT).replace(/[.!]+$/, "") || base.forfeit,
    strikeLimit: Number.isInteger(limit) ? Math.min(MAX_STRIKE_LIMIT, Math.max(1, limit)) : base.strikeLimit,
    customTruths: cleanList(source.customTruths),
    customDares: cleanList(source.customDares),
    disabled: Array.isArray(source.disabled)
      ? [...new Set(source.disabled.filter((id): id is string => typeof id === "string" && BUNDLED_IDS.has(id)))]
      : [],
  };
}

/** The prompts a game with these options plays with, before shuffling. */
export function promptPool(options: TruthOrDareOptions, kind: PromptKind): PromptCard[] {
  const source = kind === "truth" ? BUNDLED_TRUTHS : BUNDLED_DARES;
  const custom = kind === "truth" ? options.customTruths : options.customDares;
  const disabled = new Set(options.disabled);
  return [
    ...source.filter((prompt) => options.tiers.includes(prompt.tier) && !disabled.has(prompt.id)).map((prompt) => ({ ...prompt })),
    ...custom.map((text, index) => ({ id: (kind === "truth" ? "ct-" : "cd-") + String(index + 1), text, custom: true })),
  ];
}

// ─── State ──────────────────────────────────────────────────────────────────

export interface CurrentPrompt {
  kind: PromptKind;
  prompt: PromptCard;
  player: string;
  /** The player `{other}` stands for, picked when the prompt was drawn. */
  other: string | null;
  /** True when the game picked truth or dare. */
  random: boolean;
  outcome: "pending" | "done" | "refused";
}

export interface Tally {
  truths: number;
  dares: number;
  refused: number;
}

export interface TruthOrDareState extends CoreState {
  game: "truth_or_dare";
  truths: Deck<PromptCard>;
  dares: Deck<PromptCard>;
  tiers: Tier[];
  refusals: RefusalRule;
  forfeit: string;
  strikeLimit: number;
  strikes: Record<string, number>;
  tally: Record<string, Tally>;
  current: CurrentPrompt | null;
  previous: CurrentPrompt | null;
}

const PHASES = {
  choose: "choose",
  prompt: "prompt",
  end_turn: "end of turn",
  game_over: "game over",
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function deckFor(state: TruthOrDareState, kind: PromptKind): Deck<PromptCard> {
  return kind === "truth" ? state.truths : state.dares;
}

function availableKinds(state: TruthOrDareState): PromptKind[] {
  return (["truth", "dare"] as const).filter((kind) => deckFor(state, kind).remaining.length > 0);
}

/** The prompt as it should be read out, with names filled in. */
export function promptText(state: CoreState, current: CurrentPrompt): string {
  return current.prompt.text
    .split("{player}").join(playerName(state, current.player))
    .split("{other}").join(current.other ? playerName(state, current.other) : "another player");
}

function pickOther(state: TruthOrDareState, playerId: string, text: string, rng: Rng): string | null {
  if (!text.includes("{other}")) return null;
  const others = activePlayers(state).filter((player) => player.id !== playerId);
  return others.length ? others[randomInt(rng, others.length)]!.id : null;
}

function tallyFor(state: TruthOrDareState, playerId: string): Tally {
  return (state.tally[playerId] ??= { truths: 0, dares: 0, refused: 0 });
}

function refusalRule(state: TruthOrDareState): string {
  switch (state.refusals) {
    case "free":
      return "Players may refuse with no penalty.";
    case "forfeit":
      return "A player who refuses " + state.forfeit + ".";
    default:
      return "Each refusal is a strike; " + String(state.strikeLimit) + " strike" + (state.strikeLimit === 1 ? "" : "s") + " and a player is out.";
  }
}

function describeOutcome(state: TruthOrDareState, current: CurrentPrompt): string {
  const name = playerName(state, current.player);
  if (current.outcome === "done") return current.kind === "truth" ? name + " answered the truth." : name + " did the dare.";
  if (current.outcome === "pending") return "";
  if (state.refusals === "forfeit") return name + " refused the " + current.kind + " and " + state.forfeit + ".";
  if (state.refusals === "strikes") {
    const strikes = state.strikes[current.player] ?? 0;
    const out = strikes >= state.strikeLimit ? " " + name + " is out." : "";
    return name + " refused the " + current.kind + ": strike " + String(strikes) + " of " + String(state.strikeLimit) + "." + out;
  }
  return name + " refused the " + current.kind + ".";
}

function strikesLine(state: TruthOrDareState): string {
  if (state.refusals !== "strikes") return "";
  const entries = state.players
    .filter((player) => player.active && (state.strikes[player.id] ?? 0) > 0)
    .map((player) => player.name + " " + String(state.strikes[player.id]) + "/" + String(state.strikeLimit));
  return entries.length ? "Strikes: " + entries.join(", ") + "." : "";
}

function promptsLeft(state: TruthOrDareState): string {
  const truths = state.truths.remaining.length;
  const dares = state.dares.remaining.length;
  return String(truths) + " truth" + (truths === 1 ? "" : "s") + ", " + String(dares) + " dare" + (dares === 1 ? "" : "s");
}

// ─── Game definition ────────────────────────────────────────────────────────

function setup(players: Player[], options: TruthOrDareOptions, rng: Rng): TruthOrDareState {
  const truths = promptPool(options, "truth");
  const dares = promptPool(options, "dare");
  if (!truths.length && !dares.length) {
    throw new IllegalActionError("There are no prompts to play with. Turn on an intensity or add your own truths and dares.");
  }
  return {
    ...createCoreState(players, "choose", 2),
    game: "truth_or_dare",
    truths: createDeck(truths, rng),
    dares: createDeck(dares, rng),
    tiers: [...options.tiers],
    refusals: options.refusals,
    forfeit: options.forfeit,
    strikeLimit: options.strikeLimit,
    strikes: {},
    tally: {},
    current: null,
    previous: null,
  };
}

function legalActions(state: TruthOrDareState): ActionDef[] {
  if (state.status !== "active") return [];
  const player = currentPlayer(state);
  switch (state.phase) {
    case "choose": {
      const kinds = availableKinds(state);
      const actions: ActionDef[] = [];
      if (kinds.includes("truth")) actions.push({ type: "choose", label: "Truth", preset: { choice: "truth" } });
      if (kinds.includes("dare")) actions.push({ type: "choose", label: "Dare", preset: { choice: "dare" } });
      if (kinds.length) {
        actions.push({
          type: "choose",
          label: "Random",
          description: "Let the game pick truth or dare for " + player.name + ".",
          primary: true,
          preset: { choice: "random" },
        });
      }
      return actions;
    }
    case "prompt": {
      const current = state.current;
      if (!current) return [];
      const strike = (state.strikes[player.id] ?? 0) + 1;
      const refuseNote = state.refusals === "free"
        ? "Refusing has no penalty."
        : state.refusals === "forfeit"
          ? "If " + player.name + " refuses, " + player.name + " " + state.forfeit + "."
          : "If " + player.name + " refuses, that is strike " + String(strike) + " of " + String(state.strikeLimit) + (strike >= state.strikeLimit ? " and " + player.name + " is out." : ".");
      const actions: ActionDef[] = [
        { type: "perform", label: current.kind === "truth" ? "Answered" : "Did the dare", primary: true },
        { type: "refuse", label: "Refuse", description: refuseNote },
      ];
      if (deckFor(state, current.kind).remaining.length) {
        actions.push({ type: "swap", label: "Draw a different " + current.kind, description: "Skip this one; it will not come up again." });
      }
      return actions;
    }
    case "end_turn": {
      const next = nextPlayer(state);
      const description = availableKinds(state).length === 0
        ? "Out of prompts; this ends the game."
        : next ? "Pass to " + next.name + "." : undefined;
      return [{ type: "end_turn", label: "Next turn", primary: true, ...(description ? { description } : {}) }];
    }
    default:
      return [];
  }
}

function drawPrompt(state: TruthOrDareState, kind: PromptKind, playerId: string, random: boolean, rng: Rng): CurrentPrompt {
  const prompt = drawFrom(deckFor(state, kind));
  return { kind, prompt, player: playerId, other: pickOther(state, playerId, prompt.text, rng), random, outcome: "pending" };
}

function apply(input: TruthOrDareState, action: GameAction, rng: Rng): TruthOrDareState {
  const state = cloneState(input);
  switch (action.type) {
    case "choose": {
      requirePhase(state, PHASES, ["choose"], action);
      const actor = requireCurrentActor(state, action);
      const kinds = availableKinds(state);
      let kind: PromptKind;
      if (action.choice === "random") {
        if (!kinds.length) throw new IllegalActionError("There are no prompts left.");
        kind = kinds[randomInt(rng, kinds.length)]!;
      } else if (action.choice === "truth" || action.choice === "dare") {
        kind = action.choice;
        if (!kinds.includes(kind)) throw new IllegalActionError("There are no " + kind + "s left. Pick " + (kind === "truth" ? "dare" : "truth") + ".");
      } else {
        throw new IllegalActionError("Pick truth, dare, or random.");
      }
      const random = action.choice === "random";
      state.current = drawPrompt(state, kind, actor.id, random, rng);
      const tally = tallyFor(state, actor.id);
      if (kind === "truth") tally.truths += 1;
      else tally.dares += 1;
      addLog(state, actor.name + " picked " + kind + (random ? " (at random)" : "") + ': "' + promptText(state, state.current) + '"');
      state.phase = "prompt";
      return state;
    }
    case "perform":
    case "refuse": {
      requirePhase(state, PHASES, ["prompt"], action);
      const actor = requireCurrentActor(state, action);
      const current = state.current;
      if (!current) throw new IllegalActionError("No prompt has been drawn this turn.");
      if (action.type === "perform") {
        current.outcome = "done";
      } else {
        current.outcome = "refused";
        tallyFor(state, actor.id).refused += 1;
        if (state.refusals === "strikes") state.strikes[actor.id] = (state.strikes[actor.id] ?? 0) + 1;
      }
      addLog(state, describeOutcome(state, current));
      if (state.refusals === "strikes" && (state.strikes[actor.id] ?? 0) >= state.strikeLimit) {
        eliminate(state, actor.id);
        const remaining = activePlayers(state);
        if (remaining.length <= 1) {
          const winner = remaining[0];
          const reason = winner ? winner.name + " is the last player standing." : "Everyone is out.";
          addLog(state, reason);
          endGame(state, reason, winner ? [winner.id] : []);
          return state;
        }
      }
      state.phase = "end_turn";
      return state;
    }
    case "swap": {
      requirePhase(state, PHASES, ["prompt"], action);
      const actor = requireCurrentActor(state, action);
      const current = state.current;
      if (!current) throw new IllegalActionError("No prompt has been drawn this turn.");
      if (!deckFor(state, current.kind).remaining.length) throw new IllegalActionError("There are no other " + current.kind + "s left.");
      // The skipped prompt stays in the drawn pile, so it never comes back.
      state.current = drawPrompt(state, current.kind, actor.id, current.random, rng);
      addLog(state, actor.name + " skipped that " + current.kind + ' and drew another: "' + promptText(state, state.current) + '"');
      return state;
    }
    case "end_turn": {
      requirePhase(state, PHASES, ["end_turn"], action);
      requireCurrentActor(state, action);
      state.previous = state.current;
      state.current = null;
      if (!availableKinds(state).length) {
        const reason = "Out of prompts after " + String(state.turn.number) + " turns.";
        addLog(state, reason);
        endGame(state, reason);
        return state;
      }
      advanceTurn(state, "choose");
      return state;
    }
    default:
      return unknownAction(state, PHASES, action);
  }
}

function promptBlock(state: TruthOrDareState): string {
  const lines: string[] = [turnOrderLine(state)];
  if (state.status === "ended") {
    lines.push("Game over: " + (state.endReason ?? "the game has ended.") + " No more prompts are drawn.");
  } else {
    const player = currentPlayer(state);
    lines.push("It is " + player.name + "'s turn.");
    const current = state.current;
    if (state.phase === "choose" || !current) {
      lines.push(player.name + " has not picked truth or dare yet.");
      if (state.previous) {
        lines.push("Last turn: " + playerName(state, state.previous.player) + "'s " + state.previous.kind + ' was "' + promptText(state, state.previous) + '". ' + describeOutcome(state, state.previous));
      }
    } else {
      lines.push(player.name + " picked " + current.kind + (current.random ? " (chosen at random by the game)" : "") + ".");
      lines.push(player.name + "'s " + current.kind + ': "' + promptText(state, current) + '"');
      if (state.phase === "prompt") {
        lines.push(current.kind === "truth"
          ? "Waiting for " + player.name + " to answer or refuse. Use this exact question; do not replace it."
          : "Waiting for " + player.name + " to do it or refuse. Use this exact dare; do not replace it.");
      } else {
        lines.push("Resolved: " + describeOutcome(state, current) + " " + player.name + "'s turn is wrapping up.");
      }
    }
  }
  lines.push("Refusal rule: " + refusalRule(state));
  const strikes = strikesLine(state);
  if (strikes) lines.push(strikes);
  const out = state.players.filter((player) => !player.active).map((player) => player.name);
  if (out.length) lines.push("Out of the game: " + joinNames(out) + ".");
  lines.push("Prompts left: " + promptsLeft(state) + ".");
  const next = nextPlayer(state);
  if (next && state.status === "active") lines.push("Next up: " + next.name + ".");
  return formatBlock("Truth or Dare — turn " + String(state.turn.number), lines);
}

function view(state: TruthOrDareState): GameView {
  const current = state.status === "active" ? currentPlayer(state) : null;
  const next = nextPlayer(state);
  let headline: string;
  let detail: string | undefined;
  const prompt = state.current;
  if (state.status === "ended") {
    headline = "Game over";
    detail = state.endReason ?? undefined;
  } else if (prompt && current) {
    const kind = prompt.kind === "truth" ? "Truth" : "Dare";
    const suffix = prompt.outcome === "done" ? " — done" : prompt.outcome === "refused" ? " — refused" : "";
    headline = current.name + ": " + kind + (prompt.random ? " (random)" : "") + suffix;
    detail = promptText(state, prompt);
    if (prompt.outcome !== "pending") detail += " " + describeOutcome(state, prompt);
  } else {
    headline = (current?.name ?? "Someone") + " to choose";
    detail = state.previous ? describeOutcome(state, state.previous) || undefined : undefined;
  }
  const facts = [
    { label: "Truths left", value: String(state.truths.remaining.length) },
    { label: "Dares left", value: String(state.dares.remaining.length) },
    { label: "Refusing", value: refusalRule(state) },
  ];
  if (state.tiers.length) facts.push({ label: "Intensity", value: state.tiers.map((tier) => TIER_LABELS[tier].label).join(", ") });
  if (state.turn.direction === -1) facts.push({ label: "Turn order", value: "Reversed" });
  return {
    gameId: "truth_or_dare",
    gameName: "Truth or Dare",
    status: state.status,
    turnNumber: state.turn.number,
    phase: state.phase,
    phaseLabel: PHASES[state.phase as keyof typeof PHASES] ?? state.phase,
    direction: directionOf(state),
    currentPlayerId: current?.id ?? null,
    nextPlayerId: next?.id ?? null,
    players: state.players.map((player) => {
      const badges: string[] = [];
      const tally = state.tally[player.id];
      if (tally?.truths) badges.push(String(tally.truths) + (tally.truths === 1 ? " truth" : " truths"));
      if (tally?.dares) badges.push(String(tally.dares) + (tally.dares === 1 ? " dare" : " dares"));
      const strikes = state.strikes[player.id] ?? 0;
      if (state.refusals === "strikes" && strikes > 0) badges.push("Strikes " + String(strikes) + "/" + String(state.strikeLimit));
      if (!player.active) badges.push("Out");
      if (state.winners.includes(player.id)) badges.push("Winner");
      return {
        id: player.id,
        name: player.name,
        kind: player.kind,
        active: player.active,
        current: player.id === current?.id,
        next: player.id === next?.id && next?.id !== current?.id,
        badges,
      };
    }),
    headline,
    ...(detail ? { detail } : {}),
    facts,
    recent: recentLog(state, 6),
    ...(state.status === "ended" && state.endReason ? { endSummary: state.endReason } : {}),
  };
}

export const truthOrDare: GameDefinition<TruthOrDareState, TruthOrDareOptions> = {
  id: "truth_or_dare",
  name: "Truth or Dare",
  description: "Pick truth or dare and face a prompt from the pool. Prompts never repeat; refusing can cost you.",
  minPlayers: 2,
  phases: PHASES,
  defaultOptions,
  normalizeOptions,
  setup,
  legalActions,
  apply,
  promptBlock,
  view,
};
