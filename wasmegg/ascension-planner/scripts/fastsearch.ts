/**
 * Headless chain search - the planner's own simulator, no browser.
 *
 * The predecessor to this drove the real UI through Selenium at ~35s per chain.
 * This calls the same simulation functions the app calls (runUntilShift ->
 * runC3Variants -> runAscensionFromC3Variant, chosen with the app's own
 * pickVariant) directly in Node.
 *
 * MEASURED, so nobody repeats my mistake: one leg simulation costs about SIX
 * SECONDS here. Chrome was never the bottleneck - the simulator is. Removing the
 * browser alone buys very little. The speed comes from the two things below plus
 * --jobs, and a fair comparison against 4 parallel Selenium workers is a handful
 * of times faster, not orders of magnitude.
 *
 * Two wins fall out of being in-process:
 *
 *   - PREFIX SHARING. Chains form a trie: every chain starting 195/226/277
 *     shares the A1, A2 and A3 simulations. The Selenium driver recomputed all
 *     five legs for every combo; this walks the trie depth-first and simulates
 *     each distinct prefix exactly once.
 *
 *   - ONE PLAN START for the whole run, by construction. A plan's duration
 *     depends on (chain, plan_start) jointly, and that hidden variable is what
 *     made cross-batch comparisons in the CSV corpus invalid - it falsified both
 *     the "X4 = 0 mod 4" rule and the "X2 225-231 all tie" rule. Here the start
 *     is pinned once and shared by every chain in the run.
 *
 * TWO MODES.
 *
 *   --effort <tier>   Runs the SAME staged search the browser panel runs, against the same
 *                     evaluator, by importing src/search/driver.ts and src/search/chain.ts
 *                     directly. Not a reimplementation: one driver, two front ends, so the
 *                     command line cannot drift from the GUI the way scripts/autoplan.py did.
 *                     Everything the panel exposes has a flag here; see --help.
 *
 *   --stages/--grid   The original explicit-candidate mode: you name the chains, it prices all
 *                     of them. Still what autoplan.py drives, and what --exhaustive uses.
 *
 * Fully offline with --backup: nothing is fetched, so an air-gapped machine with a saved
 * backup JSON runs the whole thing. --player-id is the only flag that touches the network.
 *
 * Usage (after `pnpm search:build`):
 *   node dist-search/fastsearch.js --backup backup.json --effort thorough --jobs 12
 *   node dist-search/fastsearch.js --backup backup.json --exhaustive --range 185:390:5 --prestiges 6-8
 *   node dist-search/fastsearch.js --player-id EI... --stages "195;225-231;270-290;310-330"
 *   node dist-search/fastsearch.js --backup backup.json --grid 195,226,277,317,362 --prestiges 5-8
 *
 * What-if flags (neither edits the player's save):
 *   --mod elr=1.05            colleggtible what-if   (see MODS below)
 *   --add-artifact compass:legendary
 *                             artifact what-if       (see ADDED_ARTIFACTS below)
 *   --show-loadout            print the chosen ELR loadout without injecting anything
 */
// MUST be first: installs localStorage/window/document before any store module
// whose top-level state() reads them (lib's eids store throws at import without it).
import './node-shims';

import { markRaw } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
setActivePinia(createPinia());

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

import { requestFirstContact, resolveColleggtibleContracts } from 'lib';
import { loadAndSyncBackup, rollUpPendingTE } from '@/lib/modes';
import { resetAllStores } from '@/lib/modes/reset';
import { getSimulationContext, createBaseEngineState } from '@/engine/adapter';
import { computeSnapshot } from '@/engine/compute';
import { getLocalTimestampInTimezone } from '@/lib/events';
import { getThresholdForTE } from '@/lib/truthEggs';
import { countUnavailable, describeAvailability, isConstrained, nextAvailable,
         type Availability } from '@/search/availability';
import { meetsAll, usableMilestones, type LegArrival, type Milestone } from '@/search/milestones';
import { createChainEvaluator } from '@/search/chain';
import { runChainSearch, type CacheEntry, type EvaluateBatch } from '@/search/driver';
import { findStartingChain } from '@/search/coarse';
import { EFFORT, EFFORT_ORDER, estimateChains } from '@/search/effort';
import { splitByPrefix, workersForBatch } from '@/search/batch';
import { exhaustiveChains } from '@/search/exhaustive';
import { buildChainsCsv, describeVirtueInventory } from '@/search/csv';
import type { ChainResult, EffortTier, SearchInputs } from '@/search/types';
import {
  runUntilShift,
  deriveNextStartState,
  runContinueCurrent,
  runAscensionFromC3Variant,
} from '@/auto/ascension';
import { runC3Variants } from '@/auto/shifts/c3';
import { pickVariant, type VariantKey, type VariantResult } from '@/stores/autoPlanner';
import { useActionsStore } from '@/stores/actions';
import { useInitialStateStore } from '@/stores/initialState';
import { useVirtueStore } from '@/stores/virtue';
import { getArtifact, getArtifactLoadoutFromBackup, getOptimalEarningsSet, getOptimalELRSet } from '@/lib/artifacts';
import { allPossibleTiers } from 'lib/artifacts/data';
import { ei } from 'lib/proto';
import type { AscensionSummary } from '@/auto/types';
import type { VirtueEgg } from '@/types';

// Mirrors useAscensionGenerator's own constant: below this starting TE a Tier 13
// unlock can't realistically land inside one build phase, so those variants are
// skipped outright rather than simulated and thrown away.
const TIER_13_MIN_STARTING_TE = 190;

// Backup egg enum (50..54) -> EngineState's egg name, same table the generator
// keeps as VIRTUE_EGGS_MAP.
const VIRTUE_EGGS_MAP: Record<number, VirtueEgg> = {
  50: 'curiosity',
  51: 'integrity',
  52: 'humility',
  53: 'resilience',
  54: 'kindness',
};

// ---------------------------------------------------------------- arg parsing
function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const has = (name: string) => process.argv.includes('--' + name);

/** "195" | "225-231" | "270-290:2" | "312,316,320" -> number[] */
function parseGroup(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)(?::(\d+))?$/);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      const s = +(m[3] ?? 1);
      for (let v = a; v <= b; v += s) out.add(v);
    } else if (part.trim()) {
      out.add(+part);
    }
  }
  return [...out].sort((x, y) => x - y);
}

// ------------------------------------------- synthetic artifact injection
/**
 * `--add-artifact "compass:legendary"` answers "what if I owned ONE more artifact?"
 * WITHOUT editing the player's save.
 *
 * SYNTAX (positional, colon-separated, case-insensitive):
 *
 *     family[:rarity[:tier[:count]]]
 *
 *   family  a family id, a family name, or any unambiguous substring of either -
 *           "compass", "interstellar-compass", "quantum metronome", "gusset".
 *           Ambiguous or unknown tokens are a hard error listing the candidates.
 *   rarity  common | rare | epic | legendary   (or c / r / e / l, or 0..3)
 *           default: legendary
 *   tier    1..4                               default: 4
 *   count   how many copies to add             default: 1
 *
 * Repeatable and/or comma-separated - these are equivalent:
 *     --add-artifact "compass:legendary:4" --add-artifact "gusset:epic:2"
 *     --add-artifact "compass:legendary:4,gusset:epic:2"
 *
 * The two what-ifs this was built for (identifiers verified against
 * wasmegg/_common/eiafx/eiafx-data.json, NOT guessed):
 *
 *   main account   --add-artifact "compass:legendary"
 *                  T4L "Clairvoyant interstellar compass", family interstellar-compass,
 *                  afx name 27 / level 3 / rarity 3, +50% shipping rate, 2 stone slots,
 *                  planner artifact id `interstellar-compass-4-3`
 *
 *   alt account    --add-artifact "metronome:legendary"
 *                  T4L "Reggference quantum metronome", family quantum-metronome,
 *                  afx name 24 / level 3 / rarity 3, +35% egg laying rate, 3 stone slots,
 *                  planner artifact id `quantum-metronome-4-3`
 *
 * WHY IT GOES IN THE INVENTORY, NOT THE EQUIPPED SLOTS. `getOptimalELRSet`
 * (src/lib/artifacts/virtue.ts) searches `new Inventory(backup.artifactsDb, { virtue: true })`,
 * which reads `backup.artifactsDb.virtueAfxDb.inventoryItems` - the OWNED list. Appending a
 * row there is exactly "the player owns one more of these", and the optimizer stays free to
 * pick it or ignore it. `activeArtifacts.slots` is deliberately NOT touched, so
 * `getArtifactLoadoutFromBackup` (the currently-EQUIPPED set) is unchanged and we never
 * fake having the thing equipped. An injected artifact that does not get picked is a real
 * answer, which is why the chosen loadout is printed at startup (see reportChosenLoadout).
 *
 * With no --add-artifact flag nothing here runs and no extra output is produced.
 */
type InjectedArtifact = {
  request: string;
  familyId: string;
  tierId: string;
  tierName: string;
  artifactId: string; // planner id, `${familyId}-${tierNumber}-${rarity}`
  afxName: number;
  afxLevel: number;
  rarity: number;
  tierNumber: number;
  effect: string;
  slots: number;
  count: number;
};

const RARITY_TOKENS: Record<string, number> = {
  c: 0, common: 0, '0': 0,
  r: 1, rare: 1, '1': 1,
  e: 2, epic: 2, '2': 2,
  l: 3, legendary: 3, '3': 3,
};
const RARITY_CODE = ['C', 'R', 'E', 'L'];
const RARITY_WORD = ['common', 'rare', 'epic', 'legendary'];

/** Every occurrence of a repeatable flag, in command-line order. */
function argAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === '--' + name) out.push(process.argv[i + 1]);
  }
  return out;
}

