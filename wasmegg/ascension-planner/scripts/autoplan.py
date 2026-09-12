#!/usr/bin/env python3
"""
autoplan.py — find the fastest virtue ascension chain for any Egg Inc player.

Runs the whole recipe end to end. No Claude required; this is the recipe.

    python scripts/autoplan.py --player-id EI2345678901234567

WHAT IT DOES, and why each stage exists
---------------------------------------
1. Fetch the backup, read current TE.
2. Coarse subset scan across prestige counts.
3. LADDER CHECK -> fix the prestige count.
   Extra prestiges do NOT raise the delivery-rate ceiling; that ceiling is set by
   the farm (artifacts/soul eggs), not by how many ascensions you take. So compare
   the FINAL LEG'S ELR at N and N+1 prestiges: if identical, N+1 is a wasted
   rebuild. Verified on two accounts, and on late insertions where 10 different
   8th-prestige positions all left the final ELR bit-identical at 10.395 q/hr.
4. Coordinate descent, step 1, one checkpoint at a time.
   After EVERY accepted move, re-solve the LAST checkpoint. Moving any earlier
   checkpoint shifts every later arrival time, which shifts which weekly sale
   boundary the final build lands on. Skipping this cost 2.3 d on one test.
5. Exhaustive step-1 2-D slices over adjacent checkpoint pairs.
   Coordinate descent is NOT exact: on a measured case it ranked 4th of 441 and
   lost 0.371 d to a joint (X2,X3) optimum that no single-axis sweep can see.
6. Report the END DATE. Durations from different plan starts are not comparable;
   the finish instant is the invariant.

THE STRUCTURE IT EXPLOITS
-------------------------
* A leg's build phase ends on a Research Sale END = **Saturday 09:00 Pacific**
  (DST-exact), and an n-sale build rides n of them. Verified 68/68 rows over two
  accounts, 6 and 7 prestiges, PDT and PST.
* Because of that, sweeping the last checkpoint gives descending runs of 3-5
  separated by ~+3.15 d jumps, and **the optimum is always a run-end** (933/933).
  Only ~27% of values can win, which is a safe prune.
* Pruning by prefix COST is NOT safe: a prefix that arrives later can arrive with
  a higher delivery rate and win overall. Do not drop candidates on early-leg time.
"""
import argparse
import csv
import datetime
import itertools
import os
import subprocess
import sys
import re
import time
import tempfile
from zoneinfo import ZoneInfo
from datetime import timezone

PLANNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = "dist-search/fastsearch.js"

# Minimum chains per shard process. See Sim.jobs_for for the measurements behind
# this. Raise it to use fewer, busier processes; --jobs-fixed disables the whole
# heuristic and honours --jobs literally.
CHAINS_PER_SHARD = 4


