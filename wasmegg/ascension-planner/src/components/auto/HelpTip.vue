<!--
  A "?" that explains a term on hover or focus.

  TELEPORTED TO <body>, WITH FIXED COORDINATES. The first version put the bubble in an
  absolutely-positioned span next to the button, which works everywhere except the one place these
  are most needed: the leg table lives inside `overflow-x-auto`, and an element with a non-visible
  overflow on either axis clips its descendants on BOTH. The tooltip on "Night shifts" rendered as a
  dark sliver poking out of the top of the table, unreadable. Teleporting escapes every ancestor's
  clipping and stacking context at once; the cost is having to position it ourselves.

  Deliberately not `title=""`: the native tooltip takes about a second to appear, cannot be reached
  from the keyboard, is invisible on touch, and cannot wrap a sentence legibly — and the things this
  panel explains ("2-sale-tier13", "peak delivery", "prestige wait") are sentences.
-->
<template>
  <span class="relative inline-flex align-middle">
    <button
      ref="trigger"
      type="button"
      class="w-3.5 h-3.5 rounded-full border border-slate-300 text-slate-400 text-[9px] font-black leading-none flex items-center justify-center hover:border-slate-500 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-400"
      :aria-describedby="open ? id : undefined"
      aria-label="What does this mean?"
      @mouseenter="show"
      @mouseleave="open = false"
      @focus="show"
      @blur="open = false"
      @click.prevent="open ? (open = false) : show()"
    >
      ?
    </button>

    <Teleport to="body">
      <span
        v-if="open"
        :id="id"
        role="tooltip"
        class="pointer-events-none fixed z-[9999] w-64 rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-medium normal-case tracking-normal leading-relaxed text-slate-100 shadow-xl"
        :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      >
        <slot />
      </span>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import { nextTick, ref, useId } from 'vue';

/** One id per instance so `aria-describedby` points at THIS bubble, not the first on the page. */
const id = `helptip-${useId()}`;

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const pos = ref({ left: 0, top: 0 });

/** Bubble width, matching the `w-64` above. Needed as a number to clamp against the viewport. */
const WIDTH = 256;
/** Rough height for the flip decision. Over-estimating only makes it prefer below, which is safe. */
const HEIGHT = 96;
const MARGIN = 8;

async function show(): Promise<void> {
  open.value = true;
  // Wait for the bubble to exist before measuring the trigger, so a resize or scroll that happened
  // since the last hover cannot leave it pinned to a stale position.
  await nextTick();
  const el = trigger.value;
  if (!el) return;
  const r = el.getBoundingClientRect();

  // Centred on the trigger, then clamped so it never hangs off either edge — these sit in table
  // headers, and the rightmost column's tooltip would otherwise be half off-screen.
  const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - MARGIN);
  // Above by default; below when there is not room, which is what happens for the first row of a
  // table near the top of the viewport.
  const above = r.top - HEIGHT - MARGIN;
  pos.value = { left, top: above > MARGIN ? r.top - MARGIN - HEIGHT : r.bottom + MARGIN };
}
</script>
