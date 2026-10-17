// Runs the Quackle engine (WebAssembly) off the main thread.
// Messages in:  { type: 'load' }
//               { type: 'analyse', id, input }
//               { type: 'lexicon', id, words: string[] | null, name, collins }   (null = built-in ENABLE)
// Messages out: { type: 'ready', leaves } | { type: 'error', message }
//               { type: 'result', id, result }

let engine = null;
const BASE = new URL('../engine/', import.meta.url).href;

async function load() {
  const { default: createQuackle } = await import('../engine/quackle.js');
  engine = await createQuackle({ locateFile: f => BASE + f });
  const init = engine.ccall('qk_init', 'number', [], []);
  if (init < 0) throw new Error('The word list for Quackle is missing.');
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

let cswLeaves = null;
async function useLexicon(words, name, collins) {
  if (!words) return engine.ccall('qk_use_builtin', 'number', [], []) > 0;
  const { bytes } = buildDawg(words);
  engine.FS.writeFile('/data/lexica/user.dawg', bytes);
  let lexicon = 'user';
  if (collins) {
    try {
      if (!cswLeaves) {
        const r = await fetch(BASE + 'csw-superleaves');
        if (!r.ok) throw new Error(r.status);
        cswLeaves = new Uint8Array(await r.arrayBuffer());
      }
      engine.FS.mkdirTree('/data/strategy/csw');
      engine.FS.writeFile('/data/strategy/csw/superleaves', cswLeaves);
      lexicon = 'csw-user';
    } catch (e) { /* fall back to the default English leave values */ }
  }
  if (engine.ccall('qk_use_lexicon', 'number', ['string', 'string'], ['/data/lexica/user.dawg', lexicon]) < 0) throw new Error('Quackle could not read the word list.');
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
  } else if (m.type === 'lexicon') {
    let result;
    try { result = { ok: await useLexicon(m.words, m.name, m.collins) }; }
    catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    postMessage({ type: 'result', id: m.id, result });
  }
};
