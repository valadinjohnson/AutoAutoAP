/**
 * When the player is actually available to act, and what the search does about it.
 *
 * This replaces the narrower "excluded hours" window. Sleep is one case of a schedule — "available
 * 07:00-23:00, every day" — and a weekly calendar covers the rest: weekends only, evenings on
 * weekdays, no Wednesdays. Keeping two overlapping concepts would have meant two fingerprints, two
 * sets of CLI flags and two chances to disagree, so there is one model and sleep is a preset of it.
 *
 * WHAT THIS MODELS, PRECISELY. Every leg ends the instant its target TE is reached, and the very
 * next thing the plan asks for is a prestige — you cannot start the next ascension without it. The
 * simulator assumes that happens immediately. If a leg's target lands at 03:14 and you are asleep,
 * it does not; you prestige when you are next available, and everything downstream shifts. So a
 * constrained run moves each inter-leg handoff to the next available instant and charges the delay,
 * which then changes which weekly Research Sale boundary the next build phase lands on — which is
 * exactly why this has to be inside the objective the search minimises rather than a note printed
 * afterwards.
 *
 * WHAT IT DOES NOT MODEL, and this matters more than the part it does:
 *
 *   - Only the PRESTIGE instants are constrained. A build phase is hours or days of research
 *     buying, and the twelve shifts inside an ascension are scheduled by the simulator's own
 *     `te-wait` logic, so some of both will still fall outside your hours whatever the checkpoints
 *     are. `nightShifts` on each leg summary counts the shifts that do, so a plan cannot quietly
 *     claim to fit your schedule when it does not.
 *
 *   - The final leg is NOT pushed. Reaching the final target is not an action; there is nothing to
 *     do at that instant, so being unavailable for it costs nothing.
 *
 *   - The delay is charged in full, and the TE you keep earning while away is NOT credited. Once
 *     the target is hit the farm goes on laying, so in real life you come back slightly past the
 *     checkpoint and the next leg is slightly shorter. The model is therefore CONSERVATIVE: a plan
 *     built with a schedule will, if anything, run marginally faster than it says.
 *
 * Setting a schedule changes what "best" means, so it is part of the run fingerprint (see
 * persistence.ts) and there is none by default. Chains scored with and without one are not
 * comparable, and every accuracy figure on record was measured without one.
 */
import { getTimezoneOffsetAt } from '@/lib/events';

