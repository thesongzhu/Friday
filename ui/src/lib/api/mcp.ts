import { apiClient } from "./client";

export interface McpServerState {
  id: string;
  transport?: string;
  status?: "connected" | "disconnected" | "error" | "unknown";
  toolCount?: number;
  resourceCount?: number;
  lastError?: string;
}

interface McpHealthResponse {
  mcpServerStates?: McpServerState[];
}

export const mcpApi = {
  async listServers(): Promise<McpServerState[]> {
    try {
      const data = await apiClient.get<McpHealthResponse>("/v1/health");
      return data.mcpServerStates ?? [];
    } catch {
      return [];
    }
  },
};
