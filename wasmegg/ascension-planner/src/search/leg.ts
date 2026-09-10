/**
 * One ascension ("leg"), simulated with the app's own simulator and scored the way the app itself
 * would score it.
 *
 * This is a straight port of `runLeg`/`buildContinueVariant` in scripts/fastsearch.ts, with exactly
 * one change: everything that file reads out of Pinia is passed in as `SearchInputs` instead, so
 * this module runs unchanged in a Web Worker (see search/types.ts for why). The call sequence —
 * `runUntilShift('C3')` once, then `runC3Variants`, then `runAscensionFromC3Variant` per surviving
 * variant, then the app's own `pickVariant` — is deliberately identical, because the whole point of
 * the exercise is that the search scores chains with the SAME code path the Auto Planner tab does.
 * Any divergence here is a bug, not an optimisation.
 *
 * Cost, measured: about 2.5 s per leg on a 20-core Windows box via the CLI harness, so a 6-leg chain
 * is ~15 s. Nothing in here is cheap, and `runC3Variants` (specifically `evaluateStones` inside it)
 * is the hotspot.
 */
import { computeSnapshot } from '@/engine/compute';
import { runUntilShift, deriveNextStartState, runContinueCurrent, runAscensionFromC3Variant } from '@/auto/ascension';
import { runC3Variants } from '@/auto/shifts/c3';
import { pickVariant, type VariantKey, type VariantResult } from '@/stores/autoPlanner';
import { getArtifactLoadoutFromBackup, getOptimalEarningsSet, getOptimalELRSet } from '@/lib/artifacts';
import type { EngineState, SimulationContext } from '@/engine/types';
import type { Action } from '@/types/actions/meta';
import type { AscensionSummary } from '@/auto/types';
import type { VirtueEgg } from '@/types';
import type { SearchInputs, ShiftMoment } from './types';

/** Mirrors useAscensionGenerator's own constant: below this starting TE a Tier 13 unlock cannot
 *  realistically land inside one build phase, so those variants are skipped rather than simulated
 *  and thrown away. */
const TIER_13_MIN_STARTING_TE = 190;

/** Backup egg enum (50..54) -> EngineState's egg name, the same table the generator keeps as
 *  VIRTUE_EGGS_MAP. Passing the raw number through leaves `currentEgg` as `53` and quietly corrupts
 *  every rate calculation downstream — that was a real bug in the CLI harness. */
const VIRTUE_EGGS_MAP: Record<number, VirtueEgg> = {
  50: 'curiosity',
  51: 'integrity',
  52: 'humility',
  53: 'resilience',
  54: 'kindness',
};

export interface LegResult {
  summary: AscensionSummary;
  key: VariantKey;
  /** The starting state for the NEXT leg, via the app's own `deriveNextStartState`. */
  nextState: EngineState;
  /** Absolute instants, unix seconds, at which this leg's twelve shifts happen. Only the shifts:
   *  they are the manual moments inside an ascension that cannot be missed without the plan
   *  slipping, and unlike a research purchase there are exactly twelve of them, so a count of how
   *  many fall in a sleep window means something. See `shiftInstants` for why `timestamp` is not
   *  the field to read. */
  shifts: ShiftMoment[];
}

/**
 * When each action actually happens, absolute unix seconds.
 *
 * `Action.timestamp` is NOT the field to use: `runAscension` sets it only on the synthetic
 * `start_ascension` action (and in milliseconds), while every action the shift helpers create keeps
 * `createSimAction`'s placeholder of "now". The app itself never reads it for scheduling either —
 * `useResearchViews` derives absolute time as `baseTimestamp + (snapshot.lastStepTime - offset)`,
 * and this is the same expression with `legContext`'s `planStartOffset: 0` substituted in.
 */
function shiftInstants(actions: Action[], legStart: number): ShiftMoment[] {
  const out: ShiftMoment[] = [];
  for (const a of actions) {
    if (a.type !== 'shift') continue;
    const step = a.endState?.lastStepTime;
    if (typeof step !== 'number' || !Number.isFinite(step)) continue;
    // `toEgg` is the virtue egg this shift switches to - the thing the player physically does.
    // `fromEgg` is carried so the panel can name the block the leg starts on; see ShiftMoment.
    const payload = a.payload as { toEgg?: string; fromEgg?: string } | undefined;
    out.push({ at: legStart + step, egg: payload?.toEgg ?? '', fromEgg: payload?.fromEgg });
  }
  return out;
}

/** A fresh `SimulationContext` pinned to this leg's start. The stored context is never mutated —
 *  legs are evaluated out of order and share one `SearchInputs`. */
function legContext(inputs: SearchInputs, startTime: number): SimulationContext {
  return { ...inputs.context, ascensionStartTime: startTime, planStartOffset: 0 };
}

/** A deep, proxy-free copy of the base state. `runUntilShift` clones its own input too, but
 *  `deriveNextStartState` spreads this straight into the next leg's state, so a shared reference
 *  would let one leg's mutation leak into another's. */
function cloneBaseState(inputs: SearchInputs): EngineState {
  return JSON.parse(JSON.stringify(inputs.baseState)) as EngineState;
}

/**
 * Simulate one ascension and return the variant the app itself would pick.
 *
 * `allowContinue` is only true for A1: "continue current ascension" is a claim about the farm as it
 * stands right now, so it has no meaning further down a chain, and the app only offers it there for
 * the same reason.
 *
 * Returns null when the leg is unevaluable (no surviving variant). The caller treats that as "this
 * chain failed", not as an error.
 */
