# Tile Rewind

Photograph a finished Scrabble board and get the game back, move by move.

1. **Read the photo.** Claude (through the Claude API) transcribes every tile on the board, including blanks, and flags squares it couldn't read clearly.
2. **Check the board.** Fix misreads in a built-in editor. It flags words that aren't in the word list, tiles that don't connect, and letters that appear more often than a real set allows.
3. **Rebuild the game.** A solver works backwards from the final board, peeling off one legal play at a time so every earlier position is a valid board made of real words. It tries many orders and keeps the one that reads most like a real game.
4. **Replay.** Step through the moves with standard notation (`8H`, `H8`), the words each move formed, scores with premium squares and 50-point bingos, and running totals per player.

A finished board doesn't record the order of play, so the result is *one* order that fits every word. **Try another order** looks for a different one.

## Running it

It's a static site with no build step. Serve the folder with any web server:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight from disk won't work, because the web worker and word list are loaded with `fetch`.

### Reading photos needs a Claude API key

Photo reading calls the Claude API directly from the browser, using a key each person enters in the app (**Set API key**). The key is kept only in that browser's local storage and is sent only to `api.anthropic.com`. Get a key at <https://console.anthropic.com/settings/keys>; setting a spending limit on it is a good idea. One photo usually costs a few cents.

Everything else (editing, rebuilding, replaying) works without a key, so people can also type a board in by hand or paste it as text.

The model is `claude-opus-5-5`, set in [`js/vision.js`](js/vision.js). The request uses adaptive thinking, structured JSON output, and the API's server-side fallback in case of a refusal.

## Publishing on GitHub Pages

The repository includes a workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) that publishes the site on every push to `main`.

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow from the **Actions** tab). The site appears at `https://<your-user>.github.io/<repo-name>/`.

All paths are relative, so the site works from a project subfolder like that.

### Installing it as an app

Tile Rewind is a progressive web app: on a phone, open the site and choose **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome). The app shell and word list are cached, so the editor and solver work offline; reading photos still needs a connection. The service worker only runs over HTTPS, so it is skipped on `localhost`.

When you change any file listed in [`sw.js`](sw.js), bump `VERSION` there so installed copies pick up the update.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | Page markup |
| `css/style.css` | Styles, with light and dark themes |
| `js/app.js` | Board editor, checks, scoring, replay |
| `js/solver.js` | Web worker that reconstructs the move order |
| `js/vision.js` | Claude API call that reads a board photo |
| `data/words.txt` | ENABLE word list (public domain) plus a few common two-letter additions (QI, ZA, KI, OK, …) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install metadata |
| `tools/gen_sample.py` | Script that simulated the built-in sample game |

## Board text format

**Edit as text** and **Copy as text** use 15 lines of 15 characters: an uppercase letter is a tile, a lowercase letter is a blank, and `.` is an empty square.

## Notes

- Scrabble is a trademark of Hasbro in the US and Canada and of Mattel elsewhere. This project is not affiliated with either.
- End-of-game rack penalties aren't visible on a board, so reconstructed totals can differ from the real score sheet. Scores assume Player 1 moved first.
