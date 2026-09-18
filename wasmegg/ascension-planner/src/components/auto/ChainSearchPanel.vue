<template>
  <div class="section-premium p-4 sm:p-8 max-w-4xl mx-auto mt-6 relative overflow-hidden">
    <div class="absolute -right-20 -top-20 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl"></div>

    <div class="relative z-10 space-y-8">
      <div class="flex items-center gap-4">
        <div
          class="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-emerald-200"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <div>
          <h2 class="text-xl font-black text-slate-900 uppercase tracking-tight">Chain Search</h2>
          <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
            Beta — searches for a faster set of checkpoints than the one you typed
          </p>
        </div>
      </div>

      <!-- What it is, and what it costs -->
      <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 leading-relaxed space-y-2">
        <p>
          This takes the Target TE chain above as its starting point and tries to improve it, scoring every candidate
          with the same simulator the Auto Planner uses. It runs in
          <span class="font-bold text-slate-800">up to {{ store.workersInPool }} background workers</span> on your own
          machine. One chain costs at least 15 seconds of CPU, so a run takes <span class="font-bold">hours</span>, not
          seconds. Leave the tab open — it can be in the background, but a closed tab stops the workers.
        </p>
        <p>
          It matters because good chains are rare: {{ NEAR_OPTIMAL_SHARE }} on the one account where every chain was
          measured. You are not going to land there by trying a few by hand.
        </p>
      </div>

      <!-- Maths, then algorithm, then controls. This panel asks someone for hours of their own
           CPU, so the reasons to say yes come before the knobs. -->
      <ChainSearchExplainer />

      <!-- Collapsible so a repeat visitor can skip straight to the button. Open by default; a
           collapsed form looks like an empty panel. -->
      <div class="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <button
          type="button"
          class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
          :aria-expanded="settingsOpen"
          aria-controls="cs-settings"
          @click="settingsOpen = !settingsOpen"
        >
          <svg
            class="w-4 h-4 flex-shrink-0 text-slate-400 transition-transform duration-200"
            :class="{ 'rotate-90': settingsOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          <span class="text-[11px] font-black text-slate-700 uppercase tracking-widest">Search settings</span>
          <span class="text-[10px] font-bold text-slate-400 normal-case tracking-normal ml-auto">
            effort, limits, and what it simulates with
          </span>
        </button>

        <div v-show="settingsOpen" id="cs-settings" class="px-4 pb-5 pt-1 space-y-8">
          <!-- Effort -->
          <div class="space-y-3">
            <div class="flex items-center justify-between px-1">
              <span class="flex items-center gap-1.5">
                <label for="effort-range" class="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  Effort
                </label>
                <HelpTip
                  >How many search stages to run. They are strictly nested, so a higher tier is a later stop point, not
                  a different algorithm — stopping one early always leaves you the lower tier's answer at no extra
                  cost.</HelpTip
                >
              </span>
              <span class="text-[10px] font-black text-emerald-600 uppercase tracking-widest">{{ note.label }}</span>
            </div>

            <input
              id="effort-range"
              v-model.number="effortIndex"
              type="range"
              min="0"
              :max="EFFORT_ORDER.length - 1"
              step="1"
              :disabled="store.isRunning"
              class="w-full accent-emerald-600 disabled:opacity-50"
            />
            <div class="flex justify-between px-1">
              <span
                v-for="tier in EFFORT_ORDER"
                :key="tier"
                class="text-[9px] font-black uppercase tracking-widest"
                :class="tier === store.effort ? 'text-emerald-600' : 'text-slate-300'"
              >
                {{ EFFORT_NOTES[tier].label }}
              </span>
            </div>

            <div class="p-4 bg-white border border-slate-200 rounded-xl space-y-2">
              <p class="text-xs text-slate-700 leading-relaxed">{{ note.adds }}</p>
              <p class="text-[11px] text-slate-500 leading-relaxed">
                <span class="font-black uppercase tracking-widest text-slate-400">Measured accuracy</span>
                — {{ note.accuracy }}
              </p>
              <p class="text-[10px] text-slate-400 leading-relaxed">
                Every figure above is hours behind the best answer <em>found</em>, {{ ACCURACY_SAMPLE }}. There is no
                confidence percentage here on purpose: three observations cannot honestly be turned into one.
              </p>
              <p class="text-[11px] text-slate-500">
                <span class="font-black uppercase tracking-widest text-slate-400">Reference time</span>
                — {{ note.cliDuration }} on a 20-core desktop running the command-line version at 12 jobs. Your machine
                has {{ store.workersInPool + 1 }} logical cores, so expect a different number; the live estimate below
                is measured here, not carried over.
              </p>
              <p
                v-if="note.warning"
                class="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5 leading-relaxed"
              >
                {{ note.warning }}
              </p>
            </div>
          </div>

          <!-- Starting point -->
          <label
            class="flex items-start gap-3 p-4 bg-white border border-slate-200 rounded-xl cursor-pointer hover:border-emerald-300"
          >
            <input
              v-model="store.findSeedFirst"
              type="checkbox"
              :disabled="store.isRunning"
              class="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 disabled:opacity-50"
            />
            <span class="text-xs text-slate-600 leading-relaxed">
              <span class="font-bold text-slate-800">Find a starting chain for me</span>
              — scan a coarse grid of checkpoints first and pick the prestige count, instead of starting from the chain
              above. Turn this on if you do not already have a chain you trust. It costs one extra wide batch (<span
                class="font-semibold"
                >372 chains, about 15 minutes on a 20-core desktop</span
              >) and its answer is only a rough shape: measured 12.0 and 8.6 days off the final result on the two
              accounts tested. The stages after it are what close that gap.
            </span>
          </label>

          <!-- Limits. Both of these already governed the search; neither had a control. -->
          <div class="p-4 rounded-xl border border-slate-200 bg-white space-y-3">
            <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Limits</h3>
            <div class="flex flex-wrap items-end gap-5">
              <div>
                <span class="flex items-center gap-1.5">
                  <label
                    for="min-prestiges"
                    class="block text-[9px] font-black text-slate-400 uppercase tracking-widest"
                  >
                    Fewest ascensions
                  </label>
                  <HelpTip
                    >Counted including your final target, so a plan reaching 490 through five checkpoints is 5. Each
                    ascension is a full rebuild.</HelpTip
                  >
                </span>
                <input
                  id="min-prestiges"
                  v-model.number="store.minPrestiges"
                  type="number"
                  min="2"
                  :max="store.maxPrestiges"
                  :disabled="store.isRunning"
                  class="mt-1 w-20 rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
                />
              </div>
              <div>
                <label for="max-prestiges" class="block text-[9px] font-black text-slate-400 uppercase tracking-widest"
                  >Most ascensions</label
                >
                <input
                  id="max-prestiges"
                  v-model.number="store.maxPrestiges"
                  type="number"
                  :min="store.minPrestiges"
                  max="12"
                  :disabled="store.isRunning"
                  class="mt-1 w-20 rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
                />
              </div>
              <div>
                <span class="flex items-center gap-1.5">
                  <label for="pin-count" class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">
                    Lock the first
                  </label>
                  <HelpTip
                    >Hold this many leading checkpoints exactly as typed. Useful once you have committed to them in game
                    — and it is the cheapest speedup here, because moving the first checkpoint forces every later leg to
                    be re-simulated.</HelpTip
                  >
                </span>
                <input
                  id="pin-count"
                  v-model.number="store.pin"
                  type="number"
                  min="0"
                  :max="Math.max(0, store.seedChain.length - 2)"
                  :disabled="store.isRunning"
                  class="mt-1 w-20 rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
                />
              </div>
            </div>
            <p class="text-[11px] text-slate-500 leading-relaxed">
              Ascension count is the chain length including your final target, and it bounds both the coarse scan and
              the prestige-count probe.
              <span v-if="store.pin > 0" class="font-semibold text-slate-700">
                Locking {{ store.pin }} holds {{ store.seedChain.slice(0, store.pin).join(' ') }} fixed — the search
                will not move {{ store.pin === 1 ? 'it' : 'them' }}.
              </span>
              <span v-else>
                Locking checkpoints is worth it when you have already committed to them in game: moving the first
                checkpoint re-simulates every leg after it, so pinning it is usually the cheapest speedup available.
              </span>
            </p>
          </div>

          <!-- Availability. Off by default: it changes the objective, so a plan built with it is not
           comparable to one built without it.

           LOCKED WHILE RUNNING, LOUDLY. Every one of these inputs was already `:disabled` and that
           was not enough: a greyed checkbox reads as "not applicable here" rather than "you cannot
           change this right now", and the run it belongs to lasts hours. Reported from use — the
           search was started with the box unticked and there was nothing on screen to say the
           setting could not simply be corrected. So the whole card turns red and says what to do
           instead. -->
          <div
            class="p-4 rounded-xl border space-y-3"
            :class="store.isRunning ? 'border-rose-200 bg-rose-50/40' : 'border-slate-200 bg-white'"
          >
            <div
              v-if="store.isRunning"
              class="flex items-start gap-2.5 rounded-lg border border-rose-300 bg-rose-50 p-3"
            >
              <span class="text-rose-600 text-base leading-none mt-0.5" aria-hidden="true">&#128683;</span>
              <p class="text-[11px] text-rose-800 leading-relaxed">
                <span class="font-black uppercase tracking-wide">Locked during calculations.</span>
                Your schedule changes which chain is fastest, so it cannot be edited part-way through a run — the chains
                already priced were priced under the old setting. To change it, hit
                <span class="font-bold">Stop and keep best</span> below, adjust, and start again.
                <span class="font-semibold">Nothing is lost: every chain priced so far is checkpointed</span>
                and replays instantly if the setting you change does not affect it.
              </p>
            </div>

            <label class="flex items-start gap-3" :class="store.isRunning ? 'cursor-not-allowed' : 'cursor-pointer'">
              <input
                v-model="store.scheduleEnabled"
                type="checkbox"
                :disabled="store.isRunning"
                class="mt-0.5 rounded focus:ring-emerald-500"
                :class="
                  store.isRunning
                    ? 'border-rose-300 text-rose-400 opacity-60 cursor-not-allowed'
                    : 'border-slate-300 text-emerald-600'
                "
              />
              <span class="text-xs text-slate-600 leading-relaxed">
                <span class="font-bold text-slate-800">Plan around my schedule</span>
                — say when you can actually play, and no plan will ask you to prestige outside it. Each prestige that
                would land while you are away is moved to your next available hour and the delay is
                <span class="font-semibold">charged</span>, which is why this has to be on before the search starts: it
                changes which chain is fastest, not just how the answer is displayed.
              </span>
            </label>

            <div v-if="store.scheduleEnabled" class="space-y-3 pl-8">
              <div class="flex flex-wrap items-end gap-4">
                <div>
                  <label for="avail-from" class="block text-[9px] font-black text-slate-400 uppercase tracking-widest"
                    >Free from</label
                  >
                  <select
                    id="avail-from"
                    v-model.number="store.availableFrom"
                    :disabled="store.isRunning"
                    class="mt-1 rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
                  >
                    <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option>
                  </select>
                </div>
                <div>
                  <label for="avail-to" class="block text-[9px] font-black text-slate-400 uppercase tracking-widest"
                    >Until</label
                  >
                  <select
                    id="avail-to"
                    v-model.number="store.availableTo"
                    :disabled="store.isRunning"
                    class="mt-1 rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
                  >
                    <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option>
                  </select>
                </div>
              </div>

              <div>
                <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Days</span>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="(name, i) in DAY_NAMES"
                    :key="i"
                    type="button"
                    :disabled="store.isRunning"
                    class="px-2.5 py-1 rounded-md border text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                    :class="
                      store.availableDays.includes(i)
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-white border-slate-300 text-slate-400'
                    "
                    @click="toggleDay(i)"
                  >
                    {{ name }}
                  </button>
                </div>
              </div>

              <p class="text-[11px] text-slate-500 leading-relaxed">
                <span class="font-semibold text-slate-700">{{ store.availabilityLabel }}</span
                >. Timezone comes from the Auto Planner's scheduling inputs.
                <span v-if="store.scheduleIsEmpty" class="text-amber-700 font-semibold"
                  >Every day, all hours — that rules nothing out, so the search will run unconstrained.</span
                >
                <span v-else-if="!store.availableDays.length" class="text-amber-700 font-semibold"
                  >No days selected. Pick at least one or nothing can be scheduled.</span
                >
              </p>

              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  v-model="store.deferShifts"
                  type="checkbox"
                  :disabled="store.isRunning"
                  class="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 disabled:opacity-50"
                />
                <span class="text-[11px] text-slate-600 leading-relaxed">
                  <span class="font-bold text-slate-800">Hold the shifts for my hours too</span>
                  — not just the prestige. Each of the twelve switches inside an ascension waits for your next available
                  hour and the delay is charged, so the search looks for a chain whose shifts genuinely land when you
                  are around. Turning this off makes shifts
                  <span class="font-semibold">reported but free</span>, which is what the numbers below mean when it is
                  unticked.
                </span>
              </label>

              <p
                v-if="store.deferShifts"
                class="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed"
              >
                <span class="font-bold uppercase tracking-wide text-slate-500">How exact this is.</span>
                Shifts are pushed on top of the simulated timeline rather than re-simulated, because the simulator
                schedules them itself and teaching it about your hours would change the manual planner too. It errs one
                way only: while you wait, the farm keeps laying the egg you have not switched away from, and that extra
                progress is not credited — so a plan built this way should, if anything, run slightly faster than it
                says.
              </p>

              <p
                v-else
                class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed"
              >
                <span class="font-bold uppercase tracking-wide">What this does not fix.</span>
                Only the prestige between two ascensions is moved. The twelve shifts inside an ascension are scheduled
                by the simulator's own timing and are not moved, so some will still fall outside your hours — open a leg
                below to see exactly which, or tick the box above to have them held too. The prestige delay is charged
                in full while the extra TE you keep earning while away is not credited, so a plan built this way should,
                if anything, run slightly faster than it says. Every accuracy figure above was measured with this off.
              </p>
            </div>
          </div>

          <!-- What the simulator is wearing.
           This was only ever in the CSV header, which meant you had to finish a run and open a
           spreadsheet to find out what the two-year plan assumed you owned. It is a property of
           the RUN, not of a candidate, so it belongs beside the settings that produced it - and
           the "held fixed" caveat below is the honest limit of the whole model. -->
          <div class="p-4 rounded-xl border border-slate-200 bg-white space-y-3">
            <button
              type="button"
              class="w-full flex items-center justify-between gap-3 text-left"
              :aria-expanded="inventoryOpen"
              @click="toggleInventory"
            >
              <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                Artifacts it is simulating with
              </h3>
              <span class="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {{ inventoryOpen ? '&#8964; Hide' : '&#8250; Show' }}
              </span>
            </button>

            <div v-if="inventoryOpen && inventory" class="space-y-4">
              <p class="text-[11px] text-slate-500 leading-relaxed">
                The simulator does not wear a fixed set, and it does not wear what you have equipped. It re-solves the
                best loadout inside <span class="font-semibold">every leg</span> out of your virtue inventory, and swaps
                between these two: the <span class="font-semibold">delivery</span> set while it is building the farm,
                and the <span class="font-semibold">earnings</span> set when it cashes out.
              </p>

              <div class="flex gap-1 bg-slate-200/50 p-1 rounded-xl w-fit">
                <button
                  v-for="tab in ['elr', 'earnings'] as const"
                  :key="tab"
                  type="button"
                  class="px-4 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all"
                  :class="setTab === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
                  @click="setTab = tab"
                >
                  {{ tab === 'elr' ? 'Delivery' : 'Earnings' }}
                </button>
              </div>

              <LoadoutDisplay :loadout="setTab === 'elr' ? inventory.elr : inventory.earnings" />

              <p v-if="setTab === 'elr'" class="text-[11px] text-slate-500 leading-relaxed">
                Solved against your research levels <span class="font-semibold">as they are today</span>, so this is the
                set the first leg runs with. Every later leg re-solves against its own research state and will pick
                something different — there is no single delivery set for the whole plan.
              </p>
              <p v-else class="text-[11px] text-slate-500 leading-relaxed">
                The best earnings set your inventory can build. Unlike the delivery set this does not depend on
                research, so it is the same in every leg.
              </p>

              <!-- The inventory itself, behind a second click.
               It was open by default in the first version and that was a mistake: ten thousand
               artifacts as text chips, most of them T1 commons the solver would never look at
               twice, buried the two sets that actually answer the question. -->
              <div class="border-t border-slate-100 pt-3">
                <button
                  type="button"
                  class="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-emerald-700"
                  :aria-expanded="rawInventoryOpen"
                  @click="rawInventoryOpen = !rawInventoryOpen"
                >
                  {{ rawInventoryOpen ? '&#8964;' : '&#8250;' }} Everything it had to choose from ({{
                    totalArtifacts.toLocaleString()
                  }}
                  artifacts, {{ totalStones.toLocaleString() }} stones)
                </button>

                <div v-if="rawInventoryOpen" class="mt-3 space-y-3">
                  <div v-if="inventory.artifacts.length" class="flex flex-wrap gap-1.5">
                    <span
                      v-for="a in inventory.artifacts"
                      :key="a.label"
                      class="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[10px] font-bold text-slate-700"
                    >
                      <span v-if="a.count > 1" class="text-slate-400">{{ a.count }}&#215; </span>{{ a.label }}
                    </span>
                  </div>
                  <div v-if="inventory.stones.length" class="flex flex-wrap gap-1.5">
                    <span
                      v-for="st in inventory.stones"
                      :key="st.label"
                      class="px-2 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-[10px] font-bold text-indigo-800"
                    >
                      <span v-if="st.count > 1" class="text-indigo-400">{{ st.count }}&#215; </span>{{ st.label }}
                    </span>
                  </div>
                  <p class="text-[11px] text-slate-400 leading-relaxed">
                    Most of these never get worn. They are listed because the solver's job is to pick out of the whole
                    pile, so the pile is the input — but only the two sets above are what any leg actually runs with.
                  </p>
                </div>
              </div>

              <p
                v-if="!inventory.artifacts.length && !inventory.stones.length"
                class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed"
              >
                No virtue artifacts found in this backup. Every leg is being simulated bare, which will make the plan
                look considerably slower than it will actually be.
              </p>

              <p class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
                <span class="font-black uppercase tracking-wide">Held fixed for the whole plan.</span>
                This is what you own <span class="font-semibold">today</span>, and the search assumes it never changes
                across all
                <span class="font-semibold">{{ store.bestDays > 0 ? Math.round(store.bestDays) : '700+' }}</span>
                days. In practice you will craft and upgrade along the way, so the real run should come in
                <span class="font-semibold">faster</span> than every number here — the model errs in the safe direction,
                but it errs. Comparisons BETWEEN chains stay fair, because every candidate is simulated with the same
                inventory; it is the absolute dates that will drift early. Re-run the search with a fresh backup after
                any significant crafting.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- The coarse scan's own log, verbatim, the way the CLI prints it -->
      <div
        v-if="store.coarseLog.length"
        class="p-4 bg-slate-900 rounded-xl font-mono text-[11px] text-slate-300 leading-relaxed overflow-x-auto"
      >
        <div v-for="(line, i) in store.coarseLog" :key="i" class="whitespace-pre">{{ line }}</div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <!-- Editable. This was a read-only readout, so the only way to change the seed was to
             find the Target TE field in a different card - and a two-element seed cannot reach a
             7-prestige answer, because descent only MOVES checkpoints and the probe adds one. -->
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl">
          <span class="flex items-center gap-1.5">
            <label for="chain-search-seed" class="text-[9px] font-black text-slate-400 uppercase tracking-widest">
              Starting chain
            </label>
            <HelpTip
              >Where the search begins. It only MOVES checkpoints and adds at most one, so a seed with too few cannot
              reach a longer answer. Leave the final target off — it is appended for you.</HelpTip
            >
          </span>
          <input
            id="chain-search-seed"
            v-model="store.seedOverride"
            type="text"
            inputmode="numeric"
            :placeholder="store.seedChain.join(' ')"
            :disabled="store.isRunning"
            class="w-full mt-1 bg-transparent text-sm font-black text-slate-800 border-0 border-b border-slate-300 focus:border-indigo-500 focus:ring-0 p-0 disabled:opacity-50"
          />
          <div class="text-[9px] text-slate-400 mt-1">
            {{ store.seedOverride.trim() ? 'using ' + store.seedChain.join(' ') : 'from Target TE above' }}
          </div>
        </div>
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl">
          <div class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Your TE now</div>
          <div class="text-sm font-black text-slate-800 mt-1">{{ store.currentTE }}</div>
        </div>
        <!-- Editable: the search used to be locked to 490. Anything above the last
             checkpoint you typed is valid; the seed is re-derived from it. -->
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl">
          <label for="chain-search-final-te" class="text-[9px] font-black text-slate-400 uppercase tracking-widest"
            >Final target TE</label
          >
          <input
            id="chain-search-final-te"
            v-model.number="store.finalTE"
            type="number"
            :min="store.currentTE + 1"
            :max="2000"
            :disabled="store.isRunning"
            class="w-full mt-1 bg-transparent text-sm font-black text-slate-800 border-0 border-b border-slate-300 focus:border-indigo-500 focus:ring-0 p-0 disabled:opacity-50"
          />
        </div>
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl">
          <div class="text-[9px] font-black text-slate-400 uppercase tracking-widest">
            Chains to price (max)
            <HelpTip
              >An upper bound, not a target. Coordinate descent stops as soon as no checkpoint moves, so a run routinely
              finishes well short of this.</HelpTip
            >
          </div>
          <div class="text-sm font-black text-slate-800 mt-1">~{{ store.estimateForCurrentSettings }}</div>
        </div>
      </div>

      <!-- Resume banner -->
      <div
        v-if="store.resumable && !store.isRunning"
        class="p-4 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 space-y-2"
      >
        <p class="font-bold uppercase tracking-wide text-indigo-700">
          {{ store.resumable.complete ? 'A finished run is saved' : 'An unfinished run is saved' }}
        </p>
        <p class="leading-relaxed">
          {{ store.resumable.durations.length }} chains were already priced ({{
            relativeTime(store.resumable.updatedAt)
          }}), best so far <span class="font-black">{{ store.resumable.bestChain.join(' ') }}</span> at
          {{ (store.resumable.bestSeconds / 86400).toFixed(3) }} days.
          <template v-if="store.resumable.complete"
            >That run reached the end of its tier, so resuming it finds nothing new — but a HIGHER effort tier will
            replay all {{ store.resumable.durations.length }} priced chains for free and carry on from there.</template
          >
          <template v-else>Resuming replays those instantly and carries on — nothing is re-simulated.</template>
        </p>
        <div class="flex gap-2">
          <button class="btn-premium btn-primary px-4 py-1.5 text-[10px]" @click="run(true)">Resume</button>
          <button
            class="px-4 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700"
            @click="store.discardCheckpoint()"
          >
            Discard
          </button>
        </div>
      </div>

      <!-- The Limits box only reaches the coarse scan and the prestige-count probe, so on Quick and
           Balanced a seed of the wrong length is simply the length the answer comes back as. Say so
           here, with the one-click fix, rather than at the end of a three-hour run. -->
      <div
        v-if="store.seedIssue"
        class="p-4 rounded-xl border text-xs leading-relaxed space-y-2"
        :class="
          store.seedIssue.probeCanFix
            ? 'bg-amber-50 border-amber-200 text-amber-900'
            : 'bg-red-50 border-red-200 text-red-900'
        "
      >
        <p
          class="font-bold uppercase tracking-wide"
          :class="store.seedIssue.probeCanFix ? 'text-amber-700' : 'text-red-700'"
        >
          {{
            store.seedIssue.probeCanFix
              ? 'This chain may not match your limits'
              : 'This chain does not match your limits'
          }}
        </p>

        <p v-if="store.seedIssue.kind === 'too-long'">
          The starting chain has <span class="font-semibold">{{ store.seedIssue.ascensions }} ascensions</span> and
          "most ascensions" is set to <span class="font-semibold">{{ store.seedIssue.maxPrestiges }}</span
          >.
        </p>
        <p v-else>
          The starting chain has <span class="font-semibold">{{ store.seedIssue.ascensions }} ascensions</span> and
          "fewest ascensions" is set to <span class="font-semibold">{{ store.seedIssue.minPrestiges }}</span
          >.
        </p>

        <p v-if="store.seedIssue.probeCanFix">
          The prestige-count probe runs on this effort tier and can move the count by one, so it may land inside your
          limits. It is allowed to decline, so this is not a guarantee.
        </p>
        <p v-else>
          The limits only bound the coarse scan and the prestige-count probe, and
          <span class="font-semibold">this effort tier does not run the probe</span>. Every stage works on the chain at
          the length you gave it, so the answer will come back with {{ store.seedIssue.ascensions }} ascensions.
        </p>

        <div class="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            :disabled="store.isRunning"
            class="px-3 py-1.5 rounded-lg bg-white border text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
            :class="
              store.seedIssue.probeCanFix
                ? 'border-amber-300 text-amber-800 hover:border-amber-400'
                : 'border-red-300 text-red-800 hover:border-red-400'
            "
            @click="store.fitSeedToLimitsNow()"
          >
            Fit chain to limits
          </button>
          <span class="text-[11px] self-center opacity-80">
            or change the limits above, or tick "find a starting chain for me".
          </span>
        </div>
      </div>

      <label class="flex items-start gap-3 cursor-pointer">
        <input
          v-model="store.keepAwake"
          type="checkbox"
          class="mt-0.5 rounded border-slate-300 text-indigo-600"
        />
        <span class="text-[11px] text-slate-600 leading-relaxed">
          <span class="font-bold text-slate-800">Keep my PC awake.</span> A run can take hours; if the machine
          sleeps, every worker freezes until you wake it back up. Turn this off if you'd rather manage sleep
          yourself.
        </span>
      </label>

      <!-- Run / stop -->
      <div class="flex gap-3">
        <button
          class="btn-premium btn-primary flex-1 py-4 text-sm shadow-xl shadow-emerald-500/20 active:scale-[0.98]"
          :disabled="store.isRunning || (!store.findSeedFirst && store.seedChain.length < 2)"
          @click="run(false)"
        >
          {{ store.isRunning ? 'Searching...' : 'Start search' }}
        </button>
        <button
          v-if="store.isRunning"
          class="px-6 py-4 rounded-xl bg-slate-900 text-white text-[11px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all active:scale-[0.98] disabled:opacity-50"
          :disabled="store.stopRequested"
          @click="store.stop()"
        >
          {{ store.stopRequested ? 'Stopping...' : 'Stop & keep best' }}
        </button>
      </div>

      <!-- Live progress -->
      <div v-if="store.isRunning || store.bestDays > 0" class="space-y-4">
        <div>
          <div class="flex items-center justify-between text-[10px] font-black uppercase tracking-widest mb-1.5">
            <span class="text-slate-500">{{ store.stage }}</span>
            <span class="text-slate-400">
              {{ store.chainsDone }} / ~{{ store.chainsEstimated }} chains<template v-if="store.chainsReplayed"
                >, {{ store.chainsReplayed }} replayed</template
              >
            </span>
          </div>
          <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              class="h-full bg-emerald-500 rounded-full transition-all duration-500"
              :style="{ width: `${Math.round(store.progressFraction * 100)}%` }"
            ></div>
          </div>
          <!-- Movement WITHIN the current batch. `chainsDone` only advances when a whole batch
               returns, and stage 6's widest sweep is one ~2200-chain request — so this line is the
               difference between "thinking" and "dead", which a run once got wrong for 8.5 hours. -->
          <div
            v-if="store.isRunning && store.batchTotal > 1"
            class="flex items-center justify-between text-[10px] text-slate-400 font-bold mt-1.5"
          >
            <span>this batch: {{ store.batchDone }} / {{ store.batchTotal }} chains</span>
            <span class="text-slate-300">updates as each chain finishes</span>
          </div>
          <!-- The count stopping short of the estimate is normal and confusing, so say so. -->
          <p
            v-if="store.finishedCleanly && store.chainsDone < store.chainsEstimated * 0.9"
            class="text-[10px] text-emerald-700 font-bold mt-1.5"
          >
            Finished early — the estimate is an upper bound, and descent stops as soon as no checkpoint moves. Starting
            from an already-good chain is exactly when that happens.
          </p>
          <div class="flex items-center justify-between text-[10px] text-slate-400 font-bold mt-1.5">
            <span>{{ store.detail }}</span>
            <span v-if="store.secondsPerChain > 0">
              <template v-if="store.isRunning"
                >~{{ formatDuration(store.secondsRemaining) }} left ({{ store.secondsPerChain.toFixed(1) }} s/chain
                here)</template
              >
            </span>
            <span v-else>timing the first batch...</span>
          </div>
        </div>

        <!-- Best so far. This is the point of the whole panel: it is always usable. -->
        <div class="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2">
          <div class="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <div class="text-[9px] font-black text-emerald-700 uppercase tracking-widest">Best chain so far</div>
              <div class="text-lg font-black text-slate-900 mt-0.5">{{ store.bestChain.join(' ') }}</div>
            </div>
            <div class="text-right">
              <div class="text-[9px] font-black text-emerald-700 uppercase tracking-widest">Plan length</div>
              <!-- bestDays starts at 0 and is only real once a batch has reported. Rendering
                   "0.000 d" in that window looks like a broken result rather than a pending one. -->
              <div class="text-lg font-black text-slate-900 mt-0.5">
                {{ store.bestDays > 0 ? store.bestDays.toFixed(3) + ' d' : 'pricing…' }}
              </div>
              <div class="text-[10px] font-bold text-slate-500">ends {{ endDate }}</div>
            </div>
          </div>
          <p class="text-[11px] text-emerald-800 leading-relaxed">
            The stages are nested — each one starts from the answer the previous one produced — so stopping now is safe.
            You keep this chain, and it is exactly what the stages that already finished ({{
              store.lastCompletedStage
            }}) guarantee.
          </p>
        </div>

        <!-- Per-leg breakdown of the current best. Each row expands to the twelve shift
             instants, because "4 night shifts" tells you there is a problem and not when. -->
        <div v-if="store.bestLegs.length" class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-[9px] font-black text-slate-400 uppercase tracking-widest text-left">
                <th class="py-2 pr-3">Leg</th>
                <th class="py-2 pr-3">
                  → TE
                  <HelpTip
                    >The total Truth Eggs you will have when this ascension ends. That is the checkpoint you prestige
                    on.</HelpTip
                  >
                </th>
                <th class="py-2 pr-3">
                  Start
                  <HelpTip>When this ascension begins, in your plan's timezone.</HelpTip>
                </th>
                <th class="py-2 pr-3">
                  Finish
                  <HelpTip>When its target TE is reached — the moment you prestige into the next ascension.</HelpTip>
                </th>
                <th class="py-2 pr-3">
                  Strategy
                  <HelpTip
                    ><span class="font-mono">2-sale-tier13</span> means: spend two weekly Research Sales building before
                    you start earning, and unlock Tier 13 research on the way.
                    <span class="font-mono">continue</span> means carry on the ascension you are already in rather than
                    prestiging now.</HelpTip
                  >
                </th>
                <th class="py-2 pr-3">Days</th>
                <th class="py-2 pr-3">
                  Peak delivery
                  <HelpTip
                    >The highest egg delivery rate this ascension reaches, after the K3 research purchases. It is what
                    caps how fast the last stretch of the leg earns.</HelpTip
                  >
                </th>
                <!-- "Night shifts" lived here and has moved into the expander, next to the
                     individual shifts it counts. A bare number said there was a problem and never
                     which shift, which is the only part you can act on. -->
                <th v-if="store.scheduleEnabled" class="py-2 pr-3 whitespace-nowrap">
                  Waiting for you
                  <HelpTip
                    >Two costs, both charged to the plan and both already inside the days column. <b>P</b> is the
                    prestige at the end of this leg waiting for you to be available. <b>S</b> is the twelve shifts
                    inside it being held for the same reason. Between them they are the whole difference your schedule
                    makes, which is why turning it on changes which chain wins.</HelpTip
                  >
                </th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(leg, i) in store.bestLegs" :key="i">
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 pr-3 font-black text-slate-700 whitespace-nowrap">
                    <button
                      v-if="leg.shifts?.length"
                      type="button"
                      class="mr-1 text-slate-400 hover:text-emerald-700"
                      :aria-expanded="expandedLeg === i"
                      :aria-label="`Show A${i + 1}'s shifts`"
                      @click="expandedLeg = expandedLeg === i ? -1 : i"
                    >
                      {{ expandedLeg === i ? '⌄' : '›' }}
                    </button>
                    A{{ i + 1 }}
                  </td>
                  <td class="py-1.5 pr-3 font-bold text-slate-600">{{ leg.endTE }}</td>
                  <td class="py-1.5 pr-3 text-slate-500 whitespace-nowrap">
                    {{ leg.startTime ? stamp(leg.startTime) : '—' }}
                  </td>
                  <td class="py-1.5 pr-3 text-slate-500 whitespace-nowrap">{{ stamp(leg.endTime) }}</td>
                  <td class="py-1.5 pr-3 text-slate-500">{{ leg.key }}</td>
                  <td class="py-1.5 pr-3 text-slate-500">{{ (leg.durationSeconds / 86400).toFixed(2) }}</td>
                  <td class="py-1.5 pr-3 text-slate-500">{{ ((leg.maxELR * 3600) / 1e15).toFixed(3) }} q/hr</td>
                  <td v-if="store.scheduleEnabled" class="py-1.5 pr-3 whitespace-nowrap">
                    <span v-if="!leg.sleepDelaySeconds && !leg.shiftDelaySeconds" class="text-slate-400">&mdash;</span>
                    <template v-else>
                      <span v-if="leg.sleepDelaySeconds" class="text-slate-500">
                        <span class="text-slate-400 font-black">P</span>
                        {{ (leg.sleepDelaySeconds / 3600).toFixed(1) }} h
                      </span>
                      <span v-if="leg.shiftDelaySeconds" class="text-amber-700 font-semibold ml-1.5">
                        <span class="text-amber-500 font-black">S</span>
                        {{ (leg.shiftDelaySeconds / 3600).toFixed(1) }} h
                      </span>
                    </template>
                  </td>
                  <td class="py-1.5 text-right">
                    <button
                      v-if="leg.shifts?.length"
                      type="button"
                      class="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-emerald-700 whitespace-nowrap"
                      :aria-expanded="expandedLeg === i"
                      @click="expandedLeg = expandedLeg === i ? -1 : i"
                    >
                      {{ eggBlocks(leg).length }} eggs<template v-if="store.scheduleEnabled && leg.nightShifts"
                        ><span class="text-amber-600"> · {{ leg.nightShifts }} out</span></template
                      >
                    </button>
                  </td>
                </tr>
                <tr v-if="expandedLeg === i && leg.shifts?.length" class="bg-slate-50">
                  <td :colspan="store.scheduleEnabled ? 9 : 7" class="px-3 py-3">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                      A{{ i + 1 }} — {{ eggBlocks(leg).length }} eggs, {{ leg.shifts.length }} switches
                      <span v-if="store.scheduleEnabled" class="text-amber-600">· amber falls outside your hours</span>
                    </p>
                    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                      <div
                        v-for="(b, k) in eggBlocks(leg)"
                        :key="k"
                        class="flex items-baseline justify-between gap-2 px-2 py-1 rounded-md border text-[11px]"
                        :class="
                          b.isSwitch && outsideSchedule(b.at)
                            ? 'border-amber-300 bg-amber-50 text-amber-800'
                            : b.isSwitch
                              ? 'border-slate-200 bg-white text-slate-600'
                              : 'border-emerald-200 bg-emerald-50/60 text-emerald-800'
                        "
                      >
                        <span class="font-bold capitalize">
                          {{ b.egg || 'shift' }}
                          <span v-if="!b.isSwitch" class="font-normal normal-case text-emerald-600">(start)</span>
                        </span>
                        <span class="font-mono">{{ stamp(b.at) }}</span>
                        <span class="tabular-nums" :class="b.isSwitch ? 'text-slate-400' : 'text-emerald-500'">
                          {{ b.length }}
                        </span>
                      </div>
                    </div>
                    <p class="text-[11px] text-slate-500 mt-2 leading-relaxed">
                      One row per egg, with when you start laying it and how long you stay. The
                      <span class="font-semibold text-emerald-700">first row is where the ascension begins</span> — no
                      action needed, you are already on it. Every row after it is one manual switch, which is why twelve
                      eggs means eleven switches. This matches the Auto Planner's own C1 / I1 / K1 list.
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <!-- Apply. Until this existed the only route from a three-hour search to an actual plan
             was reading the chain off the screen and retyping it in a different card. -->
        <div class="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            :disabled="!store.bestChain.length"
            class="px-4 py-2 rounded-lg bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-emerald-500 disabled:opacity-40"
            @click="use(store.bestChain, true)"
          >
            Use this chain and build the plan
          </button>
          <button
            type="button"
            :disabled="!store.bestChain.length"
            class="px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-[10px] font-black uppercase tracking-widest hover:border-emerald-400 disabled:opacity-40"
            @click="use(store.bestChain)"
          >
            Just fill it in
          </button>
          <span v-if="applied" class="text-[11px] font-semibold text-emerald-700">
            Sent {{ applied }} to the Auto Planner{{ generated ? ' and started building the plan.' : "'s Target TE." }}
          </span>
        </div>
      </div>

      <!-- The generated plan does NOT know about the schedule. Said here rather than buried,
           because the two numbers WILL disagree and the search's is the realistic one. -->
      <div
        v-if="applied && store.scheduleEnabled && store.availability"
        class="p-4 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 leading-relaxed space-y-1.5"
      >
        <p class="font-bold uppercase tracking-wide text-amber-700">
          The built plan will show slightly earlier dates than this search
        </p>
        <p>
          The Auto Planner does not know about your available hours — only this search does. It will lay the plan out
          assuming you prestige the instant each target is hit, so its dates omit the
          <span class="font-semibold">{{ totalPrestigeWait }}</span> of waiting the search charged. The checkpoints are
          the same and the strategies are the same; only the clock differs, and
          <span class="font-semibold">this panel's finish date is the realistic one</span>.
        </p>
      </div>

      <!-- Runners-up. Picked for SPREAD, not the raw top N: a descent sweep leaves the same plan
           nudged by one TE all over the cache, and ten of those is a useless menu. -->
      <div v-if="store.pricedChains.length > 1" class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">
            Other options worth considering
          </h3>
          <button
            v-if="!store.isRunning"
            type="button"
            class="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600"
            @click="store.rebuildShortlist()"
          >
            Refresh
          </button>
        </div>

        <p class="text-[11px] text-slate-500 leading-relaxed">
          Fastest is not always best. Every prestige is a full rebuild — twelve shifts and a fresh research grind — so
          half a day slower for one fewer ascension may well be the trade you want. Pick on the
          <span class="font-semibold">finish date</span>, not the day count: durations from different plan starts are
          not comparable.
        </p>

        <!-- Preset views over the SAME priced chains. Nothing here re-simulates; every one of
             these reads the cache the run already built, so switching is instant. -->
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="v in VIEWS"
            :key="v.id"
            type="button"
            class="px-2.5 py-1 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-colors"
            :class="
              store.shortlistView === v.id
                ? 'bg-slate-800 border-slate-800 text-white'
                : 'bg-white border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700'
            "
            @click="store.setShortlistView(v.id)"
          >
            {{ v.label }}
          </button>
        </div>

        <p class="text-[11px] text-slate-500 leading-relaxed">{{ activeView?.hint }}</p>

        <!-- A single-axis sweep prices dozens of chains that are all the same plan nudged by a few
             TE, so "A good mix" can legitimately have nothing to add beyond the leader. The whole
             section used to vanish in that case, which reads as a bug rather than as an answer. -->
        <p
          v-if="store.shortlist.length <= 1"
          class="text-[11px] text-slate-500 leading-relaxed rounded-lg border border-slate-200 bg-slate-50 p-3"
        >
          Nothing else here is a genuinely different plan: every other chain this run priced is the same shape moved by
          a few TE, or more than five days behind. That is normal for a run that only swept one checkpoint, and for one
          stopped early. Switch to <span class="font-semibold">Fastest</span> to see all
          {{ store.pricedChains.length }} of them in raw order.
        </p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-[9px] font-black text-slate-400 uppercase tracking-widest text-left">
                <th class="py-2 pr-3">Chain</th>
                <th class="py-2 pr-3">Ascensions</th>
                <th class="py-2 pr-3">Finishes</th>
                <th class="py-2 pr-3">Behind</th>
                <th v-if="store.scheduleEnabled" class="py-2 pr-3 whitespace-nowrap">
                  {{ store.deferShifts ? 'Cost of your hours' : 'Night shifts' }}
                  <HelpTip v-if="store.deferShifts">
                    How much of this option's length is waiting for you: prestiges plus the twelve shifts per ascension,
                    all held until you are available. It is the part of the finish date your schedule is responsible
                    for, and it is the number that actually differs between these options — the night-shift count
                    cannot, because holding them drives it to zero for every row.
                  </HelpTip>
                  <HelpTip v-else>
                    Shifts landing outside your hours. You are not holding them, so they are reported and free — this is
                    the count you would have to get up for.
                  </HelpTip>
                </th>
                <th class="py-2 pr-3">Why</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in store.shortlist" :key="row.chain.join(',')">
                <tr class="border-t border-slate-100">
                  <!-- The caret sits with the chain it opens, not off at the far right past six
                       other columns. Same move as the leg table's A1 caret, for the same reason. -->
                  <td class="py-2 pr-3 font-mono font-bold text-slate-700 whitespace-nowrap">
                    <button
                      v-if="row.legs.length"
                      type="button"
                      class="mr-1.5 text-slate-400 hover:text-emerald-700"
                      :aria-expanded="expandedRow === row.chain.join(',')"
                      :aria-label="`Show when ${row.chain.join(' ')} happens`"
                      @click="expandedRow = expandedRow === row.chain.join(',') ? '' : row.chain.join(',')"
                    >
                      {{ expandedRow === row.chain.join(',') ? '⌄' : '›' }}
                    </button>
                    {{ row.chain.join(' ') }}
                  </td>
                  <td class="py-2 pr-3 font-bold text-slate-600">{{ row.prestiges }}</td>
                  <td class="py-2 pr-3 text-slate-600 whitespace-nowrap">{{ finishInstant(row.seconds) }}</td>
                  <td class="py-2 pr-3 text-slate-500 whitespace-nowrap">
                    {{ row.gapSeconds < 1 ? '—' : '+' + (row.gapSeconds / 86400).toFixed(2) + ' d' }}
                  </td>
                  <!-- null, not 0: a replayed chain has no legs to count, and "0" would be a claim. -->
                  <td v-if="store.scheduleEnabled" class="py-2 pr-3 whitespace-nowrap">
                    <template v-if="store.deferShifts">
                      <span v-if="scheduleCost(row) === null" class="text-slate-400">not recorded</span>
                      <span v-else-if="scheduleCost(row)! < 3600" class="text-slate-400">&mdash;</span>
                      <span v-else class="font-bold text-amber-700">
                        +{{ (scheduleCost(row)! / 86400).toFixed(2) }} d
                      </span>
                    </template>
                    <template v-else>
                      <span v-if="row.nightShifts === null" class="text-slate-400">not recorded</span>
                      <span v-else-if="!row.nightShifts" class="text-slate-400">none</span>
                      <span v-else class="font-bold text-amber-700">{{ row.nightShifts }} outside</span>
                    </template>
                  </td>
                  <td class="py-2 pr-3 text-slate-400">{{ REASON_TEXT[row.reason] }}</td>
                  <td class="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-md border border-slate-300 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:border-emerald-400 hover:text-emerald-700"
                      @click="use(row.chain, true)"
                    >
                      Use
                    </button>
                  </td>
                </tr>
                <tr v-if="expandedRow === row.chain.join(',') && row.legs.length" class="bg-slate-50">
                  <td :colspan="store.scheduleEnabled ? 7 : 6" class="px-3 py-3 space-y-2">
                    <div v-for="(leg, li) in row.legs" :key="li" class="text-[11px]">
                      <div class="flex flex-wrap items-baseline gap-x-2 text-slate-600">
                        <span class="font-black text-slate-700">A{{ li + 1 }}</span>
                        <span class="font-bold">&rarr; {{ leg.endTE }}</span>
                        <span class="text-slate-400">{{ leg.key }}</span>
                        <span v-if="leg.startTime" class="font-mono text-slate-500">
                          {{ stamp(leg.startTime) }} &rarr; {{ stamp(leg.endTime) }}
                        </span>
                      </div>
                      <div v-if="leg.shifts?.length" class="flex flex-wrap gap-1 mt-1 ml-4">
                        <span
                          v-for="(b, k) in eggBlocks(leg)"
                          :key="k"
                          class="px-1.5 py-0.5 rounded border text-[10px]"
                          :class="
                            b.isSwitch && outsideSchedule(b.at)
                              ? 'border-amber-300 bg-amber-50 text-amber-800 font-bold'
                              : b.isSwitch
                                ? 'border-slate-200 bg-white text-slate-500'
                                : 'border-emerald-200 bg-emerald-50/60 text-emerald-700'
                          "
                        >
                          <span class="capitalize">{{ b.egg || 'shift' }}</span>
                          <span class="font-mono"> {{ stamp(b.at) }}</span>
                          <span v-if="!b.isSwitch"> start</span>
                        </span>
                      </div>
                    </div>
                    <p class="text-[10px] text-slate-400 leading-relaxed pt-1">
                      One entry per egg. The first is where the ascension starts &mdash; you are already on it &mdash;
                      and each one after it is a manual switch.
                      <template v-if="store.scheduleEnabled && store.deferShifts">
                        These have already been moved into your hours, which is what this option's
                        <span class="font-semibold">cost</span> above paid for &mdash; so none are amber. Untick "hold
                        the shifts" and re-run to see where they would fall unassisted.
                      </template>
                      <template v-else-if="store.scheduleEnabled">
                        <span class="font-semibold text-amber-700">Amber ones fall outside your hours</span>
                        &mdash; you would have to be up for them. Compare the amber between options.
                      </template>
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <p class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
          Every view above reads the <span class="font-semibold">{{ store.csvRows.toLocaleString() }}</span>
          chains this run priced — switching costs nothing and re-simulates nothing. A chain missing from all of them
          was almost certainly never evaluated rather than evaluated and beaten: the search stays in its own
          neighbourhood. Download the CSV for the full list.
        </p>
      </div>

      <!-- A plan start that slides is the quietest way to lose a checkpoint, and it cost a real
           user a 778-chain run: after a rebuild the start moved 10:39 -> 17:44, the fingerprint
           changed, and the saved run simply stopped being offered. -->
      <div
        v-if="store.planStartIsNow"
        class="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 leading-relaxed space-y-1.5"
      >
        <p class="font-bold uppercase tracking-wide text-amber-700">No plan start is set</p>
        <p>
          The Auto Planner has no start date and time, so this plan is timed from
          <span class="font-semibold">right now</span> — and "now" moves every time you reload.
        </p>
        <p>
          That has two consequences worth knowing before a long run.
          <span class="font-semibold">Saved runs stop matching:</span> the plan start is part of what identifies a run,
          so after a reload the search will not offer to resume and re-prices everything.
          <span class="font-semibold">Day counts stop being comparable:</span> the same chain reports a smaller number
          simply because the stopwatch started later — compare <span class="font-semibold">finish dates</span>, which do
          not move. Set a start date and time in the scheduling inputs above to pin it.
        </p>
      </div>

      <!-- The browser froze the tab. Not a failure of the search, and the single biggest reason an
           unattended run comes back with nothing done — so it gets the fix, not just the fact. -->
      <div
        v-if="store.suspendedSeconds > 60"
        class="p-4 bg-sky-50 border border-sky-200 rounded-xl text-xs text-sky-900 leading-relaxed space-y-1.5"
      >
        <p class="font-bold uppercase tracking-wide text-sky-700">
          Your browser suspended this tab for {{ formatDuration(store.suspendedSeconds) }}
        </p>
        <p>
          Nothing ran during that time — a frozen tab freezes its background workers too, so the search was paused
          rather than working. It has been resumed and no progress was lost.
        </p>
        <p>
          To stop it happening on a long run: in Edge, open
          <span class="font-mono">edge://settings/system</span>, and either turn off
          <span class="font-semibold">"Save resources with sleeping tabs"</span> or add
          <span class="font-mono">{{ host }}</span> to
          <span class="font-semibold">"Never put these sites to sleep"</span>. Keeping the tab in a visible window also
          works. For a genuinely unattended overnight run the command-line version has no such problem.
        </p>
      </div>

      <!-- A failure is not necessarily a total loss: anything already priced is on the checkpoint
           and a rerun replays it for free. Saying so is the difference between "start again" and
           "press Start search again and keep your three hours". -->
      <div
        v-if="store.error"
        class="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 leading-relaxed space-y-1.5"
      >
        <p><span class="font-bold uppercase tracking-wide">Search failed</span> — {{ store.error }}</p>
        <p v-if="store.chainsDone > 0" class="text-red-700">
          {{ store.chainsDone }} chains were priced before it stopped and are saved. Starting the search again replays
          them without re-simulating anything, so you are resuming rather than restarting.
        </p>
        <p v-else class="text-red-700">
          Nothing was priced, so there is nothing to resume. If this repeats, lower the effort tier to see whether a
          shorter run gets through, and check the browser console for the worker's own error.
        </p>
      </div>

      <!-- Verbose view: every stage and every accepted move, in order. The panel shows only the
           newest line while running; this is the running commentary. The CSV below it is the
           per-candidate record, which this log cannot be — a log line is one accepted move, not
           one chain. Kept OUTSIDE the amber honesty block below: it was nested inside it, which
           rendered a black terminal panel in the middle of a warning box. -->
      <details v-if="store.runLog.length" class="rounded-xl border border-slate-200 bg-white">
        <summary class="cursor-pointer px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">
          Show what it tried ({{ store.runLog.length }} lines)
        </summary>
        <div class="max-h-80 overflow-y-auto border-t border-slate-100 bg-slate-900 px-4 py-3">
          <div
            v-for="(line, i) in store.runLog"
            :key="i"
            class="whitespace-pre font-mono text-[11px] leading-relaxed"
            :class="line.startsWith('--- ') ? 'text-emerald-400 font-bold mt-2' : 'text-slate-300'"
          >
            {{ line }}
          </div>
        </div>
      </details>

      <!-- Share the result.
           Sending a player's data somewhere else is the one genuinely irreversible thing this
           panel can do, so it is built to be refused easily: nothing happens without a click,
           the exact payload is inspectable BEFORE the click, and with no collector configured
           the only option is a file the player hands over themselves. -->
      <div
        v-if="store.bestDays > 0 && !store.isRunning"
        class="p-4 rounded-xl border border-indigo-200 bg-indigo-50/40 space-y-3"
      >
        <h3 class="text-[10px] font-black text-indigo-700 uppercase tracking-widest">Share this result</h3>

        <p class="text-[11px] text-indigo-900/80 leading-relaxed">
          <span class="font-bold">Contribute to the virtue track and the leaderboards.</span>
          Pooling results across accounts is the only way to answer questions one account cannot: whether the effort
          tiers behave the same everywhere, whether
          <span class="font-mono">maxLast</span> is right, whether a chain shape that wins here wins anywhere else.
        </p>

        <!-- OPT IN, UNCHECKED. Nothing leaves the machine until this is deliberately ticked;
             the submit and save buttons stay disabled until it is. Defaulting this on would make
             the consent text below decorative. -->
        <label class="flex items-start gap-3 cursor-pointer">
          <input
            v-model="optIn"
            type="checkbox"
            class="mt-0.5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span class="text-[11px] text-indigo-900 leading-relaxed">
            <span class="font-bold">Yes, contribute this result.</span>
            I have read what is included below.
          </span>
        </label>

        <div v-if="optIn" class="space-y-3">
          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-2 cursor-pointer text-[11px] font-bold text-indigo-900">
              <input v-model="anonymous" type="radio" :value="true" class="text-indigo-600 focus:ring-indigo-500" />
              Submit anonymously
            </label>
            <label class="flex items-center gap-2 cursor-pointer text-[11px] font-bold text-indigo-900">
              <input v-model="anonymous" type="radio" :value="false" class="text-indigo-600 focus:ring-indigo-500" />
              Credit me as
            </label>
            <input
              v-model="nickname"
              type="text"
              maxlength="40"
              :disabled="anonymous"
              placeholder="nickname"
              aria-label="Nickname"
              class="rounded-lg border-indigo-200 text-sm font-bold text-slate-800 w-48 disabled:opacity-40"
              @input="nicknameTouched = true"
            />
          </div>

          <label class="flex items-start gap-3 cursor-pointer">
            <input
              v-model="includeCsv"
              type="checkbox"
              class="mt-0.5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span class="text-[11px] text-indigo-900/80 leading-relaxed">
              <span class="font-bold">Include the full CSV</span> — every chain this run priced, one row per leg ({{
                (store.csvRows || 0).toLocaleString()
              }}
              chains). The JSON above is the headline; this is the working. It is compressed before it leaves your
              machine, which takes a large run from about fifteen megabytes to well under one.
            </span>
          </label>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <button
            type="button"
            class="px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 text-[10px] font-black uppercase tracking-widest hover:bg-white"
            :aria-expanded="showPayload"
            @click="showPayload = !showPayload"
          >
            {{ showPayload ? '&#8964; Hide' : '&#8250; Show' }} exactly what is sent
          </button>

          <button
            v-if="store.submitUrl"
            type="button"
            :disabled="!optIn || submitState === 'sending'"
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 disabled:opacity-40"
            @click="submit"
          >
            {{ submitState === 'sending' ? 'Sending...' : 'Submit result' }}
          </button>

          <button
            type="button"
            :disabled="!optIn"
            class="px-4 py-2 rounded-lg border border-indigo-300 text-indigo-700 text-[10px] font-black uppercase tracking-widest hover:bg-white disabled:opacity-40"
            @click="downloadSubmission"
          >
            Save the file instead
          </button>

          <span
            v-if="submitMessage"
            class="text-[11px] font-semibold"
            :class="submitOk ? 'text-emerald-700' : 'text-rose-700'"
          >
            {{ submitMessage }}
          </span>
        </div>

        <pre
          v-if="showPayload"
          class="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-[10px] leading-relaxed text-slate-200"
          >{{ payloadPreview }}</pre
        >

        <p class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
          <span class="font-black uppercase tracking-wide">What this does and does not include.</span>
          It is built from a fixed list of fields, not by stripping things out of the CSV, so nothing added to the CSV
          later can leak by being forgotten here. Your
          <span class="font-semibold">player ID is not in it</span> — it was never in the CSV either. What
          <em>is</em> in it and is still identifying: <span class="font-semibold">your artifact inventory</span>, which
          with exact counts is close to a fingerprint among people who know you; your
          <span class="font-semibold">timezone</span> and local plan start; and your
          <span class="font-semibold">available hours</span>. The inventory is included because a duration means nothing
          without knowing what it was simulated with — the same plan on commons is a different claim.
          <span v-if="includeCsv"
            >The <span class="font-semibold">CSV goes too</span>, ticked by default above: the same run in full — every
            chain it priced, one row per leg, with start and end times in your plan's timezone. Untick it to send the
            headline alone.</span
          >
          If that trade is not worth it to you, do not send it.
        </p>

        <!-- Where a submission ends up. A board nobody can find is not a shared repository of
             anything, and "it was sent somewhere" is a poor answer to "sent where?". -->
        <p v-if="store.submitUrl" class="text-[11px] text-indigo-900/70 leading-relaxed">
          Submissions land on the
          <a
            :href="store.leaderboardUrl"
            target="_blank"
            rel="noopener"
            class="font-bold text-indigo-700 underline hover:text-indigo-900"
            >chain leaderboard</a
          >
          — fastest chain per person, and every row opens to show the artifacts, stones and per-leg timings it was
          simulated with. Read it as "what shapes are winning for people": a duration depends on the account as much as
          on the chain.
        </p>

        <p v-if="!store.submitUrl" class="text-[11px] text-indigo-900/70 leading-relaxed">
          No collector is configured in this build, so there is nowhere to submit to and the button is not shown.
          <span class="font-semibold">Save the file</span> and share it however you like. Self-hosting: set
          <span class="font-mono">VITE_SUBMIT_URL</span> at build time.
        </p>
      </div>

      <!-- The run's own shape, and why it ended. The CSV had all of this already, but reading it
           meant finishing a three-hour run and opening a spreadsheet. -->
      <div v-if="store.pricedChains.length" class="p-4 rounded-xl border border-slate-200 bg-white space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">The shape of this search</h3>
          <button
            type="button"
            class="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600"
            @click="shapeOpen = !shapeOpen"
          >
            {{ shapeOpen ? 'Hide' : 'Show' }}
          </button>
        </div>

        <div v-if="shapeOpen" class="space-y-4">
          <!-- Why it ended, stated before the chart, because it changes how the chart reads: a run
               that stopped early has a right-hand edge that means nothing. -->
          <div
            class="rounded-lg border p-3 text-[11px] leading-relaxed"
            :class="
              runOutcome.tone === 'good'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            "
          >
            <span class="font-bold uppercase tracking-wide">{{ runOutcome.title }}</span>
            &mdash; {{ runOutcome.detail }}
          </div>

          <SearchShapeChart :points="store.pricedChains" :best-chain="store.bestChain" />
        </div>
      </div>

      <!-- Every chain the run priced, one row per leg. Safe to take mid-run. -->
      <div
        v-if="store.csvRows || store.resumable"
        class="flex flex-wrap items-center gap-3 p-4 rounded-xl border border-slate-200 bg-white"
      >
        <button
          type="button"
          class="px-4 py-2 rounded-lg bg-slate-800 text-white text-[10px] font-black uppercase tracking-widest hover:bg-slate-700"
          @click="downloadCsv"
        >
          Download CSV
        </button>
        <p class="text-[11px] text-slate-500 leading-relaxed flex-1 min-w-[16rem]">
          {{ store.csvRows || store.resumable?.durations.length || 0 }} chains, one row per leg — strategy, sale count,
          start and end times in your plan's timezone, peak delivery, and how many shifts fall in your schedule.
          Artifacts and stones are in the header block: the search never varies them.
          <span v-if="store.isRunning" class="font-semibold text-slate-600">Safe to download mid-run.</span>
        </p>
      </div>

      <!-- Honesty block. Do not soften this. -->
      <div
        class="p-4 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-800 space-y-1.5 leading-relaxed"
      >
        <p class="font-bold uppercase tracking-wide text-amber-700">What this does and does not promise</p>
        <ul class="space-y-1 list-disc list-inside">
          <li>The result is a strong <span class="font-semibold">local</span> optimum, never a proven global one.</li>
          <li>
            The search starts from the chain you typed above, unless you tick "find a starting chain for me" — then it
            scans a coarse grid and picks the prestige count first, the same as the command-line tool. Either way it
            never scans the whole space, so a bad starting chain can still strand it in a bad neighbourhood.
          </li>
          <li>Accuracy figures come from 3 accounts. Only one of them has a proven optimum to check against.</li>
          <li>A refresh is safe: progress is checkpointed and resumes without re-simulating anything.</li>
          <li>
            "Plan around my schedule" moves the prestige between ascensions and nothing else. Shifts inside an ascension
            can still land outside your hours; the CSV counts them per leg.
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useEidsStore } from 'lib';
import { useChainSearchStore } from '@/stores/chainSearch';
import { useAutoPlannerStore } from '@/stores/autoPlanner';
import { ACCURACY_SAMPLE, EFFORT_NOTES, EFFORT_ORDER, NEAR_OPTIMAL_SHARE } from '@/search/effort';
import { formatDuration } from '@/lib/format';
import { isAvailable } from '@/search/availability';
import ChainSearchExplainer from './ChainSearchExplainer.vue';
import HelpTip from './HelpTip.vue';
import LoadoutDisplay from './LoadoutDisplay.vue';
import SearchShapeChart from './charts/SearchShapeChart.vue';
import type { EffortTier, LegSummary } from '@/search/types';
import type { ShortlistRow } from '@/search/shortlist';
import { VIEWS } from '@/search/views';
import { downloadParts } from '@/utils/export';

