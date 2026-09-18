/**
 * The ordering bug this composable exists to survive: the first pass runs before the backup has
 * loaded, and the placeholder it writes must not become the reason the backup is ignored.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useBackupPlanStart, resetBackupPlanStart } from './useBackupPlanStart';
import { useAutoPlannerStore } from '@/stores/autoPlanner';
import { useInitialStateStore } from '@/stores/initialState';

function installStorageStub(): void {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() {
      return backing.size;
    },
  });
}

/** 2026-09-17 21:21 in UTC, the shape of a backup taken the night before. */
const BACKUP = Math.floor(Date.UTC(2026, 8, 17, 21, 21) / 1000);

describe('useBackupPlanStart', () => {
  beforeEach(() => {
    installStorageStub();
    setActivePinia(createPinia());
    resetBackupPlanStart();
  });

  const setup = () => {
    const auto = useAutoPlannerStore();
    auto.timezone = 'UTC';
    const initial = useInitialStateStore();
    return { auto, initial };
  };

  it('takes the backup timestamp when one is already loaded', () => {
    const { auto, initial } = setup();
    initial.rawBackup = { approxTime: BACKUP } as never;
    useBackupPlanStart();
    expect(auto.startDate).toBe('2026-09-17');
    expect(auto.startTime).toBe('21:21');
  });

  // The regression. Mounting before the backup arrives wrote "now" into the form; the backup then
  // landed EARLIER than that value, which resolvePlanStart treats as the player's own choice to
  // start later -- so the plan was timed from the page load instead of from the save.
  it('replaces its own placeholder when the backup arrives afterwards', async () => {
    const { auto, initial } = setup();
    useBackupPlanStart();
    const placeholder = { date: auto.startDate, time: auto.startTime };
    expect(placeholder.date).not.toBe('');

    initial.rawBackup = { approxTime: BACKUP } as never;
    await nextTick();
    expect(auto.startDate).toBe('2026-09-17');
    expect(auto.startTime).toBe('21:21');
  });

  // The other half: a start the player typed is a decision, and "I will begin tomorrow morning" is
  // a legitimate thing to ask for. Only the untouched placeholder is replaceable.
  it('leaves a start the player typed alone, even though it is later than the backup', async () => {
    const { auto, initial } = setup();
    useBackupPlanStart();
    auto.startDate = '2026-12-25';
    auto.startTime = '08:00';

    initial.rawBackup = { approxTime: BACKUP } as never;
    await nextTick();
    expect(auto.startDate).toBe('2026-12-25');
    expect(auto.startTime).toBe('08:00');
  });

  it('only takes a default once, so a later refresh does not overwrite a chosen start', async () => {
    const { auto, initial } = setup();
    initial.rawBackup = { approxTime: BACKUP } as never;
    useBackupPlanStart();
    auto.startDate = '2026-12-25';
    auto.startTime = '08:00';

    initial.rawBackup = { approxTime: BACKUP + 86400 } as never;
    await nextTick();
    expect(auto.startDate).toBe('2026-12-25');
  });

  it('ignores a backup with no usable timestamp rather than syncing to the epoch', async () => {
    const { auto, initial } = setup();
    useBackupPlanStart();
    const placeholder = auto.startDate;
    initial.rawBackup = { approxTime: 0 } as never;
    await nextTick();
    expect(auto.startDate).toBe(placeholder);
  });
});
