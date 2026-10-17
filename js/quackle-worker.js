// Runs the Quackle engine (WebAssembly) off the main thread.
// Messages in:  { type: 'load' }
//               { type: 'analyse', id, input }
//               { type: 'lexicon', id, words: string[] | null, name, collins }   (null = built-in ENABLE)
//               { type: 'simStart', id, input, candidates, plies } | { type: 'simStep', id, iterations }
//               { type: 'memory', id }
// Messages out: { type: 'ready', leaves } | { type: 'error', message }
//               { type: 'result', id, result }

let engine = null;
const BASE = new URL('../engine/', import.meta.url).href;
const ENABLE_FILES = ['lexica/enable.dawg', 'lexica/enable.gaddag'];
let separateFiles = false;   // newer engine builds ship data as separate files

const exists = p => { try { engine.FS.stat(p); return true; } catch (e) { return false; } };
async function fetchInto(paths) {
  await Promise.all(paths.map(async p => {
    const r = await fetch(BASE + 'data/' + p);
    if (!r.ok) throw new Error(`Couldn't download ${p} (${r.status}).`);
    engine.FS.mkdirTree('/data/' + p.split('/').slice(0, -1).join('/'));
    engine.FS.writeFile('/data/' + p, new Uint8Array(await r.arrayBuffer()), { canOwn: true });
  }));
}
let strategyFiles = [];      // leave values and other strategy data, re-read only when the word list changes

// The engine copies the dictionary and leave values into its own memory when it
// loads them, so the file copies are dead weight afterwards: drop them (about 24 MB
// per engine). They're fetched again, from the offline cache, if the word list changes.
function releaseDataFiles() {
  if (!separateFiles) return;
  for (const p of [...ENABLE_FILES, 'lexica/user.dawg', ...strategyFiles, 'strategy/csw/superleaves']) if (exists('/data/' + p)) engine.FS.unlink('/data/' + p);
}
async function restoreStrategyFiles() {
  if (!separateFiles) return;
  await fetchInto(strategyFiles.filter(p => !exists('/data/' + p)));
}

async function load() {
  const { default: createQuackle } = await import('../engine/quackle.js');
  engine = await createQuackle({ locateFile: f => BASE + f });
  // older builds preload everything; newer ones list their files and the page loads them
  if (!exists('/data/lexica/enable.gaddag')) {
    const list = await fetch(BASE + 'files.txt').then(r => r.ok ? r.text() : Promise.reject(new Error('The engine data list is missing.')));
    const files = list.split('\n').map(s => s.trim()).filter(Boolean);
    await fetchInto(files);
    strategyFiles = files.filter(p => p.startsWith('strategy/'));
    separateFiles = true;
  }
  const init = engine.ccall('qk_init', 'number', [], []);
  if (init < 0) throw new Error('The word list for Quackle is missing.');
  releaseDataFiles();
  return init === 1;
}

// Build a Quackle DAWG (version 1 format) from a list of A-Z words.
// Layout follows Quackle's DawgFactory: node 0 is the root, every node's children
// sit together, and subtrees follow depth-first. Each node is 7 bytes: child
// pointer (3), letter with last-child/"in smaller list" flags (1), playability (3,
// nonzero = a word ends here). Duplicate branches aren't merged; Quackle reads the
// plain trie just the same.
function buildDawg(words) {
  const letter = [0], children = [[]], ends = [false];
  for (const w of words) {
    let n = 0;
    for (let k = 0; k < w.length; k++) {
      const L = w.charCodeAt(k) - 65;
      const kids = children[n];
      let next = -1;
      for (let j = kids.length - 1; j >= 0; j--) if (letter[kids[j]] === L) { next = kids[j]; break; }
      if (next < 0) { next = letter.length; letter.push(L); children.push([]); ends.push(false); kids.push(next); }
      n = next;
    }
    ends[n] = true;
  }
  children.forEach(k => k.sort((a, b) => letter[a] - letter[b]));
  // lay nodes out the way DawgFactory::Node::print does
  const order = [0], pointer = new Int32Array(letter.length), last = new Uint8Array(letter.length);
  last[0] = 1;
  const place = n => {
    const kids = children[n];
    if (!kids.length) return;
    pointer[n] = order.length;
    for (const c of kids) order.push(c);
    last[kids[kids.length - 1]] = 1;
    for (const c of kids) place(c);
  };
  place(0);
  if (order.length >= 1 << 24) throw new Error('This word list is too big for Quackle.');
  const header = [1, ...new Array(16).fill(0), (words.length >> 16) & 255, (words.length >> 8) & 255, words.length & 255, 26];
  for (let i = 0; i < 26; i++) header.push(65 + i, 32);
  const out = new Uint8Array(header.length + order.length * 7);
  out.set(header);
  let o = header.length;
  for (const n of order) {
    const p = pointer[n];
    out[o] = (p >> 16) & 255; out[o + 1] = (p >> 8) & 255; out[o + 2] = p & 255;
    // root letter is Quackle's blank mark (1) minus its first letter (5), as a byte
    out[o + 3] = (n === 0 ? 252 : (letter[n] & 63) | (last[n] ? 64 : 0) | 128);
    out[o + 6] = ends[n] ? 1 : 0;
    o += 7;
  }
  return { bytes: out, nodes: order.length };
}

