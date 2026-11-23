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
  if (action.type === "set_direction" && definition.usesTurnOrder === false) {
    throw new IllegalActionError(definition.name + " has no fixed turn order to reverse.");
  }
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
var STANDING_INSTRUCTION = "This block is the authoritative game state, maintained by the game. Narrate only what it says. " + "Do not draw cards, change whose turn it is, eliminate players, or move the game to a new phase yourself; " + "the game advances only when the players use the game controls. If an action is still pending, describe the moment and leave it pending.";
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
function recentLog(state, count, noun = "Turn") {
  return state.log.slice(-count).map((entry) => noun + " " + String(entry.turn) + ": " + entry.text);
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
  usesTurnOrder: true,
  phases: PHASES,
  defaultOptions,
  normalizeOptions,
  setup,
  legalActions,
  apply,
  promptBlock,
  view
};

// src/games/truth-or-dare.ts
var PHASES2 = {
  round: "asking",
  game_over: "game over"
};
function pickPlayer(state, askerId, round) {
  const candidates = state.players.filter((player) => player.active && player.id !== askerId);
  if (!candidates.length)
    throw new Error("Truth or Dare needs someone besides the asker.");
  const rng = mulberry32(state.rollSeed + Math.imul(round, 2654435761) >>> 0);
  return candidates[randomInt(rng, candidates.length)];
}
function seatIndex(state, playerId) {
  return state.players.findIndex((player) => player.id === playerId);
}
function roundLine(state) {
  return playerName(state, state.asker) + " asks " + currentPlayer(state).name + ".";
}
function setup2(players, _options, rng) {
  const core = createCoreState(players, "round", 2);
  const rollSeed = Math.floor(rng.next() * 4294967296) >>> 0;
  const asker = core.players[randomInt(rng, core.players.length)];
  const state = { ...core, game: "truth_or_dare", asker: asker.id, rollSeed, previous: null };
  state.turn.index = seatIndex(state, pickPlayer(state, asker.id, 1).id);
  addLog(state, roundLine(state));
  return state;
}
function legalActions2(state) {
  if (state.status !== "active" || state.phase !== "round")
    return [];
  const player = currentPlayer(state);
  return [{
    type: "next_round",
    label: "Next round",
    description: player.name + " asks next; the game picks who answers.",
    primary: true
  }];
}
function apply2(input, action, _rng) {
  const state = cloneState(input);
  switch (action.type) {
    case "next_round": {
      requirePhase(state, PHASES2, ["round"], action);
      const player = requireCurrentActor(state, action);
      state.previous = { asker: state.asker, player: player.id };
      state.asker = player.id;
      state.turn.number += 1;
      state.turn.index = seatIndex(state, pickPlayer(state, player.id, state.turn.number).id);
      addLog(state, roundLine(state));
      return state;
    }
    default:
      return unknownAction(state, PHASES2, action);
  }
}
function promptBlock2(state) {
  const lines = ["Players: " + activePlayers(state).map((player) => player.name).join(", ") + "."];
  const asker = findPlayer(state, state.asker);
  const player = currentPlayer(state);
  const askerName = asker?.name ?? "Someone";
  lines.push("This round, " + askerName + " asks " + player.name + ': "Truth or dare?"');
  lines.push(player.name + " picks truth or dare, then answers the truth or does the dare. What " + askerName + " asks and what " + player.name + " does are up to the story.");
  if (asker?.kind === "user")
    lines.push(askerName + " is played by the user: let them ask; do not ask for them.");
  if (player.kind === "user")
    lines.push(player.name + " is played by the user: let them choose and answer; do not decide for them.");
  lines.push("Nobody else asks or answers this round. Afterwards " + player.name + " asks next and the game picks who answers; do not start the next round yourself.");
  if (state.previous) {
    lines.push("Last round: " + playerName(state, state.previous.asker) + " asked " + playerName(state, state.previous.player) + ".");
  }
  return formatBlock("Truth or Dare \u2014 round " + String(state.turn.number), lines);
}
function view2(state) {
  const player = currentPlayer(state);
  const askerName = playerName(state, state.asker);
  return {
    gameId: "truth_or_dare",
    gameName: "Truth or Dare",
    status: state.status,
    turnNumber: state.turn.number,
    turnNoun: "Round",
    phase: state.phase,
    phaseLabel: PHASES2[state.phase] ?? state.phase,
    currentPlayerId: player.id,
    nextPlayerId: null,
    roles: [
      { label: "Asking", playerId: state.asker },
      { label: "Answering", playerId: player.id }
    ],
    players: state.players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      active: entry.active,
      current: entry.id === player.id,
      next: false,
      badges: entry.id === state.asker ? ["Asking"] : entry.id === player.id ? ["Answering"] : []
    })),
    headline: askerName + " asks " + player.name,
    detail: "Truth or dare? What " + askerName + " asks and what " + player.name + " does are up to the story.",
    facts: [
      { label: "Next asker", value: player.name },
      { label: "Rounds played", value: String(state.turn.number - 1) }
    ],
    recent: recentLog(state, 6, "Round")
  };
}
var truthOrDare = {
  id: "truth_or_dare",
  name: "Truth or Dare",
  description: "The game picks who asks and who answers; the story decides the truths and dares. Whoever answers asks next.",
  minPlayers: 2,
  usesTurnOrder: false,
  phases: PHASES2,
  defaultOptions: () => ({}),
  normalizeOptions: () => ({}),
  setup: setup2,
  legalActions: legalActions2,
  apply: apply2,
  promptBlock: promptBlock2,
  view: view2
};

// src/engine/registry.ts
var GAMES = [kingsCup, truthOrDare];
var PLANNED = [
  { id: "never_have_i_ever", name: "Never Have I Ever", description: "Take turns confessing; lose a life for everything you have done.", minPlayers: 2, available: false, usesTurnOrder: true }
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
      available: true,
      usesTurnOrder: game.usesTurnOrder
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
