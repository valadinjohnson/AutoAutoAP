/**
 * The chain-cache CSV export.
 *
 * The things worth pinning down are the ones a spreadsheet would silently mangle: chains that came
 * back from a checkpoint with no per-leg detail (they must appear, with blanks, not vanish),
 * ordering and the gap column, and local-time rendering in the plan's zone rather than the
 * runner's.
 */
import { describe, expect, it } from 'vitest';
import { getLocalTimestampInTimezone } from '@/lib/events';
import { buildChainsCsv, describeLoadout, describeVirtueInventory, formatInZone } from './csv';
import type { CacheEntry } from './driver';
import type { LegSummary } from './types';

const DENVER = 'America/Denver';
const PLAN_START = getLocalTimestampInTimezone('2026-09-04', '21:30', DENVER);

const META = {
  planStart: PLAN_START,
  timezone: DENVER,
  currentTE: 176,
  final: 490,
  effort: 'balanced',
  forceContinue: true,
  availability: null,
  seedChain: [195, 490],
  loadouts: [{ label: 'equipped in the backup', loadout: null }],
  generatedAt: PLAN_START * 1000,
};

function leg(over: Partial<LegSummary> = {}): LegSummary {
  return {
    key: '2-sale-tier13',
    endTE: 219,
    durationSeconds: 60.76 * 86400,
    maxELR: 5.593e15 / 3600,
    endTime: PLAN_START + 60 * 86400,
    tier13Unlocked: true,
    startTime: PLAN_START,
    buildPhaseEndTime: PLAN_START + 5 * 86400,
    buildPhaseSaleCount: 2,
    nightShifts: 0,
    sleepDelaySeconds: 0,
    ...over,
  };
}

/** Data rows only — the `#` header block and the column line are asserted separately. */
function dataRows(csv: string): string[] {
  return csv
    .split('\n')
    .filter(l => l && !l.startsWith('#') && !l.startsWith('rank,'));
}

function column(csv: string, row: number, name: string): string {
  const header = csv.split('\n').find(l => l.startsWith('rank,'))!.split(',');
  return dataRows(csv)[row].split(',')[header.indexOf(name)];
}

