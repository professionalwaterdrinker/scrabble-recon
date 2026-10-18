// Why one play beats another: facts measured from Quackle's numbers, the board and
// sampled opponent replies, turned into a checklist.

const N = 15;
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
const BINGO_FRIENDLY = new Set(['A', 'E', 'I', 'L', 'N', 'R', 'S', 'T', '?']);
const COLS = 'ABCDEFGHIJKLMNO';
const sq = i => COLS[i % N] + (((i / N) | 0) + 1);

/* ---------- the tiles kept ---------- */

export function leaveFacts(leave) {
  const tiles = [...(leave || '')];
  const counts = {};
  tiles.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const vowels = tiles.filter(t => VOWELS.has(t)).length;
  const blanks = counts['?'] || 0;
  const consonants = tiles.length - vowels - blanks;
  return {
    tiles: tiles.join(''), size: tiles.length, vowels, consonants, blanks,
    esses: counts.S || 0,
    duplicates: Object.keys(counts).filter(t => t !== '?' && counts[t] > 1).map(t => t.repeat(counts[t])),
    qWithoutU: !!counts.Q && !counts.U,
    bingoFriendly: tiles.filter(t => BINGO_FRIENDLY.has(t)).length,
    // a leave of 3 to 6 tiles is "balanced" with roughly 40-60% vowels
    balance: tiles.length < 2 ? 'small' : vowels / Math.max(1, tiles.length - blanks) > 0.67 ? 'vowel-heavy' : vowels === 0 && consonants >= 3 ? 'no vowels' : vowels / Math.max(1, tiles.length - blanks) < 0.2 && consonants >= 4 ? 'consonant-heavy' : 'balanced',
  };
}

/* ---------- the board ---------- */

// Squares of a play, from Quackle's place and tiles ("." = already on the board).
export function playSquares(mv) {
  const h = /^(\d+)([A-O])$/i.exec(mv.place || ''), v = /^([A-O])(\d+)$/i.exec(mv.place || '');
  if (!h && !v) return [];
  const r0 = h ? +h[1] - 1 : +v[2] - 1, c0 = COLS.indexOf((h ? h[2] : v[1]).toUpperCase()), dr = h ? 0 : 1, dc = h ? 1 : 0;
  return [...mv.tiles].map((ch, k) => ({ i: (r0 + dr * k) * N + c0 + dc * k, ch: ch === '.' ? null : ch.toUpperCase(), blank: ch !== '.' && ch !== ch.toUpperCase() }));
}
const neighbours = i => { const r = (i / N) | 0, c = i % N, out = []; if (c > 0) out.push(i - 1); if (c < N - 1) out.push(i + 1); if (r > 0) out.push(i - N); if (r < N - 1) out.push(i + N); return out; };
const touching = (cells, i) => !cells[i] && neighbours(i).some(j => cells[j]);

// Lines (rows and columns) with a stretch of 7+ empty squares that touches a tile:
// room for a bingo.
function bingoLines(cells) {
  let lines = 0;
  for (let d = 0; d < 2; d++) for (let a = 0; a < N; a++) {
    let run = 0, touches = false, found = false;
    for (let b = 0; b <= N; b++) {
      const i = d === 0 ? a * N + b : b * N + a;
      if (b < N && !cells[i]) { run++; if (touching(cells, i)) touches = true; }
      else { if (run >= 7 && touches) found = true; run = 0; touches = false; }
    }
    if (found) lines++;
  }
  return lines;
}

export function boardFacts(cellsBefore, mv, PREM) {
  const after = cellsBefore.slice();
  playSquares(mv).forEach(s => { if (s.ch) after[s.i] = s.ch; });
  const opened = [], closed = [];
  for (let i = 0; i < N * N; i++) {
    if (PREM[i] !== 'tw' && PREM[i] !== 'dw' && PREM[i] !== 'tl') continue;
    const was = touching(cellsBefore, i), now = touching(after, i);
    if (now && !was) opened.push({ square: sq(i), kind: PREM[i] });
    if (was && !now) closed.push({ square: sq(i), kind: PREM[i] });
  }
  const frontier = cells => { let n = 0; for (let i = 0; i < N * N; i++) if (touching(cells, i)) n++; return n; };
  return {
    opened, closed,
    bingoLinesBefore: bingoLines(cellsBefore), bingoLinesAfter: bingoLines(after),
    openSquaresBefore: frontier(cellsBefore), openSquaresAfter: frontier(after),
    tilesPlaced: playSquares(mv).filter(s => s.ch).length,
    usedBlank: playSquares(mv).some(s => s.blank),
  };
}

