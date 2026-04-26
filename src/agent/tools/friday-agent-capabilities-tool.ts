import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import { jsonResult } from "./friday-agent-tool-helpers.js";
import type { FridayRuntimeCapabilityMatrix } from "#providers";

export interface FridayAgentCapabilitiesSnapshot {
  readOnly: boolean;
  messaging: {
    enabled: boolean;
    kinds: string[];
  };
  mcp: {
    enabled: boolean;
    serverCount: number;
    servers: Array<{
      name: string;
      connected: boolean;
      authenticated: boolean;
    }>;
  };
  provider: {
    available: boolean;
    configuredCount: number;
    mutationBlockedByReadOnly: boolean;
  };
  browser: {
    activeMode?: string;
    targetBrowser?: string;
  };
  system: {
    enabled: boolean;
  };
  desktop: {
    connected: boolean;
  };
  companion: {
    connected: boolean;
  };
  runtime?: FridayRuntimeCapabilityMatrix;
}

export interface CreateFridayAgentCapabilitiesToolOptions {
  getSnapshot: (input: { readOnly: boolean }) => Promise<FridayAgentCapabilitiesSnapshot> | FridayAgentCapabilitiesSnapshot;
}

export function createFridayAgentCapabilitiesTool(
  options: CreateFridayAgentCapabilitiesToolOptions,
): FridayAgentToolDefinition {
  return {
    name: "capabilities",
    description:
      "Return deterministic facts about Friday's current deployment capabilities. " +
      "Use this for questions like what Friday can do right now, which messaging kinds are enabled, whether MCP is configured, " +
      "whether provider mutation is blocked by readOnly, and current browser/system/desktop availability. " +
      "This tool is read-only and should be preferred over probing blocked tools.",
    parameters: {
      properties: {},
      required: [],
    },
    async execute(_args: Record<string, unknown>, signal: AbortSignal): Promise<FridayAgentToolResult> {
      const context = getFridayAgentToolExecutionContext(signal);
      const snapshot = await options.getSnapshot({
        readOnly: context?.readOnly ?? false,
      });
      return jsonResult(snapshot);
    },
  };
}
