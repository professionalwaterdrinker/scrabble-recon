import { readBoard, getKey, setKey } from './vision.js';
import { CornerPicker, loadWorkingImage, readBoardLocally } from './localreader.js';
import { deduceRacks } from './racks.js';

(() => {
const N = 15, CENTER = 112, COLS = 'ABCDEFGHIJKLMNO';
const VAL = { A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10 };
const DIST = { A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1 };
const SAMPLE = [
  '.V...ATT....NAE', '.I...GOOKY.CABS', '.GEL....HOMO...', '..HIST.LIDOS...', '....COMAs......',
  '..JNANA........', '....BERET.WEER.', '...V...ROPY....', '...OPINED.ET...', '.REDID.........',
  '.I.U...........', '.L.NA..........', '.L..G..........', '....A..........', '..WARn.........'
];
const $ = id => document.getElementById(id);
const rc = i => [(i / N) | 0, i % N];
const sqName = i => { const [r, c] = rc(i); return COLS[c] + (r + 1); };

// premium squares from one octant, mirrored
const PREM = Array(N * N).fill('');
(() => {
  const put = (list, t) => list.forEach(([r, c]) => {
    for (const [a, b] of [[r, c], [c, r]]) for (const rr of [a, 14 - a]) for (const cc of [b, 14 - b]) PREM[rr * N + cc] = t;
  });
  put([[0,3],[2,6],[3,7],[6,6]], 'dl');
  put([[1,5],[5,5]], 'tl');
  put([[1,1],[2,2],[3,3],[4,4],[7,7]], 'dw');
  put([[0,0],[0,7]], 'tw');
})();

const S = {
  cells: Array(N * N).fill(''), blanks: new Set(), unsure: new Set(), sel: CENTER, dir: 0,
  mode: 'setup', moves: null, step: 0, players: 2, seed: 0, isSample: false, file: null, playTimer: null,
};
let DICT = null, worker = null, workerReady = false, solveId = 0, visionCtl = null;

/* ---------- persistence (per-viewer draft) ---------- */
function saveDraft() {
  try { localStorage.setItem('tilerewind.board', JSON.stringify({ text: boardText(), isSample: S.isSample })); } catch (e) {}
}
function loadDraft() {
  try { const d = JSON.parse(localStorage.getItem('tilerewind.board') || 'null'); if (d && d.text) return d; } catch (e) {}
  return null;
}

/* ---------- board text ---------- */
function boardText() {
  const rows = [];
  for (let r = 0; r < N; r++) {
    let s = '';
    for (let c = 0; c < N; c++) { const i = r * N + c, ch = S.cells[i]; s += ch ? (S.blanks.has(i) ? ch.toLowerCase() : ch) : '.'; }
    rows.push(s);
  }
  return rows.join('\n');
}
function setFromRows(rows) {
  S.cells = Array(N * N).fill(''); S.blanks = new Set(); S.unsure = new Set();
  for (let r = 0; r < N; r++) {
    const line = (rows[r] || '');
    for (let c = 0; c < N; c++) {
      const ch = line[c] || '.';
      if (/[a-z]/i.test(ch)) { S.cells[r * N + c] = ch.toUpperCase(); if (ch !== ch.toUpperCase()) S.blanks.add(r * N + c); }
    }
  }
}

/* ---------- geometry ---------- */
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
      if (r.length >= 2) runs.push({ dir, pos: r, word: r.map(i => B[i]).join('') });
    }
  }
  return runs;
}
function notation(start, dir) { const [r, c] = rc(start); return dir === 0 ? (r + 1) + COLS[c] : COLS[c] + (r + 1); }

