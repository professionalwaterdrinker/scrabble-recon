// Wordvault: spaced review of study cards, kept in this browser's IndexedDB (one
// vault per word list). A simple box system: each correct answer moves a card up a
// box and the wait before it comes back grows; a miss sends it back to the start.

const DAY = 86400000, MIN = 60000;
export const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120];   // days, by box
export const NEW_PER_DAY = 15, MAX_REVIEWS = 60;
export const LEARNED_BOX = 3;                              // a week or more between reviews

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('mabble-study', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function get(key) {
  const d = await db();
  return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function put(key, value) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}

const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export async function openVault(lexKey) {
  const key = 'vault:' + lexKey;
  let v = null;
  try { v = await get(key); } catch (e) {}
  v = v || { cards: {}, lists: [], days: [], newToday: { day: '', n: 0 } };
  v.history = v.history || [];
  let saving = null;
  const save = () => { saving = (saving || Promise.resolve()).then(() => put(key, v)).catch(() => {}); return saving; };
  const vault = {
    data: v,
    has: id => !!v.cards[id],
    card: id => v.cards[id],
    // add cards from a list; they start as new and are introduced a few a day
    addList(listId, ids) {
      if (!v.lists.includes(listId)) v.lists.push(listId);
      let added = 0;
      for (const id of ids) if (!v.cards[id]) { v.cards[id] = { box: 0, due: 0, seen: 0, right: 0, wrong: 0, list: listId, added: Date.now() }; added++; }
      save(); return added;
    },
    removeList(listId) {
      v.lists = v.lists.filter(l => l !== listId);
      for (const id in v.cards) if (v.cards[id].list === listId && !v.cards[id].seen) delete v.cards[id];
      save();
    },
    // today's session: everything due, then new cards up to the daily allowance
    session(now = Date.now()) {
      const all = Object.entries(v.cards);
      const due = all.filter(([, c]) => c.seen && c.due <= now).sort((a, b) => a[1].due - b[1].due).slice(0, MAX_REVIEWS).map(([id]) => id);
      if (v.newToday.day !== dayKey(now)) v.newToday = { day: dayKey(now), n: 0 };
      const room = Math.max(0, NEW_PER_DAY - v.newToday.n);
      const fresh = all.filter(([, c]) => !c.seen).sort((a, b) => a[1].added - b[1].added || 0).slice(0, room).map(([id]) => id);
      return { due, fresh };
    },
    // grade: 0 = again, 1 = good, 2 = easy
    grade(id, g, now = Date.now()) {
      const c = v.cards[id]; if (!c) return null;
      if (!c.seen) { v.newToday.n++; }
      c.seen++; c.last = now;
      if (g === 0) { c.wrong++; c.box = 0; c.due = now + 5 * MIN; }
      else {
        c.right++;
        c.box = Math.min(INTERVALS.length - 1, Math.max(1, c.box + g));
        // a little spread so a batch learned together doesn't all come back on one day
        const days = INTERVALS[c.box] * (0.9 + Math.random() * 0.2);
        c.due = now + Math.max(10 * MIN, days * DAY);
      }
      const today = dayKey(now);
      if (v.days[v.days.length - 1] !== today) v.days.push(today), v.days.length > 400 && v.days.shift();
      save();
      return c;
    },
    stats(now = Date.now()) {
      const cards = Object.values(v.cards);
      const due = cards.filter(c => c.seen && c.due <= now).length;
      const learned = cards.filter(c => c.box >= LEARNED_BOX).length;
      const fresh = cards.filter(c => !c.seen).length;
      // days in a row with a review, counting today or yesterday as the latest
      let streak = 0;
      const set = new Set(v.days);
      for (let t = now; ; t -= DAY) { if (set.has(dayKey(t))) streak++; else if (t === now) continue; else break; if (streak > 400) break; }
      return { total: cards.length, due, learned, fresh, streak, newLeft: v.newToday.day === dayKey(now) ? Math.max(0, NEW_PER_DAY - v.newToday.n) : NEW_PER_DAY };
    },
    // one entry per finished or stopped session, newest last
    recordSession(entry) {
      v.history.push(entry);
      if (v.history.length > 300) v.history.splice(0, v.history.length - 300);
      save();
    },
    history: () => v.history,
    deleteSessions(ats) {
      const gone = new Set(ats);
      v.history = v.history.filter(h => !gone.has(h.at));
      save();
    },
    // take cards out of the reviews altogether (their progress goes with them)
    deleteCards(ids) {
      let n = 0;
      for (const id of ids) if (v.cards[id]) { delete v.cards[id]; n++; }
      // a list whose cards are all gone is no longer "in your reviews"
      v.lists = v.lists.filter(l => Object.values(v.cards).some(c => c.list === l));
      save(); return n;
    },
    cards: () => Object.entries(v.cards),
    // put deleted cards back (undo)
    restoreCards(entries, lists) {
      for (const [id, c] of entries) v.cards[id] = c;
      for (const l of lists) if (!v.lists.includes(l)) v.lists.push(l);
      save();
    },
    listProgress(ids) {
      let inVault = 0, learned = 0;
      for (const id of ids) { const c = v.cards[id]; if (c) { inVault++; if (c.box >= LEARNED_BOX) learned++; } }
      return { inVault, learned, total: ids.length };
    },
    nextDue(now = Date.now()) {
      let t = Infinity; for (const c of Object.values(v.cards)) if (c.seen && c.due > now && c.due < t) t = c.due;
      return t === Infinity ? null : t;
    },
  };
  return vault;
}

// Definitions come from Wiktionary, fetched only when a word is opened and kept on this device.
export async function definition(word) {
  const key = 'def2:' + word;   // bump to refresh saved definitions after a parsing change
  try { const hit = await get(key); if (hit !== undefined) return hit; } catch (e) {}
  let out = null;
  try {
    const r = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word.toLowerCase())}`, { headers: { accept: 'application/json' } });
    if (r.status === 404) out = { none: true };
    else if (r.ok) {
      const j = await r.json(), en = j.en || [];
      const text = html => {
        const d = new DOMParser().parseFromString(html, 'text/html');
        d.querySelectorAll('style, script, sup, .mw-ref').forEach(x => x.remove());
        return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
      };
      // playable words are nouns, verbs and the like, not codes, names or abbreviations
      const OFF = /^(symbol|proper noun|initialism|abbreviation|acronym|letter|prefix|suffix|contraction|romanization|phrase|proverb)$/i;
      const parts = en.filter(p => !OFF.test(p.partOfSpeech || ''));
      const senses = [];
      for (const part of parts.length ? parts : en) for (const d of part.definitions || []) {
        const t = text(d.definition || '');
        if (t && senses.length < 3) senses.push({ pos: part.partOfSpeech, text: t });
      }
      out = senses.length ? { senses } : { none: true };
    }
  } catch (e) { return { offline: true }; }
  if (out) { try { await put(key, out); } catch (e) {} }
  return out || { offline: true };
}
