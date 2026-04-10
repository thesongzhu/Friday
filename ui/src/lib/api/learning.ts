import { apiClient } from "./client";
import type { FridayLearningOverview } from "./types";

interface GetLearningOverviewResponse extends FridayLearningOverview {}

export const learningApi = {
  async getOverview(limit = 20): Promise<FridayLearningOverview> {
    const params = new URLSearchParams({ limit: String(limit) });
    return apiClient.get<GetLearningOverviewResponse>(
      `/v1/diagnosis/learning/overview?${params.toString()}`,
    );
  },

  async setLessonEnabled(input: {
    lessonId: string;
    enabled: boolean;
    reason?: string;
  }): Promise<void> {
    await apiClient.post<{ enabled: boolean; reason?: string }, { lesson: unknown }>(
      `/v1/diagnosis/learning/lessons/${encodeURIComponent(input.lessonId)}/enabled`,
      {
        enabled: input.enabled,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
  },

  async demotePattern(input: {
    patternId: string;
    factor: number;
    reason?: string;
  }): Promise<void> {
    await apiClient.post<{ factor: number; reason?: string }, { pattern: unknown }>(
      `/v1/diagnosis/learning/patterns/${encodeURIComponent(input.patternId)}/demote`,
      {
        factor: input.factor,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
  },

  async approveAction(actionId: string, reason?: string): Promise<void> {
    await apiClient.post(`/v1/auto-fix/actions/${encodeURIComponent(actionId)}/approve`, reason ? { reason } : {});
  },

  async denyAction(actionId: string, reason?: string): Promise<void> {
    await apiClient.post(`/v1/auto-fix/actions/${encodeURIComponent(actionId)}/deny`, reason ? { reason } : {});
  },
};