class Sim:
    """Batches chains into fastsearch `--stages` calls and caches every result."""

    def __init__(self, args):
        self.a = args
        self.total, self.legs = {}, {}
        self.calls = self.sims = 0
        self.src = (["--player-id", args.player_id, "--save-backup", args.backup]
                    if args.player_id else ["--backup", args.backup])

    def _base(self):
        b = self.src + ["--final", str(self.a.final),
                        "--start-date", self.a.start_date,
                        "--start-time", self.a.start_time,
                        "--timezone", self.a.timezone,
                        "--force-continue"]
        if self.a.mod:
            b += ["--mod", self.a.mod]
        if self.a.add_artifact:
            b += ["--add-artifact", self.a.add_artifact]
        if self.a.sleep_from is not None and self.a.sleep_until is not None:
            b += ["--sleep-from", str(self.a.sleep_from),
                  "--sleep-until", str(self.a.sleep_until)]
        if self.a.available_days:
            b += ["--available-days", self.a.available_days]
        for ms in (self.a.milestone or []):
            b += ["--milestone", ms]
        return b

    def run(self, groups):
        """groups: list of value-lists, one per checkpoint before --final."""
        want = [tuple(c) + (self.a.final,) for c in itertools.product(*groups)]
        want = [c for c in want if list(c) == sorted(c) and len(set(c)) == len(c)]
        todo = [c for c in want if c not in self.total]
        if not todo:
            return
        g = [sorted({c[i] for c in todo}) for i in range(len(groups))]
        spec = ";".join(",".join(str(v) for v in x) for x in g)
        self._invoke(["--stages", spec], len(todo))

    def grid(self, values, lo_p, hi_p):
        self._invoke(["--grid", ",".join(map(str, values)),
                      "--prestiges", "%d-%d" % (lo_p, hi_p)], 0)

    def jobs_for(self, n):
        """Size the shard pool to the BATCH, not to the CPU.

        Every shard is a fresh node process loading a 6.2 MB bundle, and those
        loads contend with each other. Measured on a MacBook: stage 2, which is
        ONE 372-chain batch, ran at 1.43 s/chain at --jobs 12 - faster per chain
        than the 20-core Windows box. Stage 4, which is many 13-17 chain batches,
        ran at 19.68 s/chain at the same --jobs 12, and at 5.1 s/chain at
        --jobs 6. Same machine, same work, 3.9x from halving the pool.

        On the 20-core Windows box a fixed 152-chain batch varied only 7.9%
        across --jobs 6/12/17, and the PERFECTLY balanced 17-way split was the
        slowest of the three - so this is not about shard balance. It is startup
        contention, and it bites hardest on small batches and small machines.

        Heuristic, not a fitted law: keep at least CHAINS_PER_SHARD chains per
        process. Two data points support the direction; the constant itself is a
        guess pending calibration. --jobs-fixed restores the old behaviour.
        """
        if self.a.jobs_fixed or n <= 0:
            return self.a.jobs
        return max(1, min(self.a.jobs, -(-n // CHAINS_PER_SHARD)))

    def _invoke(self, extra, n):
        self.calls += 1
        self.sims += n
        jobs = self.jobs_for(n)
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "o.csv")
            cmd = (["node", SCRIPT] + self._base() +
                   ["--jobs", str(jobs), "--top", "0", "--out", out] + extra)
            if self.a.verbose:
                r = subprocess.run(cmd, cwd=PLANNER_DIR)
                tail = ""
            else:
                r = subprocess.run(cmd, cwd=PLANNER_DIR, capture_output=True, text=True)
                tail = chr(10).join(
                    ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-6:])
            if r.returncode != 0 or not os.path.exists(out):
                print("  ! fastsearch failed (exit %s): %s" % (r.returncode, " ".join(extra)),
                      file=sys.stderr)
                if tail:
                    print("    " + tail.replace(chr(10), chr(10) + "    "),
                          file=sys.stderr)
                return
            with open(out, newline="", encoding="utf-8", errors="replace") as fh:
                for row in csv.DictReader(fh):
                    ch = tuple(int(x) for x in row["chain"].replace('"', "").split())
                    legs = []
                    for i in range(1, 9):
                        if not row.get("A%d_days" % i):
                            break
                        legs.append((row.get("A%d_sale" % i), row.get("A%d_te" % i),
                                     float(row["A%d_days" % i]),
                                     float(row.get("A%d_elr" % i) or 0)))
                    self.total[ch] = float(row["days"])
                    self.legs[ch] = legs

    @property
    def chains_done(self):
        return len(self.total)

    def current_te(self):
        """fastsearch prints 'player TE <n> -> <final>' on startup; that is the only
        reliable source - a leg's A1_te is the leg's TARGET, not the player's TE."""
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "o.csv")
            cmd = (["node", SCRIPT] + self._base() +
                   ["--jobs", "1", "--top", "0", "--out", out,
                    "--stages", str(self.a.final - 100)])
            r = subprocess.run(cmd, cwd=PLANNER_DIR, capture_output=True, text=True)
            m = re.search(r"player TE\s+(\d+)", (r.stdout or "") + (r.stderr or ""))
            if not m:
                raise SystemExit("could not read current TE from fastsearch output")
            return int(m.group(1))

    def get(self, chain):
        return self.total.get(tuple(chain))

    def need(self, chain):
        """Evaluate one chain if unknown, then return its duration."""
        ch = tuple(chain)
        if ch not in self.total:
            self.run([[v] for v in ch[:-1]])
        return self.total.get(ch)


T0 = [time.time()]


