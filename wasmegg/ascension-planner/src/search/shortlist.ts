/**
 * Runners-up: the best few ALTERNATIVES to the winning chain, chosen to be genuinely different
 * from each other so a player can pick on something other than raw speed.
 *
 * WHY THIS IS NOT JUST "TOP 10 BY DURATION". The cache is full of near-duplicates — a
 * coordinate-descent sweep prices `... 286 327 490` and `... 286 328 490` and `... 287 327 490`
 * within milliseconds of each other, so the ten fastest chains are routinely the same plan with one
 * checkpoint nudged by one TE. That is a useless menu. This picks for SPREAD instead: the leader,
 * then the best chain at each other prestige count, then whatever else differs from everything
 * already listed by more than a token amount.
 *
 * Prestige count is the axis that earns its own guaranteed row. It is the one difference a player
 * feels in real life rather than on a chart — each prestige is a full rebuild, twelve shifts and a
 * fresh research grind — so "half a day slower for one fewer rebuild" is a trade only they can
 * make. Measured on the alt's coarse scan: 8 prestiges came in 0.466 d ahead of 7 while hitting the
 * same delivery ceiling, which the ladder rule rejects automatically. This surfaces that same choice
 * at the end of a real run, with real numbers, instead of deciding it for them.
 *
 * WHAT IT IS NOT. These are the best alternatives AMONG THE CHAINS THIS RUN PRICED, and a search
 * visits its own neighbourhood — it is not a sample of the space. A chain absent from this list was
 * very likely never evaluated, not evaluated and beaten. The panel says so.
 */
import type { CacheEntry } from './driver';
import type { LegSummary } from './types';

export interface ShortlistRow {
  chain: number[];
  seconds: number;
  /** Seconds behind the fastest chain in the list. 0 for the leader. */
  gapSeconds: number;
  /** Chain length including the final target — one ascension each. */
  prestiges: number;
  /** Empty for a chain replayed from a checkpoint, which keeps legs for the best chain only. */
  legs: LegSummary[];
  /** Null — NOT zero — when there are no legs to count. Zero would read as "no night shifts". */
  nightShifts: number | null;
  /** Total time prestiges spend waiting for the excluded-hours window to close. Null as above. */
  prestigeWaitSeconds: number | null;
  /** Total time SHIFTS were held for the window. Null as above.
   *
   *  This is the column that makes the list comparable once shifts are being held. With holding
   *  on, `nightShifts` is zero for every row by construction — the cost moved out of the count
   *  and into the duration — so a "night shifts" column reads 0, 0, 0, 0 and distinguishes
   *  nothing. What differs between options is how much each one PAYS to fit your hours, and that
   *  is this plus `prestigeWaitSeconds`. */
  shiftHoldSeconds: number | null;
  /** Why it is on the list, so the UI can justify each row rather than showing a bare ranking. */
  reason: 'best' | 'prestige-count' | 'different-shape';
}

export interface ShortlistOptions {
  /** Hard cap on rows. Eight is about as many as anyone will actually compare. */
  maxRows?: number;
  /** Ignore anything more than this far behind the leader. The player's own success bar is "within
   *  a day"; five days keeps the interesting trades and drops the noise. */
  maxGapSeconds?: number;
  /** Total TE movement (L1) needed before a same-length chain counts as a different plan rather
   *  than the same plan nudged. */
  minSpread?: number;
}

/** L1 distance in TE. Different lengths are different plans by construction, never near-duplicates. */
function spread(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

function sumLegs(legs: LegSummary[], pick: (l: LegSummary) => number | undefined): number | null {
  if (!legs.length) return null;
  let total = 0;
  for (const l of legs) total += pick(l) ?? 0;
  return total;
}

function toRow(entry: CacheEntry, leaderSeconds: number, reason: ShortlistRow['reason']): ShortlistRow {
  const chain = entry.key.split(',').map(Number);
  return {
    chain,
    seconds: entry.seconds,
    gapSeconds: entry.seconds - leaderSeconds,
    prestiges: chain.length,
    legs: entry.legs,
    nightShifts: sumLegs(entry.legs, l => l.nightShifts),
    prestigeWaitSeconds: sumLegs(entry.legs, l => l.sleepDelaySeconds),
    shiftHoldSeconds: sumLegs(entry.legs, l => l.shiftDelaySeconds),
    reason,
  };
}

export function pickShortlist(entries: CacheEntry[], opts: ShortlistOptions = {}): ShortlistRow[] {
  const maxRows = opts.maxRows ?? 8;
  const maxGap = opts.maxGapSeconds ?? 5 * 86400;
  const minSpread = opts.minSpread ?? 6;

  // A zero/negative duration is "not priced yet", not "instant" — the same guard saveCheckpoint
  // needs, and for the same reason.
  const priced = entries.filter(e => e.seconds > 0).sort((a, b) => a.seconds - b.seconds);
  if (!priced.length) return [];

  const leader = priced[0];
  const inRange = priced.filter(e => e.seconds - leader.seconds <= maxGap);

  const chosen: ShortlistRow[] = [toRow(leader, leader.seconds, 'best')];
  const accepted: number[][] = [chosen[0].chain];

  // One guaranteed row per prestige count, cheapest first within each. This runs BEFORE the
  // general diversity fill so a rare count cannot be crowded out by same-length alternatives.
  const bestPerLength = new Map<number, CacheEntry>();
  for (const e of inRange) {
    const len = e.key.split(',').length;
    if (!bestPerLength.has(len)) bestPerLength.set(len, e);
  }
  for (const [len, e] of [...bestPerLength.entries()].sort((x, y) => x[0] - y[0])) {
    if (chosen.length >= maxRows) break;
    if (len === chosen[0].prestiges) continue; // the leader already represents its own count
    chosen.push(toRow(e, leader.seconds, 'prestige-count'));
    accepted.push(e.key.split(',').map(Number));
  }

  // Fill the rest with same-length chains that are actually a different plan.
  for (const e of inRange) {
    if (chosen.length >= maxRows) break;
    const chain = e.key.split(',').map(Number);
    if (accepted.some(a => spread(a, chain) < minSpread)) continue;
    chosen.push(toRow(e, leader.seconds, 'different-shape'));
    accepted.push(chain);
  }

  return chosen.sort((a, b) => a.seconds - b.seconds);
}
