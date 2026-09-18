import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadChainBenchmark, saveChainBenchmark, type ChainBenchmarkCache } from './chainBenchmarkCache';

/** Same bare-localStorage stub used by stores/chainSearch.seed.spec.ts. */
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

const SAMPLE: ChainBenchmarkCache = {
  secondsPerChain: 2.34,
  source: 'benchmark',
  at: 1_700_000_000_000,
  chainCount: 32,
  workers: 8,
  currentTE: 195,
  finalTE: 490,
};

describe('chainBenchmarkCache', () => {
  beforeEach(() => {
    installStorageStub();
  });

  it('returns null when nothing has been saved for this player', () => {
    expect(loadChainBenchmark('player-1')).toBeNull();
  });

  it('round-trips exactly what was saved', () => {
    saveChainBenchmark('player-1', SAMPLE);
    expect(loadChainBenchmark('player-1')).toEqual(SAMPLE);
  });

  it('keeps different players separate', () => {
    saveChainBenchmark('player-1', SAMPLE);
    expect(loadChainBenchmark('player-2')).toBeNull();
  });

  it('overwrites a previous save for the same player', () => {
    saveChainBenchmark('player-1', SAMPLE);
    const updated: ChainBenchmarkCache = { ...SAMPLE, secondsPerChain: 0.9, source: 'live' };
    saveChainBenchmark('player-1', updated);
    expect(loadChainBenchmark('player-1')).toEqual(updated);
  });

  it('is a no-op without a player id, in either direction', () => {
    saveChainBenchmark('', SAMPLE);
    expect(loadChainBenchmark('')).toBeNull();
  });

  it('treats a corrupted entry as absent rather than throwing', () => {
    localStorage.setItem('chain_benchmark_v1:player-1', '{not json');
    expect(loadChainBenchmark('player-1')).toBeNull();
  });
});
