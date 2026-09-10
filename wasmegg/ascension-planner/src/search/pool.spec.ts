/**
 * The pool's watchdog.
 *
 * This exists because of a measured eight-and-a-half-hour hang: a worker died without firing an
 * error event, its promise stayed pending forever, `Promise.all` never settled, and the run sat on
 * `7634 / ~8865 chains` with a stale ETA at 3% CPU. There was nothing in the code that could ever
 * have noticed. These tests are the thing that notices.
 *
 * A fake worker rather than a real one: the real one imports the whole simulator, and the point
 * here is the bookkeeping, not the simulation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainSearchPool } from './pool';
import type { SearchInputs } from './types';
import type { WorkerRequest, WorkerResponse } from '@/workers/chainSearch.protocol';

vi.mock('@/lib/artifacts/utils', () => ({ sanitizeLongs: <T>(v: T) => v }));
vi.mock('./batch', () => ({
  maxPoolSize: () => 2,
  workersForBatch: (batch: number, pool: number) => Math.min(pool, Math.max(1, batch)),
  splitByPrefix: (chains: number[][], workers: number) => {
    const buckets: number[][][] = Array.from({ length: workers }, () => []);
    chains.forEach((c, i) => buckets[i % workers].push(c));
    return buckets.filter(b => b.length);
  },
}));

/** Minimal stand-in for a DedicatedWorker. `mode` decides how it answers an evaluate. */
class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  static instances: FakeWorker[] = [];
  /** 'ok' replies; 'silent' answers init then never speaks again; 'heartbeat' only heartbeats. */
  mode: 'ok' | 'silent' | 'heartbeat' = 'ok';

  constructor() {
    FakeWorker.instances.push(this);
  }

  private emit(msg: WorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }

  postMessage(msg: WorkerRequest): void {
    if (msg.kind === 'init') {
      this.emit({ type: 'init-done', requestId: msg.requestId });
      return;
    }
    if (this.mode === 'silent') return;
    for (let i = 0; i < msg.chains.length; i++) {
      this.emit({ type: 'progress', requestId: msg.requestId, done: i + 1, total: msg.chains.length });
    }
    if (this.mode === 'heartbeat') return;
    this.emit({
      type: 'result',
      requestId: msg.requestId,
      results: msg.chains.map(chain => ({ chain, seconds: 100 * chain.length, legs: [] })),
      legSims: msg.chains.length,
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const INPUTS = { final: 490, currentTE: 175 } as unknown as SearchInputs;

let clock = 0;
const now = () => clock;

/**
 * Assert a rejection, attaching the handler BEFORE the rejection can happen.
 *
 * `await expect(p).rejects...` attaches its handler at the moment it is awaited. If the sweep has
 * already rejected by then, Node reports an unhandled rejection first and only afterwards notices
 * the late handler (`PromiseRejectionHandledWarning`), which Vitest surfaces as a run-level error
 * and warns can cause false positives. Attaching up front keeps the run clean and, more usefully,
 * is what a real caller does — the driver is already awaiting when a worker dies.
 */
function expectRejection(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  return p.then(
    () => {
      throw new Error('expected a rejection, got a resolved batch');
    },
    (err: unknown) => {
      expect(String(err)).toMatch(pattern);
    }
  );
}

/**
 * Let the in-flight sends register, then jump the clock past the stall window and sweep again.
 *
 * The two phases are load-bearing. `send` stamps `lastSeen` from the injected clock, and those
 * sends happen in microtasks AFTER `evaluate()` returns its promise — so moving the clock first
 * moves `lastSeen` with it and the worker never looks stale. Advance once to let the sends land,
 * then move the clock, then advance again.
 */
async function letItGoQuiet(byMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);
  clock += byMs;
  await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);
}

/** Matches WATCHDOG_INTERVAL_MS in pool.ts. */
const WATCHDOG_TICK = 30_000;

function makePool(stallMs = 1000) {
  return createChainSearchPool(INPUTS, {
    spawn: () => new FakeWorker() as unknown as Worker,
    stallMs,
    now,
  });
}

beforeEach(() => {
  FakeWorker.instances = [];
  clock = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createChainSearchPool', () => {
  it('evaluates a batch across workers and merges the replies', async () => {
    const pool = await makePool();
    const out = await pool.evaluate([[195, 490], [196, 490], [197, 490]]);
    expect(out.results).toHaveLength(3);
    expect(out.legSims).toBe(3);
    pool.terminate();
  });

  it('reports progress DURING a batch, not only at the end', async () => {
    // The display bug that hid the hang: stage 6's widest sweep is one ~2200-chain request, and
    // with no intra-batch reporting the counter did not move for half an hour at a time.
    const pool = await makePool();
    const seen: number[] = [];
    await pool.evaluate([[195, 490], [196, 490], [197, 490], [198, 490]], done => seen.push(done));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(4);
    pool.terminate();
  });

  it('rejects a request whose worker goes silent, instead of hanging forever', async () => {
    const pool = await makePool(1000);
    // Two chains -> two workers under the stubbed split; the second never answers.
    const promise = pool.evaluate([[195, 490], [196, 490]]);
    FakeWorker.instances[1].mode = 'silent';
    const settled = expectRejection(promise, /stopped responding/);

    await letItGoQuiet(5000);
    await settled;
    pool.terminate();
  });

  it('names the worker and how far it got, and says progress is checkpointed', async () => {
    // A hang cost a user a night's compute. The message has to say what happened and that the
    // work is not lost, not just fail.
    const pool = await makePool(1000);
    const promise = pool.evaluate([[195, 490], [196, 490]]);
    FakeWorker.instances[1].mode = 'silent';
    const named = expectRejection(promise, /worker 1[\s\S]*chains done/);
    const reassuring = expectRejection(promise, /checkpointed/);
    await letItGoQuiet(5000);
    await named;
    await reassuring;
    pool.terminate();
  });

  it('drops a stalled worker so a later batch does not send into a void', async () => {
    const pool = await makePool(1000);
    const first = pool.evaluate([[195, 490], [196, 490]]);
    FakeWorker.instances[1].mode = 'silent';
    const settled = expectRejection(first, /stopped responding/);
    await letItGoQuiet(5000);
    await settled;

    expect(FakeWorker.instances[1].terminated).toBe(true);
    // Slot freed: the next batch spawns a replacement rather than reusing the dead one.
    const before = FakeWorker.instances.length;
    await pool.evaluate([[195, 490], [196, 490]]);
    expect(FakeWorker.instances.length).toBeGreaterThan(before);
    pool.terminate();
  });

  it('does not fail a worker that is heartbeating, however long the batch runs', async () => {
    // The whole risk of a watchdog is killing healthy work. A heartbeat inside the window must
    // keep the request alive indefinitely.
    const pool = await makePool(1000);
    const worker = FakeWorker.instances[0];
    worker.mode = 'heartbeat';
    const promise = pool.evaluate([[195, 490]]);
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true)
    );

    // Heartbeats landed at clock 0; keep the clock just inside the threshold and sweep repeatedly.
    for (let i = 0; i < 5; i++) {
      clock += 900;
      await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);
      // Re-heartbeat, as a live worker would.
      worker.postMessage({ kind: 'evaluate', requestId: 2, chains: [[195, 490]] } as WorkerRequest);
    }
    expect(settled).toBe(false);
    pool.terminate();
  });

  it('forgives a gap that means the PAGE was suspended, not that a worker died', async () => {
    // The failure this exists for: an observed run reported "no progress for 290 minutes" when the
    // threshold is ten. That is impossible unless the watchdog itself was frozen — Edge had slept
    // the background tab, suspending timers AND workers together. The first tick after resume then
    // killed a worker that had merely been paused.
    const suspensions: number[] = [];
    const pool = await createChainSearchPool(INPUTS, {
      spawn: () => new FakeWorker() as unknown as Worker,
      stallMs: 1000,
      now,
      onSuspend: s => suspensions.push(s),
    });
    const promise = pool.evaluate([[195, 490]]);
    FakeWorker.instances[0].mode = 'silent';
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true)
    );

    // Let the send register, then jump the clock far past BOTH the stall threshold and the gap
    // that marks a suspension.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);
    clock += 290 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);

    expect(settled).toBe(false);
    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]).toBeGreaterThan(17000);
    expect(pool.suspendedSeconds).toBeGreaterThan(17000);
    pool.terminate();
  });

  it('still kills a worker that goes silent AFTER a suspension', async () => {
    // Forgiveness must not be amnesty: once the page is awake again, ten more minutes of silence
    // is real evidence and has to fail loudly.
    const pool = await makePool(1000);
    const promise = pool.evaluate([[195, 490]]);
    FakeWorker.instances[0].mode = 'silent';
    const settled = expectRejection(promise, /stopped responding/);

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);
    clock += 290 * 60 * 1000; // suspension: forgiven
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);
    clock += 5000; // genuine silence, measured by a watchdog that was awake
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK);

    await settled;
    pool.terminate();
  });

  it('terminate rejects everything outstanding and stops the watchdog', async () => {
    const pool = await makePool(1000);
    FakeWorker.instances[0].mode = 'silent';
    const promise = pool.evaluate([[195, 490]]);
    const settled = expectRejection(promise, /terminated/);
    pool.terminate();
    await settled;
    // A sweep after terminate must not throw or resurrect anything.
    clock = 100_000;
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_TICK);
  });

  it('returns an empty outcome for an empty batch without touching a worker', async () => {
    const pool = await makePool();
    const out = await pool.evaluate([]);
    expect(out).toEqual({ results: [], legSims: 0, workersUsed: 0 });
    pool.terminate();
  });
});
