// Reads a board photo on this device: free, no account, nothing uploaded.
// The person drags four corners onto the grid; we straighten the photo, find the
// letters printed on tile-coloured areas wherever the tiles actually sit, work out
// which square each belongs to, and match each letter's shape against reference
// letters, then against the clearest tiles on the same board.

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

// Straighten the quad inside `src` into a square board image, bilinear sampled,
// with `pad` squares of margin on every side (so tiles pushed past the edge stay in view).
export function warp(src, corners, pad = 0) {
  const sw = src.width, sh = src.height, size = CELL * (N + pad * 2);
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), od = img.data;
  const map = squareToQuad(corners);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [sx, sy] = map(((x + 0.5) / CELL - pad) / N, ((y + 0.5) / CELL - pad) / N);
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

/* ---------- tile finding ---------- */

// Real tiles rarely sit square in their squares, so tiles are not read from fixed cells.
// Instead: learn the colour of a tile face, find the letters printed on tile-coloured
// areas, fit how the grid sits under them (this also absorbs slightly misplaced corners),
// then give each letter the nearest free square. Tile faces left without a letter are blanks.

const PAD = 1;                 // squares of margin warped around the grid
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const median = a => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };
const pct = (a, q) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; };

// How far a pixel's colour is from the tile face, forgiving uneven light.
function faceDistance(r, g, b, ref, refL) {
  const l = Math.max(1, lum(r, g, b)), k = refL / l;
  return Math.hypot(r * k - ref[0], g * k - ref[1], b * k - ref[2]) + Math.max(0, Math.abs(Math.log(l / refL)) - 0.3) * 60;
}

// The face colour: the lighter part of squares that look like a light tile carrying a dark letter.
function faceColour(data, size) {
  const cands = [];
  const m = Math.round(CELL * 0.14);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const x0 = (c + PAD) * CELL, y0 = (r + PAD) * CELL, px = [];
    for (let y = y0 + m; y < y0 + CELL - m; y += 2) for (let x = x0 + m; x < x0 + CELL - m; x += 2) {
      const i = (y * size + x) * 4; px.push([data[i], data[i + 1], data[i + 2], lum(data[i], data[i + 1], data[i + 2])]);
    }
    px.sort((a, b) => a[3] - b[3]);
    const top = px.slice(Math.floor(px.length * 0.4));
    const med = [0, 1, 2].map(k => median(top.map(p => p[k]))), ml = lum(...med);
    const dark = px.filter(p => p[3] < ml * 0.62).length / px.length;
    if (dark > 0.04 && dark < 0.5 && ml > 95) cands.push({ med, top });
  }
  if (cands.length < 2) return null;
  let ref = [0, 1, 2].map(k => median(cands.map(s => s.med[k])));
  // drop printed premium squares and the like, then settle on the tiles' own colour
  const near = cands.filter(s => Math.hypot(s.med[0] - ref[0], s.med[1] - ref[1], s.med[2] - ref[2]) < 60);
  if (near.length >= 2) ref = [0, 1, 2].map(k => median(near.map(s => s.med[k])));
  const refL = lum(...ref);
  const ds = [];
  for (const s of near.length >= 2 ? near : cands) for (const p of s.top) ds.push(faceDistance(p[0], p[1], p[2], ref, refL));
  return { ref, refL, limit: Math.max(14, Math.min(34, pct(ds, 0.9) * 1.4)) };
}

// Summed-area table, so any box total is four lookups.
function integral(v, size) {
  const S = size + 1, I = new Float64Array(S * S);
  for (let y = 0; y < size; y++) {
    let row = 0;
    for (let x = 0; x < size; x++) { row += v[y * size + x]; I[(y + 1) * S + x + 1] = I[y * S + x + 1] + row; }
  }
  return I;
}
function boxSum(I, size, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.min(size, Math.round(x0))); x1 = Math.max(0, Math.min(size, Math.round(x1)));
  y0 = Math.max(0, Math.min(size, Math.round(y0))); y1 = Math.max(0, Math.min(size, Math.round(y1)));
  if (x1 <= x0 || y1 <= y0) return [0, 0];
  const S = size + 1;
  return [I[y1 * S + x1] - I[y0 * S + x1] - I[y1 * S + x0] + I[y0 * S + x0], (x1 - x0) * (y1 - y0)];
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
    comps.push({ id, n, minx, miny, maxx, maxy, edge, cx: (minx + maxx) / 2 / S, cy: (miny + maxy) / 2 / S });
  }
  return { lab, comps };
}