async function useLexicon(words, name, collins) {
  if (!words) {
    // the ENABLE files were released after loading; fetch them again (from the offline cache)
    if (separateFiles) await Promise.all([fetchInto(ENABLE_FILES.filter(p => !exists('/data/' + p))), restoreStrategyFiles()]);
    const ok = engine.ccall('qk_use_builtin', 'number', [], []) > 0;
    releaseDataFiles();
    return ok;
  }
  const { bytes } = buildDawg(words);
  await restoreStrategyFiles();
  engine.FS.mkdirTree('/data/lexica');
  engine.FS.writeFile('/data/lexica/user.dawg', bytes, { canOwn: true });
  let lexicon = 'user';
  if (collins) {
    try {
      if (!exists('/data/strategy/csw/superleaves')) {
        const r = await fetch(BASE + (separateFiles ? 'data/strategy/csw/superleaves' : 'csw-superleaves'));
        if (!r.ok) throw new Error(r.status);
        engine.FS.mkdirTree('/data/strategy/csw');
        engine.FS.writeFile('/data/strategy/csw/superleaves', new Uint8Array(await r.arrayBuffer()), { canOwn: true });
      }
      lexicon = 'csw-user';
    } catch (e) { /* fall back to the default English leave values */ }
  }
  if (engine.ccall('qk_use_lexicon', 'number', ['string', 'string'], ['/data/lexica/user.dawg', lexicon]) < 0) throw new Error('Quackle could not read the word list.');
  releaseDataFiles();
  return true;
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'load') {
    try { postMessage({ type: 'ready', leaves: await load() }); }
    catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); }
  } else if (m.type === 'analyse') {
    let result;
    try { result = JSON.parse(engine.ccall('qk_analyse', 'string', ['string'], [m.input])); }
    catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    postMessage({ type: 'result', id: m.id, result });
  } else if (m.type === 'simStart') {
    let result;
    try { result = JSON.parse(engine.ccall('qk_sim_start', 'string', ['string', 'number', 'number'], [m.input, m.candidates, m.plies])); }
    catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    postMessage({ type: 'result', id: m.id, result });
  } else if (m.type === 'simStep') {
    let result;
    try { result = JSON.parse(engine.ccall('qk_sim_step', 'string', ['number'], [m.iterations])); }
    catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    postMessage({ type: 'result', id: m.id, result });
  } else if (m.type === 'replies') {
    let result;
    try { result = JSON.parse(engine.ccall('qk_replies', 'string', ['string', 'number'], [m.input, m.samples])); }
    catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    postMessage({ type: 'result', id: m.id, result });
  } else if (m.type === 'memory') {
    // engine memory and this worker's JavaScript heap (Chrome only), in bytes
    postMessage({ type: 'result', id: m.id, result: { ok: true, wasm: engine ? engine.HEAPU8.byteLength : 0, js: self.performance && performance.memory ? performance.memory.usedJSHeapSize : null } });
  } else if (m.type === 'lexicon') {
    let result;
    try { result = { ok: await useLexicon(m.words, m.name, m.collins) }; }
    catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    postMessage({ type: 'result', id: m.id, result });
  }
};
