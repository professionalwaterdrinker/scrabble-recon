// Study lists, worked out in the browser from whichever word list is active, so
// nothing copyrighted ships with the app. A card is either:
//   anagram: prompt = alphagram (letters sorted), answers = the words they spell
//   hook:    prompt = a word, answers = letters that go in front of it or after it
//   stem:    prompt = a 6-letter stem, answers = letters that turn it into a 7

const DIST = { A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1 };
const VOWELS = new Set('AEIOU');
export const alphagram = w => [...w].sort().join('');

// How many ways the tiles for this alphagram can be drawn from a full bag (no blanks):
// the higher, the more often the word turns up on a rack.
function choose(n, k) { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; }
const probCache = new Map();
export function probability(a) {
  const hit = probCache.get(a);
  if (hit !== undefined) return hit;
  const counts = {};
  for (const ch of a) counts[ch] = (counts[ch] || 0) + 1;
  let p = 1;
  for (const ch in counts) p *= choose(DIST[ch] || 0, counts[ch]);
  probCache.set(a, p);
  return p;
}

// One index per word list: alphagram -> words, built once and kept.
export function buildIndex(words) {
  const byAlpha = new Map(), set = words instanceof Set ? words : new Set(words);
  for (const w of set) {
    if (w.length > 9) continue;
    const a = alphagram(w);
    const list = byAlpha.get(a);
    if (list) list.push(w); else byAlpha.set(a, [w]);
  }
  for (const list of byAlpha.values()) list.sort();
  return { byAlpha, set };
}

export function hooksOf(index, w) {
  const front = [], back = [];
  for (let c = 65; c <= 90; c++) {
    const L = String.fromCharCode(c);
    if (index.set.has(L + w)) front.push(L);
    if (index.set.has(w + L)) back.push(L);
  }
  return { front, back };
}

const byProb = (a, b) => probability(b) - probability(a) || (a < b ? -1 : 1);
const alphasOfLength = (index, n) => [...index.byAlpha.keys()].filter(a => a.length === n);

// The curated lists. `build` returns the list's cards, best first.
export const LISTS = [
  {
    id: 'twos', title: 'Two-letter words', group: 'Must-know',
    blurb: 'Every two-letter word. The single most useful list in Scrabble.',
    build: ix => alphasOfLength(ix, 2).sort().map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'threes', title: 'Three-letter words', group: 'Must-know',
    blurb: 'All the threes, most likely to be drawn first.',
    build: ix => alphasOfLength(ix, 3).sort(byProb).map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'jqxz', title: 'Short J, Q, X and Z words', group: 'Must-know',
    blurb: 'Two- to four-letter words with the big-point tiles.',
    build: ix => [...ix.byAlpha.keys()].filter(a => a.length <= 4 && /[JQXZ]/.test(a))
      .sort((a, b) => a.length - b.length || byProb(a, b)).map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'top7', title: 'Top 7-letter bingos', group: 'Bingos',
    blurb: 'The 500 seven-letter racks you are most likely to draw that spell a word.',
    build: ix => alphasOfLength(ix, 7).sort(byProb).slice(0, 500).map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'top8', title: 'Top 8-letter bingos', group: 'Bingos',
    blurb: 'The 500 most likely eight-letter words, played through a tile on the board.',
    build: ix => alphasOfLength(ix, 8).sort(byProb).slice(0, 500).map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'stems', title: 'Best bingo stems', group: 'Bingos',
    blurb: 'Six-letter stems like SATIRE that make a seven with the most extra letters.',
    build: ix => {
      const stems = new Map();
      for (const a of alphasOfLength(ix, 7)) {
        for (let i = 0; i < 7; i++) {
          if (i && a[i] === a[i - 1]) continue;
          const s = a.slice(0, i) + a.slice(i + 1);
          (stems.get(s) || stems.set(s, new Set()).get(s)).add(a[i]);
        }
      }
      return [...stems].filter(([, set]) => set.size >= 6)
        .sort((x, y) => y[1].size - x[1].size || byProb(x[0], y[0])).slice(0, 60)
        .map(([s]) => ({ kind: 'stem', prompt: s }));
    },
  },
  {
    id: 'vowels', title: 'Vowel-heavy words', group: 'Specialty',
    blurb: 'Words that use up a rack full of vowels, like AIOLI and AUREI.',
    build: ix => [...ix.byAlpha.keys()].filter(a => a.length >= 4 && a.length <= 8 && [...a].filter(ch => VOWELS.has(ch)).length >= Math.ceil(a.length * 0.6))
      .sort((a, b) => a.length - b.length || byProb(a, b)).map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'qnou', title: 'Q without U', group: 'Specialty',
    blurb: 'Words that play the Q when there is no U in sight.',
    build: ix => [...ix.byAlpha.keys()].filter(a => a.includes('Q') && !a.includes('U') && a.length <= 8)
      .sort((a, b) => a.length - b.length || byProb(a, b)).map(a => ({ kind: 'anagram', prompt: a })),
  },
  {
    id: 'hooks2', title: 'Hooks on the twos', group: 'Hooks',
    blurb: 'The letters that go in front of or after each two-letter word.',
    build: ix => [...ix.set].filter(w => w.length === 2).sort().map(w => ({ kind: 'hook', prompt: w })),
  },
];

// The answers to a card under this word list.
export function answersFor(index, card) {
  if (card.kind === 'anagram') return index.byAlpha.get(card.prompt) || [];
  if (card.kind === 'hook') { const h = hooksOf(index, card.prompt); return [...h.front.map(L => L + '-'), ...h.back.map(L => '-' + L)]; }
  if (card.kind === 'stem') {
    const out = [];
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c), words = index.byAlpha.get(alphagram(card.prompt + L));
      if (words) out.push({ letter: L, words });
    }
    return out;
  }
  return [];
}
export const cardId = c => `${c.kind}:${c.prompt}`;
export const parseId = id => { const k = id.indexOf(':'); return { kind: id.slice(0, k), prompt: id.slice(k + 1) }; };
