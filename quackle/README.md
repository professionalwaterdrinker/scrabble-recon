# Quackle engine for Tile Rewind

This folder builds [Quackle](https://github.com/quackle/quackle), an open-source crossword-game AI, into WebAssembly so Tile Rewind can analyse moves in the browser.

- `bridge.cpp` replays a reconstructed game into a Quackle position and returns Quackle's best plays for a rack, as JSON.
- `build.sh` builds Quackle's dictionary tools, turns the ENABLE word list (`data/words.txt`) into Quackle's DAWG and GADDAG files, and compiles the engine plus the bridge with Emscripten.
- `.github/workflows/quackle.yml` runs the build on GitHub and publishes `quackle.js`, `quackle.wasm` and `quackle.data` to the `quackle-build` branch.

The engine uses Quackle's English strategy files (`default_english`) for leave values. It does not use the NWL or Collins word lists that ship with Quackle, which carry their own copyright terms.

## Licence

Quackle is free software under the GNU General Public License, version 3 or later, © Jason Katz-Brown, John O'Laughlin, John Fultz and contributors. Tile Rewind is released under the same licence. The source for everything in the build is in this repository and in Quackle's repository at the commit named in the workflow.
