/**
 * Shared vocabulary for the in-browser chain search (src/search/*).
 *
 * A "chain" is the list of Truth-Egg checkpoints a player ascends through, ending at the final
 * target — `[195, 219, 248, 286, 327, 490]`. Every checkpoint is one ascension ("leg"); the number
 * the search reports is the wall-clock time from the plan start to the end of the last leg.
 *
 * The types here exist for one reason: `scripts/fastsearch.ts` reads all of its inputs out of Pinia
 * (`getSimulationContext()`, `createBaseEngineState(null)`, `useInitialStateStore()`), and a Web
 * Worker has no Pinia instance. So `SearchInputs` is the same information, resolved ONCE on the main
 * thread and shipped over `postMessage` — exactly the split researchCalc.worker.ts already uses, and
 * for the same reason (see its doc comment: the Pinia-bound helpers in engine/adapter.ts throw
 * immediately outside a Pinia context). Everything the simulation itself calls — `auto/ascension.ts`,
 * `auto/shifts/*`, `engine/compute.ts`, `lib/artifacts/*` — is already Pinia-free and safe to import
 * in a worker.
 */
import type { EngineState, SimulationContext } from '@/engine/types';
import type { CurrentFarmState, VirtueEgg } from '@/types';
import type { VariantKey } from '@/stores/autoPlanner';
import type { Availability } from './availability';
import type { Milestone } from './milestones';

/**
 * Everything one leg simulation needs, resolved off the stores.
 *
 * `context.rawBackup` must already be `sanitizeLongs`'d: protobufjs `Long` instances do not survive
 * `structuredClone` with their prototype intact, and `getOptimalELRSet` (called from
 * `auto/shifts/c3.ts` and `auto/shifts/h1.ts` through `context.rawBackup`) reads artifact item ids
 * out of it. Same hazard, same fix as researchCalc.worker.ts documents.
 */
export interface SearchInputs {
  /** `getSimulationContext()`'s result. `ascensionStartTime`/`planStartOffset` are overwritten per
   *  leg, exactly as fastsearch.ts does — the value carried here is irrelevant. */
  context: SimulationContext;
  /** `createBaseEngineState(null)` — the permanent upgrades/artifact-set template every leg starts
   *  from and `deriveNextStartState` copies forward. Deep-cloned per use, never mutated in place. */
  baseState: EngineState;
  /** `useInitialStateStore().currentFarmState` — the live farm, needed only by A1's "continue
   *  current ascension" variant. Null when there is no usable farm state (the search then falls
   *  back to build variants for A1, same as the CLI). */
  currentFarmState: CurrentFarmState | null;
  /** Plan start, unix seconds. Pinned once for a whole run: a plan's duration depends on (chain,
   *  plan start) jointly, and comparing chains evaluated from different starts is meaningless. */
  planStart: number;
  /** The player's TE right now. Checkpoints at or below this are not reachable and get filtered. */
  currentTE: number;
  /** Final target TE, the last entry of every chain. */
  final: number;
  /** Mirrors fastsearch's `--force-continue`: pin A1 to "continue current ascension" rather than
   *  letting the variant search decide. Also the cheapest speedup available — it skips the whole
   *  `runC3Variants` fan-out for A1 (up to six full C3 simulations). */
  forceContinue: boolean;
  /** When the player can act, so prestige instants are pushed into it and the delay is charged.
   *  Null/absent means the simulator's own assumption: the player acts the instant the plan asks.
   *  Changing this changes every duration, so it is part of the run fingerprint. See
   *  search/availability.ts for exactly what it does and does not model. */
  availability?: Availability | null;
  /** Dated TE milestones a chain must meet to be a candidate at all. A chain that misses one is
   *  dropped the same way an unevaluable chain is — see search/milestones.ts for why that is the
   *  whole implementation. */
  milestones?: Milestone[] | null;
  /** Also hold each SHIFT until the player is available, not just each prestige.
   *
   *  This is what turns "a plan that reports your night shifts" into "a plan that has none". It is
   *  a delay model layered on the simulated timeline rather than a re-simulation — see chain.ts for
   *  exactly what that approximates and in which direction it errs. */
  deferShifts?: boolean;
}

/**
 * One shift inside an ascension: the instant, and the virtue egg it switches TO.
 *
 * `fromEgg` exists so the panel can reconstruct the block the leg OPENS on, which is not a shift
 * and therefore is not in this list. A leg that switches eleven times lays twelve eggs, and the
 * first of those needs no action from the player because the ascension already starts there.
 * Without `fromEgg` the panel had no way to name it, so it simply omitted it — and the list then
 * appeared to start on Integrity when every ascension in fact starts on Curiosity.
 */
export interface ShiftMoment {
  at: number;
  egg: string;
  /** The egg being switched away from. Only the first entry's is ever read. */
  fromEgg?: string;
}

