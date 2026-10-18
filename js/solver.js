// Web worker: rebuilds a plausible move order by peeling plays off the final board,
// then picks and polishes the order that reads most like a real game: few points
// left on the table, and the players' totals matching the score sheet when given.
const N = 15, CENTER = 112;
const VAL = { A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10 };
const SET_VALUE = 187;  // all 100 tiles of a standard English set (blanks score nothing)
const PREM = Array(N * N).fill('');
{
  const put = (list, t) => list.forEach(([r, c]) => {
    for (const [a, b] of [[r, c], [c, r]]) for (const rr of [a, 14 - a]) for (const cc of [b, 14 - b]) PREM[rr * N + cc] = t;
  });
  put([[0,3],[2,6],[3,7],[6,6]], 'dl'); put([[1,5],[5,5]], 'tl'); put([[1,1],[2,2],[3,3],[4,4],[7,7]], 'dw'); put([[0,0],[0,7]], 'tw');
}
const LV = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => VAL[c]);
const LM = PREM.map(p => p === 'dl' ? 2 : p === 'tl' ? 3 : 1), WM = PREM.map(p => p === 'dw' ? 2 : p === 'tw' ? 3 : 1);
let DICT = null;
function mulberry(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function lineRun(B, p, dir) {
  let a = p;
  if (dir === 0) { while (a % N > 0 && B[a - 1]) a--; } else { while (a >= N && B[a - N]) a -= N; }
  const out = [];
  for (let q = a; ; ) {
    out.push(q);
    if (dir === 0) { if (q % N === N - 1 || !B[q + 1]) break; q++; }
    else { if (q + N >= N * N || !B[q + N]) break; q += N; }
  }
  return out;
}
function allRuns(B) {
  const runs = [];
  for (let dir = 0; dir < 2; dir++) {
    const seen = new Uint8Array(N * N);
    for (let p = 0; p < N * N; p++) {
      if (!B[p] || seen[p]) continue;
      const r = lineRun(B, p, dir); r.forEach(q => seen[q] = 1);
      if (r.length >= 2) runs.push({ dir, pos: r });
    }
  }
  return runs;
}

/* ---------- word tree for finding the best play with given tiles ---------- */

// First-child / next-sibling tree: a few bytes a node, so even a big list stays small.
let T = null;
function buildTree(words) {
  let cap = 1 << 18, n = 1;
  let ch = new Uint8Array(cap), kid = new Int32Array(cap).fill(-1), sib = new Int32Array(cap).fill(-1), end = new Uint8Array(cap);
  const grow = () => {
    cap *= 2;
    const c2 = new Uint8Array(cap); c2.set(ch); ch = c2;
    const k2 = new Int32Array(cap).fill(-1); k2.set(kid); kid = k2;
    const s2 = new Int32Array(cap).fill(-1); s2.set(sib); sib = s2;
    const e2 = new Uint8Array(cap); e2.set(end); end = e2;
  };
  for (const w of words) {
    let node = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - 65;
      if (c < 0 || c > 25) { node = -1; break; }
      let k = kid[node], last = -1;
      while (k >= 0 && ch[k] !== c) { last = k; k = sib[k]; }
      if (k < 0) {
        if (n >= cap) grow();
        k = n++; ch[k] = c;
        if (last < 0) kid[node] = k; else sib[last] = k;
      }
      node = k;
    }
    if (node > 0) end[node] = 1;
  }
  return { ch, kid, sib, end };
}
const child = (node, c) => { let k = T.kid[node]; while (k >= 0 && T.ch[k] !== c) k = T.sib[k]; return k; };

/* ---------- one game's worth of rules ---------- */