const normToken = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Resolve one "family[:rarity[:tier[:count]]]" token against the real artifact data. */
function parseAddArtifact(spec: string): InjectedArtifact {
  const parts = spec.split(':').map(s => s.trim());
  const familyToken = normToken(parts[0] ?? '');
  if (!familyToken) throw new Error('--add-artifact: empty family in "' + spec + '"');

  // Artifacts AND stones. Stones are not equippable on their own, but they are what
  // getOptimalELRSet sockets into the artifacts it picks, and a missing stone is a real
  // ceiling: the alt owns NO Brilliant (level 2) tachyon stones at all, only Regular x8
  // and Eggsquisite x2, and tachyon is the egg-laying-rate stone. Ingredients stay out -
  // nothing equips or sockets them.
  //
  // Stones have no rarities (has_rarities is false on every tier) and top out at
  // afx_level 2, i.e. what the game calls T3. There is no T4 stone, so "all stones at
  // max" means level 2, and asking for a higher tier is rejected below rather than
  // silently rounded down.
  //
  // Families are keyed by family.afx_id, NOT family.id, because family.id is not actually
  // constant across a family's own tiers: the gusset's T1 reports `ornate-gusset` while its
  // T2-T4 report `gusset` (this is why virtue.ts builds ids from the TIER's props.family.id).
  // afx_id and family.name were both verified constant per family in eiafx-data.json.
  const artifactTiers = allPossibleTiers.filter(
    t => t.afx_type === ei.ArtifactSpec.Type.ARTIFACT || t.afx_type === ei.ArtifactSpec.Type.STONE
  );
  const families = new Map<number, { afxId: number; name: string; ids: string[] }>();
  for (const t of artifactTiers) {
    let f = families.get(t.family.afx_id);
    if (!f) {
      f = { afxId: t.family.afx_id, name: t.family.name, ids: [] };
      families.set(t.family.afx_id, f);
    }
    if (!f.ids.includes(t.family.id)) f.ids.push(t.family.id);
  }

  const all = [...families.values()];
  const keys = (f: { name: string; ids: string[] }) => [normToken(f.name), ...f.ids.map(normToken)];
  const exact = all.filter(f => keys(f).includes(familyToken));
  const fuzzy = all.filter(f => keys(f).some(k => k.includes(familyToken)));
  const matches = exact.length ? exact : fuzzy;
  if (matches.length !== 1) {
    throw new Error(
      '--add-artifact: family "' + parts[0] + '" ' +
      (matches.length ? 'is ambiguous (' + matches.map(f => f.ids[0]).join(', ') + ')' : 'is unknown') +
      '. Known families: ' + all.map(f => f.ids[0]).sort().join(', ')
    );
  }
  const family = matches[0];

  const rarityToken = (parts[1] ?? 'legendary').toLowerCase();
  const rarity = RARITY_TOKENS[rarityToken];
  if (rarity === undefined) {
    throw new Error('--add-artifact: bad rarity "' + parts[1] + '" in "' + spec +
      '" (use common|rare|epic|legendary, c|r|e|l, or 0..3)');
  }

  const tierNumber = parts[2] ? +parts[2] : 4;
  if (!Number.isInteger(tierNumber) || tierNumber < 1 || tierNumber > 4) {
    throw new Error('--add-artifact: bad tier "' + parts[2] + '" in "' + spec + '" (use 1..4)');
  }

  const count = parts[3] ? +parts[3] : 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('--add-artifact: bad count "' + parts[3] + '" in "' + spec + '" (use a positive integer)');
  }

  const tier = artifactTiers.find(t => t.family.afx_id === family.afxId && t.tier_number === tierNumber);
  if (!tier) {
    throw new Error('--add-artifact: ' + family.ids[0] + ' has no tier ' + tierNumber);
  }

  // A rarity the tier cannot have would make InventoryItem.stoneSlotCount/effectDelta throw
  // deep inside the optimizer ("the impossible happened"), so reject it here with a real message.
  const effect = (tier.effects ?? []).find(e => e.afx_rarity === rarity);
  if (!effect) {
    const possible = (tier.effects ?? []).map(e => RARITY_WORD[e.afx_rarity]).join(', ');
    throw new Error('--add-artifact: T' + tierNumber + ' ' + family.ids[0] + ' cannot be ' +
      RARITY_WORD[rarity] + ' (possible rarities: ' + (possible || 'none') + ')');
  }

  return {
    request: spec,
    familyId: tier.family.id,
    tierId: tier.id,
    tierName: tier.name,
    // Must be built from the TIER's own family.id - the same expression virtue.ts and
    // src/lib/artifacts/data.ts use - or the gusset's id would come out wrong.
    artifactId: tier.family.id + '-' + tierNumber + '-' + rarity,
    afxName: tier.afx_id,
    afxLevel: tier.afx_level,
    rarity,
    tierNumber,
    effect: effect.effect,
    slots: effect.slots || 0,
    count,
  };
}

/** All --add-artifact requests, parsed once. Empty unless the flag was passed. */
const ADDED_ARTIFACTS: InjectedArtifact[] = argAll('add-artifact')
  .flatMap(v => v.split(','))
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseAddArtifact);

/** Planner artifact ids that were injected, for highlighting in the loadout printout. */
const ADDED_ARTIFACT_IDS = new Set(ADDED_ARTIFACTS.map(a => a.artifactId));

/**
 * Append the requested artifacts to the parsed backup's virtue inventory. Called on the
 * raw parsed object BEFORE markRaw/loadAndSyncBackup, so every consumer of
 * `initialStateStore.rawBackup` - getArtifactLoadoutFromBackup, getOptimalEarningsSet and
 * getOptimalELRSet alike - sees the same object.
 */
function injectSyntheticArtifacts(backup: any): void {
  if (!ADDED_ARTIFACTS.length) return;
  const db = backup?.artifactsDb?.virtueAfxDb;
  if (!db) throw new Error('--add-artifact: backup has no artifactsDb.virtueAfxDb to inject into');
  if (!db.inventoryItems) db.inventoryItems = [];

  ADDED_ARTIFACTS.forEach((a, i) => {
    db.inventoryItems.push({
      // Real itemIds in a backup are protobuf Longs ({low,high,unsigned}) in the low tens of
      // thousands. A plain number far above that range can never collide with one, and can
      // never be `===` an activeArtifacts slot's Long object either, so injecting cannot
      // change which artifacts are reported as currently equipped.
      itemId: 900000000 + i,
      artifact: { spec: { name: a.afxName, level: a.afxLevel, rarity: a.rarity, egg: 1000 } },
      quantity: a.count,
      serverId: '',
    });
    console.log(
      'injected artifact: ' + a.count + 'x T' + a.tierNumber + RARITY_CODE[a.rarity] + ' ' + a.tierName +
      ' (' + a.effect + ', ' + a.slots + ' stone slot' + (a.slots === 1 ? '' : 's') + ')' +
      '  [afx name=' + a.afxName + ' level=' + a.afxLevel + ' rarity=' + a.rarity +
      ', planner id ' + a.artifactId + ']  <- from "' + a.request + '"'
    );
  });
}

/** One line per occupied slot of an ELR loadout, marking anything that came from --add-artifact. */
function describeLoadout(set: any[]): string[] {
  const lines: string[] = [];
  for (const slot of set || []) {
    if (!slot?.artifactId) continue;
    const a = getArtifact(slot.artifactId);
    const stones = (slot.stones || []).filter(Boolean);
    lines.push(
      '    ' + (a ? a.label : slot.artifactId).padEnd(34) +
      (a ? a.effect : '').padEnd(26) +
      (stones.length ? 'stones: ' + stones.join(', ') : 'no stones') +
      (ADDED_ARTIFACT_IDS.has(slot.artifactId) ? '   <== INJECTED, USED' : '')
    );
  }
  if (!lines.length) lines.push('    (empty loadout)');
  return lines;
}

/**
 * Print the ELR loadout the optimizer actually picks, so an injected artifact that is NOT
 * worth equipping is visible rather than silent. Two probes because the sim re-solves the
 * loadout at several points with different assumptions: the "continue current ascension"
 * leg uses the account's real habs/vehicles, while H1 (src/auto/shifts/h1.ts) assumes maxed
 * habs and vehicles. Both use the account's CURRENT research levels, so these are
 * representative probes, not a transcript of every in-sim re-solve.
 */
function reportChosenLoadout(): void {
  const iss: any = useInitialStateStore();
  const raw = iss.rawBackup;
  if (!raw) {
    console.log('chosen ELR loadout: unavailable (no raw backup)');
    return;
  }
  const farmState: any = iss.currentFarmState;
  const probes: [string, boolean][] = [
    ['current habs/vehicles (the "continue" leg)', false],
    ['max habs/vehicles (the H1 leg near ascension end)', true],
  ];
  const usedIn = new Map<string, string[]>();
  for (const [label, assumeMax] of probes) {
    const set = getOptimalELRSet(raw, {
      commonResearch: farmState?.commonResearches,
      epicResearchLevels: iss.epicResearchLevels,
      colleggtibleModifiers: iss.colleggtibleModifiers,
      assumeMaxHabsVehicles: assumeMax,
    });
    console.log('chosen ELR loadout @ ' + label + ':');
    for (const line of describeLoadout(set)) console.log(line);
    for (const slot of set || []) {
      if (!slot?.artifactId || !ADDED_ARTIFACT_IDS.has(slot.artifactId)) continue;
      if (!usedIn.has(slot.artifactId)) usedIn.set(slot.artifactId, []);
      usedIn.get(slot.artifactId)!.push(label);
    }
  }
  // Say the quiet part out loud: an injected artifact the optimizer declines to equip is a
  // legitimate answer to the what-if, and must not look like the flag silently did nothing.
  for (const a of ADDED_ARTIFACTS) {
    const where = usedIn.get(a.artifactId);
    console.log('verdict: ' + a.artifactId + ' was ' +
      (where ? 'EQUIPPED in ' + where.length + '/' + probes.length + ' probe(s) - ' + where.join('; ')
             : 'NOT equipped in either probe (the player already owns something at least as good; ' +
               'the plan below is therefore unchanged by this injection)'));
  }
}

/** Every flag, grouped the way the browser panel groups them, so the two can be read side by
 *  side. Printed by --help; nothing else runs. */
