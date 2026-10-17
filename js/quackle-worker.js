// Runs the Quackle engine (WebAssembly) off the main thread.
// Messages in:  { type: 'load' } | { type: 'analyse', id, input }
// Messages out: { type: 'ready', leaves } | { type: 'error', message } | { type: 'result', id, result }

let engine = null;

async function load() {
  const { default: createQuackle } = await import('../engine/quackle.js');
  engine = await createQuackle({ locateFile: f => new URL('../engine/' + f, import.meta.url).href });
  const init = engine.ccall('qk_init', 'number', [], []);
  if (init < 0) throw new Error('The word list for Quackle is missing.');
  return init === 1;
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
  }
};