function makeGame(cells, blanks, strict) {
  const isBlank = new Uint8Array(N * N); blanks.forEach(i => isBlank[i] = 1);
  const extra = new Set(allRuns(cells).map(r => r.pos.map(i => cells[i]).join('')));
  const isWord = w => w.length < 2 || !strict || DICT.has(w) || extra.has(w);
  const tileVal = p => isBlank[p] ? 0 : VAL[cells[p]];
  const str = (B, ps) => { let s = ''; for (const p of ps) s += B[p]; return s; };

  // Is putting `tiles` (their final letters) onto board B a legal move? B is restored afterwards.
  function check(B, tiles) {
    const k = tiles.length;
    if (!k || k > 7) return null;
    const row = (tiles[0] / N) | 0, col = tiles[0] % N;
    const sameRow = tiles.every(p => ((p / N) | 0) === row), sameCol = tiles.every(p => p % N === col);
    if (!sameRow && !sameCol) return null;
    if (tiles.some(p => B[p])) return null;
    const first = !B.some(Boolean);
    tiles.forEach(p => B[p] = cells[p]);
    let res = null;
    try {
      let dir;
      if (k === 1) {
        const h = lineRun(B, tiles[0], 0).length, v = lineRun(B, tiles[0], 1).length;
        dir = h >= v ? 0 : 1;
      } else dir = sameRow ? 0 : 1;
      const main = lineRun(B, tiles[0], dir);
      if (!tiles.every(p => main.includes(p))) return null;      // a gap: not one line
      if (main.length < 2) return null;
      if (!isWord(str(B, main))) return null;
      const placed = new Set(tiles);
      let touches = main.length > k, score = 0, mult = 1, sum = 0;
      for (const p of main) { const v = tileVal(p); if (placed.has(p)) { sum += v * LM[p]; mult *= WM[p]; } else sum += v; }
      score = sum * mult;
      for (const p of tiles) {
        const x = lineRun(B, p, 1 - dir);
        if (x.length < 2) continue;
        touches = true;
        if (!isWord(str(B, x))) return null;
        let s = 0; for (const q of x) s += q === p ? tileVal(q) * LM[q] : tileVal(q);
        score += s * WM[p];
      }
      if (first ? !placed.has(CENTER) : !touches) return null;
      if (k === 7) score += 50;
      // kept pieces of 2+ letters inside the main word: the move extended an older word
      let frag = 0, len = 0;
      for (const p of main) { if (placed.has(p)) { if (len >= 2) frag++; len = 0; } else len++; }
      if (len >= 2) frag++;
      res = { dir, score, frag };
    } finally { tiles.forEach(p => B[p] = ''); }
    return res;
  }

  // The best score anyone could make on board B with exactly these tiles. Same tiles
  // in, same tiles kept: only the spot differs. A blank keeps the letter it was played
  // as (letting it be anything makes the search 30 times slower for little gain).
  const bestCache = new Map(), stats = { calls: 0, ms: 0 };
  function bestWith(B, tiles) {
    const rack = new Int8Array(26), rackB = new Int8Array(26);
    let letters = '';
    for (const p of tiles) { const c = cells[p].charCodeAt(0) - 65; if (isBlank[p]) rackB[c]++; else rack[c]++; }
    for (let c = 0; c < 26; c++) letters += rack[c] + ',' + rackB[c] + ';';
    const key = B.map(x => x || '.').join('') + letters;
    if (bestCache.has(key)) return bestCache.get(key);
    const t0 = performance.now(); stats.calls++;
    const k = tiles.length, empty = !B.some(Boolean), bv = p => B[p] ? (bState[p] ? 0 : VAL[B[p]]) : 0;
    const bState = new Uint8Array(N * N); for (let p = 0; p < N * N; p++) if (B[p]) bState[p] = isBlank[p];
    let best = -1;
    for (let dir = 0; dir < 2; dir++) {
      // per empty square: which letters the crossing word allows, and its points so far
      const allow = new Int32Array(N * N), crossSum = new Int32Array(N * N).fill(-1);
      const step = dir === 0 ? N : 1;
      for (let p = 0; p < N * N; p++) {
        if (B[p]) continue;
        const r = (p / N) | 0, sameLine = q => dir === 0 ? q >= 0 && q < N * N : q >= 0 && ((q / N) | 0) === r;
        let a = p; while (sameLine(a - step) && B[a - step]) a -= step;
        let b = p; while (sameLine(b + step) && B[b + step]) b += step;
        if (a === p && b === p) { allow[p] = 0x3ffffff; continue; }
        // walk the letters before the square, then try each letter and the letters after it
        let node = 0, s = 0;
        for (let q = a; q < p && node >= 0; q += step) { node = child(node, B[q].charCodeAt(0) - 65); s += bv(q); }
        let m = 0;
        if (node >= 0) for (let nx = T.kid[node]; nx >= 0; nx = T.sib[nx]) {
          let x = nx;
          for (let q = p + step; q <= b && x >= 0; q += step) x = child(x, B[q].charCodeAt(0) - 65);
          if (x >= 0 && T.end[x]) m |= 1 << T.ch[nx];
        }
        for (let q = p + step; q <= b; q += step) s += bv(q);
        allow[p] = m; crossSum[p] = s;
      }
      for (let line = 0; line < N; line++) {
        const at = i => dir === 0 ? line * N + i : i * N + line;
        // nearest square at or after i that is a tile, touches one, or is the centre on an empty board
        const near = new Int8Array(N + 1).fill(N);
        for (let i = N - 1; i >= 0; i--) {
          const p = at(i), hot = B[p] || crossSum[p] >= 0 || (empty && p === CENTER);
          near[i] = hot ? i : near[i + 1];
        }
        for (let s = 0; s < N; s++) {
          if (s > 0 && B[at(s - 1)]) continue;
          if (near[s] - s > k) continue;
          // walk along the line from s, placing or reading letters through the tree
          const walk = (i, node, used, sum, mult, cross, anchored, centre) => {
            if (i < N && B[at(i)]) {
              const p = at(i), nx = child(node, B[p].charCodeAt(0) - 65);
              if (nx < 0) return;
              walk(i + 1, nx, used, sum + bv(p), mult, cross, true, centre);
              return;
            }
            if (used === k && i - s >= 2 && T.end[node] && (anchored || (empty && centre))) {
              const sc = sum * mult + cross + (k === 7 ? 50 : 0);
              if (sc > best) best = sc;
            }
            if (i >= N || used === k) return;
            // still not touching anything, and too few tiles left to get there
            if (!anchored && !centre && (near[i] >= N || near[i] - i > k - used - 1 + (B[at(near[i])] ? 1 : 0))) return;
            const p = at(i), m = allow[p];
            if (!m) return;
            for (let nx = T.kid[node]; nx >= 0; nx = T.sib[nx]) {
              const c = T.ch[nx];
              if (!(m >> c & 1)) continue;
              for (const blank of [false, true]) {
                const r = blank ? rackB : rack;
                if (!r[c]) continue;
                r[c]--;
                const v = blank ? 0 : LV[c];
                const cs = crossSum[p];
                walk(i + 1, nx, used + 1, sum + v * LM[p], mult * WM[p], cs >= 0 ? cross + (cs + v * LM[p]) * WM[p] : cross, anchored || cs >= 0, centre || p === CENTER);
                r[c]++;
              }
            }
          };
          walk(s, 0, 0, 0, 1, 0, false, false);
        }
      }
    }
    bestCache.set(key, best);
    stats.ms += performance.now() - t0;
    return best;
  }
  return { check, bestWith, isWord, str, isBlank, stats };
}

