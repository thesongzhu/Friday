/**
 * Deep Link Types — defines the `friday://` import protocol.
 *
 * Supported resource types:
 * - provider-template: Import a provider configuration
 * - skill-source: Import a skill from a URL (GitHub, archive, etc.)
 * - mcp-server: Import an MCP server configuration
 * - workflow-template: Import a workflow template
 * - marketplace-asset: Import a marketplace asset reference
 */

export type FridayDeepLinkResourceType =
  | "provider-template"
  | "skill-source"
  | "mcp-server"
  | "workflow-template"
  | "marketplace-asset";

export interface FridayDeepLinkPayload {
  /** Protocol version for forward compatibility. */
  version: 1;
  /** Resource type being imported. */
  type: FridayDeepLinkResourceType;
  /** Human-readable label for the preview dialog. */
  label: string;
  /** Origin URL or identifier of the payload source. */
  source?: string;
  /** SHA-256 integrity hash of the payload content, if available. */
  integrityHash?: string;

  /** Provider template import fields. */
  providerTemplate?: {
    providerKind: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };

  /** Skill source import fields. */
  skillSource?: {
    url: string;
    ref?: string;
    manifestPath?: string;
  };

  /** MCP server import fields. */
  mcpServer?: {
    name: string;
    transport: "stdio" | "sse" | "streamable-http";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };

  /** Workflow template import fields. */
  workflowTemplate?: {
    url: string;
    name?: string;
  };

  /** Marketplace asset reference fields. */
  marketplaceAsset?: {
    assetId: string;
    sourceId?: string;
  };
}

export type FridayDeepLinkCheckLevel = "blocking" | "warning" | "advisory";

export interface FridayDeepLinkCheck {
  id: string;
  label: string;
  level: FridayDeepLinkCheckLevel;
  summary: string;
}

export interface FridayDeepLinkPreviewResult {
  valid: boolean;
  payload: FridayDeepLinkPayload;
  verdict: "ready" | "needs_review" | "blocked";
  checks: FridayDeepLinkCheck[];
  permissionSummary: string[];
}

export interface FridayDeepLinkApplyResult {
  applied: boolean;
  resourceType: FridayDeepLinkResourceType;
  resourceId?: string;
  message: string;
}
