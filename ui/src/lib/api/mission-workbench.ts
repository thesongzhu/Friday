import { apiClient } from "./client";
import type { MissionWorkbenchSnapshot } from "@/lib/mission-workbench/mission-workbench-contract";

interface GetMissionWorkbenchSnapshotResponse {
  snapshot: MissionWorkbenchSnapshot;
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

export const missionWorkbenchApi = {
  async getSnapshot(missionId?: string): Promise<MissionWorkbenchSnapshot> {
    const path = missionId
      ? `/v1/mission-spine/workbench?missionId=${encodeURIComponent(missionId)}`
      : "/v1/mission-spine/workbench";
    const data = await apiClient.get<GetMissionWorkbenchSnapshotResponse>(path);
    return data.snapshot;
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
};
