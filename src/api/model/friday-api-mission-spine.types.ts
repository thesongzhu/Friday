export type FridayMissionSpineTruthLabel =
  | "friday_owned"
  | "friday_adopted"
  | "observed_only"
  | "linked_only"
  | "unknown";

export type FridayMissionSpineSurfaceKind = "mobile" | "desktop" | "telegram" | "timeline";

export type FridayMissionSpineLifecycleState =
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

export type FridayMissionSpineRuntimeFeedStatus =
  | "live_rust_hub_projection"
  | "pending_rust_hub_projection";

export type FridayMissionSpineWorkItemRecoveryKind =
  | "none"
  | "dispatchable"
  | "in_flight"
  | "needs_operator"
  | "retryable"
  | "terminal";

export interface FridayMissionSpineWorkbenchWorkItem {
  id: string;
  title: string;
  state: FridayMissionSpineLifecycleState;
  owner: FridayMissionSpineTruthLabel;
  proofRef?: string;
  done: boolean;
  blockingReason: string;
  recoveryKind: FridayMissionSpineWorkItemRecoveryKind;
  canRetry: boolean;
  canCancel: boolean;
}

export interface FridayMissionSpineWorkbenchTimelinePage {
  page: number;
  cursor: string;
  nextCursor?: string;
  eventRefs: string[];
}

export interface FridayMissionSpineWorkbenchMemoryCandidate {
  id: string;
  preview: string;
  state: "candidate_review_only";
  grantsMemoryAuthority: false;
  evidenceRef: string;
}

export type FridayMissionSpineCapabilityKind = "skill" | "capability" | "advisor";

export type FridayMissionSpineApprovalState =
  | "not_required"
  | "required"
  | "approved"
  | "blocked";

export interface FridayMissionSpineWorkbenchCapabilityState {
  id: string;
  label: string;
  kind: FridayMissionSpineCapabilityKind;
  truthLabel: FridayMissionSpineTruthLabel;
  approvalState: FridayMissionSpineApprovalState;
  dispatchAllowed: boolean;
  summary: string;
  proofRef: string;
}

export type FridayMissionSpineRouteActionTargetKind = "file" | "command" | "subtask";

export type FridayMissionSpineRouteActionReversibility =
  | "reversible_git_worktree"
  | "operator_gate_required"
  | "pending_classify";

export interface FridayMissionSpineRouteActionItem {
  description: string;
  targetKind: FridayMissionSpineRouteActionTargetKind;
  targetRef: string;
  reversibility: FridayMissionSpineRouteActionReversibility;
  assignedLane: string;
  assignedProviderOrAgent?: string | null;
  routeReason: string;
}

export type FridayMissionSpineTranscriptGroupKind =
  | "mission"
  | "work_item"
  | "provider_session"
  | "skill_run"
  | "channel_task"
  | "workflow"
  | "surface"
  | "status"
  | "time";

export interface FridayMissionSpineTranscriptEvidenceRefs {
  providerRef?: string;
  skillRunRef?: string;
  channelRef?: string;
  workflowRef?: string;
  surfaceThreadRef?: string;
  timelineRef?: string;
  proofReceiptRef?: string;
}

export interface FridayMissionSpineTranscriptEvent {
  id: string;
  missionId: string;
  workItemId?: string;
  surface: FridayMissionSpineSurfaceKind;
  status: FridayMissionSpineLifecycleState;
  truthLabel: FridayMissionSpineTruthLabel;
  summary: string;
  proofRef?: string;
  evidenceRefs: FridayMissionSpineTranscriptEvidenceRefs;
  capturedAt: string;
}

export interface FridayMissionSpineTranscriptSection {
  id: string;
  title: string;
  groupKind: FridayMissionSpineTranscriptGroupKind;
  missionId: string;
  workItemId?: string;
  truthLabel: FridayMissionSpineTruthLabel;
  status: FridayMissionSpineLifecycleState;
  events: FridayMissionSpineTranscriptEvent[];
}

export interface FridayMissionSpineT3ProvisioningStatus {
  truthLabel: "rust_hub_t3_provisioning_read_only_no_mint";
  paired: boolean;
  deviceIdentityCount: number;
  trustedDeviceCount: number;
  activeTrustedDeviceCount: number;
  trustGrantCount: number;
  activeTrustGrantCount: number;
  contextPassportCount: number;
  contextPassportItemCount: number;
  latestDevice?: {
    deviceId: string;
    label: string;
    pairedAt: number;
    revokedAt?: number | null;
    keyRotatedAt?: number | null;
    pubkeyFingerprint: string;
  } | null;
}

export interface FridayMissionSpineWorkbenchSnapshot {
  missionId: string;
  fridayConversationId: string;
  runtimeFeedStatus: FridayMissionSpineRuntimeFeedStatus;
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
    actionItems: FridayMissionSpineRouteActionItem[];
    truthLabel: FridayMissionSpineTruthLabel;
  };
  providerReceiptRefs: string[];
  channelReceiptRefs: string[];
  workItems: FridayMissionSpineWorkbenchWorkItem[];
  timelinePages: FridayMissionSpineWorkbenchTimelinePage[];
  memoryCandidates: FridayMissionSpineWorkbenchMemoryCandidate[];
  capabilityStates: FridayMissionSpineWorkbenchCapabilityState[];
  t3ProvisioningStatus?: FridayMissionSpineT3ProvisioningStatus;
  transcriptSections: FridayMissionSpineTranscriptSection[];
}

export interface FridayMissionSpineWorkbenchResponse {
  snapshot: FridayMissionSpineWorkbenchSnapshot;
}
