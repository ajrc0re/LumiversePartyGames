/** Per-game option panels for the setup screen, and the Kings Cup rule editor. */
import { el, type Child } from "./dom";
import type { RuleEdit, SetupDraft } from "./frontend-model";
import { DEFAULT_RULES, EFFECT_LABELS, EFFECTS, RANKS } from "./games/kings-cup";
import {
  BUNDLED_DARES,
  BUNDLED_TRUTHS,
  MAX_FORFEIT_TEXT,
  MAX_STRIKE_LIMIT,
  promptPool,
  TIER_LABELS,
  TIERS,
  truthOrDare,
  type BundledPrompt,
  type RefusalRule,
  type Tier,
} from "./games/truth-or-dare";

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
  if (draft.gameId === "truth_or_dare") return truthOrDareOptions(draft, kit);
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

// ─── Truth or Dare ──────────────────────────────────────────────────────────

const REFUSAL_LABELS: Record<RefusalRule, string> = {
  free: "Nothing happens",
  forfeit: "They pay a forfeit",
  strikes: "They get a strike",
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function truthOrDareOptions(draft: SetupDraft, kit: PanelKit): HTMLElement[] {
  const options = draft.options;
  const tiers = new Set(stringList(options.tiers) as Tier[]);
  const disabled = new Set(stringList(options.disabled));

  // Pool size updates in place as prompts are toggled, without a re-render.
  const poolSummary = el("p", { class: "pg-muted pg-pool" });
  const updatePool = () => {
    const normalized = truthOrDare.normalizeOptions(options);
    const truths = promptPool(normalized, "truth").length;
    const dares = promptPool(normalized, "dare").length;
    poolSummary.textContent = truths + dares === 0
      ? "No prompts selected: turn on an intensity or add your own."
      : "This game plays with " + String(truths) + " truth" + (truths === 1 ? "" : "s") + " and " + String(dares) + " dare" + (dares === 1 ? "" : "s") + ".";
    poolSummary.classList.toggle("bad", truths + dares === 0);
  };
  updatePool();

  const tierRows = TIERS.map((tier) => {
    const box = el("input", { type: "checkbox", checked: tiers.has(tier) });
    box.addEventListener("change", () => {
      if (box.checked) tiers.add(tier);
      else tiers.delete(tier);
      options.tiers = TIERS.filter((entry) => tiers.has(entry));
      kit.render();
    });
    return el("label", { class: "pg-check" }, box, el("span", {}, el("b", { text: TIER_LABELS[tier].label }), " — " + TIER_LABELS[tier].description));
  });

  const refusals = (["free", "forfeit", "strikes"] as const).includes(options.refusals as RefusalRule) ? options.refusals as RefusalRule : "forfeit";
  const refusalSelect = el("select", { class: "pg-select", "aria-label": "When someone refuses" });
  for (const rule of ["free", "forfeit", "strikes"] as const) {
    refusalSelect.append(el("option", { value: rule, selected: refusals === rule, text: REFUSAL_LABELS[rule] }));
  }
  refusalSelect.addEventListener("change", () => {
    options.refusals = refusalSelect.value;
    kit.render();
  });
  let refusalDetail: HTMLElement | null = null;
  if (refusals === "forfeit") {
    const forfeit = el("input", { class: "pg-input", type: "text", value: typeof options.forfeit === "string" ? options.forfeit : "drinks", maxlength: String(MAX_FORFEIT_TEXT), placeholder: "drinks", "aria-label": "Forfeit" });
    forfeit.addEventListener("input", () => {
      options.forfeit = forfeit.value;
    });
    refusalDetail = el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "Someone who refuses…" }), forfeit);
  } else if (refusals === "strikes") {
    const limit = el("input", { class: "pg-input", type: "number", min: "1", max: String(MAX_STRIKE_LIMIT), step: "1", value: String(options.strikeLimit ?? 3), "aria-label": "Strikes before a player is out" });
    limit.addEventListener("input", () => {
      options.strikeLimit = Number(limit.value);
    });
    refusalDetail = el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "Strikes before a player is out" }), limit);
  }

  const customArea = (key: "customTruths" | "customDares", label: string, placeholder: string) => {
    const area = el("textarea", { class: "pg-input pg-textarea wide", rows: "4", placeholder, "aria-label": label });
    area.value = stringList(options[key]).join("\n");
    area.addEventListener("input", () => {
      options[key] = area.value.split("\n");
      updatePool();
    });
    return el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: label }), area);
  };

  const bundledList = (title: string, prompts: readonly BundledPrompt[]) => {
    const list = el("div", { class: "pg-prompts" });
    for (const prompt of prompts) {
      const box = el("input", { type: "checkbox", checked: !disabled.has(prompt.id) });
      box.addEventListener("change", () => {
        if (box.checked) disabled.delete(prompt.id);
        else disabled.add(prompt.id);
        options.disabled = [...disabled];
        updatePool();
      });
      list.append(el("label", { class: "pg-check pg-prompt" + (tiers.has(prompt.tier) ? "" : " off") },
        box,
        el("span", {}, el("span", { class: "pg-badge", text: TIER_LABELS[prompt.tier].label }), " " + prompt.text),
      ));
    }
    return el("div", {}, el("h4", { class: "pg-subhead", text: title }), list);
  };

  return [
    el("section", { class: "pg-section" },
      el("h3", { text: "Intensity" }),
      ...tierRows,
    ),
    el("section", { class: "pg-section" },
      el("h3", { text: "Refusing" }),
      el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "When someone refuses a truth or dare" }), refusalSelect),
      refusalDetail,
    ),
    kit.collapsible("tod-custom", "Your own truths and dares",
      el("p", { class: "pg-muted" },
        "One per line. They are always in the game, whatever the intensity. ",
        el("span", { class: "pg-code", text: "{player}" }), " is whoever is taking the turn; ",
        el("span", { class: "pg-code", text: "{other}" }), " is another player picked at random.",
      ),
      customArea("customTruths", "Truths", "What is the strangest thing {other} has ever said to you?"),
      customArea("customDares", "Dares", "Let {other} pick your next line of dialogue."),
    ),
    kit.collapsible("tod-bundled", "Bundled prompts",
      el("p", { class: "pg-muted", text: "Untick any you never want to come up. Prompts from intensities you have turned off are greyed out." }),
      bundledList("Truths", BUNDLED_TRUTHS),
      bundledList("Dares", BUNDLED_DARES),
    ),
    el("section", { class: "pg-section" },
      poolSummary,
      el("div", { class: "pg-actions" },
        kit.button("Save as my default", () => kit.saveDefaults(draft.gameId, "Truth or Dare", options), { small: true }),
        kit.button("Reset to standard settings", () => {
          draft.options = truthOrDare.defaultOptions();
          kit.render();
        }, { small: true }),
      ),
    ),
  ];
}
