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

/* ---------- best estimate of every rack ---------- */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Earliest-deadline-first: can every tile be drawn before its deadline if tile x
// may not be drawn before position `release`? (Exact for one-at-a-time draws.)
function feasibleWithRelease(dl, x, release) {
  const n = dl.length, used = new Uint8Array(n);
  for (let pos = 0; pos < n; pos++) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (used[i] || (i === x && pos < release)) continue;
      if (best < 0 || dl[i] < dl[best]) best = i;
    }
    if (best < 0 || dl[best] <= pos) return false;
    used[best] = 1;
  }
  return true;
}

// The player's draws are modelled as a random order of all the tiles they ever
// drew (the ones they played plus whatever they held at the end), with each tile
// drawn before the move that played it. We sample those orders uniformly and
// count how often each tile was on the rack at each turn.
export function estimateRacks(moves, cells, blanks, players, ded, { samples = 1500, seed = 7 } = {}) {
  const own = Array.from({ length: players }, () => []);
  moves.forEach((m, g) => own[m.player].push(g));
  const perPlayer = own.map((seq, p) => {
    if (!seq.length) return { seq, racks: [], final: [] };
    // S[t] = how many tiles the player had drawn before their t-th move
    const S = [RACK];
    seq.forEach((g, t) => S.push(S[t] + ded.racks[g].drew));
    const tiles = [], dl = [], playedAt = [];
    seq.forEach((g, t) => moves[g].tiles.forEach(i => {
      tiles.push(blanks.has(i) ? { ch: '?', as: cells[i], move: g } : { ch: cells[i], move: g });
      dl.push(S[t]); playedAt.push(t);
    }));
    const total = S[seq.length];
    const fr = ded.finalRack[p];
    for (let k = 0; tiles.length < total; k++) {
      tiles.push(fr ? { ...fr[k], final: true } : { ch: '?', unknown: true, final: true });
      dl.push(total); playedAt.push(Infinity);
    }
    const n = tiles.length;
    // start from a valid order: earliest deadline first
    const arr = [...tiles.keys()].sort((a, b) => dl[a] - dl[b]);
    const valid = arr.every((x, pos) => pos < dl[x]);
    const counts = seq.map(() => new Float64Array(n));
    let taken = 0;
    if (valid && n > 1) {
      const rand = mulberry(seed * 131 + p * 7919 + n);
      const burn = 40 * n, thin = Math.max(4, n >> 1);
      for (let step = 0; taken < samples; step++) {
        const a = (rand() * n) | 0, b = (rand() * n) | 0;
        if (a !== b && b < dl[arr[a]] && a < dl[arr[b]]) { const tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp; }
        if (step >= burn && step % thin === 0) {
          for (let t = 0; t < seq.length; t++) {
            const c = counts[t];
            for (let pos = 0; pos < S[t]; pos++) { const x = arr[pos]; if (playedAt[x] >= t) c[x]++; }
          }
          taken++;
        }
      }
    }
    const racks = seq.map((g, t) => {
      const size = ded.racks[g].size;
      const list = [];
      for (let x = 0; x < n; x++) {
        if (playedAt[x] < t) continue;
        const now = playedAt[x] === t;
        const prob = now ? 1 : (taken ? counts[t][x] / taken : 0);
        if (prob <= 0) continue;
        list.push({ tile: tiles[x], x, prob, now });
      }
      list.sort((a, b) => (b.now - a.now) || (b.prob - a.prob) || (a.tile.unknown ? 1 : 0) - (b.tile.unknown ? 1 : 0));
      const rack = list.slice(0, size);
      // "certain" only when no valid draw order could have left the tile in the bag
      rack.forEach(r => { r.certain = r.now || (r.prob > 0.9 && !feasibleWithRelease(dl, r.x, S[t])); });
      return { g, size, tiles: rack };
    });
    const final = tiles.filter(t => t.final).map(t => ({ tile: t, prob: 1, certain: !t.unknown }));
    return { seq, racks, final };
  });

  // What every player holds once `step` moves have been played.
  function at(step) {
    const mover = step > 0 ? moves[step - 1].player : -1;
    return perPlayer.map((pp, p) => {
      if (!pp.seq.length) return { player: p, mode: 'none', tiles: [] };
      if (p === mover) {
        const t = pp.seq.indexOf(step - 1);
        return { player: p, mode: 'played', move: step - 1, ...pp.racks[t] };
      }
      const t = pp.seq.findIndex(g => g >= step);
      if (t >= 0) return { player: p, mode: 'holding', ...pp.racks[t] };
      return { player: p, mode: 'final', tiles: pp.final };
    });
  }
  return { at };
}
