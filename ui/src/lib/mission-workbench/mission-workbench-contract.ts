export type MissionTruthLabel =
  | "friday_owned"
  | "friday_adopted"
  | "observed_only"
  | "linked_only"
  | "unknown";

export type MissionSurfaceKind = "mobile" | "desktop" | "telegram" | "timeline";

export type MissionLifecycleState =
  | "ready"
  | "queued"
  | "provider_ack"
  | "waiting"
  | "stale"
  | "reconnecting"
  | "timeline_read"
  | "completed_with_proof"
  | "blocked"
  | "error";

export type MissionWorkbenchRuntimeFeedStatus =
  | "live_rust_hub_projection"
  | "pending_rust_hub_projection";

export type MissionWorkItemRecoveryKind =
  | "none"
  | "dispatchable"
  | "in_flight"
  | "needs_operator"
  | "retryable"
  | "terminal";

export interface MissionWorkbenchWorkItem {
  id: string;
  title: string;
  state: MissionLifecycleState;
  owner: MissionTruthLabel;
  proofRef?: string;
  done: boolean;
  blockingReason: string;
  recoveryKind: MissionWorkItemRecoveryKind;
  canRetry: boolean;
  canCancel: boolean;
}

export interface MissionWorkbenchTimelinePage {
  page: number;
  cursor: string;
  nextCursor?: string;
  eventRefs: string[];
}

export interface MissionWorkbenchMemoryCandidate {
  id: string;
  preview: string;
  state: "candidate_review_only";
  grantsMemoryAuthority: false;
  evidenceRef: string;
}

export type MissionWorkbenchCapabilityKind = "skill" | "capability" | "advisor";

export type MissionWorkbenchApprovalState =
  | "not_required"
  | "required"
  | "approved"
  | "blocked";

export interface MissionWorkbenchCapabilityState {
  id: string;
  label: string;
  kind: MissionWorkbenchCapabilityKind;
  truthLabel: MissionTruthLabel;
  approvalState: MissionWorkbenchApprovalState;
  dispatchAllowed: boolean;
  summary: string;
  proofRef: string;
}

export type MissionRouteActionTargetKind = "file" | "command" | "subtask";

export type MissionRouteActionReversibility =
  | "reversible_git_worktree"
  | "operator_gate_required"
  | "pending_classify";

export interface MissionRouteActionItem {
  description: string;
  targetKind: MissionRouteActionTargetKind;
  targetRef: string;
  reversibility: MissionRouteActionReversibility;
  assignedLane: string;
  assignedProviderOrAgent?: string | null;
  routeReason: string;
}

export type MissionTranscriptGroupKind =
  | "mission"
  | "work_item"
  | "provider_session"
  | "skill_run"
  | "channel_task"
  | "workflow"
  | "surface"
  | "status"
  | "time";

export interface MissionTranscriptEvidenceRefs {
  providerRef?: string;
  skillRunRef?: string;
  channelRef?: string;
  workflowRef?: string;
  surfaceThreadRef?: string;
  timelineRef?: string;
  proofReceiptRef?: string;
}

export interface MissionTranscriptEvent {
  id: string;
  missionId: string;
  workItemId?: string;
  surface: MissionSurfaceKind;
  status: MissionLifecycleState;
  truthLabel: MissionTruthLabel;
  summary: string;
  proofRef?: string;
  evidenceRefs: MissionTranscriptEvidenceRefs;
  capturedAt: string;
}

export interface MissionTranscriptSection {
  id: string;
  title: string;
  groupKind: MissionTranscriptGroupKind;
  missionId: string;
  workItemId?: string;
  truthLabel: MissionTruthLabel;
  status: MissionLifecycleState;
  events: MissionTranscriptEvent[];
}

export interface MissionWorkbenchSnapshot {
  missionId: string;
  fridayConversationId: string;
  runtimeFeedStatus: MissionWorkbenchRuntimeFeedStatus;
  statusLabels: Array<"stale" | "offline" | "error">;
  duplicatePreflight: {
    status: "opens_existing_mission";
    duplicateMissionId: string;
    duplicateWorkItemId: string;
  };
  routeDecision: {
    advisorSummary: string;
    selectedRoute: string;
    controlRef: string;
    workItemId: string;
    alternatives: string[];
    actionItems: MissionRouteActionItem[];
    truthLabel: MissionTruthLabel;
  };
  providerReceiptRefs: string[];
  channelReceiptRefs: string[];
  workItems: MissionWorkbenchWorkItem[];
  timelinePages: MissionWorkbenchTimelinePage[];
  memoryCandidates: MissionWorkbenchMemoryCandidate[];
  capabilityStates: MissionWorkbenchCapabilityState[];
  transcriptSections: MissionTranscriptSection[];
}
