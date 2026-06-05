import { apiClient } from "./client";
import type { MissionWorkbenchSnapshot } from "@/lib/mission-workbench/mission-workbench-contract";

interface GetMissionWorkbenchSnapshotResponse {
  snapshot: MissionWorkbenchSnapshot;
}

export const missionWorkbenchApi = {
  async getSnapshot(missionId?: string): Promise<MissionWorkbenchSnapshot> {
    const path = missionId
      ? `/v1/mission-spine/workbench?missionId=${encodeURIComponent(missionId)}`
      : "/v1/mission-spine/workbench";
    const data = await apiClient.get<GetMissionWorkbenchSnapshotResponse>(path);
    return data.snapshot;
  },
};
