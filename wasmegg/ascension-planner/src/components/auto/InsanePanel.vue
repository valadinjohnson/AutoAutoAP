<!--
  The exhaustive search, unguarded. Reached only by URL (`?insane=1`), never linked.

  WHAT MAKES IT DIFFERENT FROM THE MAIN PANEL. That one runs the staged search: coordinate descent
  with slices, which returns a strong local optimum and says so. This prices EVERY chain over a
  pool you describe, so its winner is the true optimum of that space. It is the only mode in this
  project that can prove anything, and the only reason the README can say "rank 1 of 4913".

  NO EFFORT TIER. Effort tiers are stop points in the staged search's stage list; exhaustive has no
  stages. The knobs here are the ones that actually define the space: which checkpoint values to
  choose from, how finely, and how many ascensions.

  NO SAFETY CAP. The CLI refuses past 5,000 chains without `--yes`, which is right for a flag you
  can typo into a terminal. Here the count and the wall-clock estimate update as you type, on a page
  you had to know the URL for, so a cap would only ever block someone who already knew.

  NO PRUNING TOGGLE, because there is nothing honest to put behind it. Pruning by prefix cost is
  inadmissible -- a prefix that arrives later can arrive with a higher delivery rate and win overall
  -- and when it was implemented and measured it cut 0 of 69 chains. Exhaustive means exhaustive.
