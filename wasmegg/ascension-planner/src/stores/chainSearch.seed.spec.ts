import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChainSearchStore } from './chainSearch';
import { useAutoPlannerStore } from './autoPlanner';

/**
 * The actions store reads `localStorage` in its `state()`, which runs the moment any store in the
 * graph is instantiated, and these tests run under vitest's `node` environment. Stubbed here
 * rather than in a shared setup file because this is the only spec that reaches that far into the
 * store graph; promote it if a second one appears.
 */
function installStorageStub(): void {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() {
      return backing.size;
    },
  });
}

/**
 * The seed the panel actually hands the search, as opposed to `defaultSeedChain` in isolation.
 *
 * Both reported failures came from this computed rather than from the generator: an empty Target
 * TE field produced a one-ascension chain, and a checkpoint below current TE was passed through to
 * the simulator, which is what surfaced as a bare "Chain search worker error".
 */
describe('chainSearch: seedChain', () => {
  beforeEach(() => {
    installStorageStub();
    setActivePinia(createPinia());
  });

  /**
   * `currentTE` is a computed off the actions store's snapshot and cannot be set from here, so it
   * reads 0 in these tests. That is a real state (no backup loaded yet), and it is why the
   * "checkpoint below current TE" rule is tested against `usableCheckpoints` in
   * search/seedChain.spec.ts rather than here.
   */
  function setup(opts: { targetTE?: string; finalTE?: number }) {
    const store = useChainSearchStore();
    useAutoPlannerStore().targetTE = opts.targetTE ?? '';
    store.finalTE = opts.finalTE ?? 490;
    return store;
  }

  it('builds a chain inside the prestige limits when Target TE is empty', () => {
    // The reported bug: an empty Target TE left the seed as a single-ascension chain, which
    // descent can never grow into the 5-8 the Limits box is asking for.
    const store = setup({});
    store.minPrestiges = 5;
    store.maxPrestiges = 8;

    expect(store.seedChain.length).toBeGreaterThanOrEqual(5);
    expect(store.seedChain.length).toBeLessThanOrEqual(8);
    expect(store.seedChain[store.seedChain.length - 1]).toBe(490);
    expect(store.seedIssue).toBeNull();
  });

  it('never leaves the seed as a bare final target', () => {
    const store = setup({});
    expect(store.seedChain).not.toEqual([490]);
  });

  it('keeps a usable typed chain exactly as typed', () => {
    const store = setup({ targetTE: '195 226 277 317' });
    expect(store.seedChain).toEqual([195, 226, 277, 317, 490]);
  });

  it('reports a typed chain too short for the limits instead of silently running it', () => {
    const store = setup({ targetTE: '250' });
    store.minPrestiges = 5;
    store.maxPrestiges = 8;
    store.effort = 'balanced';

    expect(store.seedChain).toEqual([250, 490]);
    expect(store.seedIssue).toEqual({ kind: 'too-short', ascensions: 2, minPrestiges: 5, probeCanFix: false });
  });

  it('flags a chain longer than the maximum on a tier with no prestige-count probe', () => {
    // The reported case: `199 222 252 291 490` under a maximum of 4, on Balanced. The limits only
    // reach the coarse scan and the probe, and Balanced runs neither, so every stage would have
    // worked on a 5-ascension chain and returned one.
    const store = setup({ targetTE: '199 222 252 291' });
    store.minPrestiges = 2;
    store.maxPrestiges = 4;
    store.effort = 'balanced';

    expect(store.seedChain).toEqual([199, 222, 252, 291, 490]);
    expect(store.seedIssue).toEqual({ kind: 'too-long', ascensions: 5, maxPrestiges: 4, probeCanFix: false });
  });

  it('marks the same chain as probe-fixable on a tier that runs the probe', () => {
    const store = setup({ targetTE: '199 222 252 291' });
    store.minPrestiges = 2;
    store.maxPrestiges = 4;
    store.effort = 'normal';

    expect(store.seedIssue).toEqual({ kind: 'too-long', ascensions: 5, maxPrestiges: 4, probeCanFix: true });
  });

  it('fits the seed to the limits on request', () => {
    const store = setup({ targetTE: '199 222 252 291' });
    store.minPrestiges = 2;
    store.maxPrestiges = 4;
    store.effort = 'balanced';

    store.fitSeedToLimitsNow();
    expect(store.seedChain).toHaveLength(4);
    expect(store.seedIssue).toBeNull();
  });

  it('raises no issue when the coarse scan is picking the seed', () => {
    // "Find a starting chain for me" replaces the seed wholesale, so the typed one is irrelevant.
    const store = setup({ targetTE: '250' });
    store.minPrestiges = 5;
    store.findSeedFirst = true;
    expect(store.seedIssue).toBeNull();
  });
});