function printHelp(): void {
  console.log(`
fastsearch - the Ascension Planner's chain search, headless.

  Finds the fastest sequence of prestige checkpoints to a Truth Egg target, scoring every
  candidate with the planner's own simulator. Runs fully offline with --backup.

ACCOUNT  (one is required)
  --backup FILE.json        A saved backup. Nothing is fetched; works air-gapped.
  --player-id EI...         Fetch the backup from the API. The only flag that uses the network.
  --save-backup FILE        With --player-id, write the fetched backup for offline reuse.

MODE  (one of)
  --effort TIER             The browser panel's staged search.
                            fast|balanced|exact|thorough (the slider's labels; the internal
                            names quick|balanced|normal|thorough also work).
  --exhaustive              Price EVERY chain over a pool. No staged search, no pruning; the
                            winner is the true optimum of that space. Needs --range or --grid.
  --stages "a;b,c;d-e"      Explicit candidates: one pick per group, in order.
  --grid a,b,c --prestiges 5-8
                            Every subset of a pool at those chain lengths.

THE PANEL'S SETTINGS  (--effort mode)
  --seed "195 219 248"      Starting chain, final target appended for you. Panel: Starting chain.
  --find-seed               Coarse-scan for a seed first. Panel: "Find a starting chain for me".
  --min-prestiges N         Panel: Fewest ascensions.          (default 4)
  --max-prestiges N         Panel: Most ascensions.            (default 9)
  --pin N                   Hold the first N checkpoints fixed. Panel: "Lock the first".
  --final TE                Panel: Final target TE.            (default 490)

WHEN YOU CAN PLAY  (all modes; changes which chain wins, not just the display)
  --available-from H --available-to H
                            Hours you are around, in --timezone. Panel: "Plan around my schedule".
  --sleep-from H --sleep-until H
                            The same thing inverted, for the common case.
  --available-days sat,sun  Restrict to those days.            (default every day)
  --no-hold-shifts          Do NOT hold the twelve in-ascension shifts for your hours -- report
                            them and charge nothing. Panel: untick "Hold the shifts for my hours
                            too". Holding is the default, as in the panel.
  --milestone "248@2027-06-01"
                            Hard constraint, repeatable. Panel: "Dates you need to hit".

WHEN THE PLAN STARTS
  --start-date YYYY-MM-DD   (default today)
  --start-time HH:MM        (default the current hour)
  --timezone IANA           (default this machine's)
  --force-continue          Continue the current ascension rather than prestiging first.

EXHAUSTIVE
  --range lo:hi[:step]      Pool to enumerate, e.g. 185:390:5. Step defaults to 1.
  --prestiges lo-hi         Chain lengths to enumerate.        (default 5-8)
  --yes                     Proceed past the 5000-chain safety cap.

OUTPUT
  --jobs N                  Worker processes. The staged search keeps a persistent pool.
  --csv FILE                Where to write the per-leg CSV of every chain priced.
                            Defaults to fastsearch-<timestamp>.csv; nothing is discarded
                            unless you pass --no-csv.
  --no-csv                  Do not write a CSV. Only the printed summary survives the run.
  --top N                   Runners-up to print.               (default 10)

WHAT-IF  (neither edits the save)
  --mod elr=1.05            Scale a colleggtible dimension.
  --add-artifact compass:legendary
  --show-loadout            Print the chosen ELR loadout and exit.

DIAGNOSTICS  (for working on the search itself, not for planning a run)
  --debug                   Verbose per-stage tracing.
  --dump-state              Print the parsed farm state and exit.
  --show-loadout            As above; pairs with --add-artifact to check what a new piece changes.
  --prune N                 Override the descent pruning bound. Lower prunes harder and can
                            drop the true optimum -- the default is what the accuracy figures
                            were measured with.
  --max-elr N               Cap peak delivery, for reproducing a bound by hand.
  --override-ascension N --override-days D --override-hours H
                            Force one leg's length instead of simulating it. For isolating
                            whether a disagreement is in the chain or in one leg.
  --reactive-backup         Hand the backup to Pinia reactively. Much slower; only useful when
                            chasing a mismatch between CLI and browser results.

EXAMPLES
  node dist-search/fastsearch.js --backup me.json --effort thorough --find-seed --jobs 12 \\
      --available-from 9 --available-to 23 --csv run.csv
  node dist-search/fastsearch.js --backup me.json --exhaustive --range 185:390:15 --prestiges 6-7 --jobs 12
`);
}

// ------------------------------------------------------------------ bootstrap
async function loadPlayer(): Promise<void> {
  const backupFile = arg('backup');
  const playerId = arg('player-id');
  let backup: any;

  if (backupFile) {
    backup = JSON.parse(readFileSync(backupFile, 'utf8'));
  } else if (playerId) {
    const data = await requestFirstContact(playerId);
    if (!data.backup) throw new Error('no backup returned for ' + playerId);
    backup = data.backup;
    if (has('save-backup')) {
      writeFileSync(arg('save-backup', 'backup.json')!, JSON.stringify(backup));
    }
  } else {
    throw new Error('need --player-id EI... or --backup file.json');
  }

  // "What if I owned one more artifact?" - append to the parsed backup's OWNED inventory
  // before anything reads it. No-op (and silent) without --add-artifact.
  injectSyntheticArtifacts(backup);

  resolveColleggtibleContracts(backup);

  // The backup is handed to Pinia, which wraps it in a reactive Proxy. The
  // simulator reads the artifact inventory out of it constantly (getOptimalELRSet
  // -> evaluateStones walks every stone on every call), so each of those reads
  // pays for a proxy trap. A CPU profile put get/createReactiveObject/isRef at
  // ~14% of total runtime. Nothing here is reactive - there is no UI - so mark it
  // raw and Vue leaves it as a plain object.
  // --reactive-backup restores the old behaviour so the two can be timed head to head.
  if (!has('reactive-backup')) backup = markRaw(backup);

  // This mirrors initPlanFuture (src/lib/modes/planFuture.ts) step for step,
  // because that is what the Auto Planner tab actually runs - NOT App.vue's
  // generic 'default' load. The differences matter:
  //   - mode 'plan_next', not 'default'
  //   - rollUpPendingTE straight after the load, so pending TE is claimed
  //     (without it the harness starts from 159 TE instead of 174)
  //   - the virtue store is explicitly reset to now / zero bank / curiosity
  //   - the start action is stripped of any farm state
  // Loading the 'default' way instead leaves the farm and soul-egg state in a
  // shape the simulator cannot make progress from, and every leg runs for
  // decades of simulated time before giving up.
  await resetAllStores();
  loadAndSyncBackup(playerId ?? 'file', backup, 'plan_next');
  rollUpPendingTE();

  const virtueStore = useVirtueStore();
  virtueStore.resetToCurrentDateTime();
  virtueStore.setBankValue(0);
  virtueStore.setCurrentEgg('curiosity');

  const actionsStore = useActionsStore();
  const startAction: any = actionsStore.getStartAction();
  if (startAction) {
    startAction.payload.initialFarmState = undefined;
    startAction.payload.isQuickContinue = false;
    startAction.payload.initialEgg = 'curiosity';
  }

  const ctx = simContext();
  const base = createBaseEngineState(null);
  await actionsStore.setInitialSnapshot(computeSnapshot(base, ctx));
}

// -------------------------------------------------------------- one ascension
// --------------------------------------------------- colleggtible what-if
// `--mod elr=1.05,shippingCap=1.05` multiplies the colleggtible modifier for those
// dimensions. Colleggtibles enter the simulation at exactly one point -
// `context.colleggtibleModifiers` (engine/adapter.ts) - so scaling it here is
// equivalent to owning a new colleggtible granting that bonus, WITHOUT editing the
// player's save. Dimensions: earnings, awayEarnings, ihr, elr, shippingCap, habCap,
// vehicleCost, habCost, researchCost. Cost dimensions are multipliers where LOWER is
// better (0.95 = 5% cheaper).
const MODS: Record<string, number> = {};
for (const kv of (arg('mod', '') || '').split(',')) {
  if (!kv) continue;
  const [k, v] = kv.split('=');
  if (!k || !v || !isFinite(+v)) throw new Error('bad --mod entry: ' + kv);
  MODS[k.trim()] = +v;
}
function simContext(): any {
  const c: any = getSimulationContext();
  if (Object.keys(MODS).length) {
    const base = c.colleggtibleModifiers || {};
    const next: any = { ...base };
    for (const [k, f] of Object.entries(MODS)) {
      if (!(k in next)) throw new Error('unknown --mod dimension: ' + k);
      next[k] = (next[k] ?? 1) * f;
    }
    c.colleggtibleModifiers = next;
  }
  return c;
}

interface LegResult {
  summary: AscensionSummary;
  key: VariantKey;
  nextState: any;
  // Absolute instants of this leg's twelve shifts, for availability reporting.
  // NOT Action.timestamp: runAscension sets that only on the synthetic
  // start action (and in ms), so the real clock is startTime + endState.lastStepTime,
  // the same expression useResearchViews derives absolute time from.
  shiftTimes: number[];
}

function shiftInstants(actions: any[], legStart: number): number[] {
  const out: number[] = [];
  for (const a of actions ?? []) {
    if (a?.type !== 'shift') continue;
    const step = a?.endState?.lastStepTime;
    if (typeof step === 'number' && Number.isFinite(step)) out.push(legStart + step);
  }
  return out;
}

/**
 * Simulate one ascension and return the variant the app itself would pick.
 *
 * `allowContinue` is only true for A1: "continue current ascension" is a claim
 * about the farm as it stands right now, so it has no meaning further down a
 * chain, and the app only offers it there for the same reason.
 */
function runLeg(
  baseState: any,
  startTime: number,
  targetTE: number,
  allowContinue: boolean,
  startTE: number,
  idx: number,
  endOverride?: number
): LegResult | null {
  // An end-time override supersedes the TE goal entirely: runAscensionFromC3Variant
  // and runContinueCurrent only consult targetEndTime when targetTE is absent, so
  // leaving the TE goal set here would silently ignore the pin (the same trap the
  // app documents in useAscensionGenerator).
  const goalTE = endOverride !== undefined ? undefined : targetTE;
  const ctx = simContext();
  ctx.ascensionStartTime = startTime;
  ctx.planStartOffset = 0;

  // --force-continue: A1 is the ascension you are already part-way through, so
  // "prestige now" means throwing that progress away. The planner will sometimes
  // pick it anyway when the maths narrowly favours it; this pins A1 to Continue
  // Current Ascension instead.
  //
  // It is also the single cheapest speedup available. Every build variant costs a
  // full C3 (runC3Variants is the CPU hotspot - evaluateStones inside it is 20% of
  // runtime), and this skips all of them for A1, simulating one variant instead of
  // up to six.
  if (allowContinue && has('force-continue')) {
    const only = buildContinueVariant(baseState, startTime, goalTE as number, idx, endOverride);
    if (only) {
      return {
        summary: only.summary,
        key: 'continue' as VariantKey,
        nextState: deriveNextStartState(only.summary, createBaseEngineState(null)),
        shiftTimes: shiftInstants(only.actions, startTime),
      };
    }
    // No usable farm state (or zero ELR) - fall through rather than return null,
    // so the run degrades to the normal variant search instead of dying.
    console.warn('  --force-continue: no usable continue variant for A' + (idx + 1) + ', using build variants');
  }

  // Single C1->R1 precompute shared by every build variant, exactly as the app
  // does it - K3..H2 is the expensive part and must not be repeated per variant.
  const pre = runUntilShift(baseState, ctx, 'C3');
  const preC3 = { actions: pre.actions, state: pre.state, elapsedSeconds: pre.elapsedSeconds };

  const c3 = runC3Variants(pre.state, ctx, 3, startTE < TIER_13_MIN_STARTING_TE);
  let surviving = c3.filter(x => !x.impossible);
  if (endOverride !== undefined) {
    // K3's mandatory wait to buildPhaseEnd cannot be truncated, so a variant whose
    // build phase ends after the deadline is not merely slower - it is unevaluable.
    const feasible = surviving.filter((v: any) => v.buildPhaseEnd <= endOverride);
    if (!feasible.length) return null;
    surviving = feasible;
  }
  const variants: Record<string, VariantResult> = {};
  for (const v of surviving) {
    const key = (v.attemptTier13Unlock
      ? v.saleCount + '-sale-tier13'
      : v.saleCount + '-sale') as VariantKey;
    variants[key] = runAscensionFromC3Variant(
      baseState, preC3, v, ctx, startTime, 'asc_' + idx, goalTE, endOverride
    );
  }

  if (allowContinue) {
    const cont = buildContinueVariant(baseState, startTime, goalTE as number, idx, endOverride);
    if (cont) variants.continue = cont;
  }
  if (!Object.keys(variants).length) return null;

  const best = pickVariant(variants as any, undefined, false);
  const entry = Object.entries(variants).find(([, v]) => v === best);
  return {
    summary: best.summary,
    key: (entry ? entry[0] : '?') as VariantKey,
    nextState: deriveNextStartState(best.summary, createBaseEngineState(null)),
    shiftTimes: shiftInstants(best.actions, startTime),
  };
}

