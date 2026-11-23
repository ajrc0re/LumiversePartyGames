// @bun
// src/engine/rng.ts
function mulberry32(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
  };
}
function randomInt(rng, maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0)
    throw new RangeError("maxExclusive must be a positive integer.");
  return Math.min(maxExclusive - 1, Math.floor(rng.next() * maxExclusive));
}
function shuffle(items, rng) {
  const result = [...items];
  for (let index = result.length - 1;index > 0; index -= 1) {
    const swap = randomInt(rng, index + 1);
    const held = result[index];
    result[index] = result[swap];
    result[swap] = held;
  }
  return result;
}
function cryptoSeed() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] ?? 0;
}
function cryptoRng() {
  return { next: () => cryptoSeed() / 4294967296 };
}

// src/backend/requests.ts
var MUTATING = new Set(["start", "act", "undo", "end"]);
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseStartInput(input) {
  const participants = Array.isArray(input.participants) ? input.participants.filter((name) => typeof name === "string" && name.trim().length > 0).slice(0, 32) : [];
  return {
    gameId: typeof input.gameId === "string" ? input.gameId : "",
    includeUser: input.includeUser === true,
    participants,
    turnOrder: input.turnOrder === "random" ? "random" : "listed",
    options: record(input.options)
  };
}
async function handlePartyRequest(raw, service) {
  const request = record(raw);
  if (request.type !== "party:request" || typeof request.requestId !== "string" || typeof request.action !== "string") {
    return { reply: null, changed: null };
  }
  const requestId = request.requestId;
  const action = request.action;
  const input = record(request.input);
  const chatId = typeof input.chatId === "string" && input.chatId ? input.chatId : undefined;
  const requireChat = () => {
    if (!chatId)
      throw new Error("Open a chat to play.");
    return chatId;
  };
  try {
    let result;
    switch (action) {
      case "state":
        result = await service.state(requireChat());
        break;
      case "user-name":
        result = await service.userName(requireChat());
        break;
      case "start":
        result = await service.start(requireChat(), parseStartInput(input));
        break;
      case "act":
        result = (await service.act(requireChat(), input.action)).state;
        break;
      case "undo":
        result = await service.undo(requireChat());
        break;
      case "end":
        result = await service.end(requireChat());
        break;
      case "save-settings":
        await service.saveSettings(input.settings);
        result = chatId ? await service.state(chatId) : null;
        break;
      case "save-defaults":
        await service.saveDefaults(typeof input.gameId === "string" ? input.gameId : "", input.options);
        result = chatId ? await service.state(chatId) : null;
        break;
      default:
        throw new Error("Unknown Party Games action.");
    }
    return {
      reply: { type: "party:reply", requestId, result },
      changed: MUTATING.has(action) ? { type: "party:changed", chatId: chatId ?? null, reason: action } : null
    };
  } catch (error) {
    return { reply: { type: "party:reply", requestId, error: errorMessage(error) }, changed: null };
  }
}

// src/engine/core.ts
class IllegalActionError extends Error {
  constructor(message) {
    super(message);
    this.name = "IllegalActionError";
  }
}
var PLAYER_KINDS = ["user", "character", "npc"];
var MAX_PLAYERS = 16;
var MAX_NAME_LENGTH = 60;
function cleanName(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
}
function createPlayers(inputs) {
  const players = [];
  const seen = new Map;
  for (const input of inputs) {
    const base = cleanName(input?.name);
    if (!base)
      continue;
    if (players.length >= MAX_PLAYERS)
      throw new IllegalActionError("A game can have at most " + String(MAX_PLAYERS) + " players.");
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const kind = PLAYER_KINDS.includes(input.kind) ? input.kind : "npc";
    players.push({
      id: "p" + String(players.length + 1),
      name: count > 1 ? base + " " + String(count) : base,
      kind,
      active: true
    });
  }
  return players;
}
function findPlayer(state, id) {
  return id === undefined ? undefined : state.players.find((player) => player.id === id);
}
function playerName(state, id) {
  return id && findPlayer(state, id)?.name || "Unknown player";
}
function activePlayers(state) {
  return state.players.filter((player) => player.active);
}
function playerChoices(players) {
  return players.map((player) => ({ id: player.id, label: player.name }));
}
function createCoreState(players, phase, minPlayers) {
  if (players.length < minPlayers) {
    throw new IllegalActionError("This game needs at least " + String(minPlayers) + " players.");
  }
  return {
    players: players.map((player) => ({ ...player })),
    turn: { index: 0, direction: 1, skips: 0, number: 1 },
    phase,
    status: "active",
    winners: [],
    endReason: null,
    log: []
  };
}
function currentPlayer(state) {
  const player = state.players[state.turn.index];
  if (!player)
    throw new Error("Turn index is out of range.");
  return player;
}
function nextActiveIndex(players, fromIndex, direction, skips = 0) {
  const count = players.length;
  if (!count || !players.some((player) => player.active))
    return fromIndex;
  let index = fromIndex;
  let toPass = Math.max(0, skips);
  for (let guard = 0;guard < count * (toPass + 2); guard += 1) {
    index = ((index + direction) % count + count) % count;
    if (!players[index]?.active)
      continue;
    if (toPass === 0)
      return index;
    toPass -= 1;
  }
  return fromIndex;
}
function nextPlayer(state) {
  if (state.status !== "active")
    return null;
  const index = nextActiveIndex(state.players, state.turn.index, state.turn.direction, state.turn.skips);
  return state.players[index] ?? null;
}
function advanceTurn(state, phase) {
  state.turn.index = nextActiveIndex(state.players, state.turn.index, state.turn.direction, state.turn.skips);
  state.turn.skips = 0;
  state.turn.number += 1;
  state.phase = phase;
}
function directionOf(state) {
  return state.turn.direction === 1 ? "forward" : "reversed";
}
function playOrder(state) {
  const count = state.players.length;
  const order = [];
  for (let step = 0;step < count; step += 1) {
    const index = ((state.turn.index + step * state.turn.direction) % count + count) % count;
    const player = state.players[index];
    if (player?.active)
      order.push(player);
  }
  return order;
}
function turnOrderLine(state) {
  const names = playOrder(state).map((player) => player.name);
  const reversed = state.turn.direction === -1 ? " (reversed)" : "";
  return state.status === "active" ? "Turn order" + reversed + ", from the current player: " + names.join(" \u2192 ") + "." : "Players: " + state.players.map((player) => player.name).join(", ") + ".";
}
function eliminate(state, playerId) {
  const player = state.players.find((entry) => entry.id === playerId);
  if (player)
    player.active = false;
}
function endGame(state, reason, winners = []) {
  state.status = "ended";
  state.phase = "game_over";
  state.endReason = reason;
  state.winners = winners;
}
function addLog(state, text) {
  state.log.push({ turn: state.turn.number, text });
}
var TABLE_ACTIONS = ["set_direction"];
function applyTableAction(input, action) {
  requireActiveGame(input);
  const wanted = action.choice === "reversed" ? -1 : action.choice === "forward" ? 1 : 0;
  if (!wanted)
    throw new IllegalActionError('Choose "forward" or "reversed" for the turn order.');
  if (input.turn.direction === wanted) {
    throw new IllegalActionError("The turn order is already " + (wanted === 1 ? "forward" : "reversed") + ".");
  }
  const state = cloneState(input);
  state.turn.direction = wanted;
  const next = nextPlayer(state);
  addLog(state, (wanted === -1 ? "Turn order reversed." : "Turn order back to normal.") + (next ? " Next up: " + next.name + "." : ""));
  return state;
}
function applyAction(definition, state, action, rng) {
  if (TABLE_ACTIONS.includes(action.type))
    return applyTableAction(state, action);
  return definition.apply(state, action, rng);
}
function cloneState(state) {
  return structuredClone(state);
}
function requireActiveGame(state) {
  if (state.status !== "active")
    throw new IllegalActionError("The game is over. Start a new game to keep playing.");
}
function requirePhase(state, phases, allowed, action) {
  requireActiveGame(state);
  if (!allowed.includes(state.phase)) {
    const phaseLabel = phases[state.phase] ?? state.phase;
    throw new IllegalActionError('"' + action.type + '" is not allowed during the ' + phaseLabel + " phase.");
  }
}
function requireCurrentActor(state, action) {
  const current = currentPlayer(state);
  if (action.actor !== undefined && action.actor !== current.id) {
    throw new IllegalActionError("It is " + current.name + "'s turn, not " + playerName(state, action.actor) + "'s.");
  }
  return current;
}
function requireTarget(state, action, options) {
  const target = findPlayer(state, action.target);
  if (!target)
    throw new IllegalActionError("Choose a player for " + options.label + ".");
  if (!target.active)
    throw new IllegalActionError(target.name + " is out of the game.");
  if (options.excludeId && target.id === options.excludeId) {
    throw new IllegalActionError("Choose someone other than " + target.name + " for " + options.label + ".");
  }
  return target;
}
function unknownAction(state, phases, action) {
  requireActiveGame(state);
  throw new IllegalActionError('"' + String(action.type) + '" is not an action in this game (phase: ' + (phases[state.phase] ?? state.phase) + ").");
}
function createDeck(items, rng) {
  return { remaining: shuffle(items, rng), drawn: [] };
}
function drawFrom(deck) {
  const card = deck.remaining.shift();
  if (card === undefined)
    throw new IllegalActionError("The deck is empty.");
  deck.drawn.push(card);
  return card;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}
