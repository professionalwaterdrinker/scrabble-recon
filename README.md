# Mabble

Photograph a finished Scrabble board and get the game back, move by move.

1. **Read the photo.** This runs free on your own device: you drag four corners onto the grid, and the app straightens the photo, finds the tiles and reads each letter. Nothing is uploaded. Squares that couldn't be read clearly are flagged.
2. **Check the board.** Fix misreads in a built-in editor. It flags words that aren't in the word list, tiles that don't connect, and letters that appear more often than a real set allows.
3. **Rebuild the game.** A solver works backwards from the final board, peeling off one legal play at a time so every earlier position is a valid board made of real words. Many orders fit, so it picks the one a real player was most likely to make. For every play it works out the best score the same tiles could have made anywhere on the board at that point: an order where players keep ignoring much bigger spots is unlikely. Seven-tile words are kept whole as bingos. The best few orders are then polished by swapping, merging and splitting plays. If you enter the **final scores** from the score sheet, it also looks for an order whose totals match them.

   [`tools/rebuild-bench.html`](tools/rebuild-bench.html) checks this against games Quackle plays against itself. Across six such games, the rebuilt orders threw away about 30 points a game compared with the best play for the same tiles, down from about 95 before (the real games averaged about 17). About 70% of pairs of plays came out in the right order, up from 60%.
4. **Replay.** Step through the moves with standard notation (`8H`, `H8`), the words each move formed, scores with premium squares and 50-point bingos, and running totals per player.

5. **Racks.** Under the board, every player's rack is shown at every step: the player who just moved shows the rack they played from, and the others show what they're holding. The app analyses the whole game at once. It considers every order in which each player could have drawn their tiles (each tile drawn before the move that played it, as from a well-shuffled bag) and works out how likely each tile was to be on the rack at that moment.
   - **Solid tiles** are certain: they were on the rack in every possible order. That covers tiles played that turn, tiles that later plays forced onto the rack, and everything once the bag is empty.
   - **Shaded tiles** are the most likely remaining tiles, each with its chance.
   - **"?"** is a tile that player never played, in a game that wasn't finished, so it can't be named.

   It also tracks the bag count, and when one player uses their last tile with the bag empty, it adds the standard end-of-game adjustment to the scores. On simulated games, 96% of rack slots showed a letter, no "certain" tile was ever wrong, and the shown chances matched how often the tiles were really there.

A finished board doesn't record the order of play, so the result is *one* order that fits every word. **Try another order** looks for a different one. The rack deductions follow that order and assume a standard 100-tile set with no passes or exchanges.

## Running it

It's a static site with no build step. Serve the folder with any web server:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight from disk won't work, because the web worker and word list are loaded with `fetch`.

### Reading photos

[`js/localreader.js`](js/localreader.js) reads the photo in the browser, with no account and no upload:

1. You drag four dots onto the outer corners of the 15 × 15 grid. A yellow grid overlay shows when they line up, and the yellow dot marks A1.
2. The photo is straightened with a perspective transform, so a photo taken at a slight angle still works.
3. Tiles are found where they actually sit, not where the grid says. The reader learns the tile face colour, finds the letters printed on tile-coloured areas, fits how the grid lies under them (which also absorbs slightly misplaced corners), and gives each letter its nearest free square. Blanks are tile faces with no letter next to lettered tiles, at most two.
4. Each letter is matched by shape against reference letters drawn in common fonts. The clearest tiles then become templates for the rest, so the matcher adapts to your set's typeface. The small point value is ignored.
5. Letters that leave a word outside the word list are retried with their next-best match.

[`tools/reader-bench.html`](tools/reader-bench.html) draws test boards with tiles knocked off their squares, tilted, photographed at an angle and JPEG-compressed, and scores the reader: it reads 99 to 100% of letters on them, in one to two seconds. Real photos are harder, because glare, shadows, strong angles, unusual tile fonts and blank tiles cause misreads. That's why the result lands in the board editor for checking, with uncertain squares marked.


Editing, rebuilding and replaying also work with no photo at all: you can type a board in by hand or paste it as text.

## Publishing on GitHub Pages

The repository includes a workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) that publishes the site on every push to `main`.

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow from the **Actions** tab). The site appears at `https://<your-user>.github.io/<repo-name>/`.

All paths are relative, so the site works from a project subfolder like that.

### Installing it as an app

Mabble is a progressive web app: on a phone, open the site and choose **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome). The app shell and word list are cached, so the editor, the solver and the on-device photo reader all work offline. Only the first download of the Quackle engine needs a connection. The service worker only runs over HTTPS, so it is skipped on `localhost`.

