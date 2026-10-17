// Quackle simulation on demand: several engine workers play out the top candidate
// plays in parallel, each with its own random draws, and the results are combined.

// How many engines to run: leave a core free, and stay modest on phones and small devices.
export function poolSize() {
  const cores = navigator.hardwareConcurrency || 2;
  const small = (navigator.deviceMemory && navigator.deviceMemory < 4) || matchMedia('(pointer: coarse)').matches;
  return Math.max(1, Math.min(small ? 2 : 4, cores - 1));
}

export function createSimulator({ lexicon }) {
  const workers = [];   // { w, pending: Map, nextId, ready: Promise, lexKey }

  function spawn() {
    const w = new Worker(new URL('./quackle-worker.js', import.meta.url), { type: 'module' });
    const slot = { w, pending: new Map(), nextId: 1, lexKey: null };
    slot.ready = new Promise((res, rej) => {
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') res();
        else if (m.type === 'error') rej(new Error(m.message));
        else if (m.type === 'result') { const r = slot.pending.get(m.id); slot.pending.delete(m.id); if (r) r(m.result); }
      };
      w.onerror = () => rej(new Error('An engine could not start.'));
    });
    w.postMessage({ type: 'load' });
    return slot;
  }
  const call = (slot, msg) => new Promise(res => { const id = slot.nextId++; slot.pending.set(id, res); slot.w.postMessage({ ...msg, id }); });

  async function ensure(n, say) {
    while (workers.length < n) workers.push(spawn());
    say(`Starting ${n} engine${n > 1 ? 's' : ''}…`);
    await Promise.all(workers.slice(0, n).map(s => s.ready));
    const lex = lexicon();
    await Promise.all(workers.slice(0, n).map(async s => {
      if (s.lexKey === lex.key) return;
      if (!lex.builtin) say('Preparing your word list in each engine…');
      const r = await call(s, { type: 'lexicon', words: lex.builtin ? null : lex.words, name: lex.name, collins: lex.collins });
      if (!r.ok) throw new Error(r.error || 'An engine could not use this word list.');
      s.lexKey = lex.key;
    }));
  }

  // Combine every engine's running averages, weighting by iterations.
  function combine(parts, candidates) {
    const total = parts.reduce((s, p) => s + p.iterations, 0);
    return {
      iterations: total,
      moves: candidates.map((c, i) => {
        let eq = 0, win = 0;
        for (const p of parts) { eq += p.moves[i].equity * p.iterations; win += p.moves[i].win * p.iterations; }
        return { ...c, staticEquity: c.equity, simEquity: total ? eq / total : c.equity, win: total ? win / total : null };
      }),
    };
  }

  // input: position in the bridge's text format (with "actual" for the play made).
  // Calls onProgress({ phase, message, elapsed, seconds, result }) as it goes.
  async function run(input, { candidates = 6, plies = 2, seconds = 30, signal, onProgress }) {
    const say = message => onProgress && onProgress({ phase: 'setup', message });
    const n = poolSize();
    await ensure(n, say);
    if (signal && signal.aborted) return null;
    const starts = await Promise.all(workers.slice(0, n).map(s => call(s, { type: 'simStart', input, candidates, plies })));
    const first = starts[0];
    if (!first.ok) throw new Error(first.error);
    // every engine sees the same position, so they should list the same candidates; use only those that agree
    const key = st => st.ok ? st.candidates.map(c => c.text).join('|') : '';
    const active = workers.slice(0, n).filter((s, k) => key(starts[k]) === key(first));
    const parts = active.map(() => ({ iterations: 0, moves: first.candidates.map(c => ({ equity: c.equity, win: 0 })) }));
    const t0 = performance.now(), limit = seconds * 1000;
    let last = null;
    await Promise.all(active.map(async (s, k) => {
      let batch = 4;
      while (!(signal && signal.aborted) && performance.now() - t0 < limit) {
        const b0 = performance.now();
        const r = await call(s, { type: 'simStep', iterations: batch });
        if (!r.ok) throw new Error(r.error);
        parts[k] = r;
        // aim for about a quarter of a second per batch so progress stays lively and Stop is quick
        const took = performance.now() - b0;
        batch = Math.max(1, Math.min(200, Math.round(batch * 250 / Math.max(10, took))));
        last = combine(parts, first.candidates);
        onProgress && onProgress({ phase: 'running', elapsed: (performance.now() - t0) / 1000, seconds, engines: active.length, result: last });
      }
    }));
    const result = last || combine(parts, first.candidates);
    return { ...result, actualIndex: first.actualIndex, rack: first.rack, plies, engines: active.length, seconds: (performance.now() - t0) / 1000, stopped: !!(signal && signal.aborted) };
  }

  return { run, poolSize };
}