var STANDING_INSTRUCTION = "This block is the authoritative game state, maintained by the game. Narrate only what it says. " + "Do not draw cards, pick prompts, change whose turn it is, eliminate players, or move the game to a new phase yourself; " + "the game advances only when the players use the game controls. If an action is still pending, describe the moment and leave it pending.";
function joinNames(names) {
  if (names.length <= 1)
    return names[0] ?? "";
  if (names.length === 2)
    return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}
function formatBlock(title, lines) {
  return "[" + title + `]
` + lines.filter((line) => line.trim().length > 0).join(`
`) + `
` + STANDING_INSTRUCTION;
}
function recentLog(state, count) {
  return state.log.slice(-count).map((entry) => "Turn " + String(entry.turn) + ": " + entry.text);
}

// src/games/kings-cup.ts
var RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
var SUITS = ["S", "H", "D", "C"];
var SUIT_SYMBOLS = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
function cardLabel(card) {
  return card.rank + SUIT_SYMBOLS[card.suit];
}
function fullDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}
var EFFECTS = ["none", "target", "mate", "make_rule", "question_master", "kings_cup"];
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
var MAX_RULE_TITLE = 40;
var MAX_RULE_TEXT = 300;
var MAX_CUSTOM_RULE = 200;
var PHASES = {
  draw: "draw",
  resolve: "resolve",
  end_turn: "end of turn",
  game_over: "game over"
};
function normalizeRules(raw, baseTable = DEFAULT_RULES) {
  const source = isRecord(raw) ? raw : {};
  const table = {};
  for (const rank of RANKS) {
    const base = baseTable[rank];
    const override = isRecord(source[rank]) ? source[rank] : {};
    let effect = EFFECTS.includes(override.effect) ? override.effect : base.effect;
    if (rank === "K")
      effect = "kings_cup";
    else if (effect === "kings_cup")
      effect = "none";
    table[rank] = {
      title: cleanText(override.title, MAX_RULE_TITLE) || base.title,
      rule: cleanText(override.rule, MAX_RULE_TEXT) || base.rule,
      effect
    };
  }
  return table;
}
function defaultOptions() {
  return { rules: normalizeRules({}), endOnFourthKing: true };
}
function normalizeOptions(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    rules: normalizeRules(source.rules),
    endOnFourthKing: source.endOnFourthKing !== false
  };
}
function ruleFor(state, card) {
  return state.rules[card.rank];
}
function ruleText(rule, drawerName) {
  return rule.rule.split("{drawer}").join(drawerName);
}
function describeDraw(state, turnCard) {
  const rule = ruleFor(state, turnCard.card);
  return playerName(state, turnCard.drawer) + " drew " + cardLabel(turnCard.card) + " (" + rule.title + ")";
}
function describeResolution(state, turnCard) {
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
      return drawer + "'s " + rule.title + " card played out.";
  }
}
function pendingLine(state, turnCard) {
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
function hasMatePair(state, a, b) {
  return state.mates.some(([left, right]) => left === a && right === b || left === b && right === a);
}
function matesLine(state) {
  return state.mates.map(([a, b]) => playerName(state, a) + " \u2194 " + playerName(state, b)).join(", ");
}
function rulesLine(state) {
  return state.customRules.map((entry, index) => String(index + 1) + ". " + entry.text + " (" + playerName(state, entry.by) + ")").join(" ");
}
function setup(players, options, rng) {
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
    customRules: []
  };
}
function legalActions(state) {
  if (state.status !== "active")
    return [];
  const player = currentPlayer(state);
  switch (state.phase) {
    case "draw":
      return [{ type: "draw", label: "Draw a card", description: player.name + " draws the next card.", primary: true }];
    case "resolve": {
      const turnCard = state.turnCard;
      if (!turnCard)
        return [];
      const rule = ruleFor(state, turnCard.card);
      const others = playerChoices(state.players.filter((entry) => entry.active && entry.id !== turnCard.drawer));
      if (rule.effect === "target") {
        return [{
          type: "resolve",
          label: "Pick who drinks",
          primary: true,
          fields: [{ name: "target", kind: "player", label: "Who drinks", required: true, choices: others }]
        }];
      }
      if (rule.effect === "mate") {
        return [{
          type: "resolve",
          label: "Pick a mate",
          primary: true,
          fields: [{ name: "target", kind: "player", label: "Mate", required: true, choices: others }]
        }];
      }
      if (rule.effect === "make_rule") {
        return [{
          type: "resolve",
          label: "Record the rule",
          description: "Leave the rule blank if " + player.name + " makes none.",
          primary: true,
          fields: [{ name: "text", kind: "text", label: "New rule", required: false, placeholder: "e.g. No first names" }]
        }];
      }
      return [{ type: "resolve", label: "Card done", description: "The card's rule has played out.", primary: true }];
    }
    case "end_turn": {
      const next = nextPlayer(state);
      const description = state.deck.remaining.length === 0 ? "The deck is empty; this ends the game." : next ? "Pass the deck to " + next.name + "." : undefined;
      return [{ type: "end_turn", label: "Next turn", primary: true, ...description ? { description } : {} }];
    }
    default:
      return [];
  }
}
function apply(input, action, _rng) {
  const state = cloneState(input);
  switch (action.type) {
    case "draw": {
      requirePhase(state, PHASES, ["draw"], action);
      const actor = requireCurrentActor(state, action);
      const card = drawFrom(state.deck);
      const turnCard = { card, drawer: actor.id, resolved: false };
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
      if (!turnCard)
        throw new IllegalActionError("No card has been drawn this turn.");
      const rule = ruleFor(state, turnCard.card);
      if (rule.effect === "target") {
        turnCard.target = requireTarget(state, action, { excludeId: actor.id, label: "who drinks" }).id;
      } else if (rule.effect === "mate") {
        const mate = requireTarget(state, action, { excludeId: actor.id, label: "a mate" });
        turnCard.target = mate.id;
        if (!hasMatePair(state, actor.id, mate.id))
          state.mates.push([actor.id, mate.id]);
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
    case "set_rules": {
      requireActiveGame(state);
      const overrides = isRecord(action.data?.rules) ? action.data.rules : null;
      if (!overrides)
        throw new IllegalActionError("Send the card rules to change.");
      const rules = normalizeRules(overrides, state.rules);
      const changed = RANKS.filter((rank) => {
        const before = state.rules[rank];
        const after = rules[rank];
        return before.title !== after.title || before.rule !== after.rule || before.effect !== after.effect;
      });
      if (!changed.length)
        throw new IllegalActionError("Those are already the card rules.");
      state.rules = rules;
      addLog(state, "Card rules changed: " + changed.map((rank) => rank + " (" + rules[rank].title + ")").join(", ") + ".");
      return state;
    }
    default:
      return unknownAction(state, PHASES, action);
  }
}
function promptBlock(state) {
  const lines = [];
  lines.push(turnOrderLine(state));
  if (state.status === "ended") {
    lines.push("Game over: " + (state.endReason ?? "the game has ended.") + " No more cards are drawn.");
  } else {
    const player = currentPlayer(state);
    lines.push("It is " + player.name + "'s turn.");
    if (state.phase === "draw") {
      lines.push(player.name + " has not drawn a card yet.");
      if (state.previous)
        lines.push("Last card: " + describeDraw(state, state.previous) + ". " + describeResolution(state, state.previous));
    } else if (state.turnCard) {
      const rule = ruleFor(state, state.turnCard.card);
      lines.push(describeDraw(state, state.turnCard) + ": " + ruleText(rule, player.name));
      lines.push(state.phase === "resolve" ? pendingLine(state, state.turnCard) : "Resolved: " + describeResolution(state, state.turnCard) + " " + player.name + "'s turn is wrapping up.");
    }
  }
  const cupPart = state.cup.length ? " The King's Cup holds pours from " + joinNames(state.cup.map((id) => playerName(state, id))) + "." : "";
  lines.push("Kings drawn: " + String(state.kingsDrawn) + "/4." + cupPart + " Cards left: " + String(state.deck.remaining.length) + ".");
  if (state.questionMaster)
    lines.push("Question Master: " + playerName(state, state.questionMaster) + ".");
  if (state.mates.length)
    lines.push("Mates: " + matesLine(state) + ".");
  if (state.customRules.length)
    lines.push("Rules in play: " + rulesLine(state));
  const next = nextPlayer(state);
  if (next && state.status === "active")
    lines.push("Next up: " + next.name + ".");
  return formatBlock("Kings Cup \u2014 turn " + String(state.turn.number), lines);
}
function view(state) {
  const current = state.status === "active" ? currentPlayer(state) : null;
  const next = nextPlayer(state);
  let headline;
  let detail;
  if (state.status === "ended") {
    headline = "Game over";
    detail = state.endReason ?? undefined;
  } else if (state.turnCard && current) {
    const rule = ruleFor(state, state.turnCard.card);
    headline = current.name + " drew " + cardLabel(state.turnCard.card) + " \u2014 " + rule.title;
    detail = ruleText(rule, current.name);
    if (state.phase === "end_turn")
      detail += " " + describeResolution(state, state.turnCard);
  } else {
    headline = (current?.name ?? "Someone") + " to draw";
    detail = state.previous ? "Last card: " + describeDraw(state, state.previous) + "." : undefined;
  }
  const facts = [
    { label: "Kings", value: String(state.kingsDrawn) + "/4" },
    { label: "Cards left", value: String(state.deck.remaining.length) }
  ];
  if (state.turn.direction === -1)
    facts.push({ label: "Turn order", value: "Reversed" });
  if (state.cup.length)
    facts.push({ label: "King's Cup", value: joinNames(state.cup.map((id) => playerName(state, id))) });
  if (state.questionMaster)
    facts.push({ label: "Question Master", value: playerName(state, state.questionMaster) });
  if (state.mates.length)
    facts.push({ label: "Mates", value: matesLine(state) });
  state.customRules.forEach((entry, index) => {
    facts.push({ label: "Rule " + String(index + 1), value: entry.text + " (" + playerName(state, entry.by) + ")" });
  });
  return {
    gameId: "kings_cup",
    gameName: "Kings Cup",
    status: state.status,
    turnNumber: state.turn.number,
    phase: state.phase,
    phaseLabel: PHASES[state.phase] ?? state.phase,
    direction: directionOf(state),
    currentPlayerId: current?.id ?? null,
    nextPlayerId: next?.id ?? null,
    players: state.players.map((player) => {
      const badges = [];
      if (state.questionMaster === player.id)
        badges.push("Question Master");
      for (const [a, b] of state.mates) {
        if (a === player.id)
          badges.push("Mate: " + playerName(state, b));
        else if (b === player.id)
          badges.push("Mate: " + playerName(state, a));
      }
      return {
        id: player.id,
        name: player.name,
        kind: player.kind,
        active: player.active,
        current: player.id === current?.id,
        next: player.id === next?.id && next?.id !== current?.id,
        badges
      };
    }),
    headline,
    ...detail ? { detail } : {},
    facts,
    recent: recentLog(state, 6),
    ...state.status === "ended" && state.endReason ? { endSummary: state.endReason } : {},
    cardRules: RANKS.map((rank) => ({ id: rank, label: rank, ...state.rules[rank] }))
  };
}
var kingsCup = {
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
  view
};
// src/data/truth-or-dare.json
var truth_or_dare_default = {
  _comment: "Bundled Truth or Dare prompts. Ids are stored in user settings to disable entries: never reuse or renumber an id; append new ones.",
  truths: [
    {
      id: "t-mild-01",
      tier: "mild",
      text: "What is a habit of yours you would never admit to in public?"
    },
    {
      id: "t-mild-02",
      tier: "mild",
      text: "What is the silliest thing you have ever been afraid of?"
    },
    {
      id: "t-mild-03",
      tier: "mild",
      text: "What is the worst gift you have ever received, and what did you say when you opened it?"
    },
    {
      id: "t-mild-04",
      tier: "mild",
      text: "Who here would you want beside you in a crisis, and why?"
    },
    {
      id: "t-mild-05",
      tier: "mild",
      text: "What is something you pretend to understand but don't?"
    },
    {
      id: "t-mild-06",
      tier: "mild",
      text: "What is the most childish thing you still do?"
    },
    {
      id: "t-mild-07",
      tier: "mild",
      text: "If you could swap lives with {other} for a day, what would you do first?"
    },
    {
      id: "t-mild-08",
      tier: "mild",
      text: "What was the last lie you told?"
    },
    {
      id: "t-mild-09",
      tier: "mild",
      text: "What is your most irrational pet peeve?"
    },
    {
      id: "t-mild-10",
      tier: "mild",
      text: "What talent do you secretly wish you had?"
    },
    {
      id: "t-mild-11",
      tier: "mild",
      text: "What is the strangest dream you remember?"
    },
    {
      id: "t-mild-12",
      tier: "mild",
      text: "Who here would survive longest in the wilderness, and who would go first?"
    },
    {
      id: "t-mild-13",
      tier: "mild",
      text: "What food do you claim to like but actually can't stand?"
    },
    {
      id: "t-mild-14",
      tier: "mild",
      text: "What is the most trouble you ever got into as a child?"
    },
    {
      id: "t-mild-15",
      tier: "mild",
      text: "What is one thing you would change about yourself if you could?"
    },
    {
      id: "t-bold-01",
      tier: "bold",
      text: "Who here would you most want to be stuck somewhere alone with for a night?"
    },
    {
      id: "t-bold-02",
      tier: "bold",
      text: "What is the most embarrassing thing you have done to impress someone?"
    },
    {
      id: "t-bold-03",
      tier: "bold",
      text: "What was your honest first impression of {other}?"
    },
    {
      id: "t-bold-04",
      tier: "bold",
      text: "What is the most awkward first meeting you have ever had with someone you liked?"
    },
    {
      id: "t-bold-05",
      tier: "bold",
      text: "Have you ever had a crush on someone you shouldn't have? Who?"
    },
    {
      id: "t-bold-06",
      tier: "bold",
      text: "What is something you have never told anyone here?"
    },
    {
      id: "t-bold-07",
      tier: "bold",
      text: "What is the pettiest revenge you have ever taken?"
    },
    {
      id: "t-bold-08",
      tier: "bold",
      text: "Who here do you think has a secret crush, and on whom?"
    },
    {
      id: "t-bold-09",
      tier: "bold",
      text: "What is the worst thing you have done and gotten away with?"
    },
    {
      id: "t-bold-10",
      tier: "bold",
      text: "What is the most jealous you have ever been?"
    },
    {
      id: "t-bold-11",
      tier: "bold",
      text: "Rank everyone here by how good a kisser you think they are."
    },
    {
      id: "t-bold-12",
      tier: "bold",
      text: "What is a rumor about you that is actually true?"
    },
    {
      id: "t-bold-13",
      tier: "bold",
      text: "What is the boldest line anyone has ever used on you, or you on them?"
    },
    {
      id: "t-bold-14",
      tier: "bold",
      text: "Who here would you trust least with a secret?"
    },
    {
      id: "t-bold-15",
      tier: "bold",
      text: "What is the most embarrassing thing you own?"
    },
    {
      id: "t-wild-01",
      tier: "wild",
      text: "What is the biggest secret you are keeping right now?"
    },
    {
      id: "t-wild-02",
      tier: "wild",
      text: "What is the worst thing you have ever said about someone here behind their back?"
    },
    {
      id: "t-wild-03",
      tier: "wild",
      text: "What have you done that you would never want your family to find out about?"
    },
    {
      id: "t-wild-04",
      tier: "wild",
      text: "If you had to court someone here, who would it be and why?"
    },
    {
      id: "t-wild-05",
      tier: "wild",
      text: "What is the most reckless thing you have ever done?"
    },
    {
      id: "t-wild-06",
      tier: "wild",
      text: "What is one thing about {other} that annoys you more than it should?"
    },
    {
      id: "t-wild-07",
      tier: "wild",
      text: "What is the biggest lie you have ever told someone here?"
    },
    {
      id: "t-wild-08",
      tier: "wild",
      text: "What is your deepest regret?"
    },
    {
      id: "t-wild-09",
      tier: "wild",
      text: "Who here would you least want to be left alone with, and why?"
    },
    {
      id: "t-wild-10",
      tier: "wild",
      text: "What is something you are genuinely ashamed of?"
    },
    {
      id: "t-wild-11",
      tier: "wild",
      text: "What do you really think of {other}? Be completely honest."
    },
    {
      id: "t-wild-12",
      tier: "wild",
      text: "Have you ever betrayed a friend's trust? What happened?"
    },
    {
      id: "t-wild-13",
      tier: "wild",
      text: "What is a desire you have never said out loud?"
    },
    {
      id: "t-wild-14",
      tier: "wild",
      text: "What is the most scandalous thing you have witnessed and kept quiet about?"
    }
  ],
  dares: [
    {
      id: "d-mild-01",
      tier: "mild",
      text: "Do your best impression of {other} until someone guesses who it is."
    },
    {
      id: "d-mild-02",
      tier: "mild",
      text: "Speak only in rhymes until your next turn."
    },
    {
      id: "d-mild-03",
      tier: "mild",
      text: "Let {other} give you a nickname that everyone must use for the rest of the game."
    },
    {
      id: "d-mild-04",
      tier: "mild",
      text: "Tell a joke. If nobody laughs, tell another."
    },
    {
      id: "d-mild-05",
      tier: "mild",
      text: "Sing the chorus of a song {other} chooses."
    },
    {
      id: "d-mild-06",
      tier: "mild",
      text: "Talk in an over-the-top accent until your next turn."
    },
    {
      id: "d-mild-07",
      tier: "mild",
      text: "Give everyone here a sincere compliment."
    },
    {
      id: "d-mild-08",
      tier: "mild",
      text: "Act out a famous scene from a story without words until someone guesses it."
    },
    {
      id: "d-mild-09",
      tier: "mild",
      text: "Do ten jumping jacks while reciting the alphabet."
    },
    {
      id: "d-mild-10",
      tier: "mild",
      text: "Balance something on your head until your next turn."
    },
    {
      id: "d-mild-11",
      tier: "mild",
      text: "Narrate everything you do in the third person until your next turn."
    },
    {
      id: "d-mild-12",
      tier: "mild",
      text: "Let {other} style your hair however they like."
    },
    {
      id: "d-mild-13",
      tier: "mild",
      text: "Make up a short poem about {other} on the spot."
    },
    {
      id: "d-mild-14",
      tier: "mild",
      text: "Perform your most dramatic slow-motion fall."
    },
    {
      id: "d-mild-15",
      tier: "mild",
      text: "Hold a staring contest with {other}. Whoever blinks first does a forfeit of the winner's choosing."
    },
    {
      id: "d-bold-01",
      tier: "bold",
      text: "Serenade {other} with a love song of your choice."
    },
    {
      id: "d-bold-02",
      tier: "bold",
      text: "Give {other} your most convincing romantic line."
    },
    {
      id: "d-bold-03",
      tier: "bold",
      text: "Swap an item of clothing with {other} until your next turn."
    },
    {
      id: "d-bold-04",
      tier: "bold",
      text: "Let {other} draw something on your arm or face."
    },
    {
      id: "d-bold-05",
      tier: "bold",
      text: "Confess something embarrassing to the whole group in a dramatic voice."
    },
    {
      id: "d-bold-06",
      tier: "bold",
      text: "Dance with {other} until your next turn."
    },
    {
      id: "d-bold-07",
      tier: "bold",
      text: "Describe {other} as if you were writing a glowing personal ad for them."
    },
    {
      id: "d-bold-08",
      tier: "bold",
      text: "Do your best runway walk across the room."
    },
    {
      id: "d-bold-09",
      tier: "bold",
      text: "Let the group pick a word you must work into everything you say until your next turn."
    },
    {
      id: "d-bold-10",
      tier: "bold",
      text: "Act out how you would propose to {other}."
    },
    {
      id: "d-bold-11",
      tier: "bold",
      text: "Give {other} a shoulder rub for one minute."
    },
    {
      id: "d-bold-12",
      tier: "bold",
      text: "Imitate how you think {other} flirts."
    },
    {
      id: "d-bold-13",
      tier: "bold",
      text: "Let {other} choose a ridiculous pose you must hold for a full minute."
    },
    {
      id: "d-bold-14",
      tier: "bold",
      text: "Tell {other} three things you genuinely admire about them while looking them in the eye."
    },
    {
      id: "d-wild-01",
      tier: "wild",
      text: "Let {other} ask you any question; you must answer truthfully."
    },
    {
      id: "d-wild-02",
      tier: "wild",
      text: "Kiss {other} on the cheek."
    },
    {
      id: "d-wild-03",
      tier: "wild",
      text: "Let the group invent a dare for you on the spot."
    },
    {
      id: "d-wild-04",
      tier: "wild",
      text: "Sit on {other}'s lap until your next turn."
    },
    {
      id: "d-wild-05",
      tier: "wild",
      text: "Whisper something in {other}'s ear that makes them blush."
    },
    {
      id: "d-wild-06",
      tier: "wild",
      text: "Slow dance with {other}, with no music."
    },
    {
      id: "d-wild-07",
      tier: "wild",
      text: "Trade seats with {other} and imitate them until your next turn."
    },
    {
      id: "d-wild-08",
      tier: "wild",
      text: "Eat or drink something the group mixes together for you."
    },
    {
      id: "d-wild-09",
      tier: "wild",
      text: "Hold hands with {other} until your next turn."
    },
    {
      id: "d-wild-10",
      tier: "wild",
      text: "Go somewhere you will be overheard and loudly declare your admiration for {other}."
    },
    {
      id: "d-wild-11",
      tier: "wild",
      text: "Make a dramatic declaration of love to an object in the room."
    },
    {
      id: "d-wild-12",
      tier: "wild",
      text: "Let {other} tickle you for thirty seconds without laughing."
    },
    {
      id: "d-wild-13",
      tier: "wild",
      text: "Reveal the most embarrassing nickname you have ever had and let everyone use it until your next turn."
    },
    {
      id: "d-wild-14",
      tier: "wild",
      text: "Describe your ideal evening with {other}, in detail."
    }
  ]
};

// src/games/truth-or-dare.ts
var TIERS = ["mild", "bold", "wild"];
var TIER_LABELS = {
  mild: { label: "Mild", description: "Friendly questions and silly stunts" },
  bold: { label: "Bold", description: "Embarrassing confessions and flirty dares" },
  wild: { label: "Wild", description: "Deep secrets and daring stunts" }
};
function bundledList(value) {
  if (!Array.isArray(value))
    return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.text !== "string")
      return [];
    if (!TIERS.includes(entry.tier))
      return [];
    return [{ id: entry.id, tier: entry.tier, text: entry.text }];
  });
}
var BUNDLED_TRUTHS = bundledList(truth_or_dare_default.truths);
var BUNDLED_DARES = bundledList(truth_or_dare_default.dares);
var BUNDLED_IDS = new Set([...BUNDLED_TRUTHS, ...BUNDLED_DARES].map((prompt) => prompt.id));
var MAX_CUSTOM_PROMPTS = 100;
var MAX_PROMPT_TEXT = 200;
var MAX_FORFEIT_TEXT = 80;
var MAX_STRIKE_LIMIT = 9;
var REFUSAL_RULES = ["free", "forfeit", "strikes"];
function cleanList(value) {
  if (!Array.isArray(value))
    return [];
  const seen = new Set;
  const result = [];
  for (const entry of value) {
    const text = cleanText(entry, MAX_PROMPT_TEXT);
    if (!text || seen.has(text.toLowerCase()))
      continue;
    seen.add(text.toLowerCase());
    result.push(text);
    if (result.length >= MAX_CUSTOM_PROMPTS)
      break;
  }
  return result;
}
function defaultOptions2() {
  return {
    tiers: ["mild", "bold"],
    refusals: "forfeit",
    forfeit: "drinks",
    strikeLimit: 3,
    customTruths: [],
    customDares: [],
    disabled: []
  };
}
function normalizeOptions2(raw) {
  const source = isRecord(raw) ? raw : {};
  const base = defaultOptions2();
  const limit = Number(source.strikeLimit);
  return {
    tiers: Array.isArray(source.tiers) ? TIERS.filter((tier) => source.tiers.includes(tier)) : base.tiers,
    refusals: REFUSAL_RULES.includes(source.refusals) ? source.refusals : base.refusals,
    forfeit: cleanText(source.forfeit, MAX_FORFEIT_TEXT).replace(/[.!]+$/, "") || base.forfeit,
    strikeLimit: Number.isInteger(limit) ? Math.min(MAX_STRIKE_LIMIT, Math.max(1, limit)) : base.strikeLimit,
    customTruths: cleanList(source.customTruths),
    customDares: cleanList(source.customDares),
    disabled: Array.isArray(source.disabled) ? [...new Set(source.disabled.filter((id) => typeof id === "string" && BUNDLED_IDS.has(id)))] : []
  };
}
function promptPool(options, kind) {
  const source = kind === "truth" ? BUNDLED_TRUTHS : BUNDLED_DARES;
  const custom = kind === "truth" ? options.customTruths : options.customDares;
  const disabled = new Set(options.disabled);
  return [
    ...source.filter((prompt) => options.tiers.includes(prompt.tier) && !disabled.has(prompt.id)).map((prompt) => ({ ...prompt })),
    ...custom.map((text, index) => ({ id: (kind === "truth" ? "ct-" : "cd-") + String(index + 1), text, custom: true }))
  ];
}
var PHASES2 = {
  choose: "choose",
  prompt: "prompt",
  end_turn: "end of turn",
  game_over: "game over"
};
function deckFor(state, kind) {
  return kind === "truth" ? state.truths : state.dares;
}
function availableKinds(state) {
  return ["truth", "dare"].filter((kind) => deckFor(state, kind).remaining.length > 0);
}
function promptText(state, current) {
  return current.prompt.text.split("{player}").join(playerName(state, current.player)).split("{other}").join(current.other ? playerName(state, current.other) : "another player");
}
function pickOther(state, playerId, text, rng) {
  if (!text.includes("{other}"))
    return null;
  const others = activePlayers(state).filter((player) => player.id !== playerId);
  return others.length ? others[randomInt(rng, others.length)].id : null;
}
function tallyFor(state, playerId) {
  return state.tally[playerId] ??= { truths: 0, dares: 0, refused: 0 };
}
function refusalRule(state) {
  switch (state.refusals) {
    case "free":
      return "Players may refuse with no penalty.";
    case "forfeit":
      return "A player who refuses " + state.forfeit + ".";
    default:
      return "Each refusal is a strike; " + String(state.strikeLimit) + " strike" + (state.strikeLimit === 1 ? "" : "s") + " and a player is out.";
  }
}
function describeOutcome(state, current) {
  const name = playerName(state, current.player);
  if (current.outcome === "done")
    return current.kind === "truth" ? name + " answered the truth." : name + " did the dare.";
  if (current.outcome === "pending")
    return "";
  if (state.refusals === "forfeit")
    return name + " refused the " + current.kind + " and " + state.forfeit + ".";
  if (state.refusals === "strikes") {
    const strikes = state.strikes[current.player] ?? 0;
    const out = strikes >= state.strikeLimit ? " " + name + " is out." : "";
    return name + " refused the " + current.kind + ": strike " + String(strikes) + " of " + String(state.strikeLimit) + "." + out;
  }
  return name + " refused the " + current.kind + ".";
}
function strikesLine(state) {
  if (state.refusals !== "strikes")
    return "";
  const entries = state.players.filter((player) => player.active && (state.strikes[player.id] ?? 0) > 0).map((player) => player.name + " " + String(state.strikes[player.id]) + "/" + String(state.strikeLimit));
  return entries.length ? "Strikes: " + entries.join(", ") + "." : "";
}
function promptsLeft(state) {
  const truths = state.truths.remaining.length;
  const dares = state.dares.remaining.length;
  return String(truths) + " truth" + (truths === 1 ? "" : "s") + ", " + String(dares) + " dare" + (dares === 1 ? "" : "s");
}
function setup2(players, options, rng) {
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
    previous: null
  };
}
function legalActions2(state) {
  if (state.status !== "active")
    return [];
  const player = currentPlayer(state);
  switch (state.phase) {
    case "choose": {
      const kinds = availableKinds(state);
      const actions = [];
      if (kinds.includes("truth"))
        actions.push({ type: "choose", label: "Truth", preset: { choice: "truth" } });
      if (kinds.includes("dare"))
        actions.push({ type: "choose", label: "Dare", preset: { choice: "dare" } });
      if (kinds.length) {
        actions.push({
          type: "choose",
          label: "Random",
          description: "Let the game pick truth or dare for " + player.name + ".",
          primary: true,
          preset: { choice: "random" }
        });
      }
      return actions;
    }
    case "prompt": {
      const current = state.current;
      if (!current)
        return [];
      const strike = (state.strikes[player.id] ?? 0) + 1;
      const refuseNote = state.refusals === "free" ? "Refusing has no penalty." : state.refusals === "forfeit" ? "If " + player.name + " refuses, " + player.name + " " + state.forfeit + "." : "If " + player.name + " refuses, that is strike " + String(strike) + " of " + String(state.strikeLimit) + (strike >= state.strikeLimit ? " and " + player.name + " is out." : ".");
      const actions = [
        { type: "perform", label: current.kind === "truth" ? "Answered" : "Did the dare", primary: true },
        { type: "refuse", label: "Refuse", description: refuseNote }
      ];
      if (deckFor(state, current.kind).remaining.length) {
        actions.push({ type: "swap", label: "Draw a different " + current.kind, description: "Skip this one; it will not come up again." });
      }
      return actions;
    }
    case "end_turn": {
      const next = nextPlayer(state);
      const description = availableKinds(state).length === 0 ? "Out of prompts; this ends the game." : next ? "Pass to " + next.name + "." : undefined;
      return [{ type: "end_turn", label: "Next turn", primary: true, ...description ? { description } : {} }];
    }
    default:
      return [];
  }
}
function drawPrompt(state, kind, playerId, random, rng) {
  const prompt = drawFrom(deckFor(state, kind));
  return { kind, prompt, player: playerId, other: pickOther(state, playerId, prompt.text, rng), random, outcome: "pending" };
}
function apply2(input, action, rng) {
  const state = cloneState(input);
  switch (action.type) {
    case "choose": {
      requirePhase(state, PHASES2, ["choose"], action);
      const actor = requireCurrentActor(state, action);
      const kinds = availableKinds(state);
      let kind;
      if (action.choice === "random") {
        if (!kinds.length)
          throw new IllegalActionError("There are no prompts left.");
        kind = kinds[randomInt(rng, kinds.length)];
      } else if (action.choice === "truth" || action.choice === "dare") {
        kind = action.choice;
        if (!kinds.includes(kind))
          throw new IllegalActionError("There are no " + kind + "s left. Pick " + (kind === "truth" ? "dare" : "truth") + ".");
      } else {
        throw new IllegalActionError("Pick truth, dare, or random.");
      }
      const random = action.choice === "random";
      state.current = drawPrompt(state, kind, actor.id, random, rng);
      const tally = tallyFor(state, actor.id);
      if (kind === "truth")
        tally.truths += 1;
      else
        tally.dares += 1;
      addLog(state, actor.name + " picked " + kind + (random ? " (at random)" : "") + ': "' + promptText(state, state.current) + '"');
      state.phase = "prompt";
      return state;
    }
    case "perform":
    case "refuse": {
      requirePhase(state, PHASES2, ["prompt"], action);
      const actor = requireCurrentActor(state, action);
      const current = state.current;
      if (!current)
        throw new IllegalActionError("No prompt has been drawn this turn.");
      if (action.type === "perform") {
        current.outcome = "done";
      } else {
        current.outcome = "refused";
        tallyFor(state, actor.id).refused += 1;
        if (state.refusals === "strikes")
          state.strikes[actor.id] = (state.strikes[actor.id] ?? 0) + 1;
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
      requirePhase(state, PHASES2, ["prompt"], action);
      const actor = requireCurrentActor(state, action);
      const current = state.current;
      if (!current)
        throw new IllegalActionError("No prompt has been drawn this turn.");
      if (!deckFor(state, current.kind).remaining.length)
        throw new IllegalActionError("There are no other " + current.kind + "s left.");
      state.current = drawPrompt(state, current.kind, actor.id, current.random, rng);
      addLog(state, actor.name + " skipped that " + current.kind + ' and drew another: "' + promptText(state, state.current) + '"');
      return state;
    }
    case "end_turn": {
      requirePhase(state, PHASES2, ["end_turn"], action);
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
      return unknownAction(state, PHASES2, action);
  }
}
function promptBlock2(state) {
  const lines = [turnOrderLine(state)];
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
        lines.push(current.kind === "truth" ? "Waiting for " + player.name + " to answer or refuse. Use this exact question; do not replace it." : "Waiting for " + player.name + " to do it or refuse. Use this exact dare; do not replace it.");
      } else {
        lines.push("Resolved: " + describeOutcome(state, current) + " " + player.name + "'s turn is wrapping up.");
      }
    }
  }
  lines.push("Refusal rule: " + refusalRule(state));
  const strikes = strikesLine(state);
  if (strikes)
    lines.push(strikes);
  const out = state.players.filter((player) => !player.active).map((player) => player.name);
  if (out.length)
    lines.push("Out of the game: " + joinNames(out) + ".");
  lines.push("Prompts left: " + promptsLeft(state) + ".");
  const next = nextPlayer(state);
  if (next && state.status === "active")
    lines.push("Next up: " + next.name + ".");
  return formatBlock("Truth or Dare \u2014 turn " + String(state.turn.number), lines);
}
function view2(state) {
  const current = state.status === "active" ? currentPlayer(state) : null;
  const next = nextPlayer(state);
  let headline;
  let detail;
  const prompt = state.current;
  if (state.status === "ended") {
    headline = "Game over";
    detail = state.endReason ?? undefined;
  } else if (prompt && current) {
    const kind = prompt.kind === "truth" ? "Truth" : "Dare";
    const suffix = prompt.outcome === "done" ? " \u2014 done" : prompt.outcome === "refused" ? " \u2014 refused" : "";
    headline = current.name + ": " + kind + (prompt.random ? " (random)" : "") + suffix;
    detail = promptText(state, prompt);
    if (prompt.outcome !== "pending")
      detail += " " + describeOutcome(state, prompt);
  } else {
    headline = (current?.name ?? "Someone") + " to choose";
    detail = state.previous ? describeOutcome(state, state.previous) || undefined : undefined;
  }
  const facts = [
    { label: "Truths left", value: String(state.truths.remaining.length) },
    { label: "Dares left", value: String(state.dares.remaining.length) },
    { label: "Refusing", value: refusalRule(state) }
  ];
  if (state.tiers.length)
    facts.push({ label: "Intensity", value: state.tiers.map((tier) => TIER_LABELS[tier].label).join(", ") });
  if (state.turn.direction === -1)
    facts.push({ label: "Turn order", value: "Reversed" });
  return {
    gameId: "truth_or_dare",
    gameName: "Truth or Dare",
    status: state.status,
    turnNumber: state.turn.number,
    phase: state.phase,
    phaseLabel: PHASES2[state.phase] ?? state.phase,
    direction: directionOf(state),
    currentPlayerId: current?.id ?? null,
    nextPlayerId: next?.id ?? null,
    players: state.players.map((player) => {
      const badges = [];
      const tally = state.tally[player.id];
      if (tally?.truths)
        badges.push(String(tally.truths) + (tally.truths === 1 ? " truth" : " truths"));
      if (tally?.dares)
        badges.push(String(tally.dares) + (tally.dares === 1 ? " dare" : " dares"));
      const strikes = state.strikes[player.id] ?? 0;
      if (state.refusals === "strikes" && strikes > 0)
        badges.push("Strikes " + String(strikes) + "/" + String(state.strikeLimit));
      if (!player.active)
        badges.push("Out");
      if (state.winners.includes(player.id))
        badges.push("Winner");
      return {
        id: player.id,
        name: player.name,
        kind: player.kind,
        active: player.active,
        current: player.id === current?.id,
        next: player.id === next?.id && next?.id !== current?.id,
        badges
      };
    }),
    headline,
    ...detail ? { detail } : {},
    facts,
    recent: recentLog(state, 6),
    ...state.status === "ended" && state.endReason ? { endSummary: state.endReason } : {}
  };
}
var truthOrDare = {
  id: "truth_or_dare",
  name: "Truth or Dare",
  description: "Pick truth or dare and face a prompt from the pool. Prompts never repeat; refusing can cost you.",
  minPlayers: 2,
  phases: PHASES2,
  defaultOptions: defaultOptions2,
  normalizeOptions: normalizeOptions2,
  setup: setup2,
  legalActions: legalActions2,
  apply: apply2,
  promptBlock: promptBlock2,
  view: view2
};

