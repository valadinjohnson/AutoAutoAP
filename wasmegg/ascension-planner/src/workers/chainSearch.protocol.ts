/**
 * Message protocol shared between the chain-search worker pool (search/pool.ts) and
 * chainSearch.worker.ts.
 *
 * Same shape as researchCalc.protocol.ts — one request type per kind, `requestId`-tagged so a
 * response can be routed back to the caller still waiting on it — with one structural difference
 * worth calling out: this worker is STATEFUL. It is initialised once with `SearchInputs` (which
 * carries the player's backup, the single largest thing in any of these payloads) and then keeps
 * both those inputs and its own prefix memo across every subsequent `evaluate`. Re-sending the
 * inputs per batch would mean structured-cloning a multi-megabyte backup hundreds of times per run,
 * and re-creating the evaluator per batch would throw away the prefix memo that makes a
 * coordinate-descent sweep cheap in the first place (see search/chain.ts).
 *
 * The other difference is `progress`, and it exists because of an observed 8.5-hour hang. A batch
 * used to be a single silent request: one `postMessage` out, one reply back, nothing in between. So
 * a worker that died WITHOUT firing an error event — killed for memory, or taken down with a frozen
 * or discarded tab — left its promise pending forever, `Promise.all` never settled, and the driver
 * awaited a reply that was never coming. The UI went on showing the last progress line and a stale
 * ETA while nothing at all was computing. A per-chain heartbeat makes that state detectable (see
 * `STALL_MS` in search/pool.ts) and, as a side benefit, lets the counter move DURING a batch —
 * stage 6's widest sweep is a single ~2200-chain request that used to freeze the display for half
 * an hour at a time, which is exactly what made the real hang so hard to spot.
 */
import type { ChainResult, SearchInputs } from '@/search/types';

export interface InitRequest {
  kind: 'init';
  requestId: number;
  /** `context.rawBackup` must already be `sanitizeLongs`'d by the sender — protobufjs `Long`
   *  instances lose their prototype crossing `postMessage`, and `getOptimalELRSet` reads item ids
   *  off it. Same hazard researchCalc.worker.ts documents. */
  inputs: SearchInputs;
}

export interface EvaluateRequest {
  kind: 'evaluate';
  requestId: number;
  /** Pre-sorted depth-first by the caller so the worker's prefix memo actually hits. */
  chains: number[][];
}

export type WorkerRequest = InitRequest | EvaluateRequest;

export interface InitDoneMessage {
  type: 'init-done';
  requestId: number;
}

/**
 * One chain finished. Sent as the batch runs, not at the end.
 *
 * Does NOT settle the request — the pool treats it as liveness plus a progress tick and leaves the
 * pending entry in place. Cheap enough to send per chain: one small object every fifteen-odd
 * seconds of solid CPU.
 */
export interface ProgressMessage {
  type: 'progress';
  requestId: number;
  /** Chains completed in this request so far. */
  done: number;
  /** Chains in this request altogether. */
  total: number;
}

export interface EvaluateResultMessage {
  type: 'result';
  requestId: number;
  /** One entry per chain that evaluated successfully. Chains whose simulation failed are simply
   *  absent — the driver treats a missing chain as "not a candidate", never as an error. */
  results: ChainResult[];
  /** Distinct legs this worker actually simulated for this batch (cache hits excluded). Purely for
   *  the UI's cost readout and for calibrating the live time estimate. */
  legSims: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
}

export type WorkerResponse = InitDoneMessage | ProgressMessage | EvaluateResultMessage | WorkerErrorMessage;
