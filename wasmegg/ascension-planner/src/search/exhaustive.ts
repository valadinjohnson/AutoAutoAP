/**
 * @module exhaustive
 * @description Enumerating every strictly-increasing chain over a pool, for the mode that can
 * actually prove something.
 *
 * The staged search returns a strong local optimum and says so. This returns the true optimum of
 * the space it enumerates, because it prices all of it. That is the only reason this project can
 * say "rank 1 of 4913" about anything.
 *
 * THERE IS NO PRUNING HERE, and that is not an omission. Pruning by prefix cost is inadmissible:
 * a prefix that arrives later can arrive with a higher delivery rate and win overall. It was
 * implemented once and measured, and it cut 0 of 69 chains on a real run. Exhaustive means
 * exhaustive.
 *
 * IT RUNS AWAY FAST. Choosing 6 checkpoints from 185..390 at step 1 is C(206,6) = 8.2e10 chains.
 * The count is combinatorial in the pool size, so the difference between step 10 and step 5 is not
 * double, it is orders of magnitude. `countChains` exists so a caller can say so before simulating
 * anything, rather than after.
 */

/** Pool spec, the browser form of the CLI's `--range lo:hi[:step]`. */
export interface PoolSpec {
  lo: number;
  hi: number;
  /** Values are taken every `step` TE. Defaults to 1 and must be positive. */
  step: number;
}

/**
 * The checkpoint values to choose from, with anything unreachable dropped.
 *
 * At or below `currentTE` is not an ascension the account can perform, and at or above `final` is
 * the target itself, which every chain ends with anyway.
 */
export function buildPool(spec: PoolSpec, currentTE: number, final: number): number[] {
  const step = Number.isFinite(spec.step) && spec.step > 0 ? Math.floor(spec.step) : 1;
  if (!Number.isFinite(spec.lo) || !Number.isFinite(spec.hi) || spec.hi < spec.lo) return [];

  const values: number[] = [];
  for (let v = Math.floor(spec.lo); v <= Math.floor(spec.hi); v += step) values.push(v);
  return [...new Set(values)].filter(v => v > currentTE && v < final).sort((a, b) => a - b);
}

/**
 * Every strictly-increasing chain over `pool` with between `minAsc` and `maxAsc` ascensions,
 * `final` appended to each. Ported verbatim from the CLI's own enumeration so the two modes cannot
 * drift into enumerating different spaces.
 *
 * `minAsc`/`maxAsc` count the final target, so a 5-ascension chain takes 4 values from the pool.
 */
export function exhaustiveChains(
  pool: number[],
  minAsc: number,
  maxAsc: number,
  final: number,
  currentTE: number
): number[][] {
  const out: number[][] = [];
  const walk = (i: number, acc: number[]) => {
    if (acc.length >= minAsc - 1 && acc.length <= maxAsc - 1 && acc.length) out.push([...acc, final]);
    if (acc.length >= maxAsc - 1) return;
    for (let j = i; j < pool.length; j++) {
      if (pool[j] >= final) break;
      if (!acc.length ? pool[j] > currentTE : pool[j] > acc[acc.length - 1]) walk(j + 1, [...acc, pool[j]]);
    }
  };
  walk(0, []);
  return out;
}

/**
 * How many chains `exhaustiveChains` would return, without building them.
 *
 * Enumerating first and counting the array is how a browser tab dies before it can warn anybody:
 * at step 1 over a wide range the array does not fit in memory. This is the same sum of binomial
 * coefficients, computed in floating point, so it saturates to Infinity instead of allocating.
 */
export function countChains(poolSize: number, minAsc: number, maxAsc: number): number {
  const lo = Math.max(1, Math.floor(minAsc));
  const hi = Math.max(lo, Math.floor(maxAsc));
  let total = 0;
  for (let asc = lo; asc <= hi; asc++) {
    const pick = asc - 1;
    if (pick < 1 || pick > poolSize) continue;
    total += binomial(poolSize, pick);
    if (!Number.isFinite(total)) return Infinity;
  }
  return total;
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i++) {
    result = (result * (n - kk + i)) / i;
    if (!Number.isFinite(result)) return Infinity;
  }
  return Math.round(result);
}

/**
 * Wall-clock upper bound in hours.
 *
 * `secondsPerChain` is the measured floor with a warm prefix memo, so this over-estimates, which
 * is the direction an "are you sure" should err. Prefix sharing makes the real figure lower.
 */
