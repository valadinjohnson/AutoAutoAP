# Virtue ascension chain search

Finds the fastest sequence of prestige checkpoints to reach a Truth Egg target.

You pick a chain like `195 219 248 286 327 490`: ascend to TE 195, prestige, ascend to
219, prestige, … finally reach 490. Different chains take 700–950 real-world days, and
the spread between a good and a bad one is about 12 days. This tool searches for a good
one by scoring candidates with the planner app's own simulator.

Good chains are genuinely rare. On the one account where every chain in a window was
measured, **21 of 4913 (0.43%) land within a day of optimal**. You will not find one by
trying a few by hand.

The space is 7.29 x 10^16 chains and one costs ~15 s to score, so "try them all" is
3.5 x 10^10 years on one core. [FOR_MATH_NERDS.md](FOR_MATH_NERDS.md) explains how a
search that looks at one chain in ten trillion still lands within hours of the best answer
found -- and which parts of that are measured versus guessed.

> **Player IDs in this repo are placeholders.** Every `EI…` in the docs, logs and scripts
> (`EI1234567890123456`, `EI2345678901234567`, `EI3456789012345678`) stands in for the real
> account the measurement was taken on. Substitute your own. Treat a real one as a secret:
> the API will hand your entire save to anyone who has it, which is exactly what
> `--player-id` does below. Backups themselves are gitignored and none are committed.

---

## Current answers

**Unconstrained** — no schedule, prestige the instant each target is hit:

| account | chain | duration | plan start | status |
|---|---|---|---|---|
| main | `195 219 248 286 327 490` | 741.965 d | 2026-09-04 18:51 | **rank 1 of a 4913-chain exhaustive** |
| alt | `133 159 182 201 227 254 290 490` | 948.145 d | 2026-09-04 21:30 | best found |

**With a schedule**, which is a different question and not comparable to the rows above —
prestiges and shifts are held until the player is available and the delay is charged:

| account | chain | duration | window | plan start | ends |
|---|---|---|---|---|---|
| main | `182 195 228 257 285 322 490` | 739.476 d | 07:00–23:00 | 2026-09-09 19:04 | Mon 2028-09-18 06:29 |
| main | `195 228 257 285 322 490` | 739.476 d | 07:00–23:00 | 2026-09-09 19:04 | Mon 2028-09-18 06:29 |
| alt | `136 161 199 222 252 291 490` | 946.058 d | 09:00–23:00 | 2026-09-11 22:22 | Sat 2029-04-14 23:45 |

The two main rows tie to four decimal places. The **six**-ascension chain finishes at the
same moment as the seven-ascension one, which is one fewer complete rebuild — twelve shifts
and a fresh research grind — for nothing. Prefer it.

**Durations from different plan starts are not comparable** — the end date is the
invariant. This has caused real confusion: a run reporting 741.220 d looked better than
741.965 d and finished five hours *later*.

Comparing the constrained main answer against the older 741.500 d run is also not
straightforward: that one used a 09:00–23:00 window against this one's 07:00–23:00. Across
the **372 chains both runs priced**, the wider window is worth a **median +0.787 d**, so
roughly 1.2 d of the improvement is the last-checkpoint fix and the rest is the extra two
hours a day.

---

## Setup