def stamp(msg):
    """Wall clock + elapsed, printed at every stage boundary."""
    el = time.time() - T0[0]
    print("[%s  +%02d:%02d:%02d] %s"
          % (time.strftime("%H:%M:%S"), el // 3600, (el % 3600) // 60, el % 60, msg))


def dump_state(sim):
    """Print the account inputs a plan depends on, beyond the chain itself."""
    import json
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "o.csv")
        cmd = (["node", SCRIPT] + sim._base() +
               ["--jobs", "1", "--top", "0", "--out", out, "--dump-state",
                "--stages", str(sim.a.final - 90)])
        r = subprocess.run(cmd, cwd=PLANNER_DIR, capture_output=True, text=True)
    # Look in stdout FIRST and decode with raw_decode, which stops at the end of the
    # JSON object and ignores anything after it. The old version concatenated stderr
    # onto stdout and json.loads'd everything past the marker, so any warning on
    # stderr broke it: Node 26 on macOS prints "ExperimentalWarning: localStorage is
    # not available because --localstorage-file was not provided" where Node 24 on
    # Windows prints nothing, and the state dump silently failed on the Mac only.
    MARK = "===DUMP_STATE_JSON==="
    txt = r.stdout or ""
    if MARK not in txt:
        txt = (r.stdout or "") + (r.stderr or "")
    if MARK not in txt:
        print("   (could not read account state)")
        return None
    try:
        d, _ = json.JSONDecoder().raw_decode(txt.split(MARK, 1)[1].lstrip())
    except Exception:
        print("   (account state was not valid JSON)")
        return None
    tiers = d.get("colleggtibleTiers") or {}
    # lib/collegtibles.ts getColleggtibleTiers: "-1 if no tier achieved, 0-3 for tiers
    # 1-4". So index 3 IS the max (10B farm). Testing >=4 reported a fully maxed
    # account as "0/13 at max".
    LABEL = ["<10M", "10M", "100M", "1B", "10B"]
    lab = lambda v: LABEL[v + 1] if -1 <= v <= 3 else "T?%d" % v
    maxed = [k for k, v in tiers.items() if v >= 3]
    part = {k: v for k, v in tiers.items() if v < 3}
    def num(v):
        # protobuf longs arrive as {"low":n,"high":n,"unsigned":true}
        if isinstance(v, dict):
            return v.get("low", 0) + (v.get("high", 0) << 32)
        return v
    se = num(d.get("soulEggs"))
    print("   TE %s | soul eggs %.3g | prophecy eggs %s"
          % (d.get("currentTE"), se if isinstance(se, (int, float)) else 0,
             num(d.get("prophecyEggs"))))
    print("   colleggtibles: %d/%d at max (10B farm)" % (len(maxed), len(tiers)))
    if part:
        print("      not maxed: %s"
              % ", ".join("%s=%s" % (k, lab(v)) for k, v in sorted(part.items())))
    m = d.get("colleggtibleModifiers") or {}
    print("      modifiers: %s"
          % ", ".join("%s=%.4g" % (k, m[k]) for k in sorted(m)))
    arts = d.get("equippedArtifacts") or []
    print("   artifacts (%d equipped): %s"
          % (len(arts), ", ".join("%s[%ds]" % (a["id"], a["stones"]) for a in arts)))
    return d


def final_elr(sim, chain):
    lg = sim.legs.get(tuple(chain))
    return (lg[-1][3] * 3600 / 1e15) if lg else None


# ------------------------------------------------------------------ stages

def coarse(sim, cur_te, lo_p, hi_p, step, budget=1200):
    lo = cur_te + 8
    hi = min(sim.a.final - 100, cur_te + 220)
    # A high-TE account breaks the naive bounds: at cur_te=400 with final=490 this gave
    # lo=408 > hi=390, an EMPTY grid, which then sails past the budget check (0 chains)
    # and hands fastsearch an empty --grid. Clamp, and fail loudly if there is genuinely
    # no room left rather than emitting a nonsense sweep.
    if hi <= lo:
        hi = sim.a.final - 20
    if hi <= lo:
        raise SystemExit("no room for intermediate checkpoints: current TE %d, final %d"
                         % (cur_te, sim.a.final))
    vals = list(range(lo, hi + 1, step))
    while len(vals) < lo_p and step > 1:      # need at least p-1 values to form a chain
        step = max(1, step // 2)
        vals = list(range(lo, hi + 1, step))
    # Subset enumeration blows up fast: C(len(vals), p-1) summed over the prestige
    # range. A 15-value grid over 6-8 prestiges is 14,443 chains (~14 h). Warn loudly
    # and suggest a coarser step rather than silently running overnight.
    from math import comb
    n = sum(comb(len(vals), p - 1) for p in range(lo_p, hi_p + 1) if p - 1 <= len(vals))
    stamp("stage 2: coarse scan")
    print("   grid %d..%d step %d (%d values), prestiges %d-%d"
          % (lo, hi, step, len(vals), lo_p, hi_p))
    print("   -> %d chains" % n)
    # Auto-coarsen rather than dying: the caller asked for a plan, not a lecture.
    while n > budget and step < 60:
        step += 5
        vals = list(range(lo, hi + 1, step))
        n = sum(comb(len(vals), p - 1) for p in range(lo_p, hi_p + 1) if p - 1 <= len(vals))
        print("   too many; coarsening to step %d -> %d values, %d chains"
              % (step, len(vals), n))
    if n > budget:
        raise SystemExit("cannot get stage 2 under %d chains; narrow --prestiges." % budget)
    sim.grid(vals, lo_p, hi_p)
    best = {}
    for ch, d in sim.total.items():
        best.setdefault(len(ch), (1e9, None))
        if d < best[len(ch)][0]:
            best[len(ch)] = (d, ch)
    for k in sorted(best):
        d, ch = best[k]
        print("   %d prestiges: %9.3f  %s  (final ELR %.3f)"
              % (k, d, " ".join(map(str, ch)), final_elr(sim, ch) or 0))
    return best


def ladder_pick(sim, best, tol=0.5):
    """Pick the prestige count. Duration decides; the ladder only breaks near-ties.

    HISTORY - this got it wrong twice, in opposite directions:

    1. Originally pure argmin duration. On the alt that chose 8 prestiges over 7 for a
       0.156 d coarse-grid edge, when both ladders end at 10.395 q/hr - an extra rebuild
       for nothing, and ~2x the leg sims for every later stage.
    2. So it became "fewest count that reaches the ceiling". That is WORSE: on
       EI3456789012345678 all of 5/6/7/8 reach 11.585 q/hr, but 8 is **12.6 days**
       faster than 5 (843.1 vs 855.7). Same ceiling, different time-to-ceiling - more
       prestiges climb the ladder sooner and spend more of the plan at high ELR. The
       rule discarded 12.6 days.

    So: take the fastest. Only prefer a SMALLER count when it is within `tol` days AND
    reaches the same ceiling - that is the genuine "wasted rebuild" case, and there the
    smaller chain is cheaper to search and needs one less prestige in real life.
    """
    elr = {k: (final_elr(sim, ch) or 0) for k, (d, ch) in best.items()}
    fast = min(best, key=lambda k: best[k][0])
    win = fast
    for k in sorted(best):
        if k < fast and best[k][0] <= best[fast][0] + tol and elr[k] >= elr[fast] - 0.01:
            win = k
            break
    stamp("stage 3: ladder check -> %d prestiges" % win)
    print("   duration by count: %s"
          % ", ".join("%d:%.3f" % (k, best[k][0]) for k in sorted(best)))
    print("   final-leg ELR:     %s"
          % ", ".join("%d:%.3f" % (k, elr[k]) for k in sorted(elr)))
    if win != fast:
        print("   (%d is %.3f d faster but within %.1f d and hits the same ceiling, so the "
              "extra rebuild is not worth it)" % (fast, best[win][0] - best[fast][0], tol))
    return best[win][1]


def resolve_last(sim, chain, span=12):
    """Sweep the last checkpoint at step 1; the optimum is always a run-end.

    Two things this must NOT do, both observed failing in a real run:

    1. Re-centre on the edge. The old version returned the edge winner and then
       recursed on it, so the window WALKED upward - 293, 305, ... until it was
       sweeping 450-473. Now the centre stays put and the window only widens
       symmetrically, bounded by `span`.
    2. Search arbitrarily high. There is no reason for the last checkpoint to sit
       near `final`: a tiny final leg means the ladder's rebuild cost is paid for
       almost no earning time. Measured optima are ~330 on the main (envelope
       rising above ~337) and ~289 on the alt (rising above ~296), against
       final=490. `sim.a.max_last` caps it - default final-150.
    3. Centre on an out-of-range value. Nothing that PRODUCES a seed respects
       max_last - the coarse scan sweeps a fixed 185..390 grid and returns
       whatever won on it - so c0 can start above `top`. That made lo > hi, an
       empty range, and a silent `return ch`, which disabled this sweep for the
       whole run including the re-solve after every accepted descent move. With
       final=490 the cap is 340, the coarse scan proposed 360, and
       lo = max(287, 348) = 348 > hi = min(340, 372) = 340. Measured cost on a
       real 9795-chain browser run: settled at 742.378 d with the last
       checkpoint at 359 while 741.500 d sat at 328, inside the window this was
       meant to cover and never priced. Clamping starts the sweep at the edge of
       the legal range, from which the widening rule walks down to it.
    """
    ch = list(chain)
    top = min(sim.a.max_last, sim.a.final - 2)
    floor = ch[-3] + 2
    if top < floor:
        return ch
    c0 = min(max(ch[-2], floor), top)
    best = None
    while True:
        lo, hi = max(floor, c0 - span), min(top, c0 + span)
        sim.run([[v] for v in ch[:-2]] + [list(range(lo, hi + 1))])
        cand = [(sim.get(ch[:-2] + [v, sim.a.final]), v) for v in range(lo, hi + 1)]
        cand = [(d, v) for d, v in cand if d is not None]
        if not cand:
            return ch
        best = min(cand)
        # widen only while the winner is pinned to an edge we can still move
        pinned = (best[1] == lo and lo > floor) or (best[1] == hi and hi < top)
        if not pinned or span >= 36:
            break
        span += 12
    return ch[:-2] + [best[1], sim.a.final]


def descent(sim, chain, radius, passes=6,
            label="stage 4: coordinate descent (re-solving the last checkpoint after each move)"):
    cur = list(chain)
    best = sim.need(cur)
    ever = (best, list(cur))
    stamp(label)
    for p in range(passes):
        moved = False
        for j in range(sim.a.pin, len(cur) - 2):   # last checkpoint via resolve_last
            axis_moved = False
            lo = (cur[j - 1] if j else 0) + 1
            hi = cur[j + 1] - 1
            vals = [v for v in range(cur[j] - radius, cur[j] + radius + 1) if lo <= v <= hi]
            if not vals:
                continue
            sim.run([[x] for x in cur[:j]] + [vals] + [[x] for x in cur[j + 1:-1]])
            for v in vals:
                cand = cur[:j] + [v] + cur[j + 1:]
                d = sim.get(cand)
                if d is not None and d < best - 1e-9:
                    best, cur, moved, axis_moved = d, cand, True, True
            if axis_moved:
                cur = resolve_last(sim, cur)
                best = sim.need(cur)
                if best < ever[0]:
                    ever = (best, list(cur))
        if best < ever[0]:
            ever = (best, list(cur))
        print("   pass %d: %.3f  %s" % (p + 1, best, " ".join(map(str, cur))))
        if not moved:
            break
    if ever[0] < best - 1e-9:
        print("   (a pass regressed; keeping the best seen: %.3f)" % ever[0])
    return ever[1], ever[0]


def slices(sim, chain, radius):
    """Exhaustive step-1 2-D slices over adjacent pairs - catches what descent cannot.

    The loop bound is `len(cur) - 2`, not `len(cur) - 3`. The old bound stopped one
    pair early and so NEVER swept the last adjacent pair: on
    [195, 219, 248, 277, 286, 327, 490] it did (195,219) (219,248) (248,277)
    (277,286) and skipped (286,327). `resolve_last` moves the last checkpoint alone,
    so nothing moved the last two jointly - and `slices3`'s docstring records exactly
    that interaction (X4 x X5 x X6) as worth 1.665 d / 40 h on the alt. It is also
    the CHEAPEST pair to sweep, having the longest shared prefix.
    """
    cur = list(chain)
    best = sim.need(cur)
    stamp("stage 5: exhaustive 2-D slices (coordinate descent is not exact)")
    for j in range(sim.a.pin, len(cur) - 2):
        # When b IS the last checkpoint, cur[j + 2] is `final` and is the wrong
        # bound - resolve_last caps the last checkpoint at max_last for a real
        # reason (a tiny final leg pays the rebuild for almost no earning time).
        hi_b = (min(sim.a.max_last, sim.a.final - 2)
                if j + 2 == len(cur) - 1 else cur[j + 2] - 1)
        a = [v for v in range(cur[j] - radius, cur[j] + radius + 1)
             if (cur[j - 1] if j else 0) < v < cur[j + 1] + radius]
        b = [v for v in range(cur[j + 1] - radius, cur[j + 1] + radius + 1)
             if v <= hi_b]
        if not a or not b:
            continue
        sim.run([[x] for x in cur[:j]] + [a, b] + [[x] for x in cur[j + 2:-1]])
        for va in a:
            for vb in b:
                if va >= vb:
                    continue
                cand = cur[:j] + [va, vb] + cur[j + 2:]
                d = sim.get(cand)
                if d is not None and d < best - 1e-9:
                    best, cur = d, cand
        cur = resolve_last(sim, cur)
        best = sim.need(cur)
        print("   pair %d-%d: %.3f  %s" % (j + 1, j + 2, best, " ".join(map(str, cur))))
    return cur, best


def slices3(sim, chain, radius):
    """Exhaustive step-1 3-D slices over adjacent checkpoint TRIPLES.

    Needed because 2-D is demonstrably not enough. On the alt, an exhaustive
    X4 x X5 x X6 slice (13x13x13) beat the 2-D-polished answer by **1.665 d (40 h)**:
    the winner was X4=229, X5=256, X6=289, and 289 is only good jointly with
    X4=229 - at X4=231 it costs 3.4 d. No single-axis or 2-D sweep at fixed X6 can
    see that.
    """
    cur = list(chain)
    best = sim.need(cur)
    stamp("stage 6: exhaustive 3-D slices (2-D is not sufficient)")
    for j in range(len(cur) - 4, sim.a.pin - 1, -1):        # last triple first; that is where it bit
        rng = []
        for k in range(3):
            lo = (cur[j + k - 1] if j + k else 0) + 1
            hi = cur[j + 3] - 1 if j + 3 < len(cur) else sim.a.final - 1
            rng.append([v for v in range(cur[j + k] - radius, cur[j + k] + radius + 1)
                        if lo < v < hi])
        if not all(rng):
            continue
        sim.run([[x] for x in cur[:j]] + rng + [[x] for x in cur[j + 3:-1]])
        for va in rng[0]:
            for vb in rng[1]:
                for vc in rng[2]:
                    if not (va < vb < vc):
                        continue
                    cand = cur[:j] + [va, vb, vc] + cur[j + 3:]
                    d = sim.get(cand)
                    if d is not None and d < best - 1e-9:
                        best, cur = d, cand
        print("   triple %d-%d-%d: %.3f  %s" % (j + 1, j + 2, j + 3, best,
                                                " ".join(map(str, cur))))
    return cur, best


def count_probe(sim, chain, best, radius, cur_te, lo_p, hi_p):
    """Post-polish prestige-count probe: drop one checkpoint, or add one, then re-polish.

    `ladder_pick` settles the prestige COUNT on the coarse grid (step 25) and nothing
    ever revisits it. Measured on the main account 2026-09-05: coarse ranked 7
    prestiges ahead of 6 by 2.675 d, so the run polished inside 7 and returned
    195 219 248 277 286 327 490 = 742.021 d. Delete the 277 and it is
    195 219 248 286 327 490 = 741.965 d - which a 4913-chain exhaustive later
    confirmed as rank 1 of 4913. A 2.7 d coarse ranking reversed to 0.056 d the other
    way, more than 5x ladder_pick's tol=0.5, and that one spurious checkpoint was the
    ENTIRE measured loss of that blind run.

    Candidates are ordinary chains scored by the same simulator, so there is no new
    modelling assumption here. The one real hazard is accepting a dropped chain raw:
    it inherits a neighbourhood tuned for n+1 checkpoints, so any winner gets
    resolve_last plus a short descent before it is returned.
    """
    stamp("stage 7: prestige-count probe (drop one / add one, then re-polish)")
    cur = list(chain)
    cands = []
    for i in range(sim.a.pin, len(cur) - 1):          # drop checkpoint i
        if len(cur) - 1 >= 2:
            cands.append(cur[:i] + cur[i + 1:])
    prev = cur_te
    for i in range(sim.a.pin, len(cur)):              # insert a midpoint before i
        # i == len(cur) - 1 is the gap between the last checkpoint and `final` - the
        # "is one more prestige up there worth it" question. Its midpoint is far above
        # anything sensible (327..490 -> 408 against a max_last of 340), so cap it.
        m = min((prev + cur[i]) // 2, sim.a.max_last)
        if prev < m < cur[i]:
            cands.append(cur[:i] + [m] + cur[i:])
        prev = cur[i]
    # Respect --prestiges. Without this the insert path hands an 8-prestige ladder pick
    # back as a 9-checkpoint chain, which is outside the range the user asked for and
    # pushes the re-polish (and the run's total wall time) past what was estimated.
    cands = [c for c in cands if lo_p <= len(c) <= hi_p]
    if not cands:
        print("   nothing to probe within --prestiges %d-%d" % (lo_p, hi_p))
        return cur, best

    # sim.run re-crosses per-axis value sets, so every chain in one call must be the
    # same length. Group by length; the product is a superset of the candidates and
    # the extras are legal neighbouring chains that cost little and sometimes win.
    by_len = {}
    for c in cands:
        by_len.setdefault(len(c), []).append(c)
    for L in sorted(by_len):
        grp = by_len[L]
        sim.run([sorted({c[i] for c in grp}) for i in range(L - 1)])

    # Take the best chain seen ANYWHERE this run, not just among the candidates.
    # Every value in sim.total is a full duration to `final`, so they are all
    # comparable, and this doubles as a guard against a stage that regressed.
    win, wd = tuple(cur), best
    for c, d in sim.total.items():
        if d is not None and d < wd - 1e-9 and lo_p <= len(c) <= hi_p:
            win, wd = c, d
    win = list(win)
    if win == cur:
        print("   no change: %d prestiges confirmed at %.3f d" % (len(cur), best))
        return cur, best

    print("   %d -> %d prestiges: %.3f -> %.3f  (%.2f h better)  %s"
          % (len(cur), len(win), best, wd, (best - wd) * 24,
             " ".join(map(str, win))))
    win = resolve_last(sim, win)
    win, wd = descent(sim, win, radius, passes=3,
                      label="stage 7b: re-polishing the new count")
    return win, wd


EFFORT = {
    # The stages are strictly nested (2 -> 3 -> 4 -> 5 -> 7), so a tier is a STOP
    # POINT, not a different algorithm. A user who picks a higher tier and loses
    # patience already holds the lower tier's answer at zero extra cost.
    # name:       (2-D slices, 3-D slices, descent radius, 3-D radius, count probe)
    "quick":     (False, False, 8, 0, False),   # "Fast"     - descent only
    "balanced":  (True,  False, 8, 0, False),   # "Balanced" - + 2-D slices
    "normal":    (True,  False, 8, 0, True),    # "Exact"    - + count probe (default)
    "thorough":  (True,  True,  8, 6, True),    # exceeds the 5 h cap; see EFFORT_NOTE
}

# MEASURED accuracy, stated as hours behind the best answer found, with the sample
# size. Not confidence percentages - n is 2-3 accounts and there is no honest way to
# turn that into a probability. "best answer FOUND" is deliberate: only the main
# account has a proven optimum -- a complete 4913-chain map -- and even
# that proves optimality only inside a box with X1, X2, final and the checkpoint
# count all pinned.
EFFORT_NOTE = {
    "quick":    "Fast - coordinate descent only. ~1h05m on a 20-core desktop; 1h08m "
                "measured on a MacBook at --jobs 6. Five observations, spread "
                "0 h / 5 h / 5 h / 61 h / 150 h behind the best answer found. So it "
                "has always landed inside a WEEK, and usually inside a day, but the "
                "spread is real: two runs on the SAME account 5.5 h apart differed by "
                "6 days, because descent alone is basin-sensitive and nothing after "
                "it re-checks the neighbourhood. Use it to get a good answer in under "
                "an hour, not to get THE answer.",
    "balanced": "Balanced - + exhaustive 2-D slices, ~2h55m. Measured 1.3 h and 0 h "
                "behind on 2 accounts; within a day on both.",
    "normal":   "Exact - + the prestige-count probe, ~3h30m. Matched a 4913-chain "
                "exhaustive of the surrounding box on 1 account (rank 1 of 4913). The "
                "other accounts have no proven answer to check against.",
    "thorough": "+ exhaustive 3-D slices. WARNING: projects to 7-13 h and BREACHES the "
                "5 h budget at every chain length. Stage 6 has never been observed to "
                "improve an answer on any account on disk.",
}

# -------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--player-id")
    ap.add_argument("--backup", default="player.json")
    now = datetime.datetime.now()
    ap.add_argument("--start-date", default=now.strftime("%Y-%m-%d"))
    ap.add_argument("--start-time", default=now.strftime("%H:%M"))
    ap.add_argument("--timezone", default="America/Denver")
    ap.add_argument("--final", type=int, default=490)
    ap.add_argument("--jobs", type=int, default=14)
    ap.add_argument("--radius", type=int, default=None,
                help="descent / 2-D slice radius; overrides the effort preset")
    ap.add_argument("--coarse-step", type=int, default=15)
    ap.add_argument("--prestiges", default="5-8")
    ap.add_argument("--mod", help="colleggtible what-if, e.g. elr=1.05")
    ap.add_argument("--add-artifact",
                    help="artifact what-if: inject artifacts into the VIRTUE inventory "
                         "so the optimiser may pick them, e.g. "
                         "\"metronome:legendary,puzzle-cube:legendary\". Syntax is "
                         "family[:rarity[:tier[:count]]]; see fastsearch.ts. Note the "
                         "virtue inventory is separate from the main game's, so an "
                         "artifact you own in-game may still be missing here.")
    ap.add_argument("--sleep-from", type=int, default=None, metavar="HOUR",
                    help="first hour you are unavailable, 0-23, in --timezone. Use with "
                         "--sleep-until. Every inter-leg PRESTIGE that would land inside the "
                         "window is moved to the end of it and the delay is charged, which "
                         "shifts every downstream sale boundary - so this changes which chain "
                         "wins and cannot be applied to an existing answer afterwards. "
                         "Measured on the main account's proven optimum at 23-7 "
                         "America/Denver: 741.965 d -> 745.789 d on that FIXED chain. "
                         "The twelve shifts inside an ascension are NOT moved (the simulator "
                         "schedules them); the CSV's A*_nightshifts columns count how many "
                         "still land at night. Every accuracy figure in --effort's notes was "
                         "measured with this OFF.")
    ap.add_argument("--sleep-until", type=int, default=None, metavar="HOUR",
                    help="first hour you are available again, 0-23. Wraps, so "
                         "--sleep-from 23 --sleep-until 7 is the normal overnight case.")
    ap.add_argument("--available-days", default=None, metavar="DAYS",
                    help="days you can act, comma separated: \"sat,sun\" or \"mon,wed,fri\". "
                         "Combines with --sleep-from/--sleep-until, and can be used alone to mean "
                         "\"those days, any hour\". Same mechanism: a prestige that would land on "
                         "an unavailable day is pushed to the next available one and charged.")
    ap.add_argument("--milestone", action="append", metavar="TE@YYYY-MM-DD",
                    help="a date you have to hit, e.g. \"248@2027-06-01\". Repeatable. A chain "
                         "that misses one is dropped outright, so this steers the search rather "
                         "than annotating the answer. Stated as a TE value, not an ascension "
                         "number, because the count probe reshapes the chain. Note a milestone on "
                         "--final cannot improve anything: the search already minimises total time, "
                         "so if the optimum misses your date nothing else makes it.")
    ap.add_argument("--seed", help="skip stages 2-3, start descent from this chain")
    ap.add_argument("--pin", type=int, default=0,
                    help="hold the first N checkpoints fixed. Moving X1 re-simulates every "
                         "downstream leg (16.5 s/leg vs 3.1) and it is usually the best "
                         "validated value, so --pin 1 is often the right trade")
    ap.add_argument("--radius3", type=int, default=None,
                    help="override the 3-D slice radius (effort preset otherwise)")
    ap.add_argument("--max-last", type=int, default=None,
                    help="upper bound for the last checkpoint (default final-150); a tiny "
                         "final leg pays a rebuild for almost no earning time")
    ap.add_argument("--effort", choices=sorted(EFFORT), default="normal",
                    help="quick / normal / thorough - see the estimate printed before it runs")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--budget", type=int, default=1200,
                help="max chains for the stage-2 coarse scan before auto-coarsening")
    ap.add_argument("--no-state", action="store_true",
                    help="skip the account summary (colleggtibles / artifacts / TE)")
    ap.add_argument("--jobs-fixed", action="store_true",
                    help="honour --jobs literally instead of sizing the shard pool "
                         "to each batch (see Sim.jobs_for)")
    ap.add_argument("--max-hours", type=float, default=None,
                    help="refuse to start a configuration projected to exceed this many "
                         "hours in total. Off by default: the projection is printed "
                         "either way, and a long run is your call to make.")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    lo_p, hi_p = (int(x) for x in a.prestiges.split("-"))
    if a.max_last is None:
        a.max_last = a.final - 150

    # Fail here, not three hours in. One half of the pair alone is a typo, and
    # fastsearch would silently ignore it and hand back an unconstrained answer
    # that looks like a constrained one.
    if (a.sleep_from is None) != (a.sleep_until is None):
        ap.error("--sleep-from and --sleep-until must be given together")
    if a.sleep_from is not None:
        for name, h in (("--sleep-from", a.sleep_from), ("--sleep-until", a.sleep_until)):
            if not 0 <= h <= 23:
                ap.error("%s must be a whole hour 0-23 (got %r)" % (name, h))
        if a.sleep_from == a.sleep_until:
            ap.error("--sleep-from and --sleep-until must differ; equal hours exclude nothing")
        print("   asleep %02d:00-%02d:00 %s  (prestiges pushed out and charged; "
              "shifts reported only)" % (a.sleep_from, a.sleep_until, a.timezone))
    if a.available_days:
        print("   available days: %s" % a.available_days)

    t0 = time.time()
    sim = Sim(a)
    T0[0] = t0
    stamp("stage 1: fetching backup / probing current TE")
    cur_te = sim.current_te()
    print("   current TE: %d  -> target %d" % (cur_te, a.final))
    # current_te() already fetched AND saved the backup. Keep using the local file
    # from here: passing --player-id on every invocation would re-hit the API
    # hundreds of times over a full run and risk rate limiting.
    if a.player_id:
        sim.src = ["--backup", a.backup]
        print("   backup saved to %s; using it locally from here" % a.backup)
    if not a.no_state:
        dump_state(sim)

    if a.seed:
        chain = [int(x) for x in a.seed.split()]
        if chain[-1] != a.final:
            chain.append(a.final)
        t_stage2 = 0.0
    else:
        t2 = time.time()
        best = coarse(sim, cur_te, lo_p, hi_p, a.coarse_step, a.budget)
        t_stage2 = time.time() - t2
        chain = list(ladder_pick(sim, best))

    do2, do3, rad, rad3, do_probe = EFFORT[a.effort]
    # Explicit flags win over the effort preset - otherwise --radius is a silent no-op
    # (it was, and the smoke test ran radius 8 while asking for 2).
    if a.radius is not None:
        rad = a.radius
    if a.radius3 is not None:
        rad3, do3 = a.radius3, a.radius3 > 0
    n = len(chain) - 1

    # --- estimate before committing, using this account's own measured rate
    #
    # Two corrections, both measured on blind_main_v2.log:
    #  1. Stage 2's rate UNDERSTATES stages 4+. Stage 2 runs giant Cartesian batches
    #     that share prefixes well (2.41 s/chain); stages 4-7 run many small sweeps
    #     (4.79 s/chain). Ratio 1.99. Uncorrected, this printed "~76 min" for work
    #     that took 191 - a 2.5x understatement in the direction that breaks a budget.
    #  2. The probe term was 2**(n-1) = 32 chains where reality was 383: count_probe
    #     re-crosses its candidates per length, so the insertion group alone is a
    #     product, not a sum.
    SMALL_BATCH_PENALTY = 2.0
    rate = (t_stage2 / sim.chains_done) if (t_stage2 > 0 and sim.chains_done) else 0.0
    measured = rate > 0
    rate = rate * SMALL_BATCH_PENALTY if measured else 4.8
    # descent, a few passes, PLUS the resolve_last sweep (span 12 -> ~25 chains) that
    # runs after every accepted axis move. Omitting that term put stage 4 at 306 chains
    # where blind_main_v2 actually spent ~569 (45.4 min at 4.79 s/chain).
    est = (2 * rad + 1) * n * 3 + 25 * n * 2
    if do2:
        est += (2 * rad + 1) ** 2 * max(n - 1, 1)    # n-1 pairs since the last is swept
    if do3:
        # n-2 triples: slices3 sweeps j from len-4 down to pin, i.e. len-3 = n-2 of them.
        # max(n-3,1) under-counted by a whole 13**3 sweep at every chain length.
        est += (2 * rad3 + 1) ** 3 * max(n - 2, 1)
    if do_probe:
        est += n + 1                      # drop-one candidates: one per checkpoint
        # The insert-one group is re-crossed into a PRODUCT, which is the expensive
        # part of stage 7. But count_probe clamps its candidates to --prestiges, so
        # when the chain is ALREADY at hi_p every insertion is one prestige too long
        # and is thrown away before a single chain is simulated. Counting it anyway
        # overstated the alt (8 prestiges, hi_p 8) by 364 chains and made --max-hours
        # refuse a configuration that fits.
        if n + 2 <= hi_p:
            est += 3 ** max(n - 1, 1) // 2
        est += (2 * rad + 1) * n          # re-polish descent on a winner

    lo_min, hi_min = est * rate / 60 * 0.75, est * rate / 60 * 1.35
    print("")
    print("stage 4+: effort=%s  (%s)" % (a.effort, EFFORT_NOTE[a.effort]))
    print("   ~%d more chains at %.1f s/chain (%s) -> %.0f-%.0f min"
          % (est, rate, "measured here" if measured else "assumed; no stage-2 timing",
             lo_min, hi_min))

    # Time budget: ADVISORY by default. It began as a hard 5 h cap, but a cap that
    # refuses a run the user would happily have left overnight is worse than a clear
    # warning - and it refused two legitimate alt runs on a bad estimate. So the
    # projection is always printed prominently, --max-hours is off unless asked for,
    # and anything long enough to matter says so in words the user can act on.
    total_h = (time.time() - t0) / 3600 + hi_min / 60
    if total_h >= 5:
        print("   NOTE: this is a LONG run - up to about %.0f hours in total. Leave it "
              "running, or" % total_h)
        print("         pick a cheaper --effort (quick ~1h05m, balanced ~2h55m, "
              "normal ~3h30m).")
    if a.max_hours is not None and total_h > a.max_hours:
        print("   projected total %.1f h exceeds --max-hours %.1f" % (total_h, a.max_hours))
        raise SystemExit(
            "stopped: this configuration does not fit the time budget you set. Use a "
            "cheaper --effort, or raise/drop --max-hours.")

    if not a.yes and sys.stdin.isatty():
        if input("   proceed? [y/N] ").strip().lower() not in ("y", "yes"):
            raise SystemExit("stopped at the user's request")

    chain = resolve_last(sim, chain)
    chain, d = descent(sim, chain, rad)
    if do2:
        chain, d = slices(sim, chain, rad)
    if do3:
        chain, d = slices3(sim, chain, rad3)
    if do_probe:
        chain, d = count_probe(sim, chain, d, rad, cur_te, lo_p, hi_p)

    st = datetime.datetime.strptime(a.start_date + " " + a.start_time, "%Y-%m-%d %H:%M")
    st = st.replace(tzinfo=ZoneInfo(a.timezone))
    fin = (st.astimezone(timezone.utc) + datetime.timedelta(days=d)).astimezone(ZoneInfo(a.timezone))
    print("\n=== BEST CHAIN " + " ".join(map(str, chain)) + " ===")
    print("    %.3f days   ENDS %s" % (d, fin.strftime("%a %Y-%m-%d %H:%M %Z")))
    print("    final-leg ELR %.3f q/hr" % (final_elr(sim, chain) or 0))
    lg = sim.legs.get(tuple(chain)) or []
    t = 0.0
    print("\n    leg  ->TE   strategy           days   ends")
    for i, (sale, te, dur, _) in enumerate(lg):
        t += dur
        e = (st.astimezone(timezone.utc) + datetime.timedelta(days=t)).astimezone(ZoneInfo(a.timezone))
        print("     A%d  %5s  %-17s %6.2f  %s" % (i + 1, te, sale, dur, e.strftime("%a %Y-%m-%d %H:%M")))
    el = time.time() - t0
    print("\n    fastsearch invocations %d, chains simulated %d" % (sim.calls, len(sim.total)))
    print("    wall time %dh %02dm %02ds  (%.1f s per chain)"
          % (el // 3600, (el % 3600) // 60, el % 60, el / max(len(sim.total), 1)))
    print("    NOTE: this is a strong local optimum, not a proven global one.")


if __name__ == "__main__":
    main()