export function estimateHours(chains: number, workers: number, secondsPerChain = 15): number {
  if (!Number.isFinite(chains)) return Infinity;
  return (chains * secondsPerChain) / 3600 / Math.max(1, workers);
}

/** `2.1 h`, `45 min`, `3.4 years`. Coarse on purpose: this is a decision aid, not a countdown. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return 'longer than you have';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  const days = hours / 24;
  if (days < 365) return `${days.toFixed(1)} days`;
  return `${(days / 365).toFixed(1)} years`;
}

/**
 * Sort so chains sharing a prefix are adjacent.
 *
 * The evaluator memoises by prefix, and a leg simulation is the entire cost of the thing. Chunking
 * an unsorted list scatters siblings across chunks and throws that away: the CLI measured prefix
 * sharing saving the large majority of leg simulations on a real run.
 */
export function sortByPrefix(chains: number[][]): number[][] {
  return [...chains].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
}

/* ------------------------------------------------------------------------------------------- *
 * Shaping the space
 *
 * Plain `--range lo:hi:step` enumeration has a blind spot: STEP CONTROLS THE GRID, NOT THE CHAIN.
 * At step 15 the pool is 185, 200, 215, 230 ... and `185 200 215 230 490` is a perfectly legal
 * chain -- three 15-TE ascensions followed by a 260-TE one. Each of those is a full farm rebuild
 * for almost no earning time, and the enumeration prices thousands of them.
 *
 * Two ways to stop that, both OPT-IN, because both narrow what the run proves. An exhaustive over
 * a restricted space is the true optimum OF THAT SPACE, and the moment a constraint is added the
 * claim shrinks with it. That is worth saying out loud rather than burying: the value of this mode
 * is that it proves something.
 *
 * AND A MEASURED WARNING ABOUT MINIMUM GAP. It is tempting to set one and forget it. The best
 * 7-ascension chain found on this account so far is `185 200 215 230 290 380 490`, whose interior
 * gaps are 15, 15, 15, 60, 90 -- any minimum gap above 15 excludes it outright. Small early gaps
 * are cheap when the ascension is short; they only look absurd from the far end of the chain.
 * ------------------------------------------------------------------------------------------- */

/** Smallest interior gap seen in a chain measured as good on this project's own corpora. */
export const SMALLEST_MEASURED_GAP = 15;

/**
 * Every strictly-increasing chain over `pool`, with a minimum distance between consecutive
 * checkpoints. `minGap` of 0 or less is the unconstrained enumeration.
 *
 * The gap to the final target is deliberately NOT constrained: the last leg is long by nature and
 * the driver's `maxLast` is the knob for that end of the chain.
 */
export function exhaustiveChainsWithGap(
  pool: number[],
  minAsc: number,
  maxAsc: number,
  final: number,
  currentTE: number,
  minGap: number
): number[][] {
  if (!(minGap > 0)) return exhaustiveChains(pool, minAsc, maxAsc, final, currentTE);
  const out: number[][] = [];
  const walk = (i: number, acc: number[]) => {
    if (acc.length >= minAsc - 1 && acc.length <= maxAsc - 1 && acc.length) out.push([...acc, final]);
    if (acc.length >= maxAsc - 1) return;
    for (let j = i; j < pool.length; j++) {
      const v = pool[j];
      if (v >= final) break;
      if (!acc.length ? v > currentTE : v - acc[acc.length - 1] >= minGap) walk(j + 1, [...acc, v]);
    }
  };
  walk(0, []);
  return out;
}

/**
 * How many chains the above would return, without building them.
 *
 * `countChains` is a sum of binomials, which stops being right the moment a gap constraint exists.
 * This is a DP over (pool index, checkpoints chosen so far): `ways[j][k]` is the number of chains
 * of k checkpoints whose last one is `pool[j]`. O(pool^2 x maxAsc), which is nothing next to
 * enumerating, and it keeps the promise that the form can refuse a space before allocating it.
 */
