// Web worker: rebuilds a plausible move order by peeling plays off the final board.
const N = 15, CENTER = 112;
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
function solve(cells, strict, seed, timeLimit) {
  const B = cells.slice();
  const t0 = Date.now();
  let deadline = t0 + timeLimit;
  const extra = new Set(allRuns(B).map(r => r.pos.map(i => B[i]).join('')));
  const isWord = w => w.length < 2 || !strict || DICT.has(w) || extra.has(w);
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
  const SIZE = [0, 0, 5, 7.5, 8.5, 8.5, 8, 7];
  function heur(rem, dir, run, frag) {
    const k = rem.length, step = dir ? N : 1;
    const contiguous = (rem[k - 1] - rem[0]) / step + 1 === k;
    let dist = 0;
    for (const p of rem) dist += Math.max(Math.abs(((p / N) | 0) - 7), Math.abs(p % N - 7));
    dist /= k;
    return SIZE[k] - frag * 3 + (contiguous ? 1 : 0) + dist * 0.4 + rand() * 6;
  }
  // lower is more like a real game: fewer moves, few one- and two-tile plays, few word extensions
  function cost(moves) {
    let c = 0;
    for (const m of moves) c += 1 + (m.tiles.length === 1 ? 2.5 : m.tiles.length === 2 ? 0.8 : 0) + m.frag * 0.8;
    // openings are rarely two letters
    return c + (moves.length && moves[0].tiles.length < 3 ? 1.5 : 0);
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
  function dfs(n) {
    if (n === 0) return [];
    if ((++nodes & 63) === 0 && Date.now() > deadline) throw 'timeout';
    const key = B.map(x => x || '.').join('');
    if (failed.has(key)) return null;
    for (const c of candidates()) {
      const k = c.tiles.length, m = n - k;
      if (m === 0 && (k < 2 || !c.tiles.includes(CENTER))) continue;
      const saved = c.tiles.map(p => B[p]);
      c.tiles.forEach(p => B[p] = '');
      let r = null;
      if (connectedOK(m)) r = dfs(m);
      c.tiles.forEach((p, j) => B[p] = saved[j]);
      if (r) { r.push({ tiles: c.tiles, dir: c.dir, frag: c.frag }); return r; }
    }
    failed.add(key);
    return null;
  }
  const n = B.filter(Boolean).length;
  if (!connectedOK(n)) return { ok: false, reason: 'shape' };
  // several randomised searches; keep the order that reads most like a real game
  let best = null, bestCost = Infinity, tries = 0;
  for (let j = 0; j < 40; j++) {
    rand = mulberry(seed * 7919 + j + 1);
    try {
      const moves = dfs(n);
      tries++;
      if (!moves) break; // exhaustive: no order exists
      const c = cost(moves);
      if (c < bestCost) { best = moves; bestCost = c; }
      if (tries === 1) deadline = Math.min(deadline, Date.now() + 2500);
    } catch (e) {
      if (e !== 'timeout') throw e;
      break;
    }
  }
  const ms = Date.now() - t0;
  if (best) return { ok: true, moves: best, nodes, ms, tries };
  return { ok: false, reason: tries ? 'none' : 'timeout', nodes, ms };
}
onmessage = e => {
  const m = e.data;
  if (m.type === 'dict') { DICT = new Set(m.text.split('\n').filter(Boolean).map(w => w.trim().toUpperCase())); postMessage({ type: 'ready' }); }
  else if (m.type === 'solve') { postMessage(Object.assign({ type: 'result', id: m.id, strict: m.strict }, solve(m.cells, m.strict, m.seed, m.timeLimit))); }
};