-->
<template>
  <div class="section-premium p-4 sm:p-8 max-w-4xl mx-auto mt-6 relative overflow-hidden">
    <div class="absolute -right-20 -top-20 w-64 h-64 bg-rose-500/5 rounded-full blur-3xl"></div>

    <div class="relative z-10 space-y-6">
      <div class="flex items-center gap-4">
        <div
          class="w-12 h-12 bg-rose-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-rose-200"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div>
          <h2 class="text-xl font-black text-slate-900 uppercase tracking-tight">Insane mode</h2>
          <p class="text-[10px] font-black text-rose-400 uppercase tracking-widest mt-0.5">
            Exhaustive search · no caps · URL only
          </p>
        </div>
      </div>

      <div class="p-4 rounded-xl border border-rose-200 bg-rose-50 text-xs text-rose-900 leading-relaxed space-y-2">
        <p>
          This prices <span class="font-bold">every</span> chain over the pool you describe. No descent, no stages, no
          pruning, so the winner is the true optimum of that space rather than a local one. It is also the mode that
          runs away from you fastest: the chain count is combinatorial in the pool size, so halving the step does not
          double the work, it multiplies it.
        </p>
        <p>
          Nothing here is capped and nothing asks you to confirm. The count and the estimate below update as you type;
          they are what you should be reading before you press start.
        </p>
      </div>

      <!-- The space. These numbers are the whole definition of the search. -->
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-5">
        <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">The space to search</h3>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Final target TE</span>
              <HelpTip
                >The TE every chain ends at. It is appended to each chain automatically, so it never appears in the pool
                below and never counts as a pool value.</HelpTip
              >
            </span>
            <input
              v-model.number="store.finalTE"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Your TE now</span>
              <HelpTip
                >Read from your backup, not editable here. It is the floor for every checkpoint in the pool.</HelpTip
              >
            </span>
            <input
              :value="store.currentTE"
              type="number"
              disabled
              class="w-full rounded-lg border-slate-200 bg-slate-50 text-sm font-bold text-slate-500"
            />
          </label>
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Workers</span>
              <HelpTip
                >Background threads this browser will use, one less than your logical core count so the tab stays
                responsive. Chains are dealt out across them; see "How the work is split" below.</HelpTip
              >
            </span>
            <input
              :value="store.workersInPool"
              type="number"
              disabled
              class="w-full rounded-lg border-slate-200 bg-slate-50 text-sm font-bold text-slate-500"
            />
          </label>
        </div>

        <div v-if="spaceMode === 'pool'" class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Checkpoints from</span>
              <HelpTip
                >Lowest TE the search may use as an intermediate checkpoint. Anything at or below your current TE is
                dropped: you cannot ascend to a target you have already passed.</HelpTip
              >
            </span>
            <input
              v-model.number="rangeLo"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">to</span>
              <HelpTip
                >Highest TE the search may use as an intermediate checkpoint. Nothing at or above the final target is
                kept, since that is the target itself.</HelpTip
              >
            </span>
            <input
              v-model.number="rangeHi"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">every N TE (step)</span>
              <HelpTip
                >How finely the range is sampled. Step 15 over 185 to 390 gives 185, 200, 215 and so on: 14 values. Step
                is the single most expensive number on this page, because the chain count is combinatorial in the pool
                size, not linear. Over 185 to 390 at 5 to 7 ascensions: step 25 is 336 chains, step 15 is 6,006, step 10
                is 80,598, step 5 is 6.2 million, and step 1 is about 102 billion. Halving the step does not double the
                work.</HelpTip
              >
            </span>
            <input
              v-model.number="rangeStep"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
        </div>

        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-2 text-[11px] font-black text-slate-600 uppercase tracking-widest">
              <input v-model="spaceMode" type="radio" value="pool" class="text-rose-600 focus:ring-rose-500" />
              One range
            </label>
            <label class="flex items-center gap-2 text-[11px] font-black text-slate-600 uppercase tracking-widest">
              <input v-model="spaceMode" type="radio" value="bands" class="text-rose-600 focus:ring-rose-500" />
              Per-checkpoint bands
            </label>
            <HelpTip>
              One range lets any checkpoint take any pool value, which is what allows 185 200 215 230 490: three 15-TE
              rebuilds in a row. Bands say where each ascension should land, so the shape is decided by you rather than
              by the enumeration. Bands fix the ascension count: N bands is N+1 ascensions.
            </HelpTip>
          </div>

          <label v-if="spaceMode === 'bands'" class="space-y-1 block">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                Bands, one per checkpoint
              </span>
              <HelpTip>
                Semicolon separated, each `lo-hi` with an optional `:step`. `185-200:5; 210-240:10; 250-290:20` means
                the first ascension lands between 185 and 200, the second between 210 and 240, the third between 250 and
                290, then the target. Bands may overlap; chains still have to increase.
              </HelpTip>
            </span>
            <input
              v-model="bandsText"
              type="text"
              :disabled="store.isRunning"
              placeholder="185-200:5; 210-240:10; 250-290:20"
              class="w-full rounded-lg border-slate-300 text-sm font-mono-premium font-bold text-slate-800 disabled:opacity-50"
            />
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <label class="flex items-center gap-1.5 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                Ascensions
                <input
                  v-model.number="suggestAsc"
                  type="number"
                  :min="suggestRange[0]"
                  :max="suggestRange[1]"
                  :disabled="store.isRunning"
                  class="w-16 rounded-md border-slate-300 text-xs font-bold text-slate-800 disabled:opacity-50"
                />
              </label>
              <button
                type="button"
                :disabled="store.isRunning || !suggestion"
                class="px-3 py-1.5 rounded-md bg-slate-800 text-white text-[10px] font-black uppercase tracking-widest hover:bg-slate-700 disabled:opacity-40"
                @click="applySuggestion"
              >
                Suggest from measured runs
              </button>
              <span v-if="suggestion" class="text-[10px] text-slate-500">
                {{ suggestAsc }} ascensions, from {{ suggestion.runs }} runs across {{ suggestion.accounts }} accounts
              </span>
              <span v-else class="text-[10px] text-amber-700"> No suggestion for this target or ascension count. </span>
            </div>

            <span class="block text-[10px] text-slate-400">
              <template v-if="bands.length">
                {{ bands.length }} bands -> {{ bands.length + 1 }} ascensions ·
                {{ bands.map(b => b.length).join(' x ') }} values
              </template>
              <template v-else>Nothing readable yet.</template>
            </span>
          </label>

          <label class="space-y-1 block max-w-xs">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                Minimum gap between checkpoints
              </span>
              <HelpTip>
                Drops chains whose consecutive checkpoints sit closer than this. 0 is off. Measured caution: the best
                7-ascension chain found on this account, 185 200 215 230 290 380 490 at 746.354 d, has 15-TE interior
                gaps, so anything above 15 would have excluded it. Small early gaps are cheap when the ascension is
                short. The leap to the final target is never constrained by this.
              </HelpTip>
            </span>
            <input
              v-model.number="minGap"
              type="number"
              min="0"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>

          <p
            v-if="constrained"
            class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 leading-relaxed"
          >
            You have narrowed the space, so the winner will be the proven optimum
            <span class="font-semibold">of what you described</span>, not of everything reachable. That is still a
            stronger claim than the staged search makes, but it is a smaller one than an unconstrained run.
          </p>
        </div>

        <div v-if="spaceMode === 'pool'" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Fewest ascensions</span>
              <HelpTip
                >Shortest chain to enumerate, counting the final target. 5 ascensions takes four values from the pool
                plus the target. Each ascension is a full rebuild: twelve shifts and a fresh research grind.</HelpTip
              >
            </span>
            <input
              v-model.number="minAsc"
              type="number"
              min="2"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Most ascensions</span>
              <HelpTip
                >Longest chain to enumerate. Every length between fewest and most is enumerated in full, so widening
                this adds whole combinatorial layers rather than a few chains.</HelpTip
              >
            </span>
            <input
              v-model.number="maxAsc"
              type="number"
              min="2"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
        </div>

        <p class="text-[11px] text-slate-500 leading-relaxed">
          Ascension count includes the final target, so 5 ascensions takes four values from the pool. Values at or below
          your current TE, and at or above the target, are dropped: neither is an ascension you can perform.
        </p>
      </div>

      <!-- The number that should decide whether you press the button. -->
      <div
        class="rounded-xl border p-4 space-y-2"
        :class="tooBig ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'"
      >
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
          <div>
            <div class="flex items-center justify-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Pool values</span>
              <HelpTip
                >Checkpoint values left after the range is sampled by step and anything outside (your TE, target) is
                dropped. This is the number the chain count is combinatorial in.</HelpTip
              >
            </div>
            <div class="text-lg font-black text-slate-900 tabular-nums">{{ poolSize }}</div>
          </div>
          <div>
            <div class="flex items-center justify-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Chains</span>
              <HelpTip
                >Every strictly-increasing combination of pool values at each allowed ascension count, with the target
                appended. Computed combinatorially, never by building the list: at small steps the list would not fit in
                memory, and saying so before that happens is the point.</HelpTip
              >
            </div>
            <div class="text-lg font-black tabular-nums" :class="tooBig ? 'text-red-700' : 'text-slate-900'">
              {{ chainCountLabel }}
            </div>
          </div>
          <div>
            <div class="flex items-center justify-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Est. wall clock</span>
              <HelpTip
                >Chains x 15 s / workers. It errs high on purpose: 15 s is the measured floor for a leg with a warm
                prefix memo, and prefix sharing means most chains cost far less than a full simulation.</HelpTip
              >
            </div>
            <div class="text-lg font-black tabular-nums" :class="tooBig ? 'text-red-700' : 'text-slate-900'">
              {{ estimateLabel }}
            </div>
          </div>
          <div>
            <div class="flex items-center justify-center gap-1.5">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Assumed cost</span>
              <HelpTip
                >What the estimate charges per chain. It starts at the 15 s assumption and switches to this machine's
                own measured rate once the first chunk lands, so the estimate beside it stops being a guess.</HelpTip
              >
            </div>
            <div class="text-lg font-black tabular-nums" :class="measuredCost ? 'text-emerald-700' : 'text-slate-900'">
              {{ measuredCost ? measuredCost.toFixed(2) + ' s' : '15 s' }}
            </div>
          </div>
        </div>
        <p class="text-[11px] leading-relaxed" :class="tooBig ? 'text-red-800' : 'text-slate-500'">
          <template v-if="!poolSize">
            The pool is empty once values outside ({{ store.currentTE }}, {{ store.finalTE }}) are dropped.
          </template>
          <template v-else-if="!chainCount">
            No chains: the ascension range asks for more checkpoints than {{ poolSize }} pool values can supply.
          </template>
          <template v-else-if="tooBig">
            This will not finish. The estimate assumes 15 s per chain, which is the measured floor; prefix sharing makes
            the real figure lower, but not by orders of magnitude. Raise the step or narrow the ascension range.
          </template>
          <template v-else>
            The estimate assumes 15 s per chain across {{ store.workersInPool }} workers and ignores prefix sharing, so
            it errs high. Leave the tab open: a closed tab stops the workers.
          </template>
        </p>
      </div>

      <!-- The question everyone asks before committing a machine for an afternoon. -->
      <details class="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <summary
          class="px-4 py-3 cursor-pointer text-[10px] font-black text-slate-600 uppercase tracking-widest hover:bg-slate-50"
        >
          How the work is split
        </summary>
        <div class="px-4 pb-4 space-y-3 text-[11px] text-slate-600 leading-relaxed">
          <p>
            <span class="font-bold text-slate-800">Chains are sorted so relatives sit together.</span> Every chain
            starting <code class="font-mono-premium">195 229</code> is adjacent to every other one, because the
            expensive unit is not a chain, it is a <span class="font-semibold">leg</span>. Two chains sharing their
            first three checkpoints share those three leg simulations exactly.
          </p>
          <p>
            <span class="font-bold text-slate-800"
              >The sorted list is cut into chunks of {{ store.workersInPool * 2 }}</span
            >
            (workers × 2) and handed to the pool one chunk at a time. The pool splits each chunk across workers by
            prefix, so a worker gets a family of related chains rather than a random handful, and its memo pays.
          </p>
          <p>
            <span class="font-bold text-slate-800">Each worker simulates legs and remembers them.</span> A leg is a full
            farm simulation: research purchases, hab and vehicle upgrades, twelve egg switches, sale timing. That is the
            ~15 s. A chain whose prefix the worker has already priced only pays for its new legs, which is why the real
            cost lands well under the estimate.
          </p>
          <p>
            <span class="font-bold text-slate-800">Progress is a heartbeat, not a guess.</span> Each worker posts after
            every chain it finishes, so the bar moves continuously and a worker that has died is distinguishable from
            one that is thinking. The s/chain figure under the bar is measured here, not carried from another machine.
          </p>
          <p>
            <span class="font-bold text-slate-800">Stop is checked between chunks.</span> A chunk in flight finishes
            first, so on a space with long chains "Stopping…" can sit for a minute or two. Nothing is lost: everything
            priced so far stays, and the best of it is your answer.
          </p>
        </div>
      </details>

      <div class="flex flex-wrap gap-3">
        <button
          class="btn-premium btn-primary flex-1 py-4 text-sm shadow-xl shadow-rose-500/20 active:scale-[0.98]"
          :disabled="store.isRunning || !chainCount"
          @click="start"
        >
          {{ store.isRunning ? 'Pricing every chain...' : 'Start exhaustive search' }}
        </button>
        <button
          v-if="store.isRunning"
          class="px-6 py-4 rounded-xl bg-slate-900 text-white text-[11px] font-black uppercase tracking-widest hover:bg-slate-800"
          :disabled="store.stopRequested"
          @click="store.stop()"
        >
          {{ store.stopRequested ? 'Stopping...' : 'Stop & keep best' }}
        </button>
      </div>

      <div v-if="store.stage" class="space-y-1">
        <div class="flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
          <span class="text-slate-500">{{ store.stage }}</span>
          <span class="text-slate-400 tabular-nums">
            {{ pricedSoFar.toLocaleString() }} / {{ store.chainsEstimated.toLocaleString() }}
          </span>
        </div>
        <div class="h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full bg-rose-500 transition-all" :style="{ width: `${Math.round(livePercent)}%` }"></div>
        </div>
        <div v-if="store.secondsPerChain > 0" class="text-[10px] text-slate-400 tabular-nums">
          {{ store.secondsPerChain.toFixed(2) }} s/chain measured here
        </div>
      </div>

      <div
        v-if="store.error"
        class="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 leading-relaxed"
      >
        <span class="font-bold uppercase tracking-wide">Search failed</span> — {{ store.error }}
      </div>

      <div v-if="store.bestDays > 0" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-1">
        <div class="text-[10px] font-black text-emerald-700 uppercase tracking-widest">
          Best chain<template v-if="!store.isRunning && !store.stoppedEarly"> — proven optimum of this space</template>
        </div>
        <div class="font-mono-premium text-lg font-black text-slate-900">{{ store.bestChain.join(' ') }}</div>
        <div class="text-xs text-emerald-800">
          {{ store.bestDays.toFixed(3) }} days &middot; <span class="font-semibold">ends {{ endDate }}</span>
        </div>
        <p class="text-[10px] text-emerald-900/60">
          Compare runs on the finish date. Two runs started hours apart have different plan starts, so their day counts
          are not measuring the same thing; the date they land on is.
        </p>
        <p v-if="store.stoppedEarly" class="text-[11px] text-emerald-900/70 pt-1">
          You stopped it early, so this is the best of what was priced, not the optimum of the space.
        </p>
      </div>

      <!-- Saved runs. Kept in this browser, reloadable at any time. -->
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Saved runs</h3>
          <span class="text-[10px] font-bold text-slate-400">{{ store.savedRuns.length }} / {{ MAX_RUNS }}</span>
        </div>
        <p class="text-[11px] text-slate-500 leading-relaxed">
          Kept in this browser, per player. Separate from the crash-recovery checkpoint, which holds one run and only
          resumes onto identical settings. The oldest is dropped past {{ MAX_RUNS }}.
        </p>

        <div class="flex flex-wrap gap-2">
          <input
            v-model="saveLabel"
            type="text"
            placeholder="Name this run (optional)"
            class="flex-1 min-w-[12rem] rounded-lg border-slate-300 text-sm text-slate-800"
          />
          <button
            type="button"
            :disabled="store.bestDays <= 0 || saving"
            class="px-4 py-2 rounded-lg bg-slate-800 text-white text-[10px] font-black uppercase tracking-widest hover:bg-slate-700 disabled:opacity-40"
            @click="save"
          >
            {{ saving ? 'Saving...' : 'Save this run' }}
          </button>
        </div>

        <p v-if="!store.savedRuns.length" class="text-[11px] text-slate-400">Nothing saved yet.</p>
        <div v-else class="divide-y divide-slate-100">
          <div v-for="run in store.savedRuns" :key="run.id" class="flex flex-wrap items-center gap-3 py-2">
            <div class="flex-1 min-w-[14rem]">
              <div class="text-xs font-bold text-slate-800">{{ run.label }}</div>
              <div class="text-[10px] text-slate-400 font-mono-premium">
                {{ run.bestChain.join(' ') }} · {{ run.bestDays.toFixed(3) }} d · {{ run.chainsPriced }} chains<template
                  v-if="!run.complete"
                >
                  · stopped early</template
                >
              </div>
            </div>
            <button
              type="button"
              class="px-3 py-1.5 rounded-md border border-slate-300 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:border-emerald-300 hover:text-emerald-700"
              @click="open(run.id)"
            >
              Open
            </button>
            <button
              type="button"
              class="px-3 py-1.5 rounded-md border border-slate-300 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:border-red-300 hover:text-red-600"
              @click="remove(run.id)"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      <SearchShapeChart v-if="store.pricedChains.length" :points="store.pricedChains" :best-chain="store.bestChain" />

      <div v-if="store.pricedChains.length" class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="px-4 py-2 rounded-lg bg-slate-800 text-white text-[10px] font-black uppercase tracking-widest hover:bg-slate-700"
          @click="downloadCsv"
        >
          Download CSV
        </button>
        <span class="text-[11px] text-slate-500">
          {{ store.csvRows.toLocaleString() }} chains, one row per leg. Safe to take mid-run.
        </span>
      </div>

      <!-- Submission. Same payload, same opt-in, same disclosure as the main panel. -->
      <div v-if="store.bestDays > 0" class="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 space-y-3">
        <h3 class="text-[10px] font-black text-indigo-800 uppercase tracking-widest">Share this result</h3>
        <p class="text-[11px] text-indigo-900/80 leading-relaxed">
          An exhaustive result is the most useful thing the board can receive: a proven optimum of a stated space rather
          than a search result. A run opened from the library above submits without a run cost, because the time it took
          was not this machine's.
        </p>
        <label class="flex items-start gap-3 text-xs text-indigo-900">
          <input v-model="optIn" type="checkbox" class="mt-0.5 rounded border-indigo-300 text-indigo-600" />
          <span>Yes, contribute this result. Artifact inventory, timezone and local plan start are included.</span>
        </label>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="store.submitUrl"
            type="button"
            :disabled="!optIn || submitting"
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 disabled:opacity-40"
            @click="submit"
          >
            {{ submitting ? 'Sending...' : 'Submit result' }}
          </button>
          <span v-else class="text-[11px] text-indigo-900/70">
            No collector configured in this build (<code class="font-mono-premium">VITE_SUBMIT_URL</code>).
          </span>
        </div>
        <p
          v-if="submitMessage"
          class="text-[11px] font-semibold"
          :class="submitOk ? 'text-emerald-700' : 'text-rose-700'"
        >
          {{ submitMessage }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useChainSearchStore } from '@/stores/chainSearch';