export function countChainsWithGap(pool: number[], minAsc: number, maxAsc: number, minGap: number): number {
  if (!(minGap > 0)) return countChains(pool.length, minAsc, maxAsc);
  const n = pool.length;
  const maxPick = Math.max(0, Math.floor(maxAsc) - 1);
  const minPick = Math.max(1, Math.floor(minAsc) - 1);
  if (n === 0 || maxPick === 0) return 0;

  // ways[k][j]: chains of k checkpoints ending at pool[j].
  let ways: number[][] = [];
  ways[1] = new Array(n).fill(1);
  let total = minPick <= 1 && 1 <= maxPick ? n : 0;

  for (let k = 2; k <= maxPick; k++) {
    const row = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < j; i++) {
        if (pool[j] - pool[i] >= minGap) sum += ways[k - 1][i];
      }
      row[j] = sum;
      if (!Number.isFinite(row[j])) return Infinity;
    }
    ways[k] = row;
    if (k >= minPick) {
      for (const v of row) {
        total += v;
        if (!Number.isFinite(total)) return Infinity;
      }
    }
  }
  return total;
}

/**
 * Per-checkpoint bands: checkpoint 1 comes from band 1, checkpoint 2 from band 2, and so on.
 *
 * This is the surgical version of the same idea. "185-200, then 210-240, then 250-290" says where
 * each ascension should land rather than leaving the enumeration free to stack four of them inside
 * twenty TE. The ascension count is fixed by construction: N bands is N+1 ascensions, target
 * included.
 *
 * Bands may overlap; the strictly-increasing and `minGap` rules still apply, so an overlap simply
 * means the two checkpoints can be close, not that they can swap order.
 */
export function bandedChains(bands: number[][], final: number, currentTE: number, minGap = 0): number[][] {
  if (!bands.length || bands.some(b => !b.length)) return [];
  const out: number[][] = [];
  const walk = (slot: number, acc: number[]) => {
    if (slot === bands.length) {
      out.push([...acc, final]);
      return;
    }
    for (const v of bands[slot]) {
      if (v >= final) continue;
      const ok = acc.length ? v - acc[acc.length - 1] >= Math.max(1, minGap) : v > currentTE;
      if (ok) walk(slot + 1, [...acc, v]);
    }
  };
  walk(0, []);
  return out;
}

/** Counted the same way, by DP across the bands, so a wide set can be refused before it is built. */
export function countBanded(bands: number[][], final: number, currentTE: number, minGap = 0): number {
  if (!bands.length || bands.some(b => !b.length)) return 0;
  const gap = Math.max(1, minGap);

  // counts[i]: how many partial chains end at bands[slot][i].
  let prev: number[] = bands[0].filter(v => v > currentTE && v < final).map(() => 1);
  let prevValues = bands[0].filter(v => v > currentTE && v < final);

  for (let slot = 1; slot < bands.length; slot++) {
    const values = bands[slot].filter(v => v < final);
    const row = new Array(values.length).fill(0);
    for (let j = 0; j < values.length; j++) {
      let sum = 0;
      for (let i = 0; i < prevValues.length; i++) {
        if (values[j] - prevValues[i] >= gap) sum += prev[i];
      }
      row[j] = sum;
      if (!Number.isFinite(row[j])) return Infinity;
    }
    prev = row;
    prevValues = values;
  }

  let total = 0;
  for (const v of prev) {
    total += v;
    if (!Number.isFinite(total)) return Infinity;
  }
  return total;
}

/** `185-200:5` -> [185, 190, 195, 200]. The band form of a pool spec, for the UI's text entry. */
export function parseBand(text: string, defaultStep = 5): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const [rangePart, stepPart] = trimmed.split(':');
  const bounds = rangePart.split(/[-–]/).map(x => Number(x.trim()));
  const step = Number(stepPart) > 0 ? Math.floor(Number(stepPart)) : defaultStep;
  if (bounds.length === 1 && Number.isFinite(bounds[0])) return [Math.floor(bounds[0])];
  if (bounds.length !== 2 || !bounds.every(Number.isFinite) || bounds[1] < bounds[0]) return [];
  const out: number[] = [];
  for (let v = Math.floor(bounds[0]); v <= Math.floor(bounds[1]); v += step) out.push(v);
  return out;
}

/** `185-200:5; 210-240; 250-290` -> one band per segment. Blank segments are dropped. */
export function parseBands(text: string, defaultStep = 5): number[][] {
  return text
    .split(';')
    .flatMap(part => part.split('\n'))
    .map(part => parseBand(part, defaultStep))
    .filter(b => b.length);
}
