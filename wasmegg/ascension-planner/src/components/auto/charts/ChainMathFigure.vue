<template>
  <figure class="m-0">
    <div class="rounded-xl border border-slate-200 bg-white p-3 overflow-x-auto">
      <svg :viewBox="`0 0 ${W} ${H}`" class="block w-full h-auto min-w-[520px]" role="img" :aria-label="spec.ariaLabel">
        <!-- horizontal gridlines + y ticks -->
        <g>
          <template v-for="t in spec.yTicks" :key="`y${t}`">
            <line :x1="X0" :x2="X1" :y1="sy(t)" :y2="sy(t)" stroke="#e2e8f0" stroke-width="1" />
            <text
              :x="X0 - 8"
              :y="sy(t) + 4"
              text-anchor="end"
              fill="#94a3b8"
              font-size="10"
              font-family="ui-monospace, monospace"
            >
              {{ t }}
            </text>
          </template>
          <text
            :x="X0 - 8"
            :y="Y0 - 10"
            text-anchor="end"
            fill="#cbd5e1"
            font-size="9"
            font-weight="700"
            letter-spacing="0.1em"
            font-family="ui-monospace, monospace"
          >
            {{ spec.yLabel }}
          </text>
        </g>

        <!-- bars (distribution) -->
        <rect
          v-for="b in bars"
          :key="`b${b.i}`"
          :x="b.x"
          :y="b.y"
          :width="b.w"
          :height="b.h"
          rx="1.5"
          :fill="b.near ? '#10b981' : '#6366f1'"
          :opacity="b.near ? 1 : 0.8"
        />

        <!-- area + line (sweeps) -->
        <path
          v-if="spec.area && linePath"
          :d="`${linePath} L${X1} ${Y1} L${X0} ${Y1} Z`"
          fill="#6366f1"
          opacity="0.07"
        />
        <path v-if="linePath" :d="linePath" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" />

        <!-- point markers -->
        <g v-for="p in points" :key="`p${p.i}`">
          <circle
            :cx="p.cx"
            :cy="p.cy"
            :r="p.r"
            :fill="p.fill"
            :stroke="p.ring ? '#ffffff' : 'none'"
            :stroke-width="p.ring ? 2 : 0"
          />
          <circle v-if="p.halo" :cx="p.cx" :cy="p.cy" r="9.5" fill="none" stroke="#059669" stroke-width="1.5" />
        </g>

        <!-- annotations -->
        <g v-for="(a, i) in annotations" :key="`a${i}`">
          <path v-if="a.d" :d="a.d" :stroke="a.stroke" stroke-width="1.25" stroke-dasharray="3 3" fill="none" />
          <text
            v-if="a.text"
            :x="a.tx"
            :y="a.ty"
            :text-anchor="a.anchor || 'start'"
            :fill="a.fill"
            :font-size="a.size || 11"
            :font-weight="a.weight || 600"
            font-family="ui-monospace, monospace"
            paint-order="stroke"
            stroke="#ffffff"
            stroke-width="4"
            stroke-linejoin="round"
          >
            {{ a.text }}
          </text>
          <text
            v-if="a.sub"
            :x="a.tx"
            :y="(a.ty || 0) + 14"
            :text-anchor="a.anchor || 'start'"
            fill="#94a3b8"
            font-size="10"
            paint-order="stroke"
            stroke="#ffffff"
            stroke-width="4"
            stroke-linejoin="round"
          >
            {{ a.sub }}
          </text>
        </g>

        <!-- x axis -->
        <line :x1="X0" :x2="X1" :y1="Y1" :y2="Y1" stroke="#cbd5e1" stroke-width="1" />
        <text
          v-for="t in spec.xTicks"
          :key="`x${t.at}`"
          :x="sx(t.at)"
          :y="Y1 + 17"
          text-anchor="middle"
          fill="#94a3b8"
          font-size="10"
          font-family="ui-monospace, monospace"
        >
          {{ t.label }}
        </text>
        <text :x="(X0 + X1) / 2" :y="H - 6" text-anchor="middle" fill="#94a3b8" font-size="10">
          {{ spec.xLabel }}
        </text>
      </svg>
    </div>
    <figcaption class="mt-2 px-1 text-[11px] text-slate-500 leading-relaxed">
      <slot />
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { SAWTOOTH, WIDE_SWEEP, DISTRIBUTION, SEED_SENSITIVITY } from '@/lib/charts/chainSearchMath';