// src/engine/registry.ts
var GAMES = [kingsCup, truthOrDare];
var PLANNED = [
  { id: "never_have_i_ever", name: "Never Have I Ever", description: "Take turns confessing; lose a life for everything you have done.", minPlayers: 2, available: false }
];
function listGameDefinitions() {
  return GAMES;
}
function getGame(id) {
  return GAMES.find((game) => game.id === id);
}
function requireGame(id) {
  const game = getGame(id);
  if (!game)
    throw new Error('Unknown game "' + id + '".');
  return game;
}
function listGames() {
  return [
    ...GAMES.map((game) => ({
      id: game.id,
      name: game.name,
      description: game.description,
      minPlayers: game.minPlayers,
      available: true
    })),
    ...PLANNED.filter((planned) => !getGame(planned.id))
  ];
}

// src/engine/session.ts
var MAX_EVENTS = 2000;
var MAX_ACTION_DATA = 8000;

class Timeline {
  swipes = new Map;
  last;
  constructor(messages) {
    for (const message of messages)
      this.swipes.set(message.id, message.swipeId);
    const tail = messages[messages.length - 1];
    this.last = tail ? { messageId: tail.id, swipeId: tail.swipeId } : null;
  }
  isLive(anchor) {
    return anchor === null || this.swipes.get(anchor.messageId) === anchor.swipeId;
  }
  has(messageId) {
    return this.swipes.has(messageId);
  }
  get size() {
    return this.swipes.size;
  }
}
function headEvent(session, timeline) {
  for (let index = session.events.length - 1;index >= 0; index -= 1) {
    const event = session.events[index];
    if (event && timeline.isLive(event.anchor))
      return event;
  }
  return null;
}
function activeChain(session, timeline) {
  const byId = new Map(session.events.map((event) => [event.id, event]));
  const chain = [];
  const seen = new Set;
  let cursor = headEvent(session, timeline);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parent === null ? null : byId.get(cursor.parent) ?? null;
  }
  return chain.reverse();
}
function replay(definition, session, events) {
  let state = cloneState(session.setup.seedState);
  const applied = [];
  for (const event of events) {
    try {
      state = applyAction(definition, state, event.action, mulberry32(event.seed));
      applied.push(event);
    } catch (error) {
      return {
        state,
        chain: applied,
        head: applied[applied.length - 1] ?? null,
        replayError: "Stopped replaying at a stored action: " + (error instanceof Error ? error.message : String(error))
      };
    }
  }
  return { state, chain: applied, head: applied[applied.length - 1] ?? null };
}
function deriveGame(definition, session, timeline) {
  return replay(definition, session, activeChain(session, timeline));
}
function createSession(definition, players, rawOptions, rng, meta) {
  const listed = createPlayers(players);
  const seated = meta.turnOrder === "random" ? shuffle(listed, rng) : listed;
  const options = definition.normalizeOptions(rawOptions);
  const seedState = definition.setup(seated, options, rng);
  return {
    version: 1,
    id: meta.id,
    gameId: definition.id,
    createdAt: meta.now,
    setup: { players: seated, options, seedState },
    events: []
  };
}
function appendAction(definition, session, timeline, action, meta) {
  if (session.events.length >= MAX_EVENTS) {
    throw new IllegalActionError("This game has reached its limit of " + String(MAX_EVENTS) + " recorded actions. Start a new game.");
  }
  const current = deriveGame(definition, session, timeline);
  const state = applyAction(definition, current.state, action, mulberry32(meta.seed));
  const event = {
    id: meta.id,
    parent: current.head?.id ?? null,
    anchor: timeline.last,
    action,
    seed: meta.seed >>> 0,
    at: meta.now
  };
  return { session: { ...session, events: [...session.events, event] }, event, state };
}
function undoLast(definition, session, timeline) {
  const head = deriveGame(definition, session, timeline).head;
  if (!head)
    return null;
  const removed = new Set([head.id]);
  for (const event of session.events) {
    if (event.parent !== null && removed.has(event.parent))
      removed.add(event.id);
  }
  return { ...session, events: session.events.filter((event) => !removed.has(event.id)) };
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function shortString(value, limit) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}
function parseAction(raw) {
  const source = isRecord2(raw) ? raw : {};
  const type = shortString(source.type, 40);
  if (!type)
    throw new IllegalActionError("Choose an action.");
  const action = { type };
  const actor = shortString(source.actor, 40);
  const target = shortString(source.target, 40);
  const text = typeof source.text === "string" ? source.text.slice(0, 500) : undefined;
  const choice = shortString(source.choice, 40);
  if (actor)
    action.actor = actor;
  if (target)
    action.target = target;
  if (text !== undefined && text.trim())
    action.text = text;
  if (choice)
    action.choice = choice;
  if (isRecord2(source.data)) {
    const serialized = JSON.stringify(source.data);
    if (serialized.length > MAX_ACTION_DATA)
      throw new IllegalActionError("That change is too large to record.");
    action.data = JSON.parse(serialized);
  }
  if (Array.isArray(source.players)) {
    action.players = [...new Set(source.players.filter((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 40))].slice(0, 32);
  }
  return action;
}
function parseAnchor(value) {
  if (value === null)
    return null;
  if (!isRecord2(value) || typeof value.messageId !== "string" || !Number.isInteger(value.swipeId))
    return;
  return { messageId: value.messageId, swipeId: Number(value.swipeId) };
}
function parseEvent(value) {
  if (!isRecord2(value) || typeof value.id !== "string")
    return null;
  const anchor = parseAnchor(value.anchor);
  if (anchor === undefined)
    return null;
  if (value.parent !== null && typeof value.parent !== "string")
    return null;
  let action;
  try {
    action = parseAction(value.action);
  } catch {
    return null;
  }
  return {
    id: value.id,
    parent: value.parent,
    anchor,
    action,
    seed: Number.isInteger(value.seed) ? Number(value.seed) >>> 0 : 0,
    at: Number.isFinite(value.at) ? Number(value.at) : 0
  };
}
function emptyStoredGames() {
  return { version: 1, session: null };
}
function parseStoredGames(value) {
  if (!isRecord2(value) || value.version !== 1)
    return emptyStoredGames();
  const raw = value.session;
  if (!isRecord2(raw) || raw.version !== 1 || typeof raw.id !== "string" || typeof raw.gameId !== "string")
    return emptyStoredGames();
  const setup = isRecord2(raw.setup) ? raw.setup : null;
  if (!setup || !Array.isArray(setup.players) || !isRecord2(setup.seedState))
    return emptyStoredGames();
  const events = Array.isArray(raw.events) ? raw.events.map(parseEvent).filter((event) => event !== null) : [];
  return {
    version: 1,
    session: {
      version: 1,
      id: raw.id,
      gameId: raw.gameId,
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : 0,
      setup: {
        players: setup.players,
        options: isRecord2(setup.options) ? setup.options : {},
        seedState: setup.seedState
      },
      events
    }
  };
}

// src/backend/settings.ts
var SETTINGS_PATH = "settings.json";
var MAX_INJECTION_DEPTH = 50;
var DEFAULT_SETTINGS = Object.freeze({
  autoInject: true,
  injectionDepth: 1
});
function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const depth = Number(source.injectionDepth);
  return {
    autoInject: typeof source.autoInject === "boolean" ? source.autoInject : DEFAULT_SETTINGS.autoInject,
    injectionDepth: Number.isInteger(depth) ? Math.min(MAX_INJECTION_DEPTH, Math.max(0, depth)) : DEFAULT_SETTINGS.injectionDepth
  };
}
function insertAtDepth(messages, value, depth) {
  const index = Math.max(0, messages.length - Math.max(0, depth));
  return [...messages.slice(0, index), value, ...messages.slice(index)];
}

