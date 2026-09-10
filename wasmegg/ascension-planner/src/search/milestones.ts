/**
 * Dated milestones: "be at 248 TE by the first of June".
 *
 * WHY TE AND A DATE, NOT "ASCENSION 3 BY A DATE". A per-ascension deadline sounds more natural and
 * is the wrong handle: the prestige-count probe adds and removes checkpoints, so "A3" silently
 * means a different TE before and after stage 7, and a constraint whose meaning changes mid-search
 * is not a constraint. A TE value is stable no matter how the chain is reshaped, and it is also
 * what a player actually cares about — the checkpoint number is an implementation detail of the
 * plan, the truth-egg count is the thing they are waiting for.
 *
 * A chain SATISFIES a milestone when some leg ends at or above that TE at or before the deadline.
 * Reaching a TE is not an action, so the raw leg end is the right instant even under an
 * availability schedule — you hit the number while asleep just the same, you simply cannot prestige
 * on it yet.
 *
 * HOW IT STEERS THE SEARCH. A chain that misses a milestone is dropped exactly the way a chain
 * whose simulation failed is dropped — `chain.ts` returns null and the driver already treats a
 * missing chain as "not a candidate", never as an error. That is deliberate: it means dated
 * milestones need no change at all to driver.ts, the one file in this search whose comments open
 * with "READ THIS BEFORE CHANGING ANY OF IT".
 *
 * The cost of that simplicity is the all-infeasible case: if nothing satisfies the milestones the
 * search has nothing to return and the caller sees no finite answer. The panel detects that and
 * says so, rather than rendering `Infinity d`.
 *
 * A MILESTONE ON THE FINAL TARGET IS ALMOST ALWAYS REDUNDANT, and it is worth knowing why before
 * adding one. The search already minimises total time, so the fastest chain is by construction the
 * one most likely to meet a deadline on the final target — if the optimum misses it, nothing else
 * makes it either. Such a milestone cannot improve the answer; it can only turn "here is the
 * earliest you can finish" into "no chain found", which is strictly less information. Intermediate
 * milestones are the ones that genuinely change which chain wins.
 */
import type { LegSummary } from './types';

/** The only two fields these functions read. Declared narrowly on purpose: the CLI harness keeps
 *  its own leg shape (`te`/`dur`), and an `as LegSummary` cast at that call site silently produced
 *  `endTE: undefined`, which read as "never reaches this TE" and rejected every chain. A structural
 *  type makes that a compile error instead. */
export type LegArrival = Pick<LegSummary, 'endTE' | 'endTime'>;

export interface Milestone {
  /** Truth eggs to have reached. Must be at or below the run's final target to be satisfiable. */
  te: number;
  /** Deadline, unix seconds. */
  by: number;
}

/** Only milestones that could ever be met: a positive TE at or below `final`, and a real date. */
export function usableMilestones(milestones: Milestone[] | null | undefined, final: number): Milestone[] {
  if (!milestones?.length) return [];
  return milestones.filter(m => Number.isFinite(m.te) && Number.isFinite(m.by) && m.te > 0 && m.te <= final && m.by > 0);
}

/** When this plan first reaches `te`, or undefined if it never does. Legs are in chain order and
 *  `endTE` is monotonic, so the first match is the earliest. */
export function reachedAt(legs: readonly LegArrival[], te: number): number | undefined {
  for (const leg of legs) if (leg.endTE >= te) return leg.endTime;
  return undefined;
}

/** The milestones this plan misses, in the order given. Empty means it meets them all. */
export function missedMilestones(legs: readonly LegArrival[], milestones: Milestone[]): Milestone[] {
  const missed: Milestone[] = [];
  for (const m of milestones) {
    const at = reachedAt(legs, m.te);
    // Never reaching the TE at all counts as missing it, not as vacuously satisfying it.
    if (at === undefined || at > m.by) missed.push(m);
  }
  return missed;
}

export function meetsAll(legs: readonly LegArrival[], milestones: Milestone[]): boolean {
  return missedMilestones(legs, milestones).length === 0;
}

/** Stable, order-independent key for the run fingerprint — milestones change every cached duration's
 *  admissibility, and reordering the rows must not invalidate a three-hour run. Empty when there are
 *  none, so an unconstrained run keeps the fingerprint it has always had. */
export function milestonesKey(milestones: Milestone[] | null | undefined): string {
  if (!milestones?.length) return '';
  return 'ms' + [...milestones].map(m => `${m.te}@${m.by}`).sort().join(',');
}
