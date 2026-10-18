import { readBoard, getKey, setKey, explainMove } from './vision.js';
import { CornerPicker, loadWorkingImage, readBoardLocally } from './localreader.js';
import { deduceRacks, estimateRacks } from './racks.js';
import { createPractice } from './practice.js';
import { createSimulator, simSectionHtml } from './simulate.js';
import * as explainFacts from './explain.js';

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
const tileMarkup = (ch, blank, cls) => `<div class="tile${blank ? ' blank' : ''}${cls ? ' ' + cls : ''}"><b>${ch}</b>${blank ? '' : `<i>${VAL[ch]}</i>`}</div>`;
function emptySquare(i) { return i === CENTER ? STAR : PREM[i] ? `<span class="prem">${PREM[i].toUpperCase()}</span>` : ''; }
// Practice mode draws its own game: placed tiles, tiles waiting to be played, and previews.
function renderPracticeBoard() {
  const v = practice && practice.view();
  if (!v) return;
  boardEl.classList.add('editable');
  const focused = document.activeElement === kbd;
  for (let i = 0; i < N * N; i++) {
    const el = cellEls[i];
    let html;
    if (v.ghost && v.ghost.has(i)) { const t = v.ghost.get(i); html = tileMarkup(t.ch, t.blank, t.threat ? 'threat' : 'suggest'); }
    else if (v.pending.has(i)) { const t = v.pending.get(i); html = tileMarkup(t.ch, t.blank, 'pending'); }
    else if (v.cells[i]) html = tileMarkup(v.cells[i], v.blanks.has(i), v.hot.has(i) ? 'new' : '');
    else html = emptySquare(i);
    const key = 'p' + html;
    if (el._k !== key) { el.innerHTML = html; el._k = key; }
    el.classList.toggle('sel', i === v.cursor && focused);
    el.classList.toggle('dir0', v.dir === 0); el.classList.toggle('dir1', v.dir === 1);
  }
}
function renderBoard() {
  if (S.mode === 'practice') { renderPracticeBoard(); return; }
  let show, hot = new Set(), bad = new Set(), ghost = null;
  if (S.mode === 'replay' && S.moves) {
    show = new Set();
    // previewing a Quackle suggestion: the board before the move, with the suggestion on it
    const pv = S.preview && S.preview.g === S.step - 1 ? S.preview : null;
    const upTo = pv ? S.step - 1 : S.step;
    for (let k = 0; k < upTo; k++) S.moves[k].tiles.forEach(i => show.add(i));
    if (pv) ghost = pv.tiles;
    else if (S.step > 0) S.moves[S.step - 1].tiles.forEach(i => hot.add(i));
  } else if (DICT) {
    analyse().invalid.forEach(r => r.pos.forEach(i => bad.add(i)));
  }
  boardEl.classList.toggle('editable', S.mode === 'setup');
  for (let i = 0; i < N * N; i++) {
    const el = cellEls[i], ch = S.cells[i];
    const visible = ch && (!show || show.has(i));
    let html = '';
    if (ghost && ghost.has(i)) {
      const t = ghost.get(i);
      html = `<div class="tile suggest${t.blank ? ' blank' : ''}"><b>${t.ch}</b>${t.blank ? '' : `<i>${VAL[t.ch]}</i>`}</div>`;
    } else if (visible) {
      const blank = S.blanks.has(i);
      const cls = ['tile', blank && 'blank', hot.has(i) && 'new', bad.has(i) && 'bad', S.mode === 'setup' && S.unsure.has(i) && 'unsure'].filter(Boolean).join(' ');
      html = `<div class="${cls}"><b>${ch}</b>${blank ? '' : `<i>${VAL[ch]}</i>`}</div>`;
    } else if (i === CENTER) html = STAR;
    else if (PREM[i]) html = `<span class="prem">${PREM[i].toUpperCase()}</span>`;
    const key = html + (hot.has(i) ? S.step : '') + (ghost && ghost.has(i) ? 'g' : '');
    if (el._k !== key) { el.innerHTML = html; el._k = key; }
    el.classList.toggle('sel', S.mode === 'setup' && i === S.sel && document.activeElement === kbd);
    el.classList.toggle('dir0', S.dir === 0); el.classList.toggle('dir1', S.dir === 1);
  }
}