/* ---------- checks ---------- */
function analyse() {
  const B = S.cells, n = B.filter(Boolean).length;
  const runs = allRuns(B);
  const invalid = DICT ? runs.filter(r => !DICT.has(r.word)) : [];
  const counts = {}; let blanks = 0;
  B.forEach((ch, i) => { if (!ch) return; if (S.blanks.has(i)) blanks++; else counts[ch] = (counts[ch] || 0) + 1; });
  const over = Object.keys(counts).filter(k => counts[k] > DIST[k]).map(k => ({ k, have: counts[k], max: DIST[k] }));
  // connectivity from center
  let reached = 0;
  if (B[CENTER]) {
    const seen = new Set([CENTER]), st = [CENTER];
    while (st.length) { const p = st.pop(); reached++; const [r, c] = rc(p);
      [[r, c - 1], [r, c + 1], [r - 1, c], [r + 1, c]].forEach(([a, b]) => { if (a >= 0 && a < N && b >= 0 && b < N) { const q = a * N + b; if (B[q] && !seen.has(q)) { seen.add(q); st.push(q); } } }); }
  }
  const lonely = B.map((ch, i) => i).filter(i => B[i] && lineRun(B, i, 0).length < 2 && lineRun(B, i, 1).length < 2);
  return { n, runs, invalid, counts, blanks, over, center: !!B[CENTER], connected: n > 0 && reached === n, lonely };
}
function renderChecks() {
  const a = analyse();
  const items = [];
  const add = (cls, html) => items.push(`<div class="check ${cls}"><span class="dot"></span><div>${html}</div></div>`);
  add(a.n >= 2 ? '' : 'bad', `<b>${a.n}</b> tiles on the board, ${a.runs.length} words.`);
  if (a.n) {
    if (!a.center) add('bad', 'The centre square (H8) is empty. Every game starts there.');
    else if (!a.connected) add('bad', 'Some tiles are not connected to the rest. Check for a misread or a missing tile.');
    else add('', 'All tiles connect through the centre square.');
  }
  if (a.lonely.length) add('bad', `Single tiles that form no word: ${a.lonely.map(sqName).join(', ')}.`);
  if (!DICT) add('warn', '<span class="spinner"></span>Loading the word list to check spelling…');
  else if (a.invalid.length) add('warn', `${a.invalid.length} word${a.invalid.length > 1 ? 's are' : ' is'} not in the word list. Click one to jump to it. If a word is right, leave it: the rebuild accepts every word on the final board.<div class="wordchips">${a.invalid.map((r, k) => `<span class="chip" data-start="${r.pos[0]}" data-dir="${r.dir}">${notation(r.pos[0], r.dir)} ${r.word}</span>`).join('')}</div>`);
  else if (a.runs.length) add('', 'Every word is in the word list.');
  a.over.forEach(o => add('warn', `${o.have} × ${o.k} on the board, but a set has ${o.max}. One of them is probably a blank: select it and press <span class="kbd">?</span>.`));
  if (a.blanks > 2) add('warn', `${a.blanks} blanks marked, but a set has 2.`);
  if (S.unsure.size) add('warn', `${S.unsure.size} square${S.unsure.size > 1 ? 's were' : ' was'} hard to read in the photo (marked <b style="color:var(--bad)">?</b>). Typing on a square clears the mark.`);
  $('checks').innerHTML = items.join('');
  // unseen tiles
  let left = '';
  for (const k of Object.keys(DIST)) { const m = Math.max(0, DIST[k] - (a.counts[k] || 0)); left += k.repeat(m); }
  left += '?'.repeat(Math.max(0, 2 - a.blanks));
  $('unseen').textContent = `${left.length} tiles: ${left || 'none'}`;
  const ready = DICT && workerReady;
  $('solveBtn').disabled = !ready || a.n < 2 || !a.center || !a.connected || a.lonely.length > 0;
  $('solveBtn').textContent = ready ? 'Rebuild the game' : 'Loading word list…';
  return a;
}

