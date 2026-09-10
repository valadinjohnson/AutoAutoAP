/**
 * Effort tiers and what is actually known about them.
 *
 * Ported verbatim from `EFFORT`/`EFFORT_NOTE` in scripts/autoplan.py, including the numbers. Two
 * rules govern everything in this file and they are not stylistic:
 *
 *   1. The stages are strictly NESTED (resolve_last -> descent -> 2-D slices -> count probe), so a
 *      tier is a STOP POINT, not a different algorithm. A user who picks a higher tier and loses
 *      patience already holds the lower tier's answer at zero extra cost. The UI says so out loud,
 *      because it is the thing that makes "Stop" a safe button.
 *   2. Accuracy is stated as HOURS BEHIND THE BEST ANSWER FOUND, with the sample size attached, and
 *      never as a confidence percentage. n is 3 accounts. There is no honest way to turn three
 *      observations into a probability, and inventing one would be the most damaging thing this
 *      feature could do — the user is deciding whether to spend three hours on the answer.
 *
 * "Best answer FOUND" is deliberate: only the main account has a proven optimum (a complete
 * 4913-chain exhaustive), and even that proves optimality only inside a box with the first two
 * checkpoints, the final target and the checkpoint count all pinned.
 */
import type { EffortConfig, EffortTier } from './types';

export const EFFORT: Record<EffortTier, EffortConfig> = {
  // Descent radius is 8 in every tier: a replay of the search found the knee at radius 4 and
  // exactness at 7, so 8 is one step of margin rather than a round number.
  quick: { slices2: false, slices3: false, radius: 8, radius3: 0, countProbe: false },
  balanced: { slices2: true, slices3: false, radius: 8, radius3: 0, countProbe: false },
  normal: { slices2: true, slices3: false, radius: 8, radius3: 0, countProbe: true },
  thorough: { slices2: true, slices3: true, radius: 8, radius3: 6, countProbe: true },
};

export interface EffortNote {
  /** Short name for the slider. */
  label: string;
  /** Measured CLI wall time on a 20-core Windows box at --jobs 12. The browser will differ; see
   *  the store's own `secondsPerChain`, which is measured on this machine instead. */
  cliDuration: string;
  /** What the tier adds over the one below it. */
  adds: string;
  /** The measured accuracy record, verbatim. Rendered as-is in the UI — do not paraphrase it into
   *  something that sounds more confident than it is. */
  accuracy: string;
  /** A warning to surface prominently, or null. */
  warning: string | null;
}

export const EFFORT_NOTES: Record<EffortTier, EffortNote> = {
  quick: {
    label: 'Fast',
    cliDuration: '~1 h 05 m',
    adds: 'Coordinate descent only (radius 8), re-solving the last checkpoint after every accepted move.',
    accuracy:
      'Measured 5 h, 0 h and 61 h behind the best answer found, on 3 accounts. ' +
      'Then two further runs on one of those same accounts landed about 6 DAYS worse — ' +
      'so this tier’s spread is much wider than the single 5 h figure suggested. Treat it as ' +
      '"usually close, occasionally days off", not as a tight bound.',
    warning: 'Widest spread of the four tiers. Two repeat runs on one account landed ~6 days behind.',
  },
  balanced: {
    label: 'Balanced',
    cliDuration: '~2 h 55 m',
    adds: '+ exhaustive step-1 2-D slices over adjacent checkpoint pairs, which single-axis descent cannot see.',
    accuracy: 'Measured 1.3 h and 0 h behind the best answer found, on 2 accounts. Within a day on both.',
    warning: null,
  },
  normal: {
    label: 'Exact',
    cliDuration: '~3 h 30 m',
    adds: '+ the prestige-count probe: drop a checkpoint or insert one, then re-polish.',
    accuracy:
      'Matched a 4913-chain exhaustive of the surrounding box on 1 account (rank 1 of 4913). ' +
      'The other accounts have no proven answer to check against.',
    warning: null,
  },
  thorough: {
    label: 'Thorough',
    cliDuration: '7–13 h',
    adds: '+ exhaustive 3-D slices over adjacent checkpoint triples.',
    accuracy:
      'One measured win, and it is a big one: on the alt an exhaustive X4xX5xX6 slice (13^3 = ' +
      '2197 chains) beat the 2-D-polished answer by 1.665 d (40 h) — the recipe ranked 55 of 2197. ' +
      'X6=289 is only good jointly with X4=229; at X4=231 it costs 3.4 d, which no single-axis or ' +
      '2-D sweep can see. BUT that was measured before stage 5 was fixed to sweep the LAST ' +
      'adjacent pair, which it previously skipped, so an unknown share of those 40 h may now be ' +
      'captured by stage 5 alone. On the main, a 4913-chain 3-D exhaustive over X3xX4xX5 matched ' +
      'the recipe exactly, so there stage 6 had nothing to add.',
    warning:
      'Stage 6 is ~74% of this tier’s chains (6591 of 8865 on a 7-checkpoint chain) and it runs ' +
      'BEFORE the prestige-count probe, so the probe — the stage that produced the main’s proven ' +
      'answer — is gated behind all of it.',
  },
};

/** The order the slider walks, cheapest first. */
export const EFFORT_ORDER: EffortTier[] = ['quick', 'balanced', 'normal', 'thorough'];

/** How rare a genuinely good chain is — the reason "just try a few by hand" does not work.
 *  From the 4913-chain exhaustive on the main account. */
export const NEAR_OPTIMAL_SHARE = '21 of 4913 chains (0.43%) are within one day of optimal';

/** Sample size behind every accuracy figure above. Rendered next to them so it is never dropped. */
export const ACCURACY_SAMPLE = 'n = 3 accounts';

/**
 * Rough chain count for a configuration, ported from autoplan.py's own pre-flight estimate.
 *
 * The terms are the ones that were measured to matter, and each was wrong once:
 *   - the descent term must include the `resolve_last` sweep (span 12, ~25 chains) that runs after
 *     every accepted axis move. Omitting it put stage 4 at 306 chains where a real run spent ~569.
 *   - the probe term is a PRODUCT, not a sum: `count_probe` re-crosses its candidates per length,
 *     so the insertion group alone was 383 chains where `2**(n-1)` predicted 32.
 *
 * `n` is the number of checkpoints before the final target.
 */
export function estimateChains(n: number, cfg: EffortConfig): number {
  let est = (2 * cfg.radius + 1) * n * 3 + 25 * n * 2;
  if (cfg.slices2) est += (2 * cfg.radius + 1) ** 2 * Math.max(n - 1, 1);
  // n-2 TRIPLES, not n-3. driver.ts sweeps `j` from `len-4` down to `pin`, which is len-3 = n-2
  // triples - four for a 7-checkpoint chain, where this used to predict three. The shortfall is a
  // whole 13^3 sweep: an observed Thorough run showed `7634 / ~8865` with an entire triple still to
  // go, so the bar approached full while a quarter of the stage remained.
  if (cfg.slices3) est += (2 * cfg.radius3 + 1) ** 3 * Math.max(n - 2, 1);
  if (cfg.countProbe) est += Math.floor(3 ** Math.max(n - 1, 1) / 2) + (2 * cfg.radius + 1) * n;
  return est;
}
