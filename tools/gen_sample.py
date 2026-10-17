"""Simulate a plausible Scrabble game with the ENABLE list and print the final board.

Used once to make the app's built-in sample board. Not part of the app.
"""
import random, sys

N = 15
words = [w.strip().upper() for w in open(sys.argv[1]) if w.strip()]
WORDS = set(words)
pool = [w for w in words if 2 <= len(w) <= 6] * 3 + [w for w in words if len(w) in (7, 8)]
DIST = dict(A=9,B=2,C=2,D=4,E=12,F=2,G=3,H=2,I=9,J=1,K=1,L=4,M=2,N=6,O=8,P=2,Q=1,R=6,S=4,T=6,U=4,V=2,W=2,X=1,Y=2,Z=1)
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
rng = random.Random(seed)

board = [[None]*N for _ in range(N)]
used = {k: 0 for k in DIST}

def run(r, c, dr, dc):
    while 0 <= r-dr < N and 0 <= c-dc < N and board[r-dr][c-dc]:
        r -= dr; c -= dc
    s = ''
    while 0 <= r < N and 0 <= c < N and board[r][c]:
        s += board[r][c]; r += dr; c += dc
    return s

def try_place(w, r, c, dr, dc, first):
    er, ec = r + dr*(len(w)-1), c + dc*(len(w)-1)
    if not (0 <= r < N and 0 <= c < N and 0 <= er < N and 0 <= ec < N):
        return None
    # must not extend an existing word at the ends
    if 0 <= r-dr < N and 0 <= c-dc < N and board[r-dr][c-dc]: return None
    if 0 <= er+dr < N and 0 <= ec+dc < N and board[er+dr][ec+dc]: return None
    new = []
    touches = False
    for i, ch in enumerate(w):
        rr, cc = r+dr*i, c+dc*i
        cur = board[rr][cc]
        if cur:
            if cur != ch: return None
            touches = True
        else:
            new.append((rr, cc, ch))
    if not new or len(new) > 7: return None
    if first and not any(rr == 7 and cc == 7 for rr, cc, _ in new): return None
    need = {}
    for _, _, ch in new: need[ch] = need.get(ch, 0) + 1
    for ch, k in need.items():
        if used[ch] + k > DIST[ch]: return None
    for rr, cc, ch in new: board[rr][cc] = ch
    ok = True
    for rr, cc, ch in new:
        cw = run(rr, cc, dc, dr)
        if len(cw) >= 2:
            touches = True
            if cw not in WORDS: ok = False; break
    if ok and not first and not touches: ok = False
    if not ok:
        for rr, cc, _ in new: board[rr][cc] = None
        return None
    for _, _, ch in new: used[ch] += 1
    return new

moves = []
def undo(placed):
    for rr, cc, ch in placed:
        board[rr][cc] = None; used[ch] -= 1
for turn in range(40):
    cands = []
    for attempt in range(40000):
        w = rng.choice(pool)
        dr, dc = rng.choice([(0, 1), (1, 0)])
        if not moves:
            if len(w) > 5: continue
            off = rng.randrange(len(w))
            r, c = 7 - dr*off, 7 - dc*off
        else:
            r, c = rng.randrange(N), rng.randrange(N)
        placed = try_place(w, r, c, dr, dc, not moves)
        if placed:
            crosses = sum(1 for rr, cc, _ in placed if len(run(rr, cc, dc, dr)) >= 2)
            k = len(placed)
            score = crosses * 2 + (3 if 2 <= k <= 5 else (1 if k == 7 and rng.random() < 0.25 else -2)) + rng.random() * 3
            cands.append((score, w, r, c, dr, dc, k))
            undo(placed)
        if len(cands) >= 25: break
    if not cands: break
    score, w, r, c, dr, dc, k = max(cands)
    try_place(w, r, c, dr, dc, not moves)
    moves.append((w, r, c, 'H' if dc else 'V', k))
    if sum(used.values()) > 86: break

for row in board:
    print(''.join(ch or '.' for ch in row))
print(len(moves), 'moves', sum(used.values()), 'tiles', file=sys.stderr)
for m in moves: print(m, file=sys.stderr)
