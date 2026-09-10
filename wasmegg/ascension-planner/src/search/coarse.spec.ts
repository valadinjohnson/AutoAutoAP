/**
 * The coarse scan and the ladder check, tested against a stub evaluator.
 *
 * No simulation here on purpose: this exercises the grid arithmetic and the prestige-count
 * rule, and both of those are pure. The rule in particular was wrong twice in the CLI, in
 * opposite directions, so each mistake gets a regression test rather than a comment.
 */
import { describe, expect, it } from 'vitest';
import { findStartingChain } from './coarse';
import type { LegSummary } from './types';

/** Build a stub evaluateBatch that prices a chain from a caller-supplied function. */
function stub(price: (chain: number[]) => { days: number; finalELR: number }) {
  let priced = 0;
  const fn = async (chains: number[][]) => ({
    results: chains.map(chain => {
      const { days, finalELR } = price(chain);
      priced++;
      const legs: LegSummary[] = chain.map((te, i) => ({
        key: 'continue' as LegSummary['key'],
        endTE: te,
        durationSeconds: (days * 86400) / chain.length,
        maxELR: i === chain.length - 1 ? finalELR : 0,
        endTime: 0,
        tier13Unlocked: false,
      }));
      return { chain, seconds: days * 86400, legs };
    }),
    legSims: chains.length,
    workersUsed: 1,
  });
  return { fn, count: () => priced };
}

const BASE = { currentTE: 175, final: 490, minPrestiges: 5, maxPrestiges: 8 };

describe('findStartingChain', () => {
  it('takes the FASTEST count even when a smaller one reaches the same ceiling', async () => {
    // The second historical mistake: on a real account all of 5/6/7/8 reached 11.585 q/hr
    // but 8 was 12.6 DAYS faster than 5. A "fewest count that reaches the ceiling" rule
    // discarded those 12.6 days. Same ceiling, different time-to-ceiling.
    const s = stub(chain => ({ days: 900 - chain.length * 12.6, finalELR: 11.585 }));
    const r = await findStartingChain({ ...BASE, evaluateBatch: s.fn });
    expect(r.pickedPrestiges).toBe(8);
    expect(r.seed[r.seed.length - 1]).toBe(490);
  });

  it('prefers the SMALLER count on a near-tie at the same ceiling', async () => {
    // The first historical mistake, in the other direction: pure argmin duration took 8
    // over 7 for a 0.156 d edge when both ladders end at the same ceiling - a real-life
    // rebuild for nothing, and roughly twice the leg sims for every later stage.
    const s = stub(chain => ({
      days: chain.length === 8 ? 899.844 : 900,
      finalELR: 11.585,
    }));
    const r = await findStartingChain({ ...BASE, evaluateBatch: s.fn });
    expect(r.pickedPrestiges).toBe(5);
    expect(r.log.some(l => l.includes('extra rebuild is not worth it'))).toBe(true);
  });

  it('does NOT prefer the smaller count when it gives up ceiling', async () => {
    // A lower ceiling is not a wasted rebuild, it is a worse farm. Duration must win.
    const s = stub(chain => ({
      days: chain.length === 8 ? 899.9 : 900,
      finalELR: chain.length === 8 ? 11.585 : 10.395,
    }));
    const r = await findStartingChain({ ...BASE, evaluateBatch: s.fn });
    expect(r.pickedPrestiges).toBe(8);
  });

  it('auto-coarsens the grid until the enumeration fits the budget', async () => {
    const s = stub(() => ({ days: 900, finalELR: 11.585 }));
    const r = await findStartingChain({ ...BASE, evaluateBatch: s.fn, budget: 400 });
    expect(r.chainsEvaluated).toBeLessThanOrEqual(400);
    expect(r.grid.step).toBeGreaterThan(15);
    expect(r.log.some(l => l.includes('coarsening to step'))).toBe(true);
    // 372 chains at step 25 is what both measured accounts actually produced.
    expect(r.grid.values.length).toBe(9);
  });

  it('throws rather than sweeping an empty grid when there is no room left', async () => {
    // At currentTE 485 with final 490 the naive bounds give lo 493 > hi 390. The old CLI
    // sailed past its budget check with 0 chains and handed fastsearch an empty grid.
    const s = stub(() => ({ days: 900, finalELR: 11.585 }));
    await expect(
      findStartingChain({ ...BASE, currentTE: 485, evaluateBatch: s.fn })
    ).rejects.toThrow(/No room for intermediate checkpoints/);
  });

  it('never proposes a checkpoint at or below the current TE', async () => {
    const s = stub(() => ({ days: 900, finalELR: 11.585 }));
    const r = await findStartingChain({ ...BASE, evaluateBatch: s.fn });
    for (const c of r.byCount) {
      expect(c.chain[0]).toBeGreaterThan(BASE.currentTE);
      for (let i = 1; i < c.chain.length; i++) expect(c.chain[i]).toBeGreaterThan(c.chain[i - 1]);
    }
  });

  it('stops between chunks when asked', async () => {
    const s = stub(() => ({ days: 900, finalELR: 11.585 }));
    let calls = 0;
    const r = await findStartingChain({
      ...BASE,
      evaluateBatch: async chains => {
        calls++;
        return s.fn(chains);
      },
      shouldStop: () => calls >= 1,
    });
    expect(calls).toBe(1);
    expect(r.seed.length).toBeGreaterThan(0);
  });
});
