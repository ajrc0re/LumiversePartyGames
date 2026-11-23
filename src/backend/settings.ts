import type { PartyGamesSettings } from "../types";

export const SETTINGS_PATH = "settings.json";
export const MAX_INJECTION_DEPTH = 50;

export const DEFAULT_SETTINGS: Readonly<PartyGamesSettings> = Object.freeze({
  autoInject: true,
  injectionDepth: 1,
});

export function normalizeSettings(raw: unknown): PartyGamesSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const depth = Number(source.injectionDepth);
  return {
    autoInject: typeof source.autoInject === "boolean" ? source.autoInject : DEFAULT_SETTINGS.autoInject,
    injectionDepth: Number.isInteger(depth) ? Math.min(MAX_INJECTION_DEPTH, Math.max(0, depth)) : DEFAULT_SETTINGS.injectionDepth,
  };
}

/**
 * Depth 0 is the newest edge of the prompt; larger depths count back from it.
 * Returns a new array.
 */
export function insertAtDepth<T>(messages: readonly T[], value: T, depth: number): T[] {
  const index = Math.max(0, messages.length - Math.max(0, depth));
  return [...messages.slice(0, index), value, ...messages.slice(index)];
}
