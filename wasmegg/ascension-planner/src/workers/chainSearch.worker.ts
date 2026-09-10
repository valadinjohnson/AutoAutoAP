/**
 * Web Worker entry point for the chain search: evaluates batches of Truth-Egg checkpoint chains
 * with the app's own simulator.
 *
 * The reason this is a worker at all is the same one researchCalc.worker.ts gives — one chain is
 * roughly fifteen seconds of straight-line CPU, and a whole run is hours, which the main thread
 * cannot absorb without Chrome's "Page Unresponsive" detector firing (that detector only watches the
 * main thread; a worker may peg its own for as long as it likes). The reason there are MANY of these
 * is different: the work is embarrassingly parallel over chains, and the CLI harness gets its speed
 * from `--jobs`.
 *
 * Thin dispatcher only, exactly like researchCalc.worker.ts: `init` builds a `ChainEvaluator` from
 * inputs the MAIN thread resolved out of Pinia, and `evaluate` runs chains through it. Do NOT import
 * `engine/adapter.ts`'s Pinia-bound helpers (`getSimulationContext`, the no-snapshot branch of
 * `createBaseEngineState`) here — they throw immediately outside a Pinia context, which a worker
 * never has. Everything under `auto/`, `engine/compute.ts`, `calculations/` and `lib/artifacts/` is
 * Pinia-free and safe; `stores/autoPlanner.ts` is imported only for its plain exported `pickVariant`
 * function, and a module-level `defineStore(...)` call needs no active Pinia instance.
 *
 * The evaluator is kept ALIVE between messages, holding the prefix memo. That is not an
 * optimisation detail — it is most of why a coordinate-descent sweep is affordable (see
 * search/chain.ts).
 *
 * Loaded via Vite's native worker support, no bundler config needed:
 *   new Worker(new URL('./chainSearch.worker.ts', import.meta.url), { type: 'module' })
 */
import { createChainEvaluator, type ChainEvaluator } from '@/search/chain';
import type { ChainResult } from '@/search/types';
import type { WorkerRequest, WorkerResponse } from './chainSearch.protocol';

// Typed as `Worker` — the DOM-lib interface for a worker as seen from the main thread — rather than
// `DedicatedWorkerGlobalScope`. Same workaround researchCalc.worker.ts uses and for the same reason:
// tsconfig.json's `lib` is `["esnext", "dom"]` for the whole program, and TypeScript's `dom` and
// `webworker` libs declare conflicting globals when both are in scope.
const ctx = self as unknown as Worker;

let evaluator: ChainEvaluator | null = null;

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  try {
    switch (msg.kind) {
      case 'init': {
        evaluator = createChainEvaluator(msg.inputs);
        post({ type: 'init-done', requestId: msg.requestId });
        break;
      }

      case 'evaluate': {
        if (!evaluator) throw new Error('chainSearch worker received evaluate before init');
        const before = evaluator.legSims;
        const results: ChainResult[] = [];
        const total = msg.chains.length;
        for (let i = 0; i < total; i++) {
          // A chain that cannot be simulated is dropped, not reported as an error: the search space
          // legitimately contains unreachable chains (a checkpoint below the player's current TE, a
          // build phase that cannot fit) and the driver's job is to ignore them.
          const r = evaluator.evaluate(msg.chains[i]);
          if (r) results.push(r);
          // Heartbeat. Posted per chain rather than per batch because a batch can be ~2200 chains
          // (stage 6's widest sweep) and the pool has no other way to tell a worker that is
          // thinking from one that has died — see the protocol's own comment for the hang this
          // was added after. Sent AFTER the chain, so a worker that dies mid-chain simply stops.
          post({ type: 'progress', requestId: msg.requestId, done: i + 1, total });
        }
        post({ type: 'result', requestId: msg.requestId, results, legSims: evaluator.legSims - before });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
  }
};