import { useAutoPlannerStore } from '@/stores/autoPlanner';
import {
  buildPool,
  countChains,
  countChainsWithGap,
  countBanded,
  parseBands,
  suggestBands,
  SUGGESTION_TARGET_RANGE,
  SUGGESTABLE_ASCENSIONS,
  estimateHours,
  formatHours,
} from '@/search/exhaustive';
import { MAX_RUNS } from '@/search/runLibrary';
import SearchShapeChart from './charts/SearchShapeChart.vue';
import HelpTip from './HelpTip.vue';
import { downloadFile } from '@/utils/export';

/**
 * `exportCsv()` builds the text and hands it back; it does not save anything. This panel used to
 * call it straight from the click handler, which built the whole CSV and dropped it on the floor.
 */
function downloadCsv(): void {
  downloadFile(store.csvFilename(), store.exportCsv(), 'text/csv;charset=utf-8');
}

const props = defineProps<{ playerId: string }>();
const store = useChainSearchStore();
const autoPlannerStore = useAutoPlannerStore();

/** Past this the estimate is longer than anyone will wait, and the form says so rather than
 *  refusing: the point of this page is that the decision is the operator's. */
const TOO_BIG_HOURS = 24 * 14;

/** `pool` is one range any checkpoint may draw from; `bands` gives each checkpoint its own. */
const spaceMode = ref<'pool' | 'bands'>('pool');
const bandsText = ref('185-200:5; 215-245:10; 260-300:10; 320-360:20');
const minGap = ref(0);

