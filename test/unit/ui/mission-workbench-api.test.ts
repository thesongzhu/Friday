import { beforeEach, describe, expect, it, vi } from "vitest";
import { missionWorkbenchApi } from "../../../ui/src/lib/api/mission-workbench";
import { apiClient } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
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
    vi.mocked(apiClient.post).mockReset();
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

  it("posts route-decision controls through the encoded projection ref", async () => {
    const result = {
      truthLabel: "rust_wired",
      decisionId: "route-decision-1",
      missionId: "mission_capture_target",
      workItemId: "work_capture_target",
      controlKind: "veto",
      actorRef: "operator:mission-workbench",
      reason: "operator workbench route control",
      updatedAtMs: 1_700_000_000_000,
    };
    vi.mocked(apiClient.post).mockResolvedValue({ result });

    await expect(
      missionWorkbenchApi.controlRouteDecision(
        "friday://route-decision-projection/mission_capture_target/work_capture_target/1700000000000",
        {
          controlKind: "veto",
          missionId: "mission_capture_target",
          workItemId: "work_capture_target",
          actorRef: "operator:mission-workbench",
          reason: "operator workbench route control",
        },
      ),
    ).resolves.toEqual(result);

    expect(apiClient.post).toHaveBeenCalledWith(
      "/v1/mission-spine/route-decisions/friday%3A%2F%2Froute-decision-projection%2Fmission_capture_target%2Fwork_capture_target%2F1700000000000/control",
      {
        controlKind: "veto",
        missionId: "mission_capture_target",
        workItemId: "work_capture_target",
        actorRef: "operator:mission-workbench",
        reason: "operator workbench route control",
      },
    );
  });

  it("posts WorkItem recovery status transitions through the encoded WorkItem id", async () => {
    const result = {
      truthLabel: "rust_wired",
      workItemId: "work/retry target",
      status: "ready_to_dispatch",
      actorRef: "operator:mission-workbench",
      reason: "operator requested retry from Mission Workbench recovery surface",
      updatedAtMs: 1_700_000_000_000,
    };
    vi.mocked(apiClient.post).mockResolvedValue({ result });

    await expect(
      missionWorkbenchApi.transitionWorkItemStatus("work/retry target", {
        targetStatus: "ready_to_dispatch",
        actorRef: "operator:mission-workbench",
        reason: "operator requested retry from Mission Workbench recovery surface",
      }),
    ).resolves.toEqual(result);

    expect(apiClient.post).toHaveBeenCalledWith(
      "/v1/mission-spine/work-items/work%2Fretry%20target/status",
      {
        targetStatus: "ready_to_dispatch",
        actorRef: "operator:mission-workbench",
        reason: "operator requested retry from Mission Workbench recovery surface",
      },
    );
  });
});