/* ---------- board rendering ---------- */
const boardEl = $('board'), kbd = $('kbd');
const cellEls = [];
function buildBoard() {
  $('colLabels').innerHTML = '<span></span>' + [...COLS].map(c => `<span>${c}</span>`).join('');
  $('rowLabels').innerHTML = Array.from({ length: N }, (_, r) => `<span>${r + 1}</span>`).join('');
  for (let i = 0; i < N * N; i++) {
    const d = document.createElement('div');
    d.className = 'sq ' + PREM[i];
    d.dataset.i = i;
    boardEl.appendChild(d); cellEls.push(d);
  }
}
const STAR = '<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>';
function renderBoard() {
  let show, hot = new Set(), bad = new Set();
  if (S.mode === 'replay' && S.moves) {
    show = new Set();
    for (let k = 0; k < S.step; k++) S.moves[k].tiles.forEach(i => show.add(i));
    if (S.step > 0) S.moves[S.step - 1].tiles.forEach(i => hot.add(i));
  } else if (DICT) {
    analyse().invalid.forEach(r => r.pos.forEach(i => bad.add(i)));
  }
  boardEl.classList.toggle('editable', S.mode === 'setup');
  for (let i = 0; i < N * N; i++) {
    const el = cellEls[i], ch = S.cells[i];
    const visible = ch && (!show || show.has(i));
    let html = '';
    if (visible) {
      const blank = S.blanks.has(i);
      const cls = ['tile', blank && 'blank', hot.has(i) && 'new', bad.has(i) && 'bad', S.mode === 'setup' && S.unsure.has(i) && 'unsure'].filter(Boolean).join(' ');
      html = `<div class="${cls}"><b>${ch}</b>${blank ? '' : `<i>${VAL[ch]}</i>`}</div>`;
    } else if (i === CENTER) html = STAR;
    else if (PREM[i]) html = `<span class="prem">${PREM[i].toUpperCase()}</span>`;
    const key = html + (hot.has(i) ? S.step : '');
    if (el._k !== key) { el.innerHTML = html; el._k = key; }
    el.classList.toggle('sel', S.mode === 'setup' && i === S.sel && document.activeElement === kbd);
    el.classList.toggle('dir0', S.dir === 0); el.classList.toggle('dir1', S.dir === 1);
  }
}

/* ---------- editing ---------- */
function changed() { S.isSample = false; S.moves = null; $('tab-replay').disabled = true; saveDraft(); renderChecks(); renderBoard(); }
boardEl.addEventListener('mousedown', e => {
  if (S.mode !== 'setup') return;
  const sq = e.target.closest('.sq'); if (!sq) return;
  e.preventDefault();
  const i = +sq.dataset.i;
  if (i === S.sel && document.activeElement === kbd) S.dir = 1 - S.dir;
  S.sel = i;
  kbd.focus({ preventScroll: true }); renderBoard();
});
kbd.addEventListener('focus', () => { boardEl.classList.add('focused'); renderBoard(); });
kbd.addEventListener('blur', () => { boardEl.classList.remove('focused'); renderBoard(); });
function editKey(k) {
  if (S.mode !== 'setup') return false;
  const [r, c] = rc(S.sel);
  const move = (dr, dc) => { const nr = Math.min(N - 1, Math.max(0, r + dr)), nc = Math.min(N - 1, Math.max(0, c + dc)); S.sel = nr * N + nc; };
  const clear = () => { S.cells[S.sel] = ''; S.blanks.delete(S.sel); S.unsure.delete(S.sel); };
  if (/^[a-zA-Z]$/.test(k)) {
    S.cells[S.sel] = k.toUpperCase(); S.blanks.delete(S.sel); S.unsure.delete(S.sel);
    S.dir === 0 ? move(0, 1) : move(1, 0); changed();
  } else if (k === '?' || k === '*') {
    if (S.cells[S.sel]) { S.blanks.has(S.sel) ? S.blanks.delete(S.sel) : S.blanks.add(S.sel); S.unsure.delete(S.sel); changed(); }
  } else if (k === 'Backspace') {
    if (!S.cells[S.sel]) S.dir === 0 ? move(0, -1) : move(-1, 0);
    clear(); changed();
  } else if (k === 'Delete' || k === ' ' || k === '.') {
    clear();
    if (k !== 'Delete') S.dir === 0 ? move(0, 1) : move(1, 0);
    changed();
  } else if (k === 'ArrowLeft') move(0, -1);
  else if (k === 'ArrowRight') move(0, 1);
  else if (k === 'ArrowUp') move(-1, 0);
  else if (k === 'ArrowDown') move(1, 0);
  else if (k === 'Enter') S.dir = 1 - S.dir;
  else return false;
  renderBoard();
  return true;
}
kbd.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Unidentified' || e.key === 'Process') return;
  if (editKey(e.key)) e.preventDefault();
});
// phone keyboards often skip keydown details; read what they insert instead
kbd.addEventListener('beforeinput', e => {
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); editKey('Backspace'); }
});
kbd.addEventListener('input', () => {
  const v = kbd.value; kbd.value = '';
  for (const ch of v) editKey(ch);
});
$('checks').addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  S.sel = +chip.dataset.start; S.dir = +chip.dataset.dir; kbd.focus({ preventScroll: true }); renderBoard();
});
$('sampleBtn').onclick = () => { setFromRows(SAMPLE); S.isSample = true; S.moves = null; $('tab-replay').disabled = true; saveDraft(); renderChecks(); renderBoard(); };
$('clearBtn').onclick = () => { setFromRows([]); changed(); };
$('textBtn').onclick = () => { $('textArea').value = boardText(); $('textBox').hidden = false; $('textArea').focus(); };
$('cancelText').onclick = () => { $('textBox').hidden = true; };
$('applyText').onclick = () => {
  const rows = $('textArea').value.split(/\r?\n/).map(s => s.replace(/\s+$/, '')).filter(s => s.trim().length);
  setFromRows(rows); $('textBox').hidden = true; changed();
};
$('copyBtn').onclick = async () => {
  const t = boardText();
  try { await navigator.clipboard.writeText(t); flash($('copyBtn'), 'Copied'); }
  catch (e) { $('textArea').value = t; $('textBox').hidden = false; $('textArea').select(); }
};
function flash(btn, text) { const old = btn.textContent; btn.textContent = text; setTimeout(() => btn.textContent = old, 1400); }

