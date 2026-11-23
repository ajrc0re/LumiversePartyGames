// src/frontend-model.ts
function primaryAction(state) {
  const actions = state?.game?.actions ?? [];
  return actions.find((action) => action.primary) ?? actions[0] ?? null;
}
function needsInput(action) {
  return Boolean(action.fields?.some((field) => field.required));
}
function buildAction(definition, values = {}) {
  const action = { ...definition.preset, type: definition.type };
  for (const field of definition.fields ?? []) {
    if (field.name === "target" && values.target)
      action.target = values.target;
    if (field.name === "text" && values.text?.trim())
      action.text = values.text.trim();
    if (field.name === "players" && values.players?.length)
      action.players = [...values.players];
  }
  return action;
}
function missingField(definition, values) {
  for (const field of definition.fields ?? []) {
    if (!field.required)
      continue;
    const filled = field.name === "target" ? Boolean(values.target) : field.name === "players" ? Boolean(values.players?.length) : Boolean(values.text?.trim());
    if (!filled)
      return field;
  }
  return null;
}
function inputBarModel(state) {
  const game = state?.game;
  if (!game)
    return { label: "Party Games: start a game", mode: "open" };
  const name = game.view.gameName;
  const primary = primaryAction(state);
  if (!primary)
    return { label: name + ": game over", mode: "open" };
  const player = game.view.players.find((entry) => entry.id === game.view.currentPlayerId)?.name;
  const who = player ? " (" + player + ")" : "";
  if (needsInput(primary))
    return { label: name + ": " + primary.label + "…" + who, mode: "open" };
  return { label: name + ": " + primary.label + who, mode: "act" };
}
function namedParticipants(draft) {
  return draft.participants.map((name) => name.trim()).filter(Boolean);
}
function seatCount(draft) {
  return (draft.includeUser ? 1 : 0) + namedParticipants(draft).length;
}
function setupProblem(game, draft) {
  if (!game)
    return "Choose a game.";
  if (!game.available)
    return game.name + " is not available yet.";
  const seats = seatCount(draft);
  if (seats < game.minPlayers) {
    return game.name + " needs at least " + String(game.minPlayers) + " players; " + (seats === 0 ? "add some participants." : "add another participant.");
  }
  return null;
}
function startInput(draft) {
  return {
    gameId: draft.gameId,
    includeUser: draft.includeUser,
    participants: namedParticipants(draft),
    turnOrder: draft.turnOrder,
    options: draft.options
  };
}
function changedRules(current, edited) {
  const changed = {};
  for (const entry of current) {
    const edit = edited[entry.id];
    if (!edit)
      continue;
    const title = edit.title.trim();
    const rule = edit.rule.trim();
    if (!title || !rule)
      continue;
    if (title !== entry.title || rule !== entry.rule || edit.effect !== entry.effect) {
      changed[entry.id] = { title, rule, effect: edit.effect };
    }
  }
  return changed;
}
function requestIdFactory(prefix = "pg") {
  let sequence = 0;
  return () => prefix + "-" + Date.now().toString(36) + "-" + (++sequence).toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
}

// src/engine/core.ts
var STANDING_INSTRUCTION = "This block is the authoritative game state, maintained by the game. Narrate only what it says. " + "Do not draw cards, pick prompts, change whose turn it is, eliminate players, or move the game to a new phase yourself; " + "the game advances only when the players use the game controls. If an action is still pending, describe the moment and leave it pending.";

// src/games/kings-cup.ts
var RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
var EFFECTS = ["none", "target", "mate", "make_rule", "question_master", "kings_cup"];
var EFFECT_LABELS = {
  none: "No choice",
  target: "Picks who drinks",
  mate: "Picks a mate",
  make_rule: "Adds a rule",
  question_master: "Question Master",
  kings_cup: "Counts toward 4th King"
};
var DEFAULT_RULES = Object.freeze({
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
  K: { title: "King's Cup", rule: "{drawer} pours some of their drink into the King's Cup. Whoever draws the 4th King drinks the whole cup.", effect: "kings_cup" }
});

