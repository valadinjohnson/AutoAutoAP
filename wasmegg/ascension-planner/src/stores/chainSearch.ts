/**
 * Drives a chain search from the browser: gathers the Pinia-resolved inputs, owns the worker pool,
 * runs the driver, and keeps the live progress the UI renders.
 *
 * WHY THE STORE OWNS THE POOL. useResearchCalcWorker.ts ties its worker to a component via
 * `onUnmounted`, which is right for a computation that only matters while a tab is open. A chain
 * search runs for HOURS; its lifetime belongs to the run, not to whichever component happens to be
 * mounted. So the pool is created in `start()` and terminated in `stop()`/on completion, and the
 * component below it is free to unmount and remount without disturbing anything.
 *
 * ALL PINIA READS HAPPEN HERE, ON THE MAIN THREAD, ONCE. `getSimulationContext()` and
 * `createBaseEngineState(null)` (engine/adapter.ts) throw immediately outside a Pinia context, which
 * a worker never has — the same split researchCalc.worker.ts documents. Everything the simulation
 * itself calls is already Pinia-free.
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { getSimulationContext, createBaseEngineState } from '@/engine/adapter';
import { getLocalTimestampInTimezone } from '@/lib/events';
import { hashID } from '@/lib/storage/db';
import { runChainSearch, type CacheEntry } from '@/search/driver';
import { findStartingChain, planCoarseGrid } from '@/search/coarse';
import { createChainSearchPool, type ChainSearchPool } from '@/search/pool';
import { hardwareThreads, maxPoolSize, clampPoolSize } from '@/search/batch';
import { loadChainBenchmark, saveChainBenchmark } from '@/lib/chainBenchmarkCache';
import { EFFORT, estimateChains } from '@/search/effort';
import {
  buildCheckpoint,
  clearCheckpoint,
  fingerprintRun,
  loadCheckpoint,
  restoreEntries,
  saveCheckpoint,
  type SearchCheckpoint,
} from '@/search/persistence';
import {
  buildChainsCsv,
  chainsCsvChunks,
  describeLoadoutSlots,
  describeVirtueInventory,
  formatInZone,
  virtueInventory,
  type InventoryCount,
} from '@/search/csv';
import { type ShortlistRow } from '@/search/shortlist';
import { buildView, type ViewId } from '@/search/views';
import {
  buildSubmission,
  scrubIdentifiers,
  submissionFilename,
  summariseProof,
  type SearchSpace,
  type Submission,
} from '@/search/submission';
import { describeAvailability, isConstrained, type Availability } from '@/search/availability';
import { missedMilestones, usableMilestones, type Milestone } from '@/search/milestones';
import { defaultSeedChain, seedChainIssue, usableCheckpoints, fitSeedToLimits } from '@/search/seedChain';
import { buildPool, exhaustiveChainsWithGap, bandedChains, sortByPrefix } from '@/search/exhaustive';
import { applyLegBudget, estimateLegBytes } from '@/search/legBudget';
import { summariseEpicResearch, summariseColleggtibles } from '@/search/progression';
import { listRuns, saveRun, loadRun, deleteRun, defaultRunLabel, type RunSummary } from '@/search/runLibrary';
import { epicResearchDefs } from '@/lib/epicResearch';
import { getColleggtibleTiers } from 'lib/collegtibles';
import {
  getArtifactLoadoutFromBackup,
  getOptimalEarningsSet,
  getOptimalELRSet,
  type EquippedArtifact,
} from '@/lib/artifacts';
import type { EffortTier, LegSummary, PricedChain, SearchInputs } from '@/search/types';
import { useActionsStore } from './actions';
import { useAutoPlannerStore } from './autoPlanner';
import { useInitialStateStore } from './initialState';

/** Don't write to IndexedDB more often than this. A checkpoint costs a JSON round-trip over the
 *  whole cache; a batch takes tens of seconds, so this loses at most one batch on a crash. */
const CHECKPOINT_INTERVAL_MS = 20_000;

/** Weight on the newest batch in the s/chain estimate. High enough to follow a stage change
 *  within a couple of batches, low enough that one slow batch does not dominate. */
const RATE_ALPHA = 0.3;

/** How often to recompute the runners-up table. Slower than the batch rate on purpose — see
 *  `refreshShortlist`. */
const SHORTLIST_INTERVAL_MS = 30_000;

/**
 * Chains that keep their per-leg detail by default. See `legDetailBudget`.
 *
 * Scaled off the machine where the browser will tell us about it. `navigator.deviceMemory` is a
 * coarse, deliberately-fuzzed figure -- 0.25, 0.5, 1, 2, 4, 8 -- and capped at 8 by the spec so it
 * cannot be used to fingerprint a big workstation, which is fine here: the question is only whether
 * this is a 4 GB laptop or something with room to spare. Unavailable in Safari and Firefox, where
 * the middle value is the honest guess.
 */
const DEFAULT_LEG_DETAIL_BUDGET = (() => {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (!gb) return 2000;
  return Math.max(500, Math.min(8000, Math.round(gb * 500)));
})();

/** Shared by `startExhaustive` and `benchmarkMachine` — the exhaustive search's whole configuration,
 *  the browser form of the CLI's `--range`/`--bands` flags. */
export interface ExhaustiveSpec {
  lo: number;
  hi: number;
  step: number;
  minAsc: number;
  maxAsc: number;
  /** Minimum TE between consecutive checkpoints. 0 leaves the enumeration unconstrained. */
  minGap?: number;
  /** Per-checkpoint bands. When present these replace the single pool entirely, and the
   *  ascension count is `bands.length + 1` rather than the min/max range. */
  bands?: number[][];
}

