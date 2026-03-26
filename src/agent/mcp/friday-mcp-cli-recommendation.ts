export type FridayIntegrationRecommendation =
  | "keep_mcp"
  | "prefer_cli_skill"
  | "prefer_workflow_node"
  | "hybrid";

export interface FridayIntegrationRecommendationInput {
  localExecutable: boolean;
  requiresRemoteAuth: boolean;
  sharedAcrossUsers: boolean;
  tokenSensitive: boolean;
  needsStructuredResources: boolean;
  multiStepWorkflow: boolean;
}

export interface FridayIntegrationRecommendationResult {
  recommendation: FridayIntegrationRecommendation;
  reason: string;
}

export function recommendFridayIntegrationMode(
  input: FridayIntegrationRecommendationInput,
): FridayIntegrationRecommendationResult {
  if (input.multiStepWorkflow && input.localExecutable && input.tokenSensitive) {
    return {
      recommendation: "prefer_workflow_node",
      reason: "This integration is multi-step, local-friendly, and cost-sensitive, so a stable workflow node is cheaper than MCP prompt contracts.",
    };
  }

  if (input.localExecutable && input.tokenSensitive && !input.sharedAcrossUsers && !input.requiresRemoteAuth) {
    return {
      recommendation: "prefer_cli_skill",
      reason: "The capability can run locally without shared remote auth, so a CLI-backed skill keeps context smaller and execution simpler.",
    };
  }

  if (input.requiresRemoteAuth || input.sharedAcrossUsers || input.needsStructuredResources) {
    return {
      recommendation: "keep_mcp",
      reason: "This integration benefits from MCP's remote transport, shared auth surface, or structured resources/prompts.",
    };
  }

  return {
    recommendation: "hybrid",
    reason: "Both MCP and CLI have value here; keep MCP for shared/remote paths and add a local skill for the common fast path.",
  };
}
