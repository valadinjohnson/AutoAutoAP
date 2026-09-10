/**
 * Stages 2 and 3: find a starting chain from nothing, and fix the prestige count.
 *
 * A line-faithful port of `coarse()` and `ladder_pick()` from scripts/autoplan.py. Without
 * these the browser search could only improve a chain the user typed, and a bad starting
 * chain strands the search in a bad neighbourhood — the panel said so, and this closes it.
 *
 * Cost is real: the coarse scan is one big batch (372 chains on both measured accounts,
 * ~15 min on a 20-core desktop) and it buys only a rough shape. After it, the incumbent
 * was 12.0 days off on the main and 8.6 days off on the alt — it is a starting point, not
 * an answer. It is also the single stage that parallelises well, because it is one wide
 * batch rather than the 13-17 chain sweeps every later stage runs.
 */
import type { EvaluateBatch } from './driver';
import type { ChainResult, LegSummary } from './types';

export interface CoarseCandidate {
  chain: number[];
  seconds: number;
  /** Peak eggs/second on the final leg — the "ceiling" the ladder rule compares. */
  finalELR: number;
  legs: LegSummary[];
}

export interface CoarseOptions {
  currentTE: number;
  final: number;
  /** Chain lengths to consider, counted as prestiges (= chain length including `final`). */
  minPrestiges: number;
  maxPrestiges: number;
  /** Starting grid step. Auto-coarsened upward until the enumeration fits `budget`. */
  step?: number;
  budget?: number;
  evaluateBatch: EvaluateBatch;
  onProgress?: (done: number, total: number, detail: string) => void;
  shouldStop?: () => boolean;
  /** Every chain this stage priced, as it prices it. The scan keeps only the best chain per
   *  prestige count for its own purposes, and these results never reach the driver's cache — so
   *  without this hook the several hundred chains stage 2 evaluates are absent from any export of
   *  "what the run tried". */
  onResults?: (results: ChainResult[]) => void;
}

export interface CoarseResult {
  /** The ladder-picked chain, ready to hand to runChainSearch as its seed. */
  seed: number[];
  /** Best chain at each prestige count, ascending by count. */
  byCount: CoarseCandidate[];
  pickedPrestiges: number;
  grid: { lo: number; hi: number; step: number; values: number[] };
  chainsEvaluated: number;
  /** Lines the panel can show verbatim, mirroring what the CLI prints. */
  log: string[];
}

/** How many chains a grid of `n` values yields over a prestige range. */
function enumerationSize(n: number, lo: number, hi: number): number {
  let total = 0;
  for (let p = lo; p <= hi; p++) {
    const k = p - 1;
    if (k > n || k < 0) continue;
    let c = 1;
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
    total += Math.round(c);
  }
  return total;
}

/** Every strictly-increasing subset of `pool` of size lo-1..hi-1, with `final` appended. */
function subsets(pool: number[], lo: number, hi: number, final: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, acc: number[]): void => {
    if (acc.length >= lo - 1 && acc.length <= hi - 1) out.push([...acc, final]);
    if (acc.length >= hi - 1) return;
    for (let j = start; j < pool.length; j++) walk(j + 1, [...acc, pool[j]]);
  };
  walk(0, []);
  return out;
}

export interface CoarseGrid {
  lo: number;
  hi: number;
  step: number;
  values: number[];
  /** Chains the enumeration will produce. */
  chains: number;
  log: string[];
}

/**
 * Work out the grid WITHOUT evaluating anything.
 *
 * Split out from findStartingChain so the panel can price the coarse scan before the user
 * commits to it. Without this the estimate was derived from the chain typed into Target TE
 * and ignored the scan entirely: with a two-element chain typed in, it read "~101 chains"
 * for a run that was about to price 372 in the coarse stage alone.
 */