// The simulation section of an analysis card. `sim` is undefined (not run yet),
// { running, progress } while running, or { result } / { error } when done.
export function simSectionHtml(sim, { label, keeps, escapeHtml, exact, seconds = 30, plies = 2 }) {
  const sel = (v, cur) => `value="${v}"${String(v) === String(cur) ? ' selected' : ''}`;
  const controls = (busy) => `
    <div class="sim-controls">
      <label>Time <select data-sim="seconds" ${busy ? 'disabled' : ''}><option ${sel(10, seconds)}>10 s</option><option ${sel(30, seconds)}>30 s</option><option ${sel(60, seconds)}>60 s</option></select></label>
      <label>Look ahead <select data-sim="plies" ${busy ? 'disabled' : ''}><option ${sel(2, plies)}>2 turns</option><option ${sel(3, plies)}>3 turns</option></select></label>
      ${busy ? '<button class="btn" data-sim="stop" type="button">Stop</button>' : `<button class="btn primary" data-sim="run" type="button">${sim && sim.result ? 'Simulate again' : 'Simulate'}</button>`}
    </div>`;
  const intro = `<p class="hint">Simulation plays each of Quackle's top choices forward many times, with random tiles for the opponent, to check what static equity can miss: openings for the opponent, awkward leaves, and the endgame.${exact ? '' : ' The rack here is partly estimated, so treat the result as a guide.'}</p>`;
  if (!sim) return `<div class="sim">${intro}${controls(false)}</div>`;
  if (sim.error) return `<div class="sim"><p class="status err">Simulation stopped: ${escapeHtml(sim.error)}</p>${controls(false)}</div>`;
  const r = sim.running ? sim.progress && sim.progress.result : sim.result;
  let head;
  if (sim.running) {
    const p = sim.progress || {};
    head = p.phase === 'running'
      ? `<div class="sim-progress"><div class="bar"><span style="width:${Math.min(100, (p.elapsed / p.seconds) * 100).toFixed(1)}%"></span></div><span>${(r ? r.iterations : 0).toLocaleString()} playouts per play on ${p.engines} engine${p.engines > 1 ? 's' : ''} · ${Math.max(0, Math.ceil(p.seconds - p.elapsed))} s left</span></div>`
      : `<p class="status"><span class="spinner"></span>${escapeHtml(p.message || 'Starting…')}</p>`;
  } else {
    head = `<p class="note">${r.iterations.toLocaleString()} playouts per play, looking ${sim.result.plies} turns ahead, on ${sim.result.engines} engine${sim.result.engines > 1 ? 's' : ''}${sim.result.stopped ? ' (stopped early)' : ''}.${exact ? '' : ' The rack was partly estimated, so treat this as a guide.'}</p>`;
  }
  let table = '';
  if (r && r.moves) {
    const ranked = r.moves.map((m, i) => ({ ...m, i })).sort((a, b) => b.simEquity - a.simEquity);
    const best = ranked[0], actual = sim.result ? sim.result.actualIndex : (sim.actualIndex ?? -1);
    let verdict = '';
    if (!sim.running && best) {
      const mine = ranked.find(m => m.i === actual);
      if (!mine) verdict = `After simulation, Quackle prefers <b>${label(best)}</b>.`;
      else if (mine.i === best.i) verdict = `<b>After simulation, your play comes out on top.</b>`;
      else verdict = `After simulation, Quackle prefers <b>${label(best)}</b>; your play ranks ${ranked.indexOf(mine) + 1} of ${ranked.length}, ${(best.simEquity - mine.simEquity).toFixed(1)} behind.`;
    }
    table = `${verdict ? `<p class="verdict">${verdict}</p>` : ''}
      <div class="moves-wrap qk-table"><table><thead><tr><th>#</th><th>Play</th><th class="num">Static</th><th class="num">Simulated</th><th class="num">Win</th><th>Keeps</th></tr></thead><tbody>${
        ranked.map((m, k) => {
          const d = m.simEquity - m.staticEquity;
          return `<tr class="${m.i === actual ? 'played' : ''}"><td>${k + 1}</td><td>${label(m)}${m.i === actual ? ' <span class="badge">yours</span>' : ''}</td><td class="num">${m.staticEquity.toFixed(1)}</td><td class="num"><b>${m.simEquity.toFixed(1)}</b> <span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}</span></td><td class="num">${m.win === null ? '–' : m.win.toFixed(0) + '%'}</td><td class="not">${keeps(m)}</td></tr>`;
        }).join('')}</tbody></table></div>`;
  }
  return `<div class="sim">${head}${table}${controls(!!sim.running)}${!sim.running ? '<p class="note">Simulated equity is points scored minus the opponent\'s over the turns played out, plus the value of what\'s left. Win chances use Quackle\'s estimate from the scores and tiles left. More time gives steadier numbers.</p>' : ''}</div>`;
}
