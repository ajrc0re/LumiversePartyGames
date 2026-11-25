/** Per-game option panels for the setup screen, and the Kings Cup rule editor. */
import { el, type Child } from "./dom";
import type { RuleEdit, SetupDraft } from "./frontend-model";
import { DEFAULT_RULES, EFFECT_LABELS, EFFECTS, RANKS } from "./games/kings-cup";

/** What the option panels need from the panel that hosts them. */
export interface PanelKit {
  button(label: string, onClick: () => void, options?: { primary?: boolean; danger?: boolean; small?: boolean; disabled?: boolean; title?: string }): HTMLButtonElement;
  /** A collapsible section that remembers whether it is open. */
  collapsible(id: string, summary: string, ...children: Child[]): HTMLDetailsElement;
  render(): void;
  /** Saves `options` as the user's default for `gameId` and confirms it. */
  saveDefaults(gameId: string, gameName: string, options: Record<string, unknown>): void;
}

export function renderGameOptions(draft: SetupDraft, kit: PanelKit): HTMLElement[] {
  if (draft.gameId === "kings_cup") return kingsCupOptions(draft, kit);
  return [];
}

// ─── Kings Cup ──────────────────────────────────────────────────────────────

/**
 * Kings Cup card rule rows bound to `values` (edited in place). Kings stay
 * "King's Cup"; every other card can take any of the other effects.
 */
export function renderRuleRows(values: Record<string, RuleEdit>): HTMLElement {
  const list = el("div", { class: "pg-rules" });
  for (const rank of RANKS) {
    const entry = values[rank];
    if (!entry) continue;
    const title = el("input", { class: "pg-input", type: "text", value: entry.title, maxlength: "40", "aria-label": rank + " title" });
    title.addEventListener("input", () => {
      entry.title = title.value;
    });
    // Tall enough for the rule as written; the handle still allows resizing.
    const rows = Math.min(5, Math.max(2, Math.ceil(entry.rule.length / 42)));
    const rule = el("textarea", { class: "pg-input pg-textarea", maxlength: "300", rows: String(rows), "aria-label": rank + " rule" });
    rule.value = entry.rule;
    rule.addEventListener("input", () => {
      entry.rule = rule.value;
    });
    let effect: HTMLElement;
    if (rank === "K") {
      effect = el("span", { class: "pg-rule-locked", text: EFFECT_LABELS.kings_cup });
    } else {
      const select = el("select", { class: "pg-select", "aria-label": rank + " effect", title: "What drawing this card asks of the drawer" });
      for (const option of EFFECTS) {
        if (option === "kings_cup") continue;
        select.append(el("option", { value: option, selected: entry.effect === option, text: EFFECT_LABELS[option] }));
      }
      select.addEventListener("change", () => {
        entry.effect = select.value;
      });
      effect = select;
    }
    list.append(el("div", { class: "pg-rule" }, el("span", { class: "pg-rule-rank", text: rank }), title, effect, rule));
  }
  return list;
}

function kingsCupOptions(draft: SetupDraft, kit: PanelKit): HTMLElement[] {
  const fourthKing = el("input", { type: "checkbox", checked: draft.options.endOnFourthKing !== false });
  fourthKing.addEventListener("change", () => {
    draft.options.endOnFourthKing = fourthKing.checked;
  });
  const rules = (draft.options.rules ?? (draft.options.rules = structuredClone(DEFAULT_RULES))) as Record<string, RuleEdit>;
  return [
    el("section", { class: "pg-section" },
      el("h3", { text: "House rules" }),
      el("label", { class: "pg-check" }, fourthKing, el("span", { text: "The 4th King ends the game (otherwise play until the deck runs out)" })),
    ),
    kit.collapsible("setup-rules", "Card rules",
      el("p", { class: "pg-muted", text: "What each card means in this game. {drawer} is replaced with the drawing player's name." }),
      renderRuleRows(rules),
      el("div", { class: "pg-actions" },
        kit.button("Save as my default", () => kit.saveDefaults(draft.gameId, "Kings Cup", draft.options), { small: true }),
        kit.button("Reset to standard rules", () => {
          draft.options.rules = structuredClone(DEFAULT_RULES);
          kit.render();
        }, { small: true }),
      ),
    ),
  ];
}