/* ---------- how much a whole game reads like a real one ---------- */

// Lower is more believable: fewer moves, few one- and two-tile plays, few word
// extensions, few points thrown away, and totals close to the score sheet.
const WASTE = 0.25, WASTE_CAP = 80, GAP = 0.12;
function makeJudge(game, cells, players, targets) {
  const n = cells.filter(Boolean).length;
  const onBoard = cells.reduce((s, ch, p) => s + (ch && !game.isBlank[p] ? VAL[ch] : 0), 0);
  return function judge(order) {
    const B = Array(N * N).fill('');
    let cost = 0;
    const totals = Array(players).fill(0), info = [];
    for (let i = 0; i < order.length; i++) {
      const tiles = order[i];
      const c = game.check(B, tiles);
      if (!c) return null;
      const best = DICT && game.bestWith(B, tiles);
      const wasted = best > c.score ? Math.min(WASTE_CAP, best - c.score) : 0;
      const k = tiles.length;
      cost += 1 + (k === 1 ? 0.6 : k === 2 ? 0.2 : k === 7 ? -0.5 : 0) + c.frag * 0.2 + wasted * WASTE;
      totals[i % players] += c.score;
      info.push({ tiles, dir: c.dir, frag: c.frag, score: c.score, best: Math.max(best, c.score) });
      tiles.forEach(p => B[p] = cells[p]);
    }
    if (order.length && order[0].length < 3) cost += 1.5;   // openings are rarely two letters
    let gap = null;
    if (targets) {
      // the player who went out gains the value of the tiles left over (two players, game over)
      const left = Math.max(0, SET_VALUE - onBoard), adj = totals.slice();
      const over = n > 100 - 8;
      if (players === 2 && over && order.length) { const last = (order.length - 1) % 2; adj[last] += left; adj[1 - last] -= left; }
      const slack = players === 2 || !over ? 0 : left;
      gap = 0;
      for (let p = 0; p < players; p++) if (targets[p] != null) gap += Math.max(0, Math.abs(adj[p] - targets[p]) - slack);
      cost += gap * GAP;
    }
    return { cost, info, totals, gap };
  };
}