const props = defineProps<{ playerId: string }>();

const store = useChainSearchStore();

/** Open by default: a collapsed form on first load looks like the panel has nothing in it. */
const settingsOpen = ref(true);

/** Collapsed by default: it is a post-run read, and the chart is the heaviest thing on the page. */
const shapeOpen = ref(true);

/**
 * Why the run ended, in one line. `stage` already carries this, but as an internal string
 * ("done - every chain it needed was already priced") that assumes you know what the stages are.
 */
const runOutcome = computed<{ title: string; detail: string; tone: 'good' | 'warn' }>(() => {
  if (store.isRunning) {
    return {
      title: 'Still running',
      detail: `${store.stage}. The chart fills in as batches report, so the right-hand edge is wherever it has reached.`,
      tone: 'warn',
    };
  }
  if (store.error) {
    return {
      title: 'Stopped by an error',
      detail: `${store.error} Everything priced before it stopped is on the chart and saved.`,
      tone: 'warn',
    };
  }
  if (store.stoppedEarly) {
    return {
      title: 'Stopped early',
      detail: `You stopped it during "${store.lastCompletedStage}". The answer is the best of what was priced and is exactly what the completed stages guarantee, but the later stages never ran.`,
      tone: 'warn',
    };
  }
  if (store.chainsDone === 0) {
    return {
      title: 'Nothing left to price',
      detail:
        'Every chain this tier needed was already in the checkpoint from an earlier run, so it replayed them and stopped. Raise the effort tier to go further.',
      tone: 'good',
    };
  }
  return {
    title: 'Finished',
    detail: `Every stage in this tier ran to completion, ending on "${store.lastCompletedStage}". Descent stops when no checkpoint moves, so finishing short of the estimate is normal.`,
    tone: 'good',
  };
});
const autoPlannerStore = useAutoPlannerStore();

