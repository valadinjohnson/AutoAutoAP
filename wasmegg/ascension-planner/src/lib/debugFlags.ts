/**
 * Central home for this app's "flip to true, temporarily, for debugging" console-log switches —
 * each one gates a specific investigation's logging, off by default. Collected in one leaf module
 * (rather than one local `const` per file) so unrelated layers (`calculations/`, `auto/`,
 * `components/`) can all import the same switch without introducing a dependency in the wrong
 * direction (nothing under `calculations/` otherwise depends on `auto/`, and this file lives in
 * `lib/`, already the common lower layer both of those import from), and so a flag shared across
 * multiple files (like `DEBUG_SHIFT_TIMING`, read by both `auto/ascension.ts` and
 * `auto/shifts/c3.ts`) can't silently drift into two independent copies — confirmed in practice
 * once already: flipping only one file's own local copy left the other's calls completely
 * unlogged.
 *
 * Each flag names the investigation it was added for in its own doc comment; delete a flag (and
 * its call sites' `if` guards) once that investigation is fully resolved, rather than letting them
 * accumulate indefinitely.
 */

/**
 * Log every shift's own wall-clock compute time — `auto/ascension.ts`'s `runUntilShift`/
 * `runAscension` (per-shift breakdown, including `C1K1I1Segment`'s C1/I1/K1 split), and
 * `auto/shifts/c3.ts`'s `runC3Variants` (per-variant breakdown, e.g. `3-sale-tier13`, `2-sale`).
 */
export const DEBUG_SHIFT_TIMING = false;

/**
 * Log each round of `computeResearchMilestoneChain`'s loop and `sweepUntilNextSale`'s own
 * candidate search (`calculations/milestoneChain.ts`) — visible in the browser's devtools Console
 * panel even though this runs inside a Web Worker.
 */
export const DEBUG_MILESTONE_CHAIN = false;

/**
 * Log why `simulateSaleAwareBuy`'s candidate search comes up empty — i.e. what the top of the ROI
 * ranking looked like at the moment it stopped finding anything to buy
 * (`calculations/smartBuyPreview.ts`). Gated separately from `DEBUG_MILESTONE_CHAIN` since this
 * function is also invoked by the manual planner's live "Buy Until Sale Warning" button, not just
 * the milestone chain.
 */
export const DEBUG_SALE_AWARE_BUY = false;

/**
 * Log each item `handleBuyMilestoneChain` executes (`components/actions/ResearchActions.vue`) —
 * `syncEventStateForItem`'s computed price/wait/crossings and `buyOneLevel`'s actual resulting
 * timestamp — so a live "Buy Entire Chain" run can be compared directly against the milestone
 * chain's own offline preview.
 */
export const DEBUG_MILESTONE_EXECUTION = false;

/**
 * Logs `getOptimalELRSet`'s artifact-structure cache (`lib/artifacts/virtue.ts`): hit/miss counts
 * and a running estimate of wall time saved, printed every `ELR_STRUCTURE_LOG_EVERY` calls (see
 * that constant in virtue.ts). Added while investigating the chain search's ~2.5s/leg cost: an
 * unforced `getOptimalELRSet` call re-runs the up-to-495-combo artifact search from scratch, even
 * though, per that function's own `forcedArtifacts` doc comment, which artifacts are worth
 * equipping is driven only by owned inventory and target-artifact tiers, never by research levels
 * (those only affect stone placement). So the winning structure is cacheable per (backup,
 * assumeMaxHabsVehicles, excludeGusset), and every later call can skip straight to
 * `forcedArtifacts`, roughly 500x cheaper per that same comment. Safe to leave on during a real
 * profiling run; it only logs, it doesn't change which chains get evaluated.
 */
export const DEBUG_ELR_STRUCTURE_CACHE = false;

/**
 * Cross-checks the structure cache above against a full, uncached search on every Nth hit (see
 * `ELR_STRUCTURE_VERIFY_EVERY` in virtue.ts) and warns if the resulting ELR differs by more than a
 * tiny epsilon. This is the actual correctness test for the caching assumption above, run against
 * your own backup and inventory rather than taken on faith: the assumption was written for one
 * call's own candidates, within a single `rankResearchByELRImpact` invocation, and this flag
 * checks whether it still holds stretched across a whole chain-search run, which spans very
 * different research states from one ascension to the next. Turn this off for a real timed
 * profiling run (the verification search defeats the speedup you're trying to measure) and on for
 * a separate, shorter correctness check first.
 */
export const DEBUG_ELR_STRUCTURE_VERIFY = false;