describe('buildChainsCsv', () => {
  it('emits one row per leg', () => {
    const entries: CacheEntry[] = [
      { key: '195,219,490', seconds: 700 * 86400, legs: [leg(), leg({ endTE: 490 }), leg({ endTE: 490 })] },
    ];
    expect(dataRows(buildChainsCsv(entries, META))).toHaveLength(3);
  });

  it('keeps chains that have no per-leg detail, with the total intact', () => {
    // This is what a resumed run looks like: a checkpoint stores `legs` for the BEST chain only,
    // so every replayed chain comes back with a duration and nothing else. Skipping them would
    // under-report what the run priced by thousands of rows.
    const entries: CacheEntry[] = [
      { key: '195,219,490', seconds: 741.965 * 86400, legs: [] },
      { key: '196,232,490', seconds: 744.355 * 86400, legs: [] },
    ];
    const csv = buildChainsCsv(entries, META);
    expect(dataRows(csv)).toHaveLength(2);
    expect(column(csv, 0, 'total_days')).toBe('741.9650');
    expect(column(csv, 0, 'strategy')).toBe('');
    expect(column(csv, 0, 'leg')).toBe('');
  });

  it('ranks fastest first and states the gap against the best in the file', () => {
    const entries: CacheEntry[] = [
      { key: '196,232,490', seconds: 744.355 * 86400, legs: [] },
      { key: '195,219,490', seconds: 741.965 * 86400, legs: [] },
    ];
    const csv = buildChainsCsv(entries, META);
    expect(column(csv, 0, 'chain')).toBe('195 219 490');
    expect(column(csv, 0, 'gap_days')).toBe('0.0000');
    expect(column(csv, 1, 'gap_days')).toBe('2.3900');
  });

  it('renders times in the plan’s timezone, not the runner’s', () => {
    const entries: CacheEntry[] = [{ key: '195,490', seconds: 86400, legs: [leg()] }];
    const csv = buildChainsCsv(entries, META);
    expect(column(csv, 0, 'leg_start_local')).toBe('2026-09-04 21:30');
  });

  it('leaves a missing instant blank rather than printing 1970', () => {
    const entries: CacheEntry[] = [
      { key: '195,490', seconds: 86400, legs: [leg({ startTime: undefined, buildPhaseEndTime: undefined })] },
    ];
    const csv = buildChainsCsv(entries, META);
    expect(column(csv, 0, 'leg_start_local')).toBe('');
    expect(column(csv, 0, 'build_phase_end_local')).toBe('');
  });

  it('recovers the sale count from the strategy key when the field is absent', () => {
    // Legs restored from a checkpoint written before these fields existed have no
    // `buildPhaseSaleCount`, but `2-sale-tier13` still says 2.
    const entries: CacheEntry[] = [
      { key: '195,490', seconds: 86400, legs: [leg({ buildPhaseSaleCount: undefined })] },
    ];
    expect(column(buildChainsCsv(entries, META), 0, 'sales')).toBe('2');
  });

  it('reports the availability window and the schedule columns', () => {
    const entries: CacheEntry[] = [
      { key: '195,490', seconds: 86400, legs: [leg({ nightShifts: 4, sleepDelaySeconds: 3.5 * 3600 })] },
    ];
    const csv = buildChainsCsv(entries, {
      ...META,
      availability: { days: [], fromHour: 7, toHour: 23, timezone: DENVER },
    });
    expect(csv).toContain(`# available every day 07:00-23:00 ${DENVER}`);
    expect(column(csv, 0, 'night_shifts')).toBe('4');
    expect(column(csv, 0, 'prestige_delay_hours')).toBe('3.50');
  });

  it('lists each shift with its egg, in the plan timezone', () => {
    // "4 night shifts" says there is a problem; only the instants say WHEN, which is the whole
    // point of carrying twelve numbers per leg.
    const shifts = [
      { at: PLAN_START + 3600, egg: 'curiosity' },
      { at: PLAN_START + 7200, egg: 'integrity' },
    ];
    const csv = buildChainsCsv([{ key: '195,490', seconds: 86400, legs: [leg({ shifts })] }], META);
    // Semicolon separated, so the cell needs no quoting and cannot shift the columns — which is
    // the whole reason it is not comma separated.
    expect(column(csv, 0, 'shift_times_local')).toBe('2026-09-04 22:30 curiosity; 2026-09-04 23:30 integrity');
  });

  it('leaves the shift column blank rather than empty-quoting when there are none', () => {
    const csv = buildChainsCsv([{ key: '195,490', seconds: 86400, legs: [leg({ shifts: [] })] }], META);
    expect(column(csv, 0, 'shift_times_local')).toBe('');
  });

  it('reports the virtue inventory in the header, since "equipped" is usually empty', () => {
    const csv = buildChainsCsv([], { ...META, inventory: '1x T4L Puzzle cube; stones: 3x T4 Lunar stone' });
    expect(csv).toContain('virtue inventory: 1x T4L Puzzle cube; stones: 3x T4 Lunar stone');
  });

  it('quotes a cell containing a comma so the columns do not shift', () => {
    const csv = buildChainsCsv([], {
      ...META,
      loadouts: [{ label: 'a, b', loadout: null }],
    });
    expect(csv).toContain('a, b');
  });

  it('survives an empty cache', () => {
    const csv = buildChainsCsv([], META);
    expect(dataRows(csv)).toHaveLength(0);
    expect(csv).toContain('# chains priced 0');
  });

  it('ends with a newline, so the last row is not dropped on import', () => {
    expect(buildChainsCsv([{ key: '195,490', seconds: 86400, legs: [] }], META).endsWith('\n')).toBe(true);
  });
});

describe('formatInZone', () => {
  it('shows midnight as 00, not 24', () => {
    expect(formatInZone(getLocalTimestampInTimezone('2026-09-08', '00:00', DENVER), DENVER)).toBe('2026-09-08 00:00');
  });

  it('is blank for 0 and undefined', () => {
    expect(formatInZone(0, DENVER)).toBe('');
    expect(formatInZone(undefined, DENVER)).toBe('');
  });
});

describe('describeVirtueInventory', () => {
  it('says "empty" for a backup with no virtue inventory rather than throwing', () => {
    // Called on whatever the backup happens to contain, including nothing.
    expect(describeVirtueInventory(null)).toBe('empty');
    expect(describeVirtueInventory({})).toBe('empty');
    expect(describeVirtueInventory({ artifactsDb: { virtueAfxDb: { inventoryItems: [] } } })).toBe('empty');
  });

  it('ignores items it cannot resolve instead of failing the whole export', () => {
    const backup = {
      artifactsDb: { virtueAfxDb: { inventoryItems: [{ quantity: 2, artifact: { spec: { name: 9999, level: 9 } } }] } },
    };
    expect(describeVirtueInventory(backup)).toBe('empty');
  });
});

describe('describeLoadout', () => {
  it('says "none" for an empty or absent loadout rather than an empty cell', () => {
    expect(describeLoadout(null)).toBe('none');
    expect(describeLoadout([])).toBe('none');
  });

  it('produces plain text with no markup', () => {
    // The point of not reusing `summarizeLoadout`: that one emits <img> tags.
    const text = describeLoadout([{ artifactId: 'puzzle-cube-4-3', stones: [null, null, null] }]);
    expect(text).not.toContain('<');
  });
});