// The slider is an index, not a tier name — `<input type="range">` only speaks numbers.
const effortIndex = computed({
  get: () => EFFORT_ORDER.indexOf(store.effort),
  set: (i: number) => {
    store.effort = EFFORT_ORDER[Math.max(0, Math.min(EFFORT_ORDER.length - 1, i))] as EffortTier;
  },
});

const note = computed(() => EFFORT_NOTES[store.effort]);

/**
 * The artifact readout, resolved once on first open.
 *
 * Not a computed: `readInventory` calls `getOptimalEarningsSet`, which solves a set-cover over the
 * whole inventory. As a computed it would re-run on every unrelated store change, on the main
 * thread, while a search is streaming progress into that same store.
 */
const inventoryOpen = ref(false);
const inventory = ref<ReturnType<typeof store.readInventory> | null>(null);

const rawInventoryOpen = ref(false);
const setTab = ref<'elr' | 'earnings'>('elr');

const totalArtifacts = computed(() => inventory.value?.artifacts.reduce((n, a) => n + a.count, 0) ?? 0);
const totalStones = computed(() => inventory.value?.stones.reduce((n, x) => n + x.count, 0) ?? 0);

function toggleInventory(): void {
  inventoryOpen.value = !inventoryOpen.value;
  if (inventoryOpen.value && !inventory.value) inventory.value = store.readInventory();
}