// Letters: dark marks on tile-coloured surroundings, about the height a tile letter is.
export function findLetters(board) {
  const size = board.width, data = board.getContext('2d').getImageData(0, 0, size, size).data;
  const face = faceColour(data, size);
  if (!face) return null;
  const P = size * size, L = new Float32Array(P), mask = new Uint8Array(P), ml = new Float32Array(P);
  for (let i = 0; i < P; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    L[i] = lum(r, g, b);
    if (faceDistance(r, g, b, face.ref, face.refL) < face.limit) { mask[i] = 1; ml[i] = L[i]; }
  }
  const IM = integral(mask, size), IL = integral(ml, size);
  const ink = new Uint8Array(P), near = CELL * 0.35;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (mask[i]) continue;
    const [m, a] = boxSum(IM, size, x - near, y - near, x + near, y + near);
    if (m < a * 0.3) continue;
    const [lm, a2] = boxSum(IL, size, x - CELL, y - CELL, x + CELL, y + CELL), [mm] = boxSum(IM, size, x - CELL, y - CELL, x + CELL, y + CELL);
    const tileL = mm > a2 * 0.05 ? lm / mm : face.refL;
    if (L[i] < tileL * 0.6) ink[i] = 1;
  }
  const { lab, comps } = components(ink, size);
  const II = integral(ink, size), ring = CELL * 0.12;
  let blobs = comps.filter(k => {
    const w = k.maxx - k.minx + 1, h = k.maxy - k.miny + 1;
    if (h < CELL * 0.26 || h > CELL * 0.8 || w < CELL * 0.05 || w > CELL * 0.85) return false;
    if (k.n < CELL * CELL * 0.008 || k.n < w * h * 0.12) return false;
    const box = [k.minx - ring, k.miny - ring, k.maxx + 1 + ring, k.maxy + 1 + ring];
    const [m, a] = boxSum(IM, size, ...box), [n] = boxSum(II, size, ...box);
    return m >= (a - n) * 0.55;
  });
  const hm = median(blobs.map(k => k.maxy - k.miny + 1));
  blobs = blobs.filter(k => { const h = k.maxy - k.miny + 1; return h > hm * 0.62 && h < hm * 1.45; });
  // stroke width (twice the area over the outline length): bits of grid line between
  // tiles are far thinner than a printed letter's strokes
  const edge = new Float64Array(comps.length);
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const i = y * size + x, id = lab[i];
    if (id >= 0 && (lab[i - 1] !== id || lab[i + 1] !== id || lab[i - size] !== id || lab[i + size] !== id)) edge[id]++;
  }
  for (const k of blobs) k.stroke = (2 * k.n) / Math.max(1, edge[k.id]);
  const sm = median(blobs.map(k => k.stroke));
  blobs = blobs.filter(k => k.stroke > sm * 0.55);
  for (const k of blobs) { k.x = (k.minx + k.maxx + 1) / 2; k.y = (k.miny + k.maxy + 1) / 2; }
  return { blobs, ink, lab, mask, size, face, data };
}

// Solve a small least-squares system A x = b (normal equations, Gaussian elimination).
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-9) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Where a letter on square (r, c) is expected, in board pixels, under the fitted model.
const basis = (r, c) => { const u = r / (N - 1) - 0.5, v = c / (N - 1) - 0.5; return [1, u, v, u * v]; };
function expected(model, r, c) {
  const f = basis(r, c);
  let dx = 0, dy = 0; for (let k = 0; k < 4; k++) { dx += model.x[k] * f[k]; dy += model.y[k] * f[k]; }
  return [(c + PAD + 0.5) * CELL + dx, (r + PAD + 0.5) * CELL + dy];
}

