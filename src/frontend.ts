import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import {
  buildAction,
  inputBarModel,
  missingField,
  needsInput,
  primaryAction,
  requestIdFactory,
  setupProblem,
  type ActionValues,
} from "./frontend-model";
import { partyStyles, STYLE_ID } from "./styles";
import type {
  ActionDef,
  ActionField,
  ChatGameState,
  GameView,
  PartyRequestAction,
  PlayerInput,
  PlayerKind,
  SuggestedPlayers,
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
const KIND_LABELS: Record<PlayerKind, string> = { user: "You", character: "Character", npc: "Other" };

interface SetupDraft {
  gameId: string;
  players: PlayerInput[];
  options: Record<string, unknown>;
  suggested: boolean;
}

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value as EventListener);
    else if (key in node && typeof value !== "string") (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

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

  let chatId: string | null = ctx.getActiveChat().chatId;
  let state: ChatGameState | null = null;
  let stateKey = "";
  let error: string | null = null;
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
    if (activeChat !== chatId) error = null;
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
      if (!next.game) void ensureDraft(requestedChat);
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
      draft = { gameId: firstAvailable, players: [], options: {}, suggested: false };
      drafts.set(chat, draft);
    }
    return draft;
  }

  async function ensureDraft(chat: string, force = false): Promise<void> {
    const draft = draftFor(chat);
    if (draft.suggested && !force) return;
    draft.suggested = true;
    try {
      const suggestion = await request<SuggestedPlayers>("suggest-players", { chatId: chat });
      if (force || !draft.players.length) draft.players = suggestion.players.length ? suggestion.players : [{ name: "", kind: "user" }];
    } catch {
      if (!draft.players.length) draft.players = [{ name: "", kind: "user" }];
    }
    if (chat === chatId) render();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function notice(text: string, kind: "warning" | "error" = "warning"): HTMLElement {
    return el("div", { class: "pg-notice" + (kind === "error" ? " error" : ""), role: kind === "error" ? "alert" : "status", text });
  }

  function button(label: string, onClick: () => void, options: { primary?: boolean; danger?: boolean; small?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
    const classes = ["pg-button", options.primary ? "primary" : "", options.danger ? "danger" : "", options.small ? "small" : ""].filter(Boolean).join(" ");
    return el("button", { type: "button", class: classes, disabled: Boolean(options.disabled || busy), title: options.title, onclick: onClick, text: label });
  }

  function renderSetup(chat: string, current: ChatGameState): HTMLElement[] {
    const draft = draftFor(chat);
    const games = current.games;
    const selected = games.find((game) => game.id === draft.gameId);
    const problem = setupProblem(selected, draft.players);

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

    const seats = el("div", { class: "pg-seats" });
    draft.players.forEach((player, index) => {
      const name = el("input", { class: "pg-input", type: "text", value: player.name, placeholder: "Name", maxlength: "60", "aria-label": "Player " + String(index + 1) + " name" });
      name.addEventListener("input", () => {
        player.name = name.value;
      });
      name.addEventListener("change", () => render());
      const kind = el("select", { class: "pg-select", "aria-label": "Player " + String(index + 1) + " kind" });
      for (const option of Object.keys(KIND_LABELS) as PlayerKind[]) {
        kind.append(el("option", { value: option, selected: (player.kind ?? "npc") === option, text: KIND_LABELS[option] }));
      }
      kind.addEventListener("change", () => {
        player.kind = kind.value as PlayerKind;
      });
      const controls = el("span", { class: "pg-row" },
        button("↑", () => {
          if (index === 0) return;
          const [moved] = draft.players.splice(index, 1);
          if (moved) draft.players.splice(index - 1, 0, moved);
          render();
        }, { small: true, disabled: index === 0, title: "Move up" }),
        button("✕", () => {
          draft.players.splice(index, 1);
          render();
        }, { small: true, title: "Remove" }),
      );
      seats.append(el("div", { class: "pg-seat" }, el("span", { class: "pg-seat-number", text: String(index + 1) }), name, kind, controls));
    });

    const options: Child[] = [];
    if (draft.gameId === "kings_cup") {
      const fourthKing = el("input", { type: "checkbox", checked: draft.options.endOnFourthKing !== false });
      fourthKing.addEventListener("change", () => {
        draft.options.endOnFourthKing = fourthKing.checked;
      });
      options.push(el("label", { class: "pg-check" }, fourthKing, el("span", { text: "The 4th King ends the game (otherwise play until the deck runs out)" })));
    }

    return [
      el("section", { class: "pg-section" }, el("h3", { text: "Pick a game" }), gameList),
      el("section", { class: "pg-section" },
        el("div", { class: "pg-row between" },
          el("h3", { text: "Players, in turn order" }),
          button("Use chat members", () => void ensureDraft(chat, true), { small: true }),
        ),
        seats,
        el("div", { class: "pg-actions" }, button("Add player", () => {
          draft.players.push({ name: "", kind: "npc" });
          render();
        }, { small: true, disabled: draft.players.length >= 16 })),
      ),
      options.length ? el("section", { class: "pg-section" }, el("h3", { text: "House rules" }), ...options) : null,
      el("div", { class: "pg-actions" },
        button("Start " + (selected?.name ?? "game"), () => {
          void run("start", {
            gameId: draft.gameId,
            players: draft.players.filter((player) => player.name.trim()),
            options: draft.options,
          });
        }, { primary: true, disabled: Boolean(problem) }),
        problem ? el("span", { class: "pg-muted", text: problem }) : null,
      ),
    ].filter((node): node is HTMLElement => node !== null);
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
    for (const action of game.actions) {
      const key = game.sessionId + ":" + String(game.view.turnNumber) + ":" + game.view.phase + ":" + action.type + ":" + JSON.stringify(action.preset ?? {});
      let values = actionValues.get(key);
      if (!values) {
        values = {};
        actionValues.set(key, values);
      }
      const current = values;
      // Choices re-render on change, so their buttons can disable; text is checked on click so typing keeps focus.
      const missing = missingField(action, current);
      const blocked = missing && missing.kind !== "text" ? missing : null;
      section.append(el("div", { class: "pg-action" },
        action.description ? el("p", { class: "pg-muted", text: action.description }) : null,
        ...(action.fields ?? []).map((field) => renderField(field, current)),
        el("div", { class: "pg-actions" },
          button(action.label, () => {
            const unfilled = missingField(action, current);
            if (unfilled) {
              error = "Fill in “" + unfilled.label + "” first.";
              render();
              return;
            }
            void run("act", { action: buildAction(action, current) }).then((ok) => {
              if (ok) actionValues.delete(key);
            });
          }, { primary: Boolean(action.primary), disabled: Boolean(blocked), title: blocked ? "Choose " + blocked.label.toLowerCase() + " first" : undefined }),
        ),
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
      el("details", { class: "pg-section pg-details" },
        el("summary", { text: "What the model sees" }),
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
    return el("details", { class: "pg-section pg-details" },
      el("summary", { text: "Settings" }),
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