type Kind = 'sawtooth' | 'wide' | 'distribution' | 'seed';
const props = defineProps<{ kind: Kind }>();

const W = 760;
const H = 300;

interface Annotation {
  d?: string;
  stroke?: string;
  text?: string;
  sub?: string;
  tx?: number;
  ty?: number;
  fill?: string;
  size?: number;
  weight?: number;
  anchor?: string;
}
interface Point {
  i: number;
  cx: number;
  cy: number;
  r: number;
  fill: string;
  ring?: boolean;
  halo?: boolean;
}
interface Bar {
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
  near: boolean;
}

// Each figure owns its margins. The annotated ones need a right gutter to write into, since a
// label dropped into the plot body lands on the line and stops being readable.
const spec = computed(() => {
  switch (props.kind) {
    case 'sawtooth':
      return {
        ariaLabel:
          'Plan duration against the last checkpoint over 21 consecutive Truth Egg values, showing short descending runs separated by jumps of about three days.',
        m: { t: 22, r: 104, b: 40, l: 54 },
        xDomain: [310, 330] as [number, number],
        yDomain: [758.0, 763.2] as [number, number],
        yTicks: [759, 760, 761, 762, 763],
        xTicks: [310, 315, 320, 325, 330].map(v => ({ at: v, label: String(v) })),
        yLabel: 'DAYS',
        xLabel: 'last checkpoint, Truth Eggs',
        area: false,
      };
    case 'wide':
      return {
        ariaLabel:
          'Plan duration against the last checkpoint over 86 consecutive values, falling in ledges to a plateau near 285 and then climbing.',
        m: { t: 26, r: 96, b: 40, l: 54 },
        xDomain: [255, 340] as [number, number],
        yDomain: [760, 900] as [number, number],
        yTicks: [780, 800, 820, 840, 860, 880, 900],
        xTicks: [260, 280, 300, 320, 340].map(v => ({ at: v, label: String(v) })),
        yLabel: 'DAYS',
        xLabel: 'last checkpoint, Truth Eggs',
        area: true,
      };
    case 'distribution':
      return {
        ariaLabel:
          'Histogram of all 10,413 chains in the exhaustive box, with the near-optimal chains a thin sliver at the left.',
        m: { t: 54, r: 24, b: 40, l: 54 },
        xDomain: [DISTRIBUTION.edges[0], DISTRIBUTION.edges[DISTRIBUTION.edges.length - 1]] as [number, number],
        yDomain: [0, Math.max(...DISTRIBUTION.counts)] as [number, number],
        yTicks: [0, 100, 200, 300, 400],
        xTicks: [760, 764, 768, 772, 775].map(v => ({ at: v, label: String(v) })),
        yLabel: 'CHAINS',
        xLabel: 'plan duration, days',
        area: false,
      };
    case 'seed':
    default:
      return {
        ariaLabel:
          'Best chain reachable from each starting first checkpoint, varying by sixteen days in a jagged rather than smooth pattern.',
        m: { t: 44, r: 24, b: 40, l: 54 },
        xDomain: [185, 199] as [number, number],
        yDomain: [331, 352] as [number, number],
        yTicks: [335, 340, 345, 350],
        xTicks: SEED_SENSITIVITY.x1.map(v => ({ at: v, label: String(v) })),
        yLabel: 'DAYS',
        xLabel: 'first checkpoint you start from, Truth Eggs',
        area: false,
      };
  }
});