/**
 * Hand the run's CSV to the browser as a file.
 *
 * A Blob and a revoked object URL rather than a `data:` URI: a long run's export is a few megabytes
 * of text, and `data:` URLs are length-capped in some browsers, which would truncate exactly the
 * big runs worth exporting.
 */
/** Consent. Unchecked by default and gates every path that moves data off the machine --
 *  including the local save, because a file on disk is the first step to sharing one. */
const optIn = ref(false);
/** Anonymous by default: crediting yourself should be a choice, not the fallback. */
const anonymous = ref(true);
/** The name already shown in the header's ID box, for prefilling the credit field.
 *
 *  Deliberately NOT `eidsStore.displayName()`, which falls back to the raw EID when an account has
 *  neither a manual nickname nor a username captured from a backup. Prefilling that would put the
 *  player ID into a payload whose own consent text promises it is not there. Blank is the correct
 *  default in that case -- the player can type whatever they want. */
const eidsStore = useEidsStore();
const accountName = computed(() => {
  const entry = eidsStore.eids.get(props.playerId.trim());
  return entry?.nickname || entry?.username || '';
});

/** Free text the player may attach, ignored when anonymous. Seeded from the account's display
 *  name so crediting yourself is one radio click rather than retyping a name the app already
 *  shows, and still free text: anything typed here wins and is never overwritten afterwards. */
