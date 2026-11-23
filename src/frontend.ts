import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import {
  buildAction,
  changedRules,
  inputBarModel,
  missingField,
  needsInput,
  primaryAction,
  requestIdFactory,
  setupProblem,
  startInput,
  type ActionValues,
  type RuleEdit,
  type SetupDraft,
} from "./frontend-model";
import { el, type Child } from "./dom";
import { renderGameOptions, renderRuleRows, type PanelKit } from "./frontend-options";
import { partyStyles, STYLE_ID } from "./styles";
import type {
  ActionDef,
  ActionField,
  ChatGameState,
  GameView,
  PartyRequestAction,
  UserName,
} from "./types";

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="11" height="15" rx="2" transform="rotate(-8 8.5 12.5)"/><rect x="10" y="4" width="11" height="15" rx="2" transform="rotate(8 15.5 11.5)"/><path d="M15.5 9.5l-1.6 2.6 2.6 1.6 1.6-2.6z"/></svg>';
const REQUEST_TIMEOUT_MS = 20000;
const REFRESH_DELAY_MS = 150;
const REFRESH_EVENTS = [
  "CHAT_SWITCHED",
  "CHAT_CHANGED",
  "MESSAGE_SENT",
  "MESSAGE_DELETED",
  "MESSAGE_SWIPED",
  "SWIPE_EDITED",
  "GENERATION_ENDED",
  "GENERATION_STOPPED",
];
const MAX_PARTICIPANTS = 15;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = partyStyles;
  document.head.appendChild(style);
}

