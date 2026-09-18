/**
 * A checkpoint is a high-water mark. These tests exist because it was not.
 *
 * Observed in the wild: a saved best of `196 232 278 318 490` at 744.355 d was replaced by
 * `195 226 277 317 490` at 752.975 d — 8.6 days worse — simply because a second run began from
 * the chain in the Target TE box. There is one checkpoint per fingerprint, so starting a run
 * overwrote the previous run's answer with its own starting point, while the 1172 priced chains
 * that found it sat in the same record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('@/lib/storage/db', () => ({
  saveMetadata: vi.fn(async (hash: string, key: string, value: unknown) => {
    store.set(`${hash}/${key}`, value);
  }),
  loadMetadata: vi.fn(async (hash: string, key: string) => store.get(`${hash}/${key}`) ?? null),
  hashID: vi.fn(async (id: string) => id),
}));

const { buildCheckpoint, loadCheckpoint, saveCheckpoint } = await import('./persistence');

const HASH = 'partition';
const FP = 'player|1000|175|490|fc';

function record(chain: number[], days: number, keys: string[]) {
  return buildCheckpoint({
    fingerprint: FP,
    effort: 'balanced',
    seedChain: [195, 490],
    bestChain: chain,
    bestSeconds: days * 86400,
    entries: keys.map(k => ({ key: k, seconds: 1, legs: [] })),
    stage: 'running',
    detail: '',
    chainsDone: keys.length,
  });
}

describe('saveCheckpoint', () => {
  beforeEach(() => store.clear());

  it('keeps the better best when a new run writes a worse one', async () => {
    await saveCheckpoint(HASH, record([196, 232, 278, 318, 490], 744.355, ['a', 'b']));
    await saveCheckpoint(HASH, record([195, 226, 277, 317, 490], 752.975, ['c']));

    const got = await loadCheckpoint(HASH, FP);
    expect(got?.bestChain).toEqual([196, 232, 278, 318, 490]);
    expect(got!.bestSeconds / 86400).toBeCloseTo(744.355, 3);
  });

  it('accepts a genuinely better best', async () => {
    await saveCheckpoint(HASH, record([196, 232, 278, 318, 490], 744.355, ['a']));
    await saveCheckpoint(HASH, record([195, 219, 248, 286, 327, 490], 741.965, ['b']));

    const got = await loadCheckpoint(HASH, FP);
    expect(got?.bestChain).toEqual([195, 219, 248, 286, 327, 490]);
  });

  it('never lets a zero-duration placeholder win', async () => {
    // start() seeds bestDays at 0, so a checkpoint written before the first batch reports
    // carries bestSeconds 0. Zero is "no result yet", not "instant plan".
    await saveCheckpoint(HASH, record([196, 232, 278, 318, 490], 744.355, ['a']));
    await saveCheckpoint(HASH, record([195, 226, 277, 317, 490], 0, ['b']));

    const got = await loadCheckpoint(HASH, FP);
    expect(got?.bestChain).toEqual([196, 232, 278, 318, 490]);
    expect(got!.bestSeconds).toBeGreaterThan(0);
  });

  it('unions priced chains instead of replacing them', async () => {
    await saveCheckpoint(HASH, record([196, 490], 800, ['a', 'b', 'c']));
    await saveCheckpoint(HASH, record([196, 490], 799, ['c', 'd']));

    const got = await loadCheckpoint(HASH, FP);
    expect(new Set(got!.durations.map(([k]) => k))).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(got!.chainsDone).toBe(3);
  });

  it('does not merge across different fingerprints', async () => {
    // A different plan start or current TE changes what every duration MEANS, so the old best
    // must not survive into the new run.
    await saveCheckpoint(HASH, record([196, 232, 278, 318, 490], 744.355, ['a']));
    const other = { ...record([300, 490], 900, ['b']), fingerprint: 'player|2000|176|490|fc' };
    await saveCheckpoint(HASH, other);

    expect(await loadCheckpoint(HASH, FP)).toBeNull();
    const got = await loadCheckpoint(HASH, 'player|2000|176|490|fc');
    expect(got?.bestChain).toEqual([300, 490]);
  });

  it('never un-completes a finished run', async () => {
    // The panel decides between "an unfinished run is saved" and "a finished run is saved"
    // from this flag. A later interim write must not drag it back to false, or a completed
    // run starts advertising itself as resumable again - which is what made pressing Resume
    // look like it had done nothing.
    await saveCheckpoint(HASH, { ...record([196, 490], 744, ['a']), complete: true });
    await saveCheckpoint(HASH, record([196, 490], 744, ['b']));
    expect((await loadCheckpoint(HASH, FP))?.complete).toBe(true);
  });

  it('defaults complete to false', async () => {
    await saveCheckpoint(HASH, record([196, 490], 744, ['a']));
    expect((await loadCheckpoint(HASH, FP))?.complete).toBe(false);
  });

  it('still writes when the prior record cannot be read', async () => {
    const db = await import('@/lib/storage/db');
    vi.mocked(db.loadMetadata).mockRejectedValueOnce(new Error('IndexedDB blocked'));
    await saveCheckpoint(HASH, record([196, 490], 744, ['a']));
    expect(await loadCheckpoint(HASH, FP)).not.toBeNull();
  });
});

describe('the space a checkpoint was searching', () => {
  beforeEach(() => store.clear());

  const SPACE = {
    mode: 'bands' as const,
    bands: [[240, 245, 250]],
    minGap: 0,
    minAscensions: 2,
    maxAscensions: 2,
    chains: 3,
    chainsPriced: 1,
    stoppedEarly: false,
  };

  const withSpace = (space: typeof SPACE | null, chainsDone = 1, explicitNull = false) =>
    buildCheckpoint({
      fingerprint: FP,
      effort: 'balanced',
      seedChain: [195, 490],
      bestChain: [195, 490],
      bestSeconds: 700 * 86400,
      entries: [{ key: '195,490', seconds: 700 * 86400, legs: [] }],
      stage: 'running',
      detail: '',
      chainsDone,
      ...(space === null ? (explicitNull ? { space: null } : {}) : { space }),
    });

  it('is carried on the record, so a crashed run knows what it was working through', () => {
    expect(withSpace(SPACE).space?.bands).toEqual([[240, 245, 250]]);
  });

  // `undefined` and `null` both mean "no space". Neither may leave a present-but-empty key, which
  // a structuredClone into IndexedDB would keep and `crashedRun` would read as resumable.
  it('is absent rather than empty when there is none', () => {
    expect('space' in withSpace(null)).toBe(false);
    expect('space' in withSpace(null, 1, true)).toBe(false);
  });

  // The periodic write is a merge against whatever is already on disk. Dropping the space there
  // would quietly turn a resumable checkpoint back into an unresumable one a few minutes later.
  it('survives a later write that does not carry one', async () => {
    await saveCheckpoint(HASH, withSpace(SPACE));
    await saveCheckpoint(HASH, withSpace(null, 99));
    const back = await loadCheckpoint(HASH, FP);
    expect(back?.space?.bands).toEqual([[240, 245, 250]]);
    expect(back?.chainsDone).toBe(99);
  });
});
