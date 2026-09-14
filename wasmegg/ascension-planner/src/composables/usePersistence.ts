import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useActionsStore } from '@/stores/actions';
import { hashID, saveMetadata, loadMetadata } from '@/lib/storage/db';
import { exportPlanData } from '@/stores/actions/io';

const SYNC_CHANNEL_NAME = 'ascension_sync';
const partitionHash = ref('');
const isSyncing = ref(false);

/**
 * `BroadcastChannel` and `sessionStorage` are resolved on first use, not at import.
 *
 * Both used to be evaluated at module scope, which made this module impossible to import outside a
 * browser. That is not only a test concern, though it showed up as one first: this file sits in
 * the import graph of `useAscensionGenerator`, so every spec that reached that graph failed to
 * collect under vitest's `node` environment, and the whole file's tests were lost rather than a
 * single case failing. The same would happen in a web worker or any pre-render.
 *
 * Both accessors degrade instead of throwing. Cross-tab sync is a convenience; a context without
 * these globals has no other tabs to sync with, so doing nothing is the correct behaviour there.
 */
let channelInstance: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channelInstance) channelInstance = new BroadcastChannel(SYNC_CHANNEL_NAME);
  return channelInstance;
}

let sessionIdValue = '';
function getSessionId(): string {
  if (sessionIdValue) return sessionIdValue;
  const generated = Math.random().toString(36).substring(2, 15);
  try {
    const stored = sessionStorage.getItem('ascension_session_id');
    if (stored) {
      sessionIdValue = stored;
      return sessionIdValue;
    }
    sessionStorage.setItem('ascension_session_id', generated);
  } catch {
    // Private mode, blocked storage, or no DOM at all. An in-memory id is still unique for this
    // page's lifetime, which is all the draft key below actually needs.
  }
  sessionIdValue = generated;
  return sessionIdValue;
}

let lastSyncedDataStr = '';
let channelListenerAttached = false;

// ── Heartbeat tracking (centralized, shared across all consumers) ──
const busyPlanLastSeen = ref<Record<string, number>>({});

/**
 * Reactive set of plan IDs that are currently open in OTHER tabs.
 * Consumers (PlanLibrary, PlanSelectionDialog) import this directly.
 */
const busyPlanIds = computed(() => {
  const now = Date.now();
  const active = new Set<string>();
  for (const [id, lastSeen] of Object.entries(busyPlanLastSeen.value)) {
    if (now - lastSeen < 2500) {
      active.add(id);
    }
  }
  return active;
});

/**
 * Broadcast presence of the currently active plan to other tabs.
 */
function broadcastPresence(planIdOverride?: string | null) {
  const actionsStore = useActionsStore();
  const planId = planIdOverride !== undefined ? planIdOverride : actionsStore.activePlanId;

  if (planId && partitionHash.value) {
    getChannel()?.postMessage({
      type: 'PLAN_HEARTBEAT',
      planId,
      partitionHash: partitionHash.value,
    });
  }
}

// ── Channel message handler (single, centralized) ──
const handleMessage = (event: MessageEvent) => {
  // 1. Library sync
  if (event.data.type === 'LIBRARY_UPDATED' && event.data.partitionHash === partitionHash.value) {
    const actionsStore = useActionsStore();
    actionsStore.libraryUpdateTick++;
  }

  // 2. Heartbeat from another tab — track it
  if (event.data.type === 'PLAN_HEARTBEAT' && event.data.partitionHash === partitionHash.value) {
    busyPlanLastSeen.value = {
      ...busyPlanLastSeen.value,
      [event.data.planId]: Date.now(),
    };
  }

  // 3. Query from another tab — respond with our presence
  if (event.data.type === 'PLAN_QUERY' && event.data.partitionHash === partitionHash.value) {
    broadcastPresence();
  }
};

// ── Draft persistence ──
async function loadActiveDraft() {
  if (!partitionHash.value) return;

  const draft = await loadMetadata(partitionHash.value, `active_draft_${getSessionId()}`);
  if (draft) {
    isSyncing.value = true;
    try {
      const actionsStore = useActionsStore();
      await actionsStore.importPlan(JSON.stringify(draft), true, true);

      const planData = exportPlanData(actionsStore.actions, actionsStore.initialSnapshot);
      const dataForComparison = { ...planData, timestamp: 0 };
      lastSyncedDataStr = JSON.stringify(dataForComparison);
    } finally {
      isSyncing.value = false;
    }
  }
}

export function usePersistence() {
  async function initPersistence(eid: string) {
    partitionHash.value = await hashID(eid);
    await loadActiveDraft();
  }

  function broadcastLibraryUpdate() {
    getChannel()?.postMessage({
      type: 'LIBRARY_UPDATED',
      partitionHash: partitionHash.value,
      timestamp: Date.now(),
    });
  }

  async function saveActiveDraft() {
    if (!partitionHash.value || isSyncing.value) return;

    const actionsStore = useActionsStore();
    if (actionsStore.isRecalculating) return;

    const planData = exportPlanData(actionsStore.actions, actionsStore.initialSnapshot, actionsStore.activePlanId);
    const dataForComparison = { ...planData, timestamp: 0 };
    const newDataStr = JSON.stringify(dataForComparison);
    if (newDataStr === lastSyncedDataStr) return;

    lastSyncedDataStr = newDataStr;
    await saveMetadata(partitionHash.value, `active_draft_${getSessionId()}`, planData);
  }

  /**
   * Ask other tabs to identify themselves immediately.
   */
  function queryOtherTabs() {
    if (partitionHash.value) {
      getChannel()?.postMessage({ type: 'PLAN_QUERY', partitionHash: partitionHash.value });
    }
  }

  onMounted(() => {
    // Attach the centralized message handler once
    if (!channelListenerAttached) {
      getChannel()?.addEventListener('message', handleMessage);
      channelListenerAttached = true;
    }

    // Heartbeat interval
    const interval = setInterval(() => broadcastPresence(), 1000);
    onUnmounted(() => clearInterval(interval));

    // Query other tabs on mount
    queryOtherTabs();
  });

  return {
    initPersistence,
    saveActiveDraft,
    broadcastLibraryUpdate,
    broadcastPresence,
    queryOtherTabs,
    busyPlanIds,
    partitionHash,
    sessionId: getSessionId(),
  };
}