export function runLeg(
  inputs: SearchInputs,
  baseState: EngineState,
  startTime: number,
  targetTE: number,
  allowContinue: boolean,
  startTE: number,
  idx: number
): LegResult | null {
  const ctx = legContext(inputs, startTime);

  // --force-continue: A1 is the ascension you are already part-way through, so "prestige now" means
  // throwing that progress away. The planner will sometimes pick it anyway when the maths narrowly
  // favours it; this pins A1 to Continue Current Ascension instead. It is also the cheapest speedup
  // available — every build variant costs a full C3, and this skips all of them for A1.
  if (allowContinue && inputs.forceContinue) {
    const only = buildContinueVariant(inputs, baseState, startTime, targetTE, idx);
    if (only) {
      return {
        summary: only.summary,
        key: 'continue',
        nextState: deriveNextStartState(only.summary, cloneBaseState(inputs)),
        shifts: shiftInstants(only.actions, startTime),
      };
    }
    // No usable farm state (or zero ELR) — fall through to the normal variant search rather than
    // returning null, so the run degrades instead of dying.
  }

  // Single C1->R1 precompute shared by every build variant, exactly as the app does it — K3..H2 is
  // the expensive part and must not be repeated per variant.
  const pre = runUntilShift(baseState, ctx, 'C3');
  const preC3 = { actions: pre.actions, state: pre.state, elapsedSeconds: pre.elapsedSeconds };

  const c3 = runC3Variants(pre.state, ctx, 3, startTE < TIER_13_MIN_STARTING_TE);
  const surviving = c3.filter(x => !x.impossible);

  const variants: Partial<Record<VariantKey, VariantResult>> = {};
  for (const v of surviving) {
    const key = (v.attemptTier13Unlock ? `${v.saleCount}-sale-tier13` : `${v.saleCount}-sale`) as VariantKey;
    variants[key] = runAscensionFromC3Variant(baseState, preC3, v, ctx, startTime, `asc_${idx}`, targetTE);
  }

  if (allowContinue) {
    const cont = buildContinueVariant(inputs, baseState, startTime, targetTE, idx);
    if (cont) variants.continue = cont;
  }
  if (!Object.keys(variants).length) return null;

  const best = pickVariant(variants);
  const entry = Object.entries(variants).find(([, v]) => v === best);
  return {
    summary: best.summary,
    key: (entry ? entry[0] : '?') as VariantKey,
    nextState: deriveNextStartState(best.summary, cloneBaseState(inputs)),
    shifts: shiftInstants(best.actions, startTime),
  };
}

/**
 * A1-only "continue current ascension" variant, mirroring the generator's own setup.
 *
 * The field names below are load-bearing and were each a real bug in the CLI harness:
 *   - `habIds`, NOT `habs`. Writing `habs` left habIds at `[0,null,null,null]` — one starter hab,
 *     no capacity, so the farm could never afford research and `buyResearch` recursed until the
 *     stack blew on the third leg.
 *   - `currentEgg` must be the NAME, not the backup's 50..54 enum.
 *   - the ELR set is recomputed rather than reusing the equipped (earnings) loadout. Filing the
 *     earnings set under `artifactSets.elr` made "continue" report 1.580q/hr instead of 3.574q/hr.
 */
function buildContinueVariant(
  inputs: SearchInputs,
  baseState: EngineState,
  startTime: number,
  targetTE: number,
  idx: number
): VariantResult | null {
  const farmState = inputs.currentFarmState;
  const raw = inputs.context.rawBackup;
  if (!farmState || !raw) return null;

  const rawLoadout = getArtifactLoadoutFromBackup(raw);
  const optimalEarnings = getOptimalEarningsSet(raw);
  const elr =
    getOptimalELRSet(raw, {
      commonResearch: farmState.commonResearches,
      epicResearchLevels: inputs.context.epicResearchLevels,
      colleggtibleModifiers: inputs.context.colleggtibleModifiers,
      currentSet: rawLoadout,
      assumeMaxHabsVehicles: false,
    }) ?? rawLoadout;

  const state = {
    ...JSON.parse(JSON.stringify(baseState)),
    currentEgg: VIRTUE_EGGS_MAP[farmState.eggType as number] ?? 'curiosity',
    researchLevels: { ...farmState.commonResearches },
    habIds: farmState.habs || [0, null, null, null],
    vehicles: farmState.vehicles || [{ vehicleId: 0, trainLength: 1 }],
    siloCount: farmState.numSilos || 1,
    tankLevel: baseState.tankLevel,
    artifactLoadout: elr.map(s => ({ artifactId: s.artifactId, stones: [...s.stones] })),
    activeArtifactSet: 'elr',
    artifactSets: {
      earnings: optimalEarnings ? JSON.parse(JSON.stringify(optimalEarnings)) : null,
      elr: JSON.parse(JSON.stringify(elr)),
    },
    fuelTankAmounts: { ...baseState.fuelTankAmounts },
    eggsDelivered: { ...baseState.eggsDelivered },
    teEarned: { ...baseState.teEarned },
    population: farmState.population || 0,
    lastStepTime: farmState.lastStepTime || 0,
    bankValue: farmState.cash || 0,
    activeSales: { research: false, hab: false, vehicle: false },
    earningsBoost: { active: false, multiplier: 1 },
  } as EngineState;

  const ctx = legContext(inputs, startTime);
  const elrNow = computeSnapshot(state, ctx, { skipGrowth: true }).elr;
  if (!(elrNow > 0)) return null;
  return runContinueCurrent(state, ctx, startTime, elrNow, targetTE, `asc_${idx}_continue`);
}