/** Ascension count the suggestion is built for. Bands fix the count, so this picks how many boxes. */
const suggestAsc = ref(6);

/**
 * Bands from the measured corpus, or null when it cannot support one.
 *
 * Deliberately not auto-applied. It narrows the space, and the whole value of this mode is that an
 * unconstrained run proves something; taking that away should be a decision, not a default.
 */
const suggestion = computed(() => suggestBands(store.currentTE, store.finalTE, suggestAsc.value));

function applySuggestion(): void {
  const s = suggestion.value;
  if (!s) return;
  bandsText.value = s.text;
  spaceMode.value = 'bands';
}

const rangeLo = ref(185);
const rangeHi = ref(390);
const rangeStep = ref(15);
const minAsc = ref(5);
const maxAsc = ref(7);

const saveLabel = ref('');
const saving = ref(false);
const optIn = ref(false);
const submitting = ref(false);
const submitMessage = ref('');
const submitOk = ref(false);

const pool = computed(() =>
  buildPool({ lo: rangeLo.value, hi: rangeHi.value, step: rangeStep.value }, store.currentTE, store.finalTE)
);
const poolSize = computed(() =>
  spaceMode.value === 'bands' ? bands.value.reduce((n, b) => n + b.length, 0) : pool.value.length
);

/** Counted combinatorially, never by enumerating: at step 1 over a wide range the array of chains
 *  does not fit in memory, and the whole point of showing this is to say so before that happens. */
