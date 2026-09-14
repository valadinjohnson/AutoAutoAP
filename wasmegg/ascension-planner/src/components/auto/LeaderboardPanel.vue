<!--
  The chain leaderboard, read from the collector and rendered in the planner's own styling.

  The same data is served as a standalone page by the Worker itself, and that page is still the
  right answer for someone following a link from outside. This exists because the people most
  likely to want the board are the ones already looking at their own result, and sending them to
  another domain to compare against it is a worse experience than a tab.

  It re-implements the table rather than framing the Worker's page: an iframe would carry the
  other page's styling into the middle of this one, would not share the planner's TE target, and
  could not offer "use this chain". Nothing here re-simulates anything -- it is one GET.
-->
<template>
  <div class="space-y-4">
    <div class="p-4 rounded-xl border border-indigo-200 bg-indigo-50/40 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="text-[10px] font-black text-indigo-700 uppercase tracking-widest">Chain leaderboard</h3>
          <p class="text-[11px] text-indigo-900/80 leading-relaxed mt-1">
            The fastest chain each person has submitted. Open a row for the artifacts, stones and
            per-leg timings it was simulated with.
          </p>
        </div>
        <div class="flex items-end gap-2">
          <label class="block">
            <span class="block text-[9px] font-black uppercase tracking-widest text-indigo-700/70 mb-1">Target TE</span>
            <select
              v-model="final"
              class="rounded-lg border-indigo-200 text-xs font-bold text-slate-700 py-1.5"
              @change="load"
            >
              <option value="">all</option>
              <option v-for="te in targets" :key="te" :value="String(te)">{{ te }}</option>
            </select>
          </label>
          <button
            type="button"
            class="px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 text-[10px] font-black uppercase tracking-widest hover:bg-white disabled:opacity-40"
            :disabled="loading"
            @click="load"
          >
            {{ loading ? 'Loading' : 'Refresh' }}
          </button>
        </div>
      </div>

      <p v-if="error" class="text-[11px] text-red-700 font-semibold">
        Could not reach the collector: {{ error }}
      </p>

      <p v-else-if="!loading && !rows.length" class="text-[11px] text-indigo-900/60 py-6 text-center">
        Nothing submitted yet. Run a search and use <span class="font-semibold">Share this result</span>.
      </p>

      <div v-else-if="rows.length" class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-[9px] font-black uppercase tracking-widest text-slate-400 text-left">
              <th class="py-2 pr-3"></th>
              <th v-for="c in COLUMNS" :key="c.key" class="py-2 pr-3" :class="c.right ? 'text-right' : ''">
                <button
                  type="button"
                  class="uppercase tracking-widest hover:text-slate-700"
                  :class="sortKey === c.key ? 'text-slate-700' : ''"
                  :aria-sort="sortKey === c.key ? (sortAsc ? 'ascending' : 'descending') : 'none'"
                  @click="sortBy(c.key)"
                >
                  {{ c.label }}<span v-if="sortKey === c.key">{{ sortAsc ? ' ▲' : ' ▼' }}</span>
                </button>
              </th>
              <th class="py-2"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(row, i) in sortedRows" :key="row.id ?? i">
              <tr class="border-t border-slate-100">
                <td class="py-2 pr-3">
                  <button
                    type="button"
                    class="text-slate-400 hover:text-indigo-700"
                    :aria-expanded="open === (row.id ?? String(i))"
                    :aria-label="`Show what ${(row.chain || []).join(' ')} was simulated with`"
                    @click="open = open === (row.id ?? String(i)) ? '' : row.id ?? String(i)"
                  >
                    {{ open === (row.id ?? String(i)) ? '⌄' : '›' }}
                  </button>
                </td>
                <td class="py-2 pr-3 font-bold text-slate-700">{{ row.nickname || 'anonymous' }}</td>
                <td class="py-2 pr-3 font-mono font-bold text-slate-700 whitespace-nowrap">
                  {{ (row.chain || []).join(' ') }}
                </td>
                <td class="py-2 pr-3 text-right text-slate-600 font-bold">{{ row.ascensions }}</td>
                <td class="py-2 pr-3 text-right text-slate-700 font-bold whitespace-nowrap">
                  {{ Number(row.durationDays).toFixed(3) }}
                </td>
                <td class="py-2 pr-3 text-slate-500 whitespace-nowrap">{{ row.endLocal || '—' }}</td>
                <td class="py-2 pr-3 text-right whitespace-nowrap">
                  <!-- null is "not recorded", not "free": a chain replayed from a checkpoint kept
                       no per-leg detail, and printing 0 would be a claim nobody measured. -->
                  <span v-if="row.waitingHours == null" class="text-slate-400">—</span>
                  <span v-else-if="row.waitingHours < 0.05" class="text-slate-400">none</span>
                  <span v-else class="font-bold text-amber-700">{{ row.waitingHours.toFixed(1) }} h</span>
                </td>
                <td class="py-2 pr-3 text-slate-400">{{ row.window || 'no schedule' }}</td>
                <td class="py-2 text-right">
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-md border border-slate-300 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:border-emerald-400 hover:text-emerald-700"
                    @click="$emit('use', row.chain)"
                  >
                    Use
                  </button>
                </td>
              </tr>
              <tr v-if="open === (row.id ?? String(i))" class="bg-slate-50">
                <td colspan="9" class="px-3 py-3">
                  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-[11px]">
                    <div>
                      <h4 class="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Run</h4>
                      <div class="space-y-0.5 text-slate-600">
                        <div class="flex justify-between gap-3"><span>Starting TE</span><span class="font-bold">{{ row.currentTE ?? '—' }}</span></div>
                        <div class="flex justify-between gap-3"><span>Target TE</span><span class="font-bold">{{ row.finalTE }}</span></div>
                        <div class="flex justify-between gap-3"><span>Plan starts</span><span class="font-bold">{{ row.startLocal || '—' }}</span></div>
                        <div class="flex justify-between gap-3"><span>Chains priced</span><span class="font-bold">{{ row.chainsPriced ?? '—' }}</span></div>
                        <div class="flex justify-between gap-3"><span>Shifts held</span><span class="font-bold">{{ row.holdShifts ? 'yes' : 'no' }}</span></div>
                      </div>
                      <a
                        v-if="row.hasCsv"
                        :href="`${csvRoot}?id=${encodeURIComponent(row.id!)}`"
                        class="inline-block mt-2 font-bold text-indigo-700 underline hover:text-indigo-900"
                        >Download the full CSV (.csv.gz) ↓</a
                      >
                      <p v-else class="mt-2 text-slate-400">No CSV was attached.</p>
                    </div>
                    <!-- The sets the simulator actually wears, which is the question the
                         inventory only gestures at. The fourth DELIVERY slot is chosen as a
                         stone holder, so showing the stones inside each artifact is what makes
                         a T3L ankh over a T4E chalice read as a choice rather than a bug. -->
                    <div v-if="row.delivery?.length || row.earnings?.length">
                      <h4 class="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
                        {{ setTab[row.id ?? ''] === 'earnings' ? 'Earnings set' : 'Delivery set' }}
                      </h4>
                      <div class="flex gap-1 mb-1.5">
                        <button
                          v-for="t in (['delivery', 'earnings'] as const)"
                          :key="t"
                          type="button"
                          class="px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest"
                          :class="
                            (setTab[row.id ?? ''] ?? 'delivery') === t
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-400 hover:text-slate-600'
                          "
                          @click="setTab[row.id ?? ''] = t"
                        >
                          {{ t }}
                        </button>
                      </div>
                      <div
                        v-for="(slot, k) in (setTab[row.id ?? ''] === 'earnings' ? row.earnings : row.delivery)"
                        :key="k"
                        class="mb-1"
                      >
                        <div class="font-bold text-slate-700">{{ slot.artifact }}</div>
                        <div v-if="slot.stones?.length" class="text-slate-500 ml-2">
                          {{ slot.stones.join(', ') }}
                        </div>
                        <div v-else class="text-slate-400 ml-2">no stones</div>
                      </div>
                    </div>
                    <div v-else>
                      <h4 class="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Artifacts</h4>
                      <div v-if="!row.artifacts?.length" class="text-slate-400">none recorded</div>
                      <!-- Schema 2 sends labels; rows stored under schema 1 are still {label,count}. -->
                      <div v-for="(a, k) in row.artifacts" :key="k" class="text-slate-600">
                        {{ typeof a === 'string' ? a : `${a.label} ×${a.count}` }}
                      </div>
                    </div>
                    <div>
                      <h4 class="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Stones</h4>
                      <div v-if="!row.stones?.length" class="text-slate-400">none recorded</div>
                      <div v-for="(st, k) in row.stones" :key="k" class="flex justify-between gap-3 text-slate-600">
                        <span>{{ st.label }}</span><span class="font-bold">{{ st.count }}</span>
                      </div>
                    </div>
                    <div>
                      <h4 class="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Legs</h4>
                      <div v-if="!row.legs?.length" class="text-slate-400">
                        no per-leg detail — replayed from a saved checkpoint
                      </div>
                      <div v-for="(l, k) in row.legs" :key="k" class="font-mono text-[10px] text-slate-600">
                        A{{ k + 1 }} → {{ l.te }} {{ l.strategy }} {{ l.days?.toFixed(2) }} d
                        {{ l.peakDeliveryQph?.toFixed(2) }} q/hr
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <p class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
        <span class="font-semibold">Durations are not directly comparable.</span> A chain's length depends on the
        account's artifacts, research and starting TE as much as on the chain, and on whether the run was constrained
        to the player's waking hours. Read this as "what shapes are winning for people", not as a ranking of players.
        <span class="font-semibold">Use</span> puts a chain into the Auto Planner so you can price it against
        <em>your</em> account — which is the only comparison that means anything.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useChainSearchStore } from '@/stores/chainSearch';
