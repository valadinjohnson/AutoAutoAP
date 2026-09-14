/**
 * @module planStartTime
 * @description Decides what instant an Auto-AP plan should start from.
 *
 * The farm a plan is built on is copied out of the backup verbatim (`initialState.currentFarmState`)
 * and is never advanced, so it describes one specific moment: `Backup.approx_time`, the figure the
 * page header shows as "Player Backup From". The plan's start time is a separate input, and when
 * the two disagree the simulator is being asked to run a farm from one instant against a clock from
 * another.
 *
 * That gap is not cosmetic. Every leg is timed from the end of the leg before it, so an error in
 * the first start time is carried through the whole chain, and it moves legs across Research Sale
 * boundaries, which is the structure the whole search depends on (see FOR_MATH_NERDS.md). Hence:
 * default the start to the backup's own timestamp.
 *
 * Pure and separate from the component so the cases below can be tested directly; the component
 * only converts between these numbers and the date/time input strings.
 */

export interface PlanStartInput {
  /** `Backup.approx_time` in unix seconds, or null when no backup is loaded yet. */
  backupSeconds: number | null;
  /** What the form currently resolves to in unix seconds, or null when either field is empty. */
  currentSeconds: number | null;
  /** Wall clock in unix seconds. Only used when there is no backup to sync to. */
  nowSeconds: number;
}

/**
 * The instant the start fields should be set to, or `null` to leave whatever is there alone.
 *
 * - Empty form: the backup's timestamp, falling back to now when no backup is loaded.
 * - Start before the backup: replaced. This asks the simulator to begin before the state it is
 *   starting from existed, and it is what a stale cached form from a previous visit produces.
 * - Start after the backup: left alone. "I will begin this plan tomorrow morning" is a legitimate
 *   thing to ask for, and the UI warns about the drift rather than overriding the choice.
 * - No backup at all: left alone, since there is nothing better to sync to.
 */
export function resolvePlanStart({ backupSeconds, currentSeconds, nowSeconds }: PlanStartInput): number | null {
  const backup = isUsableTimestamp(backupSeconds) ? backupSeconds : null;

  if (currentSeconds === null || !Number.isFinite(currentSeconds)) {
    return backup ?? nowSeconds;
  }
  if (backup === null) return null;
  return currentSeconds < backup ? backup : null;
}

/** Guards against the zero/negative/NaN that a backup missing `approx_time` decodes to. */
function isUsableTimestamp(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * How far the chosen start sits from the backup, for the note under the Start Time fields.
 * Returns null when there is nothing meaningful to compare.
 */
export function planStartDrift(backupSeconds: number | null, currentSeconds: number | null): number | null {
  if (!isUsableTimestamp(backupSeconds)) return null;
  if (currentSeconds === null || !Number.isFinite(currentSeconds)) return null;
  return (currentSeconds - backupSeconds) / 3600;
}

/** `45m`, `6h`, `3d`. Coarse on purpose: this is a nudge, not a readout. */
export function formatDriftHours(hours: number): string {
  const abs = Math.abs(hours);
  if (abs < 1) return `${Math.round(abs * 60)}m`;
  if (abs < 48) return `${Math.round(abs)}h`;
  return `${Math.round(abs / 24)}d`;
}

/** Below this, the start and the backup are treated as the same instant. */
export const DRIFT_TOLERANCE_HOURS = 0.5;