const bands = computed(() => (spaceMode.value === 'bands' ? parseBands(bandsText.value) : []));

const chainCount = computed(() => {
  if (spaceMode.value === 'bands') {
    return bands.value.length ? countBanded(bands.value, store.finalTE, store.currentTE, minGap.value) : 0;
  }
  return minGap.value > 0
    ? countChainsWithGap(pool.value, minAsc.value, maxAsc.value, minGap.value)
    : countChains(poolSize.value, minAsc.value, maxAsc.value);
});

/** True when the space has been narrowed, which shrinks what the result proves. */
const constrained = computed(() => spaceMode.value === 'bands' || minGap.value > 0);

const chainCountLabel = computed(() =>
  Number.isFinite(chainCount.value) ? Math.round(chainCount.value).toLocaleString() : '∞'
);

/**
 * Chains finished, counting the chunk in flight.
 *
 * `chainsDone` only advances when a whole chunk resolves, so on its own the counter sits still for
 * as long as a chunk takes and the run looks hung. The pool reports within-batch progress for
 * exactly this reason; the main panel already shows it as a second bar, and here it just folds into
 * the first.
 */
const pricedSoFar = computed(() => store.chainsDone + (store.isRunning ? store.batchDone : 0));

/**
 * The finish INSTANT, not the duration. Durations from different plan starts are not comparable --
 * two runs started an hour apart produce day counts that cannot be ranked against each other -- and
 * the date is what a player actually plans around. The main panel has shown this all along; the
 * exhaustive panel printed days only, which is exactly the comparison people were getting wrong.
 */