// Pair letters with squares, nearest first, one letter per square.
function assign(blobs, model) {
  const pairs = [];
  blobs.forEach((k, bi) => {
    const c0 = Math.round(k.x / CELL - PAD - 0.5), r0 = Math.round(k.y / CELL - PAD - 0.5);
    for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (r < 0 || c < 0 || r >= N || c >= N) continue;
      const [ex, ey] = expected(model, r, c), d = Math.hypot(k.x - ex, k.y - ey);
      if (d < CELL * 0.72) pairs.push({ bi, cell: r * N + c, d });
    }
  });
  pairs.sort((a, b) => a.d - b.d);
  const byBlob = new Map(), used = new Set();
  for (const p of pairs) if (!byBlob.has(p.bi) && !used.has(p.cell)) { byBlob.set(p.bi, p.cell); used.add(p.cell); }
  return byBlob;
}

// Fit how the letters sit relative to the squares: an overall shift plus a gentle
// stretch and skew, weighted so letters on knocked tiles don't pull it off.
function fitGrid(blobs) {
  let model = { x: [0, 0, 0, 0], y: [0, 0, 0, 0] };
  for (let it = 0; it < 6; it++) {
    const byBlob = assign(blobs, model), rows = [];
    for (const [bi, cell] of byBlob) {
      const r = (cell / N) | 0, c = cell % N, k = blobs[bi], [ex, ey] = expected(model, r, c);
      const e = Math.hypot(k.x - ex, k.y - ey) / (CELL * 0.35), w = e < 1 ? (1 - e * e) ** 2 : 0;
      if (w > 0) rows.push({ f: basis(r, c), w, dx: k.x - (c + PAD + 0.5) * CELL, dy: k.y - (r + PAD + 0.5) * CELL });
    }
    if (!rows.length) break;
    const terms = rows.length >= 12 ? 4 : 1;
    const next = {};
    for (const axis of ['x', 'y']) {
      const A = Array.from({ length: terms }, () => new Array(terms).fill(0)), b = new Array(terms).fill(0);
      for (const q of rows) {
        const t = axis === 'x' ? q.dx : q.dy;
        for (let i = 0; i < terms; i++) { b[i] += q.w * q.f[i] * t; for (let j = 0; j < terms; j++) A[i][j] += q.w * q.f[i] * q.f[j]; }
      }
      // keep the stretch terms modest: corners are placed by hand, not wildly off
      for (let i = 1; i < terms; i++) A[i][i] += rows.length * 0.02;
      const s = solve(A, b);
      next[axis] = s ? [...s, 0, 0, 0].slice(0, 4) : model[axis];
    }
    model = next;
  }
  return model;
}

/* ---------- letter shapes ---------- */

const G = 32; // letters are compared on a G x G grid