const nickname = ref(accountName.value);
const nicknameTouched = ref(false);
// The username is captured when a backup finishes loading, which can land after this panel has
// mounted. Keep following it until the player edits the box themselves.
watch(accountName, name => {
  if (!nicknameTouched.value) nickname.value = name;
});

/** Send the run's full CSV alongside the JSON. On by default: the per-leg rows are what make a
 *  pooled dataset worth anything beyond a ranking, and the whole block already sits behind an
 *  unticked opt-in, so this is not the checkbox standing between anyone and an accidental upload.
 *
 *  It costs the submitter almost nothing now that it is gzipped in the browser first -- 15.3 MB
 *  of chain table compresses to 0.66 MB, measured -- which is also what let the collector keep it
 *  in KV instead of needing an R2 bucket. */
const includeCsv = ref(true);
const showPayload = ref(false);
const submitState = ref<'idle' | 'sending' | 'done'>('idle');
const submitMessage = ref('');
const submitOk = ref(false);

/** The payload, pretty-printed, so "show exactly what is sent" is the literal bytes and not a
 *  summary someone has to trust. */
/** What a nickname actually resolves to. Anonymous wins over whatever is typed in the box, so
 *  a half-typed name cannot be sent by someone who then picked anonymous. */
const effectiveNickname = computed(() => (anonymous.value ? '' : nickname.value));

