/**
 * Regression fixture for the browser search core: does `src/search/*` score a chain identically to
 * the CLI harness it was ported from?
 *
 * The proven optimum for the main account is `195 219 248 286 327 490` = 741.965 days from
 * `blind_main.json` with a plan start of 2026-09-04 18:51 America/Denver — rank 1 of a 4913-chain
 * exhaustive. The command-line equivalent of this test is:
 *
 *   node dist-search/fastsearch.js --backup blind_main.json --final 490 \
 *     --start-date 2026-09-04 --start-time 18:51 --timezone America/Denver \
 *     --force-continue --jobs 1 --top 3 --stages "195;219;248;286;327"
 *
 * and it prints `741d 23h`. This test asserts the SAME number through the ported evaluator, which is
 * the only way to know the Pinia-to-payload split in search/types.ts did not quietly change what is
 * being simulated.
 *
 * SKIPPED when `blind_main.json` is absent: it is a real player backup and is not committed. Costs
 * roughly fifteen seconds when it does run (six leg simulations), hence the explicit timeout.
 */
// MUST be first: installs localStorage/window/document before any store module whose top-level
// state() reads them (lib's eids store throws at import without it). Same reason fastsearch.ts
// imports it first.
import '../../scripts/node-shims';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { markRaw } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { resolveColleggtibleContracts } from 'lib';
import { loadAndSyncBackup, rollUpPendingTE } from '@/lib/modes';
import { resetAllStores } from '@/lib/modes/reset';
import { createBaseEngineState, getSimulationContext } from '@/engine/adapter';
import { computeSnapshot } from '@/engine/compute';
import { getLocalTimestampInTimezone } from '@/lib/events';
import { useActionsStore } from '@/stores/actions';
import { useInitialStateStore } from '@/stores/initialState';
import { useVirtueStore } from '@/stores/virtue';
import { createChainEvaluator } from './chain';
import { isAvailable } from './availability';
import type { SearchInputs } from './types';

const BACKUP = join(process.cwd(), 'blind_main.json');
const hasFixture = existsSync(BACKUP);

/** fastsearch.ts's own `fmt` — floor to whole days and hours, so the assertion compares exactly the
 *  string the CLI prints rather than a re-rounded float. */
