/**
 * The search itself — a port of the staged recipe in scripts/autoplan.py.
 *
 * READ THIS BEFORE CHANGING ANY OF IT. Every stage here exists because a simpler version of it was
 * measured losing time, and the comments record which:
 *
 *  - `resolveLast` re-solves the LAST checkpoint. It must not re-centre on the window edge: an
 *    earlier version returned the edge winner and recursed on it, so the window WALKED upward until
 *    it was sweeping 450-473 against a final of 490. The centre stays put; the window only widens,
 *    symmetrically, capped, and bounded above by `maxLast` (default final-150, because a tiny final
 *    leg pays a full rebuild for almost no earning time).
 *
 *  - `descent` re-solves the last checkpoint after EVERY accepted move. Moving any earlier
 *    checkpoint shifts every later arrival time, which shifts which weekly sale boundary the final
 *    build lands on. Skipping this cost 2.3 days on one measured test.
 *
 *  - `slices` exists because coordinate descent is not exact: on a measured case it ranked 4th of
 *    441 and lost 0.371 d to a joint (X2,X3) optimum no single-axis sweep can see. Its loop bound is
 *    `len - 2`, not `len - 3` — the older bound never swept the LAST adjacent pair, which is both
 *    the cheapest pair (longest shared prefix) and a pair `resolveLast` alone cannot move jointly.
 *
 *  - `countProbe` exists because the checkpoint COUNT is otherwise settled on a coarse grid and
 *    never revisited. Measured: a coarse scan ranked 7 checkpoints ahead of 6 by 2.675 d, and
 *    deleting one checkpoint from the polished 7-chain gave 195 219 248 286 327 490 — later
 *    confirmed rank 1 of a 4913-chain exhaustive. That one spurious checkpoint was the entire
 *    measured loss of that run.
 *
 * And one thing this file deliberately does NOT do: prune by prefix cost. A prefix that arrives
 * later can arrive with a higher delivery rate and win overall. Dropping candidates on early-leg
 * time is not safe.
 *
 * Everything is driven through `evaluateBatch`, so the driver knows nothing about workers. That is
 * what lets the same code be unit-tested against an inline evaluator.
 */
import { EFFORT, estimateChains } from './effort';
import type { ChainKey, ChainResult, EffortTier, LegSummary, SearchProgress } from './types';

/** Duration comparisons are in seconds; this is autoplan.py's `1e-9` days in the same units,
 *  rounded up. Far below any real difference between two chains (the smallest meaningful gap is
 *  minutes) and far above float noise. */
const EPS_SECONDS = 1e-4;

export interface EvaluateBatch {
  (chains: number[][]): Promise<{ results: ChainResult[]; legSims: number; workersUsed: number }>;
}

export interface DriverOptions {
  /** Where the search starts. Normally the user's own chain, or a seed from a previous run. */
  seedChain: number[];
  final: number;
  currentTE: number;
  effort: EffortTier;
  /** Upper bound for the last checkpoint. Defaults to `final - 150`. */
  maxLast?: number;
  /** Hold the first N checkpoints fixed. Moving X1 re-simulates every downstream leg, and X1 is
   *  usually the best-validated value, so pinning it is often the right trade. */
  pin?: number;
  /** Allowed checkpoint counts (chain length, final included), from the count probe's point of
   *  view. Defaults to "one either side of the seed". */
  minCheckpoints?: number;
  maxCheckpoints?: number;
  evaluateBatch: EvaluateBatch;
  /** Called after every batch and at every stage boundary. */
  onProgress?: (progress: SearchProgress) => void;
  /** Called after every batch with the full cache, for checkpointing to IndexedDB. */
  onCache?: (entries: CacheEntry[]) => void;
  /** Checked between batches. Returning true ends the run cleanly and returns the best so far —
   *  which, because the stages are nested, is always a usable answer. */
  shouldStop?: () => boolean;
  /** Cache entries restored from a previous run, so a refresh replays instead of re-simulating. */
  restoredCache?: CacheEntry[];
}

export interface CacheEntry {
  key: ChainKey;
  seconds: number;
  legs: LegSummary[];
}

export interface SearchOutcome {
  chain: number[];
  seconds: number;
  legs: LegSummary[];
  /** True when `shouldStop` ended the run before the tier's last stage finished. The answer is
   *  still the best found, and still whatever the completed stages guarantee. */
  stoppedEarly: boolean;
  /** The last stage that actually ran to completion — what the answer is backed by. */
  lastCompletedStage: string;
  chainsEvaluated: number;
  legSims: number;
}

