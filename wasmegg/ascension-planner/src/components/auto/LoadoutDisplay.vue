<!--
  One artifact set, rendered the way the manual planner renders it — icons, rarity-tinted slots,
  the effect badge, the stones — but READ-ONLY.

  `ArtifactSelector` already draws exactly this and was the obvious thing to reuse, except that
  every slot in it is a filterable <select> wired to an `update:modelValue`. Dropping that into the
  search panel would offer to edit a loadout the search does not read: the simulator re-solves its
  own set inside every leg, so a change made here would be silently discarded on the next run. A
  control that appears to do something and does not is worse than a picture.

  So this is a picture. It copies `getSlotBackgroundStyle`'s rarity tints verbatim, because the
  point of the exercise is that the two cards look like the same thing.
-->
<template>
  <div class="space-y-1.5">
    <div
      v-for="(slot, i) in filled"
      :key="i"
      class="rounded-xl border border-slate-200/70 p-2.5"
      :style="slotBackground(slot.artifactId)"
    >
      <div class="flex items-center gap-2.5">
        <span
          class="text-[10px] font-black text-slate-400 w-5 h-5 shrink-0 flex items-center justify-center bg-white/60 rounded-full shadow-inner"
          >{{ i + 1 }}</span
        >
        <img
          v-if="artifact(slot.artifactId)"
          :src="iconURL(artifact(slot.artifactId)!.iconPath, 64)"
          :alt="artifact(slot.artifactId)!.label"
          class="w-7 h-7 object-contain shrink-0"
        />
        <span class="text-xs font-bold text-slate-800 truncate">
          {{ artifact(slot.artifactId)?.label ?? 'empty slot' }}
        </span>
        <span
          v-if="artifact(slot.artifactId)"
          class="ml-auto shrink-0 text-[9px] font-black uppercase tracking-widest text-slate-600 bg-white/70 border border-white rounded-full px-2 py-0.5"
        >
          {{ artifact(slot.artifactId)!.effect }}
        </span>
      </div>

      <div v-if="slot.stones.some(Boolean)" class="flex flex-wrap items-center gap-1.5 mt-2 ml-7">
        <span
          v-for="(id, k) in slot.stones.filter(Boolean)"
          :key="k"
          class="flex items-center gap-1 bg-white/60 border border-white rounded-lg pl-1 pr-2 py-0.5"
          :title="stone(id)?.effect"
        >
          <img v-if="stone(id)" :src="iconURL(stone(id)!.iconPath, 64)" :alt="stone(id)!.label" class="w-4 h-4" />
          <span class="text-[10px] font-bold text-slate-600">{{ stone(id)?.label }}</span>
        </span>
      </div>
    </div>

    <p v-if="!filled.length" class="text-[11px] text-slate-400 italic">nothing equipped</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { iconURL } from 'lib';
import { getArtifact, getStone, type EquippedArtifact } from '@/lib/artifacts';

const props = defineProps<{ loadout: EquippedArtifact[] | null }>();

/** Empty slots carry no information here — this is a readout, not an editor, so a row saying
 *  "empty slot" three times is noise. A set that is entirely empty falls through to the italic
 *  line instead. */
const filled = computed(() => (props.loadout ?? []).filter(s => s.artifactId));

const artifact = (id: string | null) => getArtifact(id);
const stone = (id: string | null) => getStone(id);

/** Verbatim from `ArtifactSelector.getSlotBackgroundStyle` — same tints, so the two cards read as
 *  the same component even though they are not. */
function slotBackground(artifactId: string | null): Record<string, string> {
  switch (getArtifact(artifactId)?.rarity) {
    case 1:
      return { backgroundColor: '#0D6DFD30' };
    case 2:
      return { backgroundColor: '#FF00FF30' };
    case 3:
      return { backgroundColor: '#FECD1B40' };
    default:
      return { backgroundColor: 'white' };
  }
}
</script>
