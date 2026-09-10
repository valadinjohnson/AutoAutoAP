/**
 * The chain-search worker pool: `navigator.hardwareConcurrency` workers, the browser's answer to the
 * CLI harness's `--jobs 12`.
 *
 * Deliberately NOT a composable, unlike useResearchCalcWorker.ts. That one ties its worker's
 * lifetime to a component via `onUnmounted`, which is right for a computation that only matters
 * while a tab is open. A chain search runs for HOURS and must survive the user navigating around the
 * planner, so its lifetime belongs to the run, not to a component — the store (stores/chainSearch.ts)
 * creates a pool when a run starts and terminates it when the run stops. The request/response
 * bookkeeping below is otherwise the same pattern: `requestId`-tagged messages, a `pending` map, and
 * a worker-level `onerror` that rejects everything outstanding rather than leaving callers hanging.
 *
 * Every worker is initialised with the same `SearchInputs` once, then reused for every batch, so
 * each keeps its own prefix memo warm. See search/batch.ts for how a batch is split between them and
 * why the split is by prefix subtree rather than round-robin.
 *
 * THE WATCHDOG, AND THE HANG IT EXISTS FOR. `onerror` only fires for errors the worker's own thread
 * reports. It does NOT fire when a worker disappears — killed for memory, or taken down with a tab
 * the browser froze or discarded. That left the promise in `pending` unresolved AND unrejected, so
 * `Promise.all` over the batch never settled and the driver awaited a reply that was never coming.
 * Observed in the wild: a Thorough run sat at `7634 / ~8865 chains`, on the same progress line and
 * the same stale `~4h 31m left`, for eight and a half hours at 3% CPU. There was no error, no
 * timeout and no way to tell it apart from a slow batch. So every worker now heartbeats per chain
 * (see chainSearch.protocol.ts) and a request with no traffic for `STALL_MS` is failed loudly.
 */
import { sanitizeLongs } from '@/lib/artifacts/utils';
import { sortChainsDepthFirst } from './chain';
import { maxPoolSize, splitByPrefix, workersForBatch } from './batch';
import type { ChainResult, SearchInputs } from './types';
import type { EvaluateResultMessage, WorkerRequest, WorkerResponse } from '@/workers/chainSearch.protocol';

/**
 * Silence from a worker that long means it is gone, not busy.
 *
 * One chain is 15-25 seconds of CPU and every chain sends a heartbeat, so a healthy worker is never
 * quiet for more than about half a minute. Ten minutes is therefore ~25x the longest legitimate gap
 * — generous enough to survive a badly swapping machine or a laptop that suspended briefly, tight
 * enough that a dead worker costs minutes instead of a night. The `init` message has no heartbeat of
 * its own, but it completes in seconds, so it is covered by the same bound.
 */
const STALL_MS = 10 * 60 * 1000;

/** How often the watchdog looks. Coarse on purpose: it is checking a ten-minute threshold. */
const WATCHDOG_INTERVAL_MS = 30 * 1000;

/**
 * A gap between watchdog ticks longer than this means the PAGE was suspended, not that a worker
 * died.
 *
 * This distinction cost a real overnight run. The watchdog fires every 30 s and stalls a worker
 * after 10 min of silence, yet an observed failure read "no progress for 290 minutes" — which is
 * impossible if the watchdog itself had been running. It had not: the browser froze the background
 * tab (Edge's sleeping tabs, or the machine sleeping), which suspends `setInterval` and the workers
 * alike. On resume the very first tick saw five hours of wall clock and killed a worker that had
 * merely been paused, before it could get a heartbeat out.
 *
 * So elapsed wall time is only evidence of death when the watchdog was awake to measure it. Three
 * ticks' worth of slack absorbs ordinary timer throttling in a background tab; anything beyond that
 * is a suspension and gets forgiven rather than counted.
 */
const SUSPEND_GAP_MS = 3 * WATCHDOG_INTERVAL_MS;

