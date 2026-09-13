/**
 * Turning a finished run into something safe to share with other players.
 *
 * WHITELIST, NOT A SCRUBBER. The obvious design is "take the CSV and strip the identifying
 * bits", and it is the wrong one: a blacklist is only as good as the last thing someone
 * remembered to add to it, and it fails silently and invisibly when a new field appears
 * upstream. This builds a fresh object containing exactly the fields named below and nothing
 * else, so a field added to the CSV tomorrow cannot leak by default — it simply is not copied.
 *
 * WHAT IS NOT IN HERE, and was never in the CSV either: the player id. `buildChainsCsv` has no
 * `playerId` in its metadata and never printed one, so "strip the EID" is already true by
 * construction. `scrubIdentifiers` exists anyway, for the one path where a player pastes a file
 * from somewhere else — belt and braces on a door that is already shut.
 *
 * WHAT IS STILL IDENTIFYING, stated plainly because the consent has to be informed:
 *
 *   - The ARTIFACT INVENTORY is close to a fingerprint. Ten thousand items with exact counts
 *     is not anonymous among people who know each other. It is included because a chain's
 *     duration is meaningless without knowing what it was simulated with — a 740-day plan on a
 *     full T4L set is a different claim from the same plan on commons — so the trade is real and
 *     the UI says so before the button is pressed.
 *   - The TIMEZONE and the local plan start put the player in a region and a rough daily rhythm.
 *   - The AVAILABILITY WINDOW says when they are awake.
 *
 * The nickname is optional and free text; nothing is derived from the account.
 */
import type { InventoryCount } from './csv';
import type { Availability } from './availability';
import { describeAvailability } from './availability';
import type { LegSummary } from './types';

/** Bumped when the shape changes, so a collector can reject or migrate old submissions rather
 *  than mis-reading them. Receivers should refuse anything they do not recognise. */
export const SUBMISSION_SCHEMA = 1;

/**
 * The artifact families a virtue ascension can actually equip.
 *
 * A full inventory is ten thousand items, most of them irrelevant: nobody's delivery rate turns
 * on how many T1 Aurelian brooches they are sitting on. Sharing the lot is both noise and a
 * sharper fingerprint than sharing the eight families that matter, so only these are sent.
 *
 * Derived from the two sets the simulator actually builds (`getOptimalELRSet` and
 * `getOptimalEarningsSet`, see search/leg.ts): metronome, compass, gusset and chalice on the
 * delivery side; necklace, cube, totem and ankh on the earnings side. Stones are kept wholesale
 * because they slot into all of the above.
 *
 * `the-chalice` is on this list although it was not in the original request for it. It carries
 * +40% internal hatchery rate and appears in the delivery set on the account this was specified
 * from, so dropping it would have removed a real input rather than noise.
 *
 * `ornate-gusset` is the game data's family id for the T1 gusset while `gusset` covers T2-T4 —
 * a quirk of the source data, not two different artifacts. Both are listed so a T1 is not
 * silently dropped.
 */
export const VIRTUE_ARTIFACT_FAMILIES: ReadonlySet<string> = new Set([
  'quantum-metronome',
  'interstellar-compass',
  'gusset',
  'ornate-gusset',
  'the-chalice',
  'demeters-necklace',
  'puzzle-cube',
  'lunar-totem',
  'tungsten-ankh',
]);

/**
 * Keep only what a virtue ascension can wear.
 *
 * Falls back to matching the human label when `familyId` is absent, because an inventory parsed
 * by an older build carries no family and silently dropping everything would look like an empty
 * inventory rather than a missing field.
 */
export function keepVirtueArtifacts(items: InventoryCount[]): InventoryCount[] {
  return items.filter(a => {
    if (a.familyId) return VIRTUE_ARTIFACT_FAMILIES.has(a.familyId);
    const l = a.label.toLowerCase();
    return (
      l.includes('metronome') ||
      l.includes('compass') ||
      l.includes('gusset') ||
      l.includes('chalice') ||
      l.includes('necklace') ||
      l.includes('puzzle cube') ||
      l.includes('lunar totem') ||
      l.includes('tungsten ankh')
    );
  });
}

export interface SubmissionLeg {
  /** Target TE this leg reaches. */
  te: number;
  /** Which sale strategy the simulator picked, e.g. `2-sale-tier13`. */
  strategy: string;
  days: number;
  /** Peak delivery rate in q/hr, the number that caps how fast the leg's last stretch earns. */
  peakDeliveryQph: number;
}

export interface Submission {
  schema: number;
  /** Free text, optional, supplied by the player. Never derived from the account. */
  nickname?: string;

  chain: number[];
  ascensions: number;
  durationDays: number;
  /** Local wall-clock, in `timezone`. Absolute instants are deliberately not included: a unix
   *  timestamp plus a duration is a sharper fingerprint than a date and buys a leaderboard
   *  nothing. */
  startLocal: string;
  endLocal: string;
  timezone: string;

  currentTE: number;
  finalTE: number;

  effort: string;
  /** Human-readable window, or null when the run was unconstrained. */
  window: string | null;
  holdShifts: boolean;
  /** Total time the plan spends waiting for the player: prestiges held plus shifts held. */
  waitingHours: number | null;