import { sortRows, type SortKey } from '@/lib/leaderboardSort';

defineEmits<{ use: [chain: number[]] }>();

/** Mirrors the collector's row shape. Loose on purpose: this reads a public endpoint that may be
 *  a version ahead or behind, and a missing field should render a dash, not throw. */
interface Row {
  id?: string;
  hasCsv?: boolean;
  nickname?: string;
  chain: number[];
  ascensions?: number;
  durationDays: number;
  startLocal?: string;
  endLocal?: string;
  currentTE?: number;
  finalTE: number;
  window?: string | null;
  holdShifts?: boolean;
  waitingHours?: number | null;
  chainsPriced?: number;
  artifacts?: (string | { label: string; count: number })[];
  delivery?: { artifact: string; stones?: string[] }[];
  earnings?: { artifact: string; stones?: string[] }[];
  stones?: { label: string; count: number }[];
  legs?: { te: number; strategy: string; days: number; peakDeliveryQph: number }[];
}

const store = useChainSearchStore();

const root = computed(() => store.leaderboardUrl.replace(/\/$/, ''));
const csvRoot = computed(() => `${root.value}/csv`);

const COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'nickname', label: 'Who' },
  { key: 'chain', label: 'Chain' },
  { key: 'ascensions', label: 'Ascensions', right: true },
  { key: 'durationDays', label: 'Days', right: true },
  { key: 'endLocal', label: 'Finishes' },
  { key: 'waitingHours', label: 'Waiting', right: true },
  { key: 'window', label: 'Window' },
];

