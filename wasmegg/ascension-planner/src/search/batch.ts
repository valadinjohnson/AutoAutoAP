/**
 * How a batch of chains is cut up across workers, and how many workers a batch is worth.
 *
 * BOTH of these are measurements, not preferences.
 *
 * SIZE THE POOL TO THE BATCH, NOT THE CPU. The CLI forks a process per shard for every batch, and
 * on a MacBook stage 2 (one 372-chain batch) ran at 1.43 s/chain while stage 4 (many 13-17 chain
 * batches) ran at 19.68 s/chain — a 13.8x small-batch penalty, versus 2.0x on the same work on
 * Windows. Spreading a 13-chain batch over 12 shards is mostly overhead.
 *
 * The browser is NOT identical to the CLI here and it is worth being precise about why, because the
 * naive translation would be wrong in the other direction. A Web Worker pool is created once and
 * kept, so worker STARTUP is paid once per run rather than once per batch — the CLI's dominant
 * small-batch cost mostly disappears. What does NOT disappear is the other half of the penalty:
 * splitting a batch destroys PREFIX SHARING. A 17-value sweep of the third checkpoint of a 6-leg
 * chain costs 2 + 17x4 = 70 leg simulations in one worker; spread over 17 workers it costs 17x6 =
 * 102, because every worker re-simulates the two shared leading legs. So the rule kept here is
 * "enough workers to use the machine, never so many that each one gets a single chain": a floor of
 * `MIN_CHAINS_PER_WORKER` chains each.
 *
 * CUT ON WHOLE PREFIX SUBTREES, NEVER ROUND-ROBIN OVER CHAINS. Same rule fastsearch.ts uses for its
 * process shards, for the same reason. The cut depth is the SHALLOWEST that yields at least as many
 * groups as there are workers: shallower means bigger subtrees and more sharing retained, but too
 * shallow cannot fill the pool.
 *
 * And one more measured caution against over-tuning: on Windows a 152-chain batch ran 668/624/673 s
 * at 6/12/17 shards — only 7.9% spread — and the PERFECTLY balanced 17-way split was the slowest of
 * the three. Balance is not the thing that matters; keeping subtrees intact is.
 */

/** Never hand a worker fewer chains than this while there are chains left to hand out. */
const MIN_CHAINS_PER_WORKER = 2;

/** Fallback when `navigator.hardwareConcurrency` is missing (it is optional in the spec, and some
 *  browsers clamp or omit it). Four is a safe floor on anything that can run this app at all. */
const DEFAULT_CONCURRENCY = 4;

/** Logical cores, as the browser reports them. The one hardware fact a page is reliably told. */
export function hardwareThreads(): number {
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || DEFAULT_CONCURRENCY;
}

/** The pool's DEFAULT: one worker per logical core, minus one left for the main thread so the
 *  progress bar keeps painting. Not a ceiling -- see `clampPoolSize`, which lets someone who is
 *  leaving a machine to run overnight spend the last core too. */
export function maxPoolSize(): number {
  return Math.max(1, hardwareThreads() - 1);
}

/**
 * Hold a requested worker count to something this machine can actually run.
 *
 * The ceiling is every logical core, not cores minus one. Leaving one for the main thread is the
 * right DEFAULT -- it is what keeps the progress bar painting and the Stop button responsive -- but
 * it is a comfort setting, and someone who has decided to give a machine over to a run overnight
 * should be able to spend it. Past the core count there is nothing to buy: the workers are CPU-bound
 * and would only take turns.
 */
export function clampPoolSize(requested: number): number {
  if (!Number.isFinite(requested)) return maxPoolSize();
  return Math.max(1, Math.min(hardwareThreads(), Math.floor(requested)));
}

/** How many of the pool's workers this particular batch is worth using. */
export function workersForBatch(batchSize: number, poolSize: number): number {
  if (batchSize <= 0) return 1;
  return Math.max(1, Math.min(poolSize, Math.ceil(batchSize / MIN_CHAINS_PER_WORKER)));
}

/**
 * Split `chains` into at most `workers` groups, cut on whole prefix subtrees.
 *
 * Empty groups are dropped rather than returned, so the caller can use `result.length` as the
 * number of workers actually needed.
 */
export function splitByPrefix(chains: number[][], workers: number): number[][][] {
  if (chains.length === 0) return [];
  if (workers <= 1) return [chains];

  const keyAt = (c: number[], depth: number) => c.slice(0, depth).join(',');

  // Shallowest depth that yields at least `workers` distinct prefixes. Fixing this at depth 1 is
  // the mistake the CLI documents: on a grid whose second checkpoint has a single value, every
  // chain lands in one group and every extra worker sits idle.
  const maxDepth = chains[0].length;
  let depth = 1;
  for (let d = 1; d <= maxDepth; d++) {
    depth = d;
    if (new Set(chains.map(c => keyAt(c, d))).size >= workers) break;
  }

  const groups = new Map<string, number[][]>();
  for (const c of chains) {
    const k = keyAt(c, depth);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }

  // Deal whole subtrees round-robin. Subtree sizes differ, so the split is uneven — deliberately.
  // See the doc comment: the perfectly balanced split measured slowest.
  const buckets: number[][][] = Array.from({ length: workers }, () => []);
  let i = 0;
  for (const g of groups.values()) {
    buckets[i % workers].push(...g);
    i++;
  }
  return buckets.filter(b => b.length > 0);
}