This lives on top of [wasmegg-carpet/egg](https://github.com/wasmegg-carpet/egg). Against
that repo's `ascension-planner` branch it is **2 modified files and 15 added**.

### 1. Requirements

- **Node 24+** (26 works)
- **pnpm 8+**
- **Python 3.9+** — `python3` on macOS, and `pip install tzdata` **on Windows only**
  (`zoneinfo` has no system timezone database there; macOS and Linux already have one)

### 2. The two modified files

`package.json` — two script entries:

```json
"search:build": "vite build --config vite.search.config.ts",
"fastsearch":   "node dist-search/fastsearch.js",
```

`src/auto/useAscensionGenerator.ts` — **do not skip this one.** It scores the `continue`
variant against `getOptimalELRSet` instead of whatever is equipped right now. A player
parked in an earnings set had continuing scored at roughly half their real delivery rate,
which hid it as an option entirely. Artifact swaps are free and instant in game, so the
honest comparison is against the best set they can actually field. Every plan here uses
`--force-continue`, so leg A1 is a `continue` leg and this changes its result.

### 3. The files you need

| file | why |
|---|---|
| `scripts/fastsearch.ts` | the harness — wraps the app's own simulator |
| `scripts/node-shims.ts` | **required**; `fastsearch.ts` does `import './node-shims'` |
| `vite.search.config.ts` | bundles the above into `dist-search/` |
| `scripts/autoplan.py` | the staged search driver |
| `scripts/evalchains.py` | score chains you name yourself |

`beam_search.py`, `predict.py`, `bruteforce.py`, `cadence.py`, `shift_timing.py` and
`dbg.ts` are superseded and imported by nothing. Ignore them.

### 4. Build

```bash
pnpm install                 # at the REPO ROOT, not here - it is a workspace install
```

```bash
pnpm search:build            # in this directory; writes dist-search/fastsearch.js
```

`dist-search/` is not committed, so this step is mandatory on a fresh clone.

### 5. Verify before trusting a multi-hour run

```bash
node dist-search/fastsearch.js --backup blind_main.json --final 490 --start-date 2026-09-04 --start-time 18:51 --timezone America/Denver --force-continue --jobs 1 --top 3 --stages "195;219;248;286;327"
```

This must print **`741d 23h`**. That chain is rank 1 of a 4913-chain exhaustive, so if a
new machine reproduces it to the hour, the simulator is faithful. It has been reproduced
on Windows/Node 24 and macOS/Node 26, agreeing to 0.001 d. If you get a different number,
stop — something in the build differs and every result would be suspect.

---

## Running a search

`fastsearch` runs the **same search the browser panel runs** -- it imports
`src/search/driver.ts` and `src/search/chain.ts` directly, so there is one staged search
with two front ends rather than two implementations that can disagree:

```bash
pnpm search:build
node dist-search/fastsearch.js --backup me.json --effort thorough --find-seed --jobs 12 --csv run.csv
```

`node dist-search/fastsearch.js --help` lists every flag, grouped the way the panel groups
its settings. Everything the panel exposes has one: `--effort`, `--seed`, `--find-seed`,
`--min-prestiges` / `--max-prestiges`, `--pin`, `--available-from` / `--available-to` /
`--available-days`, `--no-hold-shifts`, `--milestone`, `--final`, `--start-date` /
`--start-time` / `--timezone`, `--force-continue`, `--csv`.

**`--backup file.json` runs fully offline** -- nothing is fetched, so an air-gapped machine
with a saved backup runs the whole thing. `--player-id` is the only flag that touches the
network, and `--save-backup` writes what it fetched so you only need it once.

### Proving it, rather than trusting it

The staged search returns a strong local optimum. `--exhaustive` prices **every**
strictly-increasing chain over a pool with no staged search and no pruning of any kind, so
its winner is the true optimum of that space:

```bash
node dist-search/fastsearch.js --backup me.json --exhaustive --range 185:390:15 --prestiges 6-7 --jobs 12
```

The chain count and a wall-clock estimate are printed before anything is simulated, and
anything over 5000 chains needs `--yes`. That matters: choosing 6 checkpoints from 185..390
at step 1 is C(206,6) = 8.2e10 chains. Coarsen `--range` until the estimate is bearable,
then narrow around the winner.

### Reading the results (browser)

The panel's runners-up table is one of five **views** over the same priced chains. Switching
re-reads the run's cache and simulates nothing, so it is instant:

| view | what it shows |
|---|---|
| A good mix | the leader, the best chain at each other ascension count, then genuinely different plans. The default, and the only view that filters |
| Fastest | the raw ranking, nothing dropped. Expect near-duplicates: a sweep prices dozens of chains differing by one TE |
| Kindest to my schedule | sorted by time spent waiting for you, not by length |
| By ascension count | best chain at each count. One fewer rebuild for half a day is a trade worth seeing |
| By finish date | one chain per calendar day it could finish on |

**No view filters by schedule fit.** A chain whose shifts land outside your hours is a real
option with a real cost; the cost gets a column and the choice stays yours.

Two behaviours worth knowing because they would otherwise look like bugs. A chain replayed
from a saved checkpoint kept no per-leg detail, so its waiting cost is *unknown* rather than
zero — it sorts last under "Kindest to my schedule" and shows `not recorded`. And "By finish
date" needs a plan start to know which day a chain lands on; without one it falls back to the
ranking rather than collapsing every chain onto the same epoch day.

### Leaving a long run overnight (browser)

An exhaustive run is hours to days of work in a tab, and the two things that end one early are
both the browser's doing rather than the search's. Neither produces an error in the log, which
is what makes them confusing: you come back to a stopped run, or to a page that says
*"This page is having a problem"* with a crash code.

**Memory.** A priced chain is two things: its answer — a key and a duration, tens of bytes —
and its per-leg detail, which carries each leg's twelve shifts as objects and runs to
kilobytes. Hundreds of thousands of chains of the second thing is how a renderer reaches its
heap ceiling (4 GB in Chrome and Edge on 64-bit; the Insane panel shows the tab's current
usage against it). The panel's **Memory** card sets how many chains keep their detail — the
fastest N, defaulting from `navigator.deviceMemory` where the browser reports it. Everything
past N keeps its duration, which is the answer and what the leaderboard, the CSV totals, the
checkpoint and the proof block are all built from; what is dropped is the per-leg timing for
chains you did not win with. This is the same trade the checkpoint has always made:
`buildCheckpoint` persists `durations` for every chain and `bestLegs` for one.

There is no way for a page to request or cap memory, so "how much should this use" can only be
answered as "how much should it choose to hold". Setting the budget to `0` keeps everything,
which is a real choice for a short run on a machine with room.

**Freezing and discarding.** These are two different mechanisms and only one of them can be
argued with from code.

- *Freezing* (Chrome/Edge Energy Saver) suspends a tab's task queues once every page in the
  group has been hidden and silent for about five minutes. Chromium's freezing policy has an
  explicit opt-out list, and one entry on it is a page "holding a Web Lock or an IndexedDB
  transaction" — so the run takes a Web Lock for its whole duration. That is not a trick; it
  is the documented way to say this tab is doing something.
- *Discarding* (Memory Saver) kills a background tab outright under memory pressure. **No API
  prevents it.** There is no event before it happens; the page only learns about it afterwards,
  via `document.wasDiscarded` on the reload. The defences are the checkpoint and the memory
  budget, not code that asks the browser to stop.

If you leave runs overnight, exempt the site in the browser itself:

| browser | where |
|---|---|
| Chrome | `chrome://settings/performance` → Memory Saver → **Always keep these sites active** |
| Edge | `edge://settings/system` → Sleeping tabs → **Never put these sites to sleep** |

The run also checkpoints on `visibilitychange` as well as on its timer, because
`beforeunload` and `unload` do **not** fire when a tab is discarded — going hidden is the last
moment a page is reliably given.

### The older Python driver

`scripts/autoplan.py` predates the shared driver and reimplements the staged search in
Python, driving `fastsearch --stages` batch by batch. It still works and its flags are
unchanged:

```bash
python scripts/autoplan.py --player-id EI1234567890123456 --backup me.json --effort balanced --jobs 12 --yes
```

Prefer `--effort` on `fastsearch` for anything new. The duplication is not free: the
`resolve_last` bug that left the last checkpoint unswept existed in **both** copies and had
to be found and fixed twice.

### Effort tiers

The stages are strictly nested, so a tier is a **stop point**. Picking a higher tier and
losing patience still leaves you the lower tier's answer.

| tier | stages | time | measured accuracy |
|---|---|---|---|
| `quick` | descent | ~1h05m | 0 / 5 / 5 / 61 / **150** h behind the best found (5 obs) |
| `balanced` | + 2-D slices | ~2h55m | 1.3 h and 0 h (2 accounts) |
| `normal` | + count probe | ~3h30m | **exact** — matched the 4913-chain exhaustive (n=1) |
| `thorough` | + 3-D slices | 7–13 h | one 1.665 d win on the alt; nothing to add on the main |

> **Every figure in that table was measured before the last-checkpoint sweep was fixed**, and
> they are therefore **pessimistic by an unknown amount**. On the main the fix was worth
> roughly 1.2 d on its own; on the alt it changed nothing, because the bug only bit when the
> coarse scan proposed a last checkpoint above `maxLast` and the alt's never did. Re-measuring
> the tiers is several account-days of compute and has not been done. Treat the table as a
> floor, not an estimate.

Accuracy is stated as hours behind the best answer *found*, with the sample size. There
are no confidence percentages here on purpose: three to five observations cannot honestly
be turned into one.

`quick` has always landed inside a week and usually inside a day, but the spread is real —
two runs on the same account 5.5 hours apart differed by **6 days**, because descent alone
is basin-sensitive and nothing after it re-checks the neighbourhood. Use it to get a good
answer in under an hour, not to get *the* answer.

### Flags worth knowing

| flag | effect |
|---|---|
| `--max-hours N` | refuses to start a configuration projected past N hours. **Off by default** — the projection is printed either way and a long run is your call |
| `--jobs N` | worker cap. The pool is sized **per batch** — see below |
| `--jobs-fixed` | honour `--jobs` literally instead of sizing per batch |
| `--mod elr=1.05` | colleggtible what-if: scales one modifier dimension |
| `--add-artifact metronome:legendary` | artifact what-if: injects into the **virtue** inventory |
| `--seed "195 219 248"` | skip the coarse scan and start from a chain you supply |
| `--radius N` | descent/slice window (default 8) |
| `--sleep-from 23 --sleep-until 7` | when you sleep. Changes the answer — see below |
| `--available-from 8 --available-to 22 --available-days sat,sun` | the general form of the same thing |
| `--prestiges 5-8` | how many ascensions the plan may use |
| `--pin N` | hold the first N checkpoints fixed |
| `--milestone "248@2027-06-01"` | a date you have to hit. Repeatable. Drops chains that miss it |

### Picking `--jobs`

Set it to roughly half your logical cores and stop thinking about it. On a 20-core box a
fixed 152-chain batch varied only **7.9%** across `--jobs` 6/12/17 — and the *perfectly
balanced* 17-way split was the slowest of the three, so shard balance is not the variable.

What does matter is batch size. Every shard is a fresh node process loading a 6.2 MB
bundle, and those loads contend. On a MacBook, stage 2 (one 372-chain batch) ran at
**1.43 s/chain** while stage 4 (many 13–17 chain batches) ran at **19.68 s/chain** at the
same `--jobs 12`, and 5.1 s/chain at `--jobs 6`. `Sim.jobs_for` now keeps at least
`CHAINS_PER_SHARD` chains per process, so a 13-chain batch gets 4 workers and the coarse
scan still gets all 12.

### Your schedule (`--sleep-from`/`--sleep-until`, `--available-*`)

Two spellings of one thing. `--sleep-from 23 --sleep-until 7` is the common case;
`--available-from 8 --available-to 22 --available-days sat,sun` is the general form. Days
are comma separated names or 0–6 (Sunday first), hours are whole and read in `--timezone`.
`--available-days` works alone to mean "those days, any hour". An hour window may wrap:
`--available-from 18 --available-to 2` is evenings into the night, and the back half of
such a session counts as belonging to the day it *started* on.

**What it does.** A leg ends the instant its target TE is reached, and the plan's next
instruction is a prestige — you cannot start the next ascension without it. Each inter-leg
prestige that would land while you are away is moved to your next available hour and the
delay is **charged**, which shifts every downstream Research Sale boundary. That is why it
has to be set before the search starts: it changes which chain is fastest, and it cannot be
applied to an answer afterwards.

Measured on the main account's proven optimum, browser and CLI agreeing to the hour:

```
195 219 248 286 327 490        unconstrained          741.965 d
  awake 07:00-23:00, any day   ->  745.789 d   (+3.8 d)
  weekends only, 08:00-22:00   ->  767.0   d   (+25.0 d)
```

Only ~9.6 h of the first is waiting. The rest is the knock-on: A4's 6.5 h push moved the
final build past a sale boundary, and the final leg's strategy flipped from `1-sale-tier13`
to `2-sale-tier13`. Both figures are for that **fixed** chain — re-optimising under the
constraint is the whole reason the schedule lives in the objective rather than in a report,
and the weekend-only number in particular should improve a lot once the checkpoints are
free to move.

**What it does not do.** Only the prestige between ascensions is moved. The twelve shifts
inside an ascension are scheduled by the simulator's own `te-wait` logic and are **not**
moved — on the awake-hours run above, 5 of 72 still land at night. The CSV's
`A*_nightshifts` columns count them per leg. The delay is also charged in full while the
extra TE you keep earning while away is not credited, so a plan built this way should if
anything run marginally faster than it says.

Every accuracy figure in the effort table above was measured with **no schedule**. Chains
scored with and without one are not comparable.

New CSV columns: `A*_wait_h` (hours that prestige waited) and `A*_nightshifts`.

### Dated milestones (`--milestone`)

`--milestone "248@2027-06-01"`, repeatable. A chain that misses one is **dropped** — not
ranked lower, dropped — so this steers the search rather than annotating the answer. It
reuses the path a chain whose simulation failed already takes, which is why it needs no
change to `driver.ts`.

Stated as a **TE value, not an ascension number**, and that is deliberate. The
prestige-count probe adds and removes checkpoints, so "A3" means a different TE before and
after stage 7 — a constraint whose meaning changes mid-search is not a constraint. A TE
value is stable however the chain is reshaped, and it is also the thing a player is
actually waiting for.

A milestone is met when some leg ends **at or above** that TE at or before the deadline
(end of the named day, in `--timezone`). Reaching a TE is not an action, so the raw leg end
is the right instant even under a schedule — you hit the number while asleep just the same.

**A milestone on `--final` cannot improve anything.** The search already minimises total
time, so the fastest chain is by construction the one most likely to meet a deadline on the
final target; if the optimum misses your date, nothing else makes it. All such a milestone
can do is turn "here is the earliest you can finish" into "no chain found". Intermediate
milestones are the ones that change which chain wins.

When nothing is feasible the run says so and reports nothing, because a rejected chain is
never priced or ranked. Relax the tightest date to see how close the fastest plan gets.

---

## What is worth chasing

### Colleggtibles

One additional colleggtible at T4, chain re-optimised, on the main account:

| dimension | days saved | note |
|---|---|---|
| away earnings ×3 | **23.5** | compresses the build phases; the final leg gets *longer* |
| egg laying rate +5% | 20.4 | |
| hab capacity +5% | 20.4 | **bit-identical to ELR** across five tested magnitudes |
| shipping capacity +5% | 19.4 | attacks the final leg instead of the build |
| research cost −5% | 0.3 | |
| internal hatchery, vehicle cost, hab cost | **exactly 0** | at every tier |

A 25% hab-cost cut and a 10% vehicle-cost cut change nothing at all — the plan is
time-limited, not cash-limited.

The tier ladders have opposite shapes, which changes whether a partial egg is worth
chasing:

```
                  T1     T2     T3     T4
elr / habCap     0.08   3.05   6.85  15.30   CONVEX  - all the value at T4
shippingCap      4.37   8.37  12.14  15.14   CONCAVE - pays from T1
```

A shipping egg is worth 4.4 days at T1 alone. An ELR egg's first three tiers are worth
almost nothing; only the 10B farm matters.

**Fixed-chain estimates systematically understate, and unevenly enough to reorder the
ranking** — re-optimising added +5.1 d to ELR but +13.5 d to away earnings, which moved
away earnings from third place to first. Always re-optimise before comparing.

### Artifacts

The **virtue inventory is separate from the main game's**. You can hold legendary
compasses in the main game and only epics in virtue, which is exactly the case here.

| account | upgrade | days saved |
|---|---|---|
| alt | legendary metronome **+** legendary puzzle cube | **45.3** |
| alt | legendary metronome alone | 28 |
| alt | legendary puzzle cube alone | 7 |
| main | legendary interstellar compass | 15.7 |
| alt | the chalice (IHR) | 0 |
| main | book of basan, phoenix feather | 0 |

The metronome and cube are **superadditive** — 45.3 together against 35 apart. A cheaper
research cost lets the farm reach the higher lay rate sooner.

---

## What does not work

Do not spend time re-deriving these. All are measured; see "The measurement record" at
the end of this file.

- **Predicting a chain's duration without simulating.** A feature-based surrogate got
  Spearman ρ = −0.053, median error 15.6 days, and 0/100 overlap with the true top 100.
  The true top 100 spans 1.66 days while unmodelled farm state moves a single leg 1.0–2.6
  days.
- **Pruning by prefix cost.** Unsafe: a prefix arriving later can arrive with a higher
  delivery rate and win overall.
- **`--prune` as implemented.** Measured: pruned 0 of 69 chains.
- **A closed-form final leg.** The earn phase is already a single division; the main's
  406-day final leg carries 0.748 days of simulated build phase.
- **Any "stop when it turns up" rule.** The landscape is not unimodal: a measured
  envelope falls after a rise.
- **Widening the descent radius past 8.** A replay from all 4913 exhaustive grid points
  put the knee at radius 4 and exactness at 7.

The consequence: every checkpoint value must be simulated to be known. The
exactness-preserving speedups available total **5–7 minutes on a 209-minute run**. The
only three levers are: simulate fewer chains, simulate them faster, or accept a worse
answer — which is what the effort slider sells.

---

## Known limitations

- **`--effort thorough` projects to 7–13 h.** No longer refused (`--max-hours` is off by
  default and the projection is printed, so the call is yours). Stage 6 has exactly one
  measured win — **1.665 d (40 h) on the alt**, where an exhaustive X4xX5xX6 slice beat the
  2-D-polished answer and the recipe ranked 55 of 2197 — but that predates the fix that
  taught stage 5 to sweep the last adjacent pair, so how much of those 40 h stage 5 now
  catches on its own is **unmeasured**. On the main, a 4913-chain 3-D exhaustive matched the
  recipe exactly. Stage 6 is also ~74% of the tier's chains and runs *before* the
  prestige-count probe, which gates the one stage that produced the main's proven answer.
- **No full browser run has been observed to completion.** The ported evaluator reproduces
  741.965 exactly and stages 2–7 are all present (`src/search/*.spec.ts`, 56 tests), but
  the longest observed browser run is a partial `thorough` still in progress.
- **Serving the app over plain HTTP on a LAN breaks it.** `crypto.subtle` only exists in a
  secure context, so `hashID()` throws and every IndexedDB write fails. Use `localhost`,
  or put it behind HTTPS (a Cloudflare tunnel works).
- **Per-leg and per-pass timing are not recorded.** `autoplan.py` captures fastsearch's
  output only on failure, so its own `leg sims` counts are discarded. Several cost figures
  here are reconstructed from stage timestamps rather than measured.
- **Shifts are held by a delay model, not by the simulator.** With "hold the shifts for my
  hours too" on, each of the twelve in-ascension switches is pushed to the next available
  instant on top of the simulated timeline and the accumulated delay moves the leg's end.
  That is right to first order and errs one way only -- while you wait the farm keeps laying
  the egg you have not switched away from, and that progress is not credited. An exact
  answer needs `auto/shifts/te-wait.ts` to schedule around availability itself, which would
  change the manual planner too. With the box off, shifts are reported and free.
- **The artifact inventory is held fixed for the entire plan.** The search reads the virtue
  inventory out of the backup once and assumes it never changes across ~740 days, which it
  will not -- you will craft and upgrade. The bias is in the safe direction (the real run
  should beat these dates) and comparisons *between* chains stay fair because every
  candidate is handicapped identically, but the absolute dates drift, worst at the far end.
  The panel shows the inventory it used and says so; the CSV header records it too. Re-run
  after significant crafting.
- **The browser's CSV export loses per-leg detail across a refresh, and past the memory
  budget.** A checkpoint keeps `legs` for the best chain alone, so replayed chains export
  their total with the per-leg cells blank. Chains priced in the current session are complete
  up to the Insane panel's memory budget, past which the slowest chains are stripped to their
  durations while the run is still going — see *Leaving a long run overnight*. Both are the
  same trade and both are visible in the CSV the same way.

---

## The measurement record

Every accuracy figure, refuted claim and self-correction in this document comes from a
findings log and a set of run artifacts kept in the author's working repository: an
append-only findings log, a 4913-chain exhaustive CSV that is the ground truth behind
"rank 1 of 4913", and the blind held-out validation runs behind the effort-tier figures.
Those are not shipped here -- they are a few megabytes of one player's run logs, and they
carry that player's save data by reference. Ask if you want them for review.

What *is* shipped is the part anyone can re-run: `src/search/*.spec.ts`, including a
fixture test that reproduces the CLI's 741d 23h to the hour against a real backup, and the
CLI itself -- so any claim here can be checked against your own account.

See [FOR_MATH_NERDS.md](FOR_MATH_NERDS.md) for the combinatorics, the dead ends with their
numbers, and an explicit split between what is measured and what is a hunch.
