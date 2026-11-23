import type { ActionDef, GameAction, GameView, Player } from "../types";
import {
  addLog,
  advanceTurn,
  cloneState,
  createCoreState,
  createDeck,
  currentPlayer,
  drawFrom,
  endGame,
  formatBlock,
  IllegalActionError,
  joinNames,
  nextPlayer,
  playerChoices,
  playerName,
  recentLog,
  requireCurrentActor,
  requirePhase,
  requireTarget,
  unknownAction,
  type CoreState,
  type Deck,
  type GameDefinition,
} from "../engine/core";
import type { Rng } from "../engine/rng";

// ─── Cards and the rule table ───────────────────────────────────────────────

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export type Rank = (typeof RANKS)[number];

export const SUITS = ["S", "H", "D", "C"] as const;
export type Suit = (typeof SUITS)[number];

const SUIT_SYMBOLS: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

export interface Card {
  rank: Rank;
  suit: Suit;
}

export function cardLabel(card: Card): string {
  return card.rank + SUIT_SYMBOLS[card.suit];
}

export function fullDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

/**
 * What resolving a card asks of the drawer:
 * - none: the rule plays out in the story; nothing to record.
 * - target: the drawer picks another player (2, "You").
 * - mate: the drawer picks a mate who drinks whenever they drink (8).
 * - make_rule: the drawer may record a new rule (J).
 * - question_master: the drawer becomes Question Master on the draw (Q).
 * - kings_cup: Kings only. Counts toward the 4th King and fills the cup.
 */
export const EFFECTS = ["none", "target", "mate", "make_rule", "question_master", "kings_cup"] as const;
export type KingsCupEffect = (typeof EFFECTS)[number];

export interface CardRule {
  title: string;
  /** `{drawer}` is replaced with the drawing player's name. */
  rule: string;
  effect: KingsCupEffect;
}

export type RuleTable = Record<Rank, CardRule>;

export const DEFAULT_RULES: Readonly<RuleTable> = Object.freeze({
  A: { title: "Waterfall", rule: "Everyone starts drinking with {drawer}; nobody may stop until the player before them stops.", effect: "none" },
  "2": { title: "You", rule: "{drawer} picks someone to drink.", effect: "target" },
  "3": { title: "Me", rule: "{drawer} drinks.", effect: "none" },
  "4": { title: "Floor", rule: "Last to touch the floor drinks.", effect: "none" },
  "5": { title: "Guys", rule: "All the guys drink.", effect: "none" },
  "6": { title: "Chicks", rule: "All the girls drink.", effect: "none" },
  "7": { title: "Heaven", rule: "Last to raise a hand drinks.", effect: "none" },
  "8": { title: "Mate", rule: "{drawer} picks a mate, who drinks whenever {drawer} drinks for the rest of the game.", effect: "mate" },
  "9": { title: "Rhyme", rule: "{drawer} says a word; going around, everyone rhymes with it. First to fail or repeat drinks.", effect: "none" },
  "10": { title: "Categories", rule: "{drawer} names a category; going around, everyone names something in it. First to fail or repeat drinks.", effect: "none" },
  J: { title: "Make a Rule", rule: "{drawer} makes a rule everyone must follow for the rest of the game.", effect: "make_rule" },
  Q: { title: "Question Master", rule: "{drawer} is Question Master: anyone who answers their question drinks, until another Queen is drawn.", effect: "question_master" },
  K: { title: "King's Cup", rule: "{drawer} pours some of their drink into the King's Cup. Whoever draws the 4th King drinks the whole cup.", effect: "kings_cup" },
});

export const MAX_RULE_TITLE = 40;
export const MAX_RULE_TEXT = 300;
export const MAX_CUSTOM_RULE = 200;