// Small edits to an order: swap neighbours, move a play a few turns, merge two plays
// on one line, or split one into two. Annealing: early on a slightly worse order is
// sometimes kept, so the search can climb out of dead ends; the best one seen wins.
function polish(order, judge, rand, deadline) {
  let cur = order.map(t => t.slice()), curJ = judge(cur);
  if (!curJ) return null;
  let best = cur, bestJ = curJ;
  const t0 = Date.now(), span = Math.max(1, deadline - t0);
  let tries = 0, valid = 0;
  while (true) {
    if ((tries & 15) === 0 && Date.now() >= deadline) break;
    tries++;
    const n = cur.length, op = rand();
    let next = null;
    if (op < 0.45 && n > 1) {
      const i = Math.floor(rand() * (n - 1)); next = cur.slice(); [next[i], next[i + 1]] = [next[i + 1], next[i]];
    } else if (op < 0.7 && n > 2) {
      const i = Math.floor(rand() * n), d = 1 + Math.floor(rand() * 8), j = Math.max(0, Math.min(n - 1, i + (rand() < 0.5 ? -d : d)));
      if (i === j) continue;
      next = cur.slice(); const [m] = next.splice(i, 1); next.splice(j, 0, m);
    } else if (op < 0.85 && n > 1) {
      // merge with a later play on the same line, if one comes within a few turns
      const i = Math.floor(rand() * (n - 1)), j = Math.min(n - 1, i + 1 + Math.floor(rand() * 3)), a = cur[i], b = cur[j];
      if (a.length + b.length > 7) continue;
      const all = [...a, ...b].sort((x, y) => x - y);
      const row = (all[0] / N) | 0, col = all[0] % N;
      if (!all.every(p => ((p / N) | 0) === row) && !all.every(p => p % N === col)) continue;
      next = cur.slice(); next.splice(j, 1); next.splice(i, 1, all);
    } else {
      const i = Math.floor(rand() * n), t = cur[i].slice().sort((x, y) => x - y);
      if (t.length < 2) continue;
      const cut = 1 + Math.floor(rand() * (t.length - 1)), a = t.slice(0, cut), b = t.slice(cut);
      const later = Math.min(cur.length, i + 1 + Math.floor(rand() * 3));
      next = cur.slice(); next.splice(i, 1, rand() < 0.5 ? a : b); next.splice(later, 0, next[i] === a ? b : a);
    }
    const j = judge(next);
    if (!j) continue;
    valid++;
    const temp = 2.5 * (1 - (Date.now() - t0) / span) + 0.05, d = j.cost - curJ.cost;
    if (d < 0 || rand() < Math.exp(-d / temp)) {
      cur = next; curJ = j;
      if (j.cost < bestJ.cost - 1e-9) { best = next; bestJ = j; }
    }
  }
  return { order: best, judged: bestJ, tries, valid };
}

