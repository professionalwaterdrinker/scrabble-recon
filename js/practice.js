// Practice mode: an untimed game where one person plays both racks, and the
// Quackle engine reviews every move against the exact rack that was held.

const RACK = 7;
const SAVE_KEY = 'tilerewind.practice';
const TILES = { A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1, '?': 2 };

export function createPractice(ctx) {
  const { N, CENTER, VAL, PREM, $, escapeHtml, notation, lineRun, isWord, engine, renderBoard, pickBlank } = ctx;
  const listName = () => (ctx.listName ? ctx.listName() : 'the word list');
  const value = ch => ch === '?' ? 0 : VAL[ch];

  let G = null;                 // the saved game
  let sel = null;               // selected rack slot
  let cursor = CENTER, dir = 0; // typing cursor on the board
  let pending = new Map();      // square -> { slot, ch, blank } placed but not yet played
  let swap = null;              // Set of rack slots chosen for an exchange
  let preview = null;           // { k, key, cells, blanks, ghost } while previewing a Quackle play
  let viewing = null;           // history entry whose analysis is shown
  let message = { text: '', cls: '' };
  const sims = {};               // move index -> { sim } (kept for this visit only)

  /* ---------- game state ---------- */

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function newGame() {
    const bag = [];
    for (const ch in TILES) for (let i = 0; i < TILES[ch]; i++) bag.push(ch);
    shuffle(bag);
    G = { version: 1, bag, racks: [[], []], cells: Array(N * N).fill(''), blanks: [], scores: [0, 0], turn: 0, history: [], zeroRun: 0, over: false, end: null };
    G.racks.forEach((r, p) => draw(p));
    sel = null; pending = new Map(); swap = null; preview = null; viewing = null; cursor = CENTER; dir = 0;
    message = { text: 'Player 1 to start. Your first word must cover the centre star.', cls: '' };
    save();
  }
  function draw(p) { while (G.racks[p].length < RACK && G.bag.length) G.racks[p].push(G.bag.pop()); }
  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch (e) {} }
  function load() {
    try { const g = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (g && g.version === 1) { G = g; return true; } } catch (e) {}
    return false;
  }
  const blanksSet = () => new Set(G.blanks);

  /* ---------- checking a play ---------- */

  // Is the tentative play legal, and what does it score?
  function evaluate() {
    const squares = [...pending.keys()];
    if (!squares.length) return { ok: false, reason: '' };
    const B = G.cells.slice(), blanks = blanksSet();
    pending.forEach((t, i) => { B[i] = t.ch; if (t.blank) blanks.add(i); });
    const rows = new Set(squares.map(i => (i / N) | 0)), cols = new Set(squares.map(i => i % N));
    let d;
    if (squares.length === 1) d = lineRun(B, squares[0], 0).length >= 2 ? 0 : 1;
    else if (rows.size === 1) d = 0;
    else if (cols.size === 1) d = 1;
    else return { ok: false, reason: 'All the tiles you play must be in one row or one column.' };
    const main = lineRun(B, squares[0], d);
    if (!squares.every(i => main.includes(i))) return { ok: false, reason: 'There is a gap between your tiles.' };
    const empty = G.cells.every(c => !c);
    const words = [];
    if (main.length >= 2) words.push(main);
    squares.forEach(i => { const x = lineRun(B, i, 1 - d); if (x.length >= 2) words.push(x); });
    if (!words.length) return { ok: false, reason: 'A word needs at least two letters.' };
    if (empty) {
      if (!main.includes(CENTER)) return { ok: false, reason: 'The first word must cover the centre star.' };
      if (squares.length < 2) return { ok: false, reason: 'A word needs at least two letters.' };
    } else if (!words.some(w => w.some(i => !pending.has(i)))) {
      return { ok: false, reason: 'Your word must join onto tiles already on the board.' };
    }
    const wordText = w => w.map(i => B[i]).join('');
    const bad = words.map(wordText).filter(w => !isWord(w));
    if (bad.length) return { ok: false, reason: `${bad.join(', ')} ${bad.length > 1 ? "aren't" : "isn't"} in ${listName()}.` };
    let score = 0;
    for (const w of words) {
      let s = 0, mult = 1;
      for (const i of w) {
        let v = blanks.has(i) ? 0 : VAL[B[i]];
        if (pending.has(i)) {
          if (PREM[i] === 'dl') v *= 2; else if (PREM[i] === 'tl') v *= 3;
          else if (PREM[i] === 'dw') mult *= 2; else if (PREM[i] === 'tw') mult *= 3;
        }
        s += v;
      }
      score += s * mult;
    }
    const bingo = squares.length === RACK;
    if (bingo) score += 50;
    // the play in Quackle's notation: '.' for letters already down, lowercase for blanks
    const mainLine = main.length >= 2 ? main : words[0];
    const mainDir = main.length >= 2 ? d : 1 - d;
    const qword = mainLine.map(i => pending.has(i) ? (pending.get(i).blank ? pending.get(i).ch.toLowerCase() : pending.get(i).ch) : '.').join('');
    return { ok: true, score, bingo, words: words.map(wordText), place: notation(mainLine[0], mainDir), qword, mainLine };
  }

  /* ---------- making moves ---------- */

  function rackLeft(p) { return G.racks[p].filter((_, k) => ![...pending.values()].some(t => t.slot === k)); }
  function finishTurn(entry) {
    G.history.push(entry);
    viewing = G.history.length - 1;
    const p = G.turn;
    // the game ends when someone uses their last tile with the bag empty, or after six scoreless turns in a row
    if (entry.kind === 'play' && !G.racks[p].length && !G.bag.length) {
      const other = 1 - p, left = G.racks[other], v = left.reduce((s, ch) => s + value(ch), 0);
      G.scores[p] += v; G.scores[other] -= v;
      G.over = true; G.end = { out: p, left: left.join(''), value: v };
    } else if (G.zeroRun >= 6) {
      G.end = { stalled: true, left: G.racks.map(r => r.join('')) };
      G.racks.forEach((r, q) => { G.scores[q] -= r.reduce((s, ch) => s + value(ch), 0); });
      G.over = true;
    } else {
      G.turn = 1 - p;
    }
    save();
    analyse(G.history.length - 1);
  }
  function play() {
    if (!G || G.over) return;
    const ev = evaluate();
    if (!ev.ok) { message = { text: ev.reason || 'Place some tiles first.', cls: 'err' }; render(); return; }
    const p = G.turn;
    const entry = {
      kind: 'play', player: p, place: ev.place, qword: ev.qword, words: ev.words, score: ev.score, bingo: ev.bingo,
      rack: G.racks[p].join(''), other: G.racks[1 - p].join(''), bag: G.bag.length,
      placed: [...pending.entries()].map(([i, t]) => [i, t.ch, t.blank ? 1 : 0]),
    };
    pending.forEach((t, i) => { G.cells[i] = t.ch; if (t.blank) G.blanks.push(i); });
    const used = new Set([...pending.values()].map(t => t.slot));
    G.racks[p] = G.racks[p].filter((_, k) => !used.has(k));
    G.scores[p] += ev.score;
    draw(p);
    G.zeroRun = 0;
    pending = new Map(); sel = null;
    message = { text: `Player ${p + 1} played ${ev.words[0]} for ${ev.score}${ev.bingo ? ', a bingo' : ''}.`, cls: 'good' };
    finishTurn(entry);
  }
  function startExchange() {
    if (!G || G.over) return;
    if (G.bag.length < RACK) { message = { text: `You can only exchange while the bag holds at least ${RACK} tiles.`, cls: 'err' }; render(); return; }
    recall(false);
    swap = new Set();
    message = { text: 'Choose the tiles to exchange, then confirm.', cls: '' };
    render();
  }
  function confirmExchange() {
    if (!swap || !swap.size) { message = { text: 'Choose at least one tile to exchange.', cls: 'err' }; render(); return; }
    const p = G.turn, rack = G.racks[p];
    const out = [...swap].map(k => rack[k]);
    const entry = { kind: 'exchange', player: p, tiles: out.join(''), score: 0, rack: rack.join(''), other: G.racks[1 - p].join(''), bag: G.bag.length };
    G.racks[p] = rack.filter((_, k) => !swap.has(k));
    draw(p);                   // draw first, then return the old tiles
    G.bag.push(...out); shuffle(G.bag);
    G.zeroRun++;
    swap = null;
    message = { text: `Player ${p + 1} exchanged ${out.length} tile${out.length > 1 ? 's' : ''}.`, cls: 'good' };
    finishTurn(entry);
  }
  function pass() {
    if (!G || G.over) return;
    recall(false);
    const p = G.turn;
    G.zeroRun++;
    message = { text: `Player ${p + 1} passed.`, cls: '' };
    finishTurn({ kind: 'pass', player: p, score: 0, rack: G.racks[p].join(''), other: G.racks[1 - p].join(''), bag: G.bag.length });
  }
  function recall(redraw = true) { pending = new Map(); sel = null; swap = null; if (redraw) { message = { text: '', cls: '' }; render(); } }
  function shuffleRack() {
    if (!G) return;
    recall(false);
    shuffle(G.racks[G.turn]); save(); render();
  }

  // Put rack slot `slot` on square i (asking for a letter if it's a blank).
  async function placeTile(slot, i) {
    if (G.cells[i] || pending.has(i)) return false;
    const tile = G.racks[G.turn][slot];
    let ch = tile, blank = false;
    if (tile === '?') { ch = await pickBlank(); if (!ch) return false; blank = true; }
    pending.set(i, { slot, ch, blank });
    preview = null;
    return true;
  }
  function freeSlots() { const used = new Set([...pending.values()].map(t => t.slot)); return G.racks[G.turn].map((_, k) => k).filter(k => !used.has(k)); }
  function advanceCursor() {
    let [r, c] = [(cursor / N) | 0, cursor % N];
    do { if (dir === 0) c++; else r++; } while (r < N && c < N && (G.cells[r * N + c] || pending.has(r * N + c)));
    if (r < N && c < N) cursor = r * N + c;
  }

  /* ---------- Quackle review ---------- */

  function quackleInput(k) {
    const e = G.history[k], lines = ['players 2'];
    for (let j = 0; j < k; j++) { const h = G.history[j]; if (h.kind === 'play') lines.push(`move ${h.player} ${h.place} ${h.qword}`); }
    if (e.other) lines.push(`hold ${1 - e.player} ${e.other}`);
    lines.push(`rack ${e.player} ${e.rack}`);
    lines.push(e.kind === 'play' ? `actual ${e.place} ${e.qword}` : e.kind === 'exchange' ? `actual exchange ${e.tiles}` : 'actual pass');
    lines.push('top 8');
    return lines.join('\n');
  }
  async function analyse(k) {
    const e = G.history[k];
    if (!e || e.analysis) { render(); return; }
    e.analysing = true; render();
    try {
      await engine.ready();
      const res = await engine.analyse(quackleInput(k));
      if (res.ok) {
        const best = res.moves[0];
        let loss = null;
        if (best && res.actual) loss = res.actualRank === 0 ? 0 : Math.max(0, best.equity - res.actual.equity);
        e.analysis = { moves: res.moves, actual: res.actual, rank: res.actualRank, rack: res.rack, loss };
      } else e.analysisError = res.error;
    } catch (err) {
      e.analysisError = String(err && err.message || err);
    }
    delete e.analysing;
    save(); render();
  }
  // Retry any moves still waiting (for example after reloading the page).
  function analyseMissing() { G.history.forEach((e, k) => { if (!e.analysis) { delete e.analysisError; analyse(k); } }); }

  // Board as it was before history entry k.
  function boardBefore(k) {
    const cells = Array(N * N).fill(''), blanks = new Set();
    for (let j = 0; j < k; j++) (G.history[j].placed || []).forEach(([i, ch, b]) => { cells[i] = ch; if (b) blanks.add(i); });
    return { cells, blanks };
  }
  function playSquares(mv, cells) {
    const h = /^(\d+)([A-O])$/i.exec(mv.place || ''), v = /^([A-O])(\d+)$/i.exec(mv.place || '');
    if (!h && !v) return null;
    const COLS = 'ABCDEFGHIJKLMNO';
    const r0 = h ? +h[1] - 1 : +v[2] - 1, c0 = COLS.indexOf((h ? h[2] : v[1]).toUpperCase()), dr = h ? 0 : 1, dc = h ? 1 : 0;
    return [...mv.tiles].map((ch, n) => {
      const i = (r0 + dr * n) * N + c0 + dc * n;
      return { i, thru: ch === '.', ch: ch === '.' ? cells[i] : ch.toUpperCase(), blank: ch !== '.' && ch !== ch.toUpperCase() };
    });
  }
  function moveLabel(mv, cells) {
    if (!mv) return '';
    if (mv.action === 'exchange') return `Exchange ${escapeHtml(mv.tiles)}`;
    if (mv.action === 'pass') return 'Pass';
    const sq = playSquares(mv, cells);
    if (!sq) return escapeHtml(mv.word);
    return `${mv.place} <span class="word">${sq.map(x => x.thru ? `<span class="thru">${x.ch}</span>` : x.blank ? `<span class="bl">${x.ch.toLowerCase()}</span>` : x.ch).join('')}</span>`;
  }
  function keeps(rack, mv) {
    const left = [...rack];
    const used = mv.action === 'exchange' ? [...mv.tiles] : [...mv.tiles].filter(ch => ch !== '.').map(ch => ch !== ch.toUpperCase() ? '?' : ch);
    if (mv.action === 'pass') return rack;
    for (const ch of used) { const i = left.indexOf(ch); if (i >= 0) left.splice(i, 1); }
    return left.join('') || '–';
  }
  const sameMove = (a, b) => a && b && a.action === b.action && a.place === b.place &&
    (a.action === 'exchange' ? [...a.tiles].sort().join('') === [...b.tiles].sort().join('') : a.tiles === b.tiles);

  /* ---------- rendering ---------- */

  // What the shared board renderer should draw.
  function view() {
    if (!G) return null;
    if (preview) return { cells: preview.cells, blanks: preview.blanks, pending: new Map(), ghost: preview.ghost, hot: new Set(), cursor: -1, dir };
    const last = G.history.length ? G.history[G.history.length - 1] : null;
    const hot = new Set(last && last.placed ? last.placed.map(([i]) => i) : []);
    return { cells: G.cells, blanks: blanksSet(), pending, ghost: null, hot: pending.size ? new Set() : hot, cursor, dir };
  }

  function tileFace(ch, extra = '') {
    return ch === '?' ? `<span class="rtile ${extra}" aria-label="Blank tile"></span>` : `<span class="rtile ${extra}">${ch}<i>${VAL[ch]}</i></span>`;
  }
  function renderRack() {
    const box = $('pxRacks');
    if (!G) { box.innerHTML = ''; return; }
    const p = G.turn, used = new Set([...pending.values()].map(t => t.slot));
    const mine = G.racks[p].map((ch, k) => {
      const cls = ['pxtile', used.has(k) ? 'gone' : '', sel === k ? 'picked' : '', swap && swap.has(k) ? 'swap' : ''].filter(Boolean).join(' ');
      const face = ch === '?' ? '' : `${ch}<i>${VAL[ch]}</i>`;
      return `<button type="button" class="rtile ${cls}" data-slot="${k}" ${used.has(k) ? 'disabled' : ''} aria-label="${ch === '?' ? 'Blank' : ch}">${face}</button>`;
    }).join('');
    const o = 1 - p, backs = G.racks[o].map(() => '<span class="rtile back" aria-hidden="true"></span>').join('');
    box.innerHTML = `
      <div class="shelf mover"><div class="shelf-head"><b>Player ${p + 1}</b><span class="shelf-pts">${G.scores[p]}</span><span class="shelf-tag">${G.over ? 'game over' : 'your turn'}</span></div>
        <div class="rack px-rack">${mine || '<span class="hint">No tiles left</span>'}</div></div>
      <div class="shelf"><div class="shelf-head"><b>Player ${o + 1}</b><span class="shelf-pts">${G.scores[o]}</span><span class="shelf-tag">face down</span></div>
        <div class="rack">${backs || '<span class="hint">No tiles left</span>'}</div></div>`;
  }

  function render() {
    if (!G) return;
    renderRack();
    const ev = evaluate();
    // live check of the tentative play
    let live = '';
    if (G.over) live = '';
    else if (swap) live = `${swap.size} tile${swap.size === 1 ? '' : 's'} chosen.`;
    else if (pending.size) live = ev.ok ? `<span class="ok">${ev.words.join(', ')}: ${ev.score} point${ev.score === 1 ? '' : 's'}${ev.bingo ? ' (bingo)' : ''}</span>` : `<span class="no">${escapeHtml(ev.reason)}</span>`;
    $('pxLive').innerHTML = live;
    $('pxMsg').textContent = message.text; $('pxMsg').className = 'status ' + message.cls; $('pxMsg').hidden = !message.text;
    $('pxBag').textContent = `Bag: ${G.bag.length} tile${G.bag.length === 1 ? '' : 's'}`;
    $('pxScores').innerHTML = G.scores.map((s, p) => `<div class="pl ${p === G.turn && !G.over ? 'turn' : ''}"><div class="who">Player ${p + 1}${p === G.turn && !G.over ? ' · to play' : ''}</div><div class="pts">${s}</div></div>`).join('');
    const playing = !G.over;
    $('pxPlay').disabled = !playing || !!swap || !ev.ok;
    $('pxRecall').disabled = !playing || (!pending.size && !swap);
    $('pxShuffle').disabled = !playing || !!swap;
    $('pxExchange').hidden = !!swap; $('pxConfirm').hidden = !swap;
    $('pxExchange').disabled = !playing || G.bag.length < RACK;
    $('pxPass').disabled = !playing || !!swap;
    if (G.over) {
      const e = G.end;
      $('pxMsg').hidden = false; $('pxMsg').className = 'status good';
      const lead = G.scores[0] === G.scores[1] ? "It's a tie" : `Player ${G.scores[0] > G.scores[1] ? 1 : 2} wins`;
      $('pxMsg').textContent = e && e.stalled
        ? `Game over after six scoreless turns. Both players lose the value of their tiles. ${lead}, ${G.scores[0]} to ${G.scores[1]}.`
        : `Game over: Player ${e.out + 1} used their last tile and gains ${e.value} from Player ${2 - e.out}'s rack (${e.left || 'empty'}). ${lead}, ${G.scores[0]} to ${G.scores[1]}.`;
    }
    renderReview();
    renderHistory();
    renderBoard();
  }

  function renderReview() {
    const box = $('pxReview'), title = $('pxReviewTitle');
    const k = viewing;
    if (k === null || !G.history[k]) {
      title.innerHTML = 'Quackle review';
      box.innerHTML = `<p class="hint">After each move, Quackle shows the plays with the highest equity for the rack you had, next to yours. ${engine.state() === 'loading' ? '<br><span class="spinner"></span>Loading Quackle (about 26 MB the first time)…' : ''}</p>`;
      return;
    }
    const e = G.history[k], before = boardBefore(k);
    title.innerHTML = `Quackle review <span class="n">Move ${k + 1}, Player ${e.player + 1}</span>`;
    const rack = `<p class="qk-rack">Rack ${[...e.rack].map(ch => `<span class="mini">${ch}</span>`).join('')}</p>`;
    if (e.analysing || (!e.analysis && !e.analysisError)) { box.innerHTML = `${rack}<p class="status"><span class="spinner"></span>${engine.state() === 'ready' ? 'Quackle is looking at this move…' : 'Loading Quackle (about 26 MB the first time)…'}</p>`; return; }
    if (e.analysisError) { box.innerHTML = `${rack}<p class="status err">Quackle couldn't review this move: ${escapeHtml(e.analysisError)}</p><div class="row"><button class="btn" data-retry="${k}">Try again</button></div>`; return; }
    const a = e.analysis, best = a.moves[0];
    const yours = e.kind === 'play' ? `${e.place} <span class="word">${escapeHtml(e.words[0])}</span> for ${e.score}` : e.kind === 'exchange' ? `an exchange of ${escapeHtml(e.tiles)}` : 'a pass';
    let verdict;
    if (!best) verdict = 'Quackle found no plays for this rack.';
    else if (a.loss !== null && a.loss < 0.05) verdict = `<b>You found Quackle's top play.</b>`;
    else if (a.loss !== null && a.loss < 3) verdict = `Close. You chose ${yours}; Quackle slightly prefers <b>${moveLabel(best, before.cells)}</b> for ${best.score} (${a.loss.toFixed(1)} equity).`;
    else verdict = `You chose ${yours}. Quackle prefers <b>${moveLabel(best, before.cells)}</b> for ${best.score}, worth ${a.loss.toFixed(1)} more equity.`;
    const rows = a.moves.map((mv, n) => {
      const mine = sameMove(mv, a.actual), on = preview && preview.key === `${k}:${n}`;
      return `<tr class="qkrow ${mine ? 'played' : ''} ${on ? 'cur' : ''}" data-k="${k}" data-n="${n}"><td>${n + 1}</td><td>${moveLabel(mv, before.cells)}${mine ? ' <span class="badge">yours</span>' : ''}</td><td class="num">${mv.score}</td><td class="num">${mv.equity.toFixed(1)}</td><td class="not">${keeps(e.rack, mv)}</td></tr>`;
    });
    if (a.actual && !a.moves.some(mv => sameMove(mv, a.actual))) {
      const on = preview && preview.key === `${k}:a`;
      rows.push(`<tr class="qkrow played ${on ? 'cur' : ''}" data-k="${k}" data-n="a"><td>–</td><td>${moveLabel(a.actual, before.cells)} <span class="badge">yours</span></td><td class="num">${e.score}</td><td class="num">${a.actual.equity.toFixed(1)}</td><td class="not">${keeps(e.rack, a.actual)}</td></tr>`);
    }
    box.innerHTML = `${rack}<p class="verdict">${verdict}</p>
      <div class="moves-wrap qk-table"><table><thead><tr><th>#</th><th>Play</th><th class="num">Pts</th><th class="num">Equity</th><th>Keeps</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
      <p class="note">Click a play to see it on the board as it was before your move. Equity is the score plus Quackle's value for the tiles kept.</p>
      ${ctx.simHtml ? ctx.simHtml((sims[k] || {}).sim, { label: mv => moveLabel(mv, before.cells), keeps: mv => keeps(e.rack, mv), exact: true }) : ''}`;
  }

  function renderHistory() {
    const box = $('pxHistory');
    if (!G.history.length) { box.innerHTML = '<p class="hint">No moves yet.</p>'; $('pxTotals').textContent = ''; return; }
    const lost = [0, 0], n = [0, 0];
    G.history.forEach(e => { if (e.analysis && e.analysis.loss !== null) { lost[e.player] += e.analysis.loss; n[e.player]++; } });
    $('pxTotals').innerHTML = n[0] + n[1] ? `Equity given up (lower is better): ${lost.map((v, p) => `Player ${p + 1} <b>${v.toFixed(1)}</b>`).join(' · ')}` : '';
    box.innerHTML = `<table><thead><tr><th>#</th><th>Player</th><th>Play</th><th class="num">Pts</th><th class="num">vs Quackle</th></tr></thead><tbody>${
      G.history.map((e, k) => {
        const play = e.kind === 'play' ? `${e.place} <span class="word">${escapeHtml(e.words[0])}</span>${e.bingo ? '<span class="bingo">BINGO</span>' : ''}` : e.kind === 'exchange' ? `Exchange ${e.tiles.length}` : 'Pass';
        const qk = e.analysis ? (e.analysis.loss === null ? '–' : e.analysis.loss < 0.05 ? '<span class="okmark">✓</span>' : `−${e.analysis.loss.toFixed(1)}`) : e.analysisError ? '!' : '…';
        return `<tr class="mv ${k === viewing ? 'cur' : ''}" data-view="${k}"><td>${k + 1}</td><td>P${e.player + 1}</td><td>${play}</td><td class="num">${e.score}</td><td class="num qk">${qk}</td></tr>`;
      }).reverse().join('')}</tbody></table>`;
  }

  /* ---------- input ---------- */

  // `again` is true when the board was already selected, so a second tap on the cursor turns it.
  async function clickSquare(i, again = true) {
    if (!G || G.over || swap) return;
    preview = null;
    if (pending.has(i)) { pending.delete(i); render(); return; }
    if (sel !== null && !G.cells[i]) {
      const slot = sel; sel = null;
      if (await placeTile(slot, i)) { cursor = i; advanceCursor(); }
      render(); return;
    }
    if (i === cursor && again) dir = 1 - dir;
    cursor = i;
    render();
  }
  function clickSlot(k) {
    if (!G || G.over) return;
    if (swap) { swap.has(k) ? swap.delete(k) : swap.add(k); render(); return; }
    sel = sel === k ? null : k;
    render();
  }
  // Keyboard: letters place tiles from the rack at the cursor.
  async function key(k) {
    if (!G || G.over) return false;
    if (/^[a-zA-Z]$/.test(k)) {
      if (G.cells[cursor] || pending.has(cursor)) { advanceCursor(); if (G.cells[cursor] || pending.has(cursor)) return true; }
      const L = k.toUpperCase(), free = freeSlots(), rack = G.racks[G.turn];
      let slot = free.find(s => rack[s] === L), blank = false;
      if (slot === undefined) { slot = free.find(s => rack[s] === '?'); blank = slot !== undefined; }
      if (slot === undefined) { message = { text: `There's no ${L} on your rack.`, cls: 'err' }; render(); return true; }
      pending.set(cursor, { slot, ch: L, blank });
      preview = null;
      advanceCursor(); message = { text: '', cls: '' }; render(); return true;
    }
    if (k === 'Backspace') {
      const last = [...pending.keys()].pop();
      if (last !== undefined) { pending.delete(last); cursor = last; render(); }
      return true;
    }
    if (k === 'Enter') { play(); return true; }
    if (k === 'Escape') { recall(); return true; }
    if (k === ' ') { dir = 1 - dir; render(); return true; }
    const [r, c] = [(cursor / N) | 0, cursor % N];
    const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (moves[k]) {
      const [dr, dc] = moves[k];
      cursor = Math.min(N - 1, Math.max(0, r + dr)) * N + Math.min(N - 1, Math.max(0, c + dc));
      render(); return true;
    }
    return false;
  }
  function clickReviewRow(k, n) {
    const e = G.history[k];
    if (!e || !e.analysis) return;
    const key = `${k}:${n}`;
    if (preview && preview.key === key) { preview = null; render(); return; }
    const mv = n === 'a' ? e.analysis.actual : e.analysis.moves[+n];
    const before = boardBefore(k), sq = mv && playSquares(mv, before.cells);
    if (!sq) { preview = null; render(); return; }
    recall(false);
    preview = { k, key, cells: before.cells, blanks: before.blanks, ghost: new Map(sq.filter(x => !x.thru).map(x => [x.i, x])) };
    render();
  }

  // wire up the panel
  $('pxPlay').onclick = play;
  $('pxRecall').onclick = () => recall();
  $('pxShuffle').onclick = shuffleRack;
  $('pxExchange').onclick = startExchange;
  $('pxConfirm').onclick = confirmExchange;
  $('pxPass').onclick = pass;
  $('pxNew').onclick = () => { if ($('pxNew').dataset.confirm === '1' || !G || G.over || !G.history.length) { $('pxNew').dataset.confirm = ''; $('pxNew').textContent = 'New game'; newGame(); render(); } else { $('pxNew').dataset.confirm = '1'; $('pxNew').textContent = 'Start over? Click again'; setTimeout(() => { $('pxNew').dataset.confirm = ''; $('pxNew').textContent = 'New game'; }, 3000); } };
  $('pxRacks').addEventListener('click', e => { const b = e.target.closest('[data-slot]'); if (b) clickSlot(+b.dataset.slot); });
  $('pxReview').addEventListener('click', e => {
    const retry = e.target.closest('[data-retry]');
    if (retry) { const k = +retry.dataset.retry; delete G.history[k].analysisError; analyse(k); return; }
    const simBtn = e.target.closest('[data-sim="run"], [data-sim="stop"]');
    if (simBtn && viewing !== null && ctx.simStart) {
      const k = viewing, holder = sims[k] = sims[k] || {};
      if (simBtn.dataset.sim === 'stop') { if (holder.sim && holder.sim.ctl) holder.sim.ctl.abort(); return; }
      ctx.simStart(holder, quackleInput(k), () => { if (viewing === k) renderReview(); });
      return;
    }
    const tr = e.target.closest('tr.qkrow'); if (tr) clickReviewRow(+tr.dataset.k, tr.dataset.n);
  });
  $('pxHistory').addEventListener('click', e => { const tr = e.target.closest('tr[data-view]'); if (tr) { viewing = +tr.dataset.view; preview = null; render(); } });

  return {
    enter() {
      if (!G) {
        if (load()) { if (viewing === null && G.history.length) viewing = G.history.length - 1; }
        else newGame();
      }
      render();
      engine.ready().then(() => { analyseMissing(); render(); }, () => render());
    },
    view, clickSquare, key, render,
    hasPreview: () => !!preview,
  };
}
