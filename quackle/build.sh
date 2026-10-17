#!/usr/bin/env bash
# Builds the Quackle engine for the browser.
#
#   quackle/build.sh <quackle source folder> <output folder>
#
# Needs: cmake, ninja, Qt 6 (only for Quackle's dictionary tools) and an
# activated Emscripten SDK (em++). Produces quackle.js, quackle.wasm and
# quackle.data (the ENABLE dictionary and English strategy files).
set -euo pipefail

SRC="$(cd "$1" && pwd)"
mkdir -p "$2"
OUT="$(cd "$2" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
WORK="$(mktemp -d)"

echo "== 1. Quackle's dictionary tools (native build, uses Qt)"
cmake -S "$SRC/quacker" -B "$WORK/native" -G Ninja -DCMAKE_BUILD_TYPE=Release -DQT_VERSION=6
cmake --build "$WORK/native" --target makeminidawg makegaddag
MAKEDAWG="$(find "$WORK/native" -type f -name makeminidawg -perm -u+x | head -1)"
MAKEGADDAG="$(find "$WORK/native" -type f -name makegaddag -perm -u+x | head -1)"

echo "== 2. ENABLE word list -> DAWG and GADDAG"
# the tools read ../data/alphabets/<alphabet>.quackle_alphabet relative to where they run
mkdir -p "$SRC/work"
cd "$SRC/work"
tr -d '\r' < "$ROOT/data/words.txt" | tr 'a-z' 'A-Z' | grep -E '^[A-Z]{2,15}$' | LC_ALL=C sort -u > dawginput.raw
echo "$(wc -l < dawginput.raw) words"
cp dawginput.raw smaller.raw
: > playabilities.raw
"$MAKEDAWG"
cp dawginput.raw gaddaginput.raw
"$MAKEGADDAG"
ls -l output.dawg output.gaddag

echo "== 3. Data bundled into the browser build"
DATA="$WORK/data"
mkdir -p "$DATA/lexica" "$DATA/strategy"
cp output.dawg "$DATA/lexica/enable.dawg"
cp output.gaddag "$DATA/lexica/enable.gaddag"
cp -r "$SRC/data/strategy/default_english" "$SRC/data/strategy/default" "$DATA/strategy/"
du -sh "$DATA"/*

echo "== 4. Engine -> WebAssembly"
# libquackle's sources, as listed in Quackle's CMakeLists.txt
SOURCES=(alphabetparameters bag board boardparameters bogowinplayer catchall clock computerplayer
  computerplayercollection cputopology datamanager endgame endgameplayer enumerator evaluator game
  gameparameters generator lexiconparameters move player playerlist preendgame rack reporter resolvent
  sim strategyparameters)
FILES=()
for s in "${SOURCES[@]}"; do FILES+=("$SRC/$s.cpp"); done

em++ -std=c++17 -O2 -DNDEBUG -fexceptions -I"$SRC" "${FILES[@]}" "$HERE/bridge.cpp" \
  -o "$OUT/quackle.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createQuackle \
  -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=4194304 \
  -sEXPORTED_FUNCTIONS=_qk_init,_qk_analyse,_qk_use_lexicon,_qk_use_builtin,_qk_sim_start,_qk_sim_step -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS \
  --preload-file "$DATA@/data"

# Collins leave values, fetched by the page only when a Collins word list is in use
cp "$SRC/data/strategy/csw/superleaves" "$OUT/csw-superleaves"

ls -l "$OUT"