/** A1-only "continue current ascension" variant, mirroring the generator's setup. */
function buildContinueVariant(
  baseState: any,
  startTime: number,
  targetTE: number | undefined,
  idx: number,
  endOverride?: number
): VariantResult | null {
  const initialStateStore = useInitialStateStore();
  const farmState: any = initialStateStore.currentFarmState;
  const raw = initialStateStore.rawBackup;
  if (!farmState || !raw) return null;

  const rawLoadout = getArtifactLoadoutFromBackup(raw);
  const optimalEarnings = getOptimalEarningsSet(raw);
  // The ELR set is recomputed rather than reusing the equipped (earnings) loadout.
  // Filing the earnings set under artifactSets.elr was the bug that made the
  // "continue" variant report 1.580q/hr instead of 3.574q/hr.
  const elr =
    getOptimalELRSet(raw, {
      commonResearch: farmState.commonResearches,
      epicResearchLevels: initialStateStore.epicResearchLevels,
      colleggtibleModifiers: initialStateStore.colleggtibleModifiers,
      currentSet: rawLoadout,
      assumeMaxHabsVehicles: false,
    }) ?? rawLoadout;

  const state: any = {
    ...JSON.parse(JSON.stringify(baseState)),
    // eggType is the raw backup enum (50..54); EngineState wants the name.
    // Passing the number through left currentEgg as 53 and quietly corrupted
    // every rate calculation downstream.
    currentEgg: VIRTUE_EGGS_MAP[farmState.eggType] ?? 'curiosity',
    researchLevels: { ...farmState.commonResearches },
    // EngineState's field is habIds, NOT habs. Writing `habs` here was ignored,
    // so habIds fell back to [0,null,null,null] - a single starter hab. With no
    // capacity the farm can never afford research, and buyResearch recursed until
    // the stack blew on the third leg.
    habIds: farmState.habs || [0, null, null, null],
    vehicles: farmState.vehicles || [{ vehicleId: 0, trainLength: 1 }],
    siloCount: farmState.numSilos || 1,
    tankLevel: baseState.tankLevel,
    artifactLoadout: elr.map((s: any) => ({ artifactId: s.artifactId, stones: [...s.stones] })),
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
  };

  const ctx = simContext();
  ctx.ascensionStartTime = startTime;
  ctx.planStartOffset = 0;
  const elrNow = computeSnapshot(state, ctx, { skipGrowth: true }).elr;
  if (!(elrNow > 0)) return null;
  return runContinueCurrent(state, ctx, startTime, elrNow, targetTE, 'asc_' + idx + '_continue', endOverride);
}

// -------------------------------------------------------- branch-and-bound
/**
 * Lower bound, in seconds, on the time still needed to climb from a per-egg TE
 * distribution to `targetTotal` total TE, assuming delivery never exceeds
 * `maxElr` eggs/second.
 *
 * WHY THIS IS SAFE. A prefix is never pruned because a sibling leaf was bad - it
 * is pruned because its own elapsed time is already measured, and even a
 * mathematically perfect completion cannot catch up. For prefix P, every leaf L
 * beneath it obeys total(L) >= elapsed(P) + thisBound. So if elapsed + bound
 * already loses to the incumbent, every leaf in that subtree loses, the best one
 * included. Nothing is lost.
 *
 * THE BOUND MUST UNDERESTIMATE. If it ever overstates the remaining time it
 * stops being a bound and starts being a heuristic that can discard the true
 * optimum. Two deliberate choices keep it conservative:
 *   - eggs already delivered toward the next threshold are subtracted, so the
 *     first TE on each egg is charged only for what is genuinely left;
 *   - TE is taken greedily from whichever egg is cheapest next, which is the
 *     cheapest distribution any real plan could possibly achieve.
 * Neither can make the answer larger than reality.
 *
 * The one remaining assumption is maxElr itself. If some leg can actually beat
 * it the bound is invalid, so runLeg's observed peak is checked against it and
 * the run warns loudly rather than silently returning a non-exhaustive answer.
 */
function minSecondsToReach(
  finalTE: Record<string, number>,
  delivered: Record<string, number>,
  targetTotal: number,
  maxElr: number
): number {
  const eggs = Object.keys(finalTE);
  const teIdx: Record<string, number> = { ...finalTE };
  const got: Record<string, number> = { ...delivered };
  let need = targetTotal - eggs.reduce((a, e) => a + teIdx[e], 0);
  if (need <= 0) return 0;

  let eggsNeeded = 0;
  while (need-- > 0) {
    let bestEgg = eggs[0];
    let bestCost = Infinity;
    for (const e of eggs) {
      const cost = Math.max(0, getThresholdForTE(teIdx[e] + 1) - (got[e] ?? 0));
      if (cost < bestCost) {
        bestCost = cost;
        bestEgg = e;
      }
    }
    eggsNeeded += bestCost;
    got[bestEgg] = getThresholdForTE(teIdx[bestEgg] + 1);
    teIdx[bestEgg]++;
  }
  return maxElr > 0 ? eggsNeeded / maxElr : 0;
}

// ----------------------------------------------------------------- the search
interface Row {
  chain: number[];
  seconds: number;
  legs: { key: string; te: number; dur: number; elr: number;
           bdur: number; bend: number; bsale: number; lastte: number;
           t13: number; se0: number; shift: number;
           // Schedule columns. `wait` is seconds this leg's prestige was delayed to
           // reach an available hour (charged); `nsh` is how many of the leg's twelve
           // shifts land outside the schedule (reported only - the simulator places
           // shifts itself and they are not moved).
           wait: number; nsh: number }[];
  pinDate?: string;
  pinTime?: string;
}

/**
 * Fan the run out over N child processes and merge their CSVs.
 *
 * Child processes rather than worker_threads: each child needs its own Pinia
 * instance and its own copy of the store graph, which is exactly what a fresh
 * process gives for free. Every child re-fetches the backup, so pass
 * --backup file.json to avoid N identical API calls.
 */
// ============================================================ GUI-parity search
//
// The browser panel and this share `src/search/driver.ts` and `src/search/chain.ts`
// outright. Only the three things the driver deliberately abstracts differ: where the
// chains get evaluated, how progress is reported, and where the answer is written.
//
// The alternative -- a second staged search written in Python -- is what
// `scripts/autoplan.py` is, and it is exactly how the `resolve_last` bug survived: the
// same defect existed in both copies and had to be found and fixed twice. One driver
// cannot drift from itself.

/** Build the evaluator inputs the driver needs. Mirrors `collectInputs()` in
 *  stores/chainSearch.ts field for field -- if one gains a field, so must the other. */
function planInputs(o: {
  planStart: number;
  currentTE: number;
  final: number;
  availability: Availability | null;
  milestones: Milestone[];
  deferShifts: boolean;
}): SearchInputs {
  return {
    context: simContext(),
    baseState: createBaseEngineState(null),
    currentFarmState: (useInitialStateStore() as any).currentFarmState,
    planStart: o.planStart,
    currentTE: o.currentTE,
    final: o.final,
    forceContinue: has('force-continue'),
    availability: o.availability,
    milestones: o.milestones,
    deferShifts: o.deferShifts,
  };
}

/**
 * A PERSISTENT pool of child processes, each holding a loaded player and a warm prefix memo.
 *
 * Child processes rather than worker_threads for the same reason `runSharded` uses them: every
 * evaluator needs its own Pinia instance and its own store graph, which a fresh process gives
 * for free. The difference from `runSharded` is that these are forked ONCE and then fed batches
 * over IPC, because the driver's batches are decided as it goes and re-forking per batch would
 * pay the ~2 s load cost hundreds of times.
 *
 * Chains are dealt to workers by PREFIX, never round-robin. The evaluator memoises per leg, so
 * two chains sharing `195,226,277` cost one simulation if they land on the same worker and two
 * if they do not. Round-robin would silently double the work of the widest stages.
 */