/* ---------- editing ---------- */
function changed() { S.isSample = false; S.moves = null; $('tab-replay').disabled = true; saveDraft(); renderChecks(); renderBoard(); }
boardEl.addEventListener('mousedown', e => {
  if (S.mode === 'practice') {
    const sq = e.target.closest('.sq'); if (!sq) return;
    e.preventDefault();
    const wasActive = document.activeElement === kbd;
    kbd.focus({ preventScroll: true });
    practice.clickSquare(+sq.dataset.i, wasActive);
    return;
  }
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
const PRACTICE_KEYS = /^([a-zA-Z]|Backspace|Enter|Escape| |Arrow(Left|Right|Up|Down))$/;
// One key, whichever mode is showing.
function boardKey(k) {
  if (S.mode === 'practice') { if (!PRACTICE_KEYS.test(k)) return false; practice.key(k); return true; }
  return editKey(k);
}
kbd.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Unidentified' || e.key === 'Process') return;
  if (boardKey(e.key)) e.preventDefault();
});
// phone keyboards often skip keydown details; read what they insert instead
kbd.addEventListener('beforeinput', e => {
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); boardKey('Backspace'); }
});
kbd.addEventListener('input', () => {
  const v = kbd.value; kbd.value = '';
  for (const ch of v) boardKey(ch);
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
  S.est = estimateRacks(S.moves, S.cells, S.blanks, S.players, S.racks);
  S.preview = null; QK.results = {}; QK.sims = {}; QK.token = null;
  S.meta = { ms: m.ms, nodes: m.nodes, strict: m.strict, note };
  solveStatus('');
  S.step = 1;
  setMode('replay');
  if (QK.state === 'ready') qkRunAll();
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
const miniTiles = list => list.map(t => `<span class="mini">${t.ch === '?' ? '?' : t.ch}</span>`).join('');
const tileWord = n => `${n} tile${n === 1 ? '' : 's'}`;

// One shelf per player under the board, showing what they hold at this point of the game.
function renderShelves() {
  if (!S.est) return;
  const states = S.est.at(S.step), totals = Array(S.players).fill(0);
  for (let k = 0; k < S.step; k++) totals[S.moves[k].player] += S.moves[k].score;
  $('shelfList').innerHTML = states.map(st => {
    const p = st.player, mover = st.mode === 'played';
    const label = mover ? `played move ${st.move + 1}` : st.mode === 'final' ? 'left at the end' : S.step === 0 ? 'opening rack' : 'holding';
    const tiles = st.tiles.map(r => {
      const t = r.tile;
      if (t.unknown) return `<span class="rtile unknown" title="A tile this player never played. It can't be identified from the board.">?</span>`;
      const pct = Math.round(r.prob * 100);
      const cls = [mover && r.now ? 'played' : '', r.certain ? '' : 'likely'].filter(Boolean).join(' ');
      const title = mover && r.now ? 'Played on this move' : r.certain ? (t.final ? 'Certain: still held at the end' : `Certain: played on move ${t.move + 1}`)
        : `${pct}% likely on the rack now${t.final ? '; still held at the end' : `; played on move ${t.move + 1}`}`;
      const face = t.ch === '?' ? `<small>${escapeHtml(t.as || '')}</small>` : `${t.ch}<i>${VAL[t.ch]}</i>`;
      return `<span class="rtile ${cls}" style="${r.certain ? '' : `--p:${Math.max(0.35, r.prob).toFixed(2)}`}" title="${escapeHtml(title)}">${face}${r.certain ? '' : `<em>${pct}%</em>`}</span>`;
    }).join('');
    return `<div class="shelf ${mover ? 'mover' : ''}">
      <div class="shelf-head"><b>Player ${p + 1}</b><span class="shelf-pts">${totals[p]}</span><span class="shelf-tag">${label}</span></div>
      <div class="rack">${tiles || '<span class="hint">No tiles</span>'}</div></div>`;
  }).join('');
  const r = S.racks.racks[Math.min(S.moves.length - 1, Math.max(0, S.step - 1))];
  const bagNow = S.step === 0 ? Math.max(0, 100 - 7 * S.players) : r.bagBefore - r.drew;
  $('bagCount').textContent = `Bag: ${tileWord(bagNow)}`;
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

/* ---------- Quackle move analysis ---------- */
// The engine runs in a worker and is only downloaded when asked for.
const QK = { state: 'idle', worker: null, results: {}, sims: {}, pending: new Map(), nextId: 1, token: null, leaves: true, error: '' };

// A reconstructed move in Quackle's notation: '.' for letters already down, lowercase for blanks.
function qkMoveLine(m) {
  const pos = m.main.length >= 2 ? m.main : m.words[0];
  const dir = m.main.length >= 2 ? m.dir : 1 - m.dir;
  const word = pos.map(i => m.placed.has(i) ? (S.blanks.has(i) ? S.cells[i].toLowerCase() : S.cells[i]) : '.').join('');
  return { player: m.player, place: notation(pos[0], dir), word };
}
// The mover's best-estimate rack; tiles that can't be named are left out.
function qkRack(g) {
  const st = S.est.at(g + 1).find(s => s.mode === 'played');
  const known = st ? st.tiles.filter(r => !r.tile.unknown) : [];
  return {
    letters: known.map(r => r.tile.ch).join(''), tiles: known,
    certain: known.filter(r => r.certain).length, likely: known.filter(r => !r.certain).length,
    unknown: st ? st.tiles.length - known.length : 0,
  };
}
function qkInput(g, rack) {
  const lines = ['players ' + S.players];
  for (let k = 0; k < g; k++) { const l = qkMoveLine(S.moves[k]); lines.push(`move ${l.player} ${l.place} ${l.word}`); }
  const a = qkMoveLine(S.moves[g]);
  lines.push(`rack ${a.player} ${rack.letters}`, `actual ${a.place} ${a.word}`, 'top 6');
  return lines.join('\n');
}
function qkSend(msg) {
  return new Promise(res => { const id = QK.nextId++; QK.pending.set(id, res); QK.worker.postMessage({ ...msg, id }); });
}
// Make sure the engine is using the chosen word list before it analyses anything.
function qkSyncLexicon() {
  if (QK.lexApplied === LEX.key) return Promise.resolve();
  if (QK.lexSyncing && QK.lexSyncing.key === LEX.key) return QK.lexSyncing.promise;
  const key = LEX.key;
  const promise = qkSend({ type: 'lexicon', words: LEX.builtin ? null : LEX.words, name: LEX.name, collins: LEX.collins }).then(r => {
    if (!r.ok) throw new Error(r.error || 'Quackle could not use this word list.');
    QK.lexApplied = key;
  }).finally(() => { if (QK.lexSyncing && QK.lexSyncing.key === key) QK.lexSyncing = null; });
  QK.lexSyncing = { key, promise };
  return promise;
}
async function qkCall(input) {
  try { await qkSyncLexicon(); }
  catch (e) { return { ok: false, error: e.message }; }
  return qkSend({ type: 'analyse', input });
}
// Resolves once the engine is ready, loading it if needed.
function qkReady() {
  if (QK.state === 'ready') return Promise.resolve();
  const p = new Promise((res, rej) => { (QK.waiters = QK.waiters || []).push({ res, rej }); });
  if (QK.state !== 'loading') qkLoad();
  return p;
}
function qkSettle(ok, err) {
  (QK.waiters || []).forEach(w => ok ? w.res() : w.rej(new Error(err)));
  QK.waiters = [];
  if (practice && S.mode === 'practice') practice.render();
}
function qkLoad() {
  QK.state = 'loading'; QK.error = ''; renderAnalysis();
  try { QK.worker = new Worker('js/quackle-worker.js', { type: 'module' }); }
  catch (e) { QK.state = 'error'; QK.error = 'This browser cannot run the engine.'; renderAnalysis(); return; }
  QK.worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { QK.state = 'ready'; QK.leaves = m.leaves; qkSettle(true); qkRunAll(); }
    else if (m.type === 'error') { QK.state = 'error'; QK.error = m.message; qkSettle(false, m.message); renderAnalysis(); }
    else if (m.type === 'result') { const r = QK.pending.get(m.id); QK.pending.delete(m.id); if (r) r(m.result); }
  };
  QK.worker.onerror = () => { QK.state = 'error'; QK.error = 'The engine could not be downloaded. Check your connection and try again.'; qkSettle(false, QK.error); renderAnalysis(); };
  QK.worker.postMessage({ type: 'load' });
}
// Analyse every move: the one on screen first, then the rest in order.
async function qkRunAll() {
  if (QK.state !== 'ready' || !S.moves) return;
  const token = QK.token = {};
  QK.results = {};
  renderReplay();
  const cur = Math.max(0, S.step - 1);
  const order = [cur, ...[...S.moves.keys()].filter(g => g !== cur)];
  for (const g of order) {
    const rack = qkRack(g);
    const res = await qkCall(qkInput(g, rack));
    if (QK.token !== token) return;
    let loss = null;
    if (res.ok && res.moves.length && res.actual) loss = res.actualRank === 0 ? 0 : Math.max(0, res.moves[0].equity - res.actual.equity);
    QK.results[g] = { ...res, rackInfo: rack, loss };
    const done = Object.keys(QK.results).length;
    if (g === Math.max(0, S.step - 1) || done % 6 === 0 || done === S.moves.length) renderReplay();
  }
}
function qkCell(k) {
  if (QK.state !== 'ready') return '';
  const r = QK.results[k];
  if (!r) return '<td class="num qk">…</td>';
  if (r.loss === null) return '<td class="num qk">–</td>';
  return r.loss < 0.05 ? '<td class="num qk best" title="Quackle\'s top play">✓</td>' : `<td class="num qk" title="Equity given up">−${r.loss.toFixed(1)}</td>`;
}
// Squares a suggested play covers, for previewing it on the board.
function qkTiles(move) {
  const COLS_ = 'ABCDEFGHIJKLMNO';
  const h = /^(\d+)([A-O])$/i.exec(move.place), v = /^([A-O])(\d+)$/i.exec(move.place);
  if (!h && !v) return null;
  const r0 = h ? +h[1] - 1 : +v[2] - 1, c0 = COLS_.indexOf((h ? h[2] : v[1]).toUpperCase()), dr = h ? 0 : 1, dc = h ? 1 : 0;
  const out = [];
  [...move.tiles].forEach((ch, k) => {
    const i = (r0 + dr * k) * N + c0 + dc * k;
    out.push({ i, ch: ch === '.' ? S.cells[i] : ch.toUpperCase(), blank: ch !== '.' && ch !== ch.toUpperCase(), thru: ch === '.' });
  });
  return out;
}
function qkWord(move) {
  if (move.action === 'exchange') return `Exchange ${escapeHtml(move.tiles)}`;
  if (move.action === 'pass') return 'Pass';
  const t = qkTiles(move);
  if (!t) return escapeHtml(move.word);
  return t.map(x => x.thru ? `<span class="thru">${x.ch}</span>` : x.blank ? `<span class="bl">${x.ch.toLowerCase()}</span>` : x.ch).join('');
}
function qkLeave(rack, tiles) {
  const left = [...rack];
  for (const ch of tiles) {
    if (ch === '.') continue;
    const want = ch !== ch.toUpperCase() ? '?' : ch, i = left.indexOf(want);
    if (i >= 0) left.splice(i, 1);
  }
  return left.join('') || '–';
}
const sameMove = (a, b) => a && b && a.place === b.place && a.tiles === b.tiles;

function renderAnalysis() {
  const body = $('qkBody'), title = $('qkTitle');
  if (!body) return;
  $('replay').querySelectorAll('.qk-col').forEach(el => { el.hidden = QK.state !== 'ready'; });
  if (QK.state === 'idle') { title.textContent = 'Move analysis'; return; }
  if (QK.state === 'loading') {
    title.textContent = 'Move analysis';
    body.innerHTML = '<p class="status"><span class="spinner"></span>Loading Quackle and its word list…</p>';
    return;
  }
  if (QK.state === 'error') {
    body.innerHTML = `<p class="status err">${escapeHtml(QK.error)}</p><div class="row"><button class="btn" id="qkLoad">Try again</button></div>`;
    return;
  }
  // ready
  const lost = Array(S.players).fill(0), counted = Array(S.players).fill(0);
  Object.entries(QK.results).forEach(([g, r]) => { if (r.loss !== null) { const p = S.moves[g].player; lost[p] += r.loss; counted[p]++; } });
  const summary = counted.some(Boolean)
    ? `<p class="note">Equity given up across analysed moves (lower is better): ${lost.map((v, p) => `Player ${p + 1} <b>${v.toFixed(1)}</b> over ${counted[p]}`).join(' · ')}.</p>` : '';
  if (S.step === 0) {
    title.textContent = 'Move analysis';
    body.innerHTML = `<p class="hint">Step to a move to see Quackle's view of it.</p>${summary}`;
    return;
  }
  const g = S.step - 1, m = S.moves[g], r = QK.results[g];
  title.innerHTML = `Move analysis <span class="n">Move ${g + 1}, Player ${m.player + 1}</span>`;
  if (!r) { body.innerHTML = `<p class="status"><span class="spinner"></span>Analysing this move…</p>${summary}`; return; }
  if (!r.ok) { body.innerHTML = `<p class="status err">Quackle couldn't set up this position: ${escapeHtml(r.error)}.</p>${summary}`; return; }
  const ri = r.rackInfo;
  const rackHtml = ri.tiles.map(t => `<span class="mini${t.certain ? '' : ' likely'}" title="${t.certain ? 'Certain' : Math.round(t.prob * 100) + '% likely'}">${t.tile.ch}</span>`).join('');
  const best = r.moves[0];
  let verdict;
  if (!best) verdict = 'Quackle found no plays for this rack.';
  else if (r.loss !== null && r.loss < 0.05) verdict = `<b>Matches Quackle's top play.</b>`;
  else if (r.loss !== null && r.loss < 3) verdict = `Close to Quackle's choice, <b>${best.place} ${qkWord(best)}</b> for ${best.score}: ${r.loss.toFixed(1)} equity behind.`;
  else verdict = `Quackle prefers <b>${best.place} ${qkWord(best)}</b> for ${best.score}: ${r.loss.toFixed(1)} more equity than the play made.`;
  const rows = r.moves.map((mv, k) => {
    const isActual = sameMove(mv, r.actual), on = S.preview && S.preview.key === `${g}:${k}`;
    return `<tr class="qkrow ${isActual ? 'played' : ''} ${on ? 'cur' : ''}" data-k="${k}"><td>${k + 1}</td><td class="not">${mv.place || '–'}</td><td><span class="word">${qkWord(mv)}</span>${isActual ? ' <span class="badge">played</span>' : ''}</td><td class="num">${mv.score}</td><td class="num">${mv.equity.toFixed(1)}</td><td class="not">${qkLeave(r.rack, mv.tiles)}</td></tr>`;
  });
  if (r.actual && !r.moves.some(mv => sameMove(mv, r.actual))) {
    const a = r.actual, on = S.preview && S.preview.key === `${g}:a`;
    rows.push(`<tr class="qkrow played ${on ? 'cur' : ''}" data-k="a"><td>–</td><td class="not">${a.place}</td><td><span class="word">${qkWord(a)}</span> <span class="badge">played</span></td><td class="num">${a.score}</td><td class="num">${a.equity.toFixed(1)}</td><td class="not">${qkLeave(r.rack, a.tiles)}</td></tr>`);
  }
  const approx = ri.likely || ri.unknown
    ? `Based on the best-estimate rack: ${ri.certain} certain, ${ri.likely} likely${ri.unknown ? `, ${ri.unknown} unknown and left out` : ''}. A different rack could change Quackle's choice.`
    : 'The whole rack is certain, so this is exact.';
  body.innerHTML = `
    <p class="qk-rack">Rack ${rackHtml}</p>
    <p class="verdict">${verdict}</p>
    <div class="moves-wrap qk-table"><table>
      <thead><tr><th>#</th><th>Where</th><th>Word</th><th class="num">Pts</th><th class="num">Equity</th><th>Keeps</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
    <p class="note">${approx} Click a play to see it on the board. Equity is the score plus Quackle's value for the tiles kept${QK.leaves ? '' : ' (leave values unavailable)'}.</p>
    ${simHtml((QK.sims[g] || {}).sim, { label: mv => `${mv.place || ''} ${qkWord(mv)}`.trim(), keeps: mv => qkLeave(r.rack, mv.tiles), exact: !ri.likely && !ri.unknown })}
    ${summary}`;
}
$('qkCard').addEventListener('click', e => {
  if (e.target.closest('#qkLoad')) { qkLoad(); return; }
  const simBtn = e.target.closest('[data-sim="run"], [data-sim="stop"]');
  if (simBtn && S.moves && S.step > 0) {
    const g = S.step - 1, holder = QK.sims[g] = QK.sims[g] || {};
    if (simBtn.dataset.sim === 'stop') { if (holder.sim && holder.sim.ctl) holder.sim.ctl.abort(); return; }
    startSim(holder, qkInput(g, qkRack(g)), () => { if (S.mode === 'replay' && S.step - 1 === g) renderAnalysis(); });
    return;
  }
  const tr = e.target.closest('tr.qkrow');
  if (!tr || !S.moves) return;
  const g = S.step - 1, r = QK.results[g];
  if (!r) return;
  const key = `${g}:${tr.dataset.k}`;
  if (S.preview && S.preview.key === key) S.preview = null;
  else {
    const mv = tr.dataset.k === 'a' ? r.actual : r.moves[+tr.dataset.k];
    const t = mv && qkTiles(mv);
    S.preview = t ? { g, key, tiles: new Map(t.filter(x => !x.thru).map(x => [x.i, x])) } : null;
  }
  stopPlay(); renderAnalysis(); renderBoard();
});

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
  $('replayMeta').textContent = `${n} moves, ${tiles} tiles, ${mv.filter(m => m.bingo).length} using all seven tiles. Player 1 is assumed to have moved first. ${S.meta.note}`;
  renderEndgame(adj);
  renderShelves();
  renderAnalysis();
  $('moveRows').innerHTML = mv.map((m, k) => {
    const cross = m.words.slice(m.words[0] === m.main ? 1 : 0);
    const crossHtml = cross.length ? `<div class="cross">+ ${cross.map(w => w.map(i => S.cells[i]).join('')).join(', ')}</div>` : '';
    const mainPos = m.main.length >= 2 ? m.main : m.words[0];
    return `<tr class="mv ${k === S.step - 1 ? 'cur' : ''} ${k >= S.step ? 'future' : ''}" data-k="${k}">
      <td>${k + 1}</td><td>P${m.player + 1}</td><td class="not">${notation(mainPos[0], m.main.length >= 2 ? m.dir : 1 - m.dir)}</td>
      <td><span class="word">${wordHtml(mainPos, m.placed)}</span>${m.bingo ? '<span class="bingo">BINGO</span>' : ''}${crossHtml}</td>
      <td class="num">${m.score}</td><td class="num">${m.total}</td>${qkCell(k)}</tr>`;
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
function goto(k) { if (!S.moves) return; S.step = Math.max(0, Math.min(S.moves.length, k)); S.preview = null; renderReplay(); renderBoard(); }
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
  document.body.classList.toggle('replaying', mode !== 'setup');
  $('setup').hidden = mode !== 'setup';
  $('replay').hidden = mode !== 'replay';
  $('practice').hidden = mode !== 'practice';
  $('transport').hidden = mode !== 'replay';
  $('shelves').hidden = mode !== 'replay';
  $('pxRackBox').hidden = mode !== 'practice';
  $('tab-setup').setAttribute('aria-selected', mode === 'setup');
  $('tab-replay').setAttribute('aria-selected', mode === 'replay');
  $('tab-practice').setAttribute('aria-selected', mode === 'practice');
  $('tab-replay').disabled = !S.moves;
  boardEl.classList.remove('editable');
  if (mode === 'replay') renderReplay();
  else if (mode === 'practice') practice.enter();
  else renderChecks();
  renderBoard();
}
$('tab-setup').onclick = () => setMode('setup');
$('tab-replay').onclick = () => S.moves && setMode('replay');
$('tab-practice').onclick = () => setMode('practice');

/* ---------- word list ---------- */
// The built-in ENABLE list, or a list the viewer loads from their own file.
// A loaded list is kept in this browser's IndexedDB and never leaves the device.
const LEX = { key: 'enable', name: 'ENABLE', builtin: true, words: null, collins: false };
let enableText = null, pendingList = null;

function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('tilerewind', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function idbDel(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }

// One word per line; anything after the first word is ignored (lists often carry definitions).
function parseWordList(text) {
  const seen = new Set(); let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim().split(/\s+/)[0];
    if (!w) continue;
    const W = w.toUpperCase();
    if (/^[A-Z]{2,15}$/.test(W)) seen.add(W); else skipped++;
  }
  return { words: [...seen].sort(), skipped };
}

function applyLexicon(entry) {
  if (entry) Object.assign(LEX, { key: 'user:' + entry.name + ':' + entry.words.length, name: entry.name, builtin: false, words: entry.words, collins: !!entry.collins });
  else Object.assign(LEX, { key: 'enable', name: 'ENABLE', builtin: true, words: null, collins: false });
  const words = LEX.builtin ? enableText.split('\n').filter(Boolean).map(w => w.trim().toUpperCase()) : LEX.words;
  DICT = new Set(words);
  worker.postMessage({ type: 'dict', text: LEX.builtin ? enableText : words.join('\n') });
  $('lexBtn').textContent = `Words: ${LEX.name}`;
  $('lexCurrent').textContent = LEX.builtin ? 'ENABLE (built in)' : `${LEX.name} (your file, ${words.length.toLocaleString()} words)`;
  // results from the previous list no longer apply
  QK.results = {}; QK.sims = {}; QK.token = null;
  if (S.mode === 'replay' && QK.state === 'ready') qkRunAll();
  renderChecks(); renderBoard();
  if (S.mode === 'practice') practice.render();
}
async function bootLexicon() {
  try {
    const r = await fetch('data/words.txt');
    if (!r.ok) throw new Error(r.status);
    enableText = await r.text();
  } catch (e) {
    solveStatus('The word list did not load. Reload the page to try again.', 'err');
    return;
  }
  let saved = null;
  try { saved = await idbGet('wordlist'); } catch (e) {}
  applyLexicon(saved && saved.active ? saved : null);
}

const lexStatus = (text, cls = '') => { const s = $('lexStatus'); s.hidden = !text; s.className = 'status ' + cls; s.textContent = text; };
async function openLexDialog() {
  let saved = null;
  try { saved = await idbGet('wordlist'); } catch (e) {}
  $('lexStored').hidden = !saved || !LEX.builtin;
  if (saved) $('lexStored').textContent = `Use my saved list (${saved.name})`;
  $('lexForget').hidden = !saved;
  $('lexBuiltin').hidden = LEX.builtin;
  $('lexUse').disabled = !pendingList;
  lexStatus('');
  $('lexDialog').showModal();
}
$('lexBtn').onclick = openLexDialog;

// ---- skin: classic (default) or the poster look ----
const POSTER_FONTS = 'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;800&family=IBM+Plex+Mono:wght@400;500;600&family=Oswald:wght@500;600;700&display=swap';
function applySkin(skin) {
  const poster = skin === 'brute';
  if (poster) document.documentElement.dataset.skin = 'brute';
  else delete document.documentElement.dataset.skin;
  if (poster && !document.getElementById('skinFonts')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.id = 'skinFonts'; link.href = POSTER_FONTS;
    document.head.appendChild(link);
  }
  document.querySelector('meta[name="theme-color"]').content = poster ? '#0a0a0a' : '#1d4740';
  $('skinBtn').textContent = `Skin: ${poster ? 'Poster' : 'Classic'}`;
}
applySkin(document.documentElement.dataset.skin);
$('skinBtn').onclick = () => {
  const skin = document.documentElement.dataset.skin === 'brute' ? 'classic' : 'brute';
  try { localStorage.setItem('mabble.skin', skin); } catch (e) {}
  applySkin(skin);
};
$('lexFile').onchange = async e => {
  const f = e.target.files[0];
  pendingList = null; $('lexUse').disabled = true;
  if (!f) return;
  lexStatus('Reading the file…');
  try {
    const { words, skipped } = parseWordList(await f.text());
    if (words.length < 1000) { lexStatus(`Only ${words.length} words found. Check that the file has one word per line.`, 'err'); return; }
    pendingList = words;
    const base = f.name.replace(/\.[^.]+$/, '');
    if (!$('lexName').value) $('lexName').value = base.toUpperCase().slice(0, 20);
    $('lexCollins').checked = /csw|collins|sowpods/i.test(base + ' ' + $('lexName').value);
    lexStatus(`${words.length.toLocaleString()} words found${skipped ? `. ${skipped.toLocaleString()} lines were skipped because they aren't 2 to 15 letters A to Z` : ''}.`, 'good');
    $('lexUse').disabled = false;
  } catch (err) {
    lexStatus('That file could not be read. Choose a plain text file.', 'err');
  }
};
$('lexUse').onclick = async () => {
  if (!pendingList) return;
  const entry = { name: ($('lexName').value.trim() || 'My list').slice(0, 20), collins: $('lexCollins').checked, words: pendingList, active: true };
  try { await idbSet('wordlist', entry); }
  catch (e) { lexStatus("This browser couldn't save the list, so it will only last until you close the page.", 'err'); }
  applyLexicon(entry);
  pendingList = null; $('lexFile').value = '';
  $('lexDialog').close();
};
$('lexStored').onclick = async () => {
  const saved = await idbGet('wordlist').catch(() => null);
  if (!saved) return;
  saved.active = true; await idbSet('wordlist', saved).catch(() => {});
  applyLexicon(saved); $('lexDialog').close();
};
$('lexBuiltin').onclick = async () => {
  const saved = await idbGet('wordlist').catch(() => null);
  if (saved) { saved.active = false; await idbSet('wordlist', saved).catch(() => {}); }
  applyLexicon(null); $('lexDialog').close();
};
$('lexForget').onclick = async () => {
  await idbDel('wordlist').catch(() => {});
  if (!LEX.builtin) applyLexicon(null);
  $('lexDialog').close();
};

/* ---------- simulation ---------- */
// The analysis engine doubles as the first simulation engine, so a simulation starts one fewer.
const simulator = createSimulator({
  lexicon: () => LEX,
  shared: { ready: qkReady, call: msg => qkSend(msg), syncLexicon: qkSyncLexicon },
});
const SIM_OPTS = { seconds: 30, plies: 2 };
// read-only diagnostics for checking memory use from the browser console
window.mabbleDebug = { extraSimEngines: () => simulator.extraEngines(), analysisEngine: () => QK.state };
// Run a simulation for `holder` (any object; results land in holder.sim), redrawing as it goes.
async function startSim(holder, input, render) {
  if (holder.sim && holder.sim.running) return;
  const ctl = new AbortController();
  holder.sim = { running: true, ctl, progress: { phase: 'setup', message: 'Starting…' } };
  render();
  let drawn = 0;
  try {
    const result = await simulator.run(input, {
      candidates: 6, plies: SIM_OPTS.plies, seconds: SIM_OPTS.seconds, signal: ctl.signal,
      onProgress: p => { holder.sim.progress = p; const t = performance.now(); if (t - drawn > 250) { drawn = t; render(); } },
    });
    holder.sim = result ? { result } : undefined;
  } catch (e) {
    holder.sim = { error: (e && e.message) || String(e) };
  }
  render();
}
function simHtml(sim, helpers) { return simSectionHtml(sim, { escapeHtml, seconds: SIM_OPTS.seconds, plies: SIM_OPTS.plies, ...helpers }); }
// the Time and Look ahead menus, wherever they appear
document.addEventListener('change', e => {
  const k = e.target && e.target.dataset && e.target.dataset.sim;
  if (k === 'seconds' || k === 'plies') SIM_OPTS[k] = +e.target.value;
});

/* ---------- practice ---------- */
// Ask which letter a blank stands for; resolves '' if cancelled.
function pickBlank() {
  const dlg = $('blankDialog');
  $('blankGrid').innerHTML = [...COLS, 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'].map(ch => `<button class="btn" value="${ch}" type="submit">${ch}</button>`).join('');
  return new Promise(res => {
    dlg.querySelector('form').onsubmit = e => { res(e.submitter ? e.submitter.value : ''); };
    dlg.onclose = () => res(dlg.returnValue || '');
    dlg.returnValue = '';
    dlg.showModal();
  });
}
const practice = createPractice({
  N, CENTER, VAL, PREM, $, escapeHtml, notation, lineRun, renderBoard, pickBlank,
  isWord: w => !DICT || DICT.has(w),
  listName: () => LEX.name,
  simStart: startSim, simHtml, explain: explainFacts,
  engine: {
    ready: qkReady, analyse: qkCall, state: () => QK.state,
    // the opponent's best replies after a move, over randomly sampled racks
    replies: async (input, samples) => { await qkReady(); await qkSyncLexicon(); return qkSend({ type: 'replies', input, samples }); },
  },
  // optional write-up by Claude (needs the API key set under Read the photo)
  writer: { hasKey: () => !!getKey(), write: (facts, signal) => explainMove(facts, getKey(), signal), openKeyDialog: () => openKeyDialog() },
});
$('editBtn').onclick = () => setMode('setup');

/* ---------- boot ---------- */
buildBoard();
const draft = loadDraft();
if (draft) { setFromRows(draft.text.split('\n')); S.isSample = !!draft.isSample; }
else { setFromRows(SAMPLE); S.isSample = true; }
S.autoSolve = S.isSample;
renderChecks(); renderBoard();
startWorker();
bootLexicon();
renderKeyState();
try { const m = localStorage.getItem('tilerewind.method'); const el = m && document.querySelector(`input[name="method"][value="${m}"]`); if (el) el.checked = true; } catch (e) {}
renderMethod();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
