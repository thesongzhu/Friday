import { apiClient } from "./client";
import type { AssistantDiagnostics } from "./types";

interface AssistantDiagnosticsResponse {
  assistant: AssistantDiagnostics;
}

export const assistantDiagnosticsApi = {
  async get(): Promise<AssistantDiagnostics> {
    const data = await apiClient.get<AssistantDiagnosticsResponse>("/v1/uix/diagnostics");
    return data.assistant;
  },
};