/* ---------- photo reading ---------- */
const visionStatus = (text, cls = '') => { const s = $('visionStatus'); s.hidden = !text; s.className = 'status ' + cls; s.innerHTML = text; };
let picker = null;
async function setFile(f) {
  if (!f || !/^image\//.test(f.type)) { visionStatus('That file is not an image. Choose a JPEG, PNG or WebP photo.', 'err'); return; }
  S.file = f;
  const url = URL.createObjectURL(f);
  $('thumb').innerHTML = `<img alt="Board photo" src="${url}">`;
  $('dropTitle').textContent = f.name;
  $('warpBox').hidden = true;
  visionStatus('');
  try {
    S.image = await loadWorkingImage(f);
    if (picker) picker.destroy();
    picker = new CornerPicker($('picker'), S.image);
    renderMethod();
  } catch (e) {
    S.file = null; visionStatus('That image could not be opened. Try a JPEG or PNG.', 'err');
  }
  updateReadBtn();
}
function method() { const el = document.querySelector('input[name="method"]:checked'); return el ? el.value : 'local'; }
function renderMethod() {
  const m = method();
  $('keyRow').hidden = m !== 'claude';
  $('pickerBox').hidden = m !== 'local' || !S.image;
  if (!$('pickerBox').hidden && picker) picker.draw();
}
document.querySelectorAll('input[name="method"]').forEach(r => r.addEventListener('change', () => {
  try { localStorage.setItem('tilerewind.method', method()); } catch (e) {}
  renderMethod();
}));
$('rotateBtn').onclick = () => picker && picker.rotate();
function updateReadBtn() { $('readBtn').disabled = !S.file || !!visionCtl; }
$('file').onchange = e => setFile(e.target.files[0]);
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0]); });
document.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(x => /^image\//.test(x.type)); if (f) setFile(f); });

$('readBtn').onclick = async () => {
  const local = method() === 'local';
  const key = getKey();
  if (!local && !key) { openKeyDialog(); return; }
  visionCtl = new AbortController();
  updateReadBtn(); $('stopBtn').hidden = false;
  visionStatus(local
    ? '<span class="spinner"></span>Reading the board on this device…'
    : '<span class="spinner"></span>Reading the board. Careful reading of all 225 squares usually takes 30 to 90 seconds.');
  try {
    const res = local
      ? await readBoardLocally(S.image, picker.pts, {
          signal: visionCtl.signal,
          isWord: w => !DICT || DICT.has(w),
          onProgress: t => visionStatus('<span class="spinner"></span>' + escapeHtml(t)),
        })
      : await readBoard(S.file, key, visionCtl.signal);
    setFromRows(res.rows);
    res.unsure.forEach(p => S.unsure.add(p[0] * N + p[1]));
    S.isSample = false; S.moves = null; $('tab-replay').disabled = true; saveDraft();
    const a = renderChecks(); renderBoard();
    if (res.board) { $('warpImg').src = res.board.toDataURL('image/jpeg', 0.85); $('warpBox').hidden = false; }
    visionStatus(`Read ${a.n} tiles. ${res.note ? escapeHtml(res.note) + ' ' : ''}Compare the board with your photo and fix anything that's off before rebuilding.`, 'good');
  } catch (e) {
    if (e && e.code === 'cancelled') visionStatus('Stopped.');
    else visionStatus(escapeHtml((e && e.code && e.message) || 'Something went wrong reading the photo. Try again.'), 'err');
    if (e && e.code === 'auth') renderKeyState();
  } finally {
    visionCtl = null; $('stopBtn').hidden = true; updateReadBtn();
  }
};

/* ---------- API key ---------- */
const keyDialog = $('keyDialog');
function renderKeyState() {
  const k = getKey();
  $('keyState').textContent = k ? `Using your Claude API key ending in ${k.slice(-4)}.` : 'The Claude option uses your own API key. You pay Anthropic for what you use.';
  $('keyBtn').textContent = k ? 'Change key' : 'Set API key';
}
function openKeyDialog() { $('keyInput').value = ''; $('keyRemove').hidden = !getKey(); keyDialog.showModal(); $('keyInput').focus(); }
$('keyBtn').onclick = openKeyDialog;
$('keyForm').addEventListener('submit', e => {
  const action = e.submitter ? e.submitter.value : 'save';
  if (action === 'save' && $('keyInput').value.trim()) setKey($('keyInput').value.trim());
  else if (action === 'remove') setKey('');
  $('keyInput').value = '';
  renderKeyState();
});
$('stopBtn').onclick = () => visionCtl && visionCtl.abort();
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- solving ---------- */
function startWorker() {
  worker = new Worker('js/solver.js');
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { workerReady = true; renderChecks(); if (S.autoSolve) { S.autoSolve = false; runSolve(); } }
    else if (m.type === 'result' && m.id === solveId) onResult(m);
  };
}
const solveStatus = (text, cls = '') => { const s = $('solveStatus'); s.hidden = !text; s.className = 'status ' + cls; s.innerHTML = text; };
let pendingStrict = true;
function runSolve() {
  const strict = $('strict').checked;
  pendingStrict = strict;
  post(strict);
}
function post(strict) {
  solveId++;
  $('solveBtn').disabled = true;
  solveStatus(`<span class="spinner"></span>${strict ? 'Working backwards from the final board…' : 'Trying again without checking earlier words…'}`);
  worker.postMessage({ type: 'solve', id: solveId, cells: S.cells, strict, seed: S.seed, timeLimit: strict ? 15000 : 8000 });
}
function onResult(m) {
  if (!m.ok && m.strict) {
    // fall back to a geometry-only rebuild
    S.fallback = m.reason;
    post(false); return;
  }
  renderChecks();
  if (!m.ok) {
    solveStatus(m.reason === 'shape'
      ? 'The tiles have to connect to each other through the centre square. Fix the board and try again.'
      : 'No order of moves fits this board. A tile is probably misread or missing: check the flagged words.', 'err');
    return;
  }
  const note = m.strict ? '' : (S.fallback === 'timeout'
    ? 'The dictionary search ran out of time, so earlier positions may include partial words that are not in the word list.'
    : 'No order fits with dictionary words at every stage, so earlier positions may include partial words. A misread tile is the usual cause.');
  S.fallback = null;
  S.moves = scoreMoves(m.moves);
  S.racks = deduceRacks(S.moves, S.cells, S.blanks, S.players);
  S.meta = { ms: m.ms, nodes: m.nodes, strict: m.strict, note };
  solveStatus('');
  S.step = 1;
  setMode('replay');
}
$('solveBtn').onclick = () => { S.seed = 0; S.players = +$('players').value; runSolve(); };
$('anotherBtn').onclick = () => { S.seed = (S.seed || 0) + 1 + Math.floor(Math.random() * 1000); setMode('setup'); runSolve(); };