export function planCoarseGrid(opts: {
  currentTE: number;
  final: number;
  minPrestiges: number;
  maxPrestiges: number;
  step?: number;
  budget?: number;
}): CoarseGrid {
  const { currentTE, final, minPrestiges, maxPrestiges } = opts;
  const budget = opts.budget ?? 1200;
  let step = opts.step ?? 15;
  const log: string[] = [];

  let lo = currentTE + 8;
  let hi = Math.min(final - 100, currentTE + 220);
  // A high-TE account breaks the naive bounds: at currentTE 400 with final 490 this gives
  // lo 408 > hi 390, an EMPTY grid, which then sails past the budget check with 0 chains.
  // Clamp, and fail loudly if there is genuinely no room rather than sweeping nothing.
  if (hi <= lo) hi = final - 20;
  if (hi <= lo) {
    throw new Error(
      `No room for intermediate checkpoints: current TE ${currentTE}, final ${final}. ` +
        `Pick a higher final target, or search from a chain you supply.`
    );
  }

  const values = (): number[] => {
    const v: number[] = [];
    for (let x = lo; x <= hi; x += step) v.push(x);
    return v;
  };
  let vals = values();
  // Need at least p-1 values to form a chain at all.
  while (vals.length < minPrestiges && step > 1) {
    step = Math.max(1, Math.floor(step / 2));
    vals = values();
  }

  let n = enumerationSize(vals.length, minPrestiges, maxPrestiges);
  log.push(`grid ${lo}..${hi} step ${step} (${vals.length} values), prestiges ${minPrestiges}-${maxPrestiges}`);
  log.push(`-> ${n} chains`);
  // Auto-coarsen rather than dying: the caller asked for a plan, not a lecture.
  while (n > budget && step < 60) {
    step += 5;
    vals = values();
    n = enumerationSize(vals.length, minPrestiges, maxPrestiges);
    log.push(`too many; coarsening to step ${step} -> ${vals.length} values, ${n} chains`);
  }
  if (n > budget) {
    throw new Error(
      `Cannot get the coarse scan under ${budget} chains (${n} at step ${step}). ` +
        `Narrow the prestige range.`
    );
  }
  return { lo, hi, step, values: vals, chains: n, log };
}

export async function findStartingChain(opts: CoarseOptions): Promise<CoarseResult> {
  const { currentTE, final, minPrestiges, maxPrestiges, evaluateBatch } = opts;
  const grid = planCoarseGrid(opts);
  const { lo, hi, step, values: vals } = grid;
  const log = [...grid.log];

  const want = subsets(vals, minPrestiges, maxPrestiges, final).filter(c =>
    c.every((v, i) => (i === 0 ? v > currentTE : v > c[i - 1]))
  );

  // One wide batch is what this stage is for, but chunk it so progress ticks and Stop
  // responds. The pool sizes itself to each chunk, so bigger chunks are better here.
  const CHUNK = 96;
  const best = new Map<number, CoarseCandidate>();
  let evaluated = 0;
  for (let i = 0; i < want.length; i += CHUNK) {
    if (opts.shouldStop?.()) break;
    const slice = want.slice(i, i + CHUNK);
    const { results } = await evaluateBatch(slice);
    opts.onResults?.(results);
    evaluated += slice.length;
    for (const r of results) {
      const len = r.chain.length;
      const finalELR = r.legs.length ? r.legs[r.legs.length - 1].maxELR : 0;
      const cur = best.get(len);
      if (!cur || r.seconds < cur.seconds) {
        best.set(len, { chain: r.chain, seconds: r.seconds, finalELR, legs: r.legs });
      }
    }
    opts.onProgress?.(evaluated, want.length, `coarse scan ${evaluated}/${want.length}`);
  }
  if (!best.size) throw new Error('The coarse scan produced no usable chain.');

  const byCount = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  for (const c of byCount) {
    log.push(
      `${c.chain.length} prestiges: ${(c.seconds / 86400).toFixed(3)}  ${c.chain.join(' ')}  ` +
        `(final ELR ${c.finalELR.toFixed(3)})`
    );
  }

  // --- stage 3, the ladder check. Duration decides; the ceiling only breaks near-ties.
  //
  // This rule was wrong twice in the CLI, in opposite directions, and both mistakes are
  // worth not repeating here:
  //   1. Pure argmin duration chose 8 prestiges over 7 on the alt for a 0.156 d coarse
  //      edge when both ladders end at the same ceiling — an extra real-life rebuild for
  //      nothing, and ~2x the leg sims for every later stage.
  //   2. So it became "fewest count that reaches the ceiling", which is worse: on a third
  //      account all of 5/6/7/8 reach 11.585 q/hr but 8 is 12.6 DAYS faster than 5. Same
  //      ceiling, different time-to-ceiling.
  // So: take the fastest, and prefer a smaller count only when it is within TOL days AND
  // reaches the same ceiling — the genuine "wasted rebuild" case.
  const TOL_SECONDS = 0.5 * 86400;
  const fastest = byCount.reduce((a, b) => (b.seconds < a.seconds ? b : a));
  let winner = fastest;
  for (const c of byCount) {
    if (
      c.chain.length < fastest.chain.length &&
      c.seconds <= fastest.seconds + TOL_SECONDS &&
      c.finalELR >= fastest.finalELR - 0.01
    ) {
      winner = c;
      break;
    }
  }
  log.push(`ladder check -> ${winner.chain.length} prestiges`);
  if (winner !== fastest) {
    log.push(
      `(${fastest.chain.length} is ${((winner.seconds - fastest.seconds) / 86400).toFixed(3)} d ` +
        `faster but within 0.5 d and hits the same ceiling, so the extra rebuild is not worth it)`
    );
  }

  return {
    seed: winner.chain,
    byCount,
    pickedPrestiges: winner.chain.length,
    grid: { lo, hi, step, values: vals },
    chainsEvaluated: evaluated,
    log,
  };
}
