# For math nerds

What this is actually doing, why the obvious approaches do not work, and which parts are
guesses rather than results.

Everything with a number attached was measured. Where something is a hunch, it says so.

---

## 1. The problem

You are at some Truth Egg total and you want to reach 490. You get there by ascending to a
checkpoint, prestiging, ascending to a higher one, and so on. A **chain** is that list of
checkpoints — `195 219 248 286 327 490`. You pick the checkpoints; the game does the rest.

Two chains that reach the same target can differ by **twelve days** on a plan that runs
roughly seven hundred. So the question is: which chain is fastest?

### Why you cannot just try them all

A checkpoint is an integer TE value. Between a current 177 and a final 490 there are 313
of them, and a chain is a strictly increasing subset:

| chain length | candidates |
|---|---|
| 6 checkpoints | 1.245 × 10¹² |
| 7 checkpoints | 5.458 × 10¹³ |
| 8 checkpoints | 2.088 × 10¹⁵ |
| **all lengths 3–9** | **7.29 × 10¹⁶** |

Scoring one chain means simulating every leg of it. That costs about **15 seconds** — not
because the code is slow, but because a leg is a full farm simulation: research purchases,
hab and vehicle upgrades, twelve egg switches, sale timing, the lot. A CPU profile puts the
cost in the simulator itself; removing the browser bought almost nothing.

7.29 × 10¹⁶ chains × 15 s ≈ **3.5 × 10¹⁰ years** on one core. Twenty cores and a great
deal of patience does not help.

### And good chains are rare

On the one account where an exhaustive was actually run — 4913 chains, every combination
inside a fixed box — **21 of them (0.43%) land within a day of optimal**. The true top 100
spans 1.66 days. You are not going to stumble into that by trying a few by hand, which is
the entire reason this tool exists.

---

## 2. What we cannot do

These are all dead ends, each measured rather than reasoned about.

**Predict a chain's duration without simulating it.** A feature-based surrogate — chain
shape in, days out — scored **Spearman ρ = −0.053** against the truth, median error **15.6
days**, and **0/100 overlap with the true top 100**. Slightly worse than useless: it is
anti-correlated. The reason is that unmodelled farm state moves a *single leg* by 1.0–2.6
days while the entire top 100 spans 1.66 days. The signal is smaller than the noise.

**Prune by prefix cost.** Tempting and wrong. A prefix that arrives *later* can arrive with
a higher delivery rate and win overall, so dropping candidates on early-leg time is not
admissible. An implemented branch-and-bound pruned **0 of 69** chains on a real run — the
bound was never tight enough to cut anything, which is the friendly way for an inadmissible
idea to fail.

**Assume the landscape is nice.** It is not unimodal. A measured envelope falls after a
rise, so "stop when it turns up" strands you early.

**Solve the last leg in closed form.** The earn phase already is a single division; the
main account's 406-day final leg still carries 0.748 days of simulated build phase.

---

## 3. What we do instead

Coordinate descent with exhaustive slices, over a simulator we trust, with one honest
claim: **the result is a strong local optimum, never a proven global one.**

The stages are **strictly nested**, so a tier is a stop point rather than a different
algorithm. Stopping early leaves you exactly what the completed stages guarantee.

| stage | what it does |
|---|---|
| **coarse scan** *(optional)* | A wide grid at step 15–25, to pick a starting shape and an ascension count. Its answer is deliberately rough: measured **8.6 and 12.0 days** off the final result on two accounts. |
| **4a. resolve last** | Sweep the final checkpoint at step 1 over a window that widens while the winner is pinned to an edge. |
| **4. coordinate descent** | Move one checkpoint at a time, ±8, re-solving the last checkpoint after every accepted move. |
| **5. 2-D slices** | Exhaustive 17×17 over every adjacent pair. Catches pairs that only pay off jointly. |
| **6. 3-D slices** | Exhaustive 13×13×13 over every adjacent triple. |
| **7. prestige-count probe** | Drop a checkpoint or insert one, then re-polish. |

### How little of the space that is

For a 7-ascension chain:

| tier | chains priced | fraction of the space |
|---|---|---|
| Fast | 606 | 8.3 × 10⁻¹⁵ |
| Balanced | 2,051 | 2.8 × 10⁻¹⁴ |
| Exact | 2,274 | 3.1 × 10⁻¹⁴ |
| Thorough | 11,062 | 1.5 × 10⁻¹³ |

Thorough looks at roughly **one chain in ten trillion** and lands within hours of the best
answer found. That is not because the search is clever; it is because of the next section.

---

## 4. Why so little coverage still works

**The landscape has structure, and it is the game's sale calendar.**

