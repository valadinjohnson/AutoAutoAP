import { ei } from 'lib/proto';
import {
  Artifact,
  ArtifactSet,
  Inventory,
  recommendArtifactSet,
  Strategy,
  contenderToArtifactSet,
  newItem,
} from 'lib/artifacts';
import { allModifiersFromColleggtibles, maxModifierFromColleggtibles, Modifiers } from 'lib/collegtibles';
import { getNumTruthEggs } from 'lib/earning_bonus';
import { cteFromArtifacts, cteFromColleggtibles, cteFromLabUpgrade, multiplierToTE } from 'lib/virtue';
import {
  eggValueMultiplier,
  awayEarningsMultiplier,
  researchPriceMultiplierFromArtifacts,
} from 'lib/artifacts/virtue_effects';
import { EquippedArtifact } from './types';
import { libArtifactToEquippedArtifact, equippedArtifactsToLibArtifacts } from './utils';
import { calculateArtifactModifiers, createEmptyLoadout } from './calculator';
import { calculateLayRate } from '@/calculations/layRate';
import {
  calculateShippingCapacity,
  calculateMaxVehicleSlots,
  calculateMaxTrainLength,
} from '@/calculations/shippingCapacity';
import { calculateEffectiveLayRate } from '@/calculations/effectiveLayRate';
import { calculateHabCapacity_Full } from '@/calculations/habCapacity';
import { getArtifact, getStone, artifactOptions } from './data';
import { InventoryItem } from 'lib/artifacts';
import { VehicleSlot } from '@/types';
import { DEBUG_ELR_STRUCTURE_CACHE, DEBUG_ELR_STRUCTURE_VERIFY } from '@/lib/debugFlags';

// ---------------------------------------------------------------------------------------------
// Artifact-structure cache for getOptimalELRSet.
//
// Which artifacts are worth equipping depends only on owned inventory and target-artifact tiers,
// neither of which a research purchase changes. Only stone placement depends on the current
// research state, since that determines whether lay rate or shipping capacity is the bottleneck.
// `forcedArtifacts` (see its doc comment on getOptimalELRSet below) already exploits this within
// one call: `rankResearchByELRImpact` runs the up-to-495-combo structure search once as a
// baseline, then forces every candidate and lookahead call onto that same structure. This cache
// extends the same assumption across calls, for the lifetime of one `backup` object: since a
// backup's artifact inventory doesn't change during a chain-search run, the winning structure for
// a given (assumeMaxHabsVehicles, excludeGusset) pair only needs to be found once per run.
//
// The cache is a WeakMap keyed on the backup object itself, so a different backup is a miss by
// construction and an old backup's entry is freed once nothing else references it. No hashing or
// explicit invalidation involved. If something upstream ever clones `rawBackup` before it reaches
// here (every call site currently threads the same `context.rawBackup` reference through, so this
// doesn't appear to happen), the worst case is a permanent miss, not a stale hit.
//
// Only the structure (which artifact per slot) is cached. Stone placement is always re-solved
// fresh by the recursive `forcedArtifacts` call below, the same way `rankResearchByELRImpact`'s
// own per-candidate calls already do.
//
// The `forcedArtifacts` assumption above was written for candidates within one ascension's
// research range. A chain-search run spans many ascensions and a much wider range of research
// states, and this cache now holds the first structure computed for a given (assumeMax,
// excludeGusset) pair for the rest of the run. `DEBUG_ELR_STRUCTURE_VERIFY` checks that
// assumption. See its doc comment in lib/debugFlags.ts.
/**
 * Master on/off switch for the cache, separate from the DEBUG_ELR_STRUCTURE_* logging flags in
 * debugFlags.ts, which only control whether it logs, not whether it runs. Flip this to `false`
 * and rebuild for an apples-to-apples "before" timing without touching git or the rest of this
 * file; flip back to `true` (the shipped default) for the "after" run. Every call falls through
 * to the original uncached search when this is `false`.
 */
const STRUCTURE_CACHE_ENABLED = true;

const structureCache = new WeakMap<ei.IBackup, Map<string, (string | null)[]>>();

function structureCacheKey(assumeMax: boolean, excludeGusset: boolean): string {
  return `${assumeMax ? 1 : 0}${excludeGusset ? 1 : 0}`;
}

