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

// src/dom.ts
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

// src/engine/rng.ts
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

// src/engine/core.ts
class IllegalActionError extends Error {
  constructor(message) {
    super(message);
    this.name = "IllegalActionError";
  }
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
  return state.status === "active" ? "Turn order" + reversed + ", from the current player: " + names.join(" → ") + "." : "Players: " + state.players.map((player) => player.name).join(", ") + ".";
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
function defaultOptions() {
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
function normalizeOptions(raw) {
  const source = isRecord(raw) ? raw : {};
  const base = defaultOptions();
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
var PHASES = {
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
function setup(players, options, rng) {
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
function legalActions(state) {
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
function apply(input, action, rng) {
  const state = cloneState(input);
  switch (action.type) {
    case "choose": {
      requirePhase(state, PHASES, ["choose"], action);
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
      requirePhase(state, PHASES, ["prompt"], action);
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
      requirePhase(state, PHASES, ["prompt"], action);
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
      requirePhase(state, PHASES, ["end_turn"], action);
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
      return unknownAction(state, PHASES, action);
  }
}
function promptBlock(state) {
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
  return formatBlock("Truth or Dare — turn " + String(state.turn.number), lines);
}
function view(state) {
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
    const suffix = prompt.outcome === "done" ? " — done" : prompt.outcome === "refused" ? " — refused" : "";
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
    phaseLabel: PHASES[state.phase] ?? state.phase,
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
  phases: PHASES,
  defaultOptions,
  normalizeOptions,
  setup,
  legalActions,
  apply,
  promptBlock,
  view
};

// src/frontend-options.ts
function renderGameOptions(draft, kit) {
  if (draft.gameId === "kings_cup")
    return kingsCupOptions(draft, kit);
  if (draft.gameId === "truth_or_dare")
    return truthOrDareOptions(draft, kit);
  return [];
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
      const select = el("select", { class: "pg-select", "aria-label": rank + " effect", title: "What drawing this card asks of the drawer" });
      for (const option of EFFECTS) {
        if (option === "kings_cup")
          continue;
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
function kingsCupOptions(draft, kit) {
  const fourthKing = el("input", { type: "checkbox", checked: draft.options.endOnFourthKing !== false });
  fourthKing.addEventListener("change", () => {
    draft.options.endOnFourthKing = fourthKing.checked;
  });
  const rules = draft.options.rules ?? (draft.options.rules = structuredClone(DEFAULT_RULES));
  return [
    el("section", { class: "pg-section" }, el("h3", { text: "House rules" }), el("label", { class: "pg-check" }, fourthKing, el("span", { text: "The 4th King ends the game (otherwise play until the deck runs out)" }))),
    kit.collapsible("setup-rules", "Card rules", el("p", { class: "pg-muted", text: "What each card means in this game. {drawer} is replaced with the drawing player's name." }), renderRuleRows(rules), el("div", { class: "pg-actions" }, kit.button("Save as my default", () => kit.saveDefaults(draft.gameId, "Kings Cup", draft.options), { small: true }), kit.button("Reset to standard rules", () => {
      draft.options.rules = structuredClone(DEFAULT_RULES);
      kit.render();
    }, { small: true })))
  ];
}
var REFUSAL_LABELS = {
  free: "Nothing happens",
  forfeit: "They pay a forfeit",
  strikes: "They get a strike"
};
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function truthOrDareOptions(draft, kit) {
  const options = draft.options;
  const tiers = new Set(stringList(options.tiers));
  const disabled = new Set(stringList(options.disabled));
  const poolSummary = el("p", { class: "pg-muted pg-pool" });
  const updatePool = () => {
    const normalized = truthOrDare.normalizeOptions(options);
    const truths = promptPool(normalized, "truth").length;
    const dares = promptPool(normalized, "dare").length;
    poolSummary.textContent = truths + dares === 0 ? "No prompts selected: turn on an intensity or add your own." : "This game plays with " + String(truths) + " truth" + (truths === 1 ? "" : "s") + " and " + String(dares) + " dare" + (dares === 1 ? "" : "s") + ".";
    poolSummary.classList.toggle("bad", truths + dares === 0);
  };
  updatePool();
  const tierRows = TIERS.map((tier) => {
    const box = el("input", { type: "checkbox", checked: tiers.has(tier) });
    box.addEventListener("change", () => {
      if (box.checked)
        tiers.add(tier);
      else
        tiers.delete(tier);
      options.tiers = TIERS.filter((entry) => tiers.has(entry));
      kit.render();
    });
    return el("label", { class: "pg-check" }, box, el("span", {}, el("b", { text: TIER_LABELS[tier].label }), " — " + TIER_LABELS[tier].description));
  });
  const refusals = ["free", "forfeit", "strikes"].includes(options.refusals) ? options.refusals : "forfeit";
  const refusalSelect = el("select", { class: "pg-select", "aria-label": "When someone refuses" });
  for (const rule of ["free", "forfeit", "strikes"]) {
    refusalSelect.append(el("option", { value: rule, selected: refusals === rule, text: REFUSAL_LABELS[rule] }));
  }
  refusalSelect.addEventListener("change", () => {
    options.refusals = refusalSelect.value;
    kit.render();
  });
  let refusalDetail = null;
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
  const customArea = (key, label, placeholder) => {
    const area = el("textarea", { class: "pg-input pg-textarea wide", rows: "4", placeholder, "aria-label": label });
    area.value = stringList(options[key]).join(`
`);
    area.addEventListener("input", () => {
      options[key] = area.value.split(`
`);
      updatePool();
    });
    return el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: label }), area);
  };
  const bundledList = (title, prompts) => {
    const list = el("div", { class: "pg-prompts" });
    for (const prompt of prompts) {
      const box = el("input", { type: "checkbox", checked: !disabled.has(prompt.id) });
      box.addEventListener("change", () => {
        if (box.checked)
          disabled.delete(prompt.id);
        else
          disabled.add(prompt.id);
        options.disabled = [...disabled];
        updatePool();
      });
      list.append(el("label", { class: "pg-check pg-prompt" + (tiers.has(prompt.tier) ? "" : " off") }, box, el("span", {}, el("span", { class: "pg-badge", text: TIER_LABELS[prompt.tier].label }), " " + prompt.text)));
    }
    return el("div", {}, el("h4", { class: "pg-subhead", text: title }), list);
  };
  return [
    el("section", { class: "pg-section" }, el("h3", { text: "Intensity" }), ...tierRows),
    el("section", { class: "pg-section" }, el("h3", { text: "Refusing" }), el("label", { class: "pg-field" }, el("span", { class: "pg-label", text: "When someone refuses a truth or dare" }), refusalSelect), refusalDetail),
    kit.collapsible("tod-custom", "Your own truths and dares", el("p", { class: "pg-muted" }, "One per line. They are always in the game, whatever the intensity. ", el("span", { class: "pg-code", text: "{player}" }), " is whoever is taking the turn; ", el("span", { class: "pg-code", text: "{other}" }), " is another player picked at random."), customArea("customTruths", "Truths", "What is the strangest thing {other} has ever said to you?"), customArea("customDares", "Dares", "Let {other} pick your next line of dialogue.")),
    kit.collapsible("tod-bundled", "Bundled prompts", el("p", { class: "pg-muted", text: "Untick any you never want to come up. Prompts from intensities you have turned off are greyed out." }), bundledList("Truths", BUNDLED_TRUTHS), bundledList("Dares", BUNDLED_DARES)),
    el("section", { class: "pg-section" }, poolSummary, el("div", { class: "pg-actions" }, kit.button("Save as my default", () => kit.saveDefaults(draft.gameId, "Truth or Dare", options), { small: true }), kit.button("Reset to standard settings", () => {
      draft.options = truthOrDare.defaultOptions();
      kit.render();
    }, { small: true })))
  ];
}

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
  ".pg-textarea{grid-column:2 / span 2;width:100%;min-height:46px;resize:vertical;line-height:1.35}.pg-textarea.wide{grid-column:auto}",
  ".pg-subhead{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:" + MUTED + ";margin:12px 0 4px}",
  ".pg-prompts{display:grid;gap:2px}.pg-prompt{margin:0;padding:4px 0}.pg-prompt.off{opacity:.45}.pg-prompt .pg-badge{margin-right:2px}",
  ".pg-pool{margin:0}.pg-pool.bad{color:#ef8b8b}",
  ".pg-actions.first{margin-top:0}.pg-notes{margin:8px 0 0;padding-left:18px;color:" + MUTED + ";font-size:12px}.pg-notes b{font-weight:600}",
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
function setup2(ctx) {
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
    const kit = {
      button,
      collapsible,
      render,
      saveDefaults: (gameId, gameName, options) => {
        run("save-defaults", { gameId, options }).then((ok) => {
          if (ok) {
            info = "Saved. New " + gameName + " games start with these settings.";
            render();
          }
        });
      }
    };
    const gameOptions = renderGameOptions(draft, kit);
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
    ];
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
    const actionButton = (action, values, key) => {
      const missing = missingField(action, values);
      const blocked = missing && missing.kind !== "text" ? missing : null;
      return button(action.label, () => {
        const unfilled = missingField(action, values);
        if (unfilled) {
          error = "Fill in “" + unfilled.label + "” first.";
          render();
          return;
        }
        run("act", { action: buildAction(action, values) }).then((ok) => {
          if (ok)
            actionValues.delete(key);
        });
      }, { primary: Boolean(action.primary), disabled: Boolean(blocked), title: blocked ? "Choose " + blocked.label.toLowerCase() + " first" : action.description });
    };
    const simple = [];
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
      section.append(el("div", { class: "pg-action" }, action.description ? el("p", { class: "pg-muted", text: action.description }) : null, ...(action.fields ?? []).map((field) => renderField(field, values)), el("div", { class: "pg-actions" }, actionButton(action, values, key))));
    }
    if (simple.length) {
      const notes = simple.filter((action) => action.description);
      section.append(el("div", { class: "pg-action" }, el("div", { class: "pg-actions first" }, ...simple.map((action) => actionButton(action, {}, ""))), notes.length ? el("ul", { class: "pg-notes" }, ...notes.map((action) => el("li", {}, simple.length > 1 ? el("b", { text: action.label + ": " }) : null, action.description ?? ""))) : null));
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
  setup2 as setup
};
