// ─── Degradation handler ───
//
// Assesses the degradation level of an agent run based on available tools
// and provides appropriate system prompt guidance.

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";

export type FridayDegradationLevel = "nominal" | "degraded" | "minimal" | "conversational";

/**
 * Assess degradation level based on the set of available tools.
 */
export function assessDegradation(
  availableTools: Pick<FridayAgentToolDefinition, "name">[],
): FridayDegradationLevel {
  if (availableTools.length === 0) return "conversational";

  const hasRead = availableTools.some(
    (t) => t.name.includes("read") || t.name.includes("list") || t.name.includes("search") || t.name === "capabilities" || t.name === "task_status",
  );
  const hasWrite = availableTools.some(
    (t) => t.name.includes("write") || t.name.includes("edit") || t.name === "exec" || t.name === "skill_run",
  );

  if (!hasWrite && !hasRead) return "minimal";
  if (!hasWrite) return "degraded";
  return "nominal";
}

/**
 * Get a system prompt fragment describing the current degradation state.
 * Returns an empty string for nominal operation.
 */
export function getDegradationSystemPrompt(level: FridayDegradationLevel): string {
  switch (level) {
    case "conversational":
      return (
        "All tools are currently unavailable. You can only provide analysis, " +
        "suggestions, and explanations through conversation. If the user needs " +
        "to execute operations, describe the specific steps for them to perform manually."
      );
    case "minimal":
      return (
        "Critical tools are unavailable. You have limited read-only access. " +
        "Cannot execute modifications or write operations."
      );
    case "degraded":
      return (
        "Some tools are temporarily unavailable. Fallback alternatives are active. " +
        "Write and execution capabilities are limited."
      );
    default:
      return "";
  }
}