const X0 = computed(() => spec.value.m.l);
const X1 = computed(() => W - spec.value.m.r);
const Y0 = computed(() => spec.value.m.t);
const Y1 = computed(() => H - spec.value.m.b);

function sx(v: number): number {
  const [a, b] = spec.value.xDomain;
  return X0.value + ((v - a) / (b - a)) * (X1.value - X0.value);
}
function sy(v: number): number {
  const [a, b] = spec.value.yDomain;
  return Y1.value - ((v - a) / (b - a)) * (Y1.value - Y0.value);
}

const series = computed<{ x: number[]; y: number[] } | null>(() => {
  if (props.kind === 'sawtooth') return { x: SAWTOOTH.x, y: SAWTOOTH.days };
  if (props.kind === 'wide') return { x: WIDE_SWEEP.x, y: WIDE_SWEEP.days };
  if (props.kind === 'seed') return { x: SEED_SENSITIVITY.x1, y: SEED_SENSITIVITY.best };
  return null;
});

const linePath = computed(() => {
  const s = series.value;
  if (!s) return '';
  return s.x.map((v, i) => `${i ? 'L' : 'M'}${sx(v)} ${sy(s.y[i])}`).join(' ');
});

const bars = computed<Bar[]>(() => {
  if (props.kind !== 'distribution') return [];
  const { counts, edges, best } = DISTRIBUTION;
  const cut = best + 1;
  return counts.map((c, i) => {
    const x = sx(edges[i]);
    return {
      i,
      x,
      y: sy(c),
      w: Math.max(1.5, sx(edges[i + 1]) - x - 1.5),
      h: Math.max(1, Y1.value - sy(c)),
      near: edges[i + 1] <= cut + 1e-9,
    };
  });
});

const points = computed<Point[]>(() => {
  const s = series.value;
  if (!s) return [];
  const bestIdx = s.y.indexOf(Math.min(...s.y));

  if (props.kind === 'sawtooth') {
    return s.x.map((_, i) => {
      // A run-end is the last value before the duration rises, which is where every measured
      // optimum sat.
      const runEnd = i < s.y.length - 1 && s.y[i + 1] > s.y[i];
      const isBest = i === bestIdx;
      return {
        i,
        cx: sx(s.x[i]),
        cy: sy(s.y[i]),
        r: isBest ? 5.5 : runEnd ? 4.5 : 3,
        fill: isBest ? '#059669' : runEnd ? '#f59e0b' : '#4f46e5',
        ring: true,
        halo: isBest,
      };
    });
  }
  if (props.kind === 'seed') {
    return s.x.map((_, i) => ({
      i,
      cx: sx(s.x[i]),
      cy: sy(s.y[i]),
      r: i === bestIdx ? 5.5 : 4,
      fill: i === bestIdx ? '#059669' : '#4f46e5',
      ring: true,
      halo: i === bestIdx,
    }));
  }
  // wide: mark only the optimum and the far end, so the 86 points stay a line
  return [
    { i: bestIdx, cx: sx(s.x[bestIdx]), cy: sy(s.y[bestIdx]), r: 5, fill: '#059669', ring: true, halo: true },
    {
      i: s.x.length - 1,
      cx: sx(s.x[s.x.length - 1]),
      cy: sy(s.y[s.y.length - 1]),
      r: 4.5,
      fill: '#f59e0b',
      ring: true,
    },
  ];
});