const endDate = computed(() => {
  if (!(store.bestDays > 0)) return '—';
  const tz = autoPlannerStore.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date((store.planStart + store.bestDays * 86400) * 1000));
});
const livePercent = computed(() =>
  store.chainsEstimated > 0 ? Math.min(100, (pricedSoFar.value / store.chainsEstimated) * 100) : 0
);

/**
 * The rate this machine is actually managing, once it has managed anything. The 15 s assumption is
 * a floor for a cold leg, and prefix sharing means most chains cost a fraction of that -- on these
 * runs the real figure has landed anywhere from 0.66 to 3.2 s, which is the difference between an
 * estimate that means something and one that is off by a factor of twenty.
 */
/** The ascension counts the measured corpus can actually speak to, not a hardcoded 5-7. */
const suggestRange = computed<[number, number]>(() => [
  Math.min(...SUGGESTABLE_ASCENSIONS),
  Math.max(...SUGGESTABLE_ASCENSIONS),
]);

const measuredCost = computed(() => (store.secondsPerChain > 0 ? store.secondsPerChain : 0));

const hours = computed(() =>
  estimateHours(chainCount.value, store.workersInPool, measuredCost.value || undefined)
);

/**
 * Once a run is going, project from what it has ACTUALLY done: elapsed x remaining / done. That
 * needs no view on how many workers are busy or what a chain "should" cost, and it self-corrects
 * as prefix sharing warms up. The s/chain figure cannot be used for this -- it is wall-clock per
 * chain across the whole pool already, so feeding it to estimateHours divides by the workers a
 * second time and the answer comes out wrong by roughly the worker count.
 */
