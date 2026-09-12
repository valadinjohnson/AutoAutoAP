/**
 * Named ways of looking at the chains a run priced.
 *
 * `pickShortlist` answers one question well — "show me eight genuinely different options near the
 * top" — and it answers it opinionatedly: anything more than five days behind is dropped, and
 * same-length chains within six TE of one already shown are treated as duplicates. That is the
 * right default and the wrong thing to be stuck with. A player who wants the ten outright fastest,
 * or the best chain at every ascension count, or one option per finish date, was being shown a
 * curated eight and told the rest "was almost certainly never evaluated" — which is true of chains
 * the search never visited and false of the nine thousand sitting in the cache.
 *
 * So the shortlist becomes one VIEW among several over the same priced entries. Every view reads
 * the run's own cache, none of them re-simulates anything, and switching is instant.
 *
 * NOTHING HERE FILTERS BY SCHEDULE FIT. A chain whose shifts land outside your hours is a real
 * option with a real cost, and hiding it makes the decision for the player. The cost is shown in
 * its own column instead; `cheapest-hours` sorts BY it for anyone who wants that to be the
 * priority, and `fastest` ignores it for anyone who does not.
 */
import type { CacheEntry } from './driver';
import { pickShortlist, type ShortlistRow } from './shortlist';
import type { LegSummary } from './types';

export type ViewId = 'balanced' | 'fastest' | 'cheapest-hours' | 'per-count' | 'finish-days';

export interface ViewDef {
  id: ViewId;
  /** Pill label. Short enough to sit in a row of five. */
  label: string;
  /** One line under the table explaining what this view is showing and what it is not. */
  hint: string;
}

export const VIEWS: ViewDef[] = [
  {
    id: 'balanced',
    label: 'A good mix',
    hint:
      'The leader, the best chain at each other ascension count, then whatever else is a genuinely ' +
      'different plan rather than the same one nudged by a few TE. Anything more than five days ' +
      'behind is left out here — switch to "Fastest" to see the raw ranking.',
  },
  {
    id: 'fastest',
    label: 'Fastest',
    hint:
      'The outright quickest chains this run priced, in order, with nothing filtered out. Expect ' +
      'near-duplicates: a descent sweep prices dozens of chains differing by one TE, and they are ' +
      'all really the same plan.',
  },
  {
    id: 'cheapest-hours',
    label: 'Kindest to my schedule',
    hint:
      'Sorted by how much of the plan is spent waiting for you — prestiges held plus shifts held — ' +
      'rather than by total length. The fastest chain is rarely the one that asks least of you, and ' +
      'a chain that costs you two fewer days of waiting may be worth half a day of plan.',
  },
  {
    id: 'per-count',
    label: 'By ascension count',
    hint:
      'The best chain at every ascension count the run saw, shortest chain first. Each prestige is a ' +
      'full rebuild — twelve shifts and a fresh research grind — so one fewer for half a day is a ' +
      'trade worth seeing plainly.',
  },
  {
    id: 'finish-days',
    label: 'By finish date',
    hint:
      'One chain per calendar day it could finish on, earliest first. Useful when a date matters more ' +
      'than a duration: several chains finishing the same morning are one choice, not four.',
  },
];

export interface ViewOptions {
  maxRows?: number;
  /** Plan start, unix seconds. Required by `finish-days` to know which day a chain lands on. */
  planStart?: number;
  /** IANA zone the finish dates are bucketed in — the plan's own, not the browser's. */
  timezone?: string;
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

/** Waiting-for-you total, or null when the chain was replayed from a checkpoint and kept no legs.
 *  Null sorts last: "not recorded" is not the same as "costs nothing". */
export function scheduleCost(row: ShortlistRow): number | null {
  if (row.prestigeWaitSeconds === null && row.shiftHoldSeconds === null) return null;
  return (row.prestigeWaitSeconds ?? 0) + (row.shiftHoldSeconds ?? 0);
}

/** `2028-09-18` in `tz`. Bucketing key for `finish-days`, never shown raw. */
function finishDay(planStart: number, seconds: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date((planStart + seconds) * 1000));
}

export function buildView(entries: CacheEntry[], view: ViewId, opts: ViewOptions = {}): ShortlistRow[] {
  const maxRows = opts.maxRows ?? 12;

  // A zero or negative duration means "not priced yet", not "instant" — the same guard
  // saveCheckpoint and pickShortlist both need, for the same reason.
  const priced = entries.filter(e => e.seconds > 0).sort((a, b) => a.seconds - b.seconds);
  if (!priced.length) return [];
  const leader = priced[0].seconds;

  if (view === 'balanced') return pickShortlist(entries, { maxRows });

  if (view === 'fastest') {
    return priced.slice(0, maxRows).map((e, i) => toRow(e, leader, i === 0 ? 'best' : 'different-shape'));
  }

  if (view === 'cheapest-hours') {
    const rows = priced.map((e, i) => toRow(e, leader, i === 0 ? 'best' : 'different-shape'));
    // Null cost last, then least waiting, then shortest plan as the tiebreak — among chains that
    // ask the same of you, the quicker one is strictly better.
    rows.sort((a, b) => {
      const ca = scheduleCost(a);
      const cb = scheduleCost(b);
      if (ca === null && cb === null) return a.seconds - b.seconds;
      if (ca === null) return 1;
      if (cb === null) return -1;
      return ca === cb ? a.seconds - b.seconds : ca - cb;
    });
    return rows.slice(0, maxRows);
  }

  if (view === 'per-count') {
    const best = new Map<number, CacheEntry>();
    for (const e of priced) {
      const len = e.key.split(',').length;
      if (!best.has(len)) best.set(len, e);
    }
    return [...best.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, maxRows)
      .map(([, e]) => toRow(e, leader, e.seconds === leader ? 'best' : 'prestige-count'));
  }

  // finish-days
  const planStart = opts.planStart ?? 0;
  const tz = opts.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Without a plan start every chain buckets to the same epoch day and the view collapses to one
  // row. Falling back to the raw ranking is the honest failure: still useful, not silently wrong.
  if (!planStart) return priced.slice(0, maxRows).map(e => toRow(e, leader, 'different-shape'));

  const best = new Map<string, CacheEntry>();
  for (const e of priced) {
    const day = finishDay(planStart, e.seconds, tz);
    if (!best.has(day)) best.set(day, e);
  }
  return [...best.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxRows)
    .map(([, e]) => toRow(e, leader, e.seconds === leader ? 'best' : 'different-shape'));
}