export interface KingsCupOptions {
  [key: string]: unknown;
  rules: RuleTable;
  /** Drawing the 4th King ends the game. When off, play runs until the deck is empty. */
  endOnFourthKing: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

export interface TurnCard {
  card: Card;
  drawer: string;
  resolved: boolean;
  target?: string;
  ruleText?: string;
}

export interface CustomRule {
  text: string;
  by: string;
  turn: number;
}

export interface KingsCupState extends CoreState {
  game: "kings_cup";
  rules: RuleTable;
  endOnFourthKing: boolean;
  deck: Deck<Card>;
  /** The card drawn this turn, until the turn ends. */
  turnCard: TurnCard | null;
  /** The card from the turn before, for continuity in the prompt. */
  previous: TurnCard | null;
  kingsDrawn: number;
  /** Players who have poured into the King's Cup, in order. */
  cup: string[];
  questionMaster: string | null;
  mates: Array<[string, string]>;
  customRules: CustomRule[];
}

const PHASES = {
  draw: "draw",
  resolve: "resolve",
  end_turn: "end of turn",
  game_over: "game over",
} as const;

// ─── Options ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

export function normalizeRules(raw: unknown): RuleTable {
  const source = isRecord(raw) ? raw : {};
  const table = {} as RuleTable;
  for (const rank of RANKS) {
    const base = DEFAULT_RULES[rank];
    const override = isRecord(source[rank]) ? source[rank] as Record<string, unknown> : {};
    let effect = EFFECTS.includes(override.effect as KingsCupEffect) ? override.effect as KingsCupEffect : base.effect;
    // Kings always count toward the cup; nothing else can.
    if (rank === "K") effect = "kings_cup";
    else if (effect === "kings_cup") effect = "none";
    table[rank] = {
      title: cleanText(override.title, MAX_RULE_TITLE) || base.title,
      rule: cleanText(override.rule, MAX_RULE_TEXT) || base.rule,
      effect,
    };
  }
  return table;
}

function defaultOptions(): KingsCupOptions {
  return { rules: normalizeRules({}), endOnFourthKing: true };
}

function normalizeOptions(raw: unknown): KingsCupOptions {
  const source = isRecord(raw) ? raw : {};
  return {
    rules: normalizeRules(source.rules),
    endOnFourthKing: source.endOnFourthKing !== false,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function ruleFor(state: Pick<KingsCupState, "rules">, card: Card): CardRule {
  return state.rules[card.rank];
}

export function ruleText(rule: CardRule, drawerName: string): string {
  return rule.rule.split("{drawer}").join(drawerName);
}

function describeDraw(state: KingsCupState, turnCard: TurnCard): string {
  const rule = ruleFor(state, turnCard.card);
  return playerName(state, turnCard.drawer) + " drew " + cardLabel(turnCard.card) + " (" + rule.title + ")";
}

function describeResolution(state: KingsCupState, turnCard: TurnCard): string {
  const rule = ruleFor(state, turnCard.card);
  const drawer = playerName(state, turnCard.drawer);
  switch (rule.effect) {
    case "target":
      return drawer + " picked " + playerName(state, turnCard.target) + " to drink.";
    case "mate":
      return drawer + " picked " + playerName(state, turnCard.target) + " as a mate.";
    case "make_rule":
      return turnCard.ruleText ? drawer + ' made a rule: "' + turnCard.ruleText + '".' : drawer + " made no new rule.";
    case "question_master":
      return drawer + " is now Question Master.";
    case "kings_cup":
      return drawer + " poured into the King's Cup.";
    default:
      return "The card's rule played out.";
  }
}

function pendingLine(state: KingsCupState, turnCard: TurnCard): string {
  const rule = ruleFor(state, turnCard.card);
  const drawer = playerName(state, turnCard.drawer);
  switch (rule.effect) {
    case "target":
      return "Waiting for " + drawer + " to pick who drinks. Do not pick for them.";
    case "mate":
      return "Waiting for " + drawer + " to pick a mate. Do not pick for them.";
    case "make_rule":
      return "Waiting for " + drawer + " to announce a new rule.";
    default:
      return "Now: the card's rule plays out.";
  }
}

function hasMatePair(state: KingsCupState, a: string, b: string): boolean {
  return state.mates.some(([left, right]) => (left === a && right === b) || (left === b && right === a));
}

function matesLine(state: KingsCupState): string {
  return state.mates.map(([a, b]) => playerName(state, a) + " ↔ " + playerName(state, b)).join(", ");
}

function rulesLine(state: KingsCupState): string {
  return state.customRules.map((entry, index) => String(index + 1) + ". " + entry.text + " (" + playerName(state, entry.by) + ")").join(" ");
}

// ─── Game definition ────────────────────────────────────────────────────────

function setup(players: Player[], options: KingsCupOptions, rng: Rng): KingsCupState {
  return {
    ...createCoreState(players, "draw", 2),
    game: "kings_cup",
    rules: options.rules,
    endOnFourthKing: options.endOnFourthKing,
    deck: createDeck(fullDeck(), rng),
    turnCard: null,
    previous: null,
    kingsDrawn: 0,
    cup: [],
    questionMaster: null,
    mates: [],
    customRules: [],
  };
}

function legalActions(state: KingsCupState): ActionDef[] {
  if (state.status !== "active") return [];
  const player = currentPlayer(state);
  switch (state.phase) {
    case "draw":
      return [{ type: "draw", label: "Draw a card", description: player.name + " draws the next card.", primary: true }];
    case "resolve": {
      const turnCard = state.turnCard;
      if (!turnCard) return [];
      const rule = ruleFor(state, turnCard.card);
      const others = playerChoices(state.players.filter((entry) => entry.active && entry.id !== turnCard.drawer));
      if (rule.effect === "target") {
        return [{
          type: "resolve",
          label: "Pick who drinks",
          primary: true,
          fields: [{ name: "target", kind: "player", label: "Who drinks", required: true, choices: others }],
        }];
      }
      if (rule.effect === "mate") {
        return [{
          type: "resolve",
          label: "Pick a mate",
          primary: true,
          fields: [{ name: "target", kind: "player", label: "Mate", required: true, choices: others }],
        }];
      }
      if (rule.effect === "make_rule") {
        return [{
          type: "resolve",
          label: "Record the rule",
          description: "Leave the rule blank if " + player.name + " makes none.",
          primary: true,
          fields: [{ name: "text", kind: "text", label: "New rule", required: false, placeholder: "e.g. No first names" }],
        }];
      }
      return [{ type: "resolve", label: "Card done", description: "The card's rule has played out.", primary: true }];
    }
    case "end_turn": {
      const next = nextPlayer(state);
      const description = state.deck.remaining.length === 0
        ? "The deck is empty; this ends the game."
        : next ? "Pass the deck to " + next.name + "." : undefined;
      return [{ type: "end_turn", label: "Next turn", primary: true, ...(description ? { description } : {}) }];
    }
    default:
      return [];
  }
}

function apply(input: KingsCupState, action: GameAction, _rng: Rng): KingsCupState {
  const state = cloneState(input);
  switch (action.type) {
    case "draw": {
      requirePhase(state, PHASES, ["draw"], action);
      const actor = requireCurrentActor(state, action);
      const card = drawFrom(state.deck);
      const turnCard: TurnCard = { card, drawer: actor.id, resolved: false };
      state.turnCard = turnCard;
      const rule = ruleFor(state, card);
      addLog(state, describeDraw(state, turnCard) + ".");
      if (rule.effect === "question_master") {
        state.questionMaster = actor.id;
      }
      if (rule.effect === "kings_cup") {
        state.kingsDrawn += 1;
        if (state.kingsDrawn >= 4 && state.endOnFourthKing) {
          turnCard.resolved = true;
          const reason = actor.name + " drew the 4th King and drinks the King's Cup.";
          addLog(state, reason);
          endGame(state, reason);
          return state;
        }
        state.cup.push(actor.id);
      }
      state.phase = "resolve";
      return state;
    }
    case "resolve": {
      requirePhase(state, PHASES, ["resolve"], action);
      const actor = requireCurrentActor(state, action);
      const turnCard = state.turnCard;
      if (!turnCard) throw new IllegalActionError("No card has been drawn this turn.");
      const rule = ruleFor(state, turnCard.card);
      if (rule.effect === "target") {
        turnCard.target = requireTarget(state, action, { excludeId: actor.id, label: "who drinks" }).id;
      } else if (rule.effect === "mate") {
        const mate = requireTarget(state, action, { excludeId: actor.id, label: "a mate" });
        turnCard.target = mate.id;
        if (!hasMatePair(state, actor.id, mate.id)) state.mates.push([actor.id, mate.id]);
      } else if (rule.effect === "make_rule") {
        const text = cleanText(action.text, MAX_CUSTOM_RULE);
        if (text) {
          turnCard.ruleText = text;
          state.customRules.push({ text, by: actor.id, turn: state.turn.number });
        }
      } else if (action.target !== undefined || cleanText(action.text, MAX_CUSTOM_RULE)) {
        throw new IllegalActionError(rule.title + " does not take a choice.");
      }
      turnCard.resolved = true;
      addLog(state, describeResolution(state, turnCard));
      state.phase = "end_turn";
      return state;
    }
    case "end_turn": {
      requirePhase(state, PHASES, ["end_turn"], action);
      requireCurrentActor(state, action);
      state.previous = state.turnCard;
      state.turnCard = null;
      if (state.deck.remaining.length === 0) {
        const reason = "The deck ran out after " + String(state.deck.drawn.length) + " cards.";
        addLog(state, reason);
        endGame(state, reason);
        return state;
      }
      advanceTurn(state, "draw");
      return state;
    }
    default:
      return unknownAction(state, PHASES, action);
  }
}

function promptBlock(state: KingsCupState): string {
  const lines: string[] = [];
  const names = state.players.filter((player) => player.active).map((player) => player.name);
  lines.push("Players in turn order: " + names.join(", ") + ".");
  if (state.status === "ended") {
    lines.push("Game over: " + (state.endReason ?? "the game has ended.") + " No more cards are drawn.");
  } else {
    const player = currentPlayer(state);
    lines.push("It is " + player.name + "'s turn.");
    if (state.phase === "draw") {
      lines.push(player.name + " has not drawn a card yet.");
      if (state.previous) lines.push("Last card: " + describeDraw(state, state.previous) + ". " + describeResolution(state, state.previous));
    } else if (state.turnCard) {
      const rule = ruleFor(state, state.turnCard.card);
      lines.push(describeDraw(state, state.turnCard) + ": " + ruleText(rule, player.name));
      lines.push(state.phase === "resolve"
        ? pendingLine(state, state.turnCard)
        : "Resolved: " + describeResolution(state, state.turnCard) + " " + player.name + "'s turn is wrapping up.");
    }
  }
  const cupPart = state.cup.length ? " The King's Cup holds pours from " + joinNames(state.cup.map((id) => playerName(state, id))) + "." : "";
  lines.push("Kings drawn: " + String(state.kingsDrawn) + "/4." + cupPart + " Cards left: " + String(state.deck.remaining.length) + ".");
  if (state.questionMaster) lines.push("Question Master: " + playerName(state, state.questionMaster) + ".");
  if (state.mates.length) lines.push("Mates: " + matesLine(state) + ".");
  if (state.customRules.length) lines.push("Rules in play: " + rulesLine(state));
  const next = nextPlayer(state);
  if (next && state.status === "active") lines.push("Next up: " + next.name + ".");
  return formatBlock("Kings Cup — turn " + String(state.turn.number), lines);
}

function view(state: KingsCupState): GameView {
  const current = state.status === "active" ? currentPlayer(state) : null;
  const next = nextPlayer(state);
  let headline: string;
  let detail: string | undefined;
  if (state.status === "ended") {
    headline = "Game over";
    detail = state.endReason ?? undefined;
  } else if (state.turnCard && current) {
    const rule = ruleFor(state, state.turnCard.card);
    headline = current.name + " drew " + cardLabel(state.turnCard.card) + " — " + rule.title;
    detail = ruleText(rule, current.name);
    if (state.phase === "end_turn") detail += " " + describeResolution(state, state.turnCard);
  } else {
    headline = (current?.name ?? "Someone") + " to draw";
    detail = state.previous ? "Last card: " + describeDraw(state, state.previous) + "." : undefined;
  }
  const facts = [
    { label: "Kings", value: String(state.kingsDrawn) + "/4" },
    { label: "Cards left", value: String(state.deck.remaining.length) },
  ];
  if (state.cup.length) facts.push({ label: "King's Cup", value: joinNames(state.cup.map((id) => playerName(state, id))) });
  if (state.questionMaster) facts.push({ label: "Question Master", value: playerName(state, state.questionMaster) });
  if (state.mates.length) facts.push({ label: "Mates", value: matesLine(state) });
  state.customRules.forEach((entry, index) => {
    facts.push({ label: "Rule " + String(index + 1), value: entry.text + " (" + playerName(state, entry.by) + ")" });
  });
  return {
    gameId: "kings_cup",
    gameName: "Kings Cup",
    status: state.status,
    turnNumber: state.turn.number,
    phase: state.phase,
    phaseLabel: PHASES[state.phase as keyof typeof PHASES] ?? state.phase,
    currentPlayerId: current?.id ?? null,
    nextPlayerId: next?.id ?? null,
    players: state.players.map((player) => {
      const badges: string[] = [];
      if (state.questionMaster === player.id) badges.push("Question Master");
      for (const [a, b] of state.mates) {
        if (a === player.id) badges.push("Mate: " + playerName(state, b));
        else if (b === player.id) badges.push("Mate: " + playerName(state, a));
      }
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

export const kingsCup: GameDefinition<KingsCupState, KingsCupOptions> = {
  id: "kings_cup",
  name: "Kings Cup",
  description: "Draw from a 52-card deck; every card has a rule. Whoever draws the 4th King drinks the King's Cup.",
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
