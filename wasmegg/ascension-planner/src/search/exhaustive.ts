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
