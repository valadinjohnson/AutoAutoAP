/**
 * Checkpointing a chain search to IndexedDB, so a refresh in hour two of a three-hour run does not
 * throw the run away.
 *
 * Reuses lib/storage/db.ts's `metadata` store (the same partition-by-hashed-player-id scheme the
 * plan library and the active draft already use) rather than introducing a second storage layer.
 *
 * WHAT IS SAVED, AND WHY THAT IS ENOUGH TO RESUME. The expensive thing a run accumulates is the
 * chain -> duration cache: every entry in it is roughly fifteen seconds of CPU that never has to be
 * spent again. The driver itself is deterministic given that cache, so resuming does NOT need the
 * driver's internal loop position — restoring the cache and re-running from the top replays every
 * already-known chain as a cache hit (no simulation, no worker traffic) and then continues from
 * exactly where the run stopped. That is a fast replay, not a re-simulation, and it is far more
 * robust than serialising a half-finished nested loop.
 *
 * Per-leg summaries are kept ONLY for the current best chain. They exist to render the results
 * table; keeping them for every cached chain would multiply the record's size by roughly six for
 * information nothing reads.
 */
import { loadMetadata, saveMetadata } from '@/lib/storage/db';
import type { CacheEntry } from './driver';
import type { SearchSpace } from './submission';
import { availabilityKey, type Availability } from './availability';
import { milestonesKey, type Milestone } from './milestones';
import type { EffortTier, LegSummary } from './types';

const METADATA_KEY = 'chainSearchRun';

/** Bumped whenever the shape below changes, or whenever a simulator change would make old cached
 *  durations wrong. A mismatched version discards the checkpoint rather than resuming onto numbers
 *  produced by different code — a silently stale cache is worse than no cache. */
const RECORD_VERSION = 1;

export interface SearchCheckpoint {
  version: number;
  /** Identifies the run's inputs. A checkpoint only resumes onto an identical fingerprint: the plan
   *  start, the player's TE and the final target all change every duration in the cache. */
  fingerprint: string;
  effort: EffortTier;
  seedChain: number[];
  bestChain: number[];
  bestSeconds: number;
  bestLegs: LegSummary[];
  /** `key,seconds` pairs — the cache, without per-leg detail. */
  durations: [string, number][];
  stage: string;
  detail: string;
  chainsDone: number;
  /** True once a run returned normally. The record is still useful - a higher effort tier
   *  replays its cache - but it must not be advertised as an unfinished run to resume. */
  complete: boolean;
  updatedAt: number;

  /**
   * The space an exhaustive run was enumerating, when it was one.
   *
   * ADDED FOR THE CRASH CASE, which is the only case the checkpoint exists for and the one it could
   * not actually finish. Everything needed to carry on was already here -- every priced duration,
   * the fingerprint proving they are still valid -- except the one thing nobody can reconstruct
   * from the outside: WHICH chains the run was working through. So after a crash the cache was
   * replayable in principle and unreachable in practice, because resuming meant retyping the bands
   * exactly and any difference started a different search.
   *
   * Optional and unversioned on purpose. A record written before this field is still a valid
   * record; it simply cannot offer to resume itself, which is what it could do before. Bumping
   * RECORD_VERSION to add it would have deleted the in-flight run of anyone who reloaded mid-search
   * on the release that introduced it -- the exact accident this field is meant to prevent.
   */
  space?: SearchSpace;
}

/**
 * Everything that changes what a duration means. Used verbatim as the resume gate.
 *
 * The availability schedule belongs here — it delays every prestige and so changes every cached
 * duration — but it is APPENDED only when a schedule actually excludes something, so a run without
 * one produces the byte-identical fingerprint it always did and existing checkpoints still resume.
 * The key sorts its days, so reordering the checkboxes cannot invalidate a three-hour run. Dated
 * milestones are appended on the same terms and sorted for the same reason.
 */
export function fingerprintRun(args: {
  playerId: string;
  planStart: number;
  currentTE: number;
  final: number;
  forceContinue: boolean;
  availability?: Availability | null;
  milestones?: Milestone[] | null;
  deferShifts?: boolean;
}): string {
  const parts = [args.playerId, args.planStart, args.currentTE, args.final, args.forceContinue ? 'fc' : 'auto'];
  const key = availabilityKey(args.availability);
  // `+shifts` only when a schedule is actually in force, so toggling it with no schedule set
  // cannot invalidate a checkpoint it could not have affected.
  if (key) parts.push(args.deferShifts ? `${key}+shifts` : key);
  const ms = milestonesKey(args.milestones);
  if (ms) parts.push(ms);
  return parts.join('|');
}