/* ---------- the opponent's next move ---------- */

// replies: [{ rack, move }] from the engine's sampling
export function replyFacts(replies, label) {
  const scores = replies.map(r => r.move.action === 'place' ? r.move.score : 0);
  const n = scores.length || 1;
  const groups = new Map();
  replies.forEach(r => {
    if (r.move.action !== 'place') return;
    const key = r.move.place + ' ' + r.move.tiles;
    const g = groups.get(key) || { move: r.move, count: 0, rack: r.rack };
    g.count++; groups.set(key, g);
  });
  const worst = [...groups.values()].sort((a, b) => b.move.score - a.move.score).slice(0, 3)
    .map(g => ({ move: g.move, label: label(g.move), score: g.move.score, rack: g.rack, share: g.count / n }));
  const bingos = replies.filter(r => r.move.action === 'place' && [...r.move.tiles].filter(c => c !== '.').length === 7).length;
  return {
    samples: replies.length,
    average: scores.reduce((s, v) => s + v, 0) / n,
    over30: scores.filter(v => v >= 30).length / n,
    over40: scores.filter(v => v >= 40).length / n,
    bingo: bingos / n,
    worst,
  };
}

/* ---------- putting it together ---------- */

export function moveFacts(mv, { cellsBefore, PREM, replies, label }) {
  return {
    play: label(mv), score: mv.score, equity: +mv.equity.toFixed(1),
    leaveValue: mv.leaveValue != null ? +mv.leaveValue.toFixed(1) : null,
    boardValue: mv.board != null ? +mv.board.toFixed(1) : null,
    // what's left of the equity: Quackle's opening-move placement bonus
    placementValue: mv.leaveValue != null && mv.board != null ? +(mv.equity - mv.score - mv.leaveValue - mv.board).toFixed(1) : 0,
    leave: leaveFacts(mv.leave),
    board: mv.action === 'place' ? boardFacts(cellsBefore, mv, PREM) : null,
    replies: replies ? replyFacts(replies, label) : null,
    kind: mv.action,
  };
}

const pct = x => `${Math.round(x * 100)}%`;
const oneIn = x => x >= 0.5 ? `${Math.round(x * 100)}% of racks` : x > 0 ? `about 1 in ${Math.max(2, Math.round(1 / x))} racks` : 'no sampled racks';

