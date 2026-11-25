# Party Games for Lumiverse

Play party games inside a Lumiverse chat. The extension deals the cards, tracks whose turn it is, and keeps score; the model only narrates what happened.

**Available now:** Kings Cup, Truth or Dare. **Coming next:** Never Have I Ever.

## How to play

1. Open a chat and open the **Party Games** tab in the drawer.
2. Pick a game and list the **participants**. Leave **Include {{user}}** on to seat your persona first, then type each character's name (press Enter to add the next field). A single card that plays several characters is fine: list each of them by name.
3. Choose the **turn order**: as listed, or random (shuffled once when the game starts).
4. Start the game. Use **Draw a card**, then finish the card (pick a mate, record a rule, and so on), then **Next turn**.
5. Send messages or generate replies between actions as usual. Every generation gets a short block describing the current game state, so the model narrates the draw you made instead of inventing its own.

If play suddenly goes the other way, tick **Reverse turn order** under the current turn; untick it to go back. Undo and swipes cover it like any other action.

Shortcuts: the **Extras** menu on the input bar has a Party Games button that performs the next step when it needs no choice (otherwise it opens the panel), and the command palette has **Party Games: Next action** and **Party Games: Undo last action**.

## Kings Cup rules

| Card | Rule |
|---|---|
| A | Waterfall |
| 2 | You: the drawer picks someone to drink |
| 3 | Me: the drawer drinks |
| 4 | Floor |
| 5 | Guys |
| 6 | Chicks |
| 7 | Heaven |
| 8 | Mate: the drawer picks a mate for the rest of the game |
| 9 | Rhyme |
| 10 | Categories |
| J | Make a Rule |
| Q | Question Master, until the next Queen |
| K | King's Cup: the first three Kings pour into the cup; the 4th King drinks it and ends the game |

These are the standard rules. Open **Card rules** to change any card's name, its rule text (`{drawer}` becomes the drawing player's name), and what it asks of the drawer: nothing, pick who drinks, pick a mate, add a rule, or become Question Master. Kings always count toward the King's Cup.

- At setup, edits apply to the game you are about to start. **Save as my default** keeps them for every new Kings Cup game; **Reset to standard rules** brings the table back.
- During a game, the same editor changes the rules from now on. The change is recorded like any action, so Undo and swipes cover it.

The deck is shuffled once when the game starts and is drawn without replacement, so no card repeats. You can turn off "the 4th King ends the game" to play through the whole deck.

## Truth or Dare

The game only keeps track of who is asking and who is answering; the truths, the dares, and whether the player picks truth or dare are up to the roleplay.

1. When the game starts it picks a random **asker** and a random **player** to answer.
2. The asker asks the player "Truth or dare?", and the player picks one and answers it or does it in the story.
3. Press **Next round**. The player becomes the new asker, and the game picks someone else at random to answer.

The panel shows who is **Asking** and who is **Answering**, and the model is told the same. When you are the one asking or answering, the model is told not to decide for you. Each round's random pick is fixed when the game starts, so undoing a round or swiping back and redoing it brings up the same player. There is no fixed seat order, so the turn order setting and the reverse toggle do not apply.

## Swipes, deletes, and undo

Game actions are stored with the chat and tied to the message they came after:

- **Regenerating or swiping a reply** that came after an action keeps the action. Swiping the narration of a draw never deals a new card.
- **Swiping or deleting the message an action came after** rolls the game back to before that action. Swiping back brings it back.
- Drawing again after a rollback deals the same card, because the deck order is fixed when the game starts.
- **Undo last action** takes back the most recent action explicitly.

## Prompt placement

By default the state block is inserted as a system message just before the newest message (depth 1). In the panel's **Settings** you can change the depth or turn automatic injection off and place it yourself with these macros:

- `{{party_game_state}}`: the state block, or nothing when no game is running.
- `{{party_game_active}}`: `true` while a game is running.

## Permissions

| Permission | Used for |
|---|---|
| `chats` | Saving the game in the chat's metadata |
| `chat_mutation` | Reading the chat's messages and swipes so the game follows swipes and deletes |
| `interceptor` | Adding the game state to each generation |

Without `interceptor` the game still works and the state is available through `{{party_game_state}}`.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

The engine (`src/engine`, `src/games`) is pure TypeScript with no Spindle dependency. See `AGENTS.md` for conventions and `PLAN.md` for the roadmap.
