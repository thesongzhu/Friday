import type { FridayAuthPrincipal } from "../../model/friday-api-common.types.js";
import type { FridayAgentRunConstraints } from "../../../agent/model/friday-agent.types.js";
import { isUnauthenticatedPublicPrincipal } from "../../../security/friday-owner-session-channel-capability.js";

const PUBLIC_V1_SERVER_WORKSPACE_TOOL_DENYLIST = [
  "read",
  "write",
  "edit",
  "exec",
  "pdf_parse",
  "image_analysis",
  "memory_search",
  "memory_query",
  "memory_get",
  "memory_store",
  "memory_extract",
  "feedback",
] as const;

export function buildPublicV1AgentRunIsolation(principal: FridayAuthPrincipal | null): {
  constraints: FridayAgentRunConstraints;
  disabledToolNames: string[];
} | null {
  if (!isUnauthenticatedPublicPrincipal(principal)) {
    return null;
  }

  return {
    constraints: {
      readOnly: true,
      operationalMode: "restricted",
      dataSensitivity: "public",
    },
    disabledToolNames: [...PUBLIC_V1_SERVER_WORKSPACE_TOOL_DENYLIST],
  };
}
