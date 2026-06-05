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

export interface FridayMissionSpineWorkbenchWorkItem {
  id: string;
  title: string;
  state: FridayMissionSpineLifecycleState;
  owner: FridayMissionSpineTruthLabel;
  proofRef?: string;
  done: boolean;
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
    alternatives: string[];
    truthLabel: FridayMissionSpineTruthLabel;
  };
  providerReceiptRefs: string[];
  channelReceiptRefs: string[];
  workItems: FridayMissionSpineWorkbenchWorkItem[];
  timelinePages: FridayMissionSpineWorkbenchTimelinePage[];
  memoryCandidates: FridayMissionSpineWorkbenchMemoryCandidate[];
  capabilityStates: FridayMissionSpineWorkbenchCapabilityState[];
  transcriptSections: FridayMissionSpineTranscriptSection[];
}

export interface FridayMissionSpineWorkbenchResponse {
  snapshot: FridayMissionSpineWorkbenchSnapshot;
}
