/**
 * The run's whole chain -> duration cache, as a CSV — one row per LEG, not per chain.
 *
 * The panel's "show what it tried" log answers "what is the search doing"; this answers the
 * different question of "what did each candidate actually look like": which sale strategy each leg
 * used, when each leg started and ended in local time, what the peak delivery rate was, and which
 * milestones land in the middle of the night. Per-leg is the only granularity at which those
 * questions have answers, so a 4000-chain run becomes roughly 24000 rows — which is fine for a
 * spreadsheet and is the point.
 *
 * TWO HONEST GAPS, both visible in the output rather than hidden:
 *
 *   1. Per-leg detail exists only for chains still in memory. A checkpoint deliberately keeps
 *      `legs` for the BEST chain alone (see persistence.ts — keeping them all would multiply the
 *      record's size by about six for data nothing reads), so after a refresh-and-resume the
 *      replayed chains come back with their duration and nothing else. Those rows are emitted with
 *      the total filled in and the per-leg cells blank, because dropping them would silently
 *      under-report what the run priced.
 *
 *   2. Artifacts and stones are a property of the RUN, not of a candidate — the search never varies
 *      them, and the simulator re-optimises the equipped set inside each leg via `getOptimalELRSet`
 *      rather than being told what to wear. So they are recorded once in the header block, from the
 *      backup the run was launched against, and the header says which sets those are.
 */
import { getArtifact, getStone } from '@/lib/artifacts/data';
// The workspace tier table, the same source src/lib/artifacts/data.ts parses its own
// options from. Needed raw here because an inventory item carries (afx name, level),
// not a planner artifact id.
import { allPossibleTiers } from 'lib/artifacts/data';
import type { EquippedArtifact } from '@/lib/artifacts/types';
import type { CacheEntry } from './driver';
import { describeAvailability, type Availability } from './availability';
import type { LegSummary } from './types';

export interface CsvMeta {
  planStart: number;
  /** IANA zone every local timestamp in the file is rendered in — the plan's own, not the
   *  browser's, so the file reads the same as the planner does. */
  timezone: string;
  currentTE: number;
  final: number;
  effort: string;
  forceContinue: boolean;
  availability?: Availability | null;
  seedChain: number[];
  /** Named artifact/stone sets, in the order they should appear. */
  loadouts: { label: string; loadout: EquippedArtifact[] | null }[];
  /** Everything in the VIRTUE inventory, already summarised. This is the honest answer to "what
   *  artifacts and stones were used": the sim re-optimises the equipped set inside every leg, so
   *  what matters is what it had to choose FROM. */
  inventory?: string;
  /** Defaults to now. Injectable so the tests are not clock-dependent. */
  generatedAt?: number;
}