When you change any file listed in [`sw.js`](sw.js), bump `VERSION` there so installed copies pick up the update.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | Page markup |
| `css/style.css` | Styles, with light and dark themes |
| `js/app.js` | Board editor, checks, scoring, replay |
| `js/solver.js` | Web worker that reconstructs the move order and picks the most realistic one |
| `js/racks.js` | Works out each player's rack and the bag at every turn |
| `js/localreader.js` | Free on-device photo reader: corner picker, perspective correction, tile detection, letter matching |
| `data/words.txt` | ENABLE word list (public domain) plus a few common two-letter additions (QI, ZA, KI, OK, …) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install metadata |
| `tools/gen_sample.py` | Script that simulated the built-in sample game |
| `tools/make-icons.ps1` | Redraws the PNG icons in `icons/` (Windows PowerShell) |
| `quackle/` | Bridge and build script for the Quackle engine (WebAssembly) |
| `js/quackle-worker.js` | Runs the Quackle engine in a background worker |
| `js/simulate.js` | Runs Quackle simulations on several engine workers in parallel |
| `js/explain.js` | Facts and checklist behind "Why is Quackle's play better?" |
| `js/practice.js` | Practice mode: rules, scoring, rack input and Quackle reviews |
| `js/study.js` | Study tab: word-list browser and flashcard review screens |
| `js/study-lists.js` | Builds the study lists (anagrams, probability order, stems, hooks) from the active word list |
| `js/vault.js` | Spaced-review scheduling and storage, and Wiktionary definitions |
| `tools/reader-bench.html`, `tools/rebuild-bench.html` | Test benches for the photo reader and the game rebuild |
| `quackle-test.html` | Test bench for Quackle move analysis |
| `engine/` | The built Quackle engine. Not in Git: the deploy fetches it from the `quackle-build` branch |

## Board text format

**Edit as text** and **Copy as text** use 15 lines of 15 characters: an uppercase letter is a tile, a lowercase letter is a blank, and `.` is an empty square.

## Move analysis with Quackle