export function setup(ctx: SpindleFrontendContext): () => void {
  injectStyles();
  const disposers: Array<() => void> = [];
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const nextRequestId = requestIdFactory("pg");
  const drafts = new Map<string, SetupDraft>();
  const actionValues = new Map<string, ActionValues>();
  /** Persona names behind {{user}}, per chat; "" when it could not be read. */
  const userNames = new Map<string, string>();
  /** Unsaved mid-game card rule edits, per game session. */
  const ruleEdits = new Map<string, Record<string, RuleEdit>>();
  /** Collapsible sections the user has opened, so re-renders keep them open. */
  const openSections = new Set<string>();

  let chatId: string | null = ctx.getActiveChat().chatId;
  let state: ChatGameState | null = null;
  let stateKey = "";
  let error: string | null = null;
  let info: string | null = null;
  let busy = false;
  let loading = false;
  let refreshVersion = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const tab = ctx.ui.registerDrawerTab({
    id: "party-games",
    title: "Party Games",
    shortName: "Games",
    description: "Play Kings Cup and other party games in this chat",
    keywords: ["party", "game", "kings cup", "drinking", "cards", "truth or dare", "never have i ever"],
    iconSvg: ICON,
  });
  const root = el("div", { class: "pg-root" });
  tab.root.appendChild(root);

  // ─── Backend requests ─────────────────────────────────────────────────────

  function request<T>(action: PartyRequestAction, input: Record<string, unknown> = {}): Promise<T> {
    const requestId = nextRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Party Games did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        ctx.sendToBackend({ type: "party:request", requestId, action, input });
      } catch (sendError) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(sendError instanceof Error ? sendError : new Error(String(sendError)));
      }
    });
  }

  function setState(next: ChatGameState | null): void {
    const key = JSON.stringify(next);
    if (key === stateKey) return;
    stateKey = key;
    state = next;
    render();
  }

  async function refresh(): Promise<void> {
    const version = ++refreshVersion;
    const activeChat = ctx.getActiveChat().chatId;
    if (activeChat !== chatId) {
      error = null;
      info = null;
    }
    chatId = activeChat;
    if (!chatId) {
      setState(null);
      updateInputBar();
      render();
      return;
    }
    const requestedChat = chatId;
    loading = state === null || state.chatId !== requestedChat;
    if (loading) render();
    try {
      const next = await request<ChatGameState>("state", { chatId: requestedChat });
      if (destroyed || version !== refreshVersion) return;
      const wasLoading = loading;
      loading = false;
      setState(next);
      if (wasLoading) render();
      if (!next.game) void loadUserName(requestedChat);
    } catch (refreshError) {
      if (destroyed || version !== refreshVersion) return;
      loading = false;
      error = errorMessage(refreshError);
      render();
    }
    updateInputBar();
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_DELAY_MS);
  }

  async function run(action: PartyRequestAction, input: Record<string, unknown> = {}): Promise<boolean> {
    if (busy) return false;
    const target = chatId;
    if (!target && action !== "save-settings") return false;
    busy = true;
    error = null;
    info = null;
    render();
    let ok = false;
    try {
      const next = await request<ChatGameState | null>(action, { ...input, chatId: target });
      if (next && next.chatId === chatId) setState(next);
      ok = true;
    } catch (runError) {
      error = errorMessage(runError);
    } finally {
      busy = false;
      render();
      updateInputBar();
    }
    return ok;
  }

  // ─── Setup drafts ─────────────────────────────────────────────────────────

  function draftFor(chat: string): SetupDraft {
    let draft = drafts.get(chat);
    if (!draft) {
      const firstAvailable = state?.games.find((game) => game.available)?.id ?? "kings_cup";
      draft = { gameId: firstAvailable, includeUser: true, participants: [""], turnOrder: "listed", options: {}, optionsGameId: null };
      drafts.set(chat, draft);
    }
    // Start each game's options from the user's saved defaults (or the standard ones).
    if (draft.optionsGameId !== draft.gameId && state?.gameDefaults[draft.gameId]) {
      draft.options = structuredClone(state.gameDefaults[draft.gameId]!);
      draft.optionsGameId = draft.gameId;
    }
    return draft;
  }

  async function loadUserName(chat: string): Promise<void> {
    if (userNames.has(chat)) return;
    userNames.set(chat, "");
    try {
      const result = await request<UserName>("user-name", { chatId: chat });
      userNames.set(chat, result.name);
    } catch {
      userNames.set(chat, "");
    }
    if (chat === chatId) render();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function notice(text: string, kind: "warning" | "error" | "info" = "warning"): HTMLElement {
    return el("div", { class: "pg-notice" + (kind === "warning" ? "" : " " + kind), role: kind === "error" ? "alert" : "status", text });
  }

  /** A collapsible section that stays open across re-renders once opened. */
  function collapsible(id: string, summary: string, ...children: Child[]): HTMLDetailsElement {
    const details = el("details", { class: "pg-section pg-details", open: openSections.has(id) },
      el("summary", { text: summary }),
      ...children,
    );
    details.addEventListener("toggle", () => {
      if (details.open) openSections.add(id);
      else openSections.delete(id);
    });
    return details;
  }

  function button(label: string, onClick: () => void, options: { primary?: boolean; danger?: boolean; small?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
    const classes = ["pg-button", options.primary ? "primary" : "", options.danger ? "danger" : "", options.small ? "small" : ""].filter(Boolean).join(" ");
    return el("button", { type: "button", class: classes, disabled: Boolean(options.disabled || busy), title: options.title, onclick: onClick, text: label });
  }

  function renderSetup(chat: string, current: ChatGameState): HTMLElement[] {
    const draft = draftFor(chat);
    const games = current.games;
    const selected = games.find((game) => game.id === draft.gameId);
    const problem = setupProblem(selected, draft);
    const startButton = button("Start " + (selected?.name ?? "game"), () => void run("start", { ...startInput(draft) }), { primary: true, disabled: Boolean(problem) });
    const problemText = el("span", { class: "pg-muted", text: problem ?? "" });
    /**
     * Typing only updates the start button in place. A full re-render here
     * would replace the element under the pointer and swallow the click that
     * blurred the field (for example on Start).
     */
    const refreshStart = () => {
      const current = setupProblem(selected, draft);
      startButton.disabled = Boolean(current) || busy;
      problemText.textContent = current ?? "";
    };

    const gameList = el("div", { class: "pg-games", role: "radiogroup", "aria-label": "Game" });
    for (const game of games) {
      const radio = el("input", { type: "radio", name: "pg-game", value: game.id, checked: draft.gameId === game.id, disabled: !game.available });
      radio.addEventListener("change", () => {
        draft.gameId = game.id;
        render();
      });
      gameList.append(el("label", { class: "pg-game", "aria-disabled": game.available ? "false" : "true" },
        radio,
        el("span", {},
          el("span", { class: "pg-game-name", text: game.name }),
          game.available ? null : el("span", { class: "pg-soon", text: "Coming soon" }),
          el("div", { class: "pg-muted", text: game.description }),
        ),
      ));
    }

    // Seat 1: the user's persona, behind a toggle.
    const userName = userNames.get(chat) ?? "";
    const includeUser = el("input", { type: "checkbox", checked: draft.includeUser });
    includeUser.addEventListener("change", () => {
      draft.includeUser = includeUser.checked;
      render();
    });
    const userHint = !draft.includeUser ? "(left out)" : userName ? "(" + userName + ")" : "(your persona name)";
    const seats = el("div", { class: "pg-seats" },
      el("div", { class: "pg-seat user" },
        el("span", { class: "pg-seat-number", text: draft.includeUser ? "1" : "–" }),
        el("label", { class: "pg-check inline" }, includeUser, el("span", {}, "Include ", el("span", { class: "pg-code", text: "{{user}}" }), " ", el("span", { class: "pg-muted", text: userHint }))),
      ),
    );
    const firstNumber = draft.includeUser ? 2 : 1;
    draft.participants.forEach((value, index) => {
      const name = el("input", { class: "pg-input", type: "text", value, placeholder: "Character name", maxlength: "60", "aria-label": "Participant " + String(index + 1) + " name" });
      name.addEventListener("input", () => {
        draft.participants[index] = name.value;
        refreshStart();
      });
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && name.value.trim() && index === draft.participants.length - 1 && draft.participants.length < MAX_PARTICIPANTS) {
          draft.participants.push("");
          render();
          root.querySelectorAll<HTMLInputElement>(".pg-seat:not(.user) .pg-input")[index + 1]?.focus();
        }
      });
      seats.append(el("div", { class: "pg-seat" },
        el("span", { class: "pg-seat-number", text: String(firstNumber + index) }),
        name,
        el("span", { class: "pg-row" },
          button("↑", () => {
            const [moved] = draft.participants.splice(index, 1);
            if (moved !== undefined) draft.participants.splice(index - 1, 0, moved);
            render();
          }, { small: true, disabled: index === 0, title: "Move up" }),
          button("✕", () => {
            draft.participants.splice(index, 1);
            render();
          }, { small: true, title: "Remove" }),
        ),
      ));
    });

    const order = el("select", { class: "pg-select", "aria-label": "Turn order" });
    order.append(
      el("option", { value: "listed", selected: draft.turnOrder === "listed", text: "As listed" }),
      el("option", { value: "random", selected: draft.turnOrder === "random", text: "Random (shuffled at the start)" }),
    );
    order.addEventListener("change", () => {
      draft.turnOrder = order.value === "random" ? "random" : "listed";
    });

    const kit: PanelKit = {
      button,
      collapsible,
      render,
      saveDefaults: (gameId, gameName, options) => {
        void run("save-defaults", { gameId, options }).then((ok) => {
          if (ok) {
            info = "Saved. New " + gameName + " games start with these settings.";
            render();
          }
        });
      },
    };
    const gameOptions = renderGameOptions(draft, kit);

    return [
      el("section", { class: "pg-section" }, el("h3", { text: "Pick a game" }), gameList),
      el("section", { class: "pg-section" },
        el("h3", { text: "Participants" }),
        seats,
        el("div", { class: "pg-actions" }, button("Add participant", () => {
          draft.participants.push("");
          render();
          const inputs = root.querySelectorAll<HTMLInputElement>(".pg-seat:not(.user) .pg-input");
          inputs[inputs.length - 1]?.focus();
        }, { small: true, disabled: draft.participants.length >= MAX_PARTICIPANTS })),
        el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "Turn order" }), order),
      ),
      ...gameOptions,
      el("div", { class: "pg-actions" }, startButton, problemText),
    ];
  }

  function renderField(field: ActionField, values: ActionValues): HTMLElement {
    if (field.kind === "player") {
      const select = el("select", { class: "pg-select", "aria-label": field.label });
      select.append(el("option", { value: "", text: "Choose…" }));
      for (const choice of field.choices ?? []) {
        select.append(el("option", { value: choice.id, selected: values.target === choice.id, text: choice.label }));
      }
      select.addEventListener("change", () => {
        values.target = select.value || undefined;
        render();
      });
      return el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: field.label + (field.required ? "" : " (optional)") }), select);
    }
    if (field.kind === "players") {
      const box = el("div", { class: "pg-row" });
      for (const choice of field.choices ?? []) {
        const check = el("input", { type: "checkbox", checked: Boolean(values.players?.includes(choice.id)) });
        check.addEventListener("change", () => {
          const chosen = new Set(values.players ?? []);
          if (check.checked) chosen.add(choice.id);
          else chosen.delete(choice.id);
          values.players = [...chosen];
          render();
        });
        box.append(el("label", { class: "pg-row" }, check, choice.label));
      }
      return el("div", { class: "pg-field" }, el("span", { class: "pg-label", text: field.label }), box);
    }
    const input = el("input", { class: "pg-input", type: "text", value: values.text ?? "", placeholder: field.placeholder, maxlength: "200", "aria-label": field.label });
    input.addEventListener("input", () => {
      values.text = input.value;
    });
    return el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: field.label + (field.required ? "" : " (optional)") }), input);
  }

  function renderActions(game: NonNullable<ChatGameState["game"]>): HTMLElement | null {
    if (!game.actions.length) return null;
    const section = el("section", { class: "pg-section", "aria-label": "Actions" });
    const actionButton = (action: ActionDef, values: ActionValues, key: string) => {
      // Choices re-render on change, so their buttons can disable; text is checked on click so typing keeps focus.
      const missing = missingField(action, values);
      const blocked = missing && missing.kind !== "text" ? missing : null;
      return button(action.label, () => {
        const unfilled = missingField(action, values);
        if (unfilled) {
          error = "Fill in “" + unfilled.label + "” first.";
          render();
          return;
        }
        void run("act", { action: buildAction(action, values) }).then((ok) => {
          if (ok) actionValues.delete(key);
        });
      }, { primary: Boolean(action.primary), disabled: Boolean(blocked), title: blocked ? "Choose " + blocked.label.toLowerCase() + " first" : action.description });
    };

    // Actions that take input get their own block; the rest share one row of buttons.
    const simple: ActionDef[] = [];
    for (const action of game.actions) {
      const key = game.sessionId + ":" + String(game.view.turnNumber) + ":" + game.view.phase + ":" + action.type + ":" + JSON.stringify(action.preset ?? {});
      if (!action.fields?.length) {
        simple.push(action);
        continue;
      }
      let values = actionValues.get(key);
      if (!values) {
        values = {};
        actionValues.set(key, values);
      }
      section.append(el("div", { class: "pg-action" },
        action.description ? el("p", { class: "pg-muted", text: action.description }) : null,
        ...(action.fields ?? []).map((field) => renderField(field, values)),
        el("div", { class: "pg-actions" }, actionButton(action, values, key)),
      ));
    }
    if (simple.length) {
      const notes = simple.filter((action) => action.description);
      section.append(el("div", { class: "pg-action" },
        el("div", { class: "pg-actions first" }, ...simple.map((action) => actionButton(action, {}, ""))),
        notes.length
          ? el("ul", { class: "pg-notes" }, ...notes.map((action) => el("li", {},
            simple.length > 1 ? el("b", { text: action.label + ": " }) : null,
            action.description ?? "",
          )))
          : null,
      ));
    }
    return section;
  }

  function renderScoreboard(view: GameView): HTMLElement {
    const current = view.players.find((player) => player.id === view.currentPlayerId);
    const next = view.players.find((player) => player.id === view.nextPlayerId);
    return el("section", { class: "pg-section", "aria-live": "polite" },
      el("div", { class: "pg-kicker", text: view.gameName + " · Turn " + String(view.turnNumber) + " · " + view.phaseLabel }),
      el("p", { class: "pg-headline", text: view.headline }),
      view.detail ? el("p", { class: "pg-detail", text: view.detail }) : null,
      view.status === "active"
        ? el("div", { class: "pg-turn" },
          el("span", {}, "Now: ", el("b", { text: current?.name ?? "—" })),
          el("span", {}, "Next up: ", el("b", { text: next?.name ?? "—" })),
        )
        : null,
      view.status === "active" ? renderDirectionToggle(view) : null,
    );
  }

  /** Flips play direction mid-game; recorded like any action, so undo and swipes cover it. */
  function renderDirectionToggle(view: GameView): HTMLElement {
    const reversed = el("input", { type: "checkbox", checked: view.direction === "reversed", disabled: busy });
    reversed.addEventListener("change", () => {
      void run("act", { action: { type: "set_direction", choice: reversed.checked ? "reversed" : "forward" } });
    });
    return el("label", { class: "pg-check" }, reversed, el("span", { text: "Reverse turn order" }));
  }

  function renderRuleEditor(game: NonNullable<ChatGameState["game"]>): HTMLElement | null {
    const current = game.view.cardRules;
    if (!current?.length || game.view.status !== "active") return null;
    let edits = ruleEdits.get(game.sessionId);
    if (!edits) {
      edits = Object.fromEntries(current.map((entry) => [entry.id, { title: entry.title, rule: entry.rule, effect: entry.effect }]));
      ruleEdits.set(game.sessionId, edits);
    }
    const values = edits;
    return collapsible("game-rules", "Card rules",
      el("p", { class: "pg-muted", text: "Change what a card means mid-game. Changes are recorded like any other action, so Undo takes them back." }),
      renderRuleRows(values),
      el("div", { class: "pg-actions" },
        button("Save rule changes", () => {
          const changed = changedRules(current, values);
          if (!Object.keys(changed).length) {
            info = "No rule changes to save.";
            render();
            return;
          }
          void run("act", { action: { type: "set_rules", data: { rules: changed } } }).then((ok) => {
            if (ok) {
              ruleEdits.delete(game.sessionId);
              info = "Card rules updated.";
              render();
            }
          });
        }, { small: true, primary: true }),
        button("Discard changes", () => {
          ruleEdits.delete(game.sessionId);
          render();
        }, { small: true }),
      ),
    );
  }

  function renderPlayers(view: GameView): HTMLElement {
    const list = el("ul", { class: "pg-players" });
    for (const player of view.players) {
      list.append(el("li", { class: "pg-player" + (player.current ? " current" : "") + (player.active ? "" : " out") },
        el("span", { text: player.name }),
        player.current ? el("span", { class: "pg-badge turn", text: "Turn" }) : null,
        player.next ? el("span", { class: "pg-badge next", text: "Next" }) : null,
        ...player.badges.map((badge) => el("span", { class: "pg-badge", text: badge })),
      ));
    }
    return el("section", { class: "pg-section" }, el("h3", { text: "Players" }), list);
  }

  function renderGame(game: NonNullable<ChatGameState["game"]>): HTMLElement[] {
    const view = game.view;
    const facts = el("dl", { class: "pg-facts" });
    for (const fact of view.facts) facts.append(el("dt", { text: fact.label }), el("dd", { text: fact.value }));
    const log = el("ol", { class: "pg-log" });
    for (const line of view.recent) log.append(el("li", { text: line }));
    return [
      renderScoreboard(view),
      renderActions(game),
      renderPlayers(view),
      view.facts.length ? el("section", { class: "pg-section" }, el("h3", { text: "Table" }), facts) : null,
      view.recent.length ? el("section", { class: "pg-section" }, el("h3", { text: "Recent" }), log) : null,
      el("div", { class: "pg-actions" },
        button("Undo last action", () => void run("undo"), { disabled: !game.canUndo }),
        button(view.status === "ended" ? "Close game" : "End game", () => void confirmEnd(view), { danger: true }),
      ),
      renderRuleEditor(game),
      collapsible("prompt", "What the model sees",
        el("p", { class: "pg-muted", text: "Injected into every generation in this chat while the game runs." }),
        el("pre", { class: "pg-preview", text: game.prompt }),
      ),
    ].filter((node): node is HTMLElement => node !== null);
  }

  function renderSettings(current: ChatGameState): HTMLElement {
    const settings = { ...current.settings };
    const auto = el("input", { type: "checkbox", checked: settings.autoInject });
    auto.addEventListener("change", () => {
      settings.autoInject = auto.checked;
    });
    const depth = el("input", { class: "pg-input", type: "number", min: "0", max: "50", step: "1", value: String(settings.injectionDepth), "aria-label": "Injection depth" });
    depth.addEventListener("input", () => {
      settings.injectionDepth = Number(depth.value);
    });
    return collapsible("settings", "Settings",
      el("label", { class: "pg-check" }, auto, el("span", { text: "Add the game state to every generation automatically" })),
      el("label", { class: "pg-field" },
        el("span", { class: "pg-label", text: "Injection depth" }),
        el("span", { class: "pg-muted", text: "Messages from the end of the prompt. 0 puts the state last; 1 puts it just before the newest message." }),
        depth,
      ),
      el("p", { class: "pg-muted" },
        "Presets can place the state themselves with ", el("span", { class: "pg-code", text: "{{party_game_state}}" }),
        " (turn off automatic injection to avoid sending it twice). ",
        el("span", { class: "pg-code", text: "{{party_game_active}}" }), " is true while a game runs.",
      ),
      el("div", { class: "pg-actions" }, button("Save settings", () => void run("save-settings", { settings }), { small: true })),
    );
  }

  async function confirmEnd(view: GameView): Promise<void> {
    const message = view.status === "ended"
      ? "Close this finished game? The state block stops being sent."
      : "End " + view.gameName + " for everyone in this chat? This cannot be undone.";
    let confirmed: boolean;
    if (typeof ctx.ui.showConfirm === "function") {
      confirmed = (await ctx.ui.showConfirm({ title: view.status === "ended" ? "Close game" : "End game", message, variant: "danger", confirmLabel: view.status === "ended" ? "Close" : "End game" })).confirmed;
    } else {
      confirmed = window.confirm(message);
    }
    if (confirmed) await run("end");
  }

  function render(): void {
    if (destroyed) return;
    const view = state?.game?.view;
    const subtitle = !chatId ? "No chat open" : view ? view.gameName + " · turn " + String(view.turnNumber) : "No game in this chat";
    const children: Child[] = [
      el("header", { class: "pg-header" },
        el("div", {}, el("h2", { text: "Party Games" }), el("p", { class: "pg-muted", text: subtitle })),
      ),
      error ? notice(error, "error") : null,
      info ? notice(info, "info") : null,
      ...(state?.warnings ?? []).map((warning) => notice(warning)),
    ];
    if (!chatId) {
      children.push(el("section", { class: "pg-section" }, el("p", { class: "pg-muted", text: "Open a chat to start a game." })));
    } else if (loading || !state || state.chatId !== chatId) {
      children.push(el("p", { class: "pg-muted", text: "Loading…" }));
    } else {
      children.push(...(state.game ? renderGame(state.game) : renderSetup(chatId, state)));
      children.push(renderSettings(state));
    }
    root.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)));
    tab.setBadge(state?.game && state.game.view.status === "active" ? String(state.game.view.turnNumber) : null);
  }

  // ─── Input bar ────────────────────────────────────────────────────────────

  const inputBar = ctx.ui.registerInputBarAction({ id: "party-next", label: "Party Games: start a game", iconSvg: ICON });
  let inputBarLabel = "";

  function updateInputBar(): void {
    const model = inputBarModel(chatId && state?.chatId === chatId ? state : null);
    if (model.label !== inputBarLabel) {
      inputBarLabel = model.label;
      inputBar.setLabel(model.label);
    }
  }

  disposers.push(inputBar.onClick(() => {
    if (ctx.getActiveChat().chatId !== state?.chatId) {
      // The chat just changed and the panel has not caught up; never act on the old chat.
      void refresh();
      tab.activate();
      return;
    }
    const model = inputBarModel(state);
    const primary = primaryAction(state);
    if (model.mode === "act" && primary && !needsInput(primary)) {
      void run("act", { action: buildAction(primary as ActionDef) });
    } else {
      tab.activate();
    }
  }));
  disposers.push(() => inputBar.destroy());

  // ─── Wiring ───────────────────────────────────────────────────────────────

  disposers.push(ctx.onBackendMessage((payload) => {
    if (!payload || typeof payload !== "object") return;
    const message = payload as Record<string, unknown>;
    if (message.type === "party:reply" && typeof message.requestId === "string") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (typeof message.error === "string" && message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    } else if (message.type === "party:changed") {
      if (message.chatId === null || message.chatId === chatId) scheduleRefresh();
    }
  }));

  for (const eventName of REFRESH_EVENTS) disposers.push(ctx.events.on(eventName, scheduleRefresh));
  disposers.push(tab.onActivate(scheduleRefresh));

  render();
  void refresh();
  ctx.ready();

  return () => {
    destroyed = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Best effort during teardown.
      }
    }
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    tab.destroy();
    document.getElementById(STYLE_ID)?.remove();
  };
}
