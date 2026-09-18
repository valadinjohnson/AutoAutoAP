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

  it('hides entries written by a version it does not know rather than reloading them', async () => {
    await saveRun(P, input({ id: 'r1' }));
    const key = `${P}_chainSearchLibraryIndex`;
    const index = store.get(key) as { version: number }[];
    index[0].version = LIBRARY_VERSION + 1;
    store.set(key, index);
    expect(await listRuns(P)).toEqual([]);
  });

  // Version 2 only ADDS `space` and `fingerprint`. A version 1 run's entries are identical, so
  // dropping it would have thrown away a library for no reason -- and the symptom would have been
  // an empty list, indistinguishable from never having saved anything.
  it('still lists and opens a version 1 run, which differs only by fields it never had', async () => {
    await saveRun(P, input({ id: 'r1' }));
    const indexKey = `${P}_chainSearchLibraryIndex`;
    const bodyKey = `${P}_chainSearchLibraryRun:r1`;
    const index = store.get(indexKey) as { version: number }[];
    index[0].version = 1;
    store.set(indexKey, index);
    const body = store.get(bodyKey) as { version: number };
    body.version = 1;
    store.set(bodyKey, body);

    expect((await listRuns(P)).map(r => r.id)).toEqual(['r1']);
    expect((await loadRun(P, 'r1'))?.entries).toHaveLength(2);
  });

  it('records the space and fingerprint, so an unfinished run can be picked back up', async () => {
    const space = {
      mode: 'bands' as const,
      bands: [[240, 245]],
      minGap: 0,
      minAscensions: 2,
      maxAscensions: 2,
      chains: 2,
      chainsPriced: 1,
      stoppedEarly: true,
    };
    const s = await saveRun(P, input({ id: 'r1', complete: false, space, fingerprint: 'fp-abc' }));
    expect(s.space).toEqual(space);
    expect(s.fingerprint).toBe('fp-abc');
    expect((await listRuns(P))[0].space?.bands).toEqual([[240, 245]]);
  });

  // `undefined` survives a structuredClone into IndexedDB as a present key, and a present-but-empty
  // space would make a staged run look like an exhaustive one with nothing in it.
  it('leaves the keys off entirely when there is no space to record', async () => {
    await saveRun(P, input({ id: 'r1' }));
    const summary = (await listRuns(P))[0];
    expect('space' in summary).toBe(false);
    expect('fingerprint' in summary).toBe(false);
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