// Plain-language checklist from the facts. `top` is Quackle's choice, `mine` the play made.
export function checklist(top, mine) {
  const why = [], weak = [];
  const dScore = top.score - mine.score;
  const dLeave = (top.leaveValue ?? 0) - (mine.leaveValue ?? 0);
  const dBoard = (top.boardValue ?? 0) - (mine.boardValue ?? 0);
  if (dScore > 0) why.push(`Scores ${dScore} more point${dScore === 1 ? '' : 's'} now (${top.score} against ${mine.score}).`);
  if (dLeave > 1.5) why.push(`Keeps a better leave: ${top.leave.tiles || 'nothing'} is worth ${dLeave.toFixed(1)} more to Quackle than ${mine.leave.tiles || 'nothing'}.`);
  if (dScore < 0 && dLeave > 0) why.push(`Gives up ${-dScore} point${dScore === -1 ? '' : 's'} now to keep stronger tiles for next turn.`);
  if (top.leave.esses > mine.leave.esses) why.push('Holds on to an S, which is worth saving for a hook or a bingo.');
  if (top.leave.blanks > mine.leave.blanks) why.push('Keeps the blank for a bigger play later.');
  if (top.leave.bingoFriendly - mine.leave.bingoFriendly >= 2 && top.leave.size >= 3) why.push('Keeps more bingo-friendly letters (A, E, I, L, N, R, S, T).');
  if (dBoard > 1.5) why.push('Quackle rates its effect on the board as safer.');
  if (top.placementValue - mine.placementValue > 1) why.push('Places the opening word more safely, keeping vowels away from the squares the opponent can use for big scores.');
  const tr = top.replies, mr = mine.replies;
  if (tr && mr) {
    const dAvg = mr.average - tr.average;
    if (dAvg > 2) why.push(`Leaves the opponent less to work with: their best reply averages ${tr.average.toFixed(0)} points, against ${mr.average.toFixed(0)} after your play.`);
    // be honest when Quackle's play is the riskier one
    else if (dAvg < -2) why.push(`It does give the opponent more to work with (their best reply averages ${tr.average.toFixed(0)} against ${mr.average.toFixed(0)} after yours), but the gains above outweigh that.`);
  }
  if (top.board && mine.board && top.board.bingoLinesAfter < mine.board.bingoLinesAfter) why.push('Leaves fewer open lines for a bingo.');

  // weak points only count when Quackle's play doesn't share them
  const tl = top.leave, ml = mine.leave;
  if (ml.qWithoutU && !tl.qWithoutU) weak.push('Keeps the Q without a U, which is hard to play.');
  if (ml.duplicates.length && ml.duplicates.join() !== tl.duplicates.join()) weak.push(`Keeps duplicate letters (${ml.duplicates.join(', ')}), which limit your next rack.`);
  if (ml.balance !== 'balanced' && ml.balance !== 'small' && ml.balance !== tl.balance) weak.push(`Leaves a ${ml.balance} rack (${ml.tiles}).`);
  if (mine.kind === 'pass') weak.unshift('Passing scores nothing and keeps exactly the same tiles.');
  else if (mine.kind === 'exchange') weak.unshift(`Exchanging scores nothing this turn, while Quackle found ${top.score} points.`);
  else if (ml.size >= 4 && tl.size < ml.size && dScore >= 10) weak.push(`Plays only ${7 - ml.size} tile${7 - ml.size === 1 ? '' : 's'}, keeping ${ml.size} that don't fit together as well as Quackle's leave.`);
  if (mine.board) {
    const count = (b, kind) => b ? b.opened.filter(o => o.kind === kind).length : 0;
    const tw = mine.board.opened.filter(o => o.kind === 'tw'), dw = mine.board.opened.filter(o => o.kind === 'dw');
    if (tw.length > count(top.board, 'tw')) weak.push(`Opens the triple-word square${tw.length > 1 ? 's' : ''} at ${tw.map(o => o.square).join(', ')}.`);
    if (dw.length >= 2 && dw.length > count(top.board, 'dw')) weak.push(`Opens double-word squares at ${dw.map(o => o.square).join(', ')}.`);
    if (mine.board.bingoLinesAfter > mine.board.bingoLinesBefore && (!top.board || mine.board.bingoLinesAfter > top.board.bingoLinesAfter)) weak.push('Opens a new line where the opponent could bingo.');
    if (mine.board.usedBlank && dScore > 0) weak.push(`Uses the blank for only ${mine.score} points.`);
  }
  if (mr && tr) {
    if (mr.over40 >= 0.15 && mr.over40 - tr.over40 >= 0.05) weak.push(`The opponent scores 40 or more next turn with ${oneIn(mr.over40)}, against ${oneIn(tr.over40)} after Quackle's play.`);
    else if (mr.over30 >= 0.25 && mr.over30 - tr.over30 >= 0.05) weak.push(`The opponent scores 30 or more next turn with ${oneIn(mr.over30)}, against ${oneIn(tr.over30)} after Quackle's play.`);
    if (mr.bingo >= 0.05 && mr.bingo - tr.bingo >= 0.03) weak.push(`The opponent bingos next turn with ${oneIn(mr.bingo)}, against ${oneIn(tr.bingo)} after Quackle's play.`);
  }
  if (!why.length) why.push('The plays are close; Quackle prefers it by a small margin on its overall valuation.');
  if (!weak.length) weak.push('No single big weakness: it falls a little behind on overall value.');
  return { why, weak };
}