/** Every `console.log`/`console.warn` below runs inside a Web Worker during a real search, same as
 *  the existing DEBUG_SHIFT_TIMING etc. It's still visible in the browser's devtools Console panel. */
const ELR_STRUCTURE_LOG_EVERY = 200;
const ELR_STRUCTURE_VERIFY_EVERY = 25;

const structureStats = {
  hits: 0,
  misses: 0,
  /** Wall time spent inside every miss (the full combo search), in milliseconds. */
  missMs: 0,
  /** Wall time spent inside every hit (structure lookup plus one forced stone-solve), in ms. */
  hitMs: 0,
};

/** Estimated wall time this run would have spent with the cache off, versus what it actually
 *  spent: every hit is assumed to have cost the running average miss time, since that's what it
 *  would have paid without the cache. Call from the devtools console mid-run or at the end. */
export function logELRStructureCacheStats(): void {
  const avgMiss = structureStats.misses ? structureStats.missMs / structureStats.misses : 0;
  const withoutCacheMs = structureStats.missMs + structureStats.hits * avgMiss;
  const withCacheMs = structureStats.missMs + structureStats.hitMs;
  const savedMs = withoutCacheMs - withCacheMs;
  const pct = withoutCacheMs > 0 ? (100 * savedMs) / withoutCacheMs : 0;
  console.log(
    `[getOptimalELRSet structure cache] ${structureStats.hits} hits, ${structureStats.misses} misses ` +
      `(avg miss ${avgMiss.toFixed(2)}ms). Est. without cache: ${withoutCacheMs.toFixed(0)}ms, ` +
      `with cache: ${withCacheMs.toFixed(0)}ms -> saved ~${savedMs.toFixed(0)}ms (${pct.toFixed(1)}%) ` +
      `of this function's own time so far.`
  );
}

export function resetELRStructureCacheStats(): void {
  structureStats.hits = 0;
  structureStats.misses = 0;
  structureStats.missMs = 0;
  structureStats.hitMs = 0;
}

/**
 * Get the optimal artifact set for earnings (Clothed TE).
 */
export function getOptimalEarningsSet(backup: ei.IBackup): EquippedArtifact[] {
  if (!backup.artifactsDb) {
    return createEmptyLoadout();
  }

  const inventory = new Inventory(backup.artifactsDb, { virtue: true });

  const libArtifacts: Artifact[] = [];
  const db = backup.artifactsDb?.virtueAfxDb;
  if (db && db.inventoryItems && db.activeArtifacts?.slots) {
    const itemIdToArtifact = new Map(db.inventoryItems.map(item => [item.itemId!, item.artifact!]));
    for (const slot of db.activeArtifacts.slots) {
      if (slot.occupied && slot.itemId !== undefined && slot.itemId !== null) {
        const artifact = itemIdToArtifact.get(slot.itemId);
        if (artifact && artifact.spec) {
          libArtifacts.push(
            new Artifact(
              newItem(artifact.spec),
              (artifact.stones || []).map(s => newItem(s))
            )
          );
        }
      }
    }
  }
  const equipped = new ArtifactSet(libArtifacts, false);

  const strategy =
    backup.game?.permitLevel === 1 ? Strategy.PRO_PERMIT_VIRTUE_CTE : Strategy.STANDARD_PERMIT_VIRTUE_CTE;

  const contender = recommendArtifactSet(backup, strategy);
  const { artifactSet } = contenderToArtifactSet(contender, equipped, inventory);

  return artifactSet.artifacts.map(libArtifactToEquippedArtifact);
}

/**
 * Calculate Clothed TE for an arbitrary artifact set (e.g. a candidate set the
 * player hasn't equipped yet), driven by the planner's own live initial-state
 * inputs rather than a frozen backup snapshot. Mirrors virtue-companion's
 * `calculateClothedTE`, composed from the same shared `lib/virtue` primitives.
 */