const rows = ref<Row[]>([]);
const loading = ref(false);
const error = ref('');
const open = ref('');
/** Which set each expanded row is showing. Per row, so opening a second one does not reset the
 *  first; delivery is the default because it is the one that changes between accounts. */
const setTab = ref<Record<string, 'delivery' | 'earnings'>>({});
/** Defaults to the target this player is actually searching for -- the board is only useful
 *  against comparable runs, and "all" mixes 490s with 300s. */
const final = ref(String(store.finalTE ?? ''));

/** Duration ascending, matching the order the collector's keys already impose -- the board's
 *  whole point is "what finished soonest". Clicking a header re-sorts in the browser; nothing is
 *  refetched, because the page already holds every row it is showing. */
const sortKey = ref<SortKey>('durationDays');
const sortAsc = ref(true);

function sortBy(key: SortKey): void {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    // Numbers read best smallest-first here (fewest days, least waiting, fewest ascensions);
    // text reads best A-Z. Both are "ascending", so the default is the same flag either way.
    sortAsc.value = true;
  }
}

const sortedRows = computed(() => sortRows(rows.value, sortKey.value, sortAsc.value));

/** Target-TE options, filled from what has actually been submitted. */
const targets = ref<number[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const q = new URLSearchParams({ limit: '50' });
    if (final.value) q.set('final', final.value);
    const res = await fetch(`${root.value}/leaderboard?${q}`);
    if (!res.ok) throw new Error(`the collector answered ${res.status}`);
    const data = (await res.json()) as { rows?: Row[] };
    rows.value = data.rows ?? [];
    // Populate the filter from what has actually been submitted, once, and never let the
    // player's own target vanish from the list just because nobody has posted one yet.
    if (!targets.value.length) {
      const seen = new Set(rows.value.map(r => r.finalTE));
      if (store.finalTE) seen.add(store.finalTE);
      targets.value = [...seen].sort((a, b) => a - b);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
