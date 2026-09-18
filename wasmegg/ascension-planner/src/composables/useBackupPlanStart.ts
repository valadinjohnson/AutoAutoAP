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
 *
 * THE PROVISIONAL "NOW" AND WHY IT IS TRACKED. The first pass usually runs before the backup has
 * finished loading, and with no backup and an empty form `resolvePlanStart` answers `nowSeconds` --
 * a sensible placeholder on its own. But writing it into the form creates a start LATER than the
 * backup that arrives a second afterwards, and "a start after the backup" is a case
 * `resolvePlanStart` deliberately leaves alone, because asking to begin a plan tomorrow morning is
 * legitimate. So the placeholder blocked the very sync it was standing in for: measured on a fresh
 * page, the form read 09:45 today against a backup taken 21:21 the night before, and the plan was
 * timed from the page load rather than from the save.
 *
 * The fix is to remember the exact strings written as a placeholder. If the form still holds them
 * when a backup arrives, nobody has chosen anything and the backup wins. If it holds anything else,
 * the player typed a start and it is theirs -- which is the distinction `resolvePlanStart` cannot
 * make on its own, because by then both look like "a value that is later than the backup".
 */
import { watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useAutoPlannerStore } from '@/stores/autoPlanner';
import { useInitialStateStore } from '@/stores/initialState';
import { resolvePlanStart } from '@/lib/planStartTime';
import { formatUnixToDateInput, formatUnixToTimeInput } from '@/lib/format';
import { getLocalTimestampInTimezone } from '@/lib/events';

let startDefaulted = false;
/** The date/time this module last wrote as a placeholder, or null once a human has touched it. */
let provisional: { date: string; time: string } | null = null;

/** Testing hook: forget that a default was taken. Not used by the app. */
export function resetBackupPlanStart(): void {
  startDefaulted = false;
  provisional = null;
}

export function useBackupPlanStart(): void {
  const autoPlannerStore = useAutoPlannerStore();
  const initialStateStore = useInitialStateStore();
  const { timezone, startDate, startTime } = storeToRefs(autoPlannerStore);

  const write = (seconds: number, asPlaceholder: boolean): void => {
    startDate.value = formatUnixToDateInput(seconds, timezone.value);
    startTime.value = formatUnixToTimeInput(seconds, timezone.value);
    provisional = asPlaceholder ? { date: startDate.value, time: startTime.value } : null;
  };

  /** True when the form still holds exactly what this module last wrote as a placeholder. */
  const untouched = (): boolean =>
    provisional !== null && provisional.date === startDate.value && provisional.time === startTime.value;

  watch(
    () => initialStateStore.rawBackup?.approxTime,
    approxTime => {
      if (startDefaulted) return;
      const backupSeconds = typeof approxTime === 'number' ? approxTime : null;
      const usableBackup = backupSeconds !== null && Number.isFinite(backupSeconds) && backupSeconds > 0;

      // A backup arriving over an untouched placeholder replaces it outright, bypassing
      // `resolvePlanStart`'s "a later start is the player's choice" rule -- it was not a choice.
      if (usableBackup && untouched()) {
        write(backupSeconds, false);
        startDefaulted = true;
        return;
      }

      const currentSeconds =
        startDate.value && startTime.value
          ? getLocalTimestampInTimezone(startDate.value, startTime.value, timezone.value)
          : null;

      const resolved = resolvePlanStart({ backupSeconds, currentSeconds, nowSeconds: Date.now() / 1000 });
      // Written as a placeholder only when it is the `nowSeconds` fallback -- i.e. there was no
      // backup to sync to. Anything derived from a real backup is a decision, not a stand-in.
      if (resolved !== null) write(resolved, !usableBackup);
      // Without a usable backup there is nothing better to sync to, so stay open to a later one.
      if (usableBackup) startDefaulted = true;
    },
    { immediate: true }
  );
}
