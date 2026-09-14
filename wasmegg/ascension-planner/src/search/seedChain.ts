/**
 * @module seedChain
 * @description Builds the chain the search starts from when the user has not supplied one, and
 * reports why a supplied one will not work.
 *
 * WHY THE SEED'S LENGTH IS LOAD-BEARING. Coordinate descent only MOVES checkpoints, and the
 * prestige-count probe adds at most one, so a search cannot grow a 2-checkpoint seed into the
 * 6-checkpoint answer the Limits box is asking for. A short seed does not make the search slower;
 * it makes the requested answer unreachable. Defaulting to `<final>` alone, or to whatever single
 * number happened to be in the Target TE field, quietly did exactly that.
 *
 * SPACING. Checkpoints are spaced geometrically rather than evenly, because measured optima are:
 * `195 226 277 317 490` and `195 219 248 286 327 490` both open with small gaps and widen. A
 * seed only has to land in the right basin for descent to polish, so this is deliberately a shape
 * rather than a prediction, and the coarse scan ("find a starting chain for me") remains the
 * better option for anyone without a chain they trust.
 */

export interface SeedChainOptions {
  /** Where the account is now. Checkpoints at or below this are not reachable ascensions. */
  currentTE: number;
  /** The chain's final target, always the last entry of the result. */
  finalTE: number;
  minPrestiges: number;
  maxPrestiges: number;
}

/**
 * Highest a non-final checkpoint is allowed to sit, mirroring the driver's own `maxLast` default.
 * A last checkpoint near the target pays a full farm rebuild for almost no earning time.
 */
export const MAX_LAST_GAP = 150;

/** First checkpoint sits this far above current TE, so the opening leg is a real ascension. */
const FIRST_GAP = 8;

/**
 * A chain of `clamp(6, min, max)` ascensions from `currentTE` to `finalTE`, inclusive of the
 * final target. Six is the middle of the default 5-8 range and the same length the chain-count
 * estimate already assumes when the coarse scan is picking.
 *
 * Returns `[finalTE]` only when there is genuinely no room for an intermediate checkpoint, which
 * the caller should treat as "this account is too close to its target to need a chain".
 */
export function defaultSeedChain({ currentTE, finalTE, minPrestiges, maxPrestiges }: SeedChainOptions): number[] {
  const lo = Math.floor(currentTE) + FIRST_GAP;
  // `final - 150` is a cap measured against 490 targets, and it leaves no room at all on a shorter
  // one: current 173 to a 320 target puts the cap at 170, below where the chain even starts, while
  // a measured optimum for that pair is `195 231 277 320`. So fall back the same way
  // `planCoarseGrid` does rather than returning no chain. A seed above the driver's own `maxLast`
  // is safe: the driver clamps the last checkpoint and sweeps it regardless (see driver.spec.ts,
  // "sweeps the last checkpoint even when the seed starts above maxLast").
  let hi = Math.floor(finalTE) - MAX_LAST_GAP;
  if (hi <= lo) hi = Math.floor(finalTE) - 20;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [Math.floor(finalTE)];

  const low = Math.max(1, Math.floor(minPrestiges));
  const high = Math.max(low, Math.floor(maxPrestiges));
  const ascensions = Math.min(high, Math.max(low, 6));

  // `ascensions` counts the final target, so this many checkpoints sit before it.
  const intermediate = ascensions - 1;
  if (intermediate < 1) return [Math.floor(finalTE)];
  if (intermediate === 1) return [Math.round((lo + hi) / 2), Math.floor(finalTE)];

  const ratio = Math.pow(hi / lo, 1 / (intermediate - 1));
  const chain: number[] = [];
  for (let i = 0; i < intermediate; i++) {
    const value = Math.round(lo * Math.pow(ratio, i));
    // Rounding can collide on a narrow range; keep the chain strictly increasing, which every
    // consumer downstream assumes.
    const previous = chain.length ? chain[chain.length - 1] : lo - 1;
    chain.push(Math.max(value, previous + 1));
  }

  // Nudging for strictness above can push the tail past its cap on a very narrow range. Drop
  // anything that no longer fits rather than emitting a chain the driver would reject.
  const capped = chain.filter(v => v > currentTE && v <= hi);
  return [...capped, Math.floor(finalTE)];
}

export type SeedIssue =
  | { kind: 'too-short'; ascensions: number; minPrestiges: number; probeCanFix: boolean }
  | { kind: 'too-long'; ascensions: number; maxPrestiges: number; probeCanFix: boolean };