const payloadPreview = computed(() => {
  const p = store.buildRunSubmission(effectiveNickname.value);
  return p ? JSON.stringify(p, null, 2) : 'nothing to share yet - run a search first';
});

async function submit(): Promise<void> {
  if (!optIn.value) return;
  const payload = store.buildRunSubmission(effectiveNickname.value);
  if (!payload) return;
  submitState.value = 'sending';
  submitMessage.value = '';
  const res = await store.sendSubmission(payload, includeCsv.value ? store.exportCsv() : undefined);
  submitState.value = 'done';
  submitOk.value = res.ok;
  submitMessage.value = res.ok ? `Thank you — ${res.message}` : `Not sent: ${res.message}`;
}

/** The offline path, and the only one available with no collector configured. Same Blob dance as
 *  the CSV: a `data:` URI is length-capped in some browsers. */
function downloadSubmission(): void {
  if (!optIn.value) return;
  const payload = store.buildRunSubmission(effectiveNickname.value);
  if (!payload) return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = store.submissionFilename(payload);
  a.click();
  URL.revokeObjectURL(url);
  submitOk.value = true;
  submitMessage.value = 'Saved. Share it wherever you like.';
}

/** Chunked for the same reason the Insane panel's is: a long run's table is tens of megabytes, and
 *  the one-string version needs three copies of it alive at once. See `chainsCsvChunks`. */
