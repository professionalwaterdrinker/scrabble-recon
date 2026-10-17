// Reads a board photo on this device: free, no account, nothing uploaded.
// The person drags four corners onto the grid; we straighten the photo, find
// which squares hold tiles by colour, and match each letter's shape against
// reference letters, then against the clearest tiles on the same board.

const N = 15;
const CELL = 64;            // pixels per square in the straightened board
const WORK_MAX = 2000;      // longest side of the working copy of the photo
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/* ---------- geometry ---------- */

// Maps the unit square onto a quad: (0,0)->p[0], (1,0)->p[1], (1,1)->p[2], (0,1)->p[3]. (Heckbert's formulas)
export function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (sx || sy) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}

export async function loadWorkingImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Straighten the quad inside `src` into a square board image, bilinear sampled.
export function warp(src, corners, size = CELL * N) {
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(size, size), od = img.data;
  const map = squareToQuad(corners);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [sx, sy] = map((x + 0.5) / size, (y + 0.5) / size);
      sx = Math.min(sw - 1.001, Math.max(0, sx - 0.5)); sy = Math.min(sh - 1.001, Math.max(0, sy - 0.5));
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
      const i00 = (iy * sw + ix) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) {
        od[o + k] = (sd[i00 + k] * (1 - fx) + sd[i10 + k] * fx) * (1 - fy) + (sd[i01 + k] * (1 - fx) + sd[i11 + k] * fx) * fy;
      }
      od[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ---------- corner picker ---------- */

export class CornerPicker {
  constructor(canvas, image, onChange) {
    this.canvas = canvas; this.image = image; this.onChange = onChange;
    const w = image.width, h = image.height, mx = w * 0.1, my = h * 0.1;
    this.pts = [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
    this.drag = -1;
    canvas.style.aspectRatio = `${w} / ${h}`;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => this.up());
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }
  destroy() { this.ro.disconnect(); }
  get scale() { return this.canvas.clientWidth / this.image.width; }
  toImage(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale];
  }
  down(e) {
    const [x, y] = this.toImage(e), reach = 28 / this.scale;
    let best = -1, bd = Infinity;
    this.pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    if (bd > reach) return;
    this.drag = best;
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  move(e) {
    if (this.drag < 0) return;
    const [x, y] = this.toImage(e);
    this.pts[this.drag] = [Math.max(0, Math.min(this.image.width, x)), Math.max(0, Math.min(this.image.height, y))];
    this.draw();
  }
  up() { if (this.drag >= 0) { this.drag = -1; this.onChange && this.onChange(); } }
  // Turn which photo corner counts as A1, for boards photographed sideways or upside down.
  rotate() { this.pts = [this.pts[3], this.pts[0], this.pts[1], this.pts[2]]; this.draw(); this.onChange && this.onChange(); }
  nudge(i, dx, dy) {
    const p = this.pts[i]; this.pts[i] = [p[0] + dx / this.scale, p[1] + dy / this.scale]; this.draw();
  }
  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d'), s = W / this.image.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.image, 0, 0, W, H);
    const map = squareToQuad(this.pts.map(([x, y]) => [x * s, y * s]));
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = 'rgba(255, 196, 64, 0.85)';
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      let [ax, ay] = map(t, 0), [bx, by] = map(t, 1); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      [ax, ay] = map(0, t); [bx, by] = map(1, t); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();
    // label A1 so the orientation is obvious
    const [lx, ly] = map(0.5 / N, 0.5 / N);
    ctx.font = `700 ${13 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText('A1', lx, ly);
    ctx.fillStyle = '#ffc440'; ctx.fillText('A1', lx, ly);
    this.pts.forEach(([x, y], i) => {
      ctx.beginPath(); ctx.arc(x * s, y * s, 9 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? 'rgba(255,196,64,0.95)' : 'rgba(255,255,255,0.9)'; ctx.fill();
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
    });
  }
}

/* ---------- tile detection ---------- */

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const median = a => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };

function cellStats(data, size, r, c) {
  const x0 = c * CELL, y0 = r * CELL, m = Math.round(CELL * 0.14);
  const R = [], G = [], B = [], L = [];
  for (let y = y0 + m; y < y0 + CELL - m; y++) {
    for (let x = x0 + m; x < x0 + CELL - m; x++) {
      const i = (y * size + x) * 4;
      R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); L.push(lum(data[i], data[i + 1], data[i + 2]));
    }
  }
  const med = [median(R), median(G), median(B)], ml = lum(...med);
  let dark = 0;
  for (const l of L) if (l < ml * 0.62) dark++;
  return { med, ml, dark: dark / L.length };
}

// Tiles are the squares that share one light background colour and carry a dark letter.
export function findTiles(board) {
  const size = board.width, data = board.getContext('2d').getImageData(0, 0, size, size).data;
  const stats = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) stats.push(cellStats(data, size, r, c));
  const lettered = stats.filter(s => s.dark > 0.05 && s.dark < 0.5 && s.ml > 95);
  if (lettered.length < 2) return { tiles: new Set(), stats };
  const ref = [0, 1, 2].map(k => median(lettered.map(s => s.med[k])));
  const dist = s => Math.hypot(s.med[0] - ref[0], s.med[1] - ref[1], s.med[2] - ref[2]);
  // threshold from the spread of the lettered cells, within sane bounds
  const spread = median(lettered.map(dist));
  const limit = Math.max(28, Math.min(70, spread * 2.6));
  const tiles = new Set();
  stats.forEach((s, i) => { if (s.dark > 0.025 && s.dark < 0.55 && dist(s) < limit) tiles.add(i); });
  return { tiles, stats, ref };
}

/* ---------- letter shapes ---------- */

const G = 32; // letters are compared on a G x G grid

function otsu(L) {
  const hist = new Array(256).fill(0); L.forEach(v => hist[Math.max(0, Math.min(255, v | 0))]++);
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = L.length - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

function components(ink, S) {
  const lab = new Int32Array(S * S).fill(-1), comps = [];
  for (let i = 0; i < S * S; i++) {
    if (!ink[i] || lab[i] >= 0) continue;
    const id = comps.length, st = [i]; lab[i] = id;
    let n = 0, minx = S, miny = S, maxx = 0, maxy = 0, edge = false;
    while (st.length) {
      const p = st.pop(), x = p % S, y = (p / S) | 0; n++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === S - 1 || y === S - 1) edge = true;
      if (x > 0 && ink[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; st.push(p - 1); }
      if (x < S - 1 && ink[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; st.push(p + 1); }
      if (y > 0 && ink[p - S] && lab[p - S] < 0) { lab[p - S] = id; st.push(p - S); }
      if (y < S - 1 && ink[p + S] && lab[p + S] < 0) { lab[p + S] = id; st.push(p + S); }
    }
    comps.push({ n, minx, miny, maxx, maxy, edge, cx: (minx + maxx) / 2 / S, cy: (miny + maxy) / 2 / S });
  }
  return { lab, comps };
}

// Fit the kept ink into a G x G grid (keeping its proportions), soften it, and
// scale to unit length so a dot product gives normalised correlation.
function toVector(ink, lab, keep, S) {
  let minx = S, miny = S, maxx = -1, maxy = -1;
  for (let i = 0; i < S * S; i++) if (ink[i] && keep[lab[i]]) {
    const x = i % S, y = (i / S) | 0;
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  if (maxx < 0) return null;
  const w = maxx - minx + 1, h = maxy - miny + 1, scale = (G - 4) / Math.max(w, h);
  const ox = (G - w * scale) / 2, oy = (G - h * scale) / 2;
  const g = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    let hit = 0;
    for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const sx = Math.floor((x + dx - ox) / scale) + minx, sy = Math.floor((y + dy - oy) / scale) + miny;
      if (sx < minx || sx > maxx || sy < miny || sy > maxy) continue;
      const p = sy * S + sx; if (ink[p] && keep[lab[p]]) hit++;
    }
    g[y * G + x] = hit / 4;
  }
  const b = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    let t = 0, n = 0;
    for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
      if (xx < 0 || yy < 0 || xx >= G || yy >= G) continue; t += g[yy * G + xx]; n++;
    }
    b[y * G + x] = t / n;
  }
  let mean = 0; for (const v of b) mean += v; mean /= b.length;
  let norm = 0; for (let i = 0; i < b.length; i++) { b[i] -= mean; norm += b[i] * b[i]; }
  norm = Math.sqrt(norm) || 1; for (let i = 0; i < b.length; i++) b[i] /= norm;
  return b;
}

// The letter on one tile, with the small point value and edge specks removed.
function tileVector(board, idx) {
  const r = (idx / N) | 0, c = idx % N;
  const pad = Math.round(CELL * 0.07), S = CELL - pad * 2;
  const src = board.getContext('2d').getImageData(c * CELL + pad, r * CELL + pad, S, S).data;
  const L = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) L[i] = lum(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
  const thr = otsu(L);
  const ink = new Uint8Array(S * S); for (let i = 0; i < S * S; i++) ink[i] = L[i] < thr ? 1 : 0;
  const { lab, comps } = components(ink, S);
  const keep = comps.map(k => !k.edge && k.n > S * S * 0.004 && k.cx > 0.18 && k.cx < 0.74 && k.cy > 0.15 && k.cy < 0.8);
  const big = Math.max(0, ...comps.filter((k, i) => keep[i]).map(k => k.n));
  comps.forEach((k, i) => { if (keep[i] && k.n < big * 0.12) keep[i] = false; });
  return toVector(ink, lab, keep, S);
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Reference letters drawn in fonts close to the ones tile sets use.
const FONTS = ['Arial Black', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Gill Sans', 'Futura', 'Century Gothic', 'Franklin Gothic Medium', 'Georgia', 'Times New Roman', 'Rockwell', 'sans-serif', 'serif'];
let fontTemplates = null;
function getFontTemplates() {
  if (fontTemplates) return fontTemplates;
  const S = 96, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  fontTemplates = {};
  for (const ch of LETTERS) {
    const list = [], seen = new Set();
    for (const font of FONTS) for (const weight of ['700', '900']) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = '#000'; ctx.font = `${weight} 62px "${font}"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ch, S / 2, S / 2);
      const d = ctx.getImageData(0, 0, S, S).data, ink = new Uint8Array(S * S);
      for (let i = 0; i < S * S; i++) ink[i] = d[i * 4] < 128 ? 1 : 0;
      const { lab, comps } = components(ink, S);
      const v = toVector(ink, lab, comps.map(k => k.n > 6), S);
      if (!v) continue;
      // fonts the device lacks fall back to one it has; skip those duplicates
      const key = Array.from(v.subarray(0, 96), x => x.toFixed(2)).join();
      if (!seen.has(key)) { seen.add(key); list.push(v); }
    }
    fontTemplates[ch] = list;
  }
  return fontTemplates;
}

