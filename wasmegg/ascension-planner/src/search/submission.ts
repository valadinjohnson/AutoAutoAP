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
import type { InventoryCount, LoadoutSlot } from './csv';
import type { Availability } from './availability';
import { describeAvailability } from './availability';
import type { LegSummary } from './types';

/** Bumped when the shape changes, so a collector can reject or migrate old submissions rather
 *  than mis-reading them. Receivers should refuse anything they do not recognise.
 *
 *  2: `artifacts` became a list of labels, best-per-family, instead of `{label, count}` for every
 *     tier owned. The Worker must be redeployed with the matching SCHEMA at the same time -- it
 *     refuses a schema it does not know, so an app shipped ahead of the collector submits
 *     nothing. */
export const SUBMISSION_SCHEMA = 3;

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
/**
 * The stones a virtue ascension actually socket.
 *
 * The other seven families -- life, shell, terra, dilithium, clarity, prophecy, soul -- do exist
 * in the virtue inventory and were being reported wholesale, which was a long list saying nothing:
 * none of them appear in either set the simulator builds. Tachyon and quantum drive the delivery
 * side, lunar the earnings side, and those are what a reader needs to judge whether a duration was
 * reachable on their own account.
 */
export const VIRTUE_STONE_FAMILIES: ReadonlySet<string> = new Set(['tachyon-stone', 'quantum-stone', 'lunar-stone']);

/** Keep only the stones above; falls back to the label when a family did not resolve, the same
 *  way `keepVirtueArtifacts` does and for the same reason. */
export function keepVirtueStones(items: InventoryCount[]): InventoryCount[] {
  return items.filter(s => {
    if (s.familyId) return VIRTUE_STONE_FAMILIES.has(s.familyId);
    const l = s.label.toLowerCase();
    return l.includes('tachyon') || l.includes('quantum') || l.includes('lunar');
  });
}

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

/**
 * The best piece the player owns in each family, and nothing else.
 *
 * A real inventory is a long tail of junk: the account this was built against holds 732 T1C
 * Demeters necklaces and exactly one T4L, and the simulator wears the T4L. Reporting all ninety
 * entries with exact counts described the hoard rather than the loadout, and a hoard with exact
 * counts is a much sharper fingerprint than the eight lines that actually determined the answer.
 *
 * Best means highest tier, then highest rarity -- decided on `tier`/`rarity` carried through from
 * the game data, not by parsing "T4L" back out of the label, which would quietly rank "T4L" under
 * "T4R" on a string compare.
 *
 * Counts are dropped here and kept for stones, which is not an inconsistency: an artifact slot
 * takes one artifact, so owning six changes nothing, while stones are consumed three at a time
 * per piece and how many you hold decides what can actually be socketed.
 */
/**
 * Families the game data splits in two that are really one artifact.
 *
 * `ornate-gusset` is the T1 gusset and `gusset` covers T2-T4 -- a quirk of the source data, not
 * two different items. Keying on the raw family id therefore gave every account a spurious second
 * gusset: "T1C Gusset" surviving alongside "T4L Gusset", because they were separate buckets. The
 * simulator has never treated them as different, so neither should this.
 */
const FAMILY_ALIASES: Record<string, string> = {
  'ornate-gusset': 'gusset',
};