/** `2028-09-16 00:22` in `timezone`. Blank for a missing instant, never `1970-01-01`. */
export function formatInZone(unixSeconds: number | undefined, timezone: string): string {
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
  // `hour12: false` still yields "24" for midnight in some engines; the planner shows 00.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

/** `T4L Interstellar compass + 3x T4 Tachyon stone`, plain text — `summarizeLoadout` in
 *  lib/artifacts/utils.ts produces `<img>` tags, which is right for the action history and useless
 *  in a spreadsheet cell. `label` already carries the tier and rarity ("T4L Puzzle cube"), so it is
 *  used verbatim rather than re-assembled. */
export function describeLoadout(loadout: EquippedArtifact[] | null | undefined): string {
  if (!loadout?.length) return 'none';
  const items: string[] = [];
  const stones = new Map<string, number>();
  for (const slot of loadout) {
    const a = getArtifact(slot.artifactId);
    if (a) items.push(a.label);
    for (const id of slot.stones) {
      if (!id) continue;
      const s = getStone(id);
      if (s) stones.set(s.label, (stones.get(s.label) ?? 0) + 1);
    }
  }
  for (const [label, n] of stones) items.push(`${n}x ${label}`);
  return items.length ? items.join(' + ') : 'none';
}

/**
 * Everything in the VIRTUE artifact inventory, counted by tier and rarity.
 *
 * This is the line that actually answers "what artifacts and stones were used". The equipped
 * loadout is usually empty — `getArtifactLoadoutFromBackup` reads `virtueAfxDb.activeArtifacts`,
 * which has nothing in it unless you are mid-virtue-ascension — and reporting only that produced a
 * header saying `equipped in the backup: none`, which is true and useless. The simulator picks a
 * set per leg out of this inventory, so the inventory is the input that matters.
 *
 * Reads the raw backup rather than a parsed structure because that is where the list lives; the
 * planner has no "what do I own" model of its own.
 */
export interface InventoryCount {
  label: string;
  count: number;
}

/** The virtue inventory split into artifacts and stones, counted, sorted by label. The UI renders
 *  this as two lists; `describeVirtueInventory` flattens the same data into one CSV cell. */
export function virtueInventory(rawBackup: unknown): { artifacts: InventoryCount[]; stones: InventoryCount[] } {
  const db = (rawBackup as { artifactsDb?: { virtueAfxDb?: { inventoryItems?: unknown[] } } })?.artifactsDb
    ?.virtueAfxDb;
  const items = db?.inventoryItems;
  const artifacts = new Map<string, number>();
  const stones = new Map<string, number>();
  if (!Array.isArray(items) || !items.length) return { artifacts: [], stones: [] };
  for (const raw of items) {
    const item = raw as { quantity?: number; artifact?: { spec?: { name?: number; level?: number; rarity?: number } } };
    const spec = item?.artifact?.spec;
    if (!spec) continue;
    const tier = allPossibleTiers.find(
      (t: { afx_id: number; afx_level: number; family: { id: string }; tier_number: number }) =>
        t.afx_id === spec.name && t.afx_level === spec.level
    );
    if (!tier) continue;
    // `quantity` is how many of that exact item the player holds; absent means one.
    const n = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
    const stone = getStone(`${tier.family.id}-${tier.tier_number}`);
    if (stone) {
      stones.set(stone.label, (stones.get(stone.label) ?? 0) + n);
      continue;
    }
    const art = getArtifact(`${tier.family.id}-${tier.tier_number}-${spec.rarity ?? 0}`);
    if (art) artifacts.set(art.label, (artifacts.get(art.label) ?? 0) + n);
  }

  const list = (m: Map<string, number>): InventoryCount[] =>
    [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }));
  return { artifacts: list(artifacts), stones: list(stones) };
}

export function describeVirtueInventory(rawBackup: unknown): string {
  const { artifacts, stones } = virtueInventory(rawBackup);
  const fmt = (xs: InventoryCount[]) => xs.map(x => `${x.count}x ${x.label}`).join(', ');
  const parts: string[] = [];
  if (artifacts.length) parts.push(fmt(artifacts));
  if (stones.length) parts.push(`stones: ${fmt(stones)}`);
  return parts.length ? parts.join('; ') : 'empty';
}

/** Quote only when a cell needs it, so the common case stays readable in a text editor. */
function cell(value: string | number | undefined): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  'rank',
  'chain',
  'prestiges',
  'total_days',
  'gap_days',
  'leg',
  'target_te',
  'strategy',
  'sales',
  'tier13',
  'leg_start_local',
  'build_phase_end_local',
  'leg_end_local',
  'leg_days',
  'peak_delivery_q_per_hr',
  'night_shifts',
  'prestige_delay_hours',
  'shift_hold_hours',
  'starts_on_egg',
  'shift_times_local',
] as const;