function rank(vec, fontT, photoT) {
  const out = [];
  for (const ch of LETTERS) {
    let f = -1; for (const t of fontT[ch]) { const s = dot(vec, t); if (s > f) f = s; }
    const s = photoT && photoT[ch] ? 0.35 * f + 0.65 * dot(vec, photoT[ch]) : f;
    out.push({ ch, s });
  }
  return out.sort((a, b) => b.s - a.s);
}

// Average the clearest readings of each letter into templates in this set's own font.
function photoTemplates(vecs, ranks) {
  const sums = {};
  ranks.forEach((r, i) => {
    if (!r || r[0].s < 0.6 || r[0].s - r[1].s < 0.08) return;
    const ch = r[0].ch, v = vecs[i];
    if (!sums[ch]) sums[ch] = new Float32Array(G * G);
    for (let k = 0; k < v.length; k++) sums[ch][k] += v[k];
  });
  for (const ch in sums) {
    const t = sums[ch]; let norm = 0; for (const x of t) norm += x * x; norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < t.length; k++) t[k] /= norm;
  }
  return sums;
}

export class LocalReadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const tick = () => new Promise(r => setTimeout(r));

// isWord(word) lets the reader repair letters that break words.
export async function readBoardLocally(image, corners, { onProgress, signal, isWord } = {}) {
  const say = t => onProgress && onProgress(t);
  const stopIfAsked = () => { if (signal && signal.aborted) throw new LocalReadError('cancelled', 'Stopped.'); };
  say('Straightening the photo…'); await tick();
  const board = warp(image, corners);
  const { tiles } = findTiles(board);
  if (tiles.size < 2) throw new LocalReadError('notiles', 'No tiles found. Check that the four corners sit on the corners of the 15 × 15 grid.');
  say(`Found ${tiles.size} tiles. Reading letters…`); await tick();
  stopIfAsked();
  const fontT = getFontTemplates();
  const idx = [...tiles];
  const vecs = idx.map(i => tileVector(board, i));
  let ranks = vecs.map(v => v && rank(v, fontT, null));
  // two passes that learn this board's own letter shapes
  for (let pass = 0; pass < 2; pass++) {
    await tick(); stopIfAsked();
    const pt = photoTemplates(vecs, ranks);
    ranks = vecs.map(v => v && rank(v, fontT, pt));
  }
  const cells = Array(N * N).fill('.'), conf = new Float32Array(N * N), alts = {};
  const unsure = new Set();
  idx.forEach((i, k) => {
    const r = ranks[k];
    if (!r) { unsure.add(i); return; }
    cells[i] = r[0].ch;
    const margin = r[0].s - r[1].s;
    conf[i] = Math.max(0, Math.min(100, margin * 400 + (r[0].s - 0.5) * 100));
    alts[i] = r.slice(1, 6).map(x => x.ch);
    if (r[0].s < 0.62 || margin < 0.05) unsure.add(i);
  });
  const fixed = isWord ? repairWithWords(cells, conf, alts, isWord) : [];
  fixed.forEach(i => unsure.add(i));
  const blankish = idx.filter(i => cells[i] === '.').length;
  const rows = [];
  for (let r = 0; r < N; r++) rows.push(cells.slice(r * N, r * N + N).join(''));
  const notes = [];
  if (fixed.length) notes.push(`Corrected ${fixed.length} letter${fixed.length > 1 ? 's' : ''} using the word list.`);
  if (blankish) notes.push(`${blankish} tile${blankish > 1 ? 's have' : ' has'} no readable letter (often a blank): type the letter it stands for and press ?.`);
  return { rows, unsure: [...unsure].map(i => [(i / N) | 0, i % N]), note: notes.join(' '), board };
}