export function calculateClothedTEForSet(
  loadout: EquippedArtifact[],
  options: {
    truthEggs: number;
    colleggtibleModifiers: Modifiers;
    labUpgradeLevel: number;
    permitLevel?: number | null;
  }
): number {
  const artifacts = equippedArtifactsToLibArtifacts(loadout);
  // Standard permit halves offline earnings; Pro permit (permitLevel === 1) does not.
  const permitPenalty = options.permitLevel === 1 ? 0 : multiplierToTE(0.5);

  return (
    options.truthEggs +
    cteFromArtifacts(artifacts) +
    cteFromColleggtibles(options.colleggtibleModifiers) +
    cteFromLabUpgrade(options.labUpgradeLevel) +
    permitPenalty
  );
}

/**
 * Get the optimal artifact set for ELR (Effective Lay Rate).
 * Factors in Metronomes, Compasses, Gussets, and Tachyon/Quantum stones.
 */
export function getOptimalELRSet(
  backup: ei.IBackup,
  options: {
    assumeMaxHabsVehicles?: boolean;
    currentSet?: (EquippedArtifact | null)[];
    excludeGusset?: boolean;
    commonResearch?: Record<string, number>;
    epicResearchLevels?: Record<string, number>;
    colleggtibleModifiers?: any;
    /**
     * Skip the up-to-495-combo artifact STRUCTURE search entirely and evaluate stone placement for
     * exactly this structure instead — one `artifactId` per slot (`null` for an empty slot), same
     * shape as a prior call's own return value's `.map(slot => slot.artifactId)`. Any stones on
     * those slots are ignored; stone placement is always re-solved fresh against the given research
     * state, since which stone type (tachyon vs. quantum) belongs in each slot depends on which of
     * lay rate/shipping capacity is currently the bottleneck — that shifts as research levels
     * change, even though which ARTIFACTS are worth equipping doesn't (that's driven by owned
     * inventory and target-artifact tiers, neither of which a research purchase changes). Intended
     * for callers that already know the winning structure from an earlier, unforced call against
     * the same backup (e.g. `rankResearchByELRImpact`'s baseline call) and just want that same
     * structure's stats at a different research level — skipping the structure search this way is
     * roughly 500x cheaper per call, since only one structure's stone placement runs instead of
     * every combo's.
     */
    forcedArtifacts?: (string | null)[];
    /** Internal/debug-only: skip the structure-cache lookup even though `forcedArtifacts` is
     *  unset, forcing a genuine full search. Used only by `DEBUG_ELR_STRUCTURE_VERIFY`'s own
     *  comparison call; don't set this from ordinary calling code. */
    bypassStructureCache?: boolean;
  } = {}
): EquippedArtifact[] {
  if (!backup.artifactsDb) {
    return createEmptyLoadout();
  }

  const assumeMax = options.assumeMaxHabsVehicles ?? false;
  const excludeGusset = options.excludeGusset ?? false;

  // Structure cache: an unforced call whose (backup, assumeMax, excludeGusset) triple has already
  // been solved skips straight to the cheap forcedArtifacts path instead of repeating the
  // up-to-495-combo search. See the module-level doc comment on `structureCache` above for why
  // this is safe and what it does not cover.
  if (STRUCTURE_CACHE_ENABLED && !options.forcedArtifacts && !options.bypassStructureCache) {
    const perBackup = structureCache.get(backup);
    const cached = perBackup?.get(structureCacheKey(assumeMax, excludeGusset));
    if (cached) {
      const t0 = DEBUG_ELR_STRUCTURE_CACHE || DEBUG_ELR_STRUCTURE_VERIFY ? performance.now() : 0;
      const result = getOptimalELRSet(backup, { ...options, forcedArtifacts: cached });
      if (DEBUG_ELR_STRUCTURE_CACHE) {
        structureStats.hits++;
        structureStats.hitMs += performance.now() - t0;
        if (structureStats.hits % ELR_STRUCTURE_LOG_EVERY === 0) logELRStructureCacheStats();
      }
      if (DEBUG_ELR_STRUCTURE_VERIFY && structureStats.hits % ELR_STRUCTURE_VERIFY_EVERY === 0) {
        // Force a genuine full search purely to compare. `bypassStructureCache` is the only way to
        // get one here without `forcedArtifacts`, since the cache under test would otherwise just
        // answer its own question.
        const fresh = getOptimalELRSet(backup, { ...options, forcedArtifacts: undefined, bypassStructureCache: true });
        const cachedMods = calculateArtifactModifiers(result);
        const freshMods = calculateArtifactModifiers(fresh);
        // Compare the eggLayingRate and shippingRate multipliers the two structures deliver, as a
        // cheap proxy for whether the cached structure still holds up. Anything past floating-point
        // noise means the cached structure isn't actually optimal for this research state, and the
        // cross-ascension caching assumption doesn't hold on this account.
        const drift = (a: number, b: number) => Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
        if (
          drift(cachedMods.eggLayingRate.totalMultiplier, freshMods.eggLayingRate.totalMultiplier) ||
          drift(cachedMods.shippingRate.totalMultiplier, freshMods.shippingRate.totalMultiplier)
        ) {
          console.warn(
            '[getOptimalELRSet structure cache] MISMATCH: the cached structure ' +
              `${JSON.stringify(cached)} no longer matches a fresh search's ` +
              `${JSON.stringify(fresh.map(s => s.artifactId))} for assumeMax=${assumeMax} ` +
              `excludeGusset=${excludeGusset}. The cross-ascension caching assumption does not ` +
              'hold on this account — do not trust the cached speedup without investigating.'
          );
        }
      }
      return result;
    }
  }

  const t0Miss = DEBUG_ELR_STRUCTURE_CACHE && !options.forcedArtifacts ? performance.now() : 0;
  const inventory = new Inventory(backup.artifactsDb, { virtue: true });
  const colleggtibles = options.colleggtibleModifiers ?? allModifiersFromColleggtibles(backup);

  // 1. Gather research levels
  const commonResearch: Record<string, number> = options.commonResearch ?? {};
  if (!options.commonResearch) {
    for (const r of backup.farms?.[0]?.commonResearch || []) {
      if (r.id) commonResearch[r.id] = r.level || 0;
    }
  }

  const epicResearchLevels: Record<string, number> = options.epicResearchLevels ?? {};
  if (!options.epicResearchLevels) {
    for (const r of backup.game?.epicResearch || []) {
      if (r.id) epicResearchLevels[r.id] = r.level || 0;
    }
  }

  // 2. Identify candidate artifact STRUCTURES to search over — skipped entirely when
  // `forcedArtifacts` is given (see that option's own doc comment): the search collapses to the
  // one caller-supplied structure instead of the up-to-495-combo search below, so step 4 only ever
  // evaluates stone placement for that one structure.
  let candidateLoadouts: EquippedArtifact[][];

  if (options.forcedArtifacts) {
    const forcedLoadout: EquippedArtifact[] = options.forcedArtifacts.map(artifactId => ({
      artifactId,
      stones: new Array(artifactId ? (getArtifact(artifactId)?.slots ?? 0) : 0).fill(null),
    }));
    while (forcedLoadout.length < 4) forcedLoadout.push({ artifactId: null, stones: [] });
    candidateLoadouts = [forcedLoadout];
  } else {
    const name = ei.ArtifactSpec.Name;
    const targetAfxIds = new Set([name.QUANTUM_METRONOME, name.INTERSTELLAR_COMPASS, name.ORNATE_GUSSET]);

    // Candidate Wrapper
    type Candidate = { item: InventoryItem; rarity: ei.ArtifactSpec.Rarity; slots: number; isTarget: boolean };
    const afxGroups = new Map<number, Candidate[]>();

    for (const item of inventory.items) {
      if (item.have === 0 || !item.isArtifact) continue;

      const afxId = item.afxId;
      if (excludeGusset && afxId === name.ORNATE_GUSSET) continue;

      const isTarget = targetAfxIds.has(afxId);

      // Find best rarity for this tier
      for (const rarity of [
        ei.ArtifactSpec.Rarity.LEGENDARY,
        ei.ArtifactSpec.Rarity.EPIC,
        ei.ArtifactSpec.Rarity.RARE,
        ei.ArtifactSpec.Rarity.COMMON,
      ]) {
        if (item.haveRarity[rarity] > 0) {
          const slots = item.stoneSlotCount(rarity);
          const cand: Candidate = { item, rarity, slots, isTarget };

          if (!afxGroups.has(afxId)) afxGroups.set(afxId, []);
          afxGroups.get(afxId)!.push(cand);
          break; // Only take best rarity of each tier
        }
      }
    }

    const finalCandidates: Candidate[] = [];

    // Sort each AFX group by "goodness"
    for (const [afxId, group] of afxGroups.entries()) {
      const isTarget = targetAfxIds.has(afxId);

      if (isTarget) {
        // Keep only the Pareto-optimal tier/rarity for this family: a candidate
        // is dropped when some other owned tier is at least as good on both
        // base effect delta and stone slots (and strictly better on one). This
        // reduces a T4 Legendary (typically max delta AND max slots) down to a
        // single candidate, but keeps genuine trade-offs alive -- e.g. a T2
        // Epic Gusset (fewer tiers, more slots) survives alongside a T4 Common
        // Gusset (more delta, no slots) because neither dominates the other,
        // and it's the stone/ELR search below that has to settle it.
        const delta = (c: Candidate) => c.item.effectDelta(c.rarity);
        const pareto = group.filter(
          a =>
            !group.some(
              b => b !== a && delta(b) >= delta(a) && b.slots >= a.slots && (delta(b) > delta(a) || b.slots > a.slots)
            )
        );
        finalCandidates.push(...pareto);
      } else {
        group.sort((a, b) => {
          if (a.slots !== b.slots) return b.slots - a.slots;
          return b.item.tierNumber - a.item.tierNumber;
        });
        // For non-targets, we only care about the single best carrier from this family
        finalCandidates.push(group[0]);
      }
    }

    // Pick top 4 of the non-target leaders based on slots
    const targetCands = finalCandidates.filter(c => c.isTarget);
    const nonTargetCands = finalCandidates
      .filter(c => !c.isTarget)
      .sort((a, b) => b.slots - a.slots)
      .slice(0, 4);

    const topCandidates = [...targetCands, ...nonTargetCands];

    // Search through combinations of 1 to 4 artifacts
    // 12C4 = 495, which is small enough.
    function combinations<T>(array: T[], r: number): T[][] {
      const result: T[][] = [];
      function helper(start: number, combo: T[]) {
        if (combo.length === r) {
          result.push([...combo]);
          return;
        }
        for (let i = start; i < array.length; i++) {
          helper(i + 1, [...combo, array[i]]);
        }
      }
      helper(0, []);
      return result;
    }

    const combos = [
      ...combinations(topCandidates, 1),
      ...combinations(topCandidates, 2),
      ...combinations(topCandidates, 3),
      ...combinations(topCandidates, 4),
    ];

    candidateLoadouts = combos
      .filter(comboWrappers => {
        // Ensure all artifacts in the combination are from unique families
        const families = new Set(comboWrappers.map(w => w.item.props.family.afx_id));
        return families.size === comboWrappers.length;
      })
      .map(comboWrappers => {
        const loadout: EquippedArtifact[] = comboWrappers.map(wrapper => ({
          // Use the family ID from props. This maps correctly to gusset-x-y instead of ornate-gusset-x-y
          artifactId: `${wrapper.item.props.family.id}-${wrapper.item.tierNumber}-${wrapper.rarity}`,
          stones: new Array(wrapper.slots).fill(null),
        }));
        while (loadout.length < 4) loadout.push({ artifactId: null, stones: [] });
        return loadout;
      });
  }

  // 3. Gather available stones (Tachyon and Quantum)
  const tachyonStones = inventory.items
    .filter(i => i.isStone && i.props.family.id === 'tachyon-stone' && i.tierNumber >= 2)
    .map(i => ({
      id: i.id,
      delta: i.props.effects?.[0]?.effect_delta || 0,
      count: i.haveCommon,
      tier: i.tierNumber,
    }))
    .sort((a, b) => b.tier - a.tier);

  const quantumStones = inventory.items
    .filter(i => i.isStone && i.props.family.id === 'quantum-stone' && i.tierNumber >= 2)
    .map(i => ({
      id: i.id,
      delta: i.props.effects?.[0]?.effect_delta || 0,
      count: i.haveCommon,
      tier: i.tierNumber,
    }))
    .sort((a, b) => b.tier - a.tier);

  // 4. Optimization Loop
  let bestSet: EquippedArtifact[] = createEmptyLoadout();
  let maxELR = -1;
  let bestMetrics: any = null;

  for (const loadout of candidateLoadouts) {
    // Balance stones
    const totalStoneSlots = loadout.reduce((sum, slot) => sum + slot.stones.length, 0);

    let bestStonesForThisLoadout: (string | null)[] = [];
    let bestELRForThisLoadout = -1;
    let bestMetricsForThisLoadout: any = null;

    const evaluateStones = (stones: (string | null)[]) => {
      const tempLoadout: EquippedArtifact[] = JSON.parse(JSON.stringify(loadout));
      let sIdx = 0;
      for (const slot of tempLoadout) {
        for (let i = 0; i < slot.stones.length; i++) {
          slot.stones[i] = stones[sIdx++];
        }
      }

      const artifactMods = calculateArtifactModifiers(tempLoadout);

      // Hab Capacity
      const habIds = assumeMax ? [18, 18, 18, 18] : (backup.farms?.[0]?.habs || []).map(h => (h === 19 ? null : h));
      while (!assumeMax && habIds.length < 4) habIds.push(null);

      const habCapOutput = calculateHabCapacity_Full({
        habIds: habIds as any,
        researchLevels: commonResearch,
        habCapMultiplier: colleggtibles.habCap,
        artifactMultiplier: artifactMods.habCapacity.totalMultiplier,
        artifactEffects: artifactMods.habCapacity.effects,
      });
      const population = habCapOutput.totalFinalCapacity;

      // Lay Rate
      const layRateOutput = calculateLayRate({
        researchLevels: commonResearch,
        epicComfyNestsLevel: epicResearchLevels['epic_egg_laying'] || 0,
        elrMultiplier: colleggtibles.elr,
        population,
        artifactMultiplier: artifactMods.eggLayingRate.totalMultiplier,
        artifactEffects: artifactMods.eggLayingRate.effects,
      });

      // Shipping Capacity
      let vehicles: VehicleSlot[] = [];
      const farm = backup.farms?.[0];
      if (farm) {
        if (assumeMax) {
          const totalSlots = calculateMaxVehicleSlots(commonResearch);
          const maxTrainLen = calculateMaxTrainLength(commonResearch);
          vehicles = new Array(totalSlots).fill(null).map(() => ({ vehicleId: 11, trainLength: maxTrainLen }));
        } else {
          // Map from backup number arrays
          const vehicleTypes = farm.vehicles || [];
          const trainLengths = farm.trainLength || [];
          vehicles = vehicleTypes.map((type, i) => ({
            vehicleId: type,
            trainLength: trainLengths[i] || 1,
          }));
        }
      } else {
        vehicles = [{ vehicleId: 0, trainLength: 1 }];
      }

      const shippingOutput = calculateShippingCapacity({
        vehicles,
        researchLevels: commonResearch,
        transportationLobbyistLevel: epicResearchLevels['transportation_lobbyist'] || 0,
        shippingCapMultiplier: colleggtibles.shippingCap,
        artifactMultiplier: artifactMods.shippingRate.totalMultiplier,
        artifactEffects: artifactMods.shippingRate.effects,
      });

      const elr = calculateEffectiveLayRate(layRateOutput.totalRatePerSecond, shippingOutput.totalFinalCapacity);

      return {
        layRate: layRateOutput.totalRatePerSecond,
        shipRate: shippingOutput.totalFinalCapacity,
        elr: elr.effectiveLayRate,
        population,
        habs: habIds,
        vehicles,
      };
    };

    const remTachyonStones = tachyonStones.map(s => ({ ...s }));
    const remQuantumStones = quantumStones.map(s => ({ ...s }));
    const currentStones: (string | null)[] = new Array(totalStoneSlots).fill(null);

    for (let slotIdx = 0; slotIdx < totalStoneSlots; slotIdx++) {
      const metrics = evaluateStones(currentStones);

      if (metrics.layRate < metrics.shipRate) {
        const bestTachyon = remTachyonStones.find(s => s.count > 0);
        if (bestTachyon) {
          currentStones[slotIdx] = bestTachyon.id;
          bestTachyon.count--;
        } else {
          const bestQuantum = remQuantumStones.find(s => s.count > 0);
          if (bestQuantum) {
            currentStones[slotIdx] = bestQuantum.id;
            bestQuantum.count--;
          }
        }
      } else {
        const bestQuantum = remQuantumStones.find(s => s.count > 0);
        if (bestQuantum) {
          currentStones[slotIdx] = bestQuantum.id;
          bestQuantum.count--;
        } else {
          const bestTachyon = remTachyonStones.find(s => s.count > 0);
          if (bestTachyon) {
            currentStones[slotIdx] = bestTachyon.id;
            bestTachyon.count--;
          }
        }
      }
    }

    currentStones.sort((a, b) => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;

      const isTa = a.indexOf('quantum') === 0;
      const isTb = b.indexOf('quantum') === 0;
      if (isTa && !isTb) return -1;
      if (!isTa && isTb) return 1;

      const tierA = parseInt(a.split('-').pop() || '0', 10);
      const tierB = parseInt(b.split('-').pop() || '0', 10);
      return tierB - tierA;
    });

    const finalMetrics = evaluateStones(currentStones);
    bestELRForThisLoadout = finalMetrics.elr;
    bestStonesForThisLoadout = currentStones;
    bestMetricsForThisLoadout = finalMetrics;

    const currentBestLayRate = bestMetricsForThisLoadout?.layRate ?? -1;
    const globalBestLayRate = bestMetrics?.layRate ?? -1;

    const isGlobalBetter =
      bestELRForThisLoadout > maxELR || (bestELRForThisLoadout === maxELR && currentBestLayRate > globalBestLayRate);

    if (isGlobalBetter) {
      maxELR = bestELRForThisLoadout;
      const optimizedLoadout = JSON.parse(JSON.stringify(loadout));
      let sIdx = 0;
      for (const slot of optimizedLoadout) {
        for (let i = 0; i < slot.stones.length; i++) {
          slot.stones[i] = bestStonesForThisLoadout[sIdx++];
        }
      }
      bestSet = optimizedLoadout;
      bestMetrics = bestMetricsForThisLoadout;
    }
  }

  // This was a genuine structure search (not a forced single-structure re-solve): remember the
  // winner so the next unforced call for this (backup, assumeMax, excludeGusset) triple can skip
  // straight to it. See the module-level doc comment on `structureCache` above.
  if (!options.forcedArtifacts) {
    if (DEBUG_ELR_STRUCTURE_CACHE) {
      structureStats.misses++;
      structureStats.missMs += performance.now() - t0Miss;
    }
    if (STRUCTURE_CACHE_ENABLED) {
      let perBackup = structureCache.get(backup);
      if (!perBackup) {
        perBackup = new Map();
        structureCache.set(backup, perBackup);
      }
      perBackup.set(
        structureCacheKey(assumeMax, excludeGusset),
        bestSet.map(slot => slot.artifactId)
      );
    }
  }

  if (options.currentSet && isFunctionallyIdentical(bestSet, options.currentSet)) {
    return options.currentSet as EquippedArtifact[];
  }

  return bestSet;
}