[Quackle](https://github.com/quackle/quackle), the open-source crossword-game AI, is compiled to WebAssembly so it can analyse moves in the browser. In the replay, **Load Quackle** downloads the engine and word list (about 26 MB, cached after the first time). The app then analyses every move in a background worker, using the mover's best-estimate rack:

- **The move list** gains a "vs Quackle" column: ✓ where the play was Quackle's top choice, otherwise the equity given up.
- **The analysis card** shows Quackle's top plays for the current move next to the actual play, with score, equity and the tiles each play keeps. Click a play to preview it on the board.
- **A summary** gives each player's total equity given up.

Analysis is only as reliable as the rack. When the rack includes likely (not certain) tiles, the card says so, and unknown tiles are left out.

### Simulation

Static equity (score plus leave value) is quick, but it can't see openings you give the opponent or how a leave plays on this particular board. Under any analysed move, in Replay or Practice, **Simulate** runs Quackle's simulation on its top six plays plus the one you made.

- **How it works.** Each candidate is played forward one or two more turns, many times over, with random tiles for the opponent each time. The plays are then re-ranked by simulated equity, with Quackle's win estimate alongside.
- **Settings.** You choose the time (10, 30 or 60 seconds) and how far ahead to look (2 or 3 turns). The progress bar shows the playouts so far, and **Stop** ends early with the results gathered up to then.
- **Parallel engines.** Quackle's own simulator runs on threads, which a page hosted on GitHub Pages can't use. Instead, the bridge exposes Quackle's single-playout step (`qk_sim_start` and `qk_sim_step`), and `js/simulate.js` runs several engine workers side by side, one per spare CPU core (up to 4, or 2 on phones). Their results are combined.
- **Speed.** On an 8-core laptop, a 10-second run reaches about 1,400 playouts per play.

Practice racks are exact. Replay racks may be partly estimated, and the card says so when they are.

### Why Quackle's play is better (Practice)

When your move wasn't Quackle's top choice, **Explain the difference** in the review compares the two plays:

- **Points and leave:** the score now, and the tiles each play keeps. This uses Quackle's own breakdown, where equity = score + leave value + board adjustment.
- **Leave quality:** vowel balance, duplicates, a Q without a U, keeping an S or a blank, bingo-friendly letters.
- **The board:** premium squares each play opens or closes, and lines left open for a bingo.
- **The opponent's next turn:** Quackle deals the opponent 150 random racks from the tiles you can't see (in about half a second), after each play. It then compares their average best reply, and how often they score 30-plus or bingo.

Weak points are only listed when Quackle's play doesn't share them. When Quackle's play is the riskier one, the checklist says so. **Worst cases** shows the strongest replies your play allows; tap one to see it on the board in red.

### Memory

Each Quackle engine takes about 110 MB, most of it the dictionary and leave values held in engine memory. To keep that in check:

- **Shared engine.** Simulation borrows the analysis engine as one of its engines.
- **Idle shutdown.** The extra engines close a minute after a simulation ends.
- **Released file copies.** Each engine drops its copies of the data files once they're loaded, and fetches them again from the offline cache only when the word list changes.

`mabbleDebug.extraSimEngines()` in the browser console shows how many extra engines are running. `quackle-test.html` is a test bench for trying single positions by hand. See [`quackle/README.md`](quackle/README.md) for how the engine is built.

## Word list (ENABLE or your own, such as CSW24)

The built-in word list is ENABLE, a public-domain list close to the North American tournament list. Collins Scrabble Words (CSW24) is copyrighted by HarperCollins, so it isn't included here and must never be committed to this repository.

To play with CSW24 or another list, click **Words: ENABLE** in the header and load the list from a copy you're entitled to use. It needs to be a text file with one word per line; anything after the first word on a line, such as a definition, is ignored. The list then applies everywhere:
- the board check, the game rebuild and practice games
- Quackle's suggestions

For Quackle, the app builds a DAWG from your list on your device, which takes a few seconds the first time in a session. A Collins list also loads Quackle's Collins leave values. The list is saved only in that browser (IndexedDB), and is never uploaded or published. **Use ENABLE** switches back, and **Forget my list** deletes it.

## Practice mode

The **Practice** tab is an untimed game against yourself. It deals two racks from a shuffled 100-tile bag, and you play each rack in turn, while the rack not on turn stays face down.

- **Making a move.** Tap a tile and then a square, or tap a square and type. Blanks ask which letter they stand for. A live check shows whether the play is legal (one line, no gaps, connected, centre star first, every word in the word list) and what it scores.
- **Your options.** Play, Recall, Shuffle, Exchange (when the bag holds at least 7 tiles) or Pass.
- **Quackle reviews every move.** After each move, Quackle analyses the exact position and the exact rack you held, with the other rack set too so its bag matches the real one. It shows its highest-equity plays next to yours, including exchanges. Click any of them to see it on the board as it was before your move.
- **Running totals.** The move list shows how much equity each move gave up, with a total for each player.
- **The ending** follows standard rules: going out with the bag empty earns the other rack's value, and six scoreless turns in a row end the game.
- **Saved automatically.** The game is saved in your browser, so you can come back to it later.

## Skins

The **Skin** button in the header cycles through three looks. Your choice is saved in the browser:

- **Classic** (the default): calm greens with light and dark themes.
- **Poster:** black, red and blue, in the style of a Constructivist propaganda poster.
- **Felt:** a card-game table inspired by Balatro. It has swirling green felt, the Jersey 10 pixel font, chunky buttons and tiles that float like cards. In Practice, the score is shown as letter points × word multiplier, plus any crossing words and the 50-point bingo bonus. Felt is always dark.

Each skin's fonts load from Google Fonts only the first time you choose it. Animations stop when your system asks for reduced motion.

## Study

The **Study** tab is for learning words, in the spirit of Aerolith's Wordwalls and WordVault but simpler.

**Word lists.** Curated lists worked out from the active word list, in your browser:
- **Must-know:** two-letter words, three-letter words and short J, Q, X and Z words.
- **Bingos:** the 500 most likely seven- and eight-letter words (by how often their tiles are drawn) and the best six-letter bingo stems.
- **Specialty:** vowel-heavy words and Q without U.
- **Hooks:** the letters that go before and after each two-letter word.

Each card shows the letters as tiles with a cue such as "3 words". Faint letters either side of a word are its hooks. **Hide answers** turns a list into a self-quiz, and tapping a word shows its definition. Definitions come from [Wiktionary](https://en.wiktionary.org/) (CC BY-SA). They're fetched only when you open a word, sending just that word to Wiktionary, and then saved on your device.

**Review.** Add a list and its cards join your reviews, 15 new ones a day. Answer by flipping the card or by typing every word the letters make. Grade **Again**, **Good** or **Easy**. Each Good moves a card up a box, and the wait before it comes back grows: 1, 3, 7, 14, 30, 60, then 120 days. Again brings it back in the same session. The schedule, streak and progress are kept in this browser's IndexedDB, separately for each word list.

**History.** Lists every session you finished or stopped early, with a two-week activity chart. Open a session to see which cards you missed at first. **Cards in your reviews** lists every card with its stage, when it's next due and its right and wrong counts. You can filter it (in progress, not started, learned or all) or search it. Tick cards, or **Select all**, and **Delete** to take them out of your reviews. **Undo** brings them back for a few seconds afterwards.

**Keys:** <kbd>Space</kbd> shows the answer, <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> grade it, <kbd>Enter</kbd> checks a typed word (an empty Enter shows the answer), <kbd>Esc</kbd> ends the session, <kbd>/</kbd> searches a list, <kbd>Delete</kbd> deletes the ticked cards in History and <kbd>?</kbd> lists them all.

## Licence

Mabble is free software under the [GNU General Public License, version 3](LICENSE) or later, because it includes the Quackle engine (© Jason Katz-Brown, John O'Laughlin, John Fultz and contributors, GPLv3). The ENABLE word list is in the public domain.

## Notes

- Scrabble is a trademark of Hasbro in the US and Canada and of Mattel elsewhere. This project is not affiliated with either.
- Scores assume Player 1 moved first. The end-of-game adjustment is added only when the rebuilt game shows who used their last tile, so reconstructed totals can differ from the real score sheet.
