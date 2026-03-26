import { apiClient } from "./client";
import type {
  FridayWorkflowGeneratorStartSessionResponse,
  FridayWorkflowGeneratorGetSessionResponse,
  FridayWorkflowGeneratorSubmitMessageResponse,
  FridayWorkflowGeneratorGenerateResponse,
  FridayWorkflowGeneratorEvidenceResponse,
  FridayWorkflowGeneratorApproveResponse,
} from "./types";

// ─── Request types ───

interface StartSessionInput {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
}

interface SubmitMessageInput {
  message: string;
  requestedModel?: string;
}

interface GenerateDraftInput {
  requestedModel?: string;
}

// ─── API ───

export const workflowGeneratorApi = {
  async startSession(
    input: StartSessionInput,
  ): Promise<FridayWorkflowGeneratorStartSessionResponse> {
    return apiClient.post<StartSessionInput, FridayWorkflowGeneratorStartSessionResponse>(
      "/v1/workflows/generator/sessions",
      input,
    );
  },

  async getSession(
    sessionId: string,
  ): Promise<FridayWorkflowGeneratorGetSessionResponse> {
    return apiClient.get<FridayWorkflowGeneratorGetSessionResponse>(
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  async submitMessage(
    sessionId: string,
    input: SubmitMessageInput,
  ): Promise<FridayWorkflowGeneratorSubmitMessageResponse> {
    return apiClient.post<SubmitMessageInput, FridayWorkflowGeneratorSubmitMessageResponse>(
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
      input,
    );
  },

  async generateDraft(
    sessionId: string,
    input?: GenerateDraftInput,
  ): Promise<FridayWorkflowGeneratorGenerateResponse> {
    return apiClient.post<GenerateDraftInput | Record<string, never>, FridayWorkflowGeneratorGenerateResponse>(
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/generate`,
      input ?? {},
    );
  },

  async approveSession(
    sessionId: string,
  ): Promise<FridayWorkflowGeneratorApproveResponse> {
    return apiClient.post<Record<string, never>, FridayWorkflowGeneratorApproveResponse>(
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/approve`,
      {},
    );
  },

  async getEvidence(
    sessionId: string,
  ): Promise<FridayWorkflowGeneratorEvidenceResponse> {
    return apiClient.get<FridayWorkflowGeneratorEvidenceResponse>(
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
    );
  },

  async cancelSession(
    sessionId: string,
  ): Promise<{ cancelled: true }> {
    return apiClient.del<{ cancelled: true }>(
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}`,
    );
  },
};
