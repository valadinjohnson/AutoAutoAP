<template>
  <div class="space-y-4">
    <!-- 1. What the problem is, before any mention of how it is attacked. -->
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
          You reach a Truth Egg target by ascending to a checkpoint, prestiging, ascending to a higher one, and so on. A
          <span class="font-bold text-slate-800">chain</span> is that list of checkpoints —
          <code class="font-mono-premium text-slate-800">195 219 248 286 327 490</code>. You pick the checkpoints; the
          game does the rest. Two chains that both reach the same target can differ by
          <span class="font-bold text-slate-800">twelve days</span> on a plan that runs about seven hundred. The whole
          question is which chain is fastest.
        </p>

        <div>
          <p class="font-bold text-slate-800 mb-2">Why you cannot simply try them all</p>
          <p class="mb-3">
            A checkpoint is a whole number of Truth Eggs, and a chain is a strictly increasing subset of them. Between a
            current 177 and a final 490 there are 313 to choose from:
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
            Scoring one chain means simulating every leg of it — research purchases, hab and vehicle upgrades, twelve
            egg switches, sale timing, all of it. That costs about
            <span class="font-bold text-slate-800">15 seconds</span>. At 7.29 × 10<sup>16</sup> chains, trying them all
            takes roughly <span class="font-bold text-slate-800">3.5 × 10<sup>10</sup> years</span> on one core. Twenty
            cores does not help.
          </p>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">And good chains are rare</p>
          <p class="mb-3">
            Below is every chain in one exhaustive box — all
            {{ DISTRIBUTION.n.toLocaleString() }} chains of the form
            <code class="font-mono-premium text-slate-800">195 X₂ X₃ X₄ 490</code> over a fixed range of each
            checkpoint. Because the whole box was priced, its winner is a
            <span class="font-bold text-slate-800">proven</span> optimum of the box, not a search result.
          </p>
          <ChainMathFigure kind="distribution">
            Best to worst spans {{ (DISTRIBUTION.worst - DISTRIBUTION.best).toFixed(1) }} days, but only
            <span class="font-semibold text-slate-700">{{ DISTRIBUTION.within1 }} chains (0.50%)</span> land within a
            day of the best, and the entire top 100 is packed into
            <span class="font-semibold text-slate-700">{{ DISTRIBUTION.top100Span }} days</span>. Picking checkpoints by
            feel puts you in the fat middle — about a week of real time behind.
          </ChainMathFigure>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Three things that do not work</p>
          <ul class="space-y-2 list-disc list-outside pl-4">
            <li>
              <span class="font-semibold text-slate-700">Guessing a chain's duration without simulating it.</span> A
              feature-based predictor scored Spearman ρ = −0.053 against the truth, with a median error of 15.6 days and
              zero overlap with the true top 100. It is slightly worse than useless, because unmodelled farm state moves
              a single leg by 1–2.6 days while the whole top 100 spans well under two.
            </li>
            <li>
              <span class="font-semibold text-slate-700">Throwing away chains that start slowly.</span> A prefix that
              arrives later can arrive with a higher delivery rate and win overall, so early-leg time is not a safe
              basis for pruning. An implemented branch-and-bound cut 0 of 69 chains on a real run.
            </li>
            <li>
              <span class="font-semibold text-slate-700">Assuming the landscape is well behaved.</span> It is not
              unimodal — see the second figure below — so "keep going until it gets worse" stops early.
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 2. Only now: what the search actually does, and why so little coverage is enough. -->
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
          <p class="font-bold text-slate-800 mb-2">The landscape has structure, and it is the sale calendar</p>
          <p class="mb-3">
            A leg's build phase ends on a Research Sale END — Saturday 09:00 Pacific. So as you move one checkpoint a
            single Truth Egg at a time, the duration does not change smoothly. Push it one higher and you usually still
            make the same Saturday, so the leg gets slightly cheaper. Push it one too far and you miss that sale and
            wait for the next one.
          </p>
          <ChainMathFigure kind="sawtooth">
            Every tooth is one missed sale. Across all {{ SAWTOOTH_STATS.runEndTotal }} fully swept prefixes in the box,
            the best value sat at a <span class="font-semibold text-slate-700">run-end</span> — the last Truth Egg
            before a jump —
            <span class="font-semibold text-slate-700"
              >{{ SAWTOOTH_STATS.runEndHits }} times out of {{ SAWTOOTH_STATS.runEndTotal }}</span
            >. Jumps have a median size of {{ SAWTOOTH_STATS.jumpMedianDays }} days ({{
              SAWTOOTH_STATS.jumpCount
            }}
            measured), and {{ SAWTOOTH_STATS.runLength35Pct }}% of descending runs are 3–5 Truth Eggs long.
          </ChainMathFigure>
          <p class="mt-3">
            That last number is the entire reason this works. The function is piecewise, the pieces are a few Truth Eggs
            wide, so a <span class="font-bold text-slate-800">±8 sweep</span> is wide enough to contain a whole run and
            the boundary that ends it. Replaying the search across 4913 exhaustive grid points put the knee at radius 4
            and exactness at radius 7; the code uses 8, one step of margin.
          </p>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Zoom out, and it is not a bowl</p>
          <ChainMathFigure kind="wide">
            The same sweep across 86 consecutive values. The left side falls in
            <span class="font-semibold text-slate-700">ledges of 10 to 50 days</span> as whole legs reorganise, not as a
            slope; it falls, rises, and falls again, which is what
            <span class="font-semibold text-slate-700">not unimodal</span> means in practice and why a hill-climb that
            stops at the first upturn strands early. The floor is a broad plain around 283–290, and parking the last
            checkpoint near the target instead costs 37.4 days — a tiny final leg pays a full farm rebuild for almost no
            earning time.
          </ChainMathFigure>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">What the search actually runs</p>
          <p class="mb-3">
            Coordinate descent with exhaustive slices, over a simulator we trust. The stages are
            <span class="font-semibold text-slate-700">strictly nested</span>, so a higher effort tier is a later stop
            point rather than a different algorithm — stopping early leaves you exactly what the completed stages
            guarantee.
          </p>
          <ol class="space-y-2 list-decimal list-outside pl-4">
            <li v-for="stage in STAGES" :key="stage.name">
              <span class="font-semibold text-slate-700">{{ stage.name }}</span> — {{ stage.what }}
            </li>
          </ol>
          <p class="mt-3">
            On a 7-ascension chain the Thorough tier prices about 11,062 chains. That is roughly
            <span class="font-bold text-slate-800">one chain in ten trillion</span> of the space, and it lands within
            hours of the best answer found — not because the search is clever, but because the sale calendar already cut
            the landscape into pieces small enough to sweep.
          </p>
        </div>

        <div>
          <p class="font-bold text-slate-800 mb-2">Where it goes wrong: the chain you start from</p>
          <p class="mb-3">
            Coordinate descent cannot cross a ridge wider than its radius, and nothing in the algorithm detects that it
            is stuck on the wrong hill. This is measurable. Below, each column is a different
            <span class="font-semibold text-slate-700">first checkpoint</span>, and its value is the best chain that
            exists anywhere beyond it — every one of the {{ SEED_SENSITIVITY.cells.toLocaleString() }} chains in a
            common box was priced for each, so the columns are directly comparable.
          </p>
          <ChainMathFigure kind="seed">
            Starting at {{ seed.bestX1 }} reaches {{ seed.bestDays }} days; starting at {{ seed.worstX1 }} cannot do
            better than {{ seed.worstDays }}, a
            <span class="font-semibold text-slate-700">{{ seed.spread }}-day</span>
            penalty decided before the search does anything. And the penalty is
            <span class="font-semibold text-slate-700">jagged, not a bowl</span> — 191 is 10 days better than its
            neighbour 192, which is 10 days worse than 194. There is no gradient to follow here.
          </ChainMathFigure>
          <p class="mt-3">
            So a good seed and a bad seed genuinely do end in different places, and the coarse scan that picks one for
            you is the weakest link in the whole pipeline: its own answer measured
            <span class="font-bold text-slate-800">8.6 and 12.0 days</span> off the final result on the two accounts
            tested. When it picks badly, every stage afterwards polishes the wrong hill beautifully. Running twice from
            different starting chains and comparing is currently the only way to notice.
          </p>
          <p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">
            <span class="font-bold">The honest summary.</span> The result is a strong local optimum, never a proven
            global one. Accuracy figures come from three accounts, and only one has a proven optimum to check against.
            There are no confidence percentages anywhere in this project on purpose: three observations cannot honestly
            be turned into a probability.
          </p>
        </div>
      </div>
    </section>

    <!-- 3. The ask. Deliberately last of the three: it only makes sense once someone has read
         why the sample size is the binding constraint. -->
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
          Everything above describes a search, not a formula. Nobody has worked out
          <span class="font-bold text-emerald-900">where the best places to prestige actually are</span>, or why the
          good checkpoints land where they do. We know the sale calendar carves the landscape into teeth and that optima
          sit on run-ends — but not what decides which run-end wins, how the answer moves with delivery rate or artifact
          loadout, or whether the spacing between checkpoints follows a rule at all. The same goes for shift order: the
          twelve shifts run in a fixed sequence that was tuned by hand, and nobody has shown it is optimal.
        </p>
        <p>
          The reason it is still open is sample size. Three accounts is not enough to tell a rule from a coincidence,
          and one person cannot brute-force their way past that — every extra data point costs someone hours of CPU.
        </p>
        <p class="font-semibold text-emerald-900">
          So: run a search, and when it finishes, submit the result with the button further down this panel.
        </p>
        <p>
          A submission is the chain, its timings and the settings that produced it — enough for someone to look for the
          pattern across many accounts. It is opt-in, it does not include your player ID, and you can download the same
          data as a CSV and keep it. The more accounts on the board, the sooner "run a three-hour search" becomes "here
          is the rule".
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import ChainMathFigure from './charts/ChainMathFigure.vue';
import { DISTRIBUTION, SAWTOOTH_STATS, SEED_SENSITIVITY } from '@/lib/charts/chainSearchMath';

// Open by default: someone landing here has not been told any of this yet, and a collapsed
// explanation of a three-hour operation reads as though it were optional.
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
    what: 'a wide grid at step 15–25, to pick a starting shape and an ascension count. Deliberately rough.',
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
