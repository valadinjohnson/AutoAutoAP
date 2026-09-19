/**
 * @module health
 * @description Sanity checks on what a run was given and what it produced.
 *
 * WHY THIS EXISTS. An exhaustive run is hours of CPU against a farm state loaded once at the start.
 * If that state is wrong -- a backup that half-loaded, an inventory that came back empty, a
 * post-prestige state the simulator got wrong -- nothing fails. Every chain is priced consistently
 * against the same wrong world, the ranking between them is internally coherent, and the answer is
 * confidently three times too slow. The run looks exactly like a good one.
 *
 * Measured, from a real report: a six-ascension chain came back at 2,277 days where the same
 * account's official planner said 736. The first leg matched to three decimals (3.574 q/hr), and
 * the second collapsed to 0.320 q/hr for 817 days -- a tenth of the leg before it, on a farm that
 * had just gained 17 TE. Nothing in the UI said a word, because a search has no opinion about
 * whether its inputs are sane.
 *
 * So these are the opinions. They are deliberately CRUDE: every one of them is a statement about
 * the physics of the game rather than a threshold tuned to one account, because a threshold tuned
 * to one account is a false alarm on everybody else's.
 */
import type { LegSummary } from './types';
import type { InventoryCount, LoadoutSlot } from './csv';

export interface HealthIssue {
  /** Machine-readable, so the UI can style by kind rather than by matching prose. */
  kind:
    | 'no-backup'
    | 'no-artifacts'
    | 'no-delivery-set'
    | 'no-earnings-set'
    | 'no-farm-state'
    | 'no-epic-research'
    | 'te-mismatch'
    | 'rate-collapse'
    | 'slow-leg';
  /** `error` means the numbers are probably wrong. `warning` means look before you trust them. */
  level: 'error' | 'warning';
  message: string;
}

/**
 * Is the state the workers are about to be initialised with actually complete?
 *
 * SEPARATE FROM `reviewSetup`, AND THE DIFFERENCE IS THE WHOLE POINT. `reviewSetup` reads the
 * stores when the panel renders; this reads the object literally handed to the worker pool at the
 * moment a run starts. They are normally the same thing. They are not the same thing when a backup
 * is still loading, which is exactly when this goes wrong -- reported as "I clicked around quickly
 * and it broke", and consistent with every symptom:
 *
 *   - leg 1 is correct, because `continue` runs on `currentFarmState`, which loads early;
 *   - every later leg collapses to the same 0.320 q/hr and never unlocks tier 13, which is what a
 *     farm with NO EPIC RESEARCH looks like;
 *   - the CSV header and the pre-flight both look perfect, because both re-read the stores later,
 *     after loading has finished.
 *
 * So the diagnostics could not see it: they were reading a different, later, correct copy of the
 * state than the one the run was using.
 */
export function reviewContext(ctx: {
  hasBackup: boolean;
  epicResearchCount: number;
  hasFarmState: boolean;
}): HealthIssue[] {
  const issues: HealthIssue[] = [];
  if (!ctx.hasBackup) {
    issues.push({
      kind: 'no-backup',
      level: 'error',
      message: 'The backup had not finished loading when this run tried to start. Wait for it and start again.',
    });
    return issues;
  }
  if (!ctx.hasFarmState) {
    issues.push({
      kind: 'no-farm-state',
      level: 'error',
      message: 'The current farm had not finished loading when this run tried to start. Wait for it and start again.',
    });
  }
  // Zero is the tell. A real account has levels here even if none are maxed, and an empty map makes
  // every leg after the first simulate a farm with no epic research at all.
  if (ctx.epicResearchCount === 0) {
    issues.push({
      kind: 'no-epic-research',
      level: 'error',
      message:
        'No epic research had loaded when this run tried to start. Every ascension after the first would be simulated without it, which collapses their delivery rate and is the single biggest cause of a plan coming back two or three times too long.',
    });
  }
  return issues;
}

/** Peak delivery in q/hr, the unit the panel and the CSV both print. */
export const qph = (leg: LegSummary): number => (leg.maxELR * 3600) / 1e15;

/**
 * A leg slower than this is not necessarily wrong, but it is worth a second look.
 *
 * NOT APPLIED TO THE FINAL LEG, which is the one leg that is legitimately long: it carries the
 * plan from its last checkpoint all the way to the target, often several hundred days, and
 * flagging it every single time is how a warning becomes wallpaper. The reported failure was leg 2
 * of six at 817 days, which is the shape worth catching -- an early leg that should be short.
 */
export const SLOW_LEG_DAYS = 400;

/**
 * How far delivery may fall between consecutive legs before it is treated as a fault.
 *
 * THE INVARIANT: a later leg starts from strictly more TE than the one before it, on a farm that
 * has only gained research and artifacts, so its peak delivery rate should not be dramatically
 * worse. Small dips are ordinary -- a leg can pick a different sale strategy, and the peak depends
 * on where in the sale calendar it lands. An order of magnitude is not ordinary.
 *
 * Set at half rather than at something tighter for exactly that reason: this has to survive normal
 * strategy variation and only fire on the kind of collapse that means the state is wrong.
 */