/** One leg's headline numbers, kept for the results table. Mirrors fastsearch's CSV `legs` row. */
export interface LegSummary {
  /** Which variant the app's own `pickVariant` chose, e.g. `2-sale-tier13` or `continue`. */
  key: VariantKey;
  /** Total TE at the end of this leg. */
  endTE: number;
  /** Leg duration, seconds. */
  durationSeconds: number;
  /** Peak eggs/second after K3 — the number the CLI's pruning bound is stated against. */
  maxELR: number;
  /** Absolute end instant, unix seconds. */
  endTime: number;
  tier13Unlocked: boolean;

  // ---------------------------------------------------------------- CSV / realism detail
  //
  // All OPTIONAL, and deliberately so. `LegSummary` is what gets written into the IndexedDB
  // checkpoint, and bumping the record version to add these would throw away every checkpoint on
  // disk — including a multi-hour run in progress. Old records simply come back without them, and
  // the CSV leaves those cells blank rather than inventing a value.

  /** Absolute start instant, unix seconds. `endTime - durationSeconds`, carried explicitly so the
   *  CSV does not have to reconstruct it. */
  startTime?: number;
  /** When the build phase ended — the Research Sale boundary this leg's strategy was chosen for. */
  buildPhaseEndTime?: number;
  /** How many sale boundaries the build phase spanned. The same number `key` encodes as
   *  `2-sale-tier13`, as a number. */
  buildPhaseSaleCount?: number;
  /** How many of this leg's twelve shifts land OUTSIDE the player's schedule.
   *
   *  REPORTED, NOT CHARGED, and the distinction is the whole point of the field. A schedule moves
   *  the PRESTIGE instants (see search/availability.ts); the twelve shifts inside an ascension are
   *  scheduled by the simulator's own `te-wait` logic and are not moved, so some will still fall
   *  outside your hours. Without this number a plan built with a schedule would look like it fits
   *  when it does not. 0 when no schedule is set. */
  nightShifts?: number;
  /** Seconds the prestige at the end of this leg waited for the player to become available. 0 when
   *  no schedule is set, or when the leg already ended inside it. */
  sleepDelaySeconds?: number;
  /** Total seconds this leg's SHIFTS were held back waiting for the availability window, when
   *  `deferShifts` is on. Zero otherwise. Separate from `sleepDelaySeconds` (the prestige wait)
   *  because they are different costs: one is you not being there to tap prestige, the other is
   *  you not being there to switch eggs twelve times. Both are already inside `durationSeconds`;
   *  this records how much of it each was. */
  shiftDelaySeconds?: number;
  /** This leg's twelve shifts, in order — when each happens and which egg it switches TO.
   *
   *  Small enough to carry for every chain in a batch and it is the only way the panel can answer
   *  "when am I being asked to do something, and to what", which a count cannot. `nightShifts` is
   *  derived from exactly these. */
  shifts?: ShiftMoment[];
}

/** A fully evaluated chain. `seconds` is what every stage of the driver minimises. */
export interface ChainResult {
  chain: number[];
  seconds: number;
  legs: LegSummary[];
}

/** `chain.join(',')` — the key every cache in the search is addressed by. */
export type ChainKey = string;

/**
 * Effort tiers, ported from `EFFORT`/`EFFORT_NOTE` in scripts/autoplan.py.
 *
 * The stages are strictly NESTED (resolve_last -> descent -> 2-D slices -> count probe), so a tier
 * is a STOP POINT, not a different algorithm. That is the property the UI leans on: stopping a
 * higher tier early always leaves the lower tier's answer already in hand.
 */
export type EffortTier = 'quick' | 'balanced' | 'normal' | 'thorough';

export interface EffortConfig {
  /** Stage 5: exhaustive step-1 2-D slices over adjacent checkpoint pairs. */
  slices2: boolean;
  /** Stage 6: exhaustive 3-D slices. Over budget at every chain length; see EFFORT_NOTES. */
  slices3: boolean;
  /** Descent / 2-D slice radius. 8 in every tier — the replay found the knee at 4 and exactness
   *  at 7, so 8 is one step of margin, not a guess. */
  radius: number;
  /** 3-D slice radius (0 when slices3 is off). */
  radius3: number;
  /** Stage 7: prestige-count probe — drop one checkpoint / insert one, then re-polish. */
  countProbe: boolean;
}

/** What the driver reports back after every batch, for the progress bar and the live best chain. */
export interface SearchProgress {
  stage: string;
  /** Free-form line for the stage's own running commentary, e.g. `pass 2: 742.021`. */
  detail: string;
  /** Chains evaluated so far this run (cache hits excluded — these are real simulations). */
  chainsDone: number;
  /** The driver's own estimate of the chains this configuration still has to evaluate. An
   *  ESTIMATE: the descent's per-pass work depends on how many axes actually move. */
  chainsEstimated: number;
  /** Best chain found anywhere so far, and its duration in days. Always usable. */
  bestChain: number[];
  bestDays: number;
  /** Per-leg breakdown of bestChain, so the panel's leg table updates DURING the run
   *  instead of only when it finishes. Empty until the best chain has been priced. */
  bestLegs: LegSummary[];
}

/** Per-egg TE map, as the summaries carry it. */
export type TEByEgg = Record<VirtueEgg, number>;
