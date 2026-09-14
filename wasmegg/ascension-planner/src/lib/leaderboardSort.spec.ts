import { describe, expect, it } from 'vitest';
import { sortRows, type SortableRow } from './leaderboardSort';

const rows: SortableRow[] = [
  { nickname: 'bea', chain: [180, 490], durationDays: 2015.6, waitingHours: 3.6 },
  { nickname: 'ari', chain: [99, 490], durationDays: 1005.6, waitingHours: null },
  { nickname: 'cal', chain: [169, 490], durationDays: 2066.8, waitingHours: 0 },
];

describe('sortRows', () => {
  it('orders by duration, fastest first, and reverses on a second click', () => {
    expect(sortRows(rows, 'durationDays', true).map(r => r.nickname)).toEqual(['ari', 'bea', 'cal']);
    expect(sortRows(rows, 'durationDays', false).map(r => r.nickname)).toEqual(['cal', 'bea', 'ari']);
  });

  it('compares chains as numbers, not as text', () => {
    // The trap: "99 490" sorts AFTER "180 490" on any string compare, because "9" > "1".
    expect(sortRows(rows, 'chain', true).map(r => r.chain![0])).toEqual([99, 169, 180]);
  });

  it('keeps an unrecorded waiting time out of the top, in both directions', () => {
    // null is "the submission carried no per-leg detail", not "this plan asks nothing of you".
    expect(sortRows(rows, 'waitingHours', true).map(r => r.nickname)).toEqual(['cal', 'bea', 'ari']);
    expect(sortRows(rows, 'waitingHours', false).map(r => r.nickname)).toEqual(['bea', 'cal', 'ari']);
  });

  it('sorts text case-insensitively and leaves the input untouched', () => {
    const before = rows.map(r => r.nickname);
    expect(sortRows(rows, 'nickname', true).map(r => r.nickname)).toEqual(['ari', 'bea', 'cal']);
    expect(rows.map(r => r.nickname)).toEqual(before);
  });
});
