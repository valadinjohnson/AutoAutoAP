/**
 * Driver and batching tests against a SYNTHETIC cost landscape.
 *
 * Deliberately separate from chain.spec.ts: that one proves the evaluator scores a chain the way the
 * CLI does (and costs ~80 s and a real player backup to do it). This one proves the SEARCH LOGIC —
 * the window that must not walk, the descent that must find a minimum, the stop that must leave a
 * usable answer — and it runs in milliseconds because the "simulator" is arithmetic.
 *
 * The two failure modes asserted here are both real, observed regressions recorded in
 * scripts/autoplan.py: `resolve_last` re-centring on its own window edge and walking to 450+, and a
 * pass that regresses losing the best chain already seen.
 */
import { describe, expect, it } from 'vitest';
import { splitByPrefix, workersForBatch } from './batch';
import { runChainSearch, type EvaluateBatch } from './driver';
import type { ChainResult } from './types';

const FINAL = 490;
const CURRENT_TE = 175;

/**
 * A separable landscape with its minimum at a known chain. Each checkpoint contributes a quadratic
 * penalty for being away from its optimum, so coordinate descent is guaranteed to reach it — which
 * is the point: this test is about the driver's bookkeeping, not about a hard optimisation problem.
 */
function makeEvaluator(optimum: number[]): { evaluate: EvaluateBatch; calls: number[][][] } {
  const calls: number[][][] = [];
  const evaluate: EvaluateBatch = async chains => {
    calls.push(chains);
    const results: ChainResult[] = chains.map(chain => {
      let cost = 700 * 86400;
      for (let i = 0; i < chain.length - 1; i++) {
        const target = optimum[i] ?? chain[i];
        cost += (chain[i] - target) ** 2 * 600;
      }
      return { chain: [...chain], seconds: cost, legs: [] };
    });
    return { results, legSims: chains.length, workersUsed: 1 };
  };
  return { evaluate, calls };
}