// src/backend/service.ts
var METADATA_KEY = "lumiverse_party_games";
var CONDITIONAL_METADATA_CAPABILITY = "chat-conditional-metadata-v1";
var REQUIRED_PERMISSIONS = ["chats", "chat_mutation"];
var WRITE_ATTEMPTS = 4;
function missingPermissions(host) {
  return REQUIRED_PERMISSIONS.filter((permission) => !host.hasPermission(permission));
}
function permissionError(missing) {
  return new Error("Party Games needs the " + missing.join(" and ") + " permission" + (missing.length === 1 ? "" : "s") + " to keep score in this chat.");
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function defaultsPath(gameId) {
  return "defaults-" + gameId.replace(/[^a-z0-9_-]/gi, "") + ".json";
}
var MAX_PARTICIPANTS = 15;

class PartyGamesService {
  host;
  userId;
  queues = new Map;
  settingsCache = null;
  defaultsCache = new Map;
  constructor(host, userId) {
    this.host = host;
    this.userId = userId;
  }
  async settings() {
    if (!this.settingsCache) {
      try {
        this.settingsCache = normalizeSettings(await this.host.readJson(SETTINGS_PATH, this.userId));
      } catch (error) {
        this.host.warn("settings read failed: " + errorMessage2(error));
        return { ...DEFAULT_SETTINGS };
      }
    }
    return { ...this.settingsCache };
  }
  async saveSettings(raw) {
    const settings = normalizeSettings(raw);
    await this.host.writeJson(SETTINGS_PATH, settings, this.userId);
    this.settingsCache = settings;
    return { ...settings };
  }
  async gameDefaults(gameId) {
    const definition = requireGame(gameId);
    const cached = this.defaultsCache.get(gameId);
    if (cached)
      return structuredClone(cached);
    let stored;
    try {
      stored = await this.host.readJson(defaultsPath(gameId), this.userId);
    } catch (error) {
      this.host.warn("saved defaults read failed: " + errorMessage2(error));
    }
    const options = stored && typeof stored === "object" ? definition.normalizeOptions(stored) : definition.defaultOptions();
    this.defaultsCache.set(gameId, options);
    return structuredClone(options);
  }
  async allGameDefaults() {
    const entries = await Promise.all(listGameDefinitions().map(async (game) => [game.id, await this.gameDefaults(game.id)]));
    return Object.fromEntries(entries);
  }
  async saveDefaults(gameId, raw) {
    const definition = requireGame(gameId);
    const options = definition.normalizeOptions(raw);
    await this.host.writeJson(defaultsPath(gameId), options, this.userId);
    this.defaultsCache.set(gameId, options);
    return structuredClone(options);
  }
  serial(chatId, task) {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const run = previous.catch(() => {
      return;
    }).then(task);
    this.queues.set(chatId, run.then(() => {
      return;
    }, () => {
      return;
    }));
    return run;
  }
  async load(chatId, excludeMessageId) {
    const missing = missingPermissions(this.host);
    if (missing.length)
      throw permissionError(missing);
    const chat = await this.host.getChat(chatId, this.userId);
    if (!chat)
      throw new Error("That chat no longer exists.");
    const all = await this.host.getTimeline(chatId);
    const messages = excludeMessageId ? all.filter((message) => message.id !== excludeMessageId) : all;
    return { chat, stored: parseStoredGames(chat.metadata?.[METADATA_KEY]), timeline: new Timeline(messages), messages };
  }
  derive(session, timeline) {
    const definition = getGame(session.gameId);
    if (!definition)
      return null;
    return { definition, derived: deriveGame(definition, session, timeline) };
  }
  async buildState(chatId, stored, timeline) {
    const warnings = [];
    const settings = await this.settings();
    let game = null;
    if (stored.session) {
      const result = this.derive(stored.session, timeline);
      if (!result) {
        warnings.push('This chat has a game this version does not know ("' + stored.session.gameId + '"). End it to start a new one.');
      } else {
        const { definition, derived } = result;
        if (derived.replayError)
          warnings.push(derived.replayError);
        game = {
          sessionId: stored.session.id,
          view: definition.view(derived.state),
          actions: definition.legalActions(derived.state),
          canUndo: derived.head !== null,
          prompt: definition.promptBlock(derived.state)
        };
      }
    }
    return { chatId, games: listGames(), gameDefaults: await this.allGameDefaults(), settings, game, warnings };
  }
  async state(chatId) {
    const missing = missingPermissions(this.host);
    if (missing.length) {
      return {
        chatId,
        games: listGames(),
        gameDefaults: await this.allGameDefaults(),
        settings: await this.settings(),
        game: null,
        warnings: [permissionError(missing).message]
      };
    }
    const { stored, timeline } = await this.load(chatId);
    return this.buildState(chatId, stored, timeline);
  }
  async promptFor(chatId, excludeMessageId) {
    if (missingPermissions(this.host).length)
      return null;
    const { stored, timeline } = await this.load(chatId, excludeMessageId);
    if (!stored.session)
      return null;
    const result = this.derive(stored.session, timeline);
    return result ? result.definition.promptBlock(result.derived.state) : null;
  }
  async userName(chatId) {
    try {
      const name = (await this.host.resolveMacros("{{user}}", chatId, this.userId)).replace(/\s+/g, " ").trim();
      return { name: name.includes("{{") ? "" : name };
    } catch (error) {
      this.host.warn("persona name lookup failed: " + errorMessage2(error));
      return { name: "" };
    }
  }
  async mutate(chatId, change) {
    return this.serial(chatId, async () => {
      for (let attempt = 0;attempt < WRITE_ATTEMPTS; attempt += 1) {
        const { chat, stored, timeline } = await this.load(chatId);
        const { next, result } = change(stored, timeline);
        const metadata = { ...chat.metadata ?? {}, [METADATA_KEY]: next };
        if (!this.host.hasCapability(CONDITIONAL_METADATA_CAPABILITY)) {
          await this.host.replaceMetadata(chatId, metadata, this.userId);
          return result;
        }
        const written = await this.host.compareAndSetMetadata(chatId, {
          expected_metadata: chat.metadata ?? {},
          metadata,
          expected_last_message_id: timeline.last?.messageId ?? null
        }, this.userId);
        if (written)
          return result;
      }
      throw new Error("The chat kept changing while the game was saving. Try again.");
    });
  }
  async start(chatId, input) {
    const definition = requireGame(input.gameId);
    const participants = input.participants.map((name) => name.trim()).filter(Boolean);
    if (participants.length > MAX_PARTICIPANTS)
      throw new IllegalActionError("A game can have at most " + String(MAX_PARTICIPANTS) + " participants besides you.");
    const players = participants.map((name) => ({ name, kind: "character" }));
    if (input.includeUser) {
      const { name } = await this.userName(chatId);
      if (!name)
        throw new IllegalActionError('Could not read your persona name for {{user}}. Turn off "Include {{user}}" and add yourself as a participant instead.');
      players.unshift({ name, kind: "user" });
    }
    await this.mutate(chatId, (stored) => {
      if (stored.session && getGame(stored.session.gameId)) {
        throw new IllegalActionError("A game is already running in this chat. End it before starting another.");
      }
      const session = createSession(definition, players, input.options, this.host.rng(), {
        id: this.host.newId("s"),
        now: this.host.now(),
        turnOrder: input.turnOrder
      });
      return { next: { version: 1, session }, result: undefined };
    });
    return this.state(chatId);
  }
  async act(chatId, rawAction) {
    const action = parseAction(rawAction);
    const summary = await this.mutate(chatId, (stored, timeline) => {
      if (!stored.session)
        throw new IllegalActionError("No game is running in this chat.");
      const definition = requireGame(stored.session.gameId);
      const appended = appendAction(definition, stored.session, timeline, action, {
        id: this.host.newId("e"),
        seed: this.host.seed(),
        now: this.host.now()
      });
      return { next: { version: 1, session: appended.session }, result: appended.state.log.at(-1)?.text ?? "" };
    });
    return { state: await this.state(chatId), summary };
  }
  async next(chatId) {
    const current = await this.state(chatId);
    if (!current.game)
      throw new IllegalActionError("No game is running in this chat.");
    const primary = current.game.actions.find((action) => action.primary) ?? current.game.actions[0];
    if (!primary)
      throw new IllegalActionError("There is nothing to do; the game is over.");
    if (primary.fields?.some((field) => field.required)) {
      throw new IllegalActionError(primary.label + " needs a choice. Open the Party Games panel to make it.");
    }
    return this.act(chatId, { ...primary.preset, type: primary.type });
  }
  async undo(chatId) {
    await this.mutate(chatId, (stored, timeline) => {
      if (!stored.session)
        throw new IllegalActionError("No game is running in this chat.");
      const undone = undoLast(requireGame(stored.session.gameId), stored.session, timeline);
      if (!undone)
        throw new IllegalActionError("There is nothing to undo.");
      return { next: { version: 1, session: undone }, result: undefined };
    });
    return this.state(chatId);
  }
  async end(chatId) {
    await this.mutate(chatId, () => ({ next: emptyStoredGames(), result: undefined }));
    return this.state(chatId);
  }
  async intercept(messages, context) {
    try {
      if (context.generationType === "quiet")
        return messages;
      const settings = await this.settings();
      if (!settings.autoInject || !context.chatId)
        return messages;
      const block = await this.promptFor(context.chatId, context.excludeMessageId);
      if (!block)
        return messages;
      const injected = { role: "system", content: block };
      const result = insertAtDepth(messages, injected, settings.injectionDepth);
      return { messages: result, breakdown: [{ messageIndex: result.indexOf(injected), name: "Party Games: game state" }] };
    } catch (error) {
      this.host.warn("prompt injection skipped: " + errorMessage2(error));
      return messages;
    }
  }
}

// src/backend.ts
var LOG_PREFIX = "[Party Games] ";
var LEAN_MESSAGES_CAPABILITY = "chat-lean-messages-v1";
function errorMessage3(error) {
  return error instanceof Error ? error.message : String(error);
}
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
var idCounter = 0;
var host = {
  hasPermission: (permission) => spindle.permissions.has(permission),
  hasCapability: (capability) => (spindle.host?.capabilities?.[capability] ?? 0) > 0,
  getChat: async (chatId, userId) => {
    const chat = await spindle.chats.get(chatId, userId);
    return chat ? { id: chat.id, metadata: chat.metadata ?? {} } : null;
  },
  getTimeline: async (chatId) => {
    const messages = host.hasCapability(LEAN_MESSAGES_CAPABILITY) ? await spindle.chat.getMessages(chatId, { light: true, includeExtra: false }) : await spindle.chat.getMessages(chatId);
    return messages.map((message) => ({
      id: message.id,
      swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : 0
    }));
  },
  compareAndSetMetadata: async (chatId, input, userId) => {
    const chat = await spindle.chats.compareAndSetMetadata(chatId, input, userId);
    return chat ? { id: chat.id, metadata: chat.metadata ?? {} } : null;
  },
  replaceMetadata: async (chatId, metadata, userId) => {
    await spindle.chats.update(chatId, { metadata }, userId);
  },
  resolveMacros: async (template, chatId, userId) => {
    const { text } = await spindle.macros.resolve(template, { chatId, commit: false, ...userId ? { userId } : {} });
    return text;
  },
  readJson: (path, userId) => spindle.userStorage.getJson(path, { fallback: null, ...userId ? { userId } : {} }),
  writeJson: (path, value, userId) => spindle.userStorage.setJson(path, value, userId ? { userId } : {}),
  newId: (prefix) => prefix + Date.now().toString(36) + (++idCounter).toString(36) + cryptoSeed().toString(36),
  seed: cryptoSeed,
  rng: cryptoRng,
  now: () => Date.now(),
  warn: (message) => spindle.log.warn(LOG_PREFIX + message)
};
var services = new Map;
function service(userId) {
  const key = userId || "owner";
  let current = services.get(key);
  if (!current) {
    current = new PartyGamesService(host, userId);
    services.set(key, current);
  }
  return current;
}
function notifyChanged(chatId, reason, userId) {
  const message = { type: "party:changed", chatId, reason };
  spindle.sendToFrontend(message, userId);
}
spindle.onFrontendMessage((payload, userId) => {
  handlePartyRequest(payload, service(userId)).then(({ reply, changed }) => {
    if (reply)
      spindle.sendToFrontend(reply, userId);
    if (changed)
      spindle.sendToFrontend(changed, userId);
  });
});
var interceptorDisposer;
function syncInterceptor() {
  const granted = spindle.permissions.has("interceptor");
  if (granted && !interceptorDisposer) {
    interceptorDisposer = spindle.registerInterceptor((messages, context) => service(context.userId).intercept(messages, context), 100);
  } else if (!granted && interceptorDisposer) {
    interceptorDisposer();
    interceptorDisposer = undefined;
  }
  if (!granted) {
    spindle.log.warn(LOG_PREFIX + "interceptor permission not granted; the game state block is only available through {{party_game_state}}.");
  }
}
syncInterceptor();
function macroIdentity(context) {
  const value = record2(context);
  const env = record2(value.env);
  const chat = record2(env.chat);
  const extra = record2(env.extra);
  return {
    chatId: nonEmpty(value.chatId) ?? nonEmpty(chat.id),
    userId: nonEmpty(value.userId) ?? nonEmpty(extra.userId)
  };
}
function registerMacro(name, description, returnType, select) {
  const definition = {
    name,
    category: "extension:lumiverse_party_games",
    description,
    returnType,
    volatile: true,
    handler: async (context) => {
      const { chatId, userId } = macroIdentity(context);
      if (!chatId)
        return select(null);
      try {
        return select(await service(userId).promptFor(chatId));
      } catch {
        return select(null);
      }
    }
  };
  spindle.registerMacro(definition);
}
registerMacro("party_game_state", "The current party game's state block for this chat, or nothing when no game is running. Turn off automatic injection in the Party Games panel if your preset places this itself.", "string", (block) => block ?? "");
registerMacro("party_game_active", "True when a party game is running in this chat.", "boolean", (block) => block ? "true" : "false");
var COMMANDS = [
  { id: "next", label: "Party Games: Next action", description: "Draw, finish the card, or pass the turn, whichever comes next.", keywords: ["party", "game", "draw", "next", "turn"], scope: "chat" },
  { id: "undo", label: "Party Games: Undo last action", description: "Take back the most recent game action in this chat.", keywords: ["party", "game", "undo"], scope: "chat" }
];
spindle.commands.register(COMMANDS);
spindle.commands.onInvoked(async (commandId, context, origin) => {
  const userId = origin?.userId;
  const chatId = context.chatId;
  const toastOptions = userId ? { title: "Party Games", userId } : { title: "Party Games" };
  if (!chatId) {
    spindle.toast.warning("Open a chat to play.", toastOptions);
    return;
  }
  try {
    if (commandId === "next") {
      const outcome = await service(userId).next(chatId);
      spindle.toast.success(outcome.summary || "Done.", toastOptions);
      notifyChanged(chatId, "act", userId);
    } else if (commandId === "undo") {
      await service(userId).undo(chatId);
      spindle.toast.info("Undid the last action.", toastOptions);
      notifyChanged(chatId, "undo", userId);
    }
  } catch (error) {
    spindle.toast.warning(errorMessage3(error), toastOptions);
  }
});
spindle.permissions.onChanged(() => {
  syncInterceptor();
  notifyChanged(null, "permissions");
});
spindle.log.info(LOG_PREFIX + "backend ready");