function scoreMoves(raw) {
  const B = Array(N * N).fill('');
  const totals = Array(S.players).fill(0);
  return raw.map((m, k) => {
    m.tiles.forEach(i => B[i] = S.cells[i]);
    const placed = new Set(m.tiles);
    let dir = m.dir;
    if (m.tiles.length === 1) {
      const h = lineRun(B, m.tiles[0], 0).length, v = lineRun(B, m.tiles[0], 1).length;
      dir = h >= v ? 0 : 1;
    }
    const words = [];
    const main = lineRun(B, m.tiles[0], dir);
    if (main.length >= 2) words.push(main);
    m.tiles.forEach(i => { const x = lineRun(B, i, 1 - dir); if (x.length >= 2) words.push(x); });
    let score = 0;
    const wordScores = words.map(w => {
      let s = 0, mult = 1;
      w.forEach(i => {
        let v = S.blanks.has(i) ? 0 : VAL[B[i]];
        if (placed.has(i)) {
          if (PREM[i] === 'dl') v *= 2; else if (PREM[i] === 'tl') v *= 3;
          else if (PREM[i] === 'dw') mult *= 2; else if (PREM[i] === 'tw') mult *= 3;
        }
        s += v;
      });
      score += s * mult;
      return s * mult;
    });
    const bingo = m.tiles.length === 7;
    if (bingo) score += 50;
    const player = k % S.players;
    totals[player] += score;
    return { tiles: m.tiles, dir, main, words, wordScores, score, bingo, player, total: totals[player], placed };
  });
}