const annotations = computed<Annotation[]>(() => {
  const s = series.value;

  if (props.kind === 'sawtooth' && s) {
    // The RIGHTMOST upward step, so the bracket's leader into the right gutter stays short. The
    // last pair is not necessarily a jump: the sweep can end mid-descent, which read as "+-1.17".
    let i = -1;
    for (let k = 0; k < s.y.length - 1; k++) if (s.y[k + 1] > s.y[k]) i = k;
    if (i < 0) return [];
    const ya = sy(s.y[i]);
    const yb = sy(s.y[i + 1]);
    const bx = X1.value + 26;
    const bestIdx = s.y.indexOf(Math.min(...s.y));
    return [
      {
        d: `M${sx(s.x[i])} ${ya} L${bx} ${ya} M${sx(s.x[i + 1])} ${yb} L${bx} ${yb} M${bx} ${ya} L${bx} ${yb}`,
        stroke: '#f59e0b',
        text: `+${(s.y[i + 1] - s.y[i]).toFixed(2)} d`,
        sub: 'one missed sale',
        tx: bx + 7,
        ty: (ya + yb) / 2 - 1,
        fill: '#b45309',
      },
      {
        text: `${s.y[bestIdx].toFixed(3)} d`,
        tx: sx(s.x[bestIdx]),
        ty: sy(s.y[bestIdx]) + 26,
        anchor: 'middle',
        fill: '#059669',
      },
    ];
  }

  if (props.kind === 'wide' && s) {
    const bi = s.y.indexOf(Math.min(...s.y));
    const li = s.x.length - 1;
    return [
      {
        d: `M${sx(s.x[bi])} ${sy(s.y[bi])} L${sx(s.x[li])} ${sy(s.y[bi])} M${sx(s.x[li])} ${sy(s.y[bi])} L${sx(s.x[li])} ${sy(s.y[li])}`,
        stroke: '#f59e0b',
        text: `+${(s.y[li] - s.y[bi]).toFixed(1)} d`,
        sub: 'at X = 340',
        tx: sx(s.x[li]) + 8,
        ty: sy(s.y[li]) - 4,
        fill: '#b45309',
      },
      {
        text: `X = ${s.x[bi]} · ${s.y[bi].toFixed(1)} d`,
        tx: sx(s.x[bi]),
        ty: sy(s.y[bi]) - 14,
        anchor: 'middle',
        fill: '#059669',
      },
    ];
  }

  if (props.kind === 'seed' && s) {
    const bi = s.y.indexOf(Math.min(...s.y));
    const wi = s.y.indexOf(Math.max(...s.y));
    return [
      {
        d: `M${X0.value} ${sy(s.y[bi])} L${X1.value} ${sy(s.y[bi])}`,
        stroke: '#059669',
      },
      {
        text: `${(s.y[wi] - s.y[bi]).toFixed(1)} days between the best and worst seed`,
        tx: X0.value + 4,
        ty: Y0.value - 22,
        fill: '#334155',
        size: 11.5,
      },
      {
        // To the RIGHT of the minimum, where the series runs low and flat. Centred above it lands
        // on the steep segment descending into the minimum.
        text: `best seed ${s.x[bi]} → ${s.y[bi].toFixed(1)} d`,
        tx: sx(s.x[bi]) + 12,
        ty: sy(s.y[bi]) + 16,
        anchor: 'start',
        fill: '#059669',
        size: 10.5,
      },
    ];
  }

  if (props.kind === 'distribution') {
    const cut = DISTRIBUTION.best + 1;
    return [
      {
        d: `M${sx(cut)} ${Y0.value - 30} L${sx(cut)} ${Y1.value}`,
        stroke: '#059669',
      },
      {
        text: `${DISTRIBUTION.within1} chains, 0.50%`,
        sub: 'everything within a day of optimal is left of this line',
        tx: sx(cut) + 8,
        ty: Y0.value - 34,
        fill: '#059669',
        size: 12,
      },
      {
        d: `M${sx(DISTRIBUTION.median)} ${Y0.value} L${sx(DISTRIBUTION.median)} ${Y1.value}`,
        stroke: '#64748b',
        text: `median ${DISTRIBUTION.median.toFixed(1)} d`,
        tx: sx(DISTRIBUTION.median) + 7,
        ty: Y0.value - 6,
        fill: '#475569',
        size: 10.5,
      },
    ];
  }

  return [];
});
</script>
