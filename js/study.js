// The Study tab: browse curated word lists (Wordwall) and review them as spaced
// flashcards (Wordvault). Everything is worked out from the active word list.
import { LISTS, buildIndex, answersFor, hooksOf, cardId, parseId, alphagram } from './study-lists.js';
import { openVault, definition, INTERVALS, LEARNED_BOX } from './vault.js';

const PAGE = 60, SESSION_CRAM = 20;
const VAL = { A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10 };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createStudy(ctx) {
  const { $, escapeHtml } = ctx;
  const root = $('study');
  const st = {
    active: false, view: 'lists', listId: null, index: null, indexKey: null, vault: null,
    cards: {}, filter: '', hide: false, shown: PAGE, open: new Set(), mode: 'flip', help: false, session: null,
    // history view
    histTab: 'sessions', sel: new Set(), cardFilter: 'progress', cardQuery: '', cardShown: 100, openSession: null, undo: null,
  };
  try { st.mode = localStorage.getItem('mabble.studyMode') || 'flip'; } catch (e) {}

  /* ---------- data ---------- */
  async function ready() {
    const lex = ctx.lexicon();
    if (!lex.set) return false;
    if (st.indexKey !== lex.key) {
      root.innerHTML = '<div class="st-wrap"><p class="st-loading"><span class="spinner"></span>Preparing the study lists…</p></div>';
      await new Promise(r => setTimeout(r, 30));
      st.index = buildIndex(lex.set); st.indexKey = lex.key; st.cards = {};
      st.vault = await openVault(lex.vaultKey);
    }
    return true;
  }
  const listCards = id => st.cards[id] || (st.cards[id] = LISTS.find(l => l.id === id).build(st.index));
  const listIds = id => listCards(id).map(cardId);

  /* ---------- pieces ---------- */
  const tiles = (letters, cls = '') => `<span class="st-tiles ${cls}" aria-label="${letters.split('').join(' ')}">${[...letters].map(ch => `<span class="st-tile">${ch}<i>${VAL[ch] ?? ''}</i></span>`).join('')}</span>`;
  const progress = (value, total, cls = '') => `<span class="st-bar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${value}"><span style="width:${total ? (100 * value / total).toFixed(1) : 0}%"></span></span>`;
  const wordWithHooks = w => {
    const h = hooksOf(st.index, w);
    return `<span class="hk front" title="Front hooks">${h.front.join('').toLowerCase()}</span><span class="w">${w}</span><span class="hk back" title="Back hooks">${h.back.join('').toLowerCase()}</span>`;
  };
  function cue(card, answers) {
    if (card.kind === 'anagram') return plural(answers.length, 'word');
    if (card.kind === 'hook') return answers.length ? plural(answers.length, 'hook') : 'no hooks';
    return plural(answers.length, 'letter');
  }
  function answersHtml(card, answers, { defs = true } = {}) {
    if (card.kind === 'anagram') return `<ul class="st-words">${answers.map(w => `<li><button type="button" class="st-word" data-word="${w}">${wordWithHooks(w)}</button>${defs && st.open.has(w) ? `<div class="st-def" data-def="${w}">${defHtml(w)}</div>` : ''}</li>`).join('')}</ul>`;
    if (card.kind === 'hook') {
      const front = answers.filter(a => a.endsWith('-')).map(a => a[0]), back = answers.filter(a => a.startsWith('-')).map(a => a[1]);
      return `<div class="st-hooks"><span class="st-pos">Before</span><span class="hk-side">${front.join(' ') || '–'}</span><span class="st-pos">After</span><span class="hk-side">${back.join(' ') || '–'}</span></div>
        <p class="st-sub">${front.map(L => L + card.prompt).concat(back.map(L => card.prompt + L)).join(' · ') || 'Nothing hooks onto this word.'}</p>`;
    }
    return `<div class="st-stem">${answers.map(a => `<span class="st-stem-row"><b>${a.letter}</b>${a.words.join(' ')}</span>`).join('')}</div>`;
  }
  const defCache = {};
  function defHtml(w) {
    const d = defCache[w];
    if (!d) { loadDef(w); return '<span class="st-def-wait">Looking it up…</span>'; }
    if (d.offline) return '<span class="st-def-wait">Definition unavailable offline.</span>';
    if (d.none) return '<span class="st-def-wait">No definition found.</span>';
    return d.senses.map(s => `<span class="st-pos">${escapeHtml(s.pos || '')}</span> ${escapeHtml(s.text)}`).join('<br>');
  }
  async function loadDef(w) {
    if (defCache[w] === null) return;
    defCache[w] = null;
    const d = await definition(w);
    defCache[w] = d;
    root.querySelectorAll(`[data-def="${w}"]`).forEach(el => { el.innerHTML = defHtml(w); });
  }

  /* ---------- views ---------- */
  function shell(inner) {
    const s = st.vault.stats();
    const lex = ctx.lexicon();
    return `<div class="st-wrap">
      <div class="st-top">
        <div class="st-seg" role="tablist" aria-label="Study">
          <button role="tab" data-go="lists" aria-selected="${st.view === 'lists' || st.view === 'list'}">Word lists</button>
          <button role="tab" data-go="review" aria-selected="${st.view === 'review' || st.view === 'session' || st.view === 'done'}">Review${s.due + Math.min(s.fresh, s.newLeft) ? ` <span class="st-pill">${s.due + Math.min(s.fresh, s.newLeft)}</span>` : ''}</button>
          <button role="tab" data-go="history" aria-selected="${st.view === 'history'}">History</button>
        </div>
        <span class="st-lex">${escapeHtml(lex.name)}<button type="button" class="st-help-btn" data-help aria-label="Keyboard shortcuts">?</button></span>
      </div>
      ${inner}
      ${st.help ? helpHtml() : ''}
    </div>`;
  }
  function helpHtml() {
    const k = (key, what) => `<li><kbd>${key}</kbd><span>${what}</span></li>`;
    return `<div class="st-help" role="dialog" aria-label="Keyboard shortcuts"><div class="st-help-card">
      <h3>Keyboard shortcuts</h3>
      <ul>${k('Space', 'Show the answer')}${k('1', 'Again: show it again soon')}${k('2', 'Good')}${k('3', 'Easy')}${k('Enter', 'Check a typed word (empty: show the answer)')}${k('Esc', 'End the session')}${k('/', 'Search a list')}${k('Del', 'Delete the ticked cards (History)')}${k('?', 'Show or hide this')}</ul>
      <button class="btn" type="button" data-help>Close</button></div></div>`;
  }

  function listsView() {
    const groups = [...new Set(LISTS.map(l => l.group))];
    return shell(`<div class="st-hero"><h2>Word lists</h2><p>Browse the words that win games, then add a list to your reviews to learn it a few cards a day.</p></div>
      ${groups.map(g => `<section class="st-group"><h3>${g}</h3><div class="st-grid">${LISTS.filter(l => l.group === g).map(l => {
        const ids = listIds(l.id), p = st.vault.listProgress(ids), added = st.vault.data.lists.includes(l.id);
        return `<button type="button" class="st-list" data-list="${l.id}">
          <span class="st-list-title">${l.title}</span>
          <span class="st-list-blurb">${l.blurb}</span>
          <span class="st-list-foot"><span>${plural(ids.length, l.id === 'hooks2' ? 'word' : l.id === 'stems' ? 'stem' : 'card')}</span>${added ? `<span class="st-tag">${p.learned} learned</span>` : ''}</span>
          ${added ? progress(p.learned, p.total) : ''}
        </button>`;
      }).join('')}</div></section>`).join('')}`);
  }

  function listView() {
    const l = LISTS.find(x => x.id === st.listId), cards = listCards(l.id), added = st.vault.data.lists.includes(l.id);
    const q = st.filter.trim().toUpperCase();
    const match = c => {
      if (!q) return true;
      const a = answersFor(st.index, c), words = c.kind === 'stem' ? a.flatMap(x => x.words) : c.kind === 'anagram' ? a : [c.prompt];
      return c.prompt.includes(alphagram(q)) || words.some(w => w.includes(q));
    };
    const shown = cards.filter(match), page = shown.slice(0, st.shown);
    const p = st.vault.listProgress(listIds(l.id));
    return shell(`<div class="st-head">
        <button type="button" class="st-back" data-go="lists" aria-label="Back to all lists">←</button>
        <div><h2>${l.title}</h2><p>${l.blurb}</p></div>
      </div>
      <div class="st-actions">
        ${added ? `<span class="st-added">✓ In your reviews · ${p.learned} of ${p.total} learned</span><button type="button" class="btn" data-remove="${l.id}">Remove</button>`
          : `<button type="button" class="btn primary" data-add="${l.id}">Add to my reviews</button>`}
        <button type="button" class="btn" data-cram="${l.id}">Practise ${Math.min(SESSION_CRAM, cards.length)} now</button>
      </div>
      <div class="st-tools">
        <input type="search" id="stFilter" placeholder="Find letters or a word" value="${escapeHtml(st.filter)}" aria-label="Find letters or a word">
        <label class="st-switch"><input type="checkbox" id="stHide" ${st.hide ? 'checked' : ''}><span></span>Hide answers</label>
      </div>
      <div class="st-wall ${st.hide ? 'hidden-answers' : ''}">${page.map((c, k) => {
        const a = answersFor(st.index, c), id = cardId(c), open = st.open.has(id);
        return `<article class="st-card ${open ? 'open' : ''}" data-card="${id}">
          <div class="st-card-head">${tiles(c.prompt)}${c.kind === 'stem' ? '<span class="st-plus">+ ?</span>' : ''}</div>
          <div class="st-card-meta"><span class="st-cue">${cue(c, a)}</span><span class="st-rank">#${k + 1}</span></div>
          <div class="st-answers">${answersHtml(c, a)}</div>
          <button type="button" class="st-reveal" data-reveal="${id}">Show answers</button>
        </article>`;
      }).join('') || '<p class="hint">Nothing matches.</p>'}</div>
      ${shown.length > page.length ? `<div class="st-more"><button type="button" class="btn" data-more>Show ${Math.min(PAGE, shown.length - page.length)} more</button><span class="hint">${page.length} of ${shown.length}</span></div>` : ''}
      <p class="st-credit">Tap a word for its definition, from <a href="https://en.wiktionary.org/" target="_blank" rel="noopener">Wiktionary</a> (CC BY-SA). Faint letters either side of a word are its hooks.</p>`);
  }

  function reviewView() {
    const s = st.vault.stats(), sess = st.vault.session(), lists = st.vault.data.lists.map(id => LISTS.find(l => l.id === id)).filter(Boolean);
    const todo = sess.due.length + sess.fresh.length;
    if (!lists.length && !s.total) {
      return shell(`<div class="st-empty">
        <div class="st-empty-art">${tiles('LEARN')}</div>
        <h2>Nothing to review yet</h2>
        <p>Add a word list and Mabble will show you a few new cards a day, then bring each one back just before you'd forget it.</p>
        <div class="st-actions center"><button type="button" class="btn primary" data-add="twos">Start with two-letter words</button><button type="button" class="btn" data-add="top7">Top 7-letter bingos</button></div>
      </div>`);
    }
    const next = st.vault.nextDue();
    return shell(`<div class="st-hero"><h2>${todo ? 'Ready when you are' : 'All caught up'}</h2>
        <p>${todo ? `${plural(sess.due.length, 'card')} to review and ${plural(sess.fresh.length, 'new card')} today.` : next ? `The next card comes back ${when(next)}.` : 'Add another list for more cards.'}</p></div>
      <div class="st-stats">
        <div><b>${sess.due.length}</b><span>due</span></div>
        <div><b>${sess.fresh.length}</b><span>new today</span></div>
        <div><b>${s.learned}</b><span>learned</span></div>
        <div><b>${s.streak}</b><span>day streak</span></div>
      </div>
      <div class="st-mode" role="radiogroup" aria-label="How to answer">
        <button type="button" role="radio" aria-checked="${st.mode === 'flip'}" data-mode="flip"><b>Flip cards</b><span>See the letters, think, then check yourself</span></button>
        <button type="button" role="radio" aria-checked="${st.mode === 'type'}" data-mode="type"><b>Type answers</b><span>Type every word the letters make</span></button>
      </div>
      <button type="button" class="btn primary big st-start" data-start ${todo ? '' : 'disabled'}>${todo ? `Start review · ${todo}` : 'Nothing due'}</button>
      <section class="st-group"><h3>In your reviews</h3><div class="st-mine">${lists.map(l => {
        const p = st.vault.listProgress(listIds(l.id));
        return `<button type="button" class="st-mine-row" data-list="${l.id}"><span>${l.title}</span>${progress(p.learned, p.total)}<span class="hint">${p.learned}/${p.total}</span></button>`;
      }).join('')}<button type="button" class="st-mine-row add" data-go="lists">+ Add a list</button></div></section>`);
  }
  function when(t) {
    const m = (t - Date.now()) / 60000;
    if (m < 60) return `in ${Math.max(1, Math.round(m))} min`;
    if (m < 1440) return `in ${Math.round(m / 60)} h`;
    return `in ${plural(Math.round(m / 1440), 'day')}`;
  }

  /* ---------- history ---------- */
  const listTitle = id => id === 'retry' ? 'Missed cards' : (LISTS.find(l => l.id === id) || {}).title || id;
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function fmtDate(t) {
    const d = new Date(t), today = dayStart(Date.now()), day = dayStart(t);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (day === today) return `Today, ${time}`;
    if (day === today - 86400000) return `Yesterday, ${time}`;
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + `, ${time}`;
  }
  const minutes = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : plural(m, 'min'); };
  function nextLabel(c) {
    if (!c.seen) return 'New';
    const m = (c.due - Date.now()) / 60000;
    return m <= 0 ? 'Due now' : when(c.due).replace(/^in /, 'In ');
  }
  // a card's stage: one dot per box on the way to the longest wait
  const stage = c => `<span class="st-dots" title="Box ${c.box} of ${INTERVALS.length - 1}">${INTERVALS.slice(1).map((_, k) => `<i class="${k < c.box ? 'on' : ''}"></i>`).join('')}</span>`;

  function historyView() {
    const hist = st.vault.history().slice().reverse();
    const graded = hist.reduce((n, h) => n + h.graded, 0), right = hist.reduce((n, h) => n + h.right, 0);
    const s = st.vault.stats();
    const tabs = `<div class="st-subtabs" role="tablist" aria-label="History">
      <button role="tab" data-htab="sessions" aria-selected="${st.histTab === 'sessions'}">Past sessions <span class="hint">${hist.length}</span></button>
      <button role="tab" data-htab="cards" aria-selected="${st.histTab === 'cards'}">Cards in your reviews <span class="hint">${s.total}</span></button>
    </div>`;
    return shell(`<div class="st-hero"><h2>History</h2><p>${hist.length ? `${plural(hist.length, 'session')}, ${plural(graded, 'card')} reviewed${graded ? `, ${Math.round(100 * right / graded)}% right first time` : ''}.` : 'Your review sessions will show up here.'}</p></div>
      ${tabs}
      ${st.histTab === 'sessions' ? sessionsHtml(hist) : cardsHtml()}
      ${st.undo ? `<div class="st-toast" role="status">${plural(st.undo.entries.length, 'card')} deleted<button type="button" data-undo>Undo</button><button type="button" class="st-toast-x" data-undo-close aria-label="Dismiss">✕</button></div>` : ''}`);
  }

  function sessionsHtml(hist) {
    // the last two weeks, one bar per day
    const today = dayStart(Date.now()), days = [];
    for (let k = 13; k >= 0; k--) days.push({ t: today - k * 86400000, n: 0 });
    for (const h of hist) { const d = days.find(x => x.t === dayStart(h.at)); if (d) d.n += h.graded; }
    const max = Math.max(1, ...days.map(d => d.n));
    const chart = `<div class="st-activity" aria-label="Cards reviewed each day, last two weeks">${days.map(d => {
      const label = new Date(d.t).toLocaleDateString([], { weekday: 'narrow' });
      return `<div class="st-day ${d.t === today ? 'today' : ''}" title="${new Date(d.t).toLocaleDateString()}: ${plural(d.n, 'card')}"><span class="st-day-bar"><span style="height:${d.n ? Math.max(8, 100 * d.n / max) : 0}%"></span></span><small>${label}</small></div>`;
    }).join('')}</div>`;
    if (!hist.length) return `${chart}<div class="st-empty small"><p>No sessions yet. Finish or stop a review and it will appear here.</p><button type="button" class="btn primary" data-go="review">Go to Review</button></div>`;
    return `${chart}<ul class="st-sessions">${hist.map(h => {
      const pct = h.graded ? Math.round(100 * h.right / h.graded) : 0, open = st.openSession === h.at;
      return `<li class="${open ? 'open' : ''}">
        <button type="button" class="st-session-row" data-session="${h.at}" aria-expanded="${open}">
          <span class="st-ring mini" style="--pct:${pct}"><span>${pct}%</span></span>
          <span class="st-session-main"><b>${h.lists.map(listTitle).join(', ') || 'Review'}</b>
            <span class="hint">${fmtDate(h.at)} · ${minutes(h.end - h.at)} · ${h.mode === 'type' ? 'typed' : 'flip cards'}</span></span>
          <span class="st-session-side">${h.right}/${h.graded}${h.cram ? '<span class="st-tag soft">practice</span>' : ''}${h.finished ? '' : '<span class="st-tag warn">stopped early</span>'}</span>
        </button>
        ${open ? `<div class="st-session-detail">${h.missed.length ? `<span class="hint">Missed at first:</span> ${h.missed.map(id => `<span class="st-chip miss">${parseId(id).prompt}</span>`).join(' ')}` : '<span class="hint">Every card right first time.</span>'}
          <button type="button" class="linkish" data-del-session="${h.at}">Remove from history</button></div>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }

  function cardRows() {
    const q = st.cardQuery.trim().toUpperCase();
    return st.vault.cards().filter(([id, c]) => {
      const f = st.cardFilter;
      if (f === 'progress' && !(c.seen && c.box < LEARNED_BOX)) return false;
      if (f === 'new' && c.seen) return false;
      if (f === 'learned' && c.box < LEARNED_BOX) return false;
      if (!q) return true;
      const card = parseId(id);
      return card.prompt.includes(alphagram(q)) || (card.kind === 'anagram' && answersFor(st.index, card).some(w => w.includes(q)));
    }).sort((a, b) => (a[1].seen ? a[1].due : Infinity) - (b[1].seen ? b[1].due : Infinity) || a[1].added - b[1].added);
  }
  function cardsHtml() {
    const all = st.vault.cards(), count = f => all.filter(([, c]) => f === 'progress' ? c.seen && c.box < LEARNED_BOX : f === 'new' ? !c.seen : f === 'learned' ? c.box >= LEARNED_BOX : true).length;
    const rows = cardRows(), page = rows.slice(0, st.cardShown);
    // only cards still in the vault can stay selected
    for (const id of [...st.sel]) if (!st.vault.has(id)) st.sel.delete(id);
    const allOnPage = page.length && page.every(([id]) => st.sel.has(id));
    const chips = [['progress', 'In progress'], ['new', 'Not started'], ['learned', 'Learned'], ['all', 'All']];
    return `<div class="st-tools">
        <div class="st-chips" role="radiogroup" aria-label="Show">${chips.map(([f, label]) => `<button type="button" role="radio" aria-checked="${st.cardFilter === f}" data-cfilter="${f}">${label} <span>${count(f)}</span></button>`).join('')}</div>
        <input type="search" id="stCardFilter" placeholder="Find letters or a word" value="${escapeHtml(st.cardQuery)}" aria-label="Find a card">
      </div>
      <div class="st-selbar ${st.sel.size ? 'active' : ''}">
        <label class="st-check"><input type="checkbox" data-selall ${allOnPage ? 'checked' : ''} ${page.length ? '' : 'disabled'}><span></span>${st.sel.size ? `${st.sel.size} selected` : 'Select all'}</label>
        ${st.sel.size ? `<button type="button" class="linkish" data-selnone>Clear</button><button type="button" class="btn danger" data-delete>Delete ${plural(st.sel.size, 'card')}</button>` : '<span class="hint">Tick cards to remove them from your reviews.</span>'}
      </div>
      ${page.length ? `<ul class="st-cardlist">${page.map(([id, c]) => {
        const card = parseId(id), on = st.sel.has(id), a = card.kind === 'anagram' ? answersFor(st.index, card) : [];
        return `<li class="${on ? 'sel' : ''}">
          <label class="st-check"><input type="checkbox" data-sel="${id}" ${on ? 'checked' : ''} aria-label="Select ${card.prompt}"><span></span></label>
          <span class="st-cl-card">${tiles(card.prompt, 'small')}<span class="hint">${card.kind === 'anagram' ? a.join(' · ') : card.kind === 'hook' ? 'hooks' : 'stem'}</span></span>
          <span class="st-cl-list hint">${listTitle(c.list)}</span>
          ${stage(c)}
          <span class="st-cl-next ${c.seen && c.due <= Date.now() ? 'due' : ''}">${nextLabel(c)}</span>
          <span class="st-cl-score hint" title="Right and wrong answers">${c.right}✓ ${c.wrong}✗</span>
        </li>`;
      }).join('')}</ul>` : `<p class="hint st-none">${all.length ? 'No cards match.' : 'Nothing in your reviews yet. Add a word list to start.'}</p>`}
      ${rows.length > page.length ? `<div class="st-more"><button type="button" class="btn" data-cmore>Show ${Math.min(100, rows.length - page.length)} more</button><span class="hint">${page.length} of ${rows.length}</span></div>` : ''}`;
  }
  function deleteSelected() {
    const ids = [...st.sel], entries = ids.map(id => [id, st.vault.card(id)]).filter(([, c]) => c), lists = st.vault.data.lists.slice();
    st.vault.deleteCards(ids);
    st.sel.clear();
    clearTimeout(st.undoTimer);
    st.undo = { entries, lists };
    st.undoTimer = setTimeout(() => { st.undo = null; if (st.view === 'history') render(); }, 8000);
    render();
  }

  /* ---------- review session ---------- */
  function startSession(ids, cram, source) {
    // spread new cards among the reviews instead of saving them all for the end
    let queue = ids;
    if (!cram) {
      const { due, fresh } = st.vault.session();
      queue = []; let f = 0;
      due.forEach((id, k) => { queue.push(id); if (k % 3 === 2 && f < fresh.length) queue.push(fresh[f++]); });
      while (f < fresh.length) queue.push(fresh[f++]);
    }
    if (!queue.length) return;
    st.session = { queue, pos: 0, cram, source, total: queue.length, passed: 0, right: 0, missed: new Set(), flipped: false, found: [], msg: '', t0: Date.now(), cardStart: Date.now(), log: [], recorded: false };
    st.view = 'session'; render();
  }
  function sessionView() {
    const s = st.session, id = s.queue[s.pos], card = parseId(id), answers = answersFor(st.index, card);
    const typing = st.mode === 'type' && card.kind === 'anagram' && !s.flipped;
    const label = { anagram: 'Anagram', hook: 'Hooks', stem: 'Bingo stem' }[card.kind];
    const ask = card.kind === 'anagram' ? 'What words do these letters make?' : card.kind === 'hook' ? 'Which letters go before or after it?' : 'Which letters make a seven-letter word?';
    const c = st.vault.card(id);
    const hint = g => { if (g === 0) return '< 5 min'; const box = Math.min(INTERVALS.length - 1, Math.max(1, (c ? c.box : 0) + g)); const d = INTERVALS[box]; return plural(d, 'day'); };
    return `<div class="st-wrap st-session">
      <div class="st-sbar">
        <button type="button" class="st-x" data-end aria-label="End session">✕</button>
        ${progress(s.passed, s.total, 'big')}
        <span class="st-count">${s.passed}/${s.total}</span>
      </div>
      <div class="st-stage">
        <div class="st-flash ${s.flipped ? 'flipped' : ''} ${s.flash || ''}" id="stFlash">
          <div class="st-face front">
            <span class="st-kind">${label}${c && !c.seen && !s.cram ? ' · new' : ''}</span>
            <div class="st-prompt">${tiles(card.prompt, 'big')}${card.kind === 'stem' ? '<span class="st-plus">+ ?</span>' : ''}</div>
            <p class="st-ask">${ask}</p>
            <span class="st-cue big">${cue(card, answers)}</span>
            ${typing ? `<div class="st-type">
                <div class="st-found">${answers.map(w => s.found.includes(w) ? `<span class="st-chip ok">${w}</span>` : `<span class="st-chip blank">${'·'.repeat(w.length)}</span>`).join('')}</div>
                <input id="stInput" class="st-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Type a word, press Enter" aria-label="Type a word">
                <p class="st-msg" aria-live="polite">${escapeHtml(s.msg)}</p>
              </div>` : `<p class="st-key"><kbd>Space</kbd> to show the answer</p>`}
          </div>
          <div class="st-face back">
            <span class="st-kind">${label}</span>
            <div class="st-prompt small">${tiles(card.prompt)}</div>
            ${answersHtml(card, answers)}
            ${card.kind === 'anagram' ? '<p class="st-credit">Tap a word for its definition.</p>' : ''}
          </div>
        </div>
      </div>
      <div class="st-grades ${s.flipped ? '' : 'waiting'}">
        ${s.flipped ? `
          <button type="button" class="st-grade again" data-grade="0"><b>Again</b><span>${hint(0)}</span><kbd>1</kbd></button>
          <button type="button" class="st-grade good" data-grade="1"><b>Good</b><span>${hint(1)}</span><kbd>2</kbd></button>
          <button type="button" class="st-grade easy" data-grade="2"><b>Easy</b><span>${hint(2)}</span><kbd>3</kbd></button>`
        : `<button type="button" class="btn primary big" data-flip>${typing ? 'Show the answer' : 'Show the answer'}</button>`}
      </div>
    </div>`;
  }
  function flip() {
    const s = st.session; if (!s || s.flipped) return;
    s.flipped = true;
    // the first word's meaning is the one people want; fetch it straight away
    const card = parseId(s.queue[s.pos]);
    if (card.kind === 'anagram') { const a = answersFor(st.index, card); if (a[0]) st.open.add(a[0]); }
    render();
  }
  function grade(g) {
    const s = st.session; if (!s || !s.flipped) return;
    const id = s.queue[s.pos];
    if (!s.cram || st.vault.has(id)) st.vault.grade(id, g);
    s.log.push({ id, g });
    if (g === 0) {
      s.missed.add(id);
      // try it again a few cards later
      s.queue.splice(Math.min(s.queue.length, s.pos + 4), 0, id);
    } else {
      s.passed++;
      if (!s.missed.has(id)) s.right++;
    }
    s.pos++; s.flipped = false; s.found = []; s.msg = ''; s.cardStart = Date.now(); st.open.clear();
    if (s.pos >= s.queue.length) { finishSession(true); st.view = 'done'; render(); return; }
    render();
  }
  // Log a session in the history once, when it ends or is stopped (if anything was graded).
  function finishSession(finished) {
    const s = st.session;
    if (!s || s.recorded || !s.log.length) return;
    s.recorded = true;
    const ids = [...new Set(s.log.map(x => x.id))];
    const lists = s.source ? [s.source] : [...new Set(ids.map(id => (st.vault.card(id) || {}).list).filter(Boolean))];
    st.vault.recordSession({
      at: s.t0, end: Date.now(), mode: st.mode, cram: !!s.cram, lists, planned: s.total, graded: ids.length,
      right: s.right, passed: s.passed, missed: [...s.missed], finished,
    });
  }
  function endSession() {
    const s = st.session;
    finishSession(false);
    st.view = s && s.passed ? 'done' : 'review'; render();
  }
  function typed(value) {
    const s = st.session, card = parseId(s.queue[s.pos]), answers = answersFor(st.index, card);
    const w = value.trim().toUpperCase();
    if (!w) { s.flipped = true; s.flash = ''; render(); return; }      // empty Enter: show the answer
    if (s.found.includes(w)) { feedback('Already found.', 'shake'); return; }
    if (answers.includes(w)) {
      s.found.push(w); s.msg = '';
      if (s.found.length === answers.length) {
        // all of them: a quick green pulse, then the next card on its own
        s.flash = 'right'; render();
        const quick = Date.now() - s.cardStart < 8000;
        setTimeout(() => { s.flash = ''; s.flipped = true; grade(quick ? 2 : 1); }, reduced() ? 150 : 650);
        return;
      }
      render(); return;
    }
    feedback(alphagram(w) === card.prompt ? `${w} isn't in ${ctx.lexicon().name}.` : `${w} doesn't use these letters.`, 'shake');
  }
  function feedback(msg, cls) {
    const s = st.session; s.msg = msg; render();
    const el = $('stFlash'); if (!el || reduced()) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  }
  function doneView() {
    const s = st.session, mins = Math.max(1, Math.round((Date.now() - s.t0) / 60000));
    const pct = s.total ? Math.round(100 * s.right / s.total) : 0, next = st.vault.nextDue();
    return shell(`<div class="st-done">
      <div class="st-ring" style="--pct:${pct}"><span>${pct}%</span></div>
      <h2>${pct >= 90 ? 'Brilliant!' : pct >= 70 ? 'Nice work' : 'Good practice'}</h2>
      <p>${plural(s.right, 'card')} right first time out of ${s.total}, in about ${plural(mins, 'minute')}.${!s.cram && next ? ` Next review ${when(next)}.` : ''}</p>
      <div class="st-actions center">
        <button type="button" class="btn primary" data-go="review">Done</button>
        ${s.missed.size ? `<button type="button" class="btn" data-again>Go over the ${plural(s.missed.size, 'miss')} again</button>` : ''}
      </div>
    </div>`);
  }

  /* ---------- rendering and events ---------- */
  function render() {
    if (!st.active) return;
    const focused = document.activeElement && ['stFilter', 'stCardFilter'].includes(document.activeElement.id) ? document.activeElement.id : null;
    const caret = focused ? document.activeElement.selectionStart : null;
    // cards fade in when a view opens, not on every click inside it
    const key = st.view + ':' + (st.listId || '') + ':' + (st.session ? st.session.pos : '');
    root.classList.toggle('st-enter', key !== st.lastKey); st.lastKey = key;
    root.innerHTML = st.view === 'list' ? listView() : st.view === 'history' ? historyView() : st.view === 'review' ? reviewView() : st.view === 'session' ? sessionView() : st.view === 'done' ? doneView() : listsView();
    if (focused && $(focused)) { const f = $(focused); f.focus(); f.setSelectionRange(caret, caret); }
    const input = $('stInput'); if (input) input.focus();
    ctx.onStats && ctx.onStats(st.vault.stats());
  }
  root.addEventListener('click', e => {
    const t = e.target.closest('button, [data-card]'); if (!t) return;
    const d = t.dataset;
    if (d.go) { st.view = d.go; st.shown = PAGE; st.filter = ''; st.open.clear(); if (d.go !== 'history') st.sel.clear(); render(); }
    else if (d.list) { st.view = 'list'; st.listId = d.list; st.shown = PAGE; st.filter = ''; st.open.clear(); render(); scrollTo({ top: 0 }); }
    else if (d.add) { st.vault.addList(d.add, listIds(d.add)); if (st.view !== 'list') st.view = 'review'; render(); }
    else if (d.remove) { st.vault.removeList(d.remove); render(); }
    else if (d.cram) { const ids = listIds(d.cram).filter(id => { const c = st.vault.card(id); return !c || c.box < 3; }).slice(0, SESSION_CRAM); startSession(ids.length ? ids : listIds(d.cram).slice(0, SESSION_CRAM), true, d.cram); }
    else if (d.more !== undefined) { st.shown += PAGE; render(); }
    else if (d.reveal) { st.open.add(d.reveal); render(); }
    else if (d.word) { st.open.has(d.word) ? st.open.delete(d.word) : st.open.add(d.word); render(); }
    else if (d.mode) { st.mode = d.mode; try { localStorage.setItem('mabble.studyMode', st.mode); } catch (e) {} render(); }
    else if (d.start !== undefined) startSession(null, false);
    else if (d.flip !== undefined) flip();
    else if (d.grade) grade(+d.grade);
    else if (d.end !== undefined) endSession();
    else if (d.again !== undefined) startSession([...st.session.missed], true, 'retry');
    else if (d.help !== undefined) { st.help = !st.help; render(); }
    else if (d.htab) { st.histTab = d.htab; render(); }
    else if (d.session) { st.openSession = st.openSession === +d.session ? null : +d.session; render(); }
    else if (d.delSession) { st.vault.deleteSessions([+d.delSession]); st.openSession = null; render(); }
    else if (d.cfilter) { st.cardFilter = d.cfilter; st.cardShown = 100; render(); }
    else if (d.cmore !== undefined) { st.cardShown += 100; render(); }
    else if (d.selnone !== undefined) { st.sel.clear(); render(); }
    else if (d.delete !== undefined) deleteSelected();
    else if (d.undo !== undefined && st.undo) { st.vault.restoreCards(st.undo.entries, st.undo.lists); st.undo = null; clearTimeout(st.undoTimer); render(); }
    else if (d.undoClose !== undefined) { st.undo = null; render(); }
  });
  root.addEventListener('input', e => {
    if (e.target.id === 'stFilter') { st.filter = e.target.value; st.shown = PAGE; render(); }
    else if (e.target.id === 'stCardFilter') { st.cardQuery = e.target.value; st.cardShown = 100; render(); }
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'stHide') { st.hide = t.checked; st.open.clear(); render(); }
    else if (t.dataset.sel) { t.checked ? st.sel.add(t.dataset.sel) : st.sel.delete(t.dataset.sel); render(); }
    else if (t.dataset.selall !== undefined) {
      const page = cardRows().slice(0, st.cardShown).map(([id]) => id);
      if (t.checked) page.forEach(id => st.sel.add(id)); else page.forEach(id => st.sel.delete(id));
      render();
    }
  });
  root.addEventListener('keydown', e => {
    if (e.target.id === 'stInput' && e.key === 'Enter') { e.preventDefault(); const v = e.target.value; e.target.value = ''; typed(v); }
  });
  document.addEventListener('keydown', e => {
    if (!st.active || e.ctrlKey || e.metaKey || e.altKey) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === '?' && !(inField && e.target.id === 'stInput')) { e.preventDefault(); st.help = !st.help; render(); return; }
    if (st.help && e.key === 'Escape') { st.help = false; render(); return; }
    if (st.view === 'session') {
      if (e.key === 'Escape') { e.preventDefault(); endSession(); return; }
      if (inField) return;
      if (e.key === ' ') { e.preventDefault(); flip(); }
      else if (st.session.flipped && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); grade(+e.key - 1); }
      else if (st.session.flipped && e.key === 'Enter') { e.preventDefault(); grade(1); }
    } else if (!inField && e.key === '/' && ($('stFilter') || $('stCardFilter'))) { e.preventDefault(); ($('stFilter') || $('stCardFilter')).focus(); }
    else if (st.view === 'history' && !inField && e.key === 'Delete' && st.sel.size) { e.preventDefault(); deleteSelected(); }
  });

  return {
    // the due count for the tab badge, without building the lists
    async refreshBadge() {
      const lex = ctx.lexicon(); if (!lex.set) return;
      const v = st.indexKey === lex.key && st.vault ? st.vault : await openVault(lex.vaultKey);
      ctx.onStats && ctx.onStats(v.stats());
    },
    async enter() {
      st.active = true;
      if (!(await ready())) { root.innerHTML = '<div class="st-wrap"><p class="st-loading"><span class="spinner"></span>Loading the word list…</p></div>'; return; }
      if (st.view === 'session' && !st.session) st.view = 'review';
      render();
    },
    leave() { if (st.view === 'session') finishSession(false); st.active = false; st.help = false; },
    // a different word list: different answers, and its own review history
    async lexiconChanged() { if (st.view === 'session') finishSession(false); st.indexKey = null; st.session = null; st.sel.clear(); st.undo = null; if (st.view === 'session' || st.view === 'done') st.view = 'review'; if (st.active) await this.enter(); },
  };
}