describe('runChainSearch', () => {
  /**
   * The last checkpoint must be swept even when the seed puts it outside the legal range.
   *
   * `maxLast` (final - 150 = 340 here) caps the last checkpoint, but nothing that PRODUCES a seed
   * respects that cap -- the coarse scan sweeps a fixed 185..390 grid and returns whatever won.
   * `resolveLast` used to centre its window on the incoming value, so a seed of 360 gave
   * `lo = 348 > hi = 340`, an empty window, and a silent return. It then no-opped for the whole
   * run, including the re-solve after every accepted descent move, leaving the last checkpoint to
   * drift by descent's +-8 alone.
   *
   * Observed on a real 9795-chain `thorough` run: it settled at 742.378 d with A6=359 while
   * 741.500 d sat at A6=328 -- inside the range this sweep was supposed to cover, and never priced.
   * The optimum below is 31 away from the seed for exactly that reason: a radius-8 descent cannot
   * bridge it, so only a working sweep can.
   */
  it('sweeps the last checkpoint even when the seed starts above maxLast', async () => {
    const optimum = [195, 219, 248, 286, 328];
    const { evaluate } = makeEvaluator(optimum);
    const out = await runChainSearch({
      seedChain: [195, 219, 248, 286, 360, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'quick',
      evaluateBatch: evaluate,
    });
    expect(out.chain).toEqual([...optimum, FINAL]);
  });

  it('finds a separable optimum by coordinate descent', async () => {
    const optimum = [195, 219, 248, 286, 327];
    const { evaluate } = makeEvaluator(optimum);

    const outcome = await runChainSearch({
      seedChain: [190, 225, 255, 280, 320, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'quick',
      evaluateBatch: evaluate,
    });

    expect(outcome.chain).toEqual([...optimum, FINAL]);
    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.lastCompletedStage).toBe('coordinate descent');
  });

  it('never lets the last checkpoint walk past maxLast', async () => {
    // A landscape that rewards pushing the last checkpoint ever higher — exactly the shape that made
    // an earlier `resolve_last` re-centre on its own window edge and climb to 450+ against a final
    // of 490. `maxLast` (final - 150 = 340) is the hard stop.
    const evaluate: EvaluateBatch = async chains => ({
      results: chains.map(chain => ({
        chain: [...chain],
        seconds: (900 - chain[chain.length - 2]) * 86400,
        legs: [],
      })),
      legSims: chains.length,
      workersUsed: 1,
    });

    const outcome = await runChainSearch({
      seedChain: [195, 219, 248, 286, 300, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'quick',
      evaluateBatch: evaluate,
    });

    expect(outcome.chain[outcome.chain.length - 2]).toBeLessThanOrEqual(FINAL - 150);
  });

  it('stops between batches and still returns the best chain seen', async () => {
    const { evaluate } = makeEvaluator([195, 219, 248, 286, 327]);
    let batches = 0;
    const counting: EvaluateBatch = async chains => {
      batches++;
      return evaluate(chains);
    };

    const outcome = await runChainSearch({
      seedChain: [190, 225, 255, 280, 320, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'normal',
      evaluateBatch: counting,
      shouldStop: () => batches >= 2,
    });

    expect(outcome.stoppedEarly).toBe(true);
    // Stopping must never be worse than the seed: `ever` only ever moves downward.
    expect(outcome.seconds).toBeLessThanOrEqual(700 * 86400 + (190 - 195) ** 2 * 600 + 1e6);
    expect(outcome.chain[outcome.chain.length - 1]).toBe(FINAL);
  });

  it('replays a restored cache without re-evaluating anything', async () => {
    const optimum = [195, 219, 248, 286, 327];
    const first = makeEvaluator(optimum);
    const done = await runChainSearch({
      seedChain: [190, 225, 255, 280, 320, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'quick',
      evaluateBatch: first.evaluate,
      onCache: () => {},
    });

    // Re-run from the same seed with the previous run's cache restored. Every chain the first run
    // priced must come back as a cache hit, so the second run's evaluator sees strictly fewer
    // chains — that is what makes a refresh mid-run cheap.
    const entries: { key: string; seconds: number; legs: [] }[] = [];
    await runChainSearch({
      seedChain: [190, 225, 255, 280, 320, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'quick',
      evaluateBatch: first.evaluate,
      onCache: e => {
        entries.length = 0;
        entries.push(...(e as typeof entries));
      },
    });

    const second = makeEvaluator(optimum);
    const resumed = await runChainSearch({
      seedChain: [190, 225, 255, 280, 320, FINAL],
      final: FINAL,
      currentTE: CURRENT_TE,
      effort: 'quick',
      evaluateBatch: second.evaluate,
      restoredCache: entries,
    });

    expect(resumed.chain).toEqual(done.chain);
    expect(resumed.chainsEvaluated).toBeLessThan(done.chainsEvaluated);
  });
});

describe('batch splitting', () => {
  it('sizes the pool to the batch, not the CPU', () => {
    // The measured failure: a 13-chain batch spread over 12 workers is mostly overhead. Two chains
    // per worker is the floor.
    expect(workersForBatch(13, 12)).toBe(7);
    expect(workersForBatch(1, 12)).toBe(1);
    expect(workersForBatch(400, 12)).toBe(12);
  });

  it('cuts on whole prefix subtrees rather than round-robin over chains', () => {
    // A coordinate-descent sweep of the THIRD checkpoint: everything shares `195,219`. Cutting at
    // depth 1 or 2 would put every chain in one bucket, so the cut has to fall at depth 3.
    const chains = [240, 241, 242, 243].map(v => [195, 219, v, 286, 327, FINAL]);
    const buckets = splitByPrefix(chains, 4);
    expect(buckets.length).toBe(4);
    expect(buckets.flat().length).toBe(4);

    // A sweep of the LAST checkpoint over two distinct third-checkpoint subtrees must keep each
    // subtree whole, so each worker re-simulates the shared prefix at most once.
    const twoSubtrees = [
      ...[320, 321, 322].map(v => [195, 219, 248, 286, v, FINAL]),
      ...[320, 321, 322].map(v => [195, 219, 250, 286, v, FINAL]),
    ];
    const split = splitByPrefix(twoSubtrees, 2);
    expect(split.length).toBe(2);
    for (const bucket of split) {
      expect(new Set(bucket.map(c => c[2])).size).toBe(1);
    }
  });
});