async function makeWorkerPool(jobs: number): Promise<{
  evaluate: EvaluateBatch;
  legSims: () => number;
  close: () => void;
}> {
  const { fork } = await import('node:child_process');
  // Everything except --jobs, plus --worker. The child must not itself try to shard.
  const base = process.argv.slice(2).filter((a, i, arr) => a !== '--jobs' && arr[i - 1] !== '--jobs');

  type Child = ReturnType<typeof fork>;
  const kids: Child[] = [];
  let legSimTotal = 0;

  await Promise.all(
    Array.from({ length: jobs }, (_, i) =>
      new Promise<void>((res, rej) => {
        const c = fork(process.argv[1], [...base, '--worker'], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        // Workers are silent on stdout by design; anything they do print is a problem worth
        // seeing, so it is forwarded rather than swallowed.
        c.stderr?.on('data', d => process.stderr.write('[w' + i + '] ' + d));
        c.once('message', (m: any) => (m?.ready ? res() : rej(new Error('worker ' + i + ': ' + JSON.stringify(m)))));
        c.once('exit', code => rej(new Error('worker ' + i + ' exited ' + code + ' during startup')));
        kids.push(c);
      })
    )
  );
  // Startup listeners would otherwise reject the pool the moment we close it.
  for (const c of kids) c.removeAllListeners('exit');

  const evaluate: EvaluateBatch = async chains => {
    if (!chains.length) return { results: [], legSims: 0, workersUsed: 0 };

    // `workersForBatch` and `splitByPrefix` are the browser pool's own splitter, reused verbatim
    // rather than re-derived here. Both encode measurements -- a floor of MIN_CHAINS_PER_WORKER
    // chains each because spreading a 13-chain batch over 12 shards is mostly overhead, and a cut
    // on whole prefix subtrees because splitting destroys the per-leg memo (a 17-value sweep costs
    // 2 + 17x4 = 70 leg sims in one worker and 17x6 = 102 across seventeen). Writing a second
    // splitter here would be the same mistake as a second driver.
    const wanted = workersForBatch(chains.length, jobs);
    const groups = splitByPrefix(chains, wanted);
    const buckets: number[][][] = Array.from({ length: jobs }, () => []);
    groups.forEach((g, i) => buckets[i % jobs].push(...g));

    const replies = await Promise.all(
      buckets.map((bucket, i) =>
        new Promise<{ results: ChainResult[]; legSims: number }>((res, rej) => {
          if (!bucket.length) return res({ results: [], legSims: 0 });
          const c = kids[i];
          const onMessage = (m: any) => {
            c.off('message', onMessage);
            if (m?.error) return rej(new Error('worker ' + i + ': ' + m.error));
            res({ results: m.results as ChainResult[], legSims: m.legSims as number });
          };
          c.on('message', onMessage);
          c.send({ chains: bucket });
        })
      )
    );

    const results: ChainResult[] = [];
    let legSims = 0;
    for (const r of replies) {
      results.push(...r.results);
      legSims += r.legSims;
    }
    legSimTotal += legSims;
    return { results, legSims, workersUsed: buckets.filter(b => b.length).length };
  };

  return { evaluate, legSims: () => legSimTotal, close: () => kids.forEach(c => c.kill()) };
}

/** `--worker`: load the player once, then price whatever arrives over IPC. Never returns. */
async function runWorker(inputs: SearchInputs): Promise<void> {
  const evaluator = createChainEvaluator(inputs);
  let last = 0;
  process.on('message', (m: any) => {
    try {
      const results: ChainResult[] = [];
      for (const chain of m.chains as number[][]) {
        const r = evaluator.evaluate(chain);
        // A null is a chain some leg could not simulate, or one a milestone rejected. The driver
        // treats an absent result as "not a candidate", which is the correct reading of both.
        if (r) results.push(r);
      }
      const legSims = evaluator.legSims - last;
      last = evaluator.legSims;
      process.send!({ results, legSims });
    } catch (e: any) {
      process.send!({ error: String(e?.stack || e) });
    }
  });
  process.send!({ ready: true });
  // Hold the event loop open; the parent kills us when the run ends.
  await new Promise(() => {});
}

/**
 * Every strictly-increasing chain over a pool, priced. No staged search, no pruning, no
 * heuristics -- the answer is the true optimum of whatever space the pool describes.
 *
 * This is `--exhaustive`. It is the only mode that can PROVE anything: the staged search returns
 * a strong local optimum and says so, and the 4913-chain exhaustive is what established that it
 * had found rank 1 on the main account. It is also the mode that gets away from you fastest --
 * C(206,6) is 8.2e10 chains at ~15 s each -- so the count is printed before anything is
 * simulated and a large one needs --yes.
 */
// `exhaustiveChains` lives in src/search/exhaustive.ts, shared with the browser's Insane mode so
// the two cannot drift into enumerating different spaces. Imported at the top of this file.

/**
 * `--exhaustive`: price every strictly-increasing chain over a pool. No staged search, no
 * descent, no pruning of any kind -- the winner is the true optimum of the space described,
 * not a local one.
 *
 * This is the only mode that can prove anything, and the reason the README can say "rank 1 of
 * 4913" about one account at all. It is also the mode that runs away from you fastest: choosing
 * 6 checkpoints from 185..390 at step 1 is C(206,6) = 8.2e10 chains, which at ~15 s each is
 * longer than the age of the universe divided by nothing helpful. So the count and a wall-clock
 * estimate are printed BEFORE anything is simulated, and anything over the cap needs --yes.
 *
 * Pool comes from --range lo:hi:step (step defaults to 1) or --grid a,b,c. Length comes from
 * --prestiges lo-hi, the same flag the grid mode uses.
 */
async function runExhaustive(
  inputs: SearchInputs,
  o: {
    jobs: number;
    tz: string;
    planStart: number;
    currentTE: number;
    final: number;
    availability: Availability | null;
    deferShifts: boolean;
    t0: number;
  }
): Promise<void> {
  const { jobs, currentTE, final } = o;

  let pool: number[];
  if (arg('grid')) {
    pool = parseGroup(arg('grid')!);
  } else {
    const spec = arg('range');
    if (!spec) throw new Error('--exhaustive needs --range lo:hi[:step] or --grid a,b,c');
    const [lo, hi, step] = spec.split(':').map(Number);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('--range must look like 185:390 or 185:390:5');
    const by = Number.isFinite(step) && step > 0 ? step : 1;
    pool = [];
    for (let v = lo; v <= hi; v += by) pool.push(v);
  }
  pool = [...new Set(pool)].filter(v => v > currentTE && v < final).sort((a, b) => a - b);
  if (!pool.length) throw new Error('the pool is empty once values outside (' + currentTE + ', ' + final + ') are dropped');

  const parts = (arg('prestiges', '5-8')!).split('-').map(Number);
  const lo = parts[0];
  const hi = parts[1] ?? parts[0];

  const chains = exhaustiveChains(pool, lo, hi, final, currentTE);
  // ~15 s per chain is the measured floor with a warm prefix memo; sharing makes the real figure
  // lower, so this over-estimates, which is the direction an "are you sure" wants to err.
  const hours = (chains.length * 15) / 3600 / Math.max(1, jobs);
  console.log(
    '\n--- exhaustive: ' + pool.length + ' pool values, ' + lo + '-' + hi + ' prestiges' +
    '\n    ' + chains.length.toLocaleString() + ' chains, no pruning' +
    '\n    rough upper bound ' + (hours < 1 ? (hours * 60).toFixed(0) + ' min' : hours.toFixed(1) + ' h') +
    ' across ' + jobs + ' process(es)' +
    // Said BEFORE the run, not after. A run this long is routinely left overnight, and finding out
    // where the results went should not require it to finish successfully first.
    '\n    results -> ' + (resolveCsvPath() ?? '(nowhere: --no-csv)')
  );
  const CAP = 5000;
  if (chains.length > CAP && !has('yes')) {
    throw new Error(
      chains.length.toLocaleString() + ' chains is over the ' + CAP.toLocaleString() + ' safety cap. ' +
      'Coarsen --range, narrow --prestiges, or pass --yes if you mean it.'
    );
  }
  if (!chains.length) throw new Error('no chains: check --range against --prestiges');

  const workers = jobs > 1 ? await makeWorkerPool(jobs) : null;
  const inline = workers ? null : createChainEvaluator(inputs);
  let inlineLegSims = 0;
  const evaluate: EvaluateBatch = workers
    ? workers.evaluate
    : async cs => {
        const results: ChainResult[] = [];
        for (const c of cs) {
          const r = inline!.evaluate(c);
          if (r) results.push(r);
        }
        const legSims = inline!.legSims - inlineLegSims;
        inlineLegSims = inline!.legSims;
        return { results, legSims, workersUsed: 1 };
      };

  try {
    // Chunked so progress is visible and the pool re-deals by prefix each time. Sorted first so
    // chains sharing a prefix land in the same chunk and the memo actually pays.
    chains.sort((a, b) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
      return a.length - b.length;
    });
    const CHUNK = Math.max(jobs * 8, 64);
    const cache: CacheEntry[] = [];
    let legSims = 0;
    for (let i = 0; i < chains.length; i += CHUNK) {
      const { results, legSims: n } = await evaluate(chains.slice(i, i + CHUNK));
      legSims += n;
      for (const r of results) cache.push({ key: r.chain.join(','), seconds: r.seconds, legs: r.legs });
      const done = Math.min(i + CHUNK, chains.length);
      const best = cache.reduce((m, e) => (e.seconds > 0 && e.seconds < m ? e.seconds : m), Infinity);
      console.log('  ' + done + '/' + chains.length +
        (Number.isFinite(best) ? '   best ' + (best / 86400).toFixed(3) + ' d' : ''));
    }

    const ranked = cache.filter(e => e.seconds > 0).sort((a, b) => a.seconds - b.seconds);
    if (!ranked.length) throw new Error('every chain was rejected -- check --milestone and the TE bounds');
    report(ranked[0].key.split(',').map(Number), ranked[0].seconds, cache, chains.length, legSims, {
      ...o,
      note: 'EXHAUSTIVE over ' + chains.length.toLocaleString() + ' chains: this is the true optimum of that space, not a local one',
      effort: 'exhaustive',
    });
  } finally {
    workers?.close();
  }
}

/**
 * The browser panel's search, on the command line.
 *
 * Same driver, same evaluator, same effort tiers, same coarse scan, same CSV. What differs is
 * only the plumbing the driver already abstracts: `evaluateBatch` is a process pool instead of a
 * Web Worker pool, progress goes to stdout instead of a progress bar, and the answer is printed
 * and optionally written rather than rendered.
 */