export interface Availability {
  /** Days the player can act, 0 = Sunday .. 6 = Saturday. Empty means every day. */
  days: number[];
  /** Available hours, `[fromHour, toHour)`. Wraps, so 18 -> 2 is "evenings into the night".
   *  `fromHour === toHour` means the whole day is available. */
  fromHour: number;
  toHour: number;
  /** IANA zone the hours and days are read in. The plan's own timezone, not the browser's. */
  timezone: string;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function validDays(a: Availability): number[] {
  return a.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
}

/**
 * True when this schedule actually rules anything out.
 *
 * Every day plus every hour is not a constraint, it is the default, and treating it as one would
 * mean a fingerprint change and a pointless push loop for a setting that excludes nothing.
 */
export function isConstrained(a: Availability | null | undefined): a is Availability {
  if (!a) return false;
  const { fromHour: f, toHour: t } = a;
  if (!Number.isInteger(f) || !Number.isInteger(t)) return false;
  if (f < 0 || f > 23 || t < 0 || t > 23) return false;
  const days = validDays(a);
  const allDays = days.length === 0 || days.length === 7;
  const allHours = f === t;
  return !(allDays && allHours);
}

/** Local hour-of-day, 0-23. One Intl call via `getTimezoneOffsetAt`, which is DST-exact — the
 *  offset is resolved AT that instant rather than assumed constant. */
export function localHour(unixSeconds: number, timezone: string): number {
  const wall = unixSeconds + getTimezoneOffsetAt(timezone, unixSeconds);
  return Math.floor((((wall % 86400) + 86400) % 86400) / 3600);
}

/** Local day of week, 0 = Sunday. 1970-01-01 was a Thursday, hence the +4. */
export function localDayOfWeek(unixSeconds: number, timezone: string): number {
  const wall = unixSeconds + getTimezoneOffsetAt(timezone, unixSeconds);
  return ((Math.floor(wall / 86400) % 7) + 4 + 7) % 7;
}

/**
 * Is this instant inside the schedule?
 *
 * The day test uses the day the SESSION started, not the calendar day. With a window of 18:00-02:00
 * on Friday, 01:00 on Saturday morning is still Friday night — testing Saturday would reject the
 * back half of every session the user explicitly asked for.
 */
export function isAvailable(unixSeconds: number, a: Availability): boolean {
  const h = localHour(unixSeconds, a.timezone);
  const wraps = a.fromHour > a.toHour;
  const allHours = a.fromHour === a.toHour;

  if (!allHours) {
    const inHours = wraps ? h >= a.fromHour || h < a.toHour : h >= a.fromHour && h < a.toHour;
    if (!inHours) return false;
  }

  const days = validDays(a);
  if (!days.length || days.length === 7) return true;

  const sessionStart = wraps && h < a.toHour ? unixSeconds - 86400 : unixSeconds;
  return days.includes(localDayOfWeek(sessionStart, a.timezone));
}

/**
 * The next instant strictly after `t` whose local time is exactly `hour:00`.
 *
 * Deliberately NOT `getNextTimeInTimezone` from lib/events. That helper resolves the zone offset at
 * its own GUESSED UTC instant, so on a spring-forward day it lands an hour late: asking for 07:00 on
 * 2027-03-14 in America/Denver returns 08:00 MDT, because the offset is read at 07:00 UTC, still MST
 * and before the 02:00 transition. Harmless where it is used today (whole-hour plan starts a user
 * typed), wrong here, where the result is the thing being minimised.
 */
function nextLocalHour(t: number, hour: number, tz: string): number {
  const wall = t + getTimezoneOffsetAt(tz, t);
  const intoDay = ((wall % 86400) + 86400) % 86400;
  let delta = hour * 3600 - intoDay;
  // Strictly after: standing exactly on the target means the NEXT one is tomorrow's.
  if (delta <= 0) delta += 86400;
  let out = t + delta;

  // Correct for a transition crossed on the way. Offsets move by an hour (45 minutes in a couple of
  // zones), so two rounds is ample; the third is insurance, not a real case.
  for (let i = 0; i < 3; i++) {
    const h = localHour(out, tz);
    if (h === hour) break;
    let diff = hour - h;
    if (diff > 12) diff -= 24;
    if (diff < -12) diff += 24;
    out += diff * 3600;
  }
  return out > t ? out : t + 3600;
}

/**
 * The earliest instant at or after `unixSeconds` that the player is available.
 *
 * Returns its input unchanged when that is already available, so callers can apply it
 * unconditionally.
 */
export function nextAvailable(unixSeconds: number, a: Availability): number {
  if (!isConstrained(a) || isAvailable(unixSeconds, a)) return unixSeconds;

  // Every session begins at `fromHour`, so those are the only candidate instants. Fourteen covers
  // a fortnight, which is more than enough for any weekly pattern that has any available day at
  // all; a pattern with none would loop forever without the bound.
  let c = unixSeconds;
  for (let i = 0; i < 14; i++) {
    c = nextLocalHour(c, a.fromHour, a.timezone);
    if (isAvailable(c, a)) return c;
  }
  // Give up rather than spin. A caller that gets its input back is no worse off than one with no
  // schedule at all, which is strictly better than a hung search.
  return unixSeconds;
}

/** How many of `timestamps` fall OUTSIDE the schedule. Used to report the part a schedule cannot
 *  fix: the twelve shifts inside an ascension, which the simulator places and this does not move. */
export function countUnavailable(timestamps: number[], a: Availability | null | undefined): number {
  if (!isConstrained(a)) return 0;
  let n = 0;
  for (const t of timestamps) if (!isAvailable(t, a)) n++;
  return n;
}

/** `Mon-Fri 18:00-23:00 America/Denver` — for logs, CSV headers and the panel. */
export function describeAvailability(a: Availability | null | undefined): string {
  if (!isConstrained(a)) return 'any time';
  const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const days = validDays(a).sort((x, y) => x - y);
  const dayText = !days.length || days.length === 7 ? 'every day' : days.map(d => DAY_NAMES[d]).join(',');
  const hourText = a.fromHour === a.toHour ? 'all day' : `${pad(a.fromHour)}-${pad(a.toHour)}`;
  return `${dayText} ${hourText} ${a.timezone}`;
}

/** Stable, order-independent key for the run fingerprint. Reordering the day checkboxes must not
 *  invalidate a checkpoint. */
export function availabilityKey(a: Availability | null | undefined): string {
  if (!isConstrained(a)) return '';
  const days = validDays(a).sort((x, y) => x - y);
  return `avail${days.join('') || 'all'}-${a.fromHour}-${a.toHour}@${a.timezone}`;
}

/** The sleep preset: available every day between waking and bedtime. */
export function fromSleepHours(sleepFrom: number, sleepUntil: number, timezone: string): Availability {
  return { days: [], fromHour: sleepUntil, toHour: sleepFrom, timezone };
}
