import { beforeEach, describe, expect, it, vi } from "vitest";
import { learningApi } from "../../../ui/src/lib/api/learning";
import { apiClient } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe("learningApi", () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.post).mockReset();
  });

  it("uses the backend diagnosis lesson route when toggling a lesson", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ lesson: {} });

    await learningApi.setLessonEnabled({
      lessonId: "lesson/1",
      enabled: false,
      reason: "operator override",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/v1/diagnosis/lessons/lesson%2F1/enabled",
      {
        enabled: false,
        reason: "operator override",
      },
    );
  });

  it("uses the backend diagnosis pattern route when demoting a pattern", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ pattern: {} });

    await learningApi.demotePattern({
      patternId: "pattern/1",
      factor: 0.25,
      reason: "too aggressive",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/v1/diagnosis/patterns/pattern%2F1/demote",
      {
        factor: 0.25,
        reason: "too aggressive",
      },
    );
  });
});