A leg's build phase ends on a Research Sale END — Saturday 09:00 Pacific, DST-exact. So as
you sweep a checkpoint one TE at a time, the duration does not vary smoothly: it forms
**descending runs of 3–5 values separated by jumps of about +3.15 days**, and the optimum
is always at a run-end. Verified **933/933** on the corpus.

That is the whole reason a ±8 sweep finds anything. The function is piecewise, the pieces
are a few TE wide, and a radius-8 window is wide enough to contain a whole run and its
boundary. A replay of the search across all 4913 exhaustive grid points put the **knee at
radius 4 and exactness at radius 7**; the code uses 8, one step of margin rather than a
round number.

**Prefix sharing.** Chains form a trie. Every chain starting `195 219 248` shares those
three leg simulations, so the marginal cost of a candidate is usually one leg, not six.
This is why batches are cut on whole prefix subtrees and never round-robin: a 17-value
sweep costs `2 + 17×4 = 70` leg simulations in one worker and `17×6 = 102` spread across
seventeen.

---

## 5. Where it goes wrong

**Basins.** Coordinate descent cannot cross a ridge wider than its radius. A real run
settled at 742.378 d with the last checkpoint at 359 while 741.500 d sat at 328 — thirty-one
away, unreachable by ±8 steps, and never priced. That one was our bug (the last-checkpoint
sweep was silently disabled by an out-of-range window; fixed, with a regression test seeded
31 away from the optimum precisely so a ±8 descent cannot pass it). But the failure mode is
real and survives the fix: **a bad starting chain can still strand the search in a bad
neighbourhood**, and nothing in the algorithm detects that.

**The coarse scan is the weak link.** It picks the basin, and its own answer is 8–12 days
off. When it picks badly, every stage afterwards polishes the wrong hill beautifully.

**Sample size.** Accuracy figures come from **three accounts**, and only one has a proven
optimum to check against. There are no confidence percentages anywhere in this project on
purpose: three observations cannot honestly be turned into a probability, and inventing one
would be the most damaging thing the tool could do to someone deciding whether to spend
three hours.

---

## 6. Things we currently believe, at varying confidence

**Well supported.**

- The optimum is always at a sale-boundary run-end. 933/933.
- Radius 8 is enough for single-axis moves. Knee at 4, exact at 7, across 4913 points.
- Prefix cost is not an admissible bound. Reasoned and confirmed empirically.
- Duration is not predictable from chain shape without simulating.

**Believed, thinly evidenced.**

- **`maxLast = final − 150`.** The last checkpoint should not sit near the target: a tiny
  final leg pays a full rebuild for almost no earning time. Measured optima are ~330 on the
  main and ~289 on the alt against a 490 target. This is a *cap chosen from two
  observations*, and it is load-bearing — it is what made the coarse scan's out-of-range
  proposal possible in the first place. If someone finds a real optimum above `final − 150`,
  this is wrong and the search cannot currently find it.
- **Stage 6 (3-D slices) earns its 74% of Thorough's chains.** One measured win: 1.665 d
  (40 h) on the alt, where an exhaustive 13³ slice beat the 2-D-polished answer and the
  recipe ranked 55 of 2197. But that predates the fix that taught stage 5 to sweep the last
  adjacent pair, so an unknown share of those 40 h may now be caught by stage 5 alone. On
  the main, a 4913-chain 3-D exhaustive matched the recipe exactly and stage 6 added nothing.
- **Descent order does not matter much.** Never tested.

**Open questions we have not touched.**

- Is there a cheap test for "the coarse scan put me in the wrong basin"? Restarting from
  several seeds and comparing would answer it and costs a multiple of the run.
- Would simulated annealing or a genetic approach beat coordinate descent at equal budget?
  Unknown. The sale-boundary structure suggests descent is well matched to the problem, but
  that is an argument, not a measurement.
- The artifact inventory is **held fixed for the entire plan**, which is false — you craft
  as you go. The bias is safe (real runs should beat these dates) and it cancels between
  candidates, so it does not change the ranking. It does move the absolute dates, worst at
  the far end, and nobody has quantified by how much.
- Schedule constraints are applied as a **delay model layered on the simulated timeline**,
  not re-simulated. It errs one way only: while you wait, the farm keeps laying the egg you
  have not switched away from, and that progress is not credited.

---

## 7. If you want to check any of this

`--exhaustive` prices every strictly-increasing chain over a pool with no staged search and
no pruning, so its winner is the true optimum of that space:

```bash
node dist-search/fastsearch.js --backup me.json --exhaustive --range 185:390:15 --prestiges 6-7 --jobs 12
```

It prints the chain count and a wall-clock estimate before simulating anything, and refuses
past 5000 chains without `--yes` — see the table in section 1 for why that guard exists.

That is how "rank 1 of 4913" was established, and it is the only mode in this project that
can prove anything.