async function runPlanSearch(
  inputs: SearchInputs,
  o: {
    jobs: number;
    tz: string;
    planStart: number;
    currentTE: number;
    final: number;
    availability: Availability | null;
    deferShifts: boolean;
    t0: number;
  }
): Promise<void> {
  const { jobs, tz, currentTE, final } = o;

  if (has('exhaustive')) return runExhaustive(inputs, o);

  // The panel labels the tiers Fast / Balanced / Exact / Very high while the keys are
  // quick / balanced / normal / thorough. Accept BOTH spellings: someone reaching for the CLI
  // after using the slider will type what the slider said, and being told "exact" is not a tier
  // when the screen says EXACT is a pointless thing to be right about.
  const TIER_ALIASES: Record<string, EffortTier> = { fast: 'quick', exact: 'normal' };
  const effortRaw = (arg('effort', 'normal') || '').toLowerCase();
  const effort = (TIER_ALIASES[effortRaw] ?? effortRaw) as EffortTier;
  if (!(EFFORT_ORDER as readonly string[]).includes(effort)) {
    throw new Error(
      '--effort must be one of fast|quick, balanced, exact|normal, thorough (got "' + effortRaw + '")'
    );
  }

  // Seed. `--seed "195 219 248"` matches the panel's Starting chain box, final target appended
  // for you either way. Without one there is nothing to descend from, so --find-seed is required.
  const seedArg = arg('seed');
  const seedFromArg = seedArg
    ? [...new Set(seedArg.trim().split(/\s+/).map(Number).filter(v => v > currentTE && v < final))].sort((a, b) => a - b)
    : [];

  const minPrestiges = +(arg('min-prestiges', '4')!);
  const maxPrestiges = +(arg('max-prestiges', '9')!);
  const pin = +(arg('pin', '0')!);

  if (!seedFromArg.length && !has('find-seed')) {
    throw new Error('--effort needs a starting point: pass --seed "195 219 248" or --find-seed');
  }

  const pool = jobs > 1 ? await makeWorkerPool(jobs) : null;
  // Single-process: evaluate inline. Same evaluator the workers hold, so a --jobs 1 run and a
  // --jobs 12 run differ only in wall clock, never in the answer.
  const inline = pool ? null : createChainEvaluator(inputs);
  let inlineLegSims = 0;
  const evaluate: EvaluateBatch = pool
    ? pool.evaluate
    : async chains => {
        const results: ChainResult[] = [];
        for (const c of chains) {
          const r = inline!.evaluate(c);
          if (r) results.push(r);
        }
        const legSims = inline!.legSims - inlineLegSims;
        inlineLegSims = inline!.legSims;
        return { results, legSims, workersUsed: 1 };
      };

  // Everything priced, for the CSV and for the final ranking. The driver hands back its whole
  // cache on every batch; keeping the last one is enough and avoids duplicating the bookkeeping.
  let cache: CacheEntry[] = [];

  try {
    let seed = seedFromArg.length ? [...seedFromArg, final] : [];

    if (has('find-seed')) {
      console.log('\n--- coarse scan: finding a starting chain');
      const coarse = await findStartingChain({
        currentTE,
        final,
        minPrestiges,
        maxPrestiges,
        evaluateBatch: evaluate,
      });
      for (const line of coarse.log) console.log('  ' + line);
      seed = coarse.seed;
      console.log('  seed -> ' + seed.join(' '));
    }

    const est = estimateChains(Math.max(1, seed.length - 1), EFFORT[effort]);
    console.log(
      '\n--- ' + effort + ': up to ~' + est + ' chains, ' +
      (jobs > 1 ? jobs + ' worker processes' : 'single process') +
      '\n    seed ' + seed.join(' ') + '  (prestige counts ' + minPrestiges + '-' + maxPrestiges +
      (pin ? ', first ' + pin + ' pinned' : '') + ')'
    );

    let lastStage = '';
    const outcome = await runChainSearch({
      seedChain: seed,
      final,
      currentTE,
      effort,
      pin: pin || undefined,
      minCheckpoints: minPrestiges,
      maxCheckpoints: maxPrestiges,
      evaluateBatch: evaluate,
      onCache: entries => (cache = entries),
      onProgress: p => {
        if (p.stage !== lastStage) {
          lastStage = p.stage;
          console.log('\n--- ' + p.stage);
        }
        if (p.detail) {
          console.log('  ' + p.detail +
            (p.bestSeconds > 0 ? '   ' + (p.bestSeconds / 86400).toFixed(3) + ' d  ' + p.bestChain.join(' ') : ''));
        }
      },
    });

    report(outcome.chain, outcome.seconds, cache, outcome.chainsEvaluated, outcome.legSims, {
      ...o,
      note: outcome.stoppedEarly
        ? 'stopped early; answer is what "' + outcome.lastCompletedStage + '" guarantees'
        : 'completed through ' + outcome.lastCompletedStage,
      effort,
    });
  } finally {
    pool?.close();
  }
}

/**
 * Where this run's CSV goes. Defaults to a timestamped file rather than nowhere.
 *
 * It used to write only when `--csv` was passed, and `--csv` is one line in a usage block nobody
 * re-reads. A 245-minute exhaustive over 6,006 chains finished, printed its top ten, and discarded
 * every other row: the cost of an unwanted 2 MB file is nothing next to that. `--no-csv` opts out.
 */
function resolveCsvPath(): string | null {
  if (has('no-csv')) return null;
  const explicit = arg('csv');
  if (explicit) return explicit;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `fastsearch-${stamp}.csv`;
}

/** Print the answer, and write the panel's own CSV. Shared by both new modes. */
function report(
  chain: number[],
  seconds: number,
  cache: CacheEntry[],
  chainsEvaluated: number,
  legSims: number,
  o: {
    tz: string;
    planStart: number;
    currentTE: number;
    final: number;
    availability: Availability | null;
    deferShifts: boolean;
    t0: number;
    note: string;
    effort: string;
  }
): void {
  const mins = (Date.now() - o.t0) / 60000;
  console.log('\n=== done  (' + mins.toFixed(1) + ' min, ' + chainsEvaluated + ' chains, ' + legSims + ' leg sims)');
  console.log('    ' + o.note);
  console.log('\n  ' + (seconds / 86400).toFixed(3) + ' d   ' + chain.join(' '));
  console.log('    ends ' + new Date((o.planStart + seconds) * 1000).toLocaleString('en-US', { timeZone: o.tz }));

  const ranked = [...cache].filter(e => e.seconds > 0).sort((a, b) => a.seconds - b.seconds);
  const top = +(arg('top', '10')!);
  if (top > 0 && ranked.length > 1) {
    console.log('\n  next best:');
    for (const e of ranked.slice(1, top + 1)) {
      console.log('    ' + (e.seconds / 86400).toFixed(3) + ' d  +' +
        ((e.seconds - seconds) / 86400).toFixed(3) + ' d   ' + e.key.split(',').join(' '));
    }
  }

  const csv = resolveCsvPath();
  if (csv) {
    const raw = (simContext() as any).rawBackup ?? null;
    writeFileSync(
      csv,
      buildChainsCsv(ranked, {
        planStart: o.planStart,
        timezone: o.tz,
        currentTE: o.currentTE,
        final: o.final,
        effort: o.effort,
        forceContinue: has('force-continue'),
        availability: o.availability,
        seedChain: chain,
        inventory: raw ? describeVirtueInventory(raw) : undefined,
        loadouts: [],
      })
    );
    console.log('\n  ' + ranked.length + ' chains -> ' + csv);
  }
}