/* ---------- racks ---------- */
const tileValue = t => t.ch === '?' ? 0 : VAL[t.ch];
function rackTile(t, cls, title) {
  const face = t.ch === '?' ? `<small>${t.as ? escapeHtml(t.as) : ''}</small>` : `${t.ch}<i>${VAL[t.ch]}</i>`;
  return `<span class="rtile ${cls}" title="${escapeHtml(title)}">${face}</span>`;
}
const slot = (cls, title, text = '?') => `<span class="rtile ${cls}" title="${escapeHtml(title)}">${text}</span>`;
const miniTiles = list => list.map(t => `<span class="mini">${t.ch === '?' ? '?' : t.ch}</span>`).join('');
function moveSpan(list) {
  const nums = [...new Set(list.map(t => t.move + 1))].sort((a, b) => a - b);
  if (!nums.length) return '';
  return nums.length === 1 ? `move ${nums[0]}` : nums.length === 2 ? `moves ${nums[0]} and ${nums[1]}` : `moves ${nums[0]}–${nums[nums.length - 1]}`;
}
const tileWord = n => `${n} tile${n === 1 ? '' : 's'}`;

function renderRack() {
  const R = S.racks;
  if (!R || !R.racks.length) return;
  const g = Math.max(0, S.step - 1), r = R.racks[g];
  $('rackTitle').innerHTML = `Rack <span class="n">Player ${r.player + 1}, before move ${g + 1}</span>`;
  const html = [];
  r.played.forEach(t => html.push(rackTile(t, 'played', 'Played on this move')));
  r.kept.forEach(t => html.push(rackTile(t, 'kept', `Already held, played on move ${t.move + 1}`)));
  if (r.group) for (let i = 0; i < r.group.need; i++) html.push(slot('group', 'One of the tiles listed below'));
  r.left.forEach(t => html.push(rackTile(t, 'left', 'Still on the rack when the game ended')));
  if (r.leftGroup) for (let i = 0; i < r.leftGroup.need; i++) html.push(slot('group', 'One of the tiles left at the end'));
  for (let i = 0; i < r.unknown + r.leftUnknown; i++) html.push(slot('unknown', 'Unknown tile'));
  $('rack').innerHTML = html.join('');

  const notes = [];
  const item = (swatch, text) => notes.push(`<div class="rnote"><span class="rtile mini-sw ${swatch}"></span><div>${text}</div></div>`);
  item('played', `Played this move: ${miniTiles(r.played)}`);
  if (r.kept.length) item('kept', `Already on the rack, played later on ${moveSpan(r.kept)}.`);
  if (r.group) item('group', `At least ${tileWord(r.group.need)} from these, played on ${moveSpan(r.group.from)}: ${miniTiles(r.group.from)}`);
  if (r.left.length) item('left', 'Still on the rack when the game ended.');
  if (r.leftGroup) item('group', `At least ${tileWord(r.leftGroup.need)} of the tiles left at the end: ${miniTiles(r.leftGroup.from)}`);
  const unk = r.unknown + r.leftUnknown;
  if (unk) item('unknown', `${tileWord(unk)} can't be identified from the board.`);
  notes.push(`<p class="note">Bag before this move: ${tileWord(r.bagBefore)}. ${r.bagBefore ? `Player ${r.player + 1} then drew ${r.drew}.` : 'The bag is empty, so nothing new is drawn.'}</p>`);
  if (r.over) notes.push('<p class="note">This move uses more tiles than the player could have held, so the rebuilt order is probably wrong here. Try another order.</p>');
  $('rackNotes').innerHTML = notes.join('');
}