interface PendingEntry {
  resolve: (message: WorkerResponse) => void;
  reject: (err: Error) => void;
  /** Last time ANY message arrived for this request — a heartbeat counts. */
  lastSeen: number;
  /** For the failure message, so the user learns which worker and how far it got. */
  label: string;
  done: number;
  total: number;
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingEntry>;
  index: number;
}

export interface BatchOutcome {
  results: ChainResult[];
  /** Distinct legs simulated across the whole batch — the real cost, cache hits excluded. */
  legSims: number;
  /** How many workers this batch actually used, for the UI's "12 workers" readout. */
  workersUsed: number;
}

export interface PoolOptions {
  /** Override worker construction. Exists for the watchdog's tests, which need a worker that can
   *  be made to go silent on demand; production passes nothing. */
  spawn?: () => Worker;
  /** Called when the page is detected to have been suspended, with how long for. The run continues;
   *  this exists so the UI can explain the missing hours instead of leaving the user to guess why
   *  an overnight run did nothing. */
  onSuspend?: (gapSeconds: number) => void;
  /** Override the stall threshold. Tests use a small one. */
  stallMs?: number;
  /** Injectable clock, so the tests do not have to wait ten minutes. */
  now?: () => number;
}

export interface ChainSearchPool {
  /** Upper bound on workers. Workers are spawned lazily, so this is a ceiling, not a headcount. */
  readonly size: number;
  /** How many workers actually exist right now. */
  readonly spawned: number;
  /** Seconds the page was suspended during this run — time in which nothing at all progressed. */
  readonly suspendedSeconds: number;
  /** Evaluate a set of chains, split across as many workers as the batch is worth. Resolves with
   *  only the chains that evaluated successfully. `onChainDone` fires as the batch progresses, so a
   *  caller can show movement during a single wide request. */
  evaluate(chains: number[][], onChainDone?: (done: number, total: number) => void): Promise<BatchOutcome>;
  terminate(): void;
}