async function runSharded(jobs: number): Promise<void> {
  const { fork } = await import('node:child_process');
  const out = arg('out');
  const base = process.argv.slice(2).filter((a, i, arr) =>
    a !== '--jobs' && arr[i - 1] !== '--jobs' && a !== '--out' && arr[i - 1] !== '--out');
  const parts: string[] = [];
  const t0 = Date.now();

  await Promise.all(
    Array.from({ length: jobs }, (_, i) => {
      const part = (out ?? 'fastsearch.csv').replace(/\.csv$/, '') + '.part' + i + '.csv';
      parts.push(part);
      return new Promise<void>((res, rej) => {
        const c = fork(process.argv[1], [...base, '--shard', i + '/' + jobs, '--out', part, '--top', '0'],
          { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        c.stdout?.on('data', d => process.stdout.write('[' + i + '] ' + d));
        c.stderr?.on('data', d => process.stderr.write('[' + i + '!] ' + d));
        c.on('exit', code => (code === 0 ? res() : rej(new Error('shard ' + i + ' exited ' + code))));
      });
    })
  );

  // Merge: keep one header, re-sort by days, recompute gap against the global best.
  let header = '';
  const body: string[] = [];
  for (const p of parts) {
    // A shard with no chains assigned writes no file; that is not an error.
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    header = lines[0];
    body.push(...lines.slice(1));
  }
  if (!header) throw new Error('no shard produced any output');
  const daysIdx = header.split(',').indexOf('days');
  body.sort((a, b) => +a.split(',')[daysIdx] - +b.split(',')[daysIdx]);
  const bestDays = body.length ? +body[0].split(',')[daysIdx] : 0;
  const gapIdx = header.split(',').indexOf('gap_hours');
  const merged = body.map(l => {
    const c = l.split(',');
    c[gapIdx] = (((+c[daysIdx] - bestDays) * 24)).toFixed(1);
    return c.join(',');
  });
  writeFileSync(out ?? 'fastsearch.csv', [header, ...merged].join('\n'));
  for (const p of parts) { try { unlinkSync(p); } catch { /* already gone */ } }

  console.log('\n' + merged.length + ' chains in ' + ((Date.now() - t0) / 1000).toFixed(1) +
    's across ' + jobs + ' processes -> ' + (out ?? 'fastsearch.csv'));
  for (const l of merged.slice(0, +(arg('top', '15')!))) {
    const c = l.split(',');
    console.log('  ' + c[0].replace(/"/g, '').padEnd(30) + c[2].padStart(10) + c[gapIdx].padStart(7) + 'h');
  }
}

async function main() {
  if (has('help') || process.argv.length <= 2) return printHelp();

  const t0 = Date.now();
  const jobs = +(arg('jobs', '1')!);
  // `runSharded` forks one child per shard of a FIXED candidate list and merges their CSVs. The
  // staged search has no fixed list -- it decides the next batch from the last one's answer -- so
  // it does its own parallelism with a persistent pool instead. A worker must never re-shard.
  const planMode = has('effort') || has('exhaustive');
  if (jobs > 1 && !arg('shard') && !planMode && !has('worker')) return runSharded(jobs);

  // Argument parsing and validation runs BEFORE the backup is touched. Every check in here is
  // pure -- it reads argv and nothing else -- and leaving it below `loadPlayer()` meant a typo'd
  // hour was reported only after a file read, or after a --player-id round trip to the API. Fail
  // on the flags first; the account is the expensive part.
  const tz = arg('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)!;

  // When the player can act, in `tz`. Two spellings of the same thing:
  //   --available-from 7 --available-to 23 [--available-days sat,sun]
  //   --sleep-from 23 --sleep-until 7           (the inverse, for the common case)
  // Each inter-leg PRESTIGE that would land outside the schedule is moved to the next
  // available hour and the delay is charged, which shifts every downstream sale
  // boundary - so this changes which chain is fastest and is not a display option.
  // Measured on the main account's proven optimum with 23:00-07:00 America/Denver:
  // 741.965 d -> 745.789 d on that FIXED chain (9.5 h of waiting plus a sale-boundary
  // flip on the final leg). Re-optimising under the constraint is the point of putting
  // it in the objective. See src/search/availability.ts for what it does not model.
  const DAY_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const sleepFrom = arg('sleep-from');
  const sleepUntil = arg('sleep-until');
  const availFrom = arg('available-from');
  const availTo = arg('available-to');
  const availDays = arg('available-days');

  if ((sleepFrom === undefined) !== (sleepUntil === undefined)) {
    throw new Error('--sleep-from and --sleep-until must be given together');
  }
  if ((availFrom === undefined) !== (availTo === undefined)) {
    throw new Error('--available-from and --available-to must be given together');
  }
  if (sleepFrom !== undefined && availFrom !== undefined) {
    throw new Error('use --sleep-from/--sleep-until OR --available-from/--available-to, not both');
  }

  // Hold each SHIFT for the schedule too, not just the prestige between ascensions. ON by
  // default whenever a schedule is set, matching the browser panel's own default: it is what
  // "plan around my schedule" plainly means, and without it the search reports night shifts and
  // plans around none of them. `--no-hold-shifts` restores the reported-but-free behaviour every
  // accuracy figure before this feature was measured with.
  const deferShifts = !has('no-hold-shifts');

  let availability: Availability | null = null;
  if (sleepFrom !== undefined || availFrom !== undefined || availDays !== undefined) {
    // Hours default to all-day so --available-days works on its own ("weekends only").
    const fromHour = availFrom !== undefined ? +availFrom : sleepFrom !== undefined ? +sleepUntil! : 0;
    const toHour = availTo !== undefined ? +availTo : sleepFrom !== undefined ? +sleepFrom : 0;
    const days = (availDays ?? '')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean)
      .map(t => {
        const i = /^[0-6]$/.test(t) ? +t : DAY_TOKENS.indexOf(t.slice(0, 3));
        if (i < 0 || i > 6) throw new Error('--available-days: unrecognised day "' + t + '"');
        return i;
      });
    // Range-check before `isConstrained`, which answers only "does this rule anything out" and
    // returns false for a malformed hour as well as for an empty one. Sharing one message
    // between the two meant `--available-from 25` was reported as "rules nothing out" -- a
    // description of the opposite mistake, sending you to widen a window that was never read.
    for (const [flag, h] of [['from', fromHour], ['to', toHour]] as const) {
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        throw new Error(`--available-${flag}: expected a whole hour 0-23, got "${h}"`);
      }
    }
    availability = { days, fromHour, toHour, timezone: tz };
    if (!isConstrained(availability)) {
      throw new Error('the schedule given rules nothing out (every day, all hours); ' +
                      'drop the flags or narrow it');
    }
    // Say what is actually happening, which depends on --no-hold-shifts. This line used to
    // claim "shifts are reported only" unconditionally, while `deferShifts` defaults to TRUE --
    // so the default run held and charged every shift and then told you it had not. The whole
    // point of putting the schedule in the objective is that the number moves; a banner that
    // misreports which model produced it undermines every duration printed after it.
    console.log(
      'available: ' + describeAvailability(availability) +
        (deferShifts
          ? '  (prestiges AND the twelve per-ascension shifts are pushed into it and charged)'
          : '  (prestiges are pushed into it and charged; shifts are reported only, as --no-hold-shifts asks)')
    );
  }


  await loadPlayer();

  const final = +(arg('final', '490')!);
  const now = new Date();
  const startDate = arg('start-date', now.toISOString().slice(0, 10))!;
  const startTime = arg('start-time', String(now.getHours()).padStart(2, '0') + ':00')!;
  const planStart = getLocalTimestampInTimezone(startDate, startTime, tz);

  // --milestone "248@2027-06-01", repeatable. A chain that misses one is not a candidate at all -
  // it is dropped the same way a chain whose simulation failed is dropped. Stated as a TE value
  // rather than an ascension number because the count probe reshapes the chain, so "A3" would mean
  // a different thing before and after stage 7. See src/search/milestones.ts, including why a
  // milestone on the final target cannot improve the answer.
  const milestones: Milestone[] = argAll('milestone').map(spec => {
    const m = /^(\d+)@(\d{4}-\d{2}-\d{2})$/.exec(spec.trim());
    if (!m) throw new Error('--milestone must look like "248@2027-06-01" (got "' + spec + '")');
    return { te: +m[1], by: getLocalTimestampInTimezone(m[2], '23:59', tz) };
  });
  const usable = usableMilestones(milestones, final);
  if (usable.length !== milestones.length) {
    throw new Error('--milestone: a TE must be between 1 and --final (' + final + ')');
  }
  for (const ms of usable) {
    // Formatted in `tz`, not UTC: `by` is 23:59 local, which is the NEXT day in UTC for any
    // western zone, and printing that back reads as an off-by-one.
    const shown = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms.by * 1000));
    console.log('milestone: reach ' + ms.te + ' TE by end of ' + shown + ' (chains that miss it are dropped)');
  }

  const snap: any = useActionsStore().effectiveSnapshot;
  const currentTE = snap?.teEarned
    ? (Object.values(snap.teEarned as Record<VirtueEgg, number>) as number[]).reduce((a, b) => a + b, 0)
    : 0;

  const inputs = planInputs({ planStart, currentTE, final, availability, milestones: usable, deferShifts });

  // `--worker`: a pool member. Loads the player above like anyone else, then serves chains over
  // IPC forever. Must come before every other mode, and never returns.
  if (has('worker')) return runWorker(inputs);

  if (planMode) return runPlanSearch(inputs, { jobs, tz, planStart, currentTE, final, availability, deferShifts, t0 });

  // Build the candidate list. --stages is a Cartesian product (one pick per
  // group, in order); --grid + --prestiges enumerates subsets of a shared pool.
  let chains: number[][] = [];
  const stages = arg('stages');
  if (stages) {
    const groups = stages.split(';').map(parseGroup);
    const walk = (i: number, acc: number[]) => {
      if (i === groups.length) {
        chains.push([...acc, final]);
        return;
      }
      for (const v of groups[i]) {
        if (!acc.length || v > acc[acc.length - 1]) walk(i + 1, [...acc, v]);
      }
    };
    walk(0, []);
  } else if (arg('grid')) {
    const pool = parseGroup(arg('grid')!);
    const parts = (arg('prestiges', '5-5')!).split('-').map(Number);
    const lo = parts[0];
    const hi = parts[1] ?? parts[0];
    const sub = (i: number, acc: number[]) => {
      if (acc.length && acc.length >= lo - 1 && acc.length <= hi - 1) chains.push([...acc, final]);
      if (acc.length >= hi - 1) return;
      for (let j = i; j < pool.length; j++) sub(j + 1, [...acc, pool[j]]);
    };
    sub(0, []);
  } else {
    throw new Error('need --stages "a;b;c" or --grid a,b,c --prestiges 5-8');
  }

  chains = chains.filter(c => c.every((v, i) => (i === 0 ? v > currentTE : v > c[i - 1])));

  // Sharding. A leg simulation costs seconds, so a large grid only finishes
  // quickly by using more than one core.
  //
  // Shards are cut on whole prefix subtrees, never round-robin over chains, so a
  // shared prefix is still simulated once instead of once per shard. The cut
  // depth is the SHALLOWEST one that yields at least `jobs` groups: shallower
  // means bigger subtrees and more sharing retained, but too shallow cannot fill
  // the cores. Fixing this at depth 1 (the old behaviour) silently wasted every
  // extra process on a grid like "195;231;280;313-321", where the second
  // checkpoint has a single value and every chain lands in one shard.
  const shard = arg('shard');
  if (shard && !arg('override-ascension')) {
    const [si, sn] = shard.split('/').map(Number);
    const keyAt = (c: number[], L: number) => c.slice(0, L).join(',');
    let depth = 1;
    for (let L = 1; L <= (chains[0]?.length ?? 1); L++) {
      depth = L;
      if (new Set(chains.map(c => keyAt(c, L))).size >= sn) break;
    }
    const groups = [...new Set(chains.map(c => keyAt(c, depth)))].sort();
    const mine = new Set(groups.filter((_, i) => i % sn === si));
    chains = chains.filter(c => mine.has(keyAt(c, depth)));
  }

  // --dump-state: print the account's farm inputs as JSON and exit. Everything a
  // plan depends on beyond the chain itself, so two accounts can be compared and a
  // stale backup is obvious at a glance.
  if (arg('dump-state') !== undefined) {
    const iss: any = useInitialStateStore();
    const equipped = (iss.artifactLoadout || [])
      .filter((s: any) => s && s.artifactId)
      .map((s: any) => ({ id: s.artifactId, stones: (s.stones || []).filter(Boolean).length }));
    console.log('===DUMP_STATE_JSON===');
    console.log(JSON.stringify({
      currentTE,
      colleggtibleTiers: iss.colleggtibleTiers,
      colleggtibleModifiers: iss.colleggtibleModifiers,
      equippedArtifacts: equipped,
      epicResearchLevels: iss.epicResearchLevels,
      soulEggs: (iss.rawBackup?.game?.soulEggsD ?? null),
      prophecyEggs: (iss.rawBackup?.game?.eggsOfProphecy ?? null),
      // Only present when --add-artifact was used, so an untouched dump stays untouched.
      ...(ADDED_ARTIFACTS.length ? { injectedArtifacts: ADDED_ARTIFACTS } : {}),
    }, null, 2));
    return;
  }

  // Only prints when the human asked for it, so a run with no --add-artifact is
  // byte-identical on stdout to before this feature existed.
  if (ADDED_ARTIFACTS.length || has('show-loadout')) reportChosenLoadout();

  console.log('player TE ' + currentTE + ' -> ' + final +
    ' | plan start ' + startDate + ' ' + startTime + ' ' + tz);
  console.log(chains.length + ' chains to evaluate' + (shard ? ' (shard ' + shard + ')' : ''));
  if (!chains.length) return;

  // Depth-first over the trie so each distinct prefix is simulated once. Sorting
  // groups sibling chains together, which is what makes the sharing pay off.
  chains.sort((a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? -1) - (b[i] ?? -1);
      if (d) return d;
    }
    return 0;
  });

  // ---- end-time override sweep -------------------------------------------
  // Pins one ascension to END at a given instant instead of when it naturally
  // would, which is the "when should I prestige?" question rather than "at what
  // TE?". Each (chain, pin) pair becomes its own row.
  const ovAsc = arg('override-ascension');
  const ovIdx = ovAsc ? +ovAsc - 1 : -1;
  const pins: { t: number; date: string; time: string }[] = [];
  if (ovIdx >= 0) {
    const [d0, d1] = (arg('override-days') ?? startDate + ':' + startDate).split(':');
    const hrs = parseGroup((arg('override-hours') ?? '0-23').replace(/-/g, '-'));
    for (let d = new Date(d0 + 'T00:00:00Z'); d <= new Date(d1 + 'T00:00:00Z');
         d = new Date(d.getTime() + 86400000)) {
      const ds = d.toISOString().slice(0, 10);
      for (const h of hrs) {
        const ts = String(h).padStart(2, '0') + ':00';
        pins.push({ t: getLocalTimestampInTimezone(ds, ts, tz), date: ds, time: ts });
      }
    }
    // Shard on PINS, not on chains. With 15 chains over 14 workers the chain
    // sharder cuts at depth 4 - one chain per shard - and every shard then redoes
    // A1/A2/A3 for all 168 pins on its own. Splitting the pins instead keeps all
    // the chains together in each worker, so a pin's A2/A3 are simulated once and
    // reused across every chain sharing that prefix. Measured on this sweep:
    // 11,760 leg sims the old way versus 6,888 this way.
    if (shard) {
      const [si, sn] = shard.split('/').map(Number);
      const mine = pins.filter((_, i) => i % sn === si);
      pins.length = 0;
      pins.push(...mine);
    }
    console.log('override: pinning A' + ovAsc + ' end across ' + pins.length +
      ' slots x ' + chains.length + ' chains -> ' + chains.length * pins.length + ' evaluations');
  } else {
    pins.push({ t: 0, date: '', time: '' });
  }

  const memo = new Map<string, LegResult | null>();
  const rows: Row[] = [];
  let sims = 0;
  let failed = 0;

  // Branch and bound. Off unless --prune, so the pruned and unpruned runs can be
  // diffed against each other - an inadmissible bound shows up as a missing or
  // reordered result, which is exactly the failure worth catching empirically.
  const prune = has('prune');
  const maxElrQph = +(arg('max-elr', '11.585')!);
  const maxElr = (maxElrQph * 1e15) / 3600; // q/hr -> eggs/second
  let incumbent = Infinity;
  let pruned = 0;
  let capViolations = 0;
  let worstCapSeen = 0;

  // A tight incumbent early is what makes pruning bite, so evaluate a known-good
  // chain first when one is offered. Without it the first chains examined may all
  // be poor and nothing gets cut until late in the run.
  // The seed is evaluated FIRST in every shard, because an incumbent is only
  // useful if it exists before the chains it is meant to cut. But each shard
  // owns a disjoint slice of the grid, so only the shard that actually owns the
  // seed may RECORD it - otherwise the merged CSV carries one duplicate row per
  // shard (it carried 7 before this guard) and every other shard pays to
  // simulate a chain that is not its own.
  const seed = arg('seed');
  let seedKey = '';
  let missedMilestone = 0;
  let seedIsMine = true;
  if (prune && seed) {
    const s = seed.trim().split(/\s+/).map(Number);
    const target = s[s.length - 1] === final ? s : [...s, final];
    seedKey = target.join(',');
    seedIsMine = chains.some(c => c.join(',') === seedKey);
    chains = [target, ...chains.filter(c => c.join(',') !== seedKey)];
  }

  for (const pin of pins)
  for (const chain of chains) {
    let state: any = null;
    let time = planStart;
    let te = currentTE;
    const legs: Row['legs'] = [];
    // Absolute arrivals, for the milestone check. Row['legs'] carries `te`/`dur` and no absolute
    // instant at all, so it cannot answer "when did this plan reach 248".
    const arrivals: LegArrival[] = [];
    let ok = true;

    for (let i = 0; i < chain.length; i++) {
      // Legs BEFORE the pinned one are identical for every pin, so they stay on a
      // shared key and are simulated once for the whole sweep. From the pinned leg
      // onward the result depends on the deadline, so the key carries it.
      const key = chain.slice(0, i + 1).join(',') +
        (ovIdx >= 0 && i >= ovIdx ? '@' + pin.t : '');
      let leg = memo.get(key);
      if (leg === undefined) {
        if (i === 0) {
          const b = createBaseEngineState(null);
          b.currentEgg = 'curiosity';
          b.population = 1;
          b.bankValue = 0;
          b.researchLevels = {};
          state = b;
        }
        try {
          leg = runLeg(state, time, chain[i], i === 0, te, i,
                       i === ovIdx ? pin.t : undefined);
        } catch (e) {
          if (has('debug')) console.error('  leg ' + key + ' threw: ' + (e as Error).stack);
          leg = null;
        }
        sims++;
        memo.set(key, leg);
      }
      if (!leg) {
        ok = false;
        failed++;
        break;
      }
      // Availability: the plan's next instruction after a leg ends is a prestige, so
      // a target reached at 03:14 is not acted on until the player is back. The FINAL
      // leg is exempt - reaching the final target is not an action.
      const wait = availability && i < chain.length - 1
        ? nextAvailable(leg.summary.endTime, availability) - leg.summary.endTime
        : 0;
      arrivals.push({ endTE: leg.summary.endTE, endTime: leg.summary.endTime });
      legs.push({
        wait,
        nsh: countUnavailable(leg.shiftTimes, availability),
        key: leg.key,
        te: leg.summary.endTE,
        dur: leg.summary.totalDurationSeconds,
        elr: leg.summary.maxELR,
        // Final-leg state for the phase-prediction experiment: the build phase
        // ends on a SALE BOUNDARY, so bend is a discrete quantity, not smooth.
        bdur: leg.summary.buildDurationSeconds,
        bend: leg.summary.buildPhaseEndTime - leg.summary.startTime,
        bsale: leg.summary.buildPhaseSaleCount,
        lastte: leg.summary.lastTEDurationSeconds,
        t13: leg.summary.tier13Unlocked ? 1 : 0,
        se0: leg.summary.startSoulEggs,
        shift: leg.summary.totalShiftCost,
      });
      state = leg.nextState;
      time = leg.summary.endTime + wait;
      te = leg.summary.endTE;

      // Self-check on the assumption the whole bound rests on.
      if (leg.summary.maxELR > maxElr) {
        capViolations++;
        worstCapSeen = Math.max(worstCapSeen, (leg.summary.maxELR * 3600) / 1e15);
      }

      // Cut the subtree if a perfect finish from here still loses. Checked after
      // every leg, so a hopeless prefix dies before paying for the long legs.
      if (prune && i < chain.length - 1) {
        const floor = minSecondsToReach(
          leg.summary.finalTE as any,
          leg.summary.eggsDelivered as any,
          final,
          maxElr
        );
        if (time - planStart + floor >= incumbent) {
          ok = false;
          pruned++;
          break;
        }
      }
    }

    // A chain that misses a dated milestone is not a candidate. Checked here rather than inside
    // the leg loop because the check needs the whole leg list, and it deliberately does NOT count
    // as `failed` - the simulation succeeded, the chain was simply ruled out.
    if (ok && usable.length && !meetsAll(arrivals, usable)) {
      ok = false;
      missedMilestone++;
    }

    if (ok) {
      // A foreign seed still tightens the incumbent; it just isn't ours to report.
      if (seedIsMine || chain.join(',') !== seedKey) {
        rows.push({ chain, seconds: time - planStart, legs, pinDate: pin.date, pinTime: pin.time });
      }
      if (time - planStart < incumbent) incumbent = time - planStart;
    }
    if (rows.length && rows.length % 250 === 0) {
      process.stdout.write('\r  ' + rows.length + '/' + chains.length + ' ...');
    }
  }

  rows.sort((a, b) => a.seconds - b.seconds);
  const secs = (Date.now() - t0) / 1000;
  const fmt = (s: number) => Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  // Naive cost = every leg of every chain, for every pin (no sharing at all).
  const naive = chains.reduce((n, c) => n + c.length, 0) * pins.length;

  console.log('\n\n' + rows.length + ' chains in ' + secs.toFixed(1) + 's  (' +
    sims + ' leg sims, ' + failed + ' failed' + (prune ? ', ' + pruned + ' pruned' : '') + ')');
  if (capViolations) {
    console.log('\n  !! BOUND VIOLATED: ' + capViolations + ' leg(s) exceeded --max-elr ' +
      maxElrQph + 'q/hr (worst ' + worstCapSeen.toFixed(3) + 'q/hr).');
    console.log('     The pruning bound assumed that cap, so this run may have discarded valid');
    console.log('     chains. Re-run with --max-elr ' + (Math.ceil(worstCapSeen*1000)/1000) + ' or without --prune.');
  }
  console.log((secs / Math.max(rows.length, 1) * 1000).toFixed(1) + ' ms/chain  |  prefix sharing saved ' +
    (naive - sims).toLocaleString() + ' leg sims\n');

  if (missedMilestone) {
    console.log('  ' + missedMilestone + ' chains simulated fine but missed a --milestone (not failures)');
  }
  if (usable.length && !rows.length) {
    console.log('\nNo chain met the milestones. Nothing is reported because a rejected chain is ' +
                'never ranked - relax the tightest date to see how close the fastest plan gets.');
  }
  const best = rows.length ? rows[0].seconds : 0;
  for (const r of rows.slice(0, +(arg('top', '15')!))) {
    console.log('  ' + r.chain.join(' ').padEnd(26) +
      (r.pinDate ? (r.pinDate + ' ' + r.pinTime).padEnd(18) : '') +
      fmt(r.seconds).padStart(10) + ((r.seconds - best) / 3600).toFixed(0).padStart(6) + 'h   ' +
      r.legs.map(l => l.key).join(' / '));
  }

  const out = arg('out');
  if (out) {
    const head = ['chain', 'prestiges', 'duration', 'days', 'gap_hours', 'plan_start', 'pin_date', 'pin_time'];
    for (let i = 1; i <= 8; i++) head.push('A' + i + '_sale', 'A' + i + '_te', 'A' + i + '_days', 'A' + i + '_elr',
      'A' + i + '_bdur', 'A' + i + '_bend', 'A' + i + '_bsale', 'A' + i + '_lastte',
      'A' + i + '_t13', 'A' + i + '_se0', 'A' + i + '_shift',
      'A' + i + '_wait_h', 'A' + i + '_nightshifts');
    const lines = [head.join(',')];
    for (const r of rows) {
      const c: (string | number)[] = [
        '"' + r.chain.join(' ') + '"', r.chain.length, fmt(r.seconds),
        (r.seconds / 86400).toFixed(3), ((r.seconds - best) / 3600).toFixed(1),
        '"' + startDate + ' ' + startTime + '"',
        '"' + (r.pinDate ?? '') + '"', '"' + (r.pinTime ?? '') + '"',
      ];
      for (let i = 0; i < 8; i++) {
        const l = r.legs[i];
        c.push(l ? l.key : '', l ? l.te : '', l ? (l.dur / 86400).toFixed(3) : '', l ? l.elr.toFixed(4) : '',
          l ? (l.bdur / 86400).toFixed(5) : '', l ? (l.bend / 86400).toFixed(5) : '',
          l ? l.bsale : '', l ? (l.lastte / 86400).toFixed(5) : '',
          l ? l.t13 : '', l ? l.se0 : '', l ? l.shift : '',
          l ? (l.wait / 3600).toFixed(2) : '', l ? l.nsh : '');
      }
      lines.push(c.join(','));
    }
    writeFileSync(out, lines.join('\n'));
    console.log('\nwrote ' + out);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