/**
 * Write a checkpoint, and NEVER let one go backwards.
 *
 * There is one checkpoint per fingerprint, so starting a second run on the same inputs used to
 * overwrite the first run's answer with its own starting point. Observed in the wild: a saved best
 * of `196 232 278 318 490` at 744.355 d was replaced by `195 226 277 317 490` at 752.975 d simply
 * because a new run began from the chain in the Target TE box. Eight and a half days of search,
 * silently discarded, while the 1172 priced chains that found it sat there in the same record.
 *
 * A checkpoint is a high-water mark, so this merges rather than replaces:
 *   - the better `bestChain` wins, and brings its own seconds and legs with it
 *   - `durations` are unioned, so priced chains are never lost either
 * `bestSeconds <= 0` means "no result yet" and can never win.
 */
export async function saveCheckpoint(partitionHash: string, record: SearchCheckpoint): Promise<void> {
  let merged = record;
  try {
    const prior = (await loadMetadata(partitionHash, METADATA_KEY)) as SearchCheckpoint | null;
    if (prior && prior.version === RECORD_VERSION && prior.fingerprint === record.fingerprint) {
      const priorWins = prior.bestSeconds > 0 && (record.bestSeconds <= 0 || prior.bestSeconds < record.bestSeconds);

      const durations = new Map<string, number>(prior.durations);
      for (const [key, seconds] of record.durations) durations.set(key, seconds);

      merged = {
        ...record,
        // Kept from whichever record has one. A merge that dropped the space would quietly turn a
        // resumable checkpoint back into an unresumable one on the next periodic write.
        ...((record.space ?? prior.space) ? { space: record.space ?? prior.space } : {}),
        bestChain: priorWins ? [...prior.bestChain] : record.bestChain,
        bestSeconds: priorWins ? prior.bestSeconds : record.bestSeconds,
        bestLegs: priorWins ? prior.bestLegs : record.bestLegs,
        durations: [...durations.entries()],
        chainsDone: Math.max(prior.chainsDone, record.chainsDone),
        complete: prior.complete || record.complete,
      };
    }
  } catch {
    // A read failure must not stop the write. Losing the merge is survivable; losing the
    // checkpoint entirely is what this whole module exists to prevent.
  }
  await saveMetadata(partitionHash, METADATA_KEY, merged);
}

export async function loadCheckpoint(partitionHash: string, fingerprint: string): Promise<SearchCheckpoint | null> {
  const raw = (await loadMetadata(partitionHash, METADATA_KEY)) as SearchCheckpoint | null;
  if (!raw || raw.version !== RECORD_VERSION) return null;
  if (raw.fingerprint !== fingerprint) return null;
  return raw;
}

export async function clearCheckpoint(partitionHash: string): Promise<void> {
  await saveMetadata(partitionHash, METADATA_KEY, null);
}

/** Build the record to persist. `entries` is the driver's whole cache; legs are dropped for
 *  everything except the best chain (see the module comment). */
export function buildCheckpoint(args: {
  fingerprint: string;
  effort: EffortTier;
  seedChain: number[];
  bestChain: number[];
  bestSeconds: number;
  entries: CacheEntry[];
  stage: string;
  detail: string;
  chainsDone: number;
  complete?: boolean;
  space?: SearchSpace | null;
}): SearchCheckpoint {
  const bestKey = args.bestChain.join(',');
  return {
    version: RECORD_VERSION,
    fingerprint: args.fingerprint,
    effort: args.effort,
    seedChain: [...args.seedChain],
    bestChain: [...args.bestChain],
    bestSeconds: args.bestSeconds,
    bestLegs: args.entries.find(e => e.key === bestKey)?.legs ?? [],
    durations: args.entries.map(e => [e.key, e.seconds] as [string, number]),
    stage: args.stage,
    detail: args.detail,
    chainsDone: args.chainsDone,
    complete: args.complete ?? false,
    updatedAt: Date.now(),
    ...(args.space ? { space: args.space } : {}),
  };
}

/** Turn a checkpoint's flat `durations` back into driver cache entries. Legs come back empty for
 *  every chain but the best one, which is all the driver needs — it only reads `legs` for the chain
 *  it finally returns, and any chain it re-visits it will simply find already priced. */
export function restoreEntries(record: SearchCheckpoint): CacheEntry[] {
  const bestKey = record.bestChain.join(',');
  return record.durations.map(([key, seconds]) => ({
    key,
    seconds,
    legs: key === bestKey ? record.bestLegs : [],
  }));
}
