/**
 * @module runLibrary
 * @description Named, reloadable chain-search runs, the way the plan library holds plans.
 *
 * WHAT THIS IS NOT. `persistence.ts` already checkpoints a run, but to ONE slot
 * (`METADATA_KEY = 'chainSearchRun'`) that only resumes onto an identical fingerprint. Change the
 * target TE, the plan start, or your current TE, and it is unusable. Finish a search, start a
 * different one, and the first is gone except whatever CSV was downloaded. That is a crash guard,
 * not a history.
 *
 * This keeps runs deliberately, under names, and reloads any of them at any time.
 *
 * WHAT IS STORED, AND THE SIZE PROBLEM. The valuable thing is the chain -> duration cache: every
 * entry is roughly fifteen seconds of CPU. It is also the big thing -- an 11,000-chain run is
 * megabytes. So the index is kept separately from the bodies: listing the library reads one small
 * record, and a run's cache is only loaded when it is opened. The library is capped by count and
 * the oldest is evicted, because the alternative is discovering the quota is full at the end of a
 * three-hour run.
 *
 * Per-leg summaries are kept for the best chain only, the same trade `persistence.ts` makes and
 * for the same reason: keeping them for every cached chain multiplies the record by about six for
 * information nothing reads.
 */
import { loadMetadata, saveMetadata } from '@/lib/storage/db';
import type { CacheEntry } from './driver';
import type { EffortTier, LegSummary } from './types';

const INDEX_KEY = 'chainSearchLibraryIndex';
const BODY_PREFIX = 'chainSearchLibraryRun:';

/** Bumped when the shape below changes, or when a simulator change would make cached durations
 *  wrong. A mismatched entry is dropped rather than reloaded onto numbers from different code. */
export const LIBRARY_VERSION = 1;

/** Runs kept per player. Past this the oldest is evicted on save. */
export const MAX_RUNS = 20;

/** What the list shows, and all that is read to render it. */
export interface RunSummary {
  id: string;
  version: number;
  label: string;
  savedAt: number;
  currentTE: number;
  finalTE: number;
  effort: EffortTier | string;
  seedChain: number[];
  bestChain: number[];
  bestDays: number;
  chainsPriced: number;
  /** Whether the run reached the end of its tier, for the list to say so without opening it. */
  complete: boolean;
}

/** The body, loaded only when a run is opened. */
export interface RunBody {
  version: number;
  entries: CacheEntry[];
  bestLegs: LegSummary[];
  /** The verbose stage log, so a reloaded run can still explain what it did. */
  runLog: string[];
}

export interface SaveRunInput {
  label: string;
  currentTE: number;
  finalTE: number;
  effort: EffortTier | string;
  seedChain: number[];
  bestChain: number[];
  bestDays: number;
  entries: CacheEntry[];
  bestLegs: LegSummary[];
  runLog: string[];
  complete: boolean;
  /** Injectable so tests are not clock-dependent. */
  now?: number;
  /** Injectable for the same reason; ids are otherwise random. */
  id?: string;
}

function bodyKey(id: string): string {
  return `${BODY_PREFIX}${id}`;
}

/** Newest first. Drops entries from an older version rather than showing something unopenable. */
export async function listRuns(partitionHash: string): Promise<RunSummary[]> {
  const raw = (await loadMetadata(partitionHash, INDEX_KEY)) as RunSummary[] | null;
  if (!Array.isArray(raw)) return [];
  return raw.filter(r => r && r.version === LIBRARY_VERSION).sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Save a run under a name and return its summary.
 *
 * Writes the body FIRST, then the index. If the quota blows partway, the worst case is an orphaned
 * body that nothing lists, rather than an index entry pointing at a run that cannot be opened.
 */
export async function saveRun(partitionHash: string, input: SaveRunInput): Promise<RunSummary> {
  const id = input.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const priced = input.entries.filter(e => e.seconds > 0);

  const body: RunBody = {
    version: LIBRARY_VERSION,
    entries: priced,
    bestLegs: input.bestLegs,
    runLog: input.runLog,
  };
  await saveMetadata(partitionHash, bodyKey(id), body);

  const summary: RunSummary = {
    id,
    version: LIBRARY_VERSION,
    label: input.label.trim().slice(0, 80) || 'Untitled run',
    savedAt: input.now ?? Date.now(),
    currentTE: input.currentTE,
    finalTE: input.finalTE,
    effort: input.effort,
    seedChain: [...input.seedChain],
    bestChain: [...input.bestChain],
    bestDays: input.bestDays,
    chainsPriced: priced.length,
    complete: input.complete,
  };

  const existing = await listRuns(partitionHash);
  // A re-save under the same id replaces rather than duplicates.
  const next = [summary, ...existing.filter(r => r.id !== id)];

  // Evict oldest past the cap, and delete their bodies too. An index that forgets a run while its
  // megabytes stay in IndexedDB is how a quota fills up with nothing to show for it.
  const kept = next.slice(0, MAX_RUNS);
  for (const dropped of next.slice(MAX_RUNS)) {
    await saveMetadata(partitionHash, bodyKey(dropped.id), null);
  }
  await saveMetadata(partitionHash, INDEX_KEY, kept);
  return summary;
}

/** The body for a saved run, or null when it is missing or from an older version. */
export async function loadRun(partitionHash: string, id: string): Promise<RunBody | null> {
  const raw = (await loadMetadata(partitionHash, bodyKey(id))) as RunBody | null;
  if (!raw || raw.version !== LIBRARY_VERSION || !Array.isArray(raw.entries)) return null;
  return raw;
}

/** Remove a run and its body. Safe to call for an id that is already gone. */
export async function deleteRun(partitionHash: string, id: string): Promise<void> {
  await saveMetadata(partitionHash, bodyKey(id), null);
  const existing = await listRuns(partitionHash);
  await saveMetadata(
    partitionHash,
    INDEX_KEY,
    existing.filter(r => r.id !== id)
  );
}

/** A default name, so saving does not require thinking of one: `490 TE · 6 asc · 741.9 d`. */
export function defaultRunLabel(finalTE: number, bestChain: number[], bestDays: number): string {
  const asc = bestChain.length ? `${bestChain.length} asc` : 'no result';
  const days = bestDays > 0 ? `${bestDays.toFixed(1)} d` : 'unpriced';
  return `${finalTE} TE · ${asc} · ${days}`;
}
