<!--
  The unguarded control surface for the chain search. Reached only by URL (`?insane=1`), never
  linked, because every knob on it can make a run worse and none of them are explained by the
  defaults they override.

  WHY IT IS NOT LINKED. The main panel's settings are the ones with measured accuracy figures
  behind them. Everything added here is either a driver option that was deliberately left at its
  default (`maxLast`, `pin`) or a limit that only bites in ways the main panel would have to
  explain. Someone who typed this URL has gone looking; someone who clicked a tab has not.

  WHAT IT IS NOT. This is not the CLI. The command-line tool runs in Node with forked processes and
  reads a backup from disk, so `--backup`, `--jobs`, `--shard`, `--save-backup` and `--exhaustive`
  have no browser equivalent -- `--exhaustive` in particular enumerates a pool with no staged
  search, which this app has never had a path for. The panel says so rather than offering fields
  that quietly do nothing.
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
            Every knob, no guard rails, URL only
          </p>
        </div>
      </div>

      <div class="p-4 rounded-xl border border-rose-200 bg-rose-50 text-xs text-rose-900 leading-relaxed space-y-2">
        <p>
          These are the options the main panel leaves at their defaults on purpose. The accuracy figures quoted there
          were measured with those defaults, so nothing on this page has a measured accuracy figure behind it. Anything
          you change here, you are testing.
        </p>
        <p>
          The command-line tool is not this. <code class="font-mono-premium">--exhaustive</code>,
          <code class="font-mono-premium">--backup</code>, <code class="font-mono-premium">--jobs</code> and
          <code class="font-mono-premium">--shard</code> need Node and a filesystem, and have no browser equivalent.
          What is here is everything the in-browser search can actually do.
        </p>
      </div>

      <!-- The knobs. Grouped by what they change, not by which struct they live in. -->
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-5">
        <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Search</h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label class="space-y-1">
            <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">Effort tier</span>
            <select
              v-model="store.effort"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            >
              <option v-for="tier in EFFORT_ORDER" :key="tier" :value="tier">
                {{ EFFORT_NOTES[tier].label }} ({{ tier }})
              </option>
            </select>
          </label>

          <label class="space-y-1">
            <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">Final target TE</span>
            <input
              v-model.number="store.finalTE"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
        </div>

        <label class="space-y-1 block">
          <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">
            Starting chain (checkpoints before the target, space separated)
          </span>
          <input
            v-model="store.seedOverride"
            type="text"
            :disabled="store.isRunning"
            placeholder="e.g. 195 229 283"
            class="w-full rounded-lg border-slate-300 text-sm font-mono-premium font-bold text-slate-800 disabled:opacity-50"
          />
          <span class="block text-[10px] text-slate-400">
            Using <code class="font-mono-premium">{{ store.seedChain.join(' ') }}</code>
          </span>
        </label>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <label class="space-y-1">
            <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">Min ascensions</span>
            <input
              v-model.number="store.minPrestiges"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">Max ascensions</span>
            <input
              v-model.number="store.maxPrestiges"
              type="number"
              min="1"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest">Lock first N</span>
            <input
              v-model.number="store.pin"
              type="number"
              min="0"
              :disabled="store.isRunning"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
          <label class="space-y-1">
            <span class="block text-[9px] font-black text-slate-400 uppercase tracking-widest"
              >Max last checkpoint</span
            >
            <input
              v-model.number="maxLastInput"
              type="number"
              min="1"
              :disabled="store.isRunning"
              :placeholder="String(store.finalTE - 150)"
              class="w-full rounded-lg border-slate-300 text-sm font-bold text-slate-800 disabled:opacity-50"
            />
          </label>
        </div>

        <p class="text-[11px] text-slate-500 leading-relaxed">
          <span class="font-semibold text-slate-700">Max last checkpoint</span> is the one worth playing with. The
          driver defaults it to <code class="font-mono-premium">final − 150</code>, a cap measured against 490 targets
          from two observations. This repo's own f1–f4 corpus contains a measured 320-target optimum of
          <code class="font-mono-premium">195 231 277 320</code>, whose last checkpoint sits at
          <code class="font-mono-premium">final − 43</code> and which that default puts out of reach entirely. Leave it
          blank for the default.
        </p>

        <label class="flex items-start gap-3 text-xs text-slate-600">
          <input
            v-model="store.findSeedFirst"
            type="checkbox"
            :disabled="store.isRunning"
            class="mt-0.5 rounded border-slate-300 text-rose-600 focus:ring-rose-500 disabled:opacity-50"
          />
          <span>
            <span class="font-bold text-slate-800">Find a starting chain for me</span> — run the coarse scan first and
            take its pick instead of the chain above.
          </span>
        </label>
      </div>

      <!-- Run -->
      <div class="flex flex-wrap gap-3">
        <button
          class="btn-premium btn-primary flex-1 py-4 text-sm shadow-xl shadow-rose-500/20 active:scale-[0.98]"
          :disabled="store.isRunning"
          @click="start"
        >
          {{ store.isRunning ? 'Searching...' : 'Start search' }}
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

      <div v-if="store.stage" class="text-[11px] font-mono-premium text-slate-500">
        {{ store.stage }} — {{ store.chainsDone }} / ~{{ store.chainsEstimated }} chains
      </div>

      <div
        v-if="store.error"
        class="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 leading-relaxed"
      >
        <span class="font-bold uppercase tracking-wide">Search failed</span> — {{ store.error }}
      </div>

      <!-- Result -->
      <div v-if="store.bestDays > 0" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-1">
        <div class="text-[10px] font-black text-emerald-700 uppercase tracking-widest">Best chain</div>
        <div class="font-mono-premium text-lg font-black text-slate-900">{{ store.bestChain.join(' ') }}</div>
        <div class="text-xs text-emerald-800">{{ store.bestDays.toFixed(3) }} days</div>
      </div>

      <!-- The saved-run library. The answer to "can I reload this later". -->
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Saved runs</h3>
          <span class="text-[10px] font-bold text-slate-400">{{ store.savedRuns.length }} / {{ MAX_RUNS }}</span>
        </div>

        <p class="text-[11px] text-slate-500 leading-relaxed">
          Kept in this browser, per player, and reloadable at any time. Separate from the crash-recovery checkpoint,
          which holds one run and only resumes onto identical settings. The oldest is dropped past
          {{ MAX_RUNS }}.
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
                {{ run.bestChain.join(' ') }} · {{ run.bestDays.toFixed(3) }} d · {{ run.chainsPriced }} chains ·
                {{ run.effort }}<template v-if="!run.complete"> · stopped early</template>
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

      <!-- Submission. Same payload and the same opt-in as the main panel. -->
      <div v-if="store.bestDays > 0" class="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 space-y-3">
        <h3 class="text-[10px] font-black text-indigo-800 uppercase tracking-widest">Share this result</h3>
        <p class="text-[11px] text-indigo-900/80 leading-relaxed">
          Identical to the main panel's submission, including what it contains and what it leaves out. A run opened from
          the library above submits without a run cost, because the time it took was not this machine's.
        </p>
        <label class="flex items-start gap-3 text-xs text-indigo-900">
          <input v-model="optIn" type="checkbox" class="mt-0.5 rounded border-indigo-300 text-indigo-600" />
          <span>Yes, contribute this result.</span>
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
import { computed, onMounted, ref } from 'vue';
import { useChainSearchStore } from '@/stores/chainSearch';
import { EFFORT_NOTES, EFFORT_ORDER } from '@/search/effort';
import { MAX_RUNS } from '@/search/runLibrary';
import SearchShapeChart from './charts/SearchShapeChart.vue';

const props = defineProps<{ playerId: string }>();
const store = useChainSearchStore();

/** Blank means "leave the driver's default alone", which is why this is not bound straight to the
 *  store's nullable ref: an empty number input yields `undefined`, not null. */
const maxLastInput = ref<number | null>(null);
const maxLast = computed(() =>
  typeof maxLastInput.value === 'number' && maxLastInput.value > 0 ? maxLastInput.value : null
);

const saveLabel = ref('');
const saving = ref(false);
const optIn = ref(false);
const submitting = ref(false);
const submitMessage = ref('');
const submitOk = ref(false);

onMounted(() => {
  void store.refreshSavedRuns(props.playerId);
  void store.checkResumable(props.playerId);
});

async function start(): Promise<void> {
  store.maxLastOverride = maxLast.value;
  await store.start(props.playerId);
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
