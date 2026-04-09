import type { FridayCrossBorderSnapshot } from "../../../../src/packs/cross-border/friday-cross-border-pack.types";

const CROSS_BORDER_ASSISTANT_SNAPSHOT_STORAGE_KEY = "friday.cross-border.assistant-navigation-snapshot";

function readStoredSnapshot(): FridayCrossBorderSnapshot | undefined {
  if (typeof window === "undefined" || !window.sessionStorage) {
    return undefined;
  }
  try {
    const raw = window.sessionStorage.getItem(CROSS_BORDER_ASSISTANT_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as FridayCrossBorderSnapshot;
    return parsed?.profile ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function persistCrossBorderAssistantNavigationSnapshot(
  snapshot: FridayCrossBorderSnapshot | undefined,
): void {
  if (typeof window === "undefined" || !window.sessionStorage) {
    return;
  }
  try {
    if (!snapshot?.profile) {
      window.sessionStorage.removeItem(CROSS_BORDER_ASSISTANT_SNAPSHOT_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(
      CROSS_BORDER_ASSISTANT_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    // Best-effort only. Assistant can still rely on live snapshot queries.
  }
}

export function readNavigationCrossBorderSnapshot(value: unknown): FridayCrossBorderSnapshot | undefined {
  if (!value || typeof value !== "object" || !("crossBorderSnapshot" in value)) {
    return readStoredSnapshot();
  }
  const snapshot = (value as { crossBorderSnapshot?: FridayCrossBorderSnapshot }).crossBorderSnapshot;
  if (snapshot?.profile) {
    persistCrossBorderAssistantNavigationSnapshot(snapshot);
    return snapshot;
  }
  return readStoredSnapshot();
}

export function buildCrossBorderAssistantNavigationState(
  snapshot: FridayCrossBorderSnapshot | undefined,
) {
  if (!snapshot?.profile) {
    return undefined;
  }
  return {
    crossBorderSnapshot: snapshot,
  };
}

export function mergeCrossBorderSnapshots(
  seededSnapshot: FridayCrossBorderSnapshot | undefined,
  liveSnapshot: FridayCrossBorderSnapshot | undefined,
): FridayCrossBorderSnapshot | undefined {
  if (!seededSnapshot) {
    return liveSnapshot;
  }
  if (!liveSnapshot || !liveSnapshot.profile) {
    return seededSnapshot;
  }

  const mergedWorkflowIds = new Set<string>([
    ...seededSnapshot.workflowRecommendations.map((workflow) => workflow.id),
    ...liveSnapshot.workflowRecommendations.map((workflow) => workflow.id),
  ]);

  const workflowRecommendations = Array.from(mergedWorkflowIds).map((workflowId) => {
    const liveWorkflow = liveSnapshot.workflowRecommendations.find((workflow) => workflow.id === workflowId);
    const seededWorkflow = seededSnapshot.workflowRecommendations.find((workflow) => workflow.id === workflowId);
    if (!liveWorkflow) {
      return seededWorkflow!;
    }
    if (!seededWorkflow?.automation || liveWorkflow.automation) {
      return liveWorkflow;
    }
    return {
      ...liveWorkflow,
      automation: seededWorkflow.automation,
    };
  });

  return {
    ...liveSnapshot,
    workflowRecommendations,
  };
}
