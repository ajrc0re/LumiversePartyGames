# Party Games for Lumiverse

Play party games inside a Lumiverse chat. The extension deals the cards, tracks whose turn it is, and keeps score; the model only narrates what happened.

**Available now:** Kings Cup. **Coming next:** Never Have I Ever, Truth or Dare.

## How to play

1. Open a chat and open the **Party Games** tab in the drawer.
2. Pick a game. The players default to your persona and the chat's characters (group members in a group chat); rename, reorder, add, or remove seats as you like.
3. Start the game. Use **Draw a card**, then finish the card (pick a mate, record a rule, and so on), then **Next turn**.
4. Send messages or generate replies between actions as usual. Every generation gets a short block describing the current game state, so the model narrates the draw you made instead of inventing its own.

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

The deck is shuffled once when the game starts and is drawn without replacement, so no card repeats. You can turn off "the 4th King ends the game" to play through the whole deck.

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
