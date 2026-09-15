/**
 * @module progression
 * @description Summarises the two account-wide multipliers the simulator reads but the submission
 * never carried: epic research and colleggtibles.
 *
 * WHY THESE AND NOT THE WHOLE SAVE. A duration is meaningless without knowing what produced it.
 * The board already records the artifact loadout for that reason; epic research and colleggtibles
 * are the other two things that move every leg of every chain and differ wildly between accounts.
 * Two people submitting the same chain with a four-day gap between them is noise until you can see
 * that one of them has every colleggtible at tier 4 and the other has none.
 *
 * SUMMARISED, NOT DUMPED. A full per-item level list is a sharp fingerprint and mostly zeros or
 * mostly maxes. "max" when everything is maxed, otherwise a short count plus only the items that
 * are actually short, is the useful signal at a fraction of the identifying detail.
 */

export interface ResearchLevelInput {
  id: string;
  name: string;
  level: number;
  maxLevel: number;
}

export interface EpicResearchSummary {
  /** True when every epic research is at its cap. The common case for anyone running this search. */
  maxed: boolean;
  /** How many are at cap, out of how many exist. */
  atMax: number;
  total: number;
  /**
   * Only the ones below cap, as `Name L/Max`. Empty when maxed. Capped in length so a brand new
   * account does not post its entire research tree.
   */
  short: string[];
}

const MAX_SHORT_ITEMS = 12;

/** Epic research, reduced to "max" or the handful that are not. */
export function summariseEpicResearch(levels: ResearchLevelInput[]): EpicResearchSummary | null {
  const usable = levels.filter(r => Number.isFinite(r.level) && Number.isFinite(r.maxLevel) && r.maxLevel > 0);
  if (!usable.length) return null;

  const short = usable.filter(r => r.level < r.maxLevel).sort((a, b) => a.level / a.maxLevel - b.level / b.maxLevel);

  return {
    maxed: short.length === 0,
    atMax: usable.length - short.length,
    total: usable.length,
    short: short.slice(0, MAX_SHORT_ITEMS).map(r => `${r.name} ${r.level}/${r.maxLevel}`),
  };
}

export interface ColleggtibleSummary {
  /** True when every colleggtible is at the top tier. */
  maxed: boolean;
  /** Count at each tier index, lowest first: index 0 is "none earned", 1-4 are tiers 1-4. */
  byTier: number[];
  total: number;
  /** `egg T3` for anything below the top tier, so a partial set is readable. Empty when maxed. */
  short: string[];
}

/** Tier indices in the backup are -1 (none) through 3 (tier 4). */
const TOP_TIER_INDEX = 3;

/**
 * Colleggtibles, reduced the same way.
 *
 * `tiers` is the record `getColleggtibleTiers(backup)` returns: egg identifier -> tier index, with
 * -1 meaning none earned.
 */
export function summariseColleggtibles(tiers: Record<string, number>): ColleggtibleSummary | null {
  const entries = Object.entries(tiers).filter(([, t]) => Number.isFinite(t));
  if (!entries.length) return null;

  // Five buckets: none, then tiers 1-4.
  const byTier = [0, 0, 0, 0, 0];
  const short: string[] = [];
  for (const [egg, tier] of entries) {
    const clamped = Math.max(-1, Math.min(TOP_TIER_INDEX, Math.round(tier)));
    byTier[clamped + 1] += 1;
    if (clamped < TOP_TIER_INDEX) short.push(`${egg} ${clamped < 0 ? 'none' : `T${clamped + 1}`}`);
  }

  return {
    maxed: short.length === 0,
    byTier,
    total: entries.length,
    short: short.slice(0, MAX_SHORT_ITEMS),
  };
}

/** One line for a CSV header or a tooltip: `epic research max` / `epic research 34/36 at max`. */
export function describeEpicResearch(s: EpicResearchSummary | null): string {
  if (!s) return '';
  return s.maxed ? 'max' : `${s.atMax}/${s.total} at max`;
}

/** `all T4` / `3 at T4, 2 at T3, 7 none`. */
export function describeColleggtibles(s: ColleggtibleSummary | null): string {
  if (!s) return '';
  if (s.maxed) return `all T${TOP_TIER_INDEX + 1}`;
  const labels = ['none', 'T1', 'T2', 'T3', 'T4'];
  return s.byTier
    .map((count, i) => (count ? `${count} ${i === 0 ? 'none' : `at ${labels[i]}`}` : null))
    .filter(Boolean)
    .reverse()
    .join(', ');
}
