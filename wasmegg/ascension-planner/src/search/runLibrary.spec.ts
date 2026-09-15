import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The library talks to IndexedDB through `lib/storage/db`. Mocked to an in-memory map so these
 * tests exercise the library's own rules (ordering, eviction, version gating, orphan cleanup)
 * rather than the browser's storage layer.
 */
const store = new Map<string, unknown>();
vi.mock('@/lib/storage/db', () => ({
  saveMetadata: async (partition: string, key: string, value: unknown) => {
    if (value === null) store.delete(`${partition}_${key}`);
    else store.set(`${partition}_${key}`, JSON.parse(JSON.stringify(value)));
  },
  loadMetadata: async (partition: string, key: string) => store.get(`${partition}_${key}`) ?? null,
}));

const { listRuns, saveRun, loadRun, deleteRun, defaultRunLabel, MAX_RUNS, LIBRARY_VERSION } =
  await import('./runLibrary');

const P = 'partition';

function input(overrides: Partial<Parameters<typeof saveRun>[1]> = {}) {
  return {
    label: 'A run',
    currentTE: 179,
    finalTE: 490,
    effort: 'balanced',
    seedChain: [195, 231, 290, 490],
    bestChain: [195, 229, 283, 490],
    bestDays: 743.9,
    entries: [
      { key: '195,229,283,490', seconds: 743.9 * 86400, legs: [] },
      { key: '195,231,290,490', seconds: 745.2 * 86400, legs: [] },
    ],
    bestLegs: [],
    runLog: ['stage 4: coordinate descent'],
    complete: true,
    ...overrides,
  };
}

describe('runLibrary', () => {
  beforeEach(() => store.clear());

  it('is empty before anything is saved', async () => {
    expect(await listRuns(P)).toEqual([]);
  });

  it('saves a run and lists its summary without loading the cache', async () => {
    const summary = await saveRun(P, input({ id: 'r1', now: 1000 }));
    expect(summary.chainsPriced).toBe(2);

    const list = await listRuns(P);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('A run');
    expect(list[0].bestChain).toEqual([195, 229, 283, 490]);
    // The summary is the listing; the expensive part is not in it.
    expect('entries' in list[0]).toBe(false);
  });

  it('reloads the cache and the log on open', async () => {
    await saveRun(P, input({ id: 'r1' }));
    const body = await loadRun(P, 'r1');
    expect(body?.entries).toHaveLength(2);
    expect(body?.runLog).toEqual(['stage 4: coordinate descent']);
  });

  it('drops unpriced entries rather than storing placeholders', async () => {
    // A zero duration is "not priced yet", not "instant" -- the same guard the checkpoint needs.
    await saveRun(P, input({ id: 'r1', entries: [{ key: '195,490', seconds: 0, legs: [] }] }));
    expect((await listRuns(P))[0].chainsPriced).toBe(0);
    expect((await loadRun(P, 'r1'))?.entries).toEqual([]);
  });

  it('lists newest first', async () => {
    await saveRun(P, input({ id: 'old', label: 'older', now: 1000 }));
    await saveRun(P, input({ id: 'new', label: 'newer', now: 2000 }));
    expect((await listRuns(P)).map(r => r.label)).toEqual(['newer', 'older']);
  });

  it('replaces rather than duplicates when the same id is saved again', async () => {
    await saveRun(P, input({ id: 'r1', label: 'first', now: 1000 }));
    await saveRun(P, input({ id: 'r1', label: 'renamed', now: 2000 }));
    const list = await listRuns(P);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('renamed');
  });

  it('evicts the oldest past the cap and deletes its body with it', async () => {
    for (let i = 0; i <= MAX_RUNS; i++) {
      await saveRun(P, input({ id: `r${i}`, label: `run ${i}`, now: 1000 + i }));
    }
    const list = await listRuns(P);
    expect(list).toHaveLength(MAX_RUNS);
    expect(list.some(r => r.id === 'r0')).toBe(false);
    // An index that forgets a run while its megabytes stay behind is how a quota fills up with
    // nothing to show for it.
    expect(await loadRun(P, 'r0')).toBeNull();
  });

  it('deletes a run and its body', async () => {
    await saveRun(P, input({ id: 'r1' }));
    await deleteRun(P, 'r1');
    expect(await listRuns(P)).toEqual([]);
    expect(await loadRun(P, 'r1')).toBeNull();
  });

  it('tolerates deleting something already gone', async () => {
    await expect(deleteRun(P, 'nope')).resolves.toBeUndefined();
  });

  it('hides entries written by an older version rather than reloading them', async () => {
    await saveRun(P, input({ id: 'r1' }));
    const key = `${P}_chainSearchLibraryIndex`;
    const index = store.get(key) as { version: number }[];
    index[0].version = LIBRARY_VERSION - 1;
    store.set(key, index);
    expect(await listRuns(P)).toEqual([]);
  });

  it('falls back to a name rather than saving an untitled blank', async () => {
    const s = await saveRun(P, input({ id: 'r1', label: '   ' }));
    expect(s.label).toBe('Untitled run');
  });

  it('builds a default label from the result', () => {
    expect(defaultRunLabel(490, [195, 229, 283, 490], 743.94)).toBe('490 TE · 4 asc · 743.9 d');
    expect(defaultRunLabel(490, [], 0)).toBe('490 TE · no result · unpriced');
  });
});
