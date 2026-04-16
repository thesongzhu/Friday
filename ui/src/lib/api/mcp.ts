import { assistantDiagnosticsApi } from "./assistant-diagnostics";
import type { McpServerState as DiagnosticsMcpServerState } from "./types";

export interface McpServerState {
  id: string;
  transport?: string;
  status?: "connected" | "configured" | "deferred" | "disconnected" | "error" | "unknown";
  toolCount?: number;
  resourceCount?: number;
  lastError?: string;
}

interface McpHealthResponse {
  mcpServerStates?: DiagnosticsMcpServerState[];
}

export const mcpApi = {
  async listServers(): Promise<McpServerState[]> {
    try {
      const data = await assistantDiagnosticsApi.get();
      const states = (data.mcpServerStates ?? []) as McpHealthResponse["mcpServerStates"];
      return (states ?? []).map((state) => ({
        id: state.serverId,
        transport: state.transport,
        status: state.state === "loaded"
          ? "connected"
          : state.state === "deferred"
            ? "deferred"
            : state.state === "configured" || state.state === "discoverable"
              ? "configured"
              : "disconnected",
        toolCount: state.toolCount,
        resourceCount: state.resourceCount,
      }));
    } catch {
      return [];
    }
  },
};
