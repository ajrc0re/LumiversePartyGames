/** Pure helpers for the panel and input-bar button. No DOM, no Spindle. */
import type { ActionDef, ActionField, ChatGameState, GameAction, GameSummary, PlayerInput } from "./types";

export interface ActionValues {
  target?: string;
  players?: string[];
  text?: string;
}

export function primaryAction(state: ChatGameState | null): ActionDef | null {
  const actions = state?.game?.actions ?? [];
  return actions.find((action) => action.primary) ?? actions[0] ?? null;
}

export function needsInput(action: ActionDef): boolean {
  return Boolean(action.fields?.some((field) => field.required));
}

/** The action payload sent to the backend; blank values are left out. */
export function buildAction(definition: ActionDef, values: ActionValues = {}): GameAction {
  const action: GameAction = { ...definition.preset, type: definition.type };
  for (const field of definition.fields ?? []) {
    if (field.name === "target" && values.target) action.target = values.target;
    if (field.name === "text" && values.text?.trim()) action.text = values.text.trim();
    if (field.name === "players" && values.players?.length) action.players = [...values.players];
  }
  return action;
}

/** The first required field the user has not filled in, or null when the action can be sent. */
export function missingField(definition: ActionDef, values: ActionValues): ActionField | null {
  for (const field of definition.fields ?? []) {
    if (!field.required) continue;
    const filled = field.name === "target" ? Boolean(values.target)
      : field.name === "players" ? Boolean(values.players?.length)
      : Boolean(values.text?.trim());
    if (!filled) return field;
  }
  return null;
}

export interface InputBarModel {
  label: string;
  /** "act" sends the primary action; "open" opens the panel. */
  mode: "act" | "open";
}

export function inputBarModel(state: ChatGameState | null): InputBarModel {
  const game = state?.game;
  if (!game) return { label: "Party Games: start a game", mode: "open" };
  const name = game.view.gameName;
  const primary = primaryAction(state);
  if (!primary) return { label: name + ": game over", mode: "open" };
  const player = game.view.players.find((entry) => entry.id === game.view.currentPlayerId)?.name;
  const who = player ? " (" + player + ")" : "";
  if (needsInput(primary)) return { label: name + ": " + primary.label + "…" + who, mode: "open" };
  return { label: name + ": " + primary.label + who, mode: "act" };
}

export function setupProblem(game: GameSummary | undefined, players: readonly PlayerInput[]): string | null {
  if (!game) return "Choose a game.";
  if (!game.available) return game.name + " is not available yet.";
  const named = players.filter((player) => player.name.trim());
  if (named.length < game.minPlayers) return game.name + " needs at least " + String(game.minPlayers) + " players.";
  return null;
}

/** Request ids without crypto.randomUUID, which LAN clients on plain HTTP lack. */
export function requestIdFactory(prefix = "pg"): () => string {
  let sequence = 0;
  return () => prefix + "-" + Date.now().toString(36) + "-" + (++sequence).toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
}