/**
 * Why the current seed cannot produce an answer inside the Limits box, or null when it can.
 *
 * THE LIMITS ARE NOT A CAP ON THE SEED. `minCheckpoints`/`maxCheckpoints` reach the driver, but
 * they only gate the prestige-count probe (stage 7) and the coarse scan. Stages 4, 4a, 5 and 6 all
 * run on the seed at whatever length it arrives, so a 5-ascension seed under a maximum of 4 is
 * explored as a 5 and comes back as a 5.
 *
 * `countProbe` is therefore load-bearing: on Quick and Balanced the probe does not run at all, so
 * nothing anywhere in the run will change the seed's length and the limits are decorative. On
 * Normal and Thorough the probe can add or drop exactly one checkpoint, so a seed one outside the
 * range can still land inside it, and reporting that as broken would be wrong.
 */
export function seedChainIssue(
  chain: number[],
  minPrestiges: number,
  maxPrestiges: number,
  opts: { countProbe: boolean }
): SeedIssue | null {
  const ascensions = chain.length;
  const slack = opts.countProbe ? 1 : 0;

  if (ascensions < minPrestiges - slack) {
    return { kind: 'too-short', ascensions, minPrestiges, probeCanFix: false };
  }
  if (ascensions > maxPrestiges + slack) {
    return { kind: 'too-long', ascensions, maxPrestiges, probeCanFix: false };
  }
  // Inside the range once the probe's one step is counted, but only because of it. Worth saying:
  // the probe is allowed to decline, so this is a "probably" rather than a guarantee.
  if (slack && (ascensions < minPrestiges || ascensions > maxPrestiges)) {
    return ascensions < minPrestiges
      ? { kind: 'too-short', ascensions, minPrestiges, probeCanFix: true }
      : { kind: 'too-long', ascensions, maxPrestiges, probeCanFix: true };
  }
  return null;
}

/**
 * The seed trimmed or padded to sit inside the limits, for the panel's one-click fix.
 *
 * Trimming drops interior checkpoints furthest from the ends first, which keeps the opening leg
 * (usually the best-validated value, and the one `pin` protects) and the last checkpoint (the one
 * every sweep re-solves anyway). Padding inserts midpoints into the widest gaps.
 */
export function fitSeedToLimits(chain: number[], minPrestiges: number, maxPrestiges: number): number[] {
  if (chain.length < 2) return chain;
  const final = chain[chain.length - 1];
  let interior = chain.slice(0, -1);

  const maxInterior = Math.max(1, Math.floor(maxPrestiges) - 1);
  while (interior.length > maxInterior && interior.length > 1) {
    // Drop the checkpoint whose removal leaves the most even spacing, which is the one currently
    // closest to its neighbours.
    let dropAt = 1;
    let smallestSpan = Infinity;
    for (let i = 1; i < interior.length - 1; i++) {
      const span = interior[i + 1] - interior[i - 1];
      if (span < smallestSpan) {
        smallestSpan = span;
        dropAt = i;
      }
    }
    if (interior.length === 2) dropAt = 1;
    interior = [...interior.slice(0, dropAt), ...interior.slice(dropAt + 1)];
  }

  const minInterior = Math.max(1, Math.floor(minPrestiges) - 1);
  let guard = 0;
  while (interior.length < minInterior && guard++ < 32) {
    let gapAt = 0;
    let widest = -Infinity;
    const points = [...interior, final];
    for (let i = 0; i < points.length - 1; i++) {
      const gap = points[i + 1] - points[i];
      if (gap > widest) {
        widest = gap;
        gapAt = i;
      }
    }
    const inserted = Math.floor((points[gapAt] + points[gapAt + 1]) / 2);
    if (inserted <= points[gapAt] || inserted >= points[gapAt + 1]) break;
    interior = [...interior.slice(0, gapAt + 1), inserted, ...interior.slice(gapAt + 1)];
  }

  return [...interior, final];
}

/**
 * The checkpoints from a typed chain that the search can actually use.
 *
 * Drops anything at or below current TE, because "ascend to 135" is not something a 159 TE account
 * can do and the simulator does not survive being asked, and anything at or above the final
 * target, which is appended separately. Order and duplicates are the caller's problem; this only
 * decides membership.
 */
export function usableCheckpoints(raw: number[], currentTE: number, finalTE: number): number[] {
  return raw.filter(v => Number.isFinite(v) && v > currentTE && v < finalTE);
}
