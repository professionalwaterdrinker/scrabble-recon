// Works out what each player must have held at each turn of a reconstructed game.
//
// Assumes a standard 100-tile set, every player starting with 7 tiles, no passes
// or exchanges, and that the reconstructed order is the real one. After each play
// a player draws as many tiles as they played (or what's left in the bag). From
// that bookkeeping alone:
//  - the tiles played on a turn were on the rack that turn;
//  - if later plays use more tiles than were drawn in between, the difference was
//    already on the rack ("at least n of these");
//  - once the bag is empty nothing new arrives, so everything played later, and
//    whatever is left at the end, was already there.

export const DIST = { A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1, '?': 2 };
const RACK = 7;

// tile: { ch: 'A'..'Z' or '?', as: letter a blank stood for (blanks only), move: index it was played on }
const tileAt = (cells, blanks, i, move) => blanks.has(i) ? { ch: '?', as: cells[i], move } : { ch: cells[i], move };

// Tiles not on the board: in the bag or still on racks when the photo was taken.
export function unseenTiles(cells, blanks) {
  const left = { ...DIST };
  cells.forEach((ch, i) => { if (ch) left[blanks.has(i) ? '?' : ch]--; });
  const out = [];
  for (const ch of Object.keys(DIST)) for (let n = 0; n < Math.max(0, left[ch]); n++) out.push({ ch });
  return out;
}

export function deduceRacks(moves, cells, blanks, players) {
  const info = [];
  let bag = Math.max(0, 100 - RACK * players);
  const size = Array(players).fill(RACK);
  moves.forEach((m, g) => {
    const p = m.player, k = m.tiles.length;
    const d = Math.min(k, bag);
    info.push({ player: p, size: size[p], k, bagBefore: bag, drew: d, over: k > size[p] });
    bag -= d;
    size[p] = size[p] - k + d;
  });
  const unseen = unseenTiles(cells, blanks);
  const bagEnd = bag, finalSize = size.slice();

  // Who still held which tiles at the end, when that's knowable.
  const finalRack = Array(players).fill(null);
  if (bagEnd === 0) {
    finalSize.forEach((f, p) => { if (f === 0) finalRack[p] = []; });
    const holders = finalSize.map((f, p) => f > 0 ? p : -1).filter(p => p >= 0);
    // With the bag empty, every tile not on the board is on someone's rack.
    if (holders.length === 1 && finalSize[holders[0]] === unseen.length) finalRack[holders[0]] = unseen;
  }

  const own = Array.from({ length: players }, () => []);
  moves.forEach((m, g) => own[m.player].push(g));

  const racks = moves.map((m, g) => {
    const r = info[g], p = r.player, seq = own[p], t = seq.indexOf(g);
    const played = m.tiles.map(i => tileAt(cells, blanks, i, g));
    const later = seq.slice(t + 1);
    const laterTiles = later.flatMap(h => moves[h].tiles.map(i => tileAt(cells, blanks, i, h)));
    const room = r.size - r.k;

    // Fewest tiles from later plays that must already be here.
    let need = 0, upTo = -1, cumK = 0, cumD = 0;
    later.forEach((h, j) => {
      cumD += info[seq[t + j]].drew;     // drawn after this player's previous turn
      cumK += moves[h].tiles.length;
      if (cumK - cumD > need) { need = cumK - cumD; upTo = j; }
    });
    need = Math.min(need, room);
    const allLater = laterTiles.length > 0 && need >= laterTiles.length;
    const kept = allLater ? laterTiles : [];
    const group = !allLater && need > 0
      ? { need, from: later.slice(0, upTo + 1).flatMap(h => moves[h].tiles.map(i => tileAt(cells, blanks, i, h))) }
      : null;

    // Tiles never played (still held at the end) that must already be here.
    const drawsFromNow = seq.slice(t).reduce((s, h) => s + info[h].drew, 0);
    const leftNeed = Math.max(0, Math.min(room - need, finalSize[p] - drawsFromNow));
    const fr = finalRack[p];
    const left = fr && leftNeed > 0 && leftNeed === fr.length ? fr : [];
    const leftGroup = fr && leftNeed > 0 && leftNeed < fr.length ? { need: leftNeed, from: fr } : null;
    const leftUnknown = !fr ? leftNeed : 0;

    const known = played.length + kept.length + (group ? group.need : 0) + left.length + (leftGroup ? leftGroup.need : 0) + leftUnknown;
    return {
      player: p, size: r.size, bagBefore: r.bagBefore, drew: r.drew, over: r.over,
      played, kept, group, left, leftGroup, leftUnknown,
      unknown: Math.max(0, r.size - known),
    };
  });

  // End-of-game adjustment: the player who went out gains the value of what the others still hold.
  let endgame = null;
  const last = moves.length - 1;
  if (last >= 0 && bagEnd === 0) {
    const out = moves[last].player;
    if (finalSize[out] === 0 && finalRack.every(Boolean)) {
      endgame = { out, left: finalRack.map(t => t.slice()) };
    }
  }
  return { racks, bagEnd, finalSize, finalRack, unseen, endgame };
}
