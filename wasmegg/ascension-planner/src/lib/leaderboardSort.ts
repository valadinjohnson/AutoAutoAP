/**
 * Ordering for the leaderboard table.
 *
 * Lives outside the component so the two rules that are easy to get wrong can be tested: chains
 * compare element by element, and an unrecorded waiting time never wins its column.
 */

export type SortKey =
  | 'nickname'
  | 'chain'
  | 'ascensions'
  | 'durationDays'
  | 'endLocal'
  | 'waitingHours'
  | 'window';

export interface SortableRow {
  nickname?: string;
  chain?: number[];
  ascensions?: number;
  durationDays?: number;
  endLocal?: string;
  waitingHours?: number | null;
  window?: string | null;
}

/**
 * Compare two chains as sequences of numbers.
 *
 * `169 490` must sort before `180 490`, and a string compare gets that right by accident and
 * `99 490` before `180 490` wrong -- "9" > "1". A shorter chain that matches as far as it goes
 * sorts first, which is also the answer a reader expects: fewer ascensions to the same place.
 */
function compareChains(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * Sort rows by `key`, ascending when `asc`.
 *
 * NULL SORTS LAST IN BOTH DIRECTIONS, and that is the point rather than an oversight. A null
 * `waitingHours` means the submission carried no per-leg detail -- a chain replayed from a saved
 * checkpoint keeps none -- so it is UNKNOWN, not zero. Letting it flip to the top of "least
 * waiting" would advertise an unmeasured run as the kindest to your schedule.
 */
export function sortRows<T extends SortableRow>(rows: readonly T[], key: SortKey, asc: boolean): T[] {
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'chain') return compareChains(a.chain ?? [], b.chain ?? []) * dir;
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}