export function bestPerFamily(items: InventoryCount[]): InventoryCount[] {
  const best = new Map<string, InventoryCount>();
  for (const item of items) {
    // No family means the game data did not resolve it; key on the label so it is kept rather
    // than silently collapsing every unresolved piece into one bucket.
    const raw = item.familyId ?? item.label;
    const key = FAMILY_ALIASES[raw] ?? raw;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, item);
      continue;
    }
    const rank = (x: InventoryCount) => (x.tier ?? 0) * 10 + (x.rarity ?? 0);
    if (rank(item) > rank(cur)) best.set(key, item);
  }
  return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
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

  /**
   * The two sets the simulator actually wears, per slot, with the stones in each.
   *
   * More informative than the inventory and harder to misread. A virtue DELIVERY set uses its
   * fourth slot as a stone holder, so the solver picks a T3 legendary ankh over a T4 epic
   * chalice -- more sockets beats a better base effect -- and without seeing the stones in it,
   * that choice looks like a bug. The EARNINGS set does not depend on research, so it is the
   * same in every leg; the delivery set is leg 1's and later legs re-solve.
   *
   * Optional: a submission from an older build, or one whose backup could not be read, simply
   * has no loadouts rather than a wrong one.
   */
  delivery?: LoadoutSlot[];
  earnings?: LoadoutSlot[];

  /** Labels only, best per family. An artifact slot takes one artifact, so the count never
   *  mattered; see `bestPerFamily`. */
  artifacts: string[];
  /** Counted, because how many you hold decides what can be socketed. */
  stones: InventoryCount[];

  legs: SubmissionLeg[];
  chainsPriced: number;

  /**
   * What the run cost the machine that did it. Additive in schema 3.
   *
   * The panel's own time estimate is carried from one 20-core desktop ("~1 h 05 m on a 20-core
   * desktop at 12 jobs") and scaled by nothing, so it is wrong for everyone else and known to be.
   * Three numbers fix that, but only in aggregate: with enough submissions the board can fit
   * seconds-per-chain against worker count and stop quoting one machine's stopwatch at everybody.
   *
   * All optional. A submission from an older build, or one resumed from a checkpoint where the
   * elapsed time is not the time it took, simply has none rather than a misleading figure.
   */
  run?: RunCost;

  submittedAt: string;
}

/** The cost side of a run, for calibrating the panel's estimates against real machines. */
export interface RunCost {
  /** Background workers the pool actually used. The tunable that matters most. */
  workers: number;
  /** Logical cores the browser reported, so workers can be read as a fraction of the machine. */
  cores: number | null;
  /** Wall-clock minutes of searching, excluding time the tab spent frozen. */
  minutes: number;
  /**
   * Seconds of wall clock per chain priced. Derivable from the two above, but recorded because the
   * run measures it directly and a resumed run's replayed chains would otherwise skew the ratio.
   */
  secondsPerChain: number;
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
  /** Solved sets, already reduced to words by `describeLoadoutSlots`. */
  delivery?: LoadoutSlot[];
  earnings?: LoadoutSlot[];
  chainsPriced: number;
  /** Omitted when the run's cost is not known, e.g. a result replayed from a checkpoint. */
  run?: RunCost;
  /** Injectable so tests are not clock-dependent. */
  now?: number;
}

/** Rounded before it leaves the browser: the extra precision is noise and a sharper fingerprint. */
function roundRunCost(r: RunCost): RunCost {
  return {
    workers: Math.max(0, Math.round(r.workers)),
    cores: r.cores === null || !Number.isFinite(r.cores) ? null : Math.max(0, Math.round(r.cores)),
    minutes: Number(r.minutes.toFixed(1)),
    secondsPerChain: Number(r.secondsPerChain.toFixed(2)),
  };
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
    ...(i.delivery?.length ? { delivery: i.delivery } : {}),
    ...(i.earnings?.length ? { earnings: i.earnings } : {}),
    artifacts: bestPerFamily(keepVirtueArtifacts(i.artifacts)).map(a => a.label),
    stones: keepVirtueStones(i.stones).map(a => ({ label: a.label, count: a.count })),
    legs: i.legs.map(l => ({
      te: l.endTE,
      strategy: l.key,
      days: Number((l.durationSeconds / 86400).toFixed(3)),
      peakDeliveryQph: Number(((l.maxELR * 3600) / 1e15).toFixed(3)),
    })),
    chainsPriced: i.chainsPriced,
    // Spread so an absent run cost leaves the key off entirely. `run: undefined` would serialise
    // to nothing anyway, but the collector distinguishes "absent" from "present and empty".
    ...(i.run ? { run: roundRunCost(i.run) } : {}),
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