const tick = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => store.isRunning,
  running => {
    if (ticker) clearInterval(ticker);
    ticker = running ? setInterval(() => (tick.value = Date.now()), 1000) : null;
  }
);
onUnmounted(() => ticker && clearInterval(ticker));

const remainingHours = computed(() => {
  const done = pricedSoFar.value;
  const left = Math.max(0, store.chainsEstimated - done);
  if (!store.runStartedAt || done <= 0) return Infinity;
  const elapsedHours = (tick.value - store.runStartedAt) / 3600000;
  if (!(elapsedHours > 0)) return Infinity;
  return (elapsedHours / done) * left;
});
const estimateLabel = computed(() => {
  if (store.isRunning && Number.isFinite(remainingHours.value)) {
    return formatHours(remainingHours.value) + ' left';
  }
  return chainCount.value ? formatHours(hours.value) : '—';
});
const tooBig = computed(() => chainCount.value > 0 && hours.value > TOO_BIG_HOURS);

// The pool's lower bound is only meaningful above current TE, and current TE arrives with the
// backup rather than at mount. Nudge the default up once rather than leaving a range whose bottom
// half is silently discarded.
watch(
  () => store.currentTE,
  te => {
    if (te > 0 && rangeLo.value <= te) rangeLo.value = te + 5;
  },
  { immediate: true }
);

onMounted(() => {
  void store.refreshSavedRuns(props.playerId);
});

async function start(): Promise<void> {
  await store.startExhaustive(props.playerId, {
    lo: rangeLo.value,
    hi: rangeHi.value,
    step: rangeStep.value,
    minAsc: minAsc.value,
    maxAsc: maxAsc.value,
    minGap: minGap.value,
    ...(spaceMode.value === 'bands' ? { bands: bands.value } : {}),
  });
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    await store.saveCurrentRun(props.playerId, saveLabel.value);
    saveLabel.value = '';
  } finally {
    saving.value = false;
  }
}

async function open(id: string): Promise<void> {
  await store.openSavedRun(props.playerId, id);
}

async function remove(id: string): Promise<void> {
  await store.deleteSavedRun(props.playerId, id);
}

async function submit(): Promise<void> {
  submitting.value = true;
  submitMessage.value = '';
  try {
    const payload = store.buildRunSubmission();
    if (!payload) {
      submitOk.value = false;
      submitMessage.value = 'Nothing to submit yet.';
      return;
    }
    const res = await store.sendSubmission(payload);
    submitOk.value = res.ok;
    submitMessage.value = res.ok ? `Thank you — ${res.message}` : `Not sent: ${res.message}`;
  } finally {
    submitting.value = false;
  }
}
</script>
