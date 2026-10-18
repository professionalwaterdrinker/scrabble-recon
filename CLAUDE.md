# Mabble: notes for Claude

Mabble is a static web app (no build step, no server) at
https://professionalwaterdrinker.github.io/scrabble-recon/, from the GitHub repo
`professionalwaterdrinker/scrabble-recon` (public, GPLv3). It reads a photo of a
finished Scrabble board, rebuilds the game move by move, analyses moves with Quackle
(WebAssembly), and has Practice and Study modes. README.md describes every feature
for users; this file is how to work on it.

## Rules the owner has set

- **Commits:** leave the untracked `app/` and `dict/` folders out. Stage files by name, never `git add -A` at the top level.
- **Pushing:** never push without the owner's go-ahead in the current request.
- **CSW24 / Collins:** never commit or bundle it (copyright). People load their own copy, which stays in their browser's IndexedDB.
- **Checking pushes:** after a push, verify on the live site (see below) and report what was checked.
- **Live-site data:** the owner's browser data on the live site (saved Practice game, skin, Study history) must be left as it was. Back it up before testing and restore it after.
- **Commit messages:** end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Layout

| Path | What |
|---|---|
| `index.html` | All markup. An inline script in `<head>` applies the saved skin (`data-skin`) and effects level (`data-fx`) before the page draws. |
| `css/style.css` | One stylesheet. Classic skin first, then sections scoped as `:root[data-skin="brute"]` (Poster), `:root[data-skin="felt"]` (Felt, Balatro-inspired, always dark), then `:root[data-fx=...]` effects at the end. |
| `js/app.js` | Board editor, rebuild (via `js/solver.js` worker), replay, racks, Quackle wiring (`QK`), word list (`LEX`, `DICT`), skins (`SKINS`), effects (`FX`), mode switching (`setMode`). |
| `js/solver.js` | Worker: peels plays off the final board, then picks the most realistic order (wasted-points movegen, bingo protection, annealing, optional final-score targets). |
| `js/localreader.js` | On-device photo reader (letter blobs on tile-coloured areas, grid fit, blanks). |
| `js/practice.js` | Practice: game state `G`, moves, Quackle reviews, live equity panel, bots (MoBot/ThantBot/CinBot = ids `basic`/`better`/`stee`), Felt tile bag and deal animation. |
| `js/study.js`, `js/study-lists.js`, `js/vault.js` | Study tab: lists built from the active word list, flashcard sessions (typed/flip, skip, word-count progress), Leitner scheduling, history, Wiktionary definitions. |
| `js/quackle-worker.js`, `js/simulate.js`, `js/explain.js` | Quackle engine worker, simulation pool, "why is Quackle's play better" facts. |
| `quackle/bridge.cpp` | C++ bridge compiled into the engine. Text in (`players/move/hold/rack/actual/top`), JSON out. |
| `tools/reader-bench.html`, `tools/rebuild-bench.html` | Test benches for the photo reader and the rebuild (open via the local server). |
| `sw.js` | Offline cache. **Bump `VERSION` (`mabble-vNN`) whenever a file in its SHELL list changes**, and add new JS files to SHELL. |

## Engine and deploys

- **Engine build:** `.github/workflows/quackle.yml` builds Quackle to WebAssembly and publishes it to the `quackle-build` branch, when `quackle/**` changes.
- **Site deploy:** `pages.yml` deploys the site and unpacks the engine into `engine/` (not in Git). It also redeploys after each engine build.
- **Bridge changes:** changing `quackle/bridge.cpp` means a push, an engine rebuild (several minutes), then a redeploy.

## Storage keys (keep the old `tilerewind.*` names, they hold existing user data)

- **localStorage:**
  - `tilerewind.board` (board draft + final scores)
  - `tilerewind.practice` (Practice game)
  - `mabble.skin`, `mabble.fx`
  - `mabble.studyMode`, `mabble.practiceMode`
  - `mabble.practiseRanges`, `mabble.practiseShuffle`, `mabble.practiceOpp`
- **IndexedDB:**
  - `tilerewind` / `kv` (loaded word list)
  - `mabble-study` / `kv` (`vault:<list>` review data and history, `def2:<WORD>` definitions)

## Testing locally

- **Local server:** a Python `http.server` on http://localhost:8766 serves the repo root (start one with `py -m http.server 8766` from the repo if it's not running).
- **Stale files:** the service worker and HTTP cache serve old files. Before testing, unregister service workers, clear caches and `fetch(file, {cache: 'reload'})` the changed files, then reload.
- **Test in the browser pane:** drive the app with `javascript_tool`. For Practice moves, use the hidden `.kbd-input` with keyboard events (arrow keys to steer the cursor, then letters). Clicking squares from scripts is unreliable.
- **Hidden pane:** when the browser pane is hidden it throttles `requestAnimationFrame` and screenshots lag. Rely on DOM/computed-style measurements, and say when something visual couldn't be checked.
- **Coverage:** check all three skins (the Skin button cycles them), dark mode and phone width (no horizontal scroll), and that the console has no errors.

## Checking a push on the live site

1. **Wait for the deploy:** poll `https://professionalwaterdrinker.github.io/scrabble-recon/sw.js?x=N` until it shows the new `mabble-vNN` (PowerShell loop; `gh` isn't on PATH in bash).
2. **Load the new version:** open the site, reload once so the new service worker takes over, and confirm `caches.keys()` shows the new version.
3. **Protect the owner's data:** back up any keys or IndexedDB entries the test will touch (`sessionStorage` survives reloads), test, wait for bots, reviews and saves to finish, then restore and reload.

## Working conventions

- **Code style:** plain ES modules, no frameworks or bundlers. Match the existing comment style: short comments explaining why, not what.
- **New CSS:** classic rules go before the `/* poster-only decorations stay hidden in the classic skin */` marker; skin-scoped rules go at the end (before the EFFECTS section if they must not override it).
- **Motion:** looping animations must be stepped (`steps(1, end)`) in Standard, none in Battery saver, and respect `prefers-reduced-motion`.
- **Large file edits:** in the Bash tool, long heredocs with quotes often fail to parse. Write a Python script with the Write tool and run it with `py`.
- **Writing for the owner:** keep explanations plain and avoid jargon. Report results honestly, including what wasn't verified.