// src/styles.ts
var STYLE_ID = "lumiverse-party-games-styles";
var BORDER = "var(--lumiverse-border,#34363c)";
var MUTED = "var(--lumiverse-text-muted,#9da0a8)";
var PRIMARY = "var(--lumiverse-primary,#8b7cff)";
var ELEVATED = "var(--lumiverse-bg-elevated,#202126)";
var BG = "var(--lumiverse-bg,#16171b)";
var partyStyles = [
  ".pg-root{color:var(--lumiverse-text,#ececf1);font:13px/1.45 system-ui,sans-serif;padding:12px;max-width:760px;margin:auto;box-sizing:border-box}",
  ".pg-root *{box-sizing:border-box}",
  ".pg-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}",
  ".pg-header h2{font-size:18px;margin:0 0 2px}.pg-muted{color:" + MUTED + ";margin:0}",
  ".pg-section{background:" + ELEVATED + ";border:1px solid " + BORDER + ";border-radius:9px;padding:12px;margin:0 0 12px}",
  ".pg-section h3{font-size:14px;margin:0 0 9px}",
  ".pg-notice{border-left:3px solid #e7ad42;background:color-mix(in srgb,#e7ad42 11%,transparent);padding:8px 10px;margin:0 0 12px;border-radius:4px}",
  ".pg-notice.error{border-color:#e66161;background:color-mix(in srgb,#e66161 11%,transparent)}",
  ".pg-notice.info{border-color:" + PRIMARY + ";background:color-mix(in srgb," + PRIMARY + " 11%,transparent)}",
  ".pg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pg-row.between{justify-content:space-between}",
  ".pg-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
  ".pg-button{appearance:none;border:1px solid var(--lumiverse-border,#4c4e56);border-radius:6px;background:" + BG + ";color:inherit;padding:6px 11px;cursor:pointer;font:inherit}",
  ".pg-button.primary{background:" + PRIMARY + ";border-color:" + PRIMARY + ";color:#fff}.pg-button.danger{border-color:#c75a5a}",
  ".pg-button:disabled{opacity:.48;cursor:not-allowed}.pg-button.small{padding:3px 8px;font-size:12px}",
  ".pg-input,.pg-select{min-height:30px;padding:4px 8px;border:1px solid " + BORDER + ";border-radius:6px;background:" + BG + ";color:inherit;font:inherit;min-width:0}",
  ".pg-check{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;margin:8px 0 0}.pg-check input{margin:2px 0 0;accent-color:" + PRIMARY + "}",
  ".pg-input{flex:1 1 160px}.pg-field{display:grid;gap:4px;margin:8px 0 0}.pg-label{font-weight:600;font-size:12px}",
  ".pg-games{display:grid;gap:6px}.pg-game{display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid " + BORDER + ";border-radius:7px;cursor:pointer}",
  ".pg-game[aria-disabled=true]{opacity:.55;cursor:not-allowed}.pg-game input{margin-top:3px;accent-color:" + PRIMARY + "}",
  ".pg-game-name{font-weight:650}.pg-soon{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:" + MUTED + ";margin-left:6px}",
  ".pg-seats{display:grid;gap:6px}.pg-seat{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:6px;align-items:center}.pg-seat .pg-input{width:100%}",
  ".pg-seat.user{min-height:30px}.pg-seat.user .pg-check{grid-column:2 / span 2;margin:0;align-items:center}",
  ".pg-rules{display:grid;gap:8px;margin-top:8px}.pg-rule{display:grid;grid-template-columns:30px minmax(0,1fr) minmax(0,1fr);gap:6px;align-items:center;padding:8px;border:1px solid " + BORDER + ";border-radius:7px}",
  ".pg-rule-rank{font:700 14px/1 ui-monospace,Consolas,monospace;text-align:center}.pg-rule .pg-select{width:100%}.pg-rule-locked{color:" + MUTED + ";font-size:12px}",
  ".pg-textarea{grid-column:2 / span 2;width:100%;min-height:46px;resize:vertical;line-height:1.35}",
  ".pg-seat-number{color:" + MUTED + ";font:600 12px/1 ui-monospace,Consolas,monospace;text-align:right}",
  ".pg-headline{font-size:16px;font-weight:700;margin:0}.pg-detail{margin:4px 0 0}",
  ".pg-kicker{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:" + MUTED + "}",
  ".pg-turn{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12px}.pg-turn b{font-weight:650}",
  ".pg-players{list-style:none;margin:0;padding:0;display:grid;gap:4px}",
  ".pg-player{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;border-radius:6px;border:1px solid transparent}",
  ".pg-player.current{border-color:" + PRIMARY + ";background:color-mix(in srgb," + PRIMARY + " 12%,transparent)}.pg-player.out{opacity:.5;text-decoration:line-through}",
  ".pg-badge{font-size:10px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:999px;border:1px solid " + BORDER + ";color:" + MUTED + "}",
  ".pg-badge.turn{border-color:" + PRIMARY + ";color:" + PRIMARY + "}.pg-badge.next{border-color:#77c68e;color:#77c68e}",
  ".pg-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}.pg-facts dt{color:" + MUTED + "}.pg-facts dd{margin:0;overflow-wrap:anywhere}",
  ".pg-log{margin:0;padding-left:18px;color:" + MUTED + ";font-size:12px}",
  ".pg-action{border-top:1px solid " + BORDER + ";padding-top:10px;margin-top:10px}.pg-action:first-child{border-top:0;padding-top:0;margin-top:0}",
  ".pg-preview{white-space:pre-wrap;max-height:220px;overflow:auto;background:" + BG + ";border:1px solid " + BORDER + ";border-radius:6px;padding:9px;margin:6px 0 0;font:12px/1.35 ui-monospace,Consolas,monospace}",
  ".pg-details summary{cursor:pointer;font-weight:600}.pg-code{font-family:ui-monospace,Consolas,monospace;background:" + BG + ";border-radius:4px;padding:1px 5px}",
  "@media (max-width:430px){.pg-root{padding:8px}.pg-seat{grid-template-columns:18px minmax(0,1fr) auto}.pg-rule{grid-template-columns:24px minmax(0,1fr)}.pg-rule .pg-select,.pg-rule-locked,.pg-textarea{grid-column:2}}"
].join(`
`);

