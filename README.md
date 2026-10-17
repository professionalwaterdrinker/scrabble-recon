# Tile Rewind

Photograph a finished Scrabble board and get the game back, move by move.

1. **Read the photo.** By default this runs free on your own device: you drag four corners onto the grid, and the app straightens the photo, finds the tiles and reads each letter. Nothing is uploaded. There's also an optional Claude API mode for difficult photos. Either way, squares that couldn't be read clearly are flagged.
2. **Check the board.** Fix misreads in a built-in editor. It flags words that aren't in the word list, tiles that don't connect, and letters that appear more often than a real set allows.
3. **Rebuild the game.** A solver works backwards from the final board, peeling off one legal play at a time so every earlier position is a valid board made of real words. It tries many orders and keeps the one that reads most like a real game.
4. **Replay.** Step through the moves with standard notation (`8H`, `H8`), the words each move formed, scores with premium squares and 50-point bingos, and running totals per player.

5. **Racks.** For each move, the app shows what the player must have held. The tiles they played are certain. "At least n of these" groups show tiles that had to be on the rack already, because the player's later plays used more tiles than they drew in between. Once the bag runs out, everything they play later was already there. Anything else shows as "?". It also tracks the bag count, and when one player uses their last tile with the bag empty, it adds the standard end-of-game adjustment to the scores.

A finished board doesn't record the order of play, so the result is *one* order that fits every word. **Try another order** looks for a different one. The rack deductions follow that order and assume a standard 100-tile set with no passes or exchanges.

## Running it

It's a static site with no build step. Serve the folder with any web server:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight from disk won't work, because the web worker and word list are loaded with `fetch`.

### Reading photos

There are two ways to read a photo. Choose one under **Step 1**.

**On this device (default, free).** [`js/localreader.js`](js/localreader.js) does the whole job in the browser, with no account and no upload:

1. You drag four dots onto the outer corners of the 15 × 15 grid. A yellow grid overlay shows when they line up, and the yellow dot marks A1.
2. The photo is straightened with a perspective transform, so a photo taken at a slight angle still works.
3. Squares holding tiles are found by colour: they share one light background and carry a dark letter.
4. Each letter is matched by shape against reference letters drawn in common fonts. The clearest tiles then become templates for the rest, so the matcher adapts to your set's typeface. The small point value is ignored.
5. Letters that leave a word outside the word list are retried with their next-best match.

On synthetic test boards this read 82 of 82, 87 of 87 and 81 of 82 tiles in under a second. Real photos are harder, because glare, shadows, strong angles, unusual tile fonts and blank tiles cause misreads. That's why the result lands in the board editor for checking, with uncertain squares marked.

**Claude API (optional).** This mode is more forgiving of difficult photos and needs no corner placement. It calls the Claude API directly from the browser, using a key each person enters in the app (**Set API key**). The key is kept only in that browser's local storage and is sent only to `api.anthropic.com`. Get a key at <https://console.anthropic.com/settings/keys>; setting a spending limit on it is a good idea. One photo usually costs a few cents. The model is `claude-opus-5-5`, set in [`js/vision.js`](js/vision.js). The request uses adaptive thinking, structured JSON output, and the API's server-side fallback in case of a refusal.

Editing, rebuilding and replaying work with either mode, or with no photo at all: you can type a board in by hand or paste it as text.

## Publishing on GitHub Pages

The repository includes a workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) that publishes the site on every push to `main`.

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow from the **Actions** tab). The site appears at `https://<your-user>.github.io/<repo-name>/`.

All paths are relative, so the site works from a project subfolder like that.

### Installing it as an app

Tile Rewind is a progressive web app: on a phone, open the site and choose **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome). The app shell and word list are cached, so the editor, the solver and the on-device photo reader all work offline. Only the Claude API mode needs a connection. The service worker only runs over HTTPS, so it is skipped on `localhost`.

When you change any file listed in [`sw.js`](sw.js), bump `VERSION` there so installed copies pick up the update.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | Page markup |
| `css/style.css` | Styles, with light and dark themes |
| `js/app.js` | Board editor, checks, scoring, replay |
| `js/solver.js` | Web worker that reconstructs the move order |
| `js/racks.js` | Works out each player's rack and the bag at every turn |
| `js/localreader.js` | Free on-device photo reader: corner picker, perspective correction, tile detection, letter matching |
| `js/vision.js` | Optional Claude API photo reader |
| `data/words.txt` | ENABLE word list (public domain) plus a few common two-letter additions (QI, ZA, KI, OK, …) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install metadata |
| `tools/gen_sample.py` | Script that simulated the built-in sample game |
| `tools/make-icons.ps1` | Redraws the PNG icons in `icons/` (Windows PowerShell) |

## Board text format

**Edit as text** and **Copy as text** use 15 lines of 15 characters: an uppercase letter is a tile, a lowercase letter is a blank, and `.` is an empty square.

## Notes

- Scrabble is a trademark of Hasbro in the US and Canada and of Mattel elsewhere. This project is not affiliated with either.
- Scores assume Player 1 moved first. The end-of-game adjustment is added only when the rebuilt game shows who used their last tile, so reconstructed totals can differ from the real score sheet.
