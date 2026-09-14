<!--
  Every chain this run priced, plotted. The same data the CSV holds, without the spreadsheet.

  WHY THE DEFAULT AXIS IS THE LAST CHECKPOINT. The landscape's whole structure is the game's sale
  calendar acting on the final leg, which shows up as descending runs a few TE wide separated by
  one missed sale. Plotted against the last checkpoint, a real run reproduces that sawtooth from
  the user's own account rather than from the explainer's fixed corpus. "Order priced" and "rank"
  are offered too, because they answer different questions: whether the search was still improving
  when it stopped, and how thin the good band actually is.

  COLOUR IS ASCENSION COUNT, and that is not decoration. Chains of different lengths are different
  families, and seeing two clouds at different heights is the fastest way to notice that the run
  spent its time on a length nobody asked for.

  Scatter rather than line: these points have no order between them, and connecting them would
  invent one. The line toggle exists because a single-length sweep genuinely does read better
  connected, and it is off by default.
-->
<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="mode in AXIS_MODES"
          :key="mode.id"
          type="button"
          class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-colors"
          :class="
            axis === mode.id
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
          "
          @click="axis = mode.id"
        >
          {{ mode.label }}
        </button>
      </div>
      <label class="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">
        <input
          v-model="connect"
          type="checkbox"
          class="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
        />
        Join the dots
      </label>
    </div>

    <p class="text-[11px] text-slate-500 leading-relaxed px-1">{{ AXIS_MODES.find(m => m.id === axis)?.hint }}</p>

    <EChart v-if="points.length" :option="option" height="360px" />
    <p v-else class="px-4 py-10 text-center text-[10px] font-bold text-slate-400">
      Nothing priced yet. The chart fills in as the search reports batches.
    </p>

    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[10px] font-bold text-slate-400 uppercase tracking-wide"
    >
      <span>{{ points.length.toLocaleString() }} chains priced</span>
      <span v-for="group in groups" :key="group.prestiges" class="flex items-center gap-1.5">
        <span :style="{ color: group.color }">●</span> {{ group.prestiges }} ascensions ({{ group.count }})
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import EChart from '@/components/charts/EChart.vue';
import type { ChartOption, ChartSeriesOption } from '@/lib/charts/echarts';
import type { PricedChain } from '@/search/types';

const props = defineProps<{ points: PricedChain[]; bestChain: number[] }>();

type AxisMode = 'last' | 'rank' | 'order';
const axis = ref<AxisMode>('last');
const connect = ref(false);

const AXIS_MODES: { id: AxisMode; label: string; hint: string }[] = [
  {
    id: 'last',
    label: 'Last checkpoint',
    hint: 'Duration against the last checkpoint before your target. This is where the sale-calendar sawtooth shows up: short descending runs, then a jump of about three days where a leg misses its Saturday sale.',
  },
  {
    id: 'rank',
    label: 'Sorted best first',
    hint: 'Every chain sorted fastest to slowest. The flatter the left end, the more chains are tied near the top, and the less the exact winner matters.',
  },
  {
    id: 'order',
    label: 'Order priced',
    hint: 'The order the search actually evaluated them. A trend still heading down at the right edge means it was still finding improvements when it stopped.',
  },
];

/** Ascension count decides colour. Ordered so the legend and the series agree. */
const PALETTE = ['#4f46e5', '#f59e0b', '#059669', '#d946ef', '#0891b2', '#dc2626', '#65a30d', '#7c3aed'];

const groups = computed(() => {
  const counts = new Map<number, number>();
  for (const p of props.points) counts.set(p.prestiges, (counts.get(p.prestiges) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([prestiges, count], i) => ({ prestiges, count, color: PALETTE[i % PALETTE.length] }));
});

interface Plotted {
  x: number;
  y: number;
  chain: number[];
  prestiges: number;
}

const plotted = computed<Plotted[]>(() => {
  const source = props.points;
  if (axis.value === 'rank') {
    return [...source]
      .sort((a, b) => a.days - b.days)
      .map((p, i) => ({ x: i + 1, y: p.days, chain: p.chain, prestiges: p.prestiges }));
  }
  if (axis.value === 'order') {
    return source.map((p, i) => ({ x: i + 1, y: p.days, chain: p.chain, prestiges: p.prestiges }));
  }
  return source.map(p => ({ x: p.lastCheckpoint, y: p.days, chain: p.chain, prestiges: p.prestiges }));
});

const bestKey = computed(() => props.bestChain.join(','));

const option = computed<ChartOption>(() => {
  const byLength = new Map<number, Plotted[]>();
  for (const p of plotted.value) {
    const bucket = byLength.get(p.prestiges);
    if (bucket) bucket.push(p);
    else byLength.set(p.prestiges, [p]);
  }

  const colorOf = (prestiges: number) => groups.value.find(g => g.prestiges === prestiges)?.color ?? PALETTE[0];

  const series: ChartSeriesOption[] = [...byLength.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([prestiges, pts]) => {
      // Connecting only makes sense along the x axis, so sort when the line is on. Left unsorted
      // otherwise, since sorting thousands of points every redraw buys nothing for a scatter.
      const data = (connect.value ? [...pts].sort((a, b) => a.x - b.x) : pts).map(p => [p.x, p.y, p.chain.join(' ')]);
      return {
        name: `${prestiges} ascensions`,
        type: connect.value ? ('line' as const) : ('scatter' as const),
        data,
        color: colorOf(prestiges),
        symbolSize: 5,
        ...(connect.value ? { showSymbol: true, lineStyle: { width: 1 }, smooth: false } : {}),
      };
    });

  const best = plotted.value.find(p => p.chain.join(',') === bestKey.value);
  if (best) {
    series.push({
      name: 'Best found',
      type: 'scatter' as const,
      data: [[best.x, best.y, best.chain.join(' ')]],
      color: '#059669',
      symbolSize: 16,
      // A ring, so it reads as a marker rather than another observation.
      itemStyle: { color: 'transparent', borderColor: '#059669', borderWidth: 2.5 },
    });
  }

  return {
    grid: { left: 58, right: 20, top: 16, bottom: 56 },
    tooltip: {
      trigger: 'item',
      formatter: rawParams => {
        // echarts types the formatter param as a broad union that can be an array under
        // `trigger: 'axis'`. This chart is always `trigger: 'item'`, so it is one point, and the
        // only fields read are the [x, y, chain] tuple each series was given. Same narrowing the
        // C3 comparison chart does.
        const params = rawParams as { data?: [number, number, string] };
        if (!params.data) return '';
        return `<b>${params.data[2]}</b><br/>${params.data[1].toFixed(3)} days`;
      },
    },
    xAxis: {
      type: 'value',
      name:
        axis.value === 'last' ? 'last checkpoint (TE)' : axis.value === 'rank' ? 'rank, best first' : 'order priced',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: '#94a3b8', fontSize: 10 },
      scale: true,
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      splitLine: { lineStyle: { color: '#eef2f7' } },
    },
    yAxis: {
      type: 'value',
      name: 'days',
      nameTextStyle: { color: '#94a3b8', fontSize: 10 },
      scale: true,
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      splitLine: { lineStyle: { color: '#eef2f7' } },
    },
    // Thousands of points on a 360px canvas: without a zoom the sawtooth is a smear.
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'slider', xAxisIndex: 0, height: 18, bottom: 6, borderColor: '#e2e8f0' },
    ],
    series,
  };
});
</script>