/**
 * The chain cache, and the batching layer between the driver and the workers.
 *
 * Mirrors autoplan.py's `Sim` class: `run(groups)` takes one value-list per checkpoint, forms the
 * Cartesian product, drops anything that is not strictly increasing, and evaluates only what is not
 * already known. Every stage below builds its sweep as one `run` call so the whole sweep goes to the
 * pool as a single batch — which is what lets the batch be split on prefix subtrees and keeps prefix
 * sharing intact (see search/batch.ts).
 */
class ChainCache {
  private readonly seconds = new Map<ChainKey, number>();
  private readonly legs = new Map<ChainKey, LegSummary[]>();
  chainsEvaluated = 0;
  legSims = 0;
  /** Wall seconds spent inside `evaluateBatch`, for the live time estimate. */
  wallSeconds = 0;
  lastWorkersUsed = 0;

  constructor(
    private readonly final: number,
    private readonly currentTE: number,
    private readonly evaluateBatch: EvaluateBatch
  ) {}

  restore(entries: CacheEntry[]): void {
    for (const e of entries) {
      this.seconds.set(e.key, e.seconds);
      this.legs.set(e.key, e.legs);
    }
  }

  entries(): CacheEntry[] {
    return [...this.seconds.entries()].map(([key, s]) => ({ key, seconds: s, legs: this.legs.get(key) ?? [] }));
  }

  get(chain: number[]): number | undefined {
    return this.seconds.get(chain.join(','));
  }

  legsOf(chain: number[]): LegSummary[] {
    return this.legs.get(chain.join(',')) ?? [];
  }

  /** `groups`: one value-list per checkpoint BEFORE the final target. */
  async run(groups: number[][]): Promise<void> {
    const want: number[][] = [];
    const walk = (i: number, acc: number[]): void => {
      if (i === groups.length) {
        want.push([...acc, this.final]);
        return;
      }
      for (const v of groups[i]) {
        // Strictly increasing, and above the player's current TE — the same filter fastsearch.ts
        // applies before it evaluates anything. A checkpoint at or below the current TE is not a
        // checkpoint, it is already behind you.
        if (acc.length ? v > acc[acc.length - 1] : v > this.currentTE) walk(i + 1, [...acc, v]);
      }
    };
    walk(0, []);

    const todo = want.filter(c => !this.seconds.has(c.join(',')));
    if (!todo.length) return;

    const t0 = Date.now();
    const { results, legSims, workersUsed } = await this.evaluateBatch(todo);
    this.wallSeconds += (Date.now() - t0) / 1000;
    this.legSims += legSims;
    this.lastWorkersUsed = workersUsed;
    this.chainsEvaluated += todo.length;

    for (const r of results) {
      const key = r.chain.join(',');
      this.seconds.set(key, r.seconds);
      this.legs.set(key, r.legs);
    }
    // Chains that failed to simulate are deliberately NOT cached as "known bad": re-asking for one
    // is cheap relative to getting the bookkeeping wrong, and a failure is a property of the
    // simulator's state, not of the chain. This matches autoplan.py, where a missing CSV row simply
    // stays missing.
  }

  /** Evaluate one chain if unknown, then return its duration in seconds. */
  async need(chain: number[]): Promise<number | undefined> {
    if (!this.seconds.has(chain.join(','))) {
      await this.run(chain.slice(0, -1).map(v => [v]));
    }
    return this.get(chain);
  }

  /** Best chain seen ANYWHERE this run within a checkpoint-count range. Every stored value is a
   *  full duration to the same `final` from the same plan start, so they are all comparable — which
   *  doubles as a guard against a stage that regressed. */
  bestSeen(minLen: number, maxLen: number): { chain: number[]; seconds: number } | null {
    let best: { chain: number[]; seconds: number } | null = null;
    for (const [key, s] of this.seconds) {
      const chain = key.split(',').map(Number);
      if (chain.length < minLen || chain.length > maxLen) continue;
      if (!best || s < best.seconds - EPS_SECONDS) best = { chain, seconds: s };
    }
    return best;
  }
}