/* ---------- word-list repair ---------- */

function runsThrough(cells, i) {
  const out = [], row = (i / N) | 0;
  let a = i; while (a % N > 0 && cells[a - 1] !== '.') a--;
  let pos = []; for (let q = a; ((q / N) | 0) === row && cells[q] !== '.'; q++) pos.push(q);
  if (pos.length >= 2) out.push(pos);
  a = i; while (a >= N && cells[a - N] !== '.') a -= N;
  pos = []; for (let q = a; q < N * N && cells[q] !== '.'; q += N) pos.push(q);
  if (pos.length >= 2) out.push(pos);
  return out;
}

// Least certain letters first: if a letter sits in a word that isn't in the list,
// try its next-best readings and keep the first that makes every word through it valid.
function repairWithWords(cells, conf, alts, isWord) {
  const fixed = [];
  const order = Object.keys(alts).map(Number).sort((a, b) => conf[a] - conf[b]);
  const valid = p => isWord(p.map(q => cells[q]).join(''));
  for (const i of order) {
    if (conf[i] >= 60) break;
    const words = runsThrough(cells, i);
    if (words.every(valid)) continue;
    const orig = cells[i];
    for (const alt of alts[i]) {
      cells[i] = alt;
      if (words.every(valid)) { fixed.push(i); break; }
      cells[i] = orig;
    }
  }
  return fixed;
}