/**
 * Compare two artifact sets for functional equivalence.
 */
export function isFunctionallyIdentical(
  setA: EquippedArtifact[],
  setB: (EquippedArtifact | null)[] | undefined
): boolean {
  if (!setA || !setB) return false;

  const targetAfxIds = [
    ei.ArtifactSpec.Name.QUANTUM_METRONOME,
    ei.ArtifactSpec.Name.INTERSTELLAR_COMPASS,
    ei.ArtifactSpec.Name.ORNATE_GUSSET,
  ];

  const normalize = (set: (EquippedArtifact | null)[]) => {
    const targets: string[] = []; // Target IDs (e.g. quantum-metronome-4-3)
    const holderSlots: number[] = []; // Slot counts for non-target artifacts
    const stoneCounts: Record<string, number> = {};

    for (const slot of set) {
      if (!slot?.artifactId) continue;
      const artifact = getArtifact(slot.artifactId);
      if (!artifact) continue;

      if (targetAfxIds.includes(artifact.afxId as any)) {
        targets.push(slot.artifactId);
      } else {
        holderSlots.push(artifact.slots);
      }

      for (const stoneId of slot.stones) {
        if (stoneId) {
          stoneCounts[stoneId] = (stoneCounts[stoneId] || 0) + 1;
        }
      }
    }

    return JSON.stringify({
      targets: targets.sort(),
      holders: holderSlots.sort((a, b) => a - b),
      stones: Object.entries(stoneCounts).sort((a, b) => a[0].localeCompare(b[0])),
    });
  };

  return normalize(setA) === normalize(setB);
}
