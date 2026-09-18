/**
 * @module chainBenchmarkCache
 * @description localStorage-backed persistence for the exhaustive search's measured
 * seconds-per-chain rate (see stores/chainSearch.ts's `secondsPerChain`), so a rate obtained on this
 * machine — from the "Benchmark my PC" button or from a real run's own first chunk — survives a page
 * reload instead of falling back to the hardcoded 15 s assumption every time. Follows the same bare
 * localStorage pattern used elsewhere in this app (see autoPlannerFormCache.ts).
 *
 * Keyed per player: leg simulation cost depends on the account's backup (research levels, artifact
 * inventory), so one account's rate is not necessarily another's.
 */

const STORAGE_KEY_PREFIX = 'chain_benchmark_v1';

export interface ChainBenchmarkCache {
  /** Seconds per chain, in the same units `secondsPerChain` uses everywhere else. */
  secondsPerChain: number;
  /** Where this number came from — a manual benchmark probe or a real run's own measurement. */
  source: 'benchmark' | 'live';
  /** `Date.now()` when it was measured. */
  at: number;
  /** How many chains the measurement was based on. */
  chainCount: number;
  /** Worker budget in effect when measured. */
  workers: number;
  /** TE span measured over, for the caption — not used for correctness or staleness checks. */
  currentTE: number;
  finalTE: number;
}

function storageKey(playerId: string): string {
  return `${STORAGE_KEY_PREFIX}:${playerId}`;
}

export function loadChainBenchmark(playerId: string): ChainBenchmarkCache | null {
  if (!playerId) return null;
  try {
    const raw = localStorage.getItem(storageKey(playerId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveChainBenchmark(playerId: string, data: ChainBenchmarkCache): void {
  if (!playerId) return;
  try {
    localStorage.setItem(storageKey(playerId), JSON.stringify(data));
  } catch {
    // Ignore quota/privacy-mode errors — persistence is a nicety, not a requirement.
  }
}
