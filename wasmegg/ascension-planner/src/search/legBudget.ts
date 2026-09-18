/**
 * The run's memory budget, as a rule about what to keep rather than a number of bytes.
 *
 * A browser gives a page no way to reserve or cap memory, so "how much memory should this use" can
 * only be answered as "how much should it choose to hold". A priced chain is two things: its answer
 * (a key and a duration, tens of bytes) and its per-leg detail (`legs`, each carrying its twelve
 * shifts as objects, kilobytes). An exhaustive run prices hundreds of thousands of chains, so the
 * detail is the entire memory question and the answers are a rounding error.
 *
 * THE CHECKPOINT ALREADY WORKS THIS WAY. `buildCheckpoint` persists `durations` for every chain and
 * `bestLegs` for one; `restoreEntries` brings the rest back with `legs: []`. Leg-less entries are a
 * shape this codebase already produces, resumes from and renders -- the CSV prints blank per-leg
 * cells and says why. This applies the same rule to the in-memory cache, which was the one place
 * keeping everything.
 *
 * Lives here, pure and tested, rather than inside the store: it is the one piece of the memory
 * story that can be wrong in a way nobody would notice until a run was already lost.
 */
import type { CacheEntry } from './driver';

/** A duration that has not been measured yet. Shared with `pickShortlist`, which guards the same
 *  way and for the same reason: zero is "not priced", not "instant". */
const isPriced = (e: CacheEntry): boolean => e.seconds > 0;

export interface LegBudgetResult {
  /** Entries still holding detail after the pass. */
  held: number;
  /** Entries whose detail this pass dropped. */
  dropped: number;
}

/**
 * Drop per-leg detail past `budget`, keeping the FASTEST chains.
 *
 * Fastest rather than newest, because the kept set exists to be looked at: the runners-up table
 * shows the chains nearest the winner, so those are the ones whose detail anybody opens. Keeping
 * the most recent instead would hold detail for whatever the search happened to be scanning when
 * the budget filled, which is nothing in particular.
 *
 * MUTATES IN PLACE, and callers depend on it: the store hands this its live caches while a run is
 * writing to them, and rebuilding the arrays would race the writer. Reassigning `e.legs` also
 * leaves any array another reference already points at alive -- `bestLegs` holds exactly such a
 * reference, though the winner is never a pruning candidate since it heads the kept set.
 *
 * `budget <= 0` means keep everything, which is a real choice on a machine with room and a short
 * run. It is not the default; see DEFAULT_LEG_DETAIL_BUDGET.
 */
export function applyLegBudget(entries: CacheEntry[], budget: number): LegBudgetResult {
  const held: CacheEntry[] = [];
  for (const e of entries) if (e.legs.length) held.push(e);
  if (budget <= 0 || held.length <= budget) return { held: held.length, dropped: 0 };

  // Unpriced entries sort last: they are not candidates for the fastest set, and letting a zero
  // sort to the front would evict real answers in favour of placeholders.
  held.sort((a, b) => (isPriced(a) ? a.seconds : Infinity) - (isPriced(b) ? b.seconds : Infinity));
  for (let i = budget; i < held.length; i++) held[i].legs = [];
  return { held: budget, dropped: held.length - budget };
}

/**
 * A measured estimate of what the kept detail costs, in bytes.
 *
 * SAMPLED FROM ONE ENTRY, not summed. This is a readout for a panel, and walking the whole cache to
 * stringify it would cost more than the memory it is reporting on -- on a large run, considerably
 * more. Legs are near-uniform in size (twelve shifts each, same fields), so one sample times the
 * count is the right order of magnitude, which is all a gauge needs to be.
 */
export function estimateLegBytes(entries: CacheEntry[], held: number): number {
  const sample = entries.find(e => e.legs.length);
  if (!sample || held <= 0) return 0;
  return JSON.stringify(sample.legs).length * held;
}