export const useChainSearchStore = defineStore('chainSearch', () => {
  const effort = ref<EffortTier>('balanced');
  const finalTE = ref(490);
  /** Mirrors fastsearch's `--force-continue`: pin A1 to "continue current ascension". On by default
   *  because A1 is the ascension you are already part-way through, and it is also the cheapest
   *  speedup available (it skips A1's whole build-variant fan-out). */
  const forceContinue = ref(true);
  /** Hold the first N checkpoints fixed. Moving X1 re-simulates every downstream leg, and X1 is
   *  usually the best-validated value, so pinning it is often the right trade. */
  const pin = ref(0);

  /**
   * How many ascensions the plan may use, counted as chain length INCLUDING the final target.
   *
   * Two stages read this and they read it differently, which is why it lives here rather than
   * being hardcoded in each. The coarse scan enumerates subsets at these lengths; the count probe
   * uses them as the range it may drop or insert a checkpoint within. Previously the scan was
   * pinned to 5-8 and the probe silently used "one either side of the seed", so a user who wanted
   * to forbid an 8th rebuild had no way to say so.
   */
  /** Override for the driver's `maxLast`. Null means "use the driver's default". Advanced only. */
  const maxLastOverride = ref<number | null>(null);

  const minPrestiges = ref(5);
  const maxPrestiges = ref(8);

  /**
   * When the player can actually act — the schedule the plan has to fit around.
   *
   * OFF by default, and that is not timidity. Turning it on changes the objective the search
   * minimises (every prestige is pushed into the window and the delay is charged), so a plan built
   * with it is not comparable to one built without it, and every accuracy figure in EFFORT_NOTES
   * was measured without it. See search/availability.ts for what it models.
   *
   * Defaults describe someone awake 07:00-23:00 every day, which is the sleep case — the narrower
   * feature this generalises.
   */
  const scheduleEnabled = ref(false);
  const availableFrom = ref(7);
  const availableTo = ref(23);
  /** 0 = Sunday. All seven means "every day", which the constraint check treats as no day filter. */
  const availableDays = ref<number[]>([0, 1, 2, 3, 4, 5, 6]);

  /** The schedule as the search takes it, or null. Timezone comes from the Auto Planner's own
   *  scheduling inputs so the hours mean what the rest of the planner shows. */
  const availability = computed<Availability | null>(() => {
    if (!scheduleEnabled.value) return null;
    const a = {
      days: [...availableDays.value],
      fromHour: availableFrom.value,
      toHour: availableTo.value,
      timezone: useAutoPlannerStore().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    return isConstrained(a) ? a : null;
  });

  /**
   * Hold each SHIFT for the schedule too, not just each prestige.
   *
   * ON by default, because it is what "plan around my schedule" plainly means: without it the
   * search reports night shifts and plans around none of them. With it they are charged, so the
   * answer is a chain whose twelve-per-ascension switches actually land in your hours — usually a
   * different chain, and always a slower-looking one, because work that was invisible is now
   * counted. See chain.ts for what the delay model approximates.
   */
  const deferShifts = ref(true);

  const availabilityLabel = computed(() => describeAvailability(availability.value));

  /** True when the boxes are ticked but describe no restriction at all — every day, all hours.
   *  The panel says so rather than letting the user think a constraint is in force. */
  const scheduleIsEmpty = computed(() => scheduleEnabled.value && availability.value === null);

  /**
   * Dated TE milestones — "be at 248 by the first of June".
   *
   * A HARD filter: a chain that misses one is not a candidate (see search/milestones.ts). That is
   * what makes it steer the search rather than merely annotate the answer, and it is also why the
   * panel has to handle "nothing satisfied them" as a first-class outcome instead of rendering an
   * infinite duration.
   */
  const milestones = ref<Milestone[]>([]);

  /** The ones that could ever be met — a positive TE at or below the final target. The panel warns
   *  about the rest rather than letting the search reject every chain over a typo. */
  const activeMilestones = computed(() => usableMilestones(milestones.value, finalTE.value));

  const droppedMilestones = computed(() =>
    milestones.value.filter(m => !activeMilestones.value.some(a => a.te === m.te && a.by === m.by))
  );

  const isRunning = ref(false);
  const stopRequested = ref(false);
  const error = ref<string | null>(null);

  const stage = ref('');
  const detail = ref('');
  const chainsDone = ref(0);
  const chainsEstimated = ref(0);
  const bestChain = ref<number[]>([]);
  const bestDays = ref(0);
  const bestLegs = ref<LegSummary[]>([]);

  /** Which milestones the CURRENT best chain misses. Normally empty, because a chain that missed one
   *  would have been rejected — it is non-empty only for a best chain that predates the milestone
   *  (a restored checkpoint, or a run stopped before anything feasible was priced). */
  const bestMissed = computed(() => missedMilestones(bestLegs.value, activeMilestones.value));
  /** When true, start() runs the coarse subset scan and ladder check FIRST and uses their
   *  answer as the seed, instead of trusting the chain typed into Target TE. That is the
   *  only way to get a starting chain from nothing - stages 2-3 in the CLI. */
  const findSeedFirst = ref(false);
  /** The coarse scan's own log lines, shown verbatim like the CLI prints them. */
  const coarseLog = ref<string[]>([]);
  /** Every stage/detail line the run has emitted, newest last. The panel shows only the
   *  latest by default; this is what a verbose view reads, and it is the only record of
   *  which combinations were actually tried. Capped so a 3-hour run cannot grow unbounded. */
  const runLog = ref<string[]>([]);
  const lastCompletedStage = ref('none');
  const stoppedEarly = ref(false);
  /** A run that reached the end of its tier, as opposed to stopped, failed or still going. */
  const finishedCleanly = computed(
    () => !isRunning.value && !error.value && !stoppedEarly.value && stage.value.startsWith('done')
  );
  /**
   * Whether a run should take the screen Wake Lock (see `holdScreenLock` below). The operator's
   * call, not a silent default -- some people run this on a laptop they need to actually use, or on
   * a machine where the OS sleep timer is already handled some other way. On by default because
   * the failure mode it prevents (the machine sleeping and freezing every worker for hours,
   * unnoticed) is worse than the failure mode it risks (a screen kept on that didn't need to be).
   */
  const keepAwake = ref(true);

  /**
   * Workers this run may use. The knob, as opposed to `workersInPool`, which is the readback.
   *
   * Separate because the two answer different questions and a run can make them disagree: the pool
   * spawns lazily and a small batch is not worth every worker, so "how many did you end up with" is
   * not "how many may you have". Held to the machine's core count when a pool is built.
   */
  const workerBudget = ref(maxPoolSize());
  /** Logical cores, for the panel to show alongside the knob. */
  const machineThreads = hardwareThreads();
  const workersInPool = ref(maxPoolSize());
  /** Measured on THIS machine, from this run's own batches. Not an assumption carried over from the
   *  CLI's 20-core box. */
  const secondsPerChain = ref(0);
  /** Where `secondsPerChain` came from: a live run's own first chunk, or a "Benchmark my PC" probe
   *  run before anything started. Both write the identical quantity; this is only so the UI can say
   *  which one it is showing. */
  const rateSource = ref<'benchmark' | 'live' | null>(null);
  /** A "Benchmark my PC" probe in flight. Mutually exclusive with `isRunning`: only one pool runs at
   *  a time. */
  const benchmarking = ref(false);
  const benchmarkError = ref<string | null>(null);
  /** `Date.now()` of the last benchmark probe (button-triggered or restored from a previous
   *  session), for the panel's "benchmarked Xs ago" caption. 0 means never. */
  const benchmarkedAt = ref(0);
  const benchmarkChainCount = ref(0);
  const startedAt = ref(0);
  /** A checkpoint from a previous session that matches the current inputs, if any. */
  const resumable = ref<SearchCheckpoint | null>(null);

  /**
   * The saved run currently loaded into the panel, when one is.
   *
   * Held so Resume knows which run's cache is in memory, and so the panel can explain WHY a run
   * cannot be resumed rather than just disabling a button.
   */
  const openedRun = ref<RunSummary | null>(null);
  /** Chains replayed from a checkpoint at the start of this run. They cost nothing to re-obtain,
   *  so they are counted separately from `chainsDone`, which is real simulation. */
  const chainsReplayed = ref(0);

  /**
   * Progress WITHIN the current batch, from the workers' own per-chain heartbeats.
   *
   * `chainsDone` only advances when a whole batch returns, and stage 6's widest sweep is a single
   * ~2200-chain request — so the display could sit motionless for half an hour while everything was
   * healthy. That is precisely what made a real hang invisible: an observed run held the same
   * numbers and the same stale ETA for eight and a half hours and looked no different from a long
   * batch. This moves while the batch runs.
   */
  const batchDone = ref(0);
  const batchTotal = ref(0);

  /**
   * Seconds the browser suspended this tab mid-run — time in which NOTHING progressed.
   *
   * Worth its own readout because it is invisible otherwise and it is the single biggest reason an
   * unattended run comes back with nothing done. Edge's sleeping tabs (and a machine going to
   * sleep) freeze the workers and the page's timers together; the run is not broken, it is simply
   * not running. The panel turns this into the instruction that actually fixes it.
   */
  const suspendedSeconds = ref(0);
  /** The single worst freeze, kept alongside the total: one long stall reads differently from many short ones. */
  const longestStallSeconds = ref(0);
  /** The space an exhaustive run covered, for the submission. Null for every staged run. */
  const searchSpace = ref<SearchSpace | null>(null);

  /**
   * Wall clock around the search, for the submission's run cost.
   *
   * Kept separate from `secondsPerChain`, which is a smoothed live estimate and deliberately
   * forgets the past. These two are the raw bookends, minus whatever `suspendedSeconds` says the
   * browser froze, so a run left in a background tab overnight does not report twelve hours of
   * "compute" it never did.
   */
  const runStartedAt = ref(0);
  const runEndedAt = ref(0);

  /** Minutes actually spent searching, or null when this result did not come from a live run. */
  const runMinutes = computed(() => {
    if (!runStartedAt.value || !runEndedAt.value) return null;
    const elapsed = (runEndedAt.value - runStartedAt.value) / 1000 - suspendedSeconds.value;
    return elapsed > 0 ? elapsed / 60 : null;
  });

  /**
   * What the run cost this machine, for the collector. Null unless a live run finished here:
   * a result replayed from a checkpoint took no time to produce, and reporting that as a fast
   * machine would poison exactly the estimate this exists to improve.
   */
  const runCost = computed(() => {
    const minutes = runMinutes.value;
    if (minutes === null || chainsDone.value <= 0) return null;
    return {
      workers: workersInPool.value,
      cores: typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : null,
      minutes,
      suspendedMinutes: suspendedSeconds.value / 60,
      longestStallMinutes: longestStallSeconds.value / 60,
      secondsPerChain: (minutes * 60) / chainsDone.value,
    };
  });

  let pool: ChainSearchPool | null = null;
  let lastCheckpointAt = 0;
  let lastRateAt = 0;
  let lastRateChains = 0;
  let partitionHash = '';
  let runFingerprint = '';
  /** Set at the top of `startExhaustive`/`start`, so `noteRate` can persist the first live-measured
   *  rate without every caller having to thread a player ID through it. */
  let currentPlayerId = '';

  /**
   * Recent-weighted s/chain, NOT a lifetime average, and measured per PHASE.
   *
   * Per-chain cost varies by stage rather than randomly: the coarse scan is one wide batch
   * with heavy prefix sharing (~1.5 s/chain measured), descent's early axes simulate every
   * trailing leg and its late axes simulate few (16-25 s/chain). A lifetime average lags
   * every transition.
   *
   * `reset` matters more than it looks. The coarse scan counts 0..372 and the driver then
   * starts its own counter at 1, so without a baseline reset the driver's first sample was
   * charged the WHOLE coarse scan - one observed run reported 552.4 s/chain and "~56d 16h
   * left" for work that actually runs at ~16 s/chain.
   */
  function noteRate(done: number, reset = false): void {
    const now = Date.now();
    if (reset) {
      lastRateAt = now;
      lastRateChains = done;
      return;
    }
    const d = done - lastRateChains;
    if (d <= 0) return;
    const observed = (now - lastRateAt) / 1000 / d;
    const wasUnset = !secondsPerChain.value;
    secondsPerChain.value = secondsPerChain.value
      ? secondsPerChain.value * (1 - RATE_ALPHA) + observed * RATE_ALPHA
      : observed;
    lastRateChains = done;
    lastRateAt = now;

    // The first real measurement for this run beats whatever a pre-run benchmark guessed — record
    // where it came from, and persist it the same way `benchmarkMachine` does, so a live-measured
    // rate also survives a reload rather than only the button's own probe.
    if (wasUnset) {
      rateSource.value = 'live';
      benchmarkedAt.value = now;
      benchmarkChainCount.value = done;
      if (currentPlayerId) {
        saveChainBenchmark(currentPlayerId, {
          secondsPerChain: secondsPerChain.value,
          source: 'live',
          at: now,
          chainCount: done,
          workers: workersInPool.value,
          currentTE: currentTE.value,
          finalTE: finalTE.value,
        });
      }
    }
  }

  /**
   * True when milestones are set and the run has no finite answer.
   *
   * `bestDays` stays at 0 while nothing has been priced, and a run whose every candidate was
   * rejected never prices anything — so without this the panel would sit on "0.000 d" and look
   * like it was still starting up. It is a real outcome and deserves a real message.
   */
  const noFeasibleChain = computed(
    () => activeMilestones.value.length > 0 && !isRunning.value && chainsDone.value > 0 && bestDays.value <= 0
  );

  function noteBatch(done: number, total: number): void {
    batchDone.value = done;
    batchTotal.value = total;
  }

  /**
   * Bar fill, 0..1.
   *
   * FULL when the run finished, whatever the counter says. `chainsEstimated` is an UPPER BOUND —
   * coordinate descent stops the moment no checkpoint moves — so a run that starts from an already
   * converged chain legitimately ends after a fraction of it. An observed run showed
   * `DONE  99 / ~606 chains` with the bar at 16%, which reads as "it gave up", when in fact it had
   * finished and simply had nothing left to try.
   */
  const progressFraction = computed(() => {
    if (finishedCleanly.value) return 1;
    if (!chainsEstimated.value) return 0;
    return Math.min(1, chainsDone.value / chainsEstimated.value);
  });

  /** Live remaining-time estimate, seconds. Zero until at least one batch has been timed — an
   *  estimate with no measurement behind it is worse than no estimate. */
  const secondsRemaining = computed(() => {
    if (!secondsPerChain.value) return 0;
    return Math.max(0, chainsEstimated.value - chainsDone.value) * secondsPerChain.value;
  });

  const currentTE = computed(() => {
    const snapshot = useActionsStore().effectiveSnapshot;
    if (!snapshot?.teEarned) return 0;
    return (Object.values(snapshot.teEarned) as number[]).reduce((a, b) => a + b, 0);
  });

  /** Plan start, taken from the Auto Planner tab's own scheduling inputs so the two agree. A plan's
   *  duration depends on (chain, plan start) jointly — comparing chains scored from different
   *  starts is meaningless, which is why the whole run pins one. */
  const planStart = computed(() => {
    const s = useAutoPlannerStore();
    const tz = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!s.startDate || !s.startTime) return Math.floor(Date.now() / 1000);
    return getLocalTimestampInTimezone(s.startDate, s.startTime, tz);
  });

  /**
   * True when the Auto Planner has no start date/time and the plan is therefore timed from NOW.
   *
   * Quietly consequential, and it bit a real user twice in one evening. Plan start is part of the
   * run fingerprint, so an unset one moves every time the page reloads: a 778-chain checkpoint
   * became unreachable after a rebuild (start slid from 10:39 to 17:44), and the same chain then
   * reported 737.269 d instead of 737.564 d — not an improvement, just a stopwatch started seven
   * hours later. Both finish on the same instant, which is why the panel tells you to compare
   * finish dates.
   */
  /**
   * The plan start the CURRENT results were computed against, pinned when the run began.
   *
   * Needed because `planStart` falls back to "now" when the Auto Planner has no start set, and the
   * Auto Planner then restores a CACHED start on mount — so the two can silently disagree. Observed:
   * a search ran against Sep 9 19:04 while the plan built from its answer used Sep 3 21:29, six days
   * apart, which makes every date in the built plan answer a different question. `applyChain` pins
   * the planner to this value so the plan is built for the problem the search actually solved.
   */
  const planStartUsed = ref(0);

  const planStartIsNow = computed(() => {
    const s = useAutoPlannerStore();
    return !s.startDate || !s.startTime;
  });

  /** The chain the search starts from: whatever the user has typed in the Auto Planner's Target TE
   *  field. `autoplan.py` reaches its own seed with a coarse subset scan (stage 2, measured 15 min
   *  for 372 chains) plus a ladder check; that stage is NOT ported yet, so the seed comes from the
   *  user instead. See the honesty note in ChainSearchPanel.vue. */
  /** Overrides the Auto Planner's Target TE field. The panel's own "starting chain" box writes
   *  here: it used to be a read-only readout, so the only way to change the seed was to find the
   *  Target TE field in a different card - and a seed of "206 490" cannot reach a 7-prestige
   *  answer, because descent only MOVES checkpoints and the probe adds at most one. */
  const seedOverride = ref('');

  const seedChain = computed(() => {
    const raw = (seedOverride.value.trim() || useAutoPlannerStore().targetTE || '')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0);
    // A checkpoint at or below current TE is not an ascension anyone can perform, and asking the
    // simulator to reach a target already behind it is what produced the bare "Chain search worker
    // error": the seed box happily held "135" on a 159 TE account.
    const chain = usableCheckpoints(raw, currentTE.value, finalTE.value);
    if (chain.length) return [...chain, finalTE.value];

    // Nothing usable typed. Do NOT fall through to a bare `[finalTE]`: that is a one-ascension
    // chain, descent only moves checkpoints, and the count probe adds at most one, so the Limits
    // box asking for 5-8 could never be satisfied from it. Build a chain of the right length.
    return defaultSeedChain({
      currentTE: currentTE.value,
      finalTE: finalTE.value,
      minPrestiges: minPrestiges.value,
      maxPrestiges: maxPrestiges.value,
    });
  });

  /** Why the current seed cannot produce an answer inside the Limits box, or null when it can.
   *  Probe-aware: on Quick and Balanced nothing in the run changes the seed's length at all. */
  const seedIssue = computed(() =>
    findSeedFirst.value
      ? null
      : seedChainIssue(seedChain.value, minPrestiges.value, maxPrestiges.value, {
          countProbe: EFFORT[effort.value].countProbe,
        })
  );

  /**
   * The saved run library. Separate from `resumable`, which is one crash-recovery slot tied to an
   * exact fingerprint; these are kept deliberately and reload at any time. See search/runLibrary.ts.
   */
  const savedRuns = ref<RunSummary[]>([]);

  async function refreshSavedRuns(playerId: string): Promise<void> {
    savedRuns.value = await listRuns(await hashID(playerId));
  }

  async function saveCurrentRun(playerId: string, label?: string): Promise<RunSummary | null> {
    if (!bestChain.value.length || bestDays.value <= 0) return null;
    const summary = await saveRun(await hashID(playerId), {
      label: label?.trim() || defaultRunLabel(finalTE.value, bestChain.value, bestDays.value),
      currentTE: currentTE.value,
      finalTE: finalTE.value,
      effort: effort.value,
      seedChain: seedChain.value,
      bestChain: bestChain.value,
      bestDays: bestDays.value,
      entries: allEntries(),
      bestLegs: bestLegs.value,
      runLog: runLog.value,
      complete: finishedCleanly.value,
      // What it was searching and under what inputs. Without these a saved run can be LOOKED AT and
      // not picked back up -- which is how an interrupted overnight run became an afternoon of
      // re-pricing chains that were already sitting in the file.
      ...(searchSpace.value ? { space: searchSpace.value } : {}),
      fingerprint: fingerprint(playerId),
    });
    await refreshSavedRuns(playerId);
    return summary;
  }

  /**
   * Reload a saved run into the panel as a finished result.
   *
   * Does NOT restart anything: the cache, the best chain and the log are restored and the panel
   * renders them exactly as it would at the end of the run that produced them. The shape chart and
   * the runners-up read the same cache, so both come back too.
   */
  async function openSavedRun(playerId: string, id: string): Promise<boolean> {
    // Recorded here as well as when a run starts. `resumeBlocker` compares the saved run's
    // fingerprint against the CURRENT inputs, and it needs a player id to compute one -- without
    // this it had none until a search had already run, so the guard silently passed and a run whose
    // plan start had since moved looked perfectly resumable. Measured: changing the start date
    // after opening a saved run left `canResumeOpenedRun` true.
    currentPlayerId = playerId;
    const summary = savedRuns.value.find(r => r.id === id);
    const body = await loadRun(await hashID(playerId), id);
    if (!summary || !body) return false;

    liveCache = body.entries;
    coarseCache = [];
    // Restored so the panel can say what this run covered, and so Resume has a space to hand back
    // to `startExhaustive`. Absent on a staged run and on anything saved before library version 2.
    searchSpace.value = summary.space ? { ...summary.space } : null;
    openedRun.value = summary;
    bestChain.value = [...summary.bestChain];
    bestDays.value = summary.bestDays;
    bestLegs.value = body.bestLegs;
    runLog.value = [...body.runLog];
    chainsDone.value = body.entries.length;
    chainsEstimated.value = body.entries.length;
    csvRows.value = body.entries.length;
    error.value = null;
    stoppedEarly.value = !summary.complete;
    stage.value = summary.complete ? 'done' : 'stopped';
    // A reloaded run took no time HERE, so its cost is not this machine's and must not be submitted
    // as though it were.
    runStartedAt.value = 0;
    runEndedAt.value = 0;
    refreshShortlist(true);
    return true;
  }

  /**
   * An interrupted exhaustive run this machine can carry straight on with.
   *
   * `resumable` is the raw checkpoint; this is the narrower question the panel asks: is there one,
   * did it not finish, and does it know what it was searching. The last part is what a checkpoint
   * written before `space` existed cannot answer -- it still replays if you happen to set up the
   * identical space by hand, but it cannot offer to do it for you.
   */
  const crashedRun = computed(() => {
    const cp = resumable.value;
    return cp && !cp.complete && cp.space ? cp : null;
  });

  /** Carry on an interrupted run from its checkpoint. The durations replay inside
   *  `startExhaustive`; this only has to hand back the space the checkpoint recorded. */
  async function resumeCrashedRun(playerId: string): Promise<boolean> {
    const sp = crashedRun.value?.space;
    if (!sp) return false;
    await startExhaustive(playerId, {
      lo: sp.range?.lo ?? 0,
      hi: sp.range?.hi ?? 0,
      step: sp.range?.step ?? 1,
      minAsc: sp.minAscensions,
      maxAsc: sp.maxAscensions,
      minGap: sp.minGap,
      ...(sp.mode === 'bands' && sp.bands?.length ? { bands: sp.bands.map(b => [...b]) } : {}),
    });
    return true;
  }

  /**
   * Why the loaded run can or cannot be continued, in a form the panel can print.
   *
   * Three separate reasons, kept separate on purpose. "Finished" and "saved before this was
   * possible" and "your settings have changed since" are different situations with different
   * answers, and collapsing them into a disabled button teaches the player nothing.
   */
  const resumeBlocker = computed<string | null>(() => {
    const run = openedRun.value;
    if (!run) return 'no run is loaded';
    if (run.complete) return 'this run finished — there is nothing left to price';
    if (!run.space) {
      return 'this run was saved before the space was recorded, so there is nothing to continue from — set the same bands and start again, and anything it already priced will be replayed';
    }
    if (!currentPlayerId) return 'no player id, so there is no way to check the run is still valid';
    if (run.fingerprint && run.fingerprint !== fingerprint(currentPlayerId)) {
      // The unset-plan-start case gets its own sentence because blaming the player for a change
      // they did not make is worse than saying nothing. With no start set, `planStart` is the moment
      // the page loaded, so it moves on every reload and the fingerprint moves with it -- the run is
      // genuinely unresumable, but the cause is a missing setting rather than an edited one.
      return planStartIsNow.value
        ? 'no plan start is set, so the plan is timed from the moment this page loaded — which is a different clock from the one this run was priced against. Set a start date and time (or load a backup) and save runs against that'
        : 'the plan start, TE or schedule has changed since this run, so its durations no longer describe the same problem';
    }
    return null;
  });

  const canResumeOpenedRun = computed(() => resumeBlocker.value === null);

  /**
   * Continue an unfinished saved run where it stopped.
   *
   * The entries are already in `liveCache` from `openSavedRun`; `startExhaustive` replays anything
   * it finds there whose key is in the space, so this only has to hand back the SAME space the run
   * was enumerating. Handing back the panel's current form instead would be a different search that
   * happened to reuse a cache.
   */
  async function resumeOpenedRun(playerId: string): Promise<boolean> {
    const run = openedRun.value;
    if (!run?.space || !canResumeOpenedRun.value) return false;
    const sp = run.space;
    await startExhaustive(playerId, {
      lo: sp.range?.lo ?? 0,
      hi: sp.range?.hi ?? 0,
      step: sp.range?.step ?? 1,
      minAsc: sp.minAscensions,
      maxAsc: sp.maxAscensions,
      minGap: sp.minGap,
      ...(sp.mode === 'bands' && sp.bands?.length ? { bands: sp.bands.map(b => [...b]) } : {}),
    });
    return true;
  }

  async function deleteSavedRun(playerId: string, id: string): Promise<void> {
    await deleteRun(await hashID(playerId), id);
    await refreshSavedRuns(playerId);
  }

  /** Rewrite the seed box so the chain sits inside the Limits box. Drives the panel's one-click fix. */
  function fitSeedToLimitsNow(): void {
    seedOverride.value = fitSeedToLimits(seedChain.value, minPrestiges.value, maxPrestiges.value)
      .slice(0, -1)
      .join(' ');
  }

  /** Chains the coarse scan will price, or 0 when it is not going to run. */
  const coarseChains = computed(() => {
    if (!findSeedFirst.value) return 0;
    try {
      return planCoarseGrid({
        currentTE: currentTE.value,
        final: finalTE.value,
        minPrestiges: minPrestiges.value,
        maxPrestiges: maxPrestiges.value,
      }).chains;
    } catch {
      return 0; // no room for a grid; findStartingChain will report it properly
    }
  });

  /** An UPPER BOUND, not a target. Descent stops when no axis moves, so a run routinely
   *  finishes well short of this - one measured run ended at 483 of an estimated 606. The
   *  coarse scan is added when it is enabled: without it the estimate was derived from the
   *  chain typed into Target TE and read "~101" for a run about to price 372 in stage 2. */
  const estimateForCurrentSettings = computed(() => {
    // With the coarse scan on, the post-scan chain length is what stages 4+ work on, and
    // that is the scan's ladder pick - unknown up front. Its own grid spans 5-8 prestiges,
    // so price stages 4+ against the middle of that rather than the typed chain.
    const n = findSeedFirst.value ? 6 : Math.max(1, seedChain.value.length - 1);
    return coarseChains.value + estimateChains(n, EFFORT[effort.value]);
  });

  function fingerprint(playerId: string): string {
    return fingerprintRun({
      playerId,
      planStart: planStart.value,
      currentTE: currentTE.value,
      final: finalTE.value,
      forceContinue: forceContinue.value,
      availability: availability.value,
      milestones: activeMilestones.value,
      deferShifts: deferShifts.value,
    });
  }

  /** Look for a resumable checkpoint for the current inputs. Safe to call whenever the panel opens
   *  or the settings change. */
  async function checkResumable(playerId: string): Promise<void> {
    resumable.value = null;
    if (!playerId) return;
    try {
      partitionHash = await hashID(playerId);
      resumable.value = await loadCheckpoint(partitionHash, fingerprint(playerId));
    } catch (e) {
      // A missing/blocked IndexedDB must not stop somebody running a search.
      console.warn('chain search: could not read checkpoint', e);
    }
  }

  /** Build the payload every worker is initialised with. Everything Pinia here, nothing beyond. */
  function collectInputs(): SearchInputs {
    const initialStateStore = useInitialStateStore();
    return {
      context: getSimulationContext(),
      baseState: createBaseEngineState(null),
      currentFarmState: initialStateStore.currentFarmState,
      planStart: planStart.value,
      currentTE: currentTE.value,
      final: finalTE.value,
      forceContinue: forceContinue.value,
      availability: availability.value,
      milestones: activeMilestones.value,
      deferShifts: deferShifts.value,
    };
  }

  /**
   * The full cache, per-leg detail included, kept for the CSV export.
   *
   * A plain `let`, NOT a ref. This is thousands of entries with a leg array each, and wrapping it
   * in Vue's reactivity would deep-proxy the lot on every batch for data no template reads —
   * `csvRows` is the only thing the UI needs to know, and that is one number.
   */
  let liveCache: CacheEntry[] = [];
  /** The coarse scan's own results. Kept SEPARATELY because they never enter the driver's cache —
   *  stage 2 evaluates through the pool directly — so `liveCache` would otherwise replace them and
   *  the export would be missing the several hundred chains the scan priced. */
  let coarseCache: CacheEntry[] = [];
  const csvRows = ref(0);

  /**
   * The runners-up, recomputed on a timer rather than per batch.
   *
   * `pickShortlist` walks the whole cache, and `onCache` fires after every batch with thousands of
   * entries — recomputing there would put an O(n log n) pass plus a reactive write on the hot path
   * for a table nobody is watching second by second. Refreshed on the same beat as the checkpoint.
   */
  const shortlist = ref<ShortlistRow[]>([]);
  let lastShortlistAt = 0;

  /** Which preset view the runners-up table is showing. Persisted for the session only: it is a
   *  way of looking at one run's results, not a setting that should outlive the run. */
  const shortlistView = ref<ViewId>('balanced');

  /**
   * Every chain this run priced, flattened for the shape chart.
   *
   * Refreshed on the shortlist's beat rather than per batch for the same reason it is: `onCache`
   * fires with the whole cache after every batch, and a reactive write of thousands of points on
   * that path would cost more than the chart is worth.
   */
  const pricedChains = ref<PricedChain[]>([]);

  /**
   * How many chains keep their PER-LEG DETAIL in memory. 0 means all of them.
   *
   * This is the run's memory budget, expressed in the unit the run is actually made of. A priced
   * chain is two numbers -- its key and its duration -- plus a `legs` array that is most of its
   * weight: each leg carries its twelve shifts as objects, so the detail is on the order of
   * kilobytes per chain while the answer is on the order of tens of bytes.
   *
   * An overnight exhaustive run prices hundreds of thousands of chains, and keeping full detail
   * for every one of them is what makes a tab die at 4am with no error -- the renderer is killed,
   * which is why the page comes back as "This page is having a problem" rather than anything this
   * code could catch and report.
   *
   * THE CHECKPOINT HAS ALWAYS DONE THIS. `buildCheckpoint` writes `durations` for every chain and
   * `bestLegs` for one, and `restoreEntries` brings the rest back with `legs: []` -- so leg-less
   * entries are a shape this codebase already produces, already resumes from, and already renders
   * (the CSV prints blank per-leg cells and says why). All this does is stop the IN-MEMORY cache
   * being the one place that keeps everything.
   *
   * WHAT IS LOST, stated plainly: the runners-up table can only show per-leg timings for chains
   * still holding detail. The kept set is the FASTEST ones, which is what that table shows, so in
   * practice the loss lands on chains nobody was going to open.
   */
  const legDetailBudget = ref(DEFAULT_LEG_DETAIL_BUDGET);

  /** Chains currently holding per-leg detail, and a measured estimate of what that costs. */
  const legsHeld = ref(0);
  const legDetailBytes = ref(0);

  /**
   * Apply the budget to both caches.
   *
   * Runs on the shortlist's beat rather than per batch: the rule is an O(n log n) pass over the
   * whole cache, which is exactly what `pickShortlist` already costs there, and doing it per batch
   * would put that on the hot path for nothing -- memory freed a few seconds later is still freed
   * long before it matters.
   *
   * The rule itself, and why it keeps the fastest rather than the newest, is in search/legBudget.ts.
   */
  function pruneLegDetail(): void {
    const entries = [...liveCache, ...coarseCache];
    const { held } = applyLegBudget(entries, legDetailBudget.value);
    legsHeld.value = held;
    legDetailBytes.value = estimateLegBytes(entries, held);
  }

  function refreshShortlist(force = false): void {
    const now = Date.now();
    if (!force && now - lastShortlistAt < SHORTLIST_INTERVAL_MS) return;
    lastShortlistAt = now;
    // Before the views are built, so the table is built from what is actually being kept rather
    // than from detail that is about to be dropped underneath it.
    pruneLegDetail();
    const entries = allEntries();
    shortlist.value = buildView(entries, shortlistView.value, {
      planStart: planStartUsed.value || planStart.value,
      timezone: useAutoPlannerStore().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    pricedChains.value = entries
      .filter(e => e.seconds > 0)
      .map(e => {
        const chain = e.key.split(',').map(Number);
        return {
          chain,
          days: e.seconds / 86400,
          prestiges: chain.length,
          // The last checkpoint before the target: the axis every measured sawtooth is drawn
          // against, so the user's own run can be read the same way as the explainer's figures.
          lastCheckpoint: chain.length > 1 ? chain[chain.length - 2] : chain[0],
        };
      });
  }

  /** Coarse-scan results plus driver cache, de-duplicated by chain, driver winning. */
  function allEntries(): CacheEntry[] {
    const byKey = new Map<string, CacheEntry>();
    for (const e of coarseCache) byKey.set(e.key, e);
    for (const e of liveCache) byKey.set(e.key, e);
    return [...byKey.values()];
  }

  /**
   * The run's chain -> duration cache as CSV text.
   *
   * Built from this session's own results (per-leg detail intact), falling back to a resumable
   * checkpoint's flattened durations when nothing has run yet — that fallback is why
   * `buildChainsCsv` emits leg-less rows instead of skipping them.
   */
  /**
   * What the simulator has to work with: the virtue inventory, plus the best earnings set it can
   * build out of it.
   *
   * Computed ON DEMAND rather than as a computed ref, because `getOptimalEarningsSet` solves a
   * combinatorial set problem over the whole inventory and would run on every unrelated store
   * change. The panel calls this once when the section is first opened.
   *
   * NOTE ON WHAT THIS IS NOT. It is today's inventory, held fixed for a plan that runs two years.
   * The search never varies artifacts — see `inventoryCaveat` for why that matters and which way
   * it errs.
   */
  function readInventory(): {
    artifacts: InventoryCount[];
    stones: InventoryCount[];
    earnings: EquippedArtifact[] | null;
    elr: EquippedArtifact[] | null;
    equippedNow: EquippedArtifact[] | null;
  } {
    const context = getSimulationContext();
    const raw = context.rawBackup ?? null;
    const { artifacts, stones } = virtueInventory(raw);
    if (!raw) return { artifacts, stones, earnings: null, elr: null, equippedNow: null };

    const equippedNow = getArtifactLoadoutFromBackup(raw);
    // Exactly the two calls `buildContinueVariant` in search/leg.ts makes, with the same options,
    // so this shows the sets the search is actually running rather than a plausible-looking pair.
    // `assumeMaxHabsVehicles: false` and the CURRENT research levels are what make this leg 1's
    // set specifically; later legs re-solve against their own research and will differ.
    const farmState = useInitialStateStore().currentFarmState;
    const elr =
      getOptimalELRSet(raw, {
        commonResearch: farmState?.commonResearches,
        epicResearchLevels: context.epicResearchLevels,
        colleggtibleModifiers: context.colleggtibleModifiers,
        currentSet: equippedNow,
        assumeMaxHabsVehicles: false,
      }) ?? equippedNow;

    return { artifacts, stones, earnings: getOptimalEarningsSet(raw), elr, equippedNow };
  }

  /**
   * Build the shareable summary of this run.
   *
   * Deliberately NOT the CSV. The CSV is the run's full working -- ten thousand rows, every
   * candidate, local timestamps on every leg -- and it exists so the player can audit their own
   * search. A submission is the handful of fields a leaderboard needs, assembled by whitelist in
   * `search/submission.ts`, so a field added to the CSV later cannot leak by being forgotten
   * about here.
   */
  function buildRunSubmission(nickname?: string): Submission | null {
    if (!bestChain.value.length || bestDays.value <= 0) return null;
    const inv = readInventory();
    const initialStateStore = useInitialStateStore();
    return buildSubmission({
      nickname,
      chain: [...bestChain.value],
      seconds: bestDays.value * 86400,
      legs: bestLegs.value,
      planStart: planStartUsed.value || planStart.value,
      timezone: useAutoPlannerStore().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      currentTE: currentTE.value,
      finalTE: finalTE.value,
      effort: effort.value,
      availability: isConstrained(availability.value) ? availability.value : null,
      holdShifts: deferShifts.value,
      artifacts: inv.artifacts,
      stones: inv.stones,
      // Already solved by readInventory() above, so this costs nothing extra -- `elr` is leg 1's
      // delivery set and `earnings` is the same in every leg.
      delivery: describeLoadoutSlots(inv.elr),
      earnings: describeLoadoutSlots(inv.earnings),
      chainsPriced: csvRows.value,
      // Null for a checkpoint replay, and left off entirely in that case, so the board never reads
      // "0 minutes for 400 chains" as a very fast machine.
      ...(runCost.value ? { run: runCost.value } : {}),
      // Omitted alongside a space, for the reason `seed` documents: an exhaustive run enumerates
      // rather than descends, so it has no starting guess to report and the typed chain would be
      // a starting point the search never used.
      ...(searchSpace.value ? {} : { seed: [...seedChain.value] }),
      ...(searchSpace.value ? { space: searchSpace.value } : {}),
      // Only alongside a space. The block describes the distribution over an ENUMERATED set, and
      // the same numbers taken from a staged run would be the distribution over whatever the
      // heuristic chose to look at -- a spread that says more about the pruning than the game.
      ...(searchSpace.value
        ? {
            proof: summariseProof(
              allEntries().map(e => ({ chain: e.key.split(',').map(Number), days: e.seconds / 86400 })),
              bestChain.value
            ),
          }
        : {}),
      // Read straight off the loaded backup. Null when there is no backup to read, never guessed:
      // "all maxed" asserted for an account nobody looked at would be worse than saying nothing.
      epicResearch: summariseEpicResearch(
        epicResearchDefs.map(d => ({
          id: d.id,
          name: d.name,
          level: initialStateStore.epicResearchLevels[d.id] ?? 0,
          maxLevel: d.maxLevel,
        }))
      ),
      colleggtibles: initialStateStore.rawBackup
        ? summariseColleggtibles(getColleggtibleTiers(initialStateStore.rawBackup))
        : null,
    });
  }

  /**
   * Where a submission is sent, or empty when nowhere is configured.
   *
   * Read from the build's environment rather than hardcoded, because this project is forked and
   * self-hosted and there is no single collector anyone should be posting to by default. With it
   * unset the UI falls back to "save the file and share it yourself", which needs no server at
   * all and is the only mode that works offline.
   */
  const submitUrl = (import.meta.env.VITE_SUBMIT_URL as string | undefined)?.trim() || '';

  /** The board itself, derived from the submit endpoint rather than configured separately: they
   *  are the same Worker, and two env vars that have to agree is one more thing to get wrong. */
  const leaderboardUrl = computed(() => submitUrl.replace(/\/submit\/?$/, '/'));

  /**
   * Ship it. Resolves to a short status string for the UI; never throws.
   *
   * The CSV goes as a SEPARATE request rather than as a field in the JSON, for two reasons: it is
   * megabytes of text that would have to be escaped into a string first, and the headline result
   * is worth keeping even when the bulky half fails. A failed CSV upload therefore downgrades the
   * message rather than failing the whole submission.
   */
  async function sendSubmission(payload: Submission, csv?: string): Promise<{ ok: boolean; message: string }> {
    if (!submitUrl) return { ok: false, message: 'no collector configured' };
    let id: string | undefined;
    try {
      const res = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // Say WHY. The collector answers a rejection with the list of problems -- "unknown
        // schema 1", "chain must strictly increase" -- and reporting only the status code turned
        // an answerable message into a wall. A stale build submitting an old schema looked
        // exactly like a broken collector.
        const detail = (await res.json().catch(() => ({}))) as { problems?: string[] };
        const why = detail.problems?.length ? `: ${detail.problems.join('; ')}` : '';
        return { ok: false, message: `collector said ${res.status}${why}` };
      }
      id = ((await res.json().catch(() => ({}))) as { id?: string }).id;
    } catch (e) {
      // Ordinary: someone is offline, or the collector is down. It must not look like the run
      // broke.
      return { ok: false, message: e instanceof Error ? e.message : 'could not reach the collector' };
    }

    if (!csv) return { ok: true, message: 'sent' };
    if (!id) return { ok: true, message: 'sent (no id came back, so the CSV was skipped)' };
    try {
      const csvUrl = `${submitUrl.replace(/\/submit\/?$/, '/csv')}?id=${encodeURIComponent(id)}`;
      const body = await gzip(scrubIdentifiers(csv));
      const res = await fetch(csvUrl, {
        method: 'POST',
        // Deliberately not `content-encoding: gzip`, which would invite something in the path to
        // helpfully inflate the body before the Worker sees it. These are gzip bytes being posted
        // as data, not a transfer encoding, and the type says so.
        headers: { 'content-type': 'application/gzip' },
        body,
      });
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      return res.ok
        ? { ok: true, message: `sent, with the full CSV (${mb(body.byteLength)} MB compressed)` }
        : { ok: true, message: `sent, but the CSV was refused (${res.status})` };
    } catch {
      return { ok: true, message: 'sent, but the CSV upload failed' };
    }
  }

  /**
   * Compress the CSV in the browser rather than on the collector.
   *
   * Measured on real output: 11,000 chains is 15.3 MB of text and 0.66 MB gzipped, about 23x,
   * because a chain table is overwhelmingly repeated numbers and timestamps. That is the
   * difference between a submission that needs R2 (and a payment method on the Cloudflare
   * account) and one that fits KV's 25 MB per-value limit with room to spare.
   *
   * It has to happen HERE and not in the Worker: the free Workers plan allows roughly 10ms of CPU
   * per request, and compressing fifteen megabytes would spend that many times over. Doing it
   * client-side also means the upload itself is 23x smaller, which matters more on a home
   * connection than the CPU does.
   *
   * `scrubIdentifiers` runs BEFORE compression, because it cannot run after: the Worker's own
   * `EI\d{16}` sweep is a regex over text, and an opaque gzip stream is not text. The CSV never
   * carried a player id in the first place -- `buildChainsCsv` has no playerId in its metadata --
   * so this is the same belt-and-braces it always was, just enforced one step earlier.
   */
  async function gzip(text: string): Promise<ArrayBuffer> {
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    void writer.write(new TextEncoder().encode(text));
    void writer.close();
    return await new Response(stream.readable).arrayBuffer();
  }

  function exportCsv(): string {
    const own = allEntries();
    const entries = own.length ? own : resumable.value ? restoreEntries(resumable.value) : [];
    // Read off the backup here, on the main thread: `getSimulationContext()` is Pinia-bound.
    const raw = getSimulationContext().rawBackup ?? null;
    const equipped = raw ? getArtifactLoadoutFromBackup(raw) : null;
    return buildChainsCsv(entries, {
      planStart: planStart.value,
      timezone: useAutoPlannerStore().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      currentTE: currentTE.value,
      final: finalTE.value,
      effort: effort.value,
      forceContinue: forceContinue.value,
      availability: availability.value,
      seedChain: seedChain.value,
      // The ELR set is deliberately NOT listed. `getOptimalELRSet` re-solves the structure per leg
      // against that leg's research state (up to 495 combos, and the reason it is the hotspot in
      // leg.ts), so there is no single "ELR set for the run" to report — and running the search
      // here just to print one would block the main thread for seconds on a button click.
      inventory: raw ? describeVirtueInventory(raw) : undefined,
      loadouts: [
        { label: 'equipped in the backup', loadout: equipped },
        { label: 'best earnings set available', loadout: raw ? getOptimalEarningsSet(raw) : null },
      ],
    });
  }
  /**
   * The same CSV, yielded a chunk at a time, for the download path.
   *
   * The meta block is assembled identically -- it is the same run being described -- so this is
   * deliberately a thin sibling of `exportCsv` rather than a second source of truth for what the
   * file says. Only the delivery differs: see `chainsCsvChunks` for why the download must not go
   * through one giant string.
   */
  function* exportCsvChunks(): Generator<string> {
    const own = allEntries();
    const entries = own.length ? own : resumable.value ? restoreEntries(resumable.value) : [];
    // Read off the backup here, on the main thread: `getSimulationContext()` is Pinia-bound.
    const raw = getSimulationContext().rawBackup ?? null;
    const equipped = raw ? getArtifactLoadoutFromBackup(raw) : null;
    yield* chainsCsvChunks(entries, {
      planStart: planStart.value,
      timezone: useAutoPlannerStore().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      currentTE: currentTE.value,
      final: finalTE.value,
      effort: effort.value,
      forceContinue: forceContinue.value,
      availability: availability.value,
      seedChain: seedChain.value,
      // The ELR set is deliberately NOT listed. `getOptimalELRSet` re-solves the structure per leg
      // against that leg's research state (up to 495 combos, and the reason it is the hotspot in
      // leg.ts), so there is no single "ELR set for the run" to report — and running the search
      // here just to print one would block the main thread for seconds on a button click.
      inventory: raw ? describeVirtueInventory(raw) : undefined,
      loadouts: [
        { label: 'equipped in the backup', loadout: equipped },
        { label: 'best earnings set available', loadout: raw ? getOptimalEarningsSet(raw) : null },
      ],
    });
  }

  /** Suggested filename, so two exports from different runs do not collide in Downloads. */
  function csvFilename(): string {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return `chain-search-${effort.value}-${stamp}.csv`;
  }

  async function persist(entries: CacheEntry[], force = false, complete = false): Promise<void> {
    if (!partitionHash) return;
    // Nothing priced yet. start() seeds bestDays at 0, so persisting here would write the
    // typed chain with a zero duration and - before saveCheckpoint learned to merge - would
    // clobber a better answer from a previous run. saveCheckpoint now refuses to regress, but
    // there is still no reason to write a placeholder.
    if (bestDays.value <= 0) return;
    const now = Date.now();
    if (!force && now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt = now;
    try {
      await saveCheckpoint(
        partitionHash,
        buildCheckpoint({
          // So a crash leaves something that can carry on, not just a cache nobody can aim at.
          space: searchSpace.value,
          fingerprint: runFingerprint,
          effort: effort.value,
          seedChain: seedChain.value,
          bestChain: bestChain.value,
          bestSeconds: bestDays.value * 86400,
          entries,
          stage: stage.value,
          detail: detail.value,
          chainsDone: chainsDone.value,
          complete,
        })
      );
    } catch (e) {
      console.warn('chain search: could not write checkpoint', e);
    }
  }

  /**
   * Start (or resume) a run.
   *
   * `resume` reuses the stored chain->duration cache. Because every stage is deterministic given
   * that cache, the driver simply re-runs from the top: already-priced chains come back as cache
   * hits with no simulation, and the run continues from where it stopped.
   */
  /**
   * Price EVERY chain over a pool. No staged search, no descent, no pruning.
   *
   * The browser twin of the CLI's `--exhaustive`. The staged search returns a strong local optimum
   * and says so; this returns the true optimum of the space it enumerates, because it prices all of
   * it. It shares the enumeration with the CLI (`search/exhaustive.ts`) so the two cannot drift
   * into covering different spaces.
   *
   * NO SAFETY CAP. The CLI refuses past 5,000 chains without `--yes`, which is right for a flag you
   * can typo. This is a form that shows the count and the estimate as you type, on a page reached
   * only by URL, so the guard would only ever be in the way of someone who already knows.
   *
   * Progress, cache, best-so-far and the stop button are the same state the staged search writes,
   * so every results panel works unchanged.
   */
  /** Best priced chain in `liveCache`, pushed into the fields the panels read. */
  function noteBest(): void {
    let bestSeconds = Infinity;
    let bestEntry: CacheEntry | null = null;
    for (const e of liveCache) {
      if (e.seconds > 0 && e.seconds < bestSeconds) {
        bestSeconds = e.seconds;
        bestEntry = e;
      }
    }
    if (!bestEntry) return;
    bestChain.value = bestEntry.key.split(',').map(Number);
    bestDays.value = bestEntry.seconds / 86400;
    bestLegs.value = bestEntry.legs;
  }

  /**
   * Bands-vs-pool chain building, shared by `startExhaustive` and `benchmarkMachine` so the two can
   * never enumerate different spaces for what is supposed to be the same configuration.
   *
   * `limit` bounds the DFS walk itself (see exhaustive.ts), not a slice taken after the fact — the
   * benchmark passes one specifically so a space of billions of chains never gets enumerated just to
   * sample the first few dozen.
   */
  function buildChainsForSpec(spec: ExhaustiveSpec, limit = Infinity): { chains: number[][]; error: string | null } {
    const minGap = Math.max(0, Math.floor(spec.minGap ?? 0));

    if (spec.bands?.length) {
      const chains = sortByPrefix(bandedChains(spec.bands, finalTE.value, currentTE.value, minGap, limit));
      if (!chains.length) {
        return {
          chains: [],
          error:
            'No chains: the bands leave nothing strictly increasing once the minimum gap and your current TE are applied.',
        };
      }
      return { chains, error: null };
    }

    const poolValues = buildPool({ lo: spec.lo, hi: spec.hi, step: spec.step }, currentTE.value, finalTE.value);
    if (!poolValues.length) {
      return {
        chains: [],
        error: `The pool is empty once values outside (${currentTE.value}, ${finalTE.value}) are dropped.`,
      };
    }
    const chains = sortByPrefix(
      exhaustiveChainsWithGap(poolValues, spec.minAsc, spec.maxAsc, finalTE.value, currentTE.value, minGap, limit)
    );
    if (!chains.length) {
      return {
        chains: [],
        error: minGap
          ? `No chains: nothing in the pool is ${minGap} TE apart at that ascension count.`
          : 'No chains: the ascension range asks for more checkpoints than the pool can supply.',
      };
    }
    return { chains, error: null };
  }

  async function startExhaustive(playerId: string, spec: ExhaustiveSpec): Promise<void> {
    if (isRunning.value) return;
    currentPlayerId = playerId;

    const minGap = Math.max(0, Math.floor(spec.minGap ?? 0));
    const built = buildChainsForSpec(spec);
    if (built.error) {
      error.value = built.error;
      return;
    }
    const chains = built.chains;

    // Stated before a single chain is priced, so the submission says what was ASKED for even when
    // the run is stopped halfway. chainsPriced and stoppedEarly are filled in at the end.
    searchSpace.value = {
      mode: spec.bands?.length ? 'bands' : 'range',
      ...(spec.bands?.length
        ? { bands: spec.bands.map(b => [...b]) }
        : { range: { lo: spec.lo, hi: spec.hi, step: spec.step } }),
      minGap,
      minAscensions: spec.bands?.length ? spec.bands.length + 1 : spec.minAsc,
      maxAscensions: spec.bands?.length ? spec.bands.length + 1 : spec.maxAsc,
      chains: chains.length,
      chainsPriced: 0,
      stoppedEarly: false,
    };

    error.value = null;
    stopRequested.value = false;
    stoppedEarly.value = false;
    isRunning.value = true;
    startedAt.value = Date.now();
    chainsDone.value = 0;
    chainsReplayed.value = 0;
    runLog.value = spec.bands?.length
      ? [`--- exhaustive: ${spec.bands.length} bands, ${spec.bands.length + 1} ascensions`]
      : [`--- exhaustive: ${spec.minAsc}-${spec.maxAsc} ascensions`];
    if (minGap) runLog.value.push(`minimum gap ${minGap} TE between checkpoints`);
    runLog.value.push(`${chains.length.toLocaleString()} chains, no pruning`);
    secondsPerChain.value = 0;
    rateSource.value = null;

    // CARRY FORWARD WHAT IS ALREADY PRICED, rather than starting from an empty cache.
    //
    // This line used to be `liveCache = []` unconditionally, and that is what made an unfinished
    // saved run un-continuable: opening one fills `liveCache` with every chain it managed to price,
    // and pressing Start threw all of it away and re-simulated from nothing. The checkpoint was the
    // only thing that ever got replayed, and a checkpoint is one slot per player that any later run
    // overwrites -- so a run saved deliberately, by name, was the one kind that could not be picked
    // back up.
    //
    // Guarded by the FINGERPRINT, which is the whole reason it is safe. A cached duration only means
    // anything against the plan start, TE, schedule and shift handling it was measured under, and
    // every one of those is editable between saving a run and reopening it. Same fingerprint, the
    // numbers describe the same problem and replaying them is free; different, and they are dropped
    // rather than quietly mixed into a ranking with chains priced under another clock.
    const carried = new Map<string, CacheEntry>();
    const currentFingerprint = fingerprint(playerId);
    if (!openedRun.value || !openedRun.value.fingerprint || openedRun.value.fingerprint === currentFingerprint) {
      for (const e of [...liveCache, ...coarseCache]) if (e.seconds > 0) carried.set(e.key, e);
    }
    liveCache = [];
    coarseCache = [];
    // Cleared once the carry-forward above has been taken: from here this is a LIVE run, not a
    // saved one sitting in the panel, and leaving it set would go on offering to resume something
    // that is already running.
    openedRun.value = null;
    csvRows.value = 0;
    shortlist.value = [];
    lastShortlistAt = 0;
    batchDone.value = 0;
    batchTotal.value = 0;
    suspendedSeconds.value = 0;
    longestStallSeconds.value = 0;
    runStartedAt.value = Date.now();
    runEndedAt.value = 0;
    lastRateAt = Date.now();
    lastRateChains = 0;

    planStartUsed.value = planStart.value;
    chainsEstimated.value = chains.length;
    bestChain.value = [];
    bestDays.value = 0;
    bestLegs.value = [];
    stage.value = 'starting workers';
    detail.value = '';

    // Checkpointing, which this path did without for one release and should not have. An exhaustive
    // over a banded space is a six-to-eight hour commitment; the first version kept every priced
    // chain in memory and wrote nothing until the operator pressed Save, so an unattended machine
    // that restarted lost the lot. The staged search has always checkpointed on a timer. This now
    // does the same, and replays what it finds instead of re-simulating it.
    // Seeded from memory first, then topped up from the checkpoint. Order matters only in that the
    // checkpoint wins a tie, and a tie means the same chain priced under the same inputs twice --
    // identical numbers either way.
    const alreadyPriced = new Map<string, CacheEntry>(carried);
    try {
      partitionHash = await hashID(playerId);
      runFingerprint = currentFingerprint;
      const saved = await loadCheckpoint(partitionHash, runFingerprint);
      if (saved) {
        for (const e of restoreEntries(saved)) if (e.seconds > 0) alreadyPriced.set(e.key, e);
      }
    } catch (e) {
      console.warn('chain search: could not prepare storage', e);
    }

    // Replay before pricing: a chain already in the checkpoint costs nothing to carry forward, and
    // the counter has to include it or a resumed run looks like it lost its progress.
    const toPrice: number[][] = [];
    for (const chain of chains) {
      const hit = alreadyPriced.get(chain.join(','));
      if (hit) liveCache.push(hit);
      else toPrice.push(chain);
    }
    chainsReplayed.value = liveCache.length;
    chainsDone.value = liveCache.length;
    csvRows.value = liveCache.length;
    if (chainsReplayed.value) {
      runLog.value.push(`replayed ${chainsReplayed.value.toLocaleString()} chains from a previous run`);
      noteBest();
      refreshShortlist(true);
    }

    holdRunLock();
    void holdScreenLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    try {
      pool = await createChainSearchPool(collectInputs(), {
        size: workerBudget.value,
        onSuspend: gap => {
          suspendedSeconds.value += gap;
          longestStallSeconds.value = Math.max(longestStallSeconds.value, gap);
          runLog.value.push(`--- the browser suspended this tab for ${Math.round(gap / 60)} minutes`);
        },
      });
      workersInPool.value = pool.size;
      stage.value = 'pricing every chain';

      // Chunked so progress is visible and so the pool re-deals by prefix each time. Sorted above,
      // which is what makes the evaluator's prefix memo pay: siblings land in the same chunk.
      //
      // DELIBERATELY SMALLER THAN THE CLI'S `jobs * 8`. The chunk is the unit of both the progress
      // counter and the stop check, and at 19 workers `* 8` is 152 chains -- about two minutes
      // during which the bar reads "0 / 6,006" and Stop does nothing. In a terminal that is a
      // quiet stretch between printed lines; in a UI it looks broken. `* 2` keeps every worker fed
      // (the pool splits a batch by prefix internally) while checking the stop flag four times as
      // often, at the cost of a little prefix sharing across chunk boundaries.
      const chunk = Math.max(pool.size * 2, 32);
      for (let i = 0; i < toPrice.length && !stopRequested.value; i += chunk) {
        const slice = toPrice.slice(i, i + chunk);
        const { results } = await pool.evaluate(slice, noteBatch);
        for (const r of results) liveCache.push({ key: r.chain.join(','), seconds: r.seconds, legs: r.legs });

        chainsDone.value = chainsReplayed.value + Math.min(i + chunk, toPrice.length);
        csvRows.value = liveCache.length;
        noteRate(chainsDone.value);
        noteBest();
        detail.value = `${chainsDone.value.toLocaleString()} / ${chains.length.toLocaleString()}`;
        refreshShortlist();
        // On the checkpoint timer, not every chunk. Losing at most a few minutes of pricing to a
        // crash is the trade; losing eight hours is not.
        void persist(liveCache);
      }

      stoppedEarly.value = stopRequested.value;
      if (searchSpace.value) {
        searchSpace.value.chainsPriced = liveCache.length;
        searchSpace.value.stoppedEarly = stopRequested.value;
      }
      stage.value = stopRequested.value ? 'stopped' : 'done';
      refreshShortlist(true);
      await persist(liveCache, true, !stopRequested.value);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      stage.value = 'failed';
    } finally {
      runEndedAt.value = Date.now();
      pool?.terminate();
      pool = null;
      isRunning.value = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      dropRunLock();
      dropScreenLock();
    }
  }

  /**
   * Prices the same first chunk `startExhaustive` would, through a throwaway pool, and uses the
   * result to seed `secondsPerChain` before the operator commits to a real run.
   *
   * Deliberately not "a chain per worker" or any other synthetic probe shape: `secondsPerChain` is a
   * specific quantity (wall clock for one parallel batch ÷ chains it contained), and matching the
   * real run's own chunk size and prefix-sorted ordering is what makes this number mean the same
   * thing as "what the live rate would read after one chunk" rather than a differently-biased guess.
   */
  async function benchmarkMachine(playerId: string, spec: ExhaustiveSpec): Promise<void> {
    if (isRunning.value || benchmarking.value) return;

    benchmarking.value = true;
    benchmarkError.value = null;
    let bench: ChainSearchPool | null = null;
    try {
      const chunkSize = Math.max(clampPoolSize(workerBudget.value) * 2, 32);
      const built = buildChainsForSpec(spec, chunkSize);
      if (built.error) {
        benchmarkError.value = built.error;
        return;
      }

      bench = await createChainSearchPool(collectInputs(), { size: workerBudget.value });
      const probeStartedAt = performance.now();
      const { results } = await bench.evaluate(built.chains);
      const elapsedSeconds = (performance.now() - probeStartedAt) / 1000;

      if (!results.length) {
        benchmarkError.value = 'No chains in this batch could be evaluated — nothing to benchmark.';
        return;
      }

      secondsPerChain.value = elapsedSeconds / results.length;
      rateSource.value = 'benchmark';
      benchmarkedAt.value = Date.now();
      benchmarkChainCount.value = results.length;
      saveChainBenchmark(playerId, {
        secondsPerChain: secondsPerChain.value,
        source: 'benchmark',
        at: benchmarkedAt.value,
        chainCount: results.length,
        workers: workerBudget.value,
        currentTE: currentTE.value,
        finalTE: finalTE.value,
      });
    } catch (e) {
      benchmarkError.value = e instanceof Error ? e.message : String(e);
    } finally {
      bench?.terminate();
      benchmarking.value = false;
    }
  }

  /**
   * Restores a rate measured in an earlier session, so the estimate does not fall back to the 15 s
   * assumption on every reload. Only ever applied on top of "nothing measured yet" — a rate this
   * session has already established, live or benchmarked, is never overwritten by a stale one.
   */
  function restoreBenchmark(playerId: string): void {
    if (isRunning.value || secondsPerChain.value) return;
    const cached = loadChainBenchmark(playerId);
    if (!cached) return;
    secondsPerChain.value = cached.secondsPerChain;
    rateSource.value = cached.source;
    benchmarkedAt.value = cached.at;
    benchmarkChainCount.value = cached.chainCount;
  }

  /**
   * Keep the browser from freezing this tab while a run is in flight.
   *
   * Chromium's freezing policy has an explicit opt-out list, and one entry on it is a page "holding
   * a Web Lock or an IndexedDB transaction". So a lock held for the life of the run is not a
   * workaround -- it is the documented way to say "this tab is doing something". Without it, a
   * backgrounded tab that has been hidden and silent for five minutes is a candidate for freezing,
   * which is why a run left overnight can be found stopped in the morning with nothing in the log.
   *
   * WHAT THIS DOES NOT DO, and there is no API that does: it cannot prevent DISCARDING. Memory
   * Saver kills a background tab outright under memory pressure, there is no event before it, and
   * the page only learns about it afterwards via `document.wasDiscarded` on the reload. The
   * defences against that are the checkpoint and the memory budget, not this.
   *
   * Best-effort throughout. `navigator.locks` is absent in older browsers and the request can be
   * refused; a run that cannot take a lock still runs.
   */
  let releaseRunLock: (() => void) | null = null;

  function holdRunLock(): void {
    if (releaseRunLock) return;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return;
    try {
      // Resolved with a promise the lock is held until: `request` keeps the lock for as long as the
      // callback's promise is pending, so the release function is the resolver.
      void locks.request(
        'ascension-planner:chain-search',
        () =>
          new Promise<void>(resolve => {
            releaseRunLock = resolve;
          })
      );
    } catch {
      /* A run without a lock is a run that might get frozen, not a run that cannot start. */
    }
  }

  function dropRunLock(): void {
    releaseRunLock?.();
    releaseRunLock = null;
  }

  /**
   * Keep the SCREEN awake while a run is visible.
   *
   * A different problem from the Web Lock above, with a different owner. The lock argues with the
   * browser about freezing a backgrounded tab; this argues with the operating system about dimming
   * and locking the display, which on a desktop is usually the step before the machine suspends --
   * and a suspended machine stops everything, workers included. It is the difference between a run
   * that is slower in the morning and a run that did nothing for six hours.
   *
   * ONLY WORKS WHILE THE TAB IS VISIBLE, by design of the API: the lock is released automatically
   * when the tab is hidden or the window minimised, and cannot be taken again until it is back. So
   * it is re-requested on `visibilitychange` rather than taken once, and a run left with the tab in
   * the background genuinely has no screen lock -- there is no API that does.
   *
   * IT DOES NOT STOP THE MACHINE SLEEPING ON ITS OWN TERMS. A sleep timer that fires regardless of
   * display state, a lid close, or a manual sleep will still suspend everything; the run resumes
   * where it left off from the checkpoint, and `onSuspend` reports the gap rather than pretending it
   * did not happen. The README says which OS setting actually covers that.
   */
  let screenLock: WakeLockSentinel | null = null;

  async function holdScreenLock(): Promise<void> {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!keepAwake.value || !wakeLock || screenLock || document.visibilityState !== 'visible') return;
    try {
      screenLock = await wakeLock.request('screen');
      // The browser releases it on its own when the tab hides; drop our handle so the
      // visibilitychange path knows to ask again rather than believing it still holds one.
      screenLock.addEventListener('release', () => {
        screenLock = null;
      });
    } catch {
      /* Refused, unsupported, or the tab lost visibility mid-request. Not worth failing a run for. */
    }
  }

  function dropScreenLock(): void {
    void screenLock?.release().catch(() => {});
    screenLock = null;
  }

  /** Flipping the toggle mid-run takes effect immediately, rather than waiting for the next
   *  visibility change to notice. */
  watch(keepAwake, on => {
    if (!isRunning.value) return;
    if (on) void holdScreenLock();
    else dropScreenLock();
  });

  /**
   * Checkpoint when the tab is hidden, not only on the timer.
   *
   * `visibilitychange` is the last event a page is guaranteed to get: `beforeunload` and `unload`
   * do not fire when a tab is discarded, so anything that waits for them loses the run. Going
   * hidden is also the moment the tab becomes eligible for everything that can kill it, which makes
   * it the one point where a save is worth paying for off-schedule.
   */
  function onVisibilityChange(): void {
    if (!isRunning.value) return;
    if (document.visibilityState === 'hidden') void persist(liveCache, true);
    // Coming back into view is the only moment a screen lock can be taken again.
    else void holdScreenLock();
  }

  async function start(playerId: string, options: { resume?: boolean } = {}): Promise<void> {
    if (isRunning.value) return;
    currentPlayerId = playerId;

    error.value = null;
    stopRequested.value = false;
    stoppedEarly.value = false;
    isRunning.value = true;
    startedAt.value = Date.now();
    chainsDone.value = 0;
    chainsReplayed.value = 0;
    runLog.value = [];
    // A staged run proves nothing over a stated space, and must not inherit the last one's.
    searchSpace.value = null;
    secondsPerChain.value = 0;
    rateSource.value = null;
    // A fresh run's export must not carry the previous run's rows: the settings that give every
    // duration its meaning (plan start, excluded hours, final target) may all have changed.
    liveCache = [];
    coarseCache = [];
    openedRun.value = null;
    csvRows.value = 0;
    shortlist.value = [];
    lastShortlistAt = 0;
    batchDone.value = 0;
    batchTotal.value = 0;
    suspendedSeconds.value = 0;
    longestStallSeconds.value = 0;
    runStartedAt.value = Date.now();
    runEndedAt.value = 0;
    lastCheckpointAt = 0;
    lastRateAt = Date.now();
    lastRateChains = 0;

    planStartUsed.value = planStart.value;
    const chain = seedChain.value;
    chainsEstimated.value = estimateChains(Math.max(1, chain.length - 1), EFFORT[effort.value]);
    bestChain.value = [...chain];
    bestDays.value = 0;
    bestLegs.value = [];
    stage.value = 'starting workers';
    detail.value = '';

    let restoredCache: CacheEntry[] | undefined;
    let cacheAtEnd: CacheEntry[] = [];
    // Chains already priced before the driver starts, so its own 0-based counter does not
    // make the progress bar jump backwards after the coarse scan.
    let chainsBase = 0;
    try {
      partitionHash = await hashID(playerId);
      runFingerprint = fingerprint(playerId);
      if (options.resume && resumable.value) {
        restoredCache = restoreEntries(resumable.value);
        bestChain.value = [...resumable.value.bestChain];
        bestDays.value = resumable.value.bestSeconds / 86400;
        bestLegs.value = resumable.value.bestLegs;
        chainsReplayed.value = restoredCache.length;
        detail.value = `resumed with ${restoredCache.length} chains already priced`;
        // Seed the export with what we replayed, so a CSV taken before the first batch reports the
        // replayed chains (durations only - a checkpoint keeps legs for the best chain alone).
        liveCache = [...restoredCache];
        csvRows.value = liveCache.length;
        refreshShortlist(true);
      }
    } catch (e) {
      console.warn('chain search: could not prepare storage', e);
    }

    holdRunLock();
    void holdScreenLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    try {
      pool = await createChainSearchPool(collectInputs(), {
        size: workerBudget.value,
        onSuspend: gap => {
          suspendedSeconds.value += gap;
          longestStallSeconds.value = Math.max(longestStallSeconds.value, gap);
          runLog.value.push(
            `--- the browser suspended this tab for ${Math.round(gap / 60)} minutes; nothing ran in that time`
          );
        },
      });
      workersInPool.value = pool.size;
      stage.value = 'running';

      // Stages 2-3. One wide batch, so it is also the stage that parallelises best.
      let seed = chain;
      if (findSeedFirst.value) {
        stage.value = 'coarse scan';
        coarseLog.value = [];
        const coarse = await findStartingChain({
          currentTE: currentTE.value,
          final: finalTE.value,
          minPrestiges: minPrestiges.value,
          maxPrestiges: maxPrestiges.value,
          evaluateBatch: chains => pool!.evaluate(chains, noteBatch),
          shouldStop: () => stopRequested.value,
          onProgress: (done, total, d) => {
            chainsDone.value = done;
            chainsEstimated.value = total + estimateChains(Math.max(1, chain.length - 1), EFFORT[effort.value]);
            detail.value = d;
            noteRate(done);
          },
          onResults: results => {
            for (const r of results) coarseCache.push({ key: r.chain.join(','), seconds: r.seconds, legs: r.legs });
            csvRows.value = coarseCache.length;
          },
        });
        coarseLog.value = coarse.log;
        seed = coarse.seed;
        bestChain.value = [...seed];
        bestDays.value = (coarse.byCount.find(c => c.chain.length === seed.length)?.seconds ?? 0) / 86400;
        chainsEstimated.value =
          coarse.chainsEvaluated + estimateChains(Math.max(1, seed.length - 1), EFFORT[effort.value]);
        chainsBase = coarse.chainsEvaluated;
        noteRate(chainsBase, true);
      }

      stage.value = 'running';
      const outcome = await runChainSearch({
        seedChain: seed,
        final: finalTE.value,
        currentTE: currentTE.value,
        effort: effort.value,
        pin: pin.value,
        // Normally the driver's own default (`final - 150`). Exposed so the cap can be tested
        // rather than assumed: it was measured against 490 targets, and this repo's own f1-f4
        // corpus contains a 320-target optimum whose last checkpoint sits at `final - 43`, which
        // the default would put out of reach. Null leaves the driver's behaviour untouched.
        ...(maxLastOverride.value !== null ? { maxLast: maxLastOverride.value } : {}),
        // Without these the probe defaulted to "one either side of the seed", which quietly
        // overrode whatever the user asked for in the range above.
        minCheckpoints: minPrestiges.value,
        maxCheckpoints: maxPrestiges.value,
        evaluateBatch: chains => pool!.evaluate(chains, noteBatch),
        restoredCache,
        shouldStop: () => stopRequested.value,
        onProgress: p => {
          if (p.stage !== stage.value) runLog.value.push(`--- ${p.stage}`);
          if (p.detail && p.detail !== detail.value) {
            runLog.value.push(p.detail);
            if (runLog.value.length > 2000) runLog.value.splice(0, runLog.value.length - 2000);
          }
          stage.value = p.stage;
          detail.value = p.detail;
          chainsDone.value = p.chainsDone;
          chainsEstimated.value = Math.max(p.chainsEstimated, p.chainsDone);
          bestChain.value = p.bestChain;
          bestDays.value = p.bestDays;
          // Keep whatever we had if this progress tick has not priced the leader yet,
          // so the table does not flicker empty between stages.
          if (p.bestLegs.length) bestLegs.value = p.bestLegs;
          noteRate(chainsBase + p.chainsDone);
        },
        onCache: entries => {
          cacheAtEnd = entries;
          liveCache = entries;
          csvRows.value = coarseCache.length + entries.length;
          refreshShortlist();
          void persist(entries);
        },
      });

      bestChain.value = outcome.chain;
      bestDays.value = outcome.seconds / 86400;
      bestLegs.value = outcome.legs;
      lastCompletedStage.value = outcome.lastCompletedStage;
      stoppedEarly.value = outcome.stoppedEarly;
      chainsDone.value = outcome.chainsEvaluated;
      // A run that evaluated nothing did not fail - it replayed a checkpoint that already
      // covered its whole trajectory, which is exactly what the resume banner promises. Saying
      // plain "done" next to "0 / ~404 chains" reads as a crash, so say what happened.
      secondsPerChain.value = 0;
      rateSource.value = null;
      // Force a final write marked complete, so the panel stops offering a finished run as
      // something to resume - which is what made it look like Resume had done nothing.
      //
      // AWAITED, not fire-and-forget. `finally` re-reads the checkpoint to refresh the
      // banner, and an un-awaited write lost that race every time: the banner kept showing
      // the pre-run record - "468 chains were already priced (1h ago)" next to a DONE line
      // reading 483 - so a finished run still advertised itself as unfinished.
      await persist(cacheAtEnd, true, !outcome.stoppedEarly);
      refreshShortlist(true);
      stage.value = outcome.stoppedEarly
        ? 'stopped'
        : outcome.chainsEvaluated === 0
          ? 'done - every chain it needed was already priced'
          : 'done';
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      stage.value = 'failed';
    } finally {
      runEndedAt.value = Date.now();
      pool?.terminate();
      pool = null;
      isRunning.value = false;
      stopRequested.value = false;
      batchDone.value = 0;
      batchTotal.value = 0;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      dropRunLock();
      dropScreenLock();
      await checkResumable(playerId);
    }
  }

  /** Ask the run to stop at the next batch boundary. Because the stages are nested, whatever is on
   *  screen at that moment is already a usable answer — that is the property the UI advertises. */
  function stop(): void {
    stopRequested.value = true;
    stage.value = 'stopping after the current batch...';
  }

  /**
   * Send a chain to the Auto Planner as the plan to generate.
   *
   * Until now the only route from a finished search to an actual plan was reading the winning
   * chain off the screen and retyping it into the Target TE box in a different card. That is a
   * transcription step between a three-hour computation and the thing it was computed for, and
   * `195 219 248 277 286 327` is exactly the kind of string a person fat-fingers.
   *
   * The WHOLE chain goes across, final target included. An earlier version stripped it here on the
   * assumption that the Auto Planner appends the goal itself — it does not. `getTargets()` in
   * useAscensionGenerator is a bare whitespace split of this field, so dropping 490 produced a plan
   * that stopped at 332: six ascensions instead of seven, and 158 truth eggs short of the goal the
   * search had just spent an hour optimising for.
   */
  /**
   * Bumped by `applyChain` when the caller wants the plan built too.
   *
   * A counter rather than a boolean because two applies in a row must both fire, and a signal
   * rather than a direct call because `useAscensionGenerator` is a COMPOSABLE: calling it from
   * here would create a second instance with its own `isGenerating`/`generateProgress`, so the
   * Auto Planner's own progress UI would sit idle while the work happened invisibly. AutomaticPlanner
   * watches this and calls the instance it already owns.
   */
  const generateRequested = ref(0);

  function applyChain(chain: number[], alsoGenerate = false): void {
    const planner = useAutoPlannerStore();
    // Pin the planner to the start this answer was computed against. Without it the plan can be
    // built from a different instant entirely (see `planStartUsed`), and every date in it would be
    // answering a question the search never asked.
    if (planStartUsed.value) {
      const tz = planner.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const [d, t] = formatInZone(planStartUsed.value, tz).split(' ');
      if (d && t) {
        planner.startDate = d;
        planner.startTime = t;
      }
    }
    planner.targetTE = chain.join(' ');
    // The seed box keeps the checkpoints WITHOUT the final target: `seedChain` appends `finalTE`
    // itself, so leaving it in would ask for it twice.
    seedOverride.value = chain.filter(v => v !== finalTE.value).join(' ');
    if (alsoGenerate) generateRequested.value++;
  }

  /** Recompute the runners-up now — for the panel, when a run is not writing batches. */
  /** Switch view and rebuild immediately -- this reads the cache the run already has, so it is
   *  instant and costs no simulation. */
  function setShortlistView(view: ViewId): void {
    shortlistView.value = view;
    refreshShortlist(true);
  }

  function rebuildShortlist(): void {
    refreshShortlist(true);
  }

  async function discardCheckpoint(): Promise<void> {
    if (!partitionHash) return;
    await clearCheckpoint(partitionHash);
    resumable.value = null;
  }

  return {
    // settings
    effort,
    finalTE,
    forceContinue,
    pin,
    minPrestiges,
    maxLastOverride,
    maxPrestiges,
    scheduleEnabled,
    availableFrom,
    availableTo,
    availableDays,
    availability,
    availabilityLabel,
    deferShifts,
    planStartUsed,
    scheduleIsEmpty,
    milestones,
    activeMilestones,
    droppedMilestones,
    bestMissed,
    noFeasibleChain,
    // live state
    isRunning,
    stopRequested,
    error,
    stage,
    detail,
    chainsDone,
    chainsReplayed,
    batchDone,
    batchTotal,
    suspendedSeconds,
    runMinutes,
    runCost,
    chainsEstimated,
    bestChain,
    bestDays,
    bestLegs,
    lastCompletedStage,
    stoppedEarly,
    workersInPool,
    secondsPerChain,
    rateSource,
    benchmarking,
    benchmarkError,
    benchmarkedAt,
    benchmarkChainCount,
    resumable,
    keepAwake,
    // derived
    progressFraction,
    secondsRemaining,
    currentTE,
    planStart,
    planStartIsNow,
    finishedCleanly,
    seedChain,
    seedIssue,
    fitSeedToLimitsNow,
    savedRuns,
    refreshSavedRuns,
    saveCurrentRun,
    openSavedRun,
    deleteSavedRun,
    seedOverride,
    estimateForCurrentSettings,
    findSeedFirst,
    coarseLog,
    runLog,
    csvRows,
    shortlist,
    pricedChains,
    shortlistView,
    setShortlistView,
    // actions
    start,
    startExhaustive,
    benchmarkMachine,
    restoreBenchmark,
    stop,
    checkResumable,
    discardCheckpoint,
    runStartedAt,
    searchSpace,
    openedRun,
    crashedRun,
    resumeCrashedRun,
    canResumeOpenedRun,
    resumeBlocker,
    resumeOpenedRun,
    workerBudget,
    machineThreads,
    legDetailBudget,
    legsHeld,
    legDetailBytes,
    exportCsv,
    exportCsvChunks,
    buildRunSubmission,
    sendSubmission,
    submitUrl,
    leaderboardUrl,
    submissionFilename,
    readInventory,
    csvFilename,
    applyChain,
    generateRequested,
    rebuildShortlist,
  };
});