// Standard ending: the player who goes out gains the value of every other rack; the others lose theirs.
function endgameAdjust() {
  const e = S.racks && S.racks.endgame;
  if (!e) return null;
  const delta = Array(S.players).fill(0);
  e.left.forEach((tiles, p) => { const v = tiles.reduce((s, t) => s + tileValue(t), 0); delta[p] -= v; delta[e.out] += v; });
  return { ...e, delta };
}
function renderEndgame(adj) {
  const el = $('endgame'), R = S.racks;
  if (!R) { el.hidden = true; return; }
  if (adj) {
    const others = adj.left.map((t, p) => t.length ? `Player ${p + 1} was left with ${miniTiles(t)} (−${-adj.delta[p]})` : '').filter(Boolean);
    el.innerHTML = `End of game: Player ${adj.out + 1} used their last tile${others.length ? `. ${others.join('; ')}, so Player ${adj.out + 1} gets +${adj.delta[adj.out]}` : ''}. The final scores include this.`;
  } else if (R.bagEnd > 0) {
    el.textContent = `The bag would still hold ${tileWord(R.bagEnd)}, so the game wasn't finished when the photo was taken (or tiles were exchanged). No end-of-game adjustment is applied.`;
  } else {
    el.textContent = 'The bag ran out, but no player used their last tile in the rebuilt order, so the end-of-game adjustment is left out.';
  }
  el.hidden = false;
}