export async function runChainSearch(opts: DriverOptions): Promise<SearchOutcome> {
  const cfg = EFFORT[opts.effort];
  const final = opts.final;
  const maxLast = opts.maxLast ?? final - 150;
  const pin = opts.pin ?? 0;
  const cache = new ChainCache(final, opts.currentTE, opts.evaluateBatch);
  if (opts.restoredCache?.length) cache.restore(opts.restoredCache);

  let cur = [...opts.seedChain];
  if (cur[cur.length - 1] !== final) cur = [...cur, final];

  const minLen = opts.minCheckpoints ?? Math.max(2, cur.length - 1);
  const maxLen = opts.maxCheckpoints ?? cur.length + 1;
  const chainsEstimated = estimateChains(cur.length - 1, cfg);

  let stage = 'starting';
  let lastCompletedStage = 'none';
  let stopped = false;
  let best = (await cache.need(cur)) ?? Infinity;
  /** Best seen anywhere, which is what the UI shows and what a stop returns. A stage can regress;
   *  this cannot. */
  let ever = { chain: [...cur], seconds: best };

  function report(detail: string): void {
    opts.onProgress?.({
      stage,
      detail,
      chainsDone: cache.chainsEvaluated,
      chainsEstimated,
      bestChain: [...ever.chain],
      bestDays: ever.seconds / 86400,
      bestLegs: cache.legsOf(ever.chain),
    });
    opts.onCache?.(cache.entries());
  }

  function note(chain: number[], seconds: number | undefined): void {
    if (seconds === undefined) return;
    if (seconds < ever.seconds - EPS_SECONDS) ever = { chain: [...chain], seconds };
  }

  function stopRequested(): boolean {
    if (opts.shouldStop?.()) {
      stopped = true;
      return true;
    }
    return false;
  }

  const days = (s: number) => (s / 86400).toFixed(3);

  /**
   * Sweep the last checkpoint at step 1.
   *
   * The optimum is always a run-end: a leg's build phase ends on a Research Sale END (Saturday 09:00
   * Pacific, DST-exact), so sweeping the last checkpoint gives descending runs of 3-5 separated by
   * ~+3.15 d jumps. Verified 933/933 on the corpus. This still sweeps every value in the window
   * rather than only run-ends — the prune is safe but the saving is small next to the risk of
   * mis-detecting a run boundary from a sparse window.
   */
  async function resolveLast(chain: number[]): Promise<number[]> {
    const ch = [...chain];
    if (ch.length < 2) return ch;
    const centre = ch[ch.length - 2];
    // autoplan.py indexes `ch[-3]` here and so requires at least three entries. The floor it wants
    // is "whatever the previous checkpoint is"; for a two-entry chain there is no previous
    // checkpoint and the player's current TE is the real floor.
    const floor = ch.length >= 3 ? ch[ch.length - 3] + 2 : opts.currentTE + 1;
    const top = Math.min(maxLast, final - 2);
    let span = 12;

    for (;;) {
      const lo = Math.max(floor, centre - span);
      const hi = Math.min(top, centre + span);
      if (hi < lo) return ch;

      const window: number[] = [];
      for (let v = lo; v <= hi; v++) window.push(v);
      await cache.run([...ch.slice(0, -2).map(v => [v]), window]);
      if (stopRequested()) return ch;

      let bestSeconds = Infinity;
      let bestValue = -1;
      for (const v of window) {
        const cand = [...ch.slice(0, -2), v, final];
        const d = cache.get(cand);
        if (d === undefined) continue;
        note(cand, d);
        if (d < bestSeconds) {
          bestSeconds = d;
          bestValue = v;
        }
      }
      if (bestValue < 0) return ch;

      // Widen ONLY while the winner is pinned to an edge we can still move. The centre never moves,
      // which is the whole fix for the runaway window described at the top of this file.
      const pinned = (bestValue === lo && lo > floor) || (bestValue === hi && hi < top);
      if (!pinned || span >= 36) return [...ch.slice(0, -2), bestValue, final];
      span += 12;
    }
  }

  /** Stage 4: coordinate descent, step 1, one checkpoint at a time. */
  async function descent(passes: number, label: string): Promise<void> {
    stage = label;
    for (let p = 0; p < passes; p++) {
      let moved = false;
      // The LAST checkpoint is excluded here on purpose — `resolveLast` owns it.
      for (let j = pin; j < cur.length - 2; j++) {
        let axisMoved = false;
        const lo = (j ? cur[j - 1] : 0) + 1;
        const hi = cur[j + 1] - 1;
        const vals: number[] = [];
        for (let v = cur[j] - cfg.radius; v <= cur[j] + cfg.radius; v++) if (v >= lo && v <= hi) vals.push(v);
        if (!vals.length) continue;

        await cache.run([...cur.slice(0, j).map(v => [v]), vals, ...cur.slice(j + 1, -1).map(v => [v])]);
        if (stopRequested()) return;

        for (const v of vals) {
          const cand = [...cur.slice(0, j), v, ...cur.slice(j + 1)];
          const d = cache.get(cand);
          if (d === undefined) continue;
          note(cand, d);
          if (d < best - EPS_SECONDS) {
            best = d;
            cur = cand;
            moved = true;
            axisMoved = true;
          }
        }

        if (axisMoved) {
          cur = await resolveLast(cur);
          if (stopRequested()) return;
          best = (await cache.need(cur)) ?? best;
          note(cur, best);
        }
        report(`pass ${p + 1}, checkpoint ${j + 1}: ${days(best)} d  ${cur.join(' ')}`);
      }
      report(`pass ${p + 1}: ${days(best)} d  ${cur.join(' ')}`);
      if (!moved) break;
    }
  }

  /** Stage 5: exhaustive step-1 2-D slices over adjacent checkpoint pairs. */
  async function slices(): Promise<void> {
    stage = 'stage 5: exhaustive 2-D slices';
    for (let j = pin; j < cur.length - 2; j++) {
      // When b IS the last checkpoint, `cur[j+2]` is `final` and is the wrong bound — `resolveLast`
      // caps the last checkpoint at `maxLast` for a real reason.
      const hiB = j + 2 === cur.length - 1 ? Math.min(maxLast, final - 2) : cur[j + 2] - 1;
      const a: number[] = [];
      for (let v = cur[j] - cfg.radius; v <= cur[j] + cfg.radius; v++) {
        if (v > (j ? cur[j - 1] : 0) && v < cur[j + 1] + cfg.radius) a.push(v);
      }
      const b: number[] = [];
      for (let v = cur[j + 1] - cfg.radius; v <= cur[j + 1] + cfg.radius; v++) if (v <= hiB) b.push(v);
      if (!a.length || !b.length) continue;

      await cache.run([...cur.slice(0, j).map(v => [v]), a, b, ...cur.slice(j + 2, -1).map(v => [v])]);
      if (stopRequested()) return;

      for (const va of a) {
        for (const vb of b) {
          if (va >= vb) continue;
          const cand = [...cur.slice(0, j), va, vb, ...cur.slice(j + 2)];
          const d = cache.get(cand);
          if (d === undefined) continue;
          note(cand, d);
          if (d < best - EPS_SECONDS) {
            best = d;
            cur = cand;
          }
        }
      }

      cur = await resolveLast(cur);
      if (stopRequested()) return;
      best = (await cache.need(cur)) ?? best;
      note(cur, best);
      report(`pair ${j + 1}-${j + 2}: ${days(best)} d  ${cur.join(' ')}`);
    }
  }

  /** Stage 6: exhaustive 3-D slices over adjacent triples. Last triple first — that is where it bit
   *  on the one account where it ever moved anything (1.665 d / 40 h). */
  async function slices3(): Promise<void> {
    stage = 'stage 6: exhaustive 3-D slices';
    for (let j = cur.length - 4; j >= pin; j--) {
      const rng: number[][] = [];
      for (let k = 0; k < 3; k++) {
        const lo = (j + k ? cur[j + k - 1] : 0) + 1;
        const hi = j + 3 < cur.length ? cur[j + 3] - 1 : final - 1;
        const vals: number[] = [];
        for (let v = cur[j + k] - cfg.radius3; v <= cur[j + k] + cfg.radius3; v++) if (v > lo && v < hi) vals.push(v);
        rng.push(vals);
      }
      if (rng.some(r => !r.length)) continue;

      await cache.run([...cur.slice(0, j).map(v => [v]), ...rng, ...cur.slice(j + 3, -1).map(v => [v])]);
      if (stopRequested()) return;

      for (const va of rng[0]) {
        for (const vb of rng[1]) {
          for (const vc of rng[2]) {
            if (!(va < vb && vb < vc)) continue;
            const cand = [...cur.slice(0, j), va, vb, vc, ...cur.slice(j + 3)];
            const d = cache.get(cand);
            if (d === undefined) continue;
            note(cand, d);
            if (d < best - EPS_SECONDS) {
              best = d;
              cur = cand;
            }
          }
        }
      }
      report(`triple ${j + 1}-${j + 2}-${j + 3}: ${days(best)} d  ${cur.join(' ')}`);
    }
  }

  /** Stage 7: prestige-count probe — drop one checkpoint, or insert one, then re-polish. */
  async function countProbe(): Promise<void> {
    stage = 'stage 7: prestige-count probe';
    const cands: number[][] = [];

    for (let i = pin; i < cur.length - 1; i++) {
      if (cur.length - 1 >= 2) cands.push([...cur.slice(0, i), ...cur.slice(i + 1)]);
    }
    let prev = opts.currentTE;
    for (let i = pin; i < cur.length; i++) {
      // `i === cur.length - 1` is the gap between the last checkpoint and `final` — the "is one more
      // prestige up there worth it" question. Its midpoint is far above anything sensible
      // (327..490 -> 408 against a maxLast of 340), so it is capped.
      const m = Math.min(Math.floor((prev + cur[i]) / 2), maxLast);
      if (prev < m && m < cur[i]) cands.push([...cur.slice(0, i), m, ...cur.slice(i)]);
      prev = cur[i];
    }

    const allowed = cands.filter(c => c.length >= minLen && c.length <= maxLen);
    if (!allowed.length) {
      report(`nothing to probe within ${minLen}-${maxLen} checkpoints`);
      return;
    }

    // `cache.run` re-crosses per-axis value sets, so every chain in one call must be the same
    // length. Group by length; the product is a superset of the candidates, and the extras are legal
    // neighbouring chains that cost little and sometimes win.
    const byLen = new Map<number, number[][]>();
    for (const c of allowed) {
      const g = byLen.get(c.length);
      if (g) g.push(c);
      else byLen.set(c.length, [c]);
    }
    for (const [len, grp] of [...byLen.entries()].sort((x, y) => x[0] - y[0])) {
      const groups: number[][] = [];
      for (let i = 0; i < len - 1; i++) groups.push([...new Set(grp.map(c => c[i]))].sort((p, q) => p - q));
      await cache.run(groups);
      if (stopRequested()) return;
      report(`probed ${len}-checkpoint candidates`);
    }

    const win = cache.bestSeen(minLen, maxLen);
    if (!win || win.chain.join(',') === cur.join(',')) {
      report(`no change: ${cur.length} checkpoints confirmed at ${days(best)} d`);
      return;
    }

    cur = win.chain;
    best = win.seconds;
    note(cur, best);
    report(`${days(best)} d  ${cur.join(' ')}`);

    // A dropped/inserted chain inherits a neighbourhood tuned for a different checkpoint count, so
    // it is never accepted raw.
    cur = await resolveLast(cur);
    if (stopRequested()) return;
    best = (await cache.need(cur)) ?? best;
    note(cur, best);
    await descent(3, 'stage 7b: re-polishing the new count');
  }

  // ------------------------------------------------------------------ the run
  stage = 'stage 4a: solving the last checkpoint';
  report('sweeping the last checkpoint');
  cur = await resolveLast(cur);
  if (!stopped) {
    best = (await cache.need(cur)) ?? best;
    note(cur, best);
    lastCompletedStage = 'last-checkpoint sweep';
  }

  if (!stopped) {
    await descent(6, 'stage 4: coordinate descent');
    if (!stopped) lastCompletedStage = 'coordinate descent';
  }
  if (!stopped && cfg.slices2) {
    await slices();
    if (!stopped) lastCompletedStage = '2-D slices';
  }
  if (!stopped && cfg.slices3) {
    await slices3();
    if (!stopped) lastCompletedStage = '3-D slices';
  }
  if (!stopped && cfg.countProbe) {
    await countProbe();
    if (!stopped) lastCompletedStage = 'prestige-count probe';
  }

  stage = stopped ? 'stopped' : 'done';
  report(`${days(ever.seconds)} d  ${ever.chain.join(' ')}`);

  return {
    chain: ever.chain,
    seconds: ever.seconds,
    legs: cache.legsOf(ever.chain),
    stoppedEarly: stopped,
    lastCompletedStage,
    chainsEvaluated: cache.chainsEvaluated,
    legSims: cache.legSims,
  };
}