function downloadCsv(): void {
  downloadParts(store.csvFilename(), store.exportCsvChunks(), 'text/csv;charset=utf-8');
}

/** The finish INSTANT, not the duration: durations from different plan starts are not comparable,
 *  and the end date is the invariant a player actually plans around. */
function finishInstant(seconds: number): string {
  if (!seconds) return '—';
  const tz = autoPlannerStore.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date((store.planStart + seconds) * 1000));
}

const endDate = computed(() => finishInstant(store.bestDays * 86400));

/** Why a runner-up is on the list, in words. A bare ranking invites "so why is #4 here?". */
const REASON_TEXT: Record<string, string> = {
  best: 'fastest found',
  'prestige-count': 'best at this prestige count',
  'different-shape': 'a genuinely different shape',
};

/** Whatever the page is served from, so the sleeping-tabs instruction names the right site. */
const host = typeof window !== 'undefined' ? window.location.host : 'this site';

interface EggBlock {
  egg: string;
  at: number;
  length: string;
  /** False for the block the leg opens on -- there is nothing to do, you are already there. */
  isSwitch: boolean;
}

/**
 * The eggs a leg lays, in order, INCLUDING the one it opens on.
 *
 * `leg.shifts` holds switches, not blocks, and a leg that switches eleven times lays twelve eggs.
 * Listing only the switches made the panel appear to start each ascension on Integrity when every
 * ascension in fact starts on Curiosity -- the opening stretch on Curiosity, 27 minutes of it in
 * the run that surfaced this, was simply missing. The Auto Planner's roadmap lists blocks (C1, I1,
 * K1 ...), so this now lines up with it one row per row, which is what makes the two cross-checkable.
 *
 * Each block runs until the next switch, or until the leg ends for the last one; the switch action
 * itself takes no time, so what a player experiences is the farming stretch between switches.
 */
