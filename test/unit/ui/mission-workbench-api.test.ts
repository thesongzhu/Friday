import { beforeEach, describe, expect, it, vi } from "vitest";
import { missionWorkbenchApi } from "../../../ui/src/lib/api/mission-workbench";
import { apiClient } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

describe("missionWorkbenchApi", () => {
  const snapshot = {
    missionId: "mission_capture_target",
    fridayConversationId: "conversation_capture_target",
    runtimeFeedStatus: "live_rust_hub_projection",
  };

  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
  });

  it("reads the latest Mission Workbench snapshot when no mission id is supplied", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ snapshot });

    await expect(missionWorkbenchApi.getSnapshot()).resolves.toEqual(snapshot);

    expect(apiClient.get).toHaveBeenCalledWith("/v1/mission-spine/workbench");
  });

  it("passes the operator capture mission id to the Mission Workbench route", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ snapshot });

    await expect(missionWorkbenchApi.getSnapshot("mission_capture/target space?")).resolves.toEqual(
      snapshot,
    );

    expect(apiClient.get).toHaveBeenCalledWith(
      "/v1/mission-spine/workbench?missionId=mission_capture%2Ftarget%20space%3F",
    );
  });
});