  artifacts: InventoryCount[];
  stones: InventoryCount[];

  legs: SubmissionLeg[];
  chainsPriced: number;
  submittedAt: string;
}

/**
 * Remove anything shaped like an Egg Inc player id from free text.
 *
 * Not load-bearing for our own submissions — the CSV never carried one — but a player pasting
 * someone else's file, or a nickname typed carelessly, should not become an account handout.
 * An id is a bearer token: the API will return the whole save to anyone holding it.
 */
export function scrubIdentifiers(text: string): string {
  return text.replace(/EI\d{16}/g, 'EI[redacted]');
}

/** `2026-09-09 19:04` in `timezone`, or '' for a missing instant. Never `1970-01-01`. */
function localStamp(unixSeconds: number, timezone: string): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

export interface SubmissionInputs {
  nickname?: string;
  chain: number[];
  seconds: number;
  legs: LegSummary[];
  planStart: number;
  timezone: string;
  currentTE: number;
  finalTE: number;
  effort: string;
  availability: Availability | null;
  holdShifts: boolean;
  artifacts: InventoryCount[];
  stones: InventoryCount[];
  chainsPriced: number;
  /** Injectable so tests are not clock-dependent. */
  now?: number;
}

export function buildSubmission(i: SubmissionInputs): Submission {
  const tz = i.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Null, not zero, when no legs were kept: a chain replayed from a checkpoint has an UNKNOWN
  // waiting cost, and publishing "0" would be a claim nobody measured.
  const waiting = i.legs.length
    ? i.legs.reduce((n, l) => n + (l.sleepDelaySeconds ?? 0) + (l.shiftDelaySeconds ?? 0), 0) / 3600
    : null;

  const nickname = i.nickname?.trim() ? scrubIdentifiers(i.nickname.trim()).slice(0, 40) : undefined;

  return {
    schema: SUBMISSION_SCHEMA,
    ...(nickname ? { nickname } : {}),
    chain: [...i.chain],
    ascensions: i.chain.length,
    durationDays: Number((i.seconds / 86400).toFixed(4)),
    startLocal: localStamp(i.planStart, tz),
    endLocal: localStamp(i.planStart + i.seconds, tz),
    timezone: tz,
    currentTE: i.currentTE,
    finalTE: i.finalTE,
    effort: i.effort,
    window: i.availability ? describeAvailability(i.availability) : null,
    holdShifts: i.holdShifts,
    waitingHours: waiting === null ? null : Number(waiting.toFixed(2)),
    // Stones are kept wholesale -- they slot into every family above -- while artifacts are
    // narrowed to what a virtue ascension can equip. See VIRTUE_ARTIFACT_FAMILIES.
    artifacts: keepVirtueArtifacts(i.artifacts).map(a => ({ label: a.label, count: a.count })),
    stones: i.stones.map(a => ({ label: a.label, count: a.count })),
    legs: i.legs.map(l => ({
      te: l.endTE,
      strategy: l.key,
      days: Number((l.durationSeconds / 86400).toFixed(3)),
      peakDeliveryQph: Number(((l.maxELR * 3600) / 1e15).toFixed(3)),
    })),
    chainsPriced: i.chainsPriced,
    submittedAt: new Date(i.now ?? Date.now()).toISOString(),
  };
}

/** Suggested filename for the offline path. Dated so two submissions do not collide. */
export function submissionFilename(s: Submission): string {
  const stamp = s.submittedAt.slice(0, 16).replace(/[:T]/g, '-');
  return `chain-submission-${s.finalTE}te-${stamp}.json`;
}

/**
 * Everything a receiving collector needs to validate a submission before storing it.
 *
 * Exported so the Worker and the app agree on the rules rather than each inventing their own.
 * Returns the problems; an empty array means acceptable.
 */
export function validateSubmission(value: unknown): string[] {
  const problems: string[] = [];
  const s = value as Partial<Submission> | null;
  if (!s || typeof s !== 'object') return ['not an object'];
  if (s.schema !== SUBMISSION_SCHEMA) problems.push(`unknown schema ${String(s.schema)}`);
  if (!Array.isArray(s.chain) || s.chain.length < 2) problems.push('chain must have at least two entries');
  else {
    if (!s.chain.every(v => Number.isInteger(v) && v > 0)) problems.push('chain must be positive integers');
    if (!s.chain.every((v, k) => k === 0 || v > s.chain![k - 1])) problems.push('chain must strictly increase');
  }
  if (typeof s.durationDays !== 'number' || !(s.durationDays > 0)) problems.push('durationDays must be positive');
  if (typeof s.finalTE !== 'number' || !(s.finalTE > 0)) problems.push('finalTE must be positive');
  if (s.nickname !== undefined && (typeof s.nickname !== 'string' || s.nickname.length > 40)) {
    problems.push('nickname must be a string of at most 40 characters');
  }
  if (typeof JSON.stringify(s) === 'string' && JSON.stringify(s).length > 200_000) {
    problems.push('submission is implausibly large');
  }
  return problems;
}