function eggBlocks(leg: LegSummary): EggBlock[] {
  const shifts = leg.shifts ?? [];
  if (!shifts.length) return [];

  const span = (from: number, to: number | undefined) =>
    to !== undefined && to > from ? formatDuration(to - from) : '—';

  const blocks: EggBlock[] = [];
  // The opening block. Needs both a name and a start: `fromEgg` is only recorded from the build
  // that added it, and `startTime` is optional on LegSummary, so a checkpoint written by older
  // code simply does not get this row rather than getting a wrong one.
  const opener = shifts[0].fromEgg;
  if (opener && leg.startTime) {
    blocks.push({ egg: opener, at: leg.startTime, length: span(leg.startTime, shifts[0].at), isSwitch: false });
  }
  shifts.forEach((sh, k) => {
    blocks.push({
      egg: sh.egg,
      at: sh.at,
      length: span(sh.at, k + 1 < shifts.length ? shifts[k + 1].at : leg.endTime),
      isSwitch: true,
    });
  });
  return blocks;
}

/** Which runner-up's timing is open, by chain key. Empty for none. */
const expandedRow = ref('');

const activeView = computed(() => VIEWS.find(v => v.id === store.shortlistView));

/** `Sep 30, 5:25 PM` — deliberately no year. Every leg of a plan sits within a couple of years of
 *  the others, so the year is dead weight in a table this dense; the finish date above carries it. */
function stamp(unixSeconds: number | undefined): string {
  if (!unixSeconds) return '—';
  const tz = autoPlannerStore.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

/** Which leg's shift list is open. -1 for none; one at a time keeps the table readable. */
const expandedLeg = ref(-1);

/**
 * Everything a row's finish date owes to the schedule: prestiges waiting plus shifts held.
 *
 * Both halves are already inside the chain's duration; this pulls them back out so two options can
 * be compared on the one axis the schedule controls. Null when the chain was replayed from a
 * checkpoint and has no legs -- "0 d" there would be a claim, not a measurement.
 */
function scheduleCost(row: ShortlistRow): number | null {
  if (row.prestigeWaitSeconds === null && row.shiftHoldSeconds === null) return null;
  return (row.prestigeWaitSeconds ?? 0) + (row.shiftHoldSeconds ?? 0);
}

/** True when this instant falls outside the schedule. Uses the same predicate the search does, so
 *  the highlighting can never disagree with the count in the row above it. */
function outsideSchedule(unixSeconds: number): boolean {
  const a = store.availability;
  return a ? !isAvailable(unixSeconds, a) : false;
}

/** Sunday-first, matching `Availability.days` where 0 is Sunday. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toggleDay(day: number): void {
  if (store.isRunning) return;
  const days = store.availableDays.includes(day)
    ? store.availableDays.filter(d => d !== day)
    : [...store.availableDays, day].sort((a, b) => a - b);
  store.availableDays = days;
}

/** What was last sent to the Auto Planner, so the click has visible consequence. */
const applied = ref('');

const generated = ref(false);

function use(chain: number[], alsoGenerate = false): void {
  store.applyChain(chain, alsoGenerate);
  applied.value = chain.filter(v => v !== store.finalTE).join(' ');
  generated.value = alsoGenerate;
}

/** Everything the search charged for the schedule, which the generated plan will not include.
 *  Both halves, because the Auto Planner is unaware of both -- reporting only the prestige wait
 *  understated the gap by the larger of the two whenever shifts were being held. */
const totalPrestigeWait = computed(() => {
  const s = store.bestLegs.reduce((n, l) => n + (l.sleepDelaySeconds ?? 0) + (l.shiftDelaySeconds ?? 0), 0);
  return s > 0 ? formatDuration(s) : 'no';
});

function relativeTime(ms: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function run(resume: boolean): void {
  void store.start(props.playerId, { resume });
}

onMounted(() => void store.checkResumable(props.playerId));

// A checkpoint only resumes onto identical inputs (see search/persistence.ts's fingerprint), so
// re-check whenever anything that changes what a duration MEANS changes.
watch(
  () => [props.playerId, store.planStart, store.currentTE, store.finalTE, store.forceContinue],
  () => {
    if (!store.isRunning) void store.checkResumable(props.playerId);
  }
);
</script>
