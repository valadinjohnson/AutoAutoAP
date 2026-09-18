/**
 * Default the plan start to the moment the backup was taken, not to `now`.
 *
 * EXTRACTED FROM AutomaticPlanner SO INSANE MODE GETS IT TOO. It used to live inside that
 * component, which means it only ran when that component was mounted -- and Insane mode REPLACES
 * the Auto Planner rather than sitting beside it, so an exhaustive run never got the default at
 * all. Every number that panel prints is a date computed from the plan start, so the one mode
 * where the sync mattered most was the one mode that did not have it.
 *
 * The rule and the reasoning live in `lib/planStartTime.ts`, which is tested directly; this only
 * converts between its unix seconds and the date/time input strings the form holds.
 *
 * `startDefaulted` is MODULE-LEVEL, not per-caller. It expresses "this session has already taken a
 * default from a backup", and that has to stay true across a switch from one panel to the other --
 * per-instance state would re-apply the backup's time and silently overwrite a start the player
 * typed on the other panel a moment earlier.
 */
import { watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useAutoPlannerStore } from '@/stores/autoPlanner';
import { useInitialStateStore } from '@/stores/initialState';
import { resolvePlanStart } from '@/lib/planStartTime';
import { formatUnixToDateInput, formatUnixToTimeInput } from '@/lib/format';
import { getLocalTimestampInTimezone } from '@/lib/events';

let startDefaulted = false;

/** Testing hook: forget that a default was taken. Not used by the app. */
export function resetBackupPlanStart(): void {
  startDefaulted = false;
}

export function useBackupPlanStart(): void {
  const autoPlannerStore = useAutoPlannerStore();
  const initialStateStore = useInitialStateStore();
  const { timezone, startDate, startTime } = storeToRefs(autoPlannerStore);

  watch(
    () => initialStateStore.rawBackup?.approxTime,
    approxTime => {
      if (startDefaulted) return;
      const backupSeconds = typeof approxTime === 'number' ? approxTime : null;
      const currentSeconds =
        startDate.value && startTime.value
          ? getLocalTimestampInTimezone(startDate.value, startTime.value, timezone.value)
          : null;

      const resolved = resolvePlanStart({ backupSeconds, currentSeconds, nowSeconds: Date.now() / 1000 });
      if (resolved !== null) {
        startDate.value = formatUnixToDateInput(resolved, timezone.value);
        startTime.value = formatUnixToTimeInput(resolved, timezone.value);
      }
      // Without a usable backup there is nothing better to sync to, so stay open to a later one.
      if (backupSeconds !== null && backupSeconds > 0) startDefaulted = true;
    },
    { immediate: true }
  );
}