function solve(cells, strict, seed, timeLimit, blanks, players, targets) {
  const B = cells.slice();
  const t0 = Date.now();
  let deadline = t0 + timeLimit;
  const game = makeGame(cells, blanks, strict);
  const { isWord } = game;
  let rand = () => 0;
  const str = ps => { let s = ''; for (const p of ps) s += B[p]; return s; };
  const failed = new Set();
  let nodes = 0;
  const maxBlocks = strict ? 4 : 2;

  function crossOK(p, pdir) {
    const run = lineRun(B, p, pdir);
    if (run.length < 2) return true;
    const k = run.indexOf(p);
    return isWord(str(run.slice(0, k))) && isWord(str(run.slice(k + 1)));
  }
  // kept pieces of 2+ letters inside the main word: the move extended an older word
  function fragments(rem, run) {
    const gone = new Set(rem); let f = 0, len = 0;
    for (const p of run) { if (gone.has(p)) { if (len >= 2) f++; len = 0; } else len++; }
    return f + (len >= 2 ? 1 : 0);
  }
  // seven new tiles forming one word were almost always a single bingo, so try those first
  const SIZE = [0, 0, 5, 7.5, 8.5, 8.5, 8.5, 15];
  function heur(rem, dir, run, frag) {
    const k = rem.length, step = dir ? N : 1;
    const contiguous = (rem[k - 1] - rem[0]) / step + 1 === k;
    let dist = 0;
    for (const p of rem) dist += Math.max(Math.abs(((p / N) | 0) - 7), Math.abs(p % N - 7));
    dist /= k;
    return SIZE[k] - frag * 3 + (contiguous ? 1 : 0) + dist * 0.4 + rand() * 6;
  }
  function candidates() {
    const seen = new Set(), out = [];
    for (const { dir, pos: run } of allRuns(B)) {
      const L = run.length, ok = run.map(q => crossOK(q, 1 - dir));
      const removed = [];
      const rec = (i, ps, blocks, lastRemoved) => {
        if (i === L) {
          if (removed.length && isWord(str(run.slice(ps, L)))) {
            const key = removed.join(',');
            if (!seen.has(key)) { seen.add(key); const frag = fragments(removed, run); out.push({ tiles: removed.slice(), dir, frag, h: heur(removed, dir, run, frag) }); }
          }
          return;
        }
        rec(i + 1, ps, blocks, false);
        if (ok[i] && removed.length < 7) {
          const nb = lastRemoved ? blocks : blocks + 1;
          if (nb <= maxBlocks && isWord(str(run.slice(ps, i)))) {
            removed.push(run[i]); rec(i + 1, i + 1, nb, true); removed.pop();
          }
        }
      };
      rec(0, 0, 0, false);
    }
    // don't peel off part of what is still removable as one seven-tile play (a bingo)
    const sevens = out.filter(c => c.tiles.length === 7).map(c => new Set(c.tiles));
    if (sevens.length) for (const c of out) if (c.tiles.length < 7 && sevens.some(t => c.tiles.every(p => t.has(p)))) c.h -= 8;
    out.sort((a, b) => b.h - a.h);
    return out;
  }
  function connectedOK(n) {
    if (n === 0) return true;
    if (n < 2 || !B[CENTER]) return false;
    const seen = new Uint8Array(N * N), stack = [CENTER]; seen[CENTER] = 1; let c = 0;
    while (stack.length) {
      const p = stack.pop(); c++;
      const r = (p / N) | 0, col = p % N;
      const nb = [];
      if (col > 0) nb.push(p - 1); if (col < N - 1) nb.push(p + 1); if (r > 0) nb.push(p - N); if (r < N - 1) nb.push(p + N);
      for (const q of nb) if (B[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    return c === n;
  }
  // When guided, the likeliest few removals are also weighed by the points they'd
  // have thrown away: a play is unlikely if the same tiles scored far more elsewhere.
  let guided = false;
  const GUIDE_TOP = 6;
  function ranked() {
    const list = candidates();
    if (!guided || !DICT) return list;
    const top = list.slice(0, GUIDE_TOP);
    for (const c of top) {
      c.tiles.forEach(p => B[p] = '');
      const chk = game.check(B, c.tiles);
      const best = chk ? game.bestWith(B, c.tiles) : -1;
      c.tiles.forEach(p => B[p] = cells[p]);
      const wasted = chk && best > chk.score ? Math.min(WASTE_CAP, best - chk.score) : 0;
      c.g = c.h - wasted * 0.6;
    }
    top.sort((a, b) => b.g - a.g);
    return top.concat(list.slice(GUIDE_TOP));
  }
  function dfs(n) {
    if (n === 0) return [];
    if ((++nodes & 63) === 0 && Date.now() > deadline) throw 'timeout';
    const key = B.map(x => x || '.').join('');
    if (failed.has(key)) return null;
    for (const c of ranked()) {
      const k = c.tiles.length, m = n - k;
      if (m === 0 && (k < 2 || !c.tiles.includes(CENTER))) continue;
      c.tiles.forEach(p => B[p] = '');
      let r = null;
      if (connectedOK(m)) r = dfs(m);
      c.tiles.forEach(p => B[p] = cells[p]);
      if (r) { r.push({ tiles: c.tiles, dir: c.dir, frag: c.frag }); return r; }
    }
    failed.add(key);
    return null;
  }
  const n = B.filter(Boolean).length;
  if (!connectedOK(n)) return { ok: false, reason: 'shape' };
  // several randomised searches give a pool of orders that fit the board: a quick
  // unguided one first (does any order exist?), then searches that avoid wasted points
  const pool = [];
  let tries = 0;
  const runs = strict ? 10 : 40;
  for (let j = 0; j < runs; j++) {
    rand = mulberry(seed * 7919 + j + 1);
    guided = strict && j > 0;
    try {
      const moves = dfs(n);
      tries++;
      if (!moves) break; // exhaustive: no order exists
      pool.push(moves.map(m => m.tiles));
      if (tries === 1) { deadline = Math.min(deadline, Date.now() + (strict ? 5000 : 2500)); postMessage({ type: 'progress', text: 'Found an order that fits. Looking for the most realistic one…' }); }
    } catch (e) {
      if (e !== 'timeout') throw e;
      break;
    }
  }
  if (!pool.length) return { ok: false, reason: tries ? 'none' : 'timeout', nodes, ms: Date.now() - t0 };
  // judge them, then polish the most believable few
  const judge = makeJudge(game, cells, players, targets);
  const scored = pool.map(o => ({ order: o, j: judge(o) })).filter(x => x.j).sort((a, b) => a.j.cost - b.j.cost);
  let best = scored[0];
  if (strict) {
    postMessage({ type: 'progress', text: 'Weighing which plays a real player would make…' });
    const budget = targets ? 7000 : 3000, starts = scored.slice(0, 2);
    const end = Date.now() + budget;
    starts.forEach((s, k) => {
      const r = polish(s.order, judge, mulberry(seed * 104729 + k + 1), Date.now() + (end - Date.now()) / (starts.length - k));
      if (r && r.judged.cost < best.j.cost) best = { order: r.order, j: r.judged };
    });
  }
  const moves = best.j.info.map(m => ({ tiles: m.tiles, dir: m.dir, frag: m.frag, best: m.best }));
  const wasted = best.j.info.reduce((s, m) => s + (m.best - m.score), 0);
  return { ok: true, moves, nodes, ms: Date.now() - t0, tries, realism: { wasted, gap: best.j.gap, totals: best.j.totals }, stats: { ...game.stats, pool: pool.length } };
}
onmessage = e => {
  const m = e.data;
  if (m.type === 'dict') {
    const words = m.text.split('\n').map(w => w.trim().toUpperCase()).filter(Boolean);
    DICT = new Set(words); T = buildTree(words);
    postMessage({ type: 'ready' });
  }
  else if (m.type === 'judge') {
    // for the test bench: how believable a given order is
    const game = makeGame(m.cells, m.blanks || [], true), j = makeJudge(game, m.cells, m.players || 2, m.targets || null)(m.order);
    postMessage({ type: 'judged', id: m.id, cost: j && j.cost, gap: j && j.gap, wasted: j && j.info.reduce((s, x) => s + (x.best - x.score), 0), valid: !!j });
  }
  else if (m.type === 'solve') {
    postMessage(Object.assign({ type: 'result', id: m.id, strict: m.strict },
      solve(m.cells, m.strict, m.seed, m.timeLimit, m.blanks || [], m.players || 2, m.targets || null)));
  }
};