const fmt = (s: number) => `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;

describe.skipIf(!hasFixture)('chain evaluator (blind_main fixture)', () => {
  let inputs: SearchInputs;

  beforeAll(async () => {
    setActivePinia(createPinia());

    let backup = JSON.parse(readFileSync(BACKUP, 'utf8'));
    resolveColleggtibleContracts(backup);
    // Nothing here is reactive, and the simulator reads the artifact inventory out of this constantly
    // (getOptimalELRSet -> evaluateStones walks every stone on every call). A CPU profile put Vue's
    // proxy traps at ~14% of total runtime in the CLI harness; markRaw removes them.
    backup = markRaw(backup);

    // Mirrors initPlanFuture (src/lib/modes/planFuture.ts) step for step, because that is what the
    // Auto Planner tab actually runs. The differences from the generic 'default' load matter: mode
    // 'plan_next', rollUpPendingTE straight after (without it this starts from 159 TE instead of
    // 175), the virtue store reset, and a start action stripped of farm state.
    await resetAllStores();
    loadAndSyncBackup('file', backup, 'plan_next');
    rollUpPendingTE();

    const virtueStore = useVirtueStore();
    virtueStore.resetToCurrentDateTime();
    virtueStore.setBankValue(0);
    virtueStore.setCurrentEgg('curiosity');

    const actionsStore = useActionsStore();
    const startAction = actionsStore.getStartAction();
    if (startAction) {
      startAction.payload.initialFarmState = undefined;
      startAction.payload.isQuickContinue = false;
      startAction.payload.initialEgg = 'curiosity';
    }
    await actionsStore.setInitialSnapshot(computeSnapshot(createBaseEngineState(null), getSimulationContext()));

    const snapshot = actionsStore.effectiveSnapshot;
    const currentTE = snapshot?.teEarned
      ? (Object.values(snapshot.teEarned) as number[]).reduce((a, b) => a + b, 0)
      : 0;

    inputs = {
      context: getSimulationContext(),
      baseState: createBaseEngineState(null),
      currentFarmState: useInitialStateStore().currentFarmState,
      planStart: getLocalTimestampInTimezone('2026-09-04', '18:51', 'America/Denver'),
      currentTE,
      final: 490,
      forceContinue: true,
    };
  }, 120_000);

  it('reproduces the CLI harness result for the known-optimal chain', () => {
    const evaluator = createChainEvaluator(inputs);
    const result = evaluator.evaluate([195, 219, 248, 286, 327, 490]);

    expect(result).not.toBeNull();
    expect(fmt(result!.seconds)).toBe('741d 23h');
    expect(result!.seconds / 86400).toBeCloseTo(741.965, 2);
    // The CLI prints the same six variant choices for this chain; a change here means the variant
    // search diverged even if the total happened to land in the same hour.
    expect(result!.legs.map(l => l.key)).toEqual([
      'continue',
      '3-sale-tier13',
      '2-sale-tier13',
      '2-sale-tier13',
      '2-sale-tier13',
      '1-sale-tier13',
    ]);
  }, 180_000);

  /**
   * Excluded hours, end to end through the real simulator.
   *
   * No magic number is asserted, because there is no ground truth for the constrained answer —
   * only the CLI's unconstrained 741d 23h exists. What CAN be asserted is every property the
   * feature claims: a constrained plan is never faster, every prestige the player has to be there
   * for lands in an available hour, and the final target is exempt because reaching it is not an
   * action. Those are the things a regression would break.
   */
  it('pushes every prestige into the availability window, and only the prestiges', () => {
    const chain = [195, 219, 248, 286, 327, 490];
    const free = createChainEvaluator(inputs).evaluate(chain)!;
    const window = { days: [], fromHour: 7, toHour: 23, timezone: 'America/Denver' };
    const slept = createChainEvaluator({ ...inputs, availability: window }).evaluate(chain)!;

    // Charging a delay can only make a fixed chain slower, never faster.
    expect(slept.seconds).toBeGreaterThanOrEqual(free.seconds);

    slept.legs.forEach((leg, i) => {
      const handoff = leg.endTime + (leg.sleepDelaySeconds ?? 0);
      if (i === slept.legs.length - 1) {
        // The final leg is exempt: 490 TE arrives whether you are awake or not.
        expect(leg.sleepDelaySeconds).toBe(0);
      } else {
        expect(isAvailable(handoff, window)).toBe(true);
        // A delay is only ever charged when the leg genuinely ended inside the window.
        if (leg.sleepDelaySeconds) expect(isAvailable(leg.endTime, window)).toBe(false);
      }
    });

    // The shifts are reported, not moved — the count is the honesty half of the feature, so a
    // silent zero everywhere would mean the reporting had broken.
    const shifts = slept.legs.reduce((n, l) => n + (l.nightShifts ?? 0), 0);
    expect(shifts).toBeGreaterThan(0);
  }, 300_000);

  it('holds the shifts too when asked, and charges what that costs', () => {
    // The feature's whole claim: with `deferShifts` on, a plan that fits your hours has NO shift
    // outside them - the cost has moved out of a warning and into the duration.
    const chain = [195, 219, 248, 286, 327, 490];
    const window = { days: [], fromHour: 7, toHour: 23, timezone: 'America/Denver' };
    const reported = createChainEvaluator({ ...inputs, availability: window })!.evaluate(chain)!;
    const held = createChainEvaluator({ ...inputs, availability: window, deferShifts: true }).evaluate(chain)!;

    // Reported-only leaves shifts outside the window; holding them leaves none.
    expect(reported.legs.reduce((n, l) => n + (l.nightShifts ?? 0), 0)).toBeGreaterThan(0);
    expect(held.legs.reduce((n, l) => n + (l.nightShifts ?? 0), 0)).toBe(0);

    // Every shift instant is genuinely inside the window, not merely counted as zero.
    for (const leg of held.legs) {
      for (const sh of leg.shifts ?? []) expect(isAvailable(sh.at, window)).toBe(true);
    }

    // Holding work back can only make a fixed chain slower.
    expect(held.seconds).toBeGreaterThan(reported.seconds);
  }, 300_000);

  it('leaves durations untouched when no schedule is set', () => {
    // The default path must be byte-identical to the pre-feature computation, which is what makes
    // every accuracy figure on record still apply.
    const chain = [195, 219, 248, 286, 327, 490];
    const a = createChainEvaluator(inputs).evaluate(chain)!;
    const b = createChainEvaluator({ ...inputs, availability: null }).evaluate(chain)!;
    expect(b.seconds).toBe(a.seconds);
    expect(b.legs.every(l => l.sleepDelaySeconds === 0)).toBe(true);
    expect(b.legs.every(l => l.nightShifts === 0)).toBe(true);
  }, 300_000);

  /**
   * Every leg opens on an egg, and that opening block is NOT a shift.
   *
   * The panel listed `shifts` and so appeared to start each ascension on integrity, because the
   * first switch is `curiosity -> integrity` and the opening stretch on curiosity -- 27 minutes of
   * it in the run that surfaced this -- has no shift action to be found in. Reported by the player
   * cross-checking the panel against the Auto Planner's own C1 / I1 / K1 roadmap, which does list
   * it. `fromEgg` is what lets the panel put the row back, so this asserts it survives; an
   * undefined `fromEgg` drops the row silently rather than showing a wrong one.
   *
   * A FRESH ascension always opens on curiosity. The FIRST leg need not: "continue current
   * ascension" resumes on whatever egg the backup was actually laying, which on this fixture is
   * resilience. That asymmetry is the app's own (`deriveNextStartState` and
   * `buildContinueVariant`), not the search's, and is precisely why the opening egg has to be
   * read rather than assumed to be curiosity.
   */
  it('records the egg each leg opens on, which is never one of its own shifts', () => {
    const result = createChainEvaluator(inputs).evaluate([195, 219, 248, 286, 327, 490])!;
    const openers = result.legs.map(l => l.shifts?.[0]?.fromEgg);
    const VIRTUE_EGGS = ['curiosity', 'integrity', 'humility', 'resilience', 'kindness'];

    result.legs.forEach((leg, i) => {
      const shifts = leg.shifts ?? [];
      if (!shifts.length) return;
      expect(VIRTUE_EGGS, `leg ${i + 1} opener, all openers: ${openers.join(', ')}`).toContain(openers[i]);
      // The opening block is genuinely absent from the switch list: the leg does not switch TO
      // the egg it starts on, so a reader of `shifts` alone cannot know it was ever laid.
      expect(shifts[0].egg).not.toBe(openers[i]);
      expect(leg.startTime).toBeLessThanOrEqual(shifts[0].at);
    });

    // Legs after the first are fresh ascensions and reset to curiosity.
    expect(openers.slice(1).filter(Boolean), `openers: ${openers.join(', ')}`).toEqual(
      openers
        .slice(1)
        .filter(Boolean)
        .map(() => 'curiosity')
    );
  }, 300_000);

  it('shares prefixes across chains instead of re-simulating them', () => {
    const evaluator = createChainEvaluator(inputs);
    evaluator.evaluate([195, 219, 248, 286, 327, 490]);
    const afterFirst = evaluator.legSims;
    // A second chain differing only in its LAST checkpoint must reuse all four leading legs.
    evaluator.evaluate([195, 219, 248, 286, 328, 490]);
    expect(evaluator.legSims - afterFirst).toBe(2);
  }, 180_000);
});