function legRow(
  rank: number,
  chain: string,
  prestiges: number,
  totalDays: number,
  gapDays: number,
  legIndex: number | '',
  leg: LegSummary | null,
  tz: string
): string {
  // `sales` is the same number `strategy` already encodes as `2-sale-tier13`, broken out so a
  // spreadsheet can group on it. `continue` has no build phase and so no sale count.
  const salesFromKey = leg ? /^(\d+)-sale/.exec(leg.key)?.[1] : undefined;
  return [
    rank,
    chain,
    prestiges,
    totalDays.toFixed(4),
    gapDays.toFixed(4),
    legIndex === '' ? '' : legIndex + 1,
    leg?.endTE,
    leg?.key,
    leg ? (leg.buildPhaseSaleCount ?? salesFromKey) : undefined,
    leg ? (leg.tier13Unlocked ? 'yes' : 'no') : undefined,
    formatInZone(leg?.startTime, tz),
    formatInZone(leg?.buildPhaseEndTime, tz),
    formatInZone(leg?.endTime, tz),
    leg ? (leg.durationSeconds / 86400).toFixed(4) : undefined,
    leg ? ((leg.maxELR * 3600) / 1e15).toFixed(3) : undefined,
    leg?.nightShifts,
    leg?.sleepDelaySeconds === undefined ? undefined : (leg.sleepDelaySeconds / 3600).toFixed(2),
    leg?.shiftDelaySeconds === undefined ? undefined : (leg.shiftDelaySeconds / 3600).toFixed(2),
    // One cell, semicolon separated. Twelve columns would be worse: the count is not always
    // twelve (A1's "continue" variant is a part-finished ascension) and a spreadsheet handles a
    // split-on-semicolon better than twelve mostly-empty columns.
    leg?.shifts?.[0]?.fromEgg,
    leg?.shifts?.length ? leg.shifts.map(x => `${formatInZone(x.at, tz)} ${x.egg}`).join('; ') : undefined,
  ]
    .map(cell)
    .join(',');
}

export function buildChainsCsv(entries: CacheEntry[], meta: CsvMeta): string {
  const tz = meta.timezone;
  const ranked = [...entries].sort((a, b) => a.seconds - b.seconds);
  const bestSeconds = ranked.length ? ranked[0].seconds : 0;

  const lines: string[] = [];
  const note = (s: string) => lines.push(`# ${s}`);

  note(`ascension-planner chain search — every chain this run priced`);
  note(`generated ${formatInZone(Math.floor((meta.generatedAt ?? Date.now()) / 1000), tz)} (${tz})`);
  note(`plan start ${formatInZone(meta.planStart, tz)}`);
  note(`current TE ${meta.currentTE} -> final target ${meta.final}`);
  note(`effort ${meta.effort}; force-continue ${meta.forceContinue ? 'on' : 'off'}`);
  note(`available ${describeAvailability(meta.availability)}`);
  note(`seed chain ${meta.seedChain.join(' ')}`);
  note(`chains priced ${entries.length}`);
  note('');
  note('artifacts and stones — fixed for the whole run, never varied by the search.');
  note('The simulator re-optimises the equipped set inside each leg, so what matters is what it');
  note('had to choose FROM, not what happened to be equipped when the backup was taken.');
  if (meta.inventory) note(`  virtue inventory: ${meta.inventory}`);
  for (const { label, loadout } of meta.loadouts) note(`  ${label}: ${describeLoadout(loadout)}`);
  note('  ("equipped" is empty whenever you are not mid-virtue-ascension. That is normal and');
  note('   does not mean the plan was simulated bare - the inventory line above is what counts.)');
  note('');
  note('One row per leg. Blank per-leg cells mean the chain was replayed from a saved checkpoint,');
  note('which keeps per-leg detail for the best chain only — the total is still exact.');
  note(`Local times are ${tz}. gap_days is days behind the best chain in this file.`);

  lines.push(COLUMNS.join(','));

  let rank = 0;
  for (const entry of ranked) {
    rank++;
    const chain = entry.key.split(',').map(Number);
    const chainText = chain.join(' ');
    const totalDays = entry.seconds / 86400;
    const gapDays = (entry.seconds - bestSeconds) / 86400;
    if (!entry.legs.length) {
      lines.push(legRow(rank, chainText, chain.length, totalDays, gapDays, '', null, tz));
      continue;
    }
    entry.legs.forEach((leg, i) => {
      lines.push(legRow(rank, chainText, chain.length, totalDays, gapDays, i, leg, tz));
    });
  }

  // Trailing newline: some spreadsheet importers drop the last row without one.
  return lines.join('\n') + '\n';
}