/* ---------- replay ---------- */
function wordHtml(pos, placed) {
  return pos.map(i => {
    const cls = [placed.has(i) ? '' : 'thru', S.blanks.has(i) ? 'bl' : ''].filter(Boolean).join(' ');
    return cls ? `<span class="${cls}">${S.cells[i]}</span>` : S.cells[i];
  }).join('');
}
function renderReplay() {
  const mv = S.moves, n = mv.length;
  $('replayTitle').innerHTML = `Reconstructed game ${S.isSample ? '<span class="badge">Sample game</span>' : ''}`;
  const now = Array(S.players).fill(0);
  for (let k = 0; k < S.step; k++) now[mv[k].player] += mv[k].score;
  const fin = Array(S.players).fill(0); mv.forEach(m => fin[m.player] += m.score);
  const adj = endgameAdjust();
  const nextP = S.step < n ? mv[S.step].player : -1;
  $('scores').innerHTML = now.map((v, p) => {
    const a = adj ? adj.delta[p] : 0;
    const finText = a ? `final ${fin[p] + a} <span title="End-of-game tiles">(${a > 0 ? '+' : '−'}${Math.abs(a)})</span>` : `final ${fin[p]}`;
    return `<div class="pl ${p === nextP ? 'turn' : ''}"><div class="who">Player ${p + 1}${p === nextP ? ' · to play' : ''}</div><div class="pts">${v + (S.step === n ? a : 0)}</div><div class="fin">${finText}</div></div>`;
  }).join('');
  const tiles = S.cells.filter(Boolean).length;
  $('replayMeta').textContent = `${n} moves, ${tiles} tiles, ${mv.filter(m => m.bingo).length} using all seven tiles. Player 1 is assumed to have moved first. Found in ${(S.meta.ms / 1000).toFixed(1)} s. ${S.meta.note}`;
  renderEndgame(adj);
  renderRack();
  $('moveRows').innerHTML = mv.map((m, k) => {
    const cross = m.words.slice(m.words[0] === m.main ? 1 : 0);
    const crossHtml = cross.length ? `<div class="cross">+ ${cross.map(w => w.map(i => S.cells[i]).join('')).join(', ')}</div>` : '';
    const mainPos = m.main.length >= 2 ? m.main : m.words[0];
    return `<tr class="mv ${k === S.step - 1 ? 'cur' : ''} ${k >= S.step ? 'future' : ''}" data-k="${k}">
      <td>${k + 1}</td><td>P${m.player + 1}</td><td class="not">${notation(mainPos[0], m.main.length >= 2 ? m.dir : 1 - m.dir)}</td>
      <td><span class="word">${wordHtml(mainPos, m.placed)}</span>${m.bingo ? '<span class="bingo">BINGO</span>' : ''}${crossHtml}</td>
      <td class="num">${m.score}</td><td class="num">${m.total}</td></tr>`;
  }).join('');
  $('tSlider').max = n; $('tSlider').value = S.step;
  $('tNum').textContent = `${S.step} / ${n}`;
  $('tPrev').disabled = $('tFirst').disabled = S.step === 0;
  $('tNext').disabled = $('tLast').disabled = S.step === n;
  const cur = $('moveRows').querySelector('tr.cur'), wrap = $('movesWrap');
  if (cur) {
    const top = cur.offsetTop, bottom = top + cur.offsetHeight;
    if (top < wrap.scrollTop + 34) wrap.scrollTop = top - 34;
    else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight;
  }
}
function goto(k) { S.step = Math.max(0, Math.min(S.moves.length, k)); renderReplay(); renderBoard(); }
$('moveRows').addEventListener('click', e => { const tr = e.target.closest('tr.mv'); if (tr) { stopPlay(); goto(+tr.dataset.k + 1); } });
$('tFirst').onclick = () => { stopPlay(); goto(0); };
$('tPrev').onclick = () => { stopPlay(); goto(S.step - 1); };
$('tNext').onclick = () => { stopPlay(); goto(S.step + 1); };
$('tLast').onclick = () => { stopPlay(); goto(S.moves.length); };
$('tSlider').oninput = e => { stopPlay(); goto(+e.target.value); };
$('tPlay').onclick = () => {
  if (S.playTimer) { stopPlay(); return; }
  if (S.step >= S.moves.length) goto(0);
  $('playIcon').innerHTML = '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>'; $('tPlay').setAttribute('aria-label', 'Pause');
  S.playTimer = setInterval(() => { if (S.step >= S.moves.length) stopPlay(); else goto(S.step + 1); }, 1100);
};
function stopPlay() {
  if (S.playTimer) clearInterval(S.playTimer); S.playTimer = null;
  $('playIcon').innerHTML = '<path d="M4 2v12l10-6z"/>'; $('tPlay').setAttribute('aria-label', 'Play');
}
document.addEventListener('keydown', e => {
  if (S.mode !== 'replay' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === 'ArrowRight') { stopPlay(); goto(S.step + 1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { stopPlay(); goto(S.step - 1); e.preventDefault(); }
});

/* ---------- modes ---------- */
function setMode(mode) {
  stopPlay();
  S.mode = mode;
  $('setup').hidden = mode !== 'setup';
  $('replay').hidden = mode !== 'replay';
  $('transport').hidden = mode !== 'replay';
  $('tab-setup').setAttribute('aria-selected', mode === 'setup');
  $('tab-replay').setAttribute('aria-selected', mode === 'replay');
  $('tab-replay').disabled = !S.moves;
  if (mode === 'replay') renderReplay(); else renderChecks();
  renderBoard();
}
$('tab-setup').onclick = () => setMode('setup');
$('tab-replay').onclick = () => S.moves && setMode('replay');
$('editBtn').onclick = () => setMode('setup');

/* ---------- boot ---------- */
buildBoard();
const draft = loadDraft();
if (draft) { setFromRows(draft.text.split('\n')); S.isSample = !!draft.isSample; }
else { setFromRows(SAMPLE); S.isSample = true; }
S.autoSolve = S.isSample;
renderChecks(); renderBoard();
startWorker();
fetch('data/words.txt').then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }).then(text => {
  DICT = new Set(text.split('\n').filter(Boolean).map(w => w.trim().toUpperCase()));
  worker.postMessage({ type: 'dict', text });
  renderChecks(); renderBoard();
}).catch(() => {
  solveStatus('The word list did not load. Reload the page to try again.', 'err');
});
renderKeyState();
try { const m = localStorage.getItem('tilerewind.method'); const el = m && document.querySelector(`input[name="method"][value="${m}"]`); if (el) el.checked = true; } catch (e) {}
renderMethod();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