export const COLLAPSE_RATIO = 0.5;

/**
 * Review a priced chain's legs for results that contradict the game.
 *
 * Reads only what a leg already records, so it costs nothing to run on every result and can be run
 * on a reloaded run whose legs came out of storage.
 */
export function reviewLegs(legs: LegSummary[]): HealthIssue[] {
  const issues: HealthIssue[] = [];
  legs.forEach((leg, i) => {
    const days = leg.durationSeconds / 86400;
    const isFinalLeg = i === legs.length - 1;
    if (!isFinalLeg && days > SLOW_LEG_DAYS) {
      issues.push({
        kind: 'slow-leg',
        level: 'warning',
        message: `Leg ${i + 1} (to ${leg.endTE} TE) takes ${days.toFixed(0)} days on its own. That is long enough to be worth checking rather than trusting.`,
      });
    }
    if (i === 0) return;
    const prev = qph(legs[i - 1]);
    const here = qph(leg);
    if (prev > 0 && here < prev * COLLAPSE_RATIO) {
      issues.push({
        kind: 'rate-collapse',
        level: 'error',
        message: `Leg ${i + 1} (to ${leg.endTE} TE) peaks at ${here.toFixed(3)} q/hr, down from ${prev.toFixed(3)} on the leg before it. Delivery should not fall as TE rises — this usually means the state the simulator carried into this leg is wrong, and every duration after it is too.`,
      });
    }
  });
  return issues;
}

export interface SetupInputs {
  hasBackup: boolean;
  artifacts: InventoryCount[];
  stones: InventoryCount[];
  delivery: LoadoutSlot[];
  earnings: LoadoutSlot[];
  /** The TE the search will start from: the sum of the action snapshot's per-virtue totals. */
  currentTE: number;
  /** The TE the loaded save itself reports, summed the same way from `initialTeEarned`. */
  backupTE: number;
}

/**
 * Below this the two TE figures are treated as agreeing.
 *
 * Not zero, because a plan legitimately in progress moves the snapshot by a virtue or two and
 * nobody needs telling about that. The failure this exists for was 22 TE.
 */
export const TE_MISMATCH_TOLERANCE = 3;

/**
 * Review what a run is ABOUT to be given, before hours are spent on it.
 *
 * Every one of these is silently survivable, which is the problem: the search runs happily against
 * an empty inventory and returns a confident answer for a farm nobody owns.
 */
export function reviewSetup(i: SetupInputs): HealthIssue[] {
  const issues: HealthIssue[] = [];
  if (!i.hasBackup) {
    issues.push({
      kind: 'no-backup',
      level: 'error',
      message: 'No backup is loaded, so there is no farm to simulate. Load your save before starting.',
    });
    // Everything below is downstream of the backup; repeating it would be four ways of saying this.
    return issues;
  }
  if (!i.artifacts.length) {
    issues.push({
      kind: 'no-artifacts',
      level: 'error',
      message:
        'The virtue artifact inventory came back empty. The simulator will run with nothing equipped, which makes every duration far too long.',
    });
  }
  if (!i.delivery.length) {
    issues.push({
      kind: 'no-delivery-set',
      level: 'error',
      message: 'No delivery set could be solved from your inventory. Delivery rate is what the whole plan is paced by.',
    });
  }
  if (!i.earnings.length) {
    issues.push({
      kind: 'no-earnings-set',
      level: 'warning',
      message: 'No earnings set could be solved from your inventory, so sale income will be understated.',
    });
  }

  // THE ONE THAT CAUGHT THE REPORTED FAILURE, and the reason it took so long to find: nothing about
  // it looks like a fault. The artifacts were right, the loadouts were right, leg 1 matched the
  // official planner to three decimals. The search was simply told it was starting 22 TE further
  // back than the save says, and a plan from 159 TE is about twice as long as the same plan from
  // 181 -- which the official planner reproduces exactly when given the same wrong figure.
  //
  // The two numbers come from different places. The search starts from the ACTION SNAPSHOT's TE,
  // which reflects any plan or action history currently loaded; the save reports its own per-virtue
  // totals. A stale plan left over from an earlier session makes them disagree, and only the
  // snapshot is visible in the result.
  if (Math.abs(i.currentTE - i.backupTE) > TE_MISMATCH_TOLERANCE) {
    issues.push({
      kind: 'te-mismatch',
      level: 'error',
      message: `This run will start from ${i.currentTE} TE, but your loaded save reports ${i.backupTE} TE. Starting from the wrong TE changes every duration in the plan — a run from ${Math.min(i.currentTE, i.backupTE)} TE is far longer than the same run from ${Math.max(i.currentTE, i.backupTE)}. If you are not deliberately planning from a point part-way through an existing plan, reset to today's defaults or reload your backup before starting.`,
    });
  }
  return issues;
}