// src/frontend.ts
var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="11" height="15" rx="2" transform="rotate(-8 8.5 12.5)"/><rect x="10" y="4" width="11" height="15" rx="2" transform="rotate(8 15.5 11.5)"/><path d="M15.5 9.5l-1.6 2.6 2.6 1.6 1.6-2.6z"/></svg>';
var REQUEST_TIMEOUT_MS = 20000;
var REFRESH_DELAY_MS = 150;
var REFRESH_EVENTS = [
  "CHAT_SWITCHED",
  "CHAT_CHANGED",
  "MESSAGE_SENT",
  "MESSAGE_DELETED",
  "MESSAGE_SWIPED",
  "SWIPE_EDITED",
  "GENERATION_ENDED",
  "GENERATION_STOPPED"
];
var MAX_PARTICIPANTS = 15;
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false)
      continue;
    if (key === "class")
      node.className = String(value);
    else if (key === "text")
      node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string")
      node[key] = value;
    else
      node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false)
      continue;
    node.append(child);
  }
  return node;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function injectStyles() {
  if (document.getElementById(STYLE_ID))
    return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = partyStyles;
  document.head.appendChild(style);
}
function setup(ctx) {
  injectStyles();
  const disposers = [];
  const pending = new Map;
  const nextRequestId = requestIdFactory("pg");
  const drafts = new Map;
  const actionValues = new Map;
  const userNames = new Map;
  const ruleEdits = new Map;
  const openSections = new Set;
  let chatId = ctx.getActiveChat().chatId;
  let state = null;
  let stateKey = "";
  let error = null;
  let info = null;
  let busy = false;
  let loading = false;
  let refreshVersion = 0;
  let refreshTimer;
  let destroyed = false;
  const tab = ctx.ui.registerDrawerTab({
    id: "party-games",
    title: "Party Games",
    shortName: "Games",
    description: "Play Kings Cup and other party games in this chat",
    keywords: ["party", "game", "kings cup", "drinking", "cards", "truth or dare", "never have i ever"],
    iconSvg: ICON
  });
  const root = el("div", { class: "pg-root" });
  tab.root.appendChild(root);
  function request(action, input = {}) {
    const requestId = nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Party Games did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve: (value) => resolve(value), reject, timer });
      try {
        ctx.sendToBackend({ type: "party:request", requestId, action, input });
      } catch (sendError) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(sendError instanceof Error ? sendError : new Error(String(sendError)));
      }
    });
  }
  function setState(next) {
    const key = JSON.stringify(next);
    if (key === stateKey)
      return;
    stateKey = key;
    state = next;
    render();
  }
  async function refresh() {
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
    if (loading)
      render();
    try {
      const next = await request("state", { chatId: requestedChat });
      if (destroyed || version !== refreshVersion)
        return;
      const wasLoading = loading;
      loading = false;
      setState(next);
      if (wasLoading)
        render();
      if (!next.game)
        loadUserName(requestedChat);
    } catch (refreshError) {
      if (destroyed || version !== refreshVersion)
        return;
      loading = false;
      error = errorMessage(refreshError);
      render();
    }
    updateInputBar();
  }
  function scheduleRefresh() {
    if (refreshTimer)
      clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, REFRESH_DELAY_MS);
  }
  async function run(action, input = {}) {
    if (busy)
      return false;
    const target = chatId;
    if (!target && action !== "save-settings")
      return false;
    busy = true;
    error = null;
    info = null;
    render();
    let ok = false;
    try {
      const next = await request(action, { ...input, chatId: target });
      if (next && next.chatId === chatId)
        setState(next);
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
  function draftFor(chat) {
    let draft = drafts.get(chat);
    if (!draft) {
      const firstAvailable = state?.games.find((game) => game.available)?.id ?? "kings_cup";
      draft = { gameId: firstAvailable, includeUser: true, participants: [""], turnOrder: "listed", options: {}, optionsGameId: null };
      drafts.set(chat, draft);
    }
    if (draft.optionsGameId !== draft.gameId && state?.gameDefaults[draft.gameId]) {
      draft.options = structuredClone(state.gameDefaults[draft.gameId]);
      draft.optionsGameId = draft.gameId;
    }
    return draft;
  }
  async function loadUserName(chat) {
    if (userNames.has(chat))
      return;
    userNames.set(chat, "");
    try {
      const result = await request("user-name", { chatId: chat });
      userNames.set(chat, result.name);
    } catch {
      userNames.set(chat, "");
    }
    if (chat === chatId)
      render();
  }
  function notice(text, kind = "warning") {
    return el("div", { class: "pg-notice" + (kind === "warning" ? "" : " " + kind), role: kind === "error" ? "alert" : "status", text });
  }
  function collapsible(id, summary, ...children) {
    const details = el("details", { class: "pg-section pg-details", open: openSections.has(id) }, el("summary", { text: summary }), ...children);
    details.addEventListener("toggle", () => {
      if (details.open)
        openSections.add(id);
      else
        openSections.delete(id);
    });
    return details;
  }
  function renderRuleRows(values) {
    const list = el("div", { class: "pg-rules" });
    for (const rank of RANKS) {
      const entry = values[rank];
      if (!entry)
        continue;
      const title = el("input", { class: "pg-input", type: "text", value: entry.title, maxlength: "40", "aria-label": rank + " title" });
      title.addEventListener("input", () => {
        entry.title = title.value;
      });
      const rows = Math.min(5, Math.max(2, Math.ceil(entry.rule.length / 42)));
      const rule = el("textarea", { class: "pg-input pg-textarea", maxlength: "300", rows: String(rows), "aria-label": rank + " rule" });
      rule.value = entry.rule;
      rule.addEventListener("input", () => {
        entry.rule = rule.value;
      });
      let effect;
      if (rank === "K") {
        effect = el("span", { class: "pg-rule-locked", text: EFFECT_LABELS.kings_cup });
      } else {
        const select = el("select", { class: "pg-select", "aria-label": rank + " effect" });
        for (const option of EFFECTS) {
          if (option === "kings_cup")
            continue;
          select.append(el("option", { value: option, selected: entry.effect === option, text: EFFECT_LABELS[option] }));
        }
        select.title = "What drawing this card asks of the drawer";
        select.addEventListener("change", () => {
          entry.effect = select.value;
        });
        effect = select;
      }
      list.append(el("div", { class: "pg-rule" }, el("span", { class: "pg-rule-rank", text: rank }), title, effect, rule));
    }
    return list;
  }
  function button(label, onClick, options = {}) {
    const classes = ["pg-button", options.primary ? "primary" : "", options.danger ? "danger" : "", options.small ? "small" : ""].filter(Boolean).join(" ");
    return el("button", { type: "button", class: classes, disabled: Boolean(options.disabled || busy), title: options.title, onclick: onClick, text: label });
  }
  function renderSetup(chat, current) {
    const draft = draftFor(chat);
    const games = current.games;
    const selected = games.find((game) => game.id === draft.gameId);
    const problem = setupProblem(selected, draft);
    const startButton = button("Start " + (selected?.name ?? "game"), () => void run("start", { ...startInput(draft) }), { primary: true, disabled: Boolean(problem) });
    const problemText = el("span", { class: "pg-muted", text: problem ?? "" });
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
      gameList.append(el("label", { class: "pg-game", "aria-disabled": game.available ? "false" : "true" }, radio, el("span", {}, el("span", { class: "pg-game-name", text: game.name }), game.available ? null : el("span", { class: "pg-soon", text: "Coming soon" }), el("div", { class: "pg-muted", text: game.description }))));
    }
    const userName = userNames.get(chat) ?? "";
    const includeUser = el("input", { type: "checkbox", checked: draft.includeUser });
    includeUser.addEventListener("change", () => {
      draft.includeUser = includeUser.checked;
      render();
    });
    const userHint = !draft.includeUser ? "(left out)" : userName ? "(" + userName + ")" : "(your persona name)";
    const seats = el("div", { class: "pg-seats" }, el("div", { class: "pg-seat user" }, el("span", { class: "pg-seat-number", text: draft.includeUser ? "1" : "–" }), el("label", { class: "pg-check inline" }, includeUser, el("span", {}, "Include ", el("span", { class: "pg-code", text: "{{user}}" }), " ", el("span", { class: "pg-muted", text: userHint })))));
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
          root.querySelectorAll(".pg-seat:not(.user) .pg-input")[index + 1]?.focus();
        }
      });
      seats.append(el("div", { class: "pg-seat" }, el("span", { class: "pg-seat-number", text: String(firstNumber + index) }), name, el("span", { class: "pg-row" }, button("↑", () => {
        const [moved] = draft.participants.splice(index, 1);
        if (moved !== undefined)
          draft.participants.splice(index - 1, 0, moved);
        render();
      }, { small: true, disabled: index === 0, title: "Move up" }), button("✕", () => {
        draft.participants.splice(index, 1);
        render();
      }, { small: true, title: "Remove" }))));
    });
    const order = el("select", { class: "pg-select", "aria-label": "Turn order" });
    order.append(el("option", { value: "listed", selected: draft.turnOrder === "listed", text: "As listed" }), el("option", { value: "random", selected: draft.turnOrder === "random", text: "Random (shuffled at the start)" }));
    order.addEventListener("change", () => {
      draft.turnOrder = order.value === "random" ? "random" : "listed";
    });
    const gameOptions = [];
    if (draft.gameId === "kings_cup") {
      const fourthKing = el("input", { type: "checkbox", checked: draft.options.endOnFourthKing !== false });
      fourthKing.addEventListener("change", () => {
        draft.options.endOnFourthKing = fourthKing.checked;
      });
      const rules = draft.options.rules ?? (draft.options.rules = structuredClone(DEFAULT_RULES));
      gameOptions.push(el("section", { class: "pg-section" }, el("h3", { text: "House rules" }), el("label", { class: "pg-check" }, fourthKing, el("span", { text: "The 4th King ends the game (otherwise play until the deck runs out)" }))), collapsible("setup-rules", "Card rules", el("p", { class: "pg-muted", text: "What each card means in this game. {drawer} is replaced with the drawing player's name." }), renderRuleRows(rules), el("div", { class: "pg-actions" }, button("Save as my default", () => {
        run("save-defaults", { gameId: draft.gameId, options: draft.options }).then((ok) => {
          if (ok) {
            info = "Saved. New Kings Cup games start with these rules.";
            render();
          }
        });
      }, { small: true }), button("Reset to standard rules", () => {
        draft.options.rules = structuredClone(DEFAULT_RULES);
        render();
      }, { small: true }))));
    }
    return [
      el("section", { class: "pg-section" }, el("h3", { text: "Pick a game" }), gameList),
      el("section", { class: "pg-section" }, el("h3", { text: "Participants" }), seats, el("div", { class: "pg-actions" }, button("Add participant", () => {
        draft.participants.push("");
        render();
        const inputs = root.querySelectorAll(".pg-seat:not(.user) .pg-input");
        inputs[inputs.length - 1]?.focus();
      }, { small: true, disabled: draft.participants.length >= MAX_PARTICIPANTS })), el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "Turn order" }), order)),
      ...gameOptions,
      el("div", { class: "pg-actions" }, startButton, problemText)
    ].filter((node) => node !== null && node !== false);
  }
  function renderField(field, values) {
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
          if (check.checked)
            chosen.add(choice.id);
          else
            chosen.delete(choice.id);
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
  function renderActions(game) {
    if (!game.actions.length)
      return null;
    const section = el("section", { class: "pg-section", "aria-label": "Actions" });
    for (const action of game.actions) {
      const key = game.sessionId + ":" + String(game.view.turnNumber) + ":" + game.view.phase + ":" + action.type + ":" + JSON.stringify(action.preset ?? {});
      let values = actionValues.get(key);
      if (!values) {
        values = {};
        actionValues.set(key, values);
      }
      const current = values;
      const missing = missingField(action, current);
      const blocked = missing && missing.kind !== "text" ? missing : null;
      section.append(el("div", { class: "pg-action" }, action.description ? el("p", { class: "pg-muted", text: action.description }) : null, ...(action.fields ?? []).map((field) => renderField(field, current)), el("div", { class: "pg-actions" }, button(action.label, () => {
        const unfilled = missingField(action, current);
        if (unfilled) {
          error = "Fill in “" + unfilled.label + "” first.";
          render();
          return;
        }
        run("act", { action: buildAction(action, current) }).then((ok) => {
          if (ok)
            actionValues.delete(key);
        });
      }, { primary: Boolean(action.primary), disabled: Boolean(blocked), title: blocked ? "Choose " + blocked.label.toLowerCase() + " first" : undefined }))));
    }
    return section;
  }
  function renderScoreboard(view) {
    const current = view.players.find((player) => player.id === view.currentPlayerId);
    const next = view.players.find((player) => player.id === view.nextPlayerId);
    return el("section", { class: "pg-section", "aria-live": "polite" }, el("div", { class: "pg-kicker", text: view.gameName + " · Turn " + String(view.turnNumber) + " · " + view.phaseLabel }), el("p", { class: "pg-headline", text: view.headline }), view.detail ? el("p", { class: "pg-detail", text: view.detail }) : null, view.status === "active" ? el("div", { class: "pg-turn" }, el("span", {}, "Now: ", el("b", { text: current?.name ?? "—" })), el("span", {}, "Next up: ", el("b", { text: next?.name ?? "—" }))) : null, view.status === "active" ? renderDirectionToggle(view) : null);
  }
  function renderDirectionToggle(view) {
    const reversed = el("input", { type: "checkbox", checked: view.direction === "reversed", disabled: busy });
    reversed.addEventListener("change", () => {
      run("act", { action: { type: "set_direction", choice: reversed.checked ? "reversed" : "forward" } });
    });
    return el("label", { class: "pg-check" }, reversed, el("span", { text: "Reverse turn order" }));
  }
  function renderRuleEditor(game) {
    const current = game.view.cardRules;
    if (!current?.length || game.view.status !== "active")
      return null;
    let edits = ruleEdits.get(game.sessionId);
    if (!edits) {
      edits = Object.fromEntries(current.map((entry) => [entry.id, { title: entry.title, rule: entry.rule, effect: entry.effect }]));
      ruleEdits.set(game.sessionId, edits);
    }
    const values = edits;
    return collapsible("game-rules", "Card rules", el("p", { class: "pg-muted", text: "Change what a card means mid-game. Changes are recorded like any other action, so Undo takes them back." }), renderRuleRows(values), el("div", { class: "pg-actions" }, button("Save rule changes", () => {
      const changed = changedRules(current, values);
      if (!Object.keys(changed).length) {
        info = "No rule changes to save.";
        render();
        return;
      }
      run("act", { action: { type: "set_rules", data: { rules: changed } } }).then((ok) => {
        if (ok) {
          ruleEdits.delete(game.sessionId);
          info = "Card rules updated.";
          render();
        }
      });
    }, { small: true, primary: true }), button("Discard changes", () => {
      ruleEdits.delete(game.sessionId);
      render();
    }, { small: true })));
  }
  function renderPlayers(view) {
    const list = el("ul", { class: "pg-players" });
    for (const player of view.players) {
      list.append(el("li", { class: "pg-player" + (player.current ? " current" : "") + (player.active ? "" : " out") }, el("span", { text: player.name }), player.current ? el("span", { class: "pg-badge turn", text: "Turn" }) : null, player.next ? el("span", { class: "pg-badge next", text: "Next" }) : null, ...player.badges.map((badge) => el("span", { class: "pg-badge", text: badge }))));
    }
    return el("section", { class: "pg-section" }, el("h3", { text: "Players" }), list);
  }
  function renderGame(game) {
    const view = game.view;
    const facts = el("dl", { class: "pg-facts" });
    for (const fact of view.facts)
      facts.append(el("dt", { text: fact.label }), el("dd", { text: fact.value }));
    const log = el("ol", { class: "pg-log" });
    for (const line of view.recent)
      log.append(el("li", { text: line }));
    return [
      renderScoreboard(view),
      renderActions(game),
      renderPlayers(view),
      view.facts.length ? el("section", { class: "pg-section" }, el("h3", { text: "Table" }), facts) : null,
      view.recent.length ? el("section", { class: "pg-section" }, el("h3", { text: "Recent" }), log) : null,
      el("div", { class: "pg-actions" }, button("Undo last action", () => void run("undo"), { disabled: !game.canUndo }), button(view.status === "ended" ? "Close game" : "End game", () => void confirmEnd(view), { danger: true })),
      renderRuleEditor(game),
      collapsible("prompt", "What the model sees", el("p", { class: "pg-muted", text: "Injected into every generation in this chat while the game runs." }), el("pre", { class: "pg-preview", text: game.prompt }))
    ].filter((node) => node !== null);
  }
  function renderSettings(current) {
    const settings = { ...current.settings };
    const auto = el("input", { type: "checkbox", checked: settings.autoInject });
    auto.addEventListener("change", () => {
      settings.autoInject = auto.checked;
    });
    const depth = el("input", { class: "pg-input", type: "number", min: "0", max: "50", step: "1", value: String(settings.injectionDepth), "aria-label": "Injection depth" });
    depth.addEventListener("input", () => {
      settings.injectionDepth = Number(depth.value);
    });
    return collapsible("settings", "Settings", el("label", { class: "pg-check" }, auto, el("span", { text: "Add the game state to every generation automatically" })), el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "Injection depth" }), el("span", { class: "pg-muted", text: "Messages from the end of the prompt. 0 puts the state last; 1 puts it just before the newest message." }), depth), el("p", { class: "pg-muted" }, "Presets can place the state themselves with ", el("span", { class: "pg-code", text: "{{party_game_state}}" }), " (turn off automatic injection to avoid sending it twice). ", el("span", { class: "pg-code", text: "{{party_game_active}}" }), " is true while a game runs."), el("div", { class: "pg-actions" }, button("Save settings", () => void run("save-settings", { settings }), { small: true })));
  }
  async function confirmEnd(view) {
    const message = view.status === "ended" ? "Close this finished game? The state block stops being sent." : "End " + view.gameName + " for everyone in this chat? This cannot be undone.";
    let confirmed;
    if (typeof ctx.ui.showConfirm === "function") {
      confirmed = (await ctx.ui.showConfirm({ title: view.status === "ended" ? "Close game" : "End game", message, variant: "danger", confirmLabel: view.status === "ended" ? "Close" : "End game" })).confirmed;
    } else {
      confirmed = window.confirm(message);
    }
    if (confirmed)
      await run("end");
  }
  function render() {
    if (destroyed)
      return;
    const view = state?.game?.view;
    const subtitle = !chatId ? "No chat open" : view ? view.gameName + " · turn " + String(view.turnNumber) : "No game in this chat";
    const children = [
      el("header", { class: "pg-header" }, el("div", {}, el("h2", { text: "Party Games" }), el("p", { class: "pg-muted", text: subtitle }))),
      error ? notice(error, "error") : null,
      info ? notice(info, "info") : null,
      ...(state?.warnings ?? []).map((warning) => notice(warning))
    ];
    if (!chatId) {
      children.push(el("section", { class: "pg-section" }, el("p", { class: "pg-muted", text: "Open a chat to start a game." })));
    } else if (loading || !state || state.chatId !== chatId) {
      children.push(el("p", { class: "pg-muted", text: "Loading…" }));
    } else {
      children.push(...state.game ? renderGame(state.game) : renderSetup(chatId, state));
      children.push(renderSettings(state));
    }
    root.replaceChildren(...children.filter((child) => Boolean(child)));
    tab.setBadge(state?.game && state.game.view.status === "active" ? String(state.game.view.turnNumber) : null);
  }
  const inputBar = ctx.ui.registerInputBarAction({ id: "party-next", label: "Party Games: start a game", iconSvg: ICON });
  let inputBarLabel = "";
  function updateInputBar() {
    const model = inputBarModel(chatId && state?.chatId === chatId ? state : null);
    if (model.label !== inputBarLabel) {
      inputBarLabel = model.label;
      inputBar.setLabel(model.label);
    }
  }
  disposers.push(inputBar.onClick(() => {
    if (ctx.getActiveChat().chatId !== state?.chatId) {
      refresh();
      tab.activate();
      return;
    }
    const model = inputBarModel(state);
    const primary = primaryAction(state);
    if (model.mode === "act" && primary && !needsInput(primary)) {
      run("act", { action: buildAction(primary) });
    } else {
      tab.activate();
    }
  }));
  disposers.push(() => inputBar.destroy());
  disposers.push(ctx.onBackendMessage((payload) => {
    if (!payload || typeof payload !== "object")
      return;
    const message = payload;
    if (message.type === "party:reply" && typeof message.requestId === "string") {
      const entry = pending.get(message.requestId);
      if (!entry)
        return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (typeof message.error === "string" && message.error)
        entry.reject(new Error(message.error));
      else
        entry.resolve(message.result);
    } else if (message.type === "party:changed") {
      if (message.chatId === null || message.chatId === chatId)
        scheduleRefresh();
    }
  }));
  for (const eventName of REFRESH_EVENTS)
    disposers.push(ctx.events.on(eventName, scheduleRefresh));
  disposers.push(tab.onActivate(scheduleRefresh));
  render();
  refresh();
  ctx.ready();
  return () => {
    destroyed = true;
    if (refreshTimer)
      clearTimeout(refreshTimer);
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    for (const entry of pending.values())
      clearTimeout(entry.timer);
    pending.clear();
    tab.destroy();
    document.getElementById(STYLE_ID)?.remove();
  };
}
export {
  setup
};
