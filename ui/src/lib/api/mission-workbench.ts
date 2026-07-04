import { apiClient } from "./client";
import type { MissionWorkbenchSnapshot } from "@/lib/mission-workbench/mission-workbench-contract";

interface GetMissionWorkbenchSnapshotResponse {
  snapshot: MissionWorkbenchSnapshot;
}

export interface MissionSpineIntakeRequest {
  fridayConversationId: string;
  ownerPrincipal: string;
  surfaceThreadId: string;
  surfaceKind: string;
  deliveryRoute: string;
  visibilityPolicy: string;
  missionId: string;
  workItemId: string;
  title: string;
  intent: string;
  lane: string;
  targetProviderOrAgent?: string;
  capabilityId?: string;
  bodyRef?: string;
  proofRequirements?: string[];
  includesSensitiveContext?: boolean;
}

export interface MissionSpineIntakeResult {
  fridayConversationId: string;
  missionId: string;
  workItemId: string;
  surfaceThreadId: string;
  status: string;
  blockers: string[];
  duplicateMissionId?: string;
  duplicateWorkItemId?: string;
  createdOrReady: boolean;
}

interface MissionSpineIntakeResponse {
  result: MissionSpineIntakeResult;
}

export interface MissionRouteDecisionControlRequest {
  controlKind: "veto" | "override";
  missionId: string;
  workItemId: string;
  overrideLane?: string;
  overrideProviderOrAgent?: string;
  actorRef: string;
  reason: string;
}

export interface MissionRouteDecisionControlResult {
  truthLabel: "rust_wired";
  decisionId: string;
  missionId: string;
  workItemId: string;
  controlKind: "veto" | "override";
  overrideLane?: string;
  overrideProviderOrAgent?: string;
  actorRef: string;
  reason: string;
  updatedAtMs: number;
}

interface ControlMissionRouteDecisionResponse {
  result: MissionRouteDecisionControlResult;
}

export interface MissionWorkItemStatusRequest {
  targetStatus: string;
  actorRef: string;
  reason: string;
  proofReceipt?: string;
}

export interface MissionWorkItemStatusResult {
  truthLabel: "rust_wired";
  workItemId: string;
  status: string;
  actorRef: string;
  reason: string;
  proofReceipt?: string;
  updatedAtMs: number;
}

interface TransitionMissionWorkItemStatusResponse {
  result: MissionWorkItemStatusResult;
}

export interface MemorySpineDecisionRequest {
  memoryId: string;
  ownerPrincipal: string;
  decision: "confirm" | "reject";
}

export interface MemorySpineDecisionResult {
  memoryId: string;
  state: string;
  status: string;
  recallable: boolean;
}

interface MemorySpineDecisionResponse {
  result: MemorySpineDecisionResult;
}

export const missionWorkbenchApi = {
  async getSnapshot(missionId?: string): Promise<MissionWorkbenchSnapshot> {
    const path = missionId
      ? `/v1/mission-spine/workbench?missionId=${encodeURIComponent(missionId)}`
      : "/v1/mission-spine/workbench";
    const data = await apiClient.get<GetMissionWorkbenchSnapshotResponse>(path);
    return data.snapshot;
  },

  async createMissionFromSurface(
    request: MissionSpineIntakeRequest,
  ): Promise<MissionSpineIntakeResult> {
    const data = await apiClient.post<MissionSpineIntakeRequest, MissionSpineIntakeResponse>(
      "/v1/mission-spine/intake",
      request,
    );
    return data.result;
  },

  async controlRouteDecision(
    controlRef: string,
    request: MissionRouteDecisionControlRequest,
  ): Promise<MissionRouteDecisionControlResult> {
    const path = `/v1/mission-spine/route-decisions/${encodeURIComponent(controlRef)}/control`;
    const data = await apiClient.post<
      MissionRouteDecisionControlRequest,
      ControlMissionRouteDecisionResponse
    >(path, request);
    return data.result;
  },

  async transitionWorkItemStatus(
    workItemId: string,
    request: MissionWorkItemStatusRequest,
  ): Promise<MissionWorkItemStatusResult> {
    const path = `/v1/mission-spine/work-items/${encodeURIComponent(workItemId)}/status`;
    const data = await apiClient.post<
      MissionWorkItemStatusRequest,
      TransitionMissionWorkItemStatusResponse
    >(path, request);
    return data.result;
  },

  async decideMemoryCandidate(
    request: MemorySpineDecisionRequest,
  ): Promise<MemorySpineDecisionResult> {
    const data = await apiClient.post<MemorySpineDecisionRequest, MemorySpineDecisionResponse>(
      "/v1/memory-spine/decide",
      request,
    );
    return data.result;
  },
};