// Fit the ink for which has(x, y) is true, inside the given box, into a G x G grid
// (keeping its proportions), soften it, and scale to unit length so a dot product
// gives normalised correlation.
function toVector(has, minx, miny, maxx, maxy) {
  const w = maxx - minx + 1, h = maxy - miny + 1, scale = (G - 4) / Math.max(w, h);
  const ox = (G - w * scale) / 2, oy = (G - h * scale) / 2;
  const g = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    let hit = 0;
    for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const sx = Math.floor((x + dx - ox) / scale) + minx, sy = Math.floor((y + dy - oy) / scale) + miny;
      if (sx < minx || sx > maxx || sy < miny || sy > maxy) continue;
      if (has(sx, sy)) hit++;
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

function blobVector(found, k) {
  const { lab, size } = found;
  return toVector((x, y) => lab[y * size + x] === k.id, k.minx, k.miny, k.maxx, k.maxy);
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Reference letters drawn in fonts close to the ones tile sets use, a little tilted
// either way too, since tiles are rarely placed dead straight.
const FONTS = ['Arial Black', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Gill Sans', 'Futura', 'Century Gothic', 'Franklin Gothic Medium', 'Georgia', 'Times New Roman', 'Rockwell', 'sans-serif', 'serif'];
const TILTS = [0, -5, 5, -10, 10];
let fontTemplates = null;
function getFontTemplates() {
  if (fontTemplates) return fontTemplates;
  const S = 96, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  fontTemplates = {};
  for (const ch of LETTERS) {
    const list = [], seen = new Set();
    for (const font of FONTS) for (const weight of ['700', '900']) for (const tilt of TILTS) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S);
      ctx.translate(S / 2, S / 2); ctx.rotate(tilt * Math.PI / 180);
      ctx.fillStyle = '#000'; ctx.font = `${weight} 56px "${font}"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ch, 0, 0);
      const d = ctx.getImageData(0, 0, S, S).data, ink = new Uint8Array(S * S);
      for (let i = 0; i < S * S; i++) ink[i] = d[i * 4] < 128 ? 1 : 0;
      const { lab, comps } = components(ink, S);
      const keep = comps.filter(k => k.n > 6);
      if (!keep.length) continue;
      const ids = new Set(keep.map(k => k.id));
      const v = toVector((x, y) => ids.has(lab[y * S + x]),
        Math.min(...keep.map(k => k.minx)), Math.min(...keep.map(k => k.miny)), Math.max(...keep.map(k => k.maxx)), Math.max(...keep.map(k => k.maxy)));
      // fonts the device lacks fall back to one it has; skip those duplicates
      const key = Array.from(v.subarray(0, 96), x => x.toFixed(2)).join();
      if (!seen.has(key)) { seen.add(key); list.push(v); }
    }
    fontTemplates[ch] = list;
  }
  return fontTemplates;
}

// Best match against the reference fonts, per letter. Computed once per tile.
function fontScores(vec, fontT) {
  const out = {};
  for (const ch of LETTERS) { let f = -1; for (const t of fontT[ch]) { const s = dot(vec, t); if (s > f) f = s; } out[ch] = f; }
  return out;
}

function rank(vec, font, photoT) {
  const out = [];
  for (const ch of LETTERS) {
    const s = photoT && photoT[ch] ? 0.35 * font[ch] + 0.65 * dot(vec, photoT[ch]) : font[ch];
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

// Squares holding a tile face with no letter on it: blanks. A set has only two, and
// every tile is part of a word, so only squares next to a lettered tile count, and only
// when their colour is clearly nearer the tile faces than this board's empty squares.
function findBlanks(found, model, lettered) {
  const { data, ink, size } = found;
  const P = size * size, ch = [0, 1, 2].map(() => new Float32Array(P)), clear = new Uint8Array(P);
  for (let i = 0; i < P; i++) if (!ink[i]) { clear[i] = 1; for (let k = 0; k < 3; k++) ch[k][i] = data[i * 4 + k]; }
  const IC = ch.map(v => integral(v, size)), IN = integral(clear, size), II = integral(ink, size);
  // mean colour of the non-ink pixels in a box, and how much ink it holds
  const colourAt = (x, y, h) => {
    const [n, a] = boxSum(IN, size, x - h, y - h, x + h, y + h), [k] = boxSum(II, size, x - h, y - h, x + h, y + h);
    return n ? { rgb: IC.map(I => boxSum(I, size, x - h, y - h, x + h, y + h)[0] / n), ink: k / a } : null;
  };
  const dist = (p, q) => faceDistance(p[0], p[1], p[2], q, Math.max(1, lum(...q)));
  const faces = lettered.map(k => colourAt(k.x, k.y, CELL * 0.3)).filter(Boolean).map(c => c.rgb);
  const usedCells = new Set(lettered.map(k => k.cell));
  const empties = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (usedCells.has(r * N + c)) continue;
    const [ex, ey] = expected(model, r, c), col = colourAt(ex, ey, CELL * 0.3);
    if (col) empties.push(col.rgb);
  }
  if (faces.length < 3 || empties.length < 3) return [];
  const F = [0, 1, 2].map(k => median(faces.map(f => f[k]))), E = [0, 1, 2].map(k => median(empties.map(f => f[k])));
  const sep = dist(E, F);
  if (sep < 20) return [];                       // tiles and squares look alike: can't tell
  const cands = [];
  for (const cell0 of usedCells) {
    const r0 = (cell0 / N) | 0, c0 = cell0 % N;
    for (const [r, c] of [[r0 - 1, c0], [r0 + 1, c0], [r0, c0 - 1], [r0, c0 + 1]]) {
      if (r < 0 || c < 0 || r >= N || c >= N || usedCells.has(r * N + c) || cands.some(q => q.cell === r * N + c)) continue;
      const [ex, ey] = expected(model, r, c);
      let best = null;
      for (let dy = -0.2; dy <= 0.2; dy += 0.1) for (let dx = -0.2; dx <= 0.2; dx += 0.1) {
        const col = colourAt(ex + dx * CELL, ey + dy * CELL, CELL * 0.32);
        if (!col || col.ink > 0.03) continue;
        const d = dist(col.rgb, F);
        if (!best || d < best.d) best = { d, e: dist(col.rgb, E) };
      }
      if (best && best.d < sep * 0.3 && best.d < best.e * 0.5) cands.push({ cell: r * N + c, d: best.d });
    }
  }
  return cands.sort((a, b) => a.d - b.d).slice(0, 2).map(q => q.cell);
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
  const padded = warp(image, corners, PAD);
  const found = findLetters(padded);
  if (!found || found.blobs.length < 2) throw new LocalReadError('notiles', 'No tiles found. Check that the four corners sit on the corners of the 15 × 15 grid.');
  say('Finding where each tile sits…'); await tick();
  stopIfAsked();
  const model = fitGrid(found.blobs);
  const byBlob = assign(found.blobs, model);
  const placed = [...byBlob].map(([bi, cell]) => Object.assign(found.blobs[bi], { cell }));
  say(`Found ${placed.length} letters. Reading them…`); await tick();
  stopIfAsked();
  const fontT = getFontTemplates();
  const vecs = placed.map(k => blobVector(found, k));
  const fonts = vecs.map(v => fontScores(v, fontT));
  let ranks = vecs.map((v, k) => rank(v, fonts[k], null));
  // two passes that learn this board's own letter shapes
  for (let pass = 0; pass < 2; pass++) {
    await tick(); stopIfAsked();
    const pt = photoTemplates(vecs, ranks);
    ranks = vecs.map((v, k) => rank(v, fonts[k], pt));
  }
  const cells = Array(N * N).fill('.'), conf = new Float32Array(N * N), alts = {};
  const unsure = new Set(), letters = [];
  placed.forEach((k, j) => {
    const r = ranks[j], i = k.cell;
    if (r[0].s < 0.35) return;                  // not a letter after all (a seam or a smudge)
    letters.push(k);
    cells[i] = r[0].ch;
    const margin = r[0].s - r[1].s;
    conf[i] = Math.max(0, Math.min(100, margin * 400 + (r[0].s - 0.5) * 100));
    alts[i] = r.slice(1, 6).map(x => x.ch);
    if (r[0].s < 0.62 || margin < 0.05) unsure.add(i);
  });
  const blanks = findBlanks(found, model, letters);
  blanks.forEach(i => unsure.add(i));
  const fixed = isWord ? repairWithWords(cells, conf, alts, isWord) : [];
  fixed.forEach(i => unsure.add(i));
  const rows = [];
  for (let r = 0; r < N; r++) rows.push(cells.slice(r * N, r * N + N).join(''));
  const notes = [];
  if (fixed.length) notes.push(`Corrected ${fixed.length} letter${fixed.length > 1 ? 's' : ''} using the word list.`);
  if (blanks.length) notes.push(`${blanks.length} tile${blanks.length > 1 ? 's have' : ' has'} no readable letter (often a blank): type the letter it stands for and press ?.`);
  // show the straightened grid itself, without the margin
  const board = document.createElement('canvas');
  board.width = board.height = CELL * N;
  board.getContext('2d').drawImage(padded, PAD * CELL, PAD * CELL, CELL * N, CELL * N, 0, 0, CELL * N, CELL * N);
  return { rows, unsure: [...unsure].map(i => [(i / N) | 0, i % N]), note: notes.join(' '), board, blanks };
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
