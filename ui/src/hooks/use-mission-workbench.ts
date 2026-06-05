import { useQuery } from "@tanstack/react-query";
import { missionWorkbenchApi } from "@/lib/api/mission-workbench";
import type { MissionWorkbenchSnapshot } from "@/lib/mission-workbench/mission-workbench-contract";

export type MissionWorkbenchSnapshotSource = "live_rust_hub" | "unavailable";

export interface UseMissionWorkbenchSnapshotResult {
  snapshot: MissionWorkbenchSnapshot | null;
  source: MissionWorkbenchSnapshotSource;
  isLoading: boolean;
  isLive: boolean;
  liveUnavailable: boolean;
}

export function useMissionWorkbenchSnapshot(missionId?: string): UseMissionWorkbenchSnapshotResult {
  const query = useQuery({
    queryKey: ["mission-spine", "workbench", "snapshot", missionId ?? "latest"],
    queryFn: () => missionWorkbenchApi.getSnapshot(missionId),
    staleTime: 5_000,
    retry: 1,
  });

  if (query.data) {
    return {
      snapshot: query.data,
      source: "live_rust_hub",
      isLoading: query.isLoading,
      isLive: true,
      liveUnavailable: false,
    };
  }

  return {
    snapshot: null,
    source: "unavailable",
    isLoading: query.isLoading,
    isLive: false,
    liveUnavailable: query.isError,
  };
}
