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
import { computed, ref } from 'vue';
import { getSimulationContext, createBaseEngineState } from '@/engine/adapter';
import { getLocalTimestampInTimezone } from '@/lib/events';
import { hashID } from '@/lib/storage/db';
import { runChainSearch, type CacheEntry } from '@/search/driver';
import { findStartingChain, planCoarseGrid } from '@/search/coarse';
import { createChainSearchPool, type ChainSearchPool } from '@/search/pool';
import { maxPoolSize } from '@/search/batch';
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
  describeVirtueInventory,
  formatInZone,
  virtueInventory,
  type InventoryCount,
} from '@/search/csv';
import { pickShortlist, type ShortlistRow } from '@/search/shortlist';
import { describeAvailability, isConstrained, type Availability } from '@/search/availability';
import { missedMilestones, usableMilestones, type Milestone } from '@/search/milestones';
import {
  getArtifactLoadoutFromBackup,
  getOptimalEarningsSet,
  getOptimalELRSet,
  type EquippedArtifact,
} from '@/lib/artifacts';
import type { EffortTier, LegSummary, SearchInputs } from '@/search/types';
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
  const workersInPool = ref(maxPoolSize());
  /** Measured on THIS machine, from this run's own batches. Not an assumption carried over from the
   *  CLI's 20-core box. */
  const secondsPerChain = ref(0);
  const startedAt = ref(0);
  /** A checkpoint from a previous session that matches the current inputs, if any. */
  const resumable = ref<SearchCheckpoint | null>(null);
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

  let pool: ChainSearchPool | null = null;
  let lastCheckpointAt = 0;
  let lastRateAt = 0;
  let lastRateChains = 0;
  let partitionHash = '';
  let runFingerprint = '';

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
    secondsPerChain.value = secondsPerChain.value
      ? secondsPerChain.value * (1 - RATE_ALPHA) + observed * RATE_ALPHA
      : observed;
    lastRateChains = done;
    lastRateAt = now;
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
    const chain = raw.filter(v => v < finalTE.value);
    return [...chain, finalTE.value];
  });

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

  function refreshShortlist(force = false): void {
    const now = Date.now();
    if (!force && now - lastShortlistAt < SHORTLIST_INTERVAL_MS) return;
    lastShortlistAt = now;
    shortlist.value = pickShortlist(allEntries());
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
  async function start(playerId: string, options: { resume?: boolean } = {}): Promise<void> {
    if (isRunning.value) return;

    error.value = null;
    stopRequested.value = false;
    stoppedEarly.value = false;
    isRunning.value = true;
    startedAt.value = Date.now();
    chainsDone.value = 0;
    chainsReplayed.value = 0;
    runLog.value = [];
    secondsPerChain.value = 0;
    // A fresh run's export must not carry the previous run's rows: the settings that give every
    // duration its meaning (plan start, excluded hours, final target) may all have changed.
    liveCache = [];
    coarseCache = [];
    csvRows.value = 0;
    shortlist.value = [];
    lastShortlistAt = 0;
    batchDone.value = 0;
    batchTotal.value = 0;
    suspendedSeconds.value = 0;
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

    try {
      pool = await createChainSearchPool(collectInputs(), {
        onSuspend: gap => {
          suspendedSeconds.value += gap;
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
      pool?.terminate();
      pool = null;
      isRunning.value = false;
      stopRequested.value = false;
      batchDone.value = 0;
      batchTotal.value = 0;
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
    chainsEstimated,
    bestChain,
    bestDays,
    bestLegs,
    lastCompletedStage,
    stoppedEarly,
    workersInPool,
    secondsPerChain,
    resumable,
    // derived
    progressFraction,
    secondsRemaining,
    currentTE,
    planStart,
    planStartIsNow,
    finishedCleanly,
    seedChain,
    seedOverride,
    estimateForCurrentSettings,
    findSeedFirst,
    coarseLog,
    runLog,
    csvRows,
    shortlist,
    // actions
    start,
    stop,
    checkResumable,
    discardCheckpoint,
    exportCsv,
    readInventory,
    csvFilename,
    applyChain,
    generateRequested,
    rebuildShortlist,
  };
});
