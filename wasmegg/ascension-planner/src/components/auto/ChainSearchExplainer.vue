<template>
  <div class="space-y-4">
    <!-- What the problem is, before any mention of how it is attacked. -->
    <section class="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button
        type="button"
        class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
        :aria-expanded="open.how"
        aria-controls="cs-how"
        @click="open.how = !open.how"
      >
        <svg
          class="w-4 h-4 flex-shrink-0 text-slate-400 transition-transform duration-200"
          :class="{ 'rotate-90': open.how }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        <span class="text-[11px] font-black text-slate-700 uppercase tracking-widest">How it works</span>
        <span class="text-[10px] font-bold text-slate-400 normal-case tracking-normal ml-auto">
          the problem, and why it is hard
        </span>
      </button>

      <div v-show="open.how" id="cs-how" class="px-4 pb-5 pt-1 space-y-4 text-xs text-slate-600 leading-relaxed">
        <p>
          You reach a Truth Egg target by ascending to a checkpoint, prestiging, ascending to a higher one, and so on.
          That list of checkpoints is a chain:
          <code class="font-mono-premium text-slate-800">195 219 248 286 327 490</code>. You pick them and the game does
          the rest. Two chains that reach the same target can finish
          <span class="font-bold text-slate-800">twelve days</span> apart on a plan that runs about seven hundred, which
          is what this panel is for.
        </p>

        <div>
          <p class="font-bold text-slate-800 mb-2">Why you can't just try them all</p>
          <p class="mb-3">
            A checkpoint is a whole number of Truth Eggs, and a chain is a strictly increasing subset of them. Between a
            current 177 and a final 490 there are 313 to pick from:
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-[11px] font-mono-premium">
              <thead>
                <tr class="text-slate-400 uppercase tracking-widest text-[9px] font-black">
                  <th class="text-left py-1.5 pr-4 font-black">Chain length</th>
                  <th class="text-right py-1.5 font-black">Possible chains</th>
                </tr>
              </thead>
              <tbody class="text-slate-700">
                <tr v-for="row in SPACE_SIZE" :key="row.label" class="border-t border-slate-100">
                  <td class="py-1.5 pr-4" :class="{ 'font-bold text-slate-900': row.emphasis }">{{ row.label }}</td>
                  <td class="py-1.5 text-right tabular-nums" :class="{ 'font-bold text-slate-900': row.emphasis }">
                    {{ row.count }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-3">
            Scoring one chain means simulating every leg of it: research purchases, hab and vehicle upgrades, twelve egg
            switches, sale timing. That costs about <span class="font-bold text-slate-800">15 seconds</span>. At 7.29 ×
            10<sup>16</sup> chains it comes to roughly
            <span class="font-bold text-slate-800">3.5 × 10<sup>10</sup> years</span> on one core, and twenty cores
            barely dents that.
          </p>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Good chains are rare</p>
          <p class="mb-3">
            The figure below covers one box priced in full: all {{ DISTRIBUTION.n.toLocaleString() }} chains of the form
            <code class="font-mono-premium text-slate-800">195 X₂ X₃ X₄ 490</code> over a fixed range of each
            checkpoint. Since nothing in it was skipped, the winner there is a
            <span class="font-bold text-slate-800">proven</span> optimum of that box rather than something a search
            happened to land on.
          </p>
          <ChainMathFigure kind="distribution">
            Best to worst spans {{ (DISTRIBUTION.worst - DISTRIBUTION.best).toFixed(1) }} days. Only
            <span class="font-semibold text-slate-700">{{ DISTRIBUTION.within1 }} chains (0.50%)</span> land within a
            day of the best, and the whole top 100 fits inside
            <span class="font-semibold text-slate-700">{{ DISTRIBUTION.top100Span }} days</span>. Picking checkpoints by
            feel drops you somewhere in the middle of that hump, about a week behind.
          </ChainMathFigure>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Three things that do not work</p>
          <ul class="space-y-2 list-disc list-outside pl-4">
            <li>
              Guessing a chain's duration without simulating it. A feature-based predictor scored Spearman ρ = −0.053
              against the truth, a median error of 15.6 days, and zero overlap with the true top 100. It is
              anti-correlated, so it is worse than having nothing. Unmodelled farm state shifts a single leg by 1 to 2.6
              days while the whole top 100 spans under two, so the noise is larger than the signal.
            </li>
            <li>
              Discarding chains that start slowly. A prefix that arrives later can arrive with a higher delivery rate
              and win overall, so early-leg time is not a safe basis for pruning. An implemented branch-and-bound cut 0
              of 69 chains on a real run.
            </li>
            <li>
              Assuming the shape is well behaved. It is not unimodal, as the second figure below shows, so "keep going
              until it gets worse" stops you early.
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Only now: what the search does, and why so little coverage is enough. -->
    <section class="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button
        type="button"
        class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
        :aria-expanded="open.algorithm"
        aria-controls="cs-algorithm"
        @click="open.algorithm = !open.algorithm"
      >
        <svg
          class="w-4 h-4 flex-shrink-0 text-slate-400 transition-transform duration-200"
          :class="{ 'rotate-90': open.algorithm }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        <span class="text-[11px] font-black text-slate-700 uppercase tracking-widest">The algorithm</span>
        <span class="text-[10px] font-bold text-slate-400 normal-case tracking-normal ml-auto">
          and where it goes wrong
        </span>
      </button>

      <div
        v-show="open.algorithm"
        id="cs-algorithm"
        class="px-4 pb-5 pt-1 space-y-5 text-xs text-slate-600 leading-relaxed"
      >
        <div>
          <p class="font-bold text-slate-800 mb-2">The shape comes from the sale calendar</p>
          <p class="mb-3">
            A leg's build phase ends on a Research Sale END, which falls on Saturday at 09:00 Pacific. Move one
            checkpoint up a single Truth Egg and the duration does not change smoothly. Usually you still make the same
            Saturday and the leg gets slightly cheaper. Go one too far and you miss that sale and wait for the next one.
          </p>
          <ChainMathFigure kind="sawtooth">
            Every tooth is one missed sale. The best value in a sweep always sat at a
            <span class="font-semibold text-slate-700">run-end</span>, meaning the last Truth Egg before a jump:
            <span class="font-semibold text-slate-700"
              >{{ SAWTOOTH_STATS.runEndHits }} times out of {{ SAWTOOTH_STATS.runEndTotal }}</span
            >
            fully swept prefixes in the box. Jumps have a median size of {{ SAWTOOTH_STATS.jumpMedianDays }} days across
            {{ SAWTOOTH_STATS.jumpCount }} measured, and {{ SAWTOOTH_STATS.runLength35Pct }}% of descending runs are 3
            to 5 Truth Eggs long.
          </ChainMathFigure>
          <p class="mt-3">
            That run length is what makes a narrow sweep viable. The function is piecewise and the pieces are a few
            Truth Eggs wide, so a <span class="font-bold text-slate-800">±8 sweep</span> is wide enough to hold a whole
            run plus the boundary that ends it. Replaying the search across 4913 exhaustive grid points put the knee at
            radius 4 and exactness at radius 7. The code uses 8, one step of margin.
          </p>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Zoomed out, it is not a bowl</p>
          <ChainMathFigure kind="wide">
            The same sweep across 86 consecutive values. The left side drops in
            <span class="font-semibold text-slate-700">ledges of 10 to 50 days</span> as whole legs reorganise. It
            falls, rises, and falls again, which is what
            <span class="font-semibold text-slate-700">not unimodal</span> means here: a hill-climb that stops at the
            first upturn strands early. The floor is a broad plain around 283 to 290. Parking the last checkpoint near
            the target instead costs 37.4 days, because a tiny final leg pays for a full farm rebuild and then has
            almost no time left to earn.
          </ChainMathFigure>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">What the search actually runs</p>
          <p class="mb-3">
            Coordinate descent with exhaustive slices, scored by the same simulator the Auto Planner uses. The stages
            are <span class="font-semibold text-slate-700">strictly nested</span>, so a higher effort tier stops later
            in the same sequence. Whichever tier you stop at, you keep everything the completed stages guarantee.
          </p>
          <ol class="space-y-2 list-decimal list-outside pl-4">
            <li v-for="stage in STAGES" :key="stage.name">
              <span class="font-semibold text-slate-700">{{ stage.name }}:</span> {{ stage.what }}
            </li>
          </ol>
          <p class="mt-3">
            On a 7-ascension chain the Thorough tier prices about 11,062 chains, roughly
            <span class="font-bold text-slate-800">one in ten trillion</span> of the space, and lands within hours of
            the best answer found. It gets away with that because the sale calendar has already cut the range into
            pieces small enough to sweep.
          </p>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Where it goes wrong: the chain you start from</p>
          <p class="mb-3">
            Coordinate descent cannot cross a ridge wider than its radius, and nothing in the algorithm notices when it
            is stuck on the wrong hill. The figure below measures what that costs. Each column is a different
            <span class="font-semibold text-slate-700">first checkpoint</span>, and its height is the best chain
            reachable from there. The same {{ SEED_SENSITIVITY.cells.toLocaleString() }}-chain box was priced under
            every column, so they are directly comparable.
          </p>
          <ChainMathFigure kind="seed">
            Starting at {{ seed.bestX1 }} reaches {{ seed.bestDays }} days. Starting at {{ seed.worstX1 }} cannot do
            better than {{ seed.worstDays }}, a <span class="font-semibold text-slate-700">{{ seed.spread }}-day</span>
            penalty settled before the search runs at all. The penalty is also
            <span class="font-semibold text-slate-700">jagged rather than bowl-shaped</span>, so there is nothing to
            follow downhill: 191 beats its neighbour 192 by 10 days, and 192 is 10 days worse than 194.
          </ChainMathFigure>
          <p class="mt-3">
            Good and bad starting chains really do end up in different places, which puts a lot of weight on the coarse
            scan that picks one for you. Its own answer measured
            <span class="font-bold text-slate-800">8.6 and 12.0 days</span> off the final result on the two accounts
            tested. When it picks badly, every later stage does a careful job on the wrong hill. Running twice from
            different starting chains and comparing the answers is the only way to catch that at the moment.
          </p>
          <p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">
            What you get out of this is a strong local optimum. It has never been proven to be the global one, and the
            search cannot tell you how far off it is. The accuracy figures come from three accounts, only one of which
            has a proven optimum to check against. That is also why there are no confidence percentages anywhere in this
            project: three observations cannot honestly be turned into a probability.
          </p>
        </div>
      </div>
    </section>

    <!-- The ask. Last of the three, so it lands after the reader knows why the sample size is the
         thing holding everything up. -->
    <section class="rounded-xl border border-emerald-200 bg-emerald-50/60 overflow-hidden">
      <button
        type="button"
        class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-emerald-50 transition-colors"
        :aria-expanded="open.help"
        aria-controls="cs-help"
        @click="open.help = !open.help"
      >
        <svg
          class="w-4 h-4 flex-shrink-0 text-emerald-600 transition-transform duration-200"
          :class="{ 'rotate-90': open.help }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        <span class="text-[11px] font-black text-emerald-800 uppercase tracking-widest">Help crack the formula</span>
        <span class="text-[10px] font-bold text-emerald-600/70 normal-case tracking-normal ml-auto">
          run a search, submit the result
        </span>
      </button>

      <div v-show="open.help" id="cs-help" class="px-4 pb-5 pt-1 space-y-3 text-xs text-emerald-900/80 leading-relaxed">
        <p>
          Everything above is a search. There is still no formula for
          <span class="font-bold text-emerald-900">where the best places to prestige are</span>, or why the good
          checkpoints land where they do. We know the sale calendar cuts the range into teeth and that optima sit on
          run-ends. We do not know what decides which run-end wins, how the answer moves as delivery rate or artifact
          loadout changes, or whether the spacing between checkpoints follows any rule. Shift order is in the same
          state: the twelve shifts run in a hand-tuned fixed sequence that nobody has shown to be optimal.
        </p>
        <p>
          What is holding it up is sample size. Three accounts cannot separate a rule from a coincidence, and no one
          person can brute-force past that, since every extra data point costs somebody hours of CPU.
        </p>
        <p class="font-semibold text-emerald-900">
          So if you run a search, submit the result when it finishes. The button is further down this panel.
        </p>
        <p>
          A submission holds the chain, its timings and the settings that produced it, which is enough to go looking for
          the pattern across many accounts. It is opt-in, it leaves out your player ID, and you can download the same
          data as a CSV for yourself. More accounts on the board is the only thing that turns any of this into a rule.
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import ChainMathFigure from './charts/ChainMathFigure.vue';
import { DISTRIBUTION, SAWTOOTH_STATS, SEED_SENSITIVITY } from '@/lib/charts/chainSearchMath';

// Open by default. A collapsed form of this reads as optional, and most people who get here have
// not seen any of it before.
const open = reactive({ how: true, algorithm: true, help: true });

// Read off the data rather than transcribed into the prose, so re-running the sweeps and pasting a
// new SEED_SENSITIVITY cannot leave the sentence claiming the old numbers.
const seed = (() => {
  const { x1, best } = SEED_SENSITIVITY;
  const lo = Math.min(...best);
  const hi = Math.max(...best);
  return {
    bestX1: x1[best.indexOf(lo)],
    bestDays: lo.toFixed(1),
    worstX1: x1[best.indexOf(hi)],
    worstDays: hi.toFixed(1),
    spread: (hi - lo).toFixed(1),
  };
})();

const SPACE_SIZE = [
  { label: '6 checkpoints', count: '1.245 × 10¹²', emphasis: false },
  { label: '7 checkpoints', count: '5.458 × 10¹³', emphasis: false },
  { label: '8 checkpoints', count: '2.088 × 10¹⁵', emphasis: false },
  { label: 'all lengths 3–9', count: '7.29 × 10¹⁶', emphasis: true },
];

const STAGES = [
  {
    name: 'Coarse scan (optional)',
    what: 'a wide grid at step 15 to 25, to pick a starting shape and an ascension count. Deliberately rough.',
  },
  {
    name: 'Resolve last',
    what: 'sweep the final checkpoint one Truth Egg at a time over a window that widens while the winner is pinned to an edge.',
  },
  {
    name: 'Coordinate descent',
    what: 'move one checkpoint at a time, ±8, re-solving the last checkpoint after every accepted move.',
  },
  { name: '2-D slices', what: 'exhaustive 17×17 over every adjacent pair, catching pairs that only pay off jointly.' },
  { name: '3-D slices', what: 'exhaustive 13×13×13 over every adjacent triple.' },
  { name: 'Prestige-count probe', what: 'drop a checkpoint or insert one, then re-polish.' },
];
</script>
