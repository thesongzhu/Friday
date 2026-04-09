import type { FridayCrossBorderSnapshot } from "../../../../src/packs/cross-border/friday-cross-border-pack.types";

export function readNavigationCrossBorderSnapshot(value: unknown): FridayCrossBorderSnapshot | undefined {
  if (!value || typeof value !== "object" || !("crossBorderSnapshot" in value)) {
    return undefined;
  }
  const snapshot = (value as { crossBorderSnapshot?: FridayCrossBorderSnapshot }).crossBorderSnapshot;
  return snapshot?.profile ? snapshot : undefined;
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