export async function createChainSearchPool(inputs: SearchInputs, opts: PoolOptions = {}): Promise<ChainSearchPool> {
  const size = maxPoolSize();
  const stallMs = opts.stallMs ?? STALL_MS;
  const now = opts.now ?? (() => Date.now());
  let nextRequestId = 0;
  let terminated = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  /** Total wall time the page spent suspended during this run. Reported, never charged. */
  let suspendedSeconds = 0;

  // Workers are spawned ON DEMAND, not up front.
  //
  // This used to be `Array.from({length: size}, ...)`, which on a 20-core machine created 19
  // workers the instant a run started - each one importing the whole simulator module graph (the
  // same code that compiles to a 6.2 MB bundle) and each then handed a full copy of the sanitised
  // backup by the init broadcast below. Stages 4-7 run 13-17 chain batches that `workersForBatch`
  // only ever wants 4-7 workers for, so most of that memory was allocated and never used, and the
  // tab is what paid for it.
  const live: (PoolWorker | null)[] = Array.from({ length: size }, () => null);
  const spawning: (Promise<PoolWorker> | null)[] = Array.from({ length: size }, () => null);

  function makeWorker(index: number): PoolWorker {
    const worker = opts.spawn
      ? opts.spawn()
      : new Worker(new URL('../workers/chainSearch.worker.ts', import.meta.url), { type: 'module' });
    const pw: PoolWorker = { worker, pending: new Map(), index };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const entry = pw.pending.get(msg.requestId);
      // A stray or duplicate response is expected to be harmless, not merely tolerated: a batch
      // abandoned by `terminate()` can still land here.
      if (!entry) return;

      // A heartbeat proves liveness and moves the counter; it does NOT settle the request.
      if (msg.type === 'progress') {
        entry.lastSeen = now();
        entry.done = msg.done;
        entry.total = msg.total;
        onProgress?.(pw.index, msg.done, msg.total);
        return;
      }

      pw.pending.delete(msg.requestId);
      if (msg.type === 'error') entry.reject(new Error(msg.message));
      else entry.resolve(msg);
    };

    // A worker-level failure (a bad worker bundle, an out-of-memory kill the thread lives long
    // enough to report) has no requestId to route by. Reject everything outstanding on that worker
    // so the driver's `await` — and the progress UI riding on it — fails loudly instead of hanging
    // for the rest of the afternoon. A worker that dies WITHOUT firing this is what the watchdog
    // is for.
    worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || 'Chain search worker error');
      for (const entry of pw.pending.values()) entry.reject(err);
      pw.pending.clear();
    };

    return pw;
  }

  /** Set while a batch is in flight, so heartbeats can be forwarded to the caller. */
  let onProgress: ((workerIndex: number, done: number, total: number) => void) | null = null;

  /** When the watchdog last actually ran. A big jump means the page was frozen, not that time
   *  passed normally. */
  let lastSweepAt = now();

  function sweepStalled(): void {
    const t = now();
    const sinceLastSweep = t - lastSweepAt;
    lastSweepAt = t;

    // The page was suspended: the workers were frozen too, so none of that wall time is evidence
    // that anything died. Credit every pending request with the gap and skip this round. If a
    // worker really is gone, the next ten minutes of genuine silence will say so properly.
    if (sinceLastSweep > SUSPEND_GAP_MS) {
      for (const pw of live) {
        if (!pw) continue;
        for (const entry of pw.pending.values()) entry.lastSeen += sinceLastSweep;
      }
      suspendedSeconds += sinceLastSweep / 1000;
      opts.onSuspend?.(sinceLastSweep / 1000);
      return;
    }

    for (const pw of live) {
      if (!pw) continue;
      for (const [id, entry] of [...pw.pending]) {
        if (t - entry.lastSeen < stallMs) continue;
        pw.pending.delete(id);
        const quiet = t - entry.lastSeen;
        const forHow = quiet >= 60_000 ? `${Math.round(quiet / 60000)} minutes` : `${Math.round(quiet / 1000)}s`;
        entry.reject(
          new Error(
            `${entry.label} stopped responding: no progress for ${forHow} ` +
              `(${entry.done}/${entry.total} chains done). The worker was very likely killed — ` +
              `most often the browser reclaiming memory, or the tab being frozen or discarded. ` +
              `Your progress is checkpointed, so resuming re-uses every chain already priced.`
          )
        );
        // Do not reuse a worker that has stopped answering: drop it so a later batch spawns a
        // fresh one in its slot rather than sending into a void.
        try {
          pw.worker.terminate();
        } catch {
          // Terminating an already-dead worker is not an error worth surfacing.
        }
        live[pw.index] = null;
        spawning[pw.index] = null;
      }
    }
  }

  /**
   * Armed once and left running until `terminate()`.
   *
   * An earlier version cleared the interval whenever `pending` went empty and re-armed on the next
   * send, which looks tidier and is worse: between two batches the queue IS empty, so the timer was
   * torn down and restarted from zero, pushing detection of a genuinely dead worker out by up to a
   * whole interval. A 30-second no-op for the life of a run costs nothing worth measuring.
   */
  function armWatchdog(): void {
    if (watchdog || terminated) return;
    lastSweepAt = now();
    watchdog = setInterval(sweepStalled, WATCHDOG_INTERVAL_MS);
  }

  function send(pw: PoolWorker, message: WorkerRequest, label: string, total = 0): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      if (terminated) {
        reject(new Error('chain search pool was terminated'));
        return;
      }
      pw.pending.set(message.requestId, { resolve, reject, lastSeen: now(), label, done: 0, total });
      armWatchdog();
      pw.worker.postMessage(message);
    });
  }

  // One `sanitizeLongs` pass on the main thread, shared by every worker's init message.
  //
  // Two separate problems, one fix. (1) protobufjs `Long` int64 fields on the backup (artifact item
  // ids, read by `getOptimalELRSet` through `context.rawBackup`) do not survive `structuredClone`
  // with their prototype intact. (2) Every field here can still be a Vue reactive Proxy — Pinia
  // wraps its whole state tree in `reactive()` — and a reactive Proxy is NOT guaranteed
  // structured-clone-safe; useResearchCalcWorker.ts records `postMessage` throwing `DataCloneError`
  // on exactly that, discovered the hard way. `sanitizeLongs` deep-rebuilds into a plain,
  // Proxy-free, Long-free structure and solves both.
  //
  // Unlike researchCalc's own `prepareForPostMessage`, `context.rawBackup` is NOT dropped here: the
  // simulation path genuinely reads it (`auto/shifts/c3.ts` and `auto/shifts/h1.ts` both call
  // `getOptimalELRSet(context.rawBackup, ...)`), and the "continue current ascension" variant reads
  // the artifact inventory off it too.
  const cleanInputs = sanitizeLongs(inputs);

  /** Create and initialise worker `i` on first use; every later caller awaits the same promise. */
  function workerAt(i: number): Promise<PoolWorker> {
    let p = spawning[i];
    if (!p) {
      p = (async () => {
        const pw = makeWorker(i);
        live[i] = pw;
        await send(pw, { kind: 'init', requestId: ++nextRequestId, inputs: cleanInputs }, `worker ${i} (start-up)`);
        return pw;
      })();
      spawning[i] = p;
    }
    return p;
  }

  // One worker eagerly, so a broken worker bundle or a structured-clone failure on the inputs
  // throws HERE, when the user presses Start, instead of surfacing mid-run an hour later.
  await workerAt(0);

  return {
    size,
    get spawned(): number {
      return live.reduce((n, pw) => n + (pw ? 1 : 0), 0);
    },
    get suspendedSeconds(): number {
      return suspendedSeconds;
    },

    async evaluate(
      chains: number[][],
      onChainDone?: (done: number, total: number) => void
    ): Promise<BatchOutcome> {
      if (!chains.length) return { results: [], legSims: 0, workersUsed: 0 };

      const sorted = sortChainsDepthFirst(chains);
      const wanted = workersForBatch(sorted.length, size);
      const buckets = splitByPrefix(sorted, wanted);

      // Aggregate the per-worker heartbeats into one batch-wide count. Without this the widest
      // sweep in the search (stage 6, one ~2200-chain request) shows no movement at all until it
      // returns, which is precisely what let a dead worker look like a long batch.
      const perWorker = new Map<number, number>();
      if (onChainDone) {
        onProgress = (index, done) => {
          perWorker.set(index, done);
          let total = 0;
          for (const v of perWorker.values()) total += v;
          onChainDone(Math.min(total, sorted.length), sorted.length);
        };
      }

      try {
        const pws = await Promise.all(buckets.map((_, i) => workerAt(i)));
        const sends = buckets.map((bucket, i) =>
          send(
            pws[i],
            { kind: 'evaluate', requestId: ++nextRequestId, chains: bucket },
            `worker ${i}`,
            bucket.length
          )
        );
        // Attach a no-op handler to each send BEFORE awaiting them together. `Promise.all` rejects
        // on the first failure and abandons its siblings; those siblings still reject later (the
        // watchdog, or `terminate()` in the store's `finally`), and an abandoned rejection with no
        // handler surfaces as an unhandled-rejection warning that has nothing to do with the real
        // fault. The `catch` is on a derived promise, so `Promise.all` still sees the rejection.
        for (const p of sends) void p.catch(() => {});
        const replies = await Promise.all(sends);

        const results: ChainResult[] = [];
        let legSims = 0;
        for (const reply of replies) {
          const r = reply as EvaluateResultMessage;
          results.push(...r.results);
          legSims += r.legSims;
        }
        return { results, legSims, workersUsed: buckets.length };
      } finally {
        onProgress = null;
      }
    },

    terminate(): void {
      terminated = true;
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
      for (const pw of live) {
        if (!pw) continue;
        for (const entry of pw.pending.values()) entry.reject(new Error('chain search pool was terminated'));
        pw.pending.clear();
        pw.worker.terminate();
      }
    },
  };
}
