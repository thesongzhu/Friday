/**
 * Deep Link Validator — validates parsed payloads and produces a preview result.
 *
 * Checks:
 * - Required fields present per resource type
 * - URL safety (no private IPs, no localhost in production)
 * - Integrity hash format (if provided)
 * - Permission implications
 */

import type {
  FridayDeepLinkCheck,
  FridayDeepLinkPayload,
  FridayDeepLinkPreviewResult,
} from "./friday-deeplink-types.js";

function isPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    // Check for private/reserved hostnames
    if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
    // Check for private IP ranges (strip brackets for IPv6)
    const ip = hostname.replace(/^\[|\]$/g, "");
    if (/^127\./.test(ip)) return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (ip === "::1" || ip === "0.0.0.0" || ip === "0:0:0:0:0:0:0:1") return true;
    // Check for link-local and other reserved ranges
    if (/^169\.254\./.test(ip)) return true;
    if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true;
    if (/^fe80:/i.test(ip)) return true;
    return false;
  } catch {
    // If URL parsing fails, treat as potentially private (fail-closed)
    return true;
  }
}

function isValidSha256(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

export function validateFridayDeepLink(payload: FridayDeepLinkPayload): FridayDeepLinkPreviewResult {
  const checks: FridayDeepLinkCheck[] = [];
  const permissions: string[] = [];

  // Version check
  if (payload.version !== 1) {
    checks.push({
      id: "version",
      label: "Protocol Version",
      level: "blocking",
      summary: `Unsupported version: ${String(payload.version)}. Only version 1 is supported.`,
    });
  }

  // Integrity hash check
  if (payload.integrityHash) {
    if (isValidSha256(payload.integrityHash)) {
      checks.push({
        id: "integrity",
        label: "Integrity Hash",
        level: "advisory",
        summary: "SHA-256 integrity hash provided and format is valid.",
      });
    } else {
      checks.push({
        id: "integrity",
        label: "Integrity Hash",
        level: "warning",
        summary: "Integrity hash is not a valid SHA-256 format.",
      });
    }
  } else {
    checks.push({
      id: "integrity",
      label: "Integrity Hash",
      level: "advisory",
      summary: "No integrity hash provided. Content will not be verified against a checksum.",
    });
  }

  // Type-specific validation
  switch (payload.type) {
    case "provider-template":
      validateProviderTemplate(payload, checks, permissions);
      break;
    case "skill-source":
      validateSkillSource(payload, checks, permissions);
      break;
    case "mcp-server":
      validateMcpServer(payload, checks, permissions);
      break;
    case "workflow-template":
      validateWorkflowTemplate(payload, checks, permissions);
      break;
    case "marketplace-asset":
      validateMarketplaceAsset(payload, checks, permissions);
      break;
  }

  const hasBlocking = checks.some((check) => check.level === "blocking");
  const hasWarning = checks.some((check) => check.level === "warning");

  return {
    valid: !hasBlocking,
    payload,
    verdict: hasBlocking ? "blocked" : hasWarning ? "needs_review" : "ready",
    checks,
    permissionSummary: permissions,
  };
}

function validateProviderTemplate(
  payload: FridayDeepLinkPayload,
  checks: FridayDeepLinkCheck[],
  permissions: string[],
): void {
  const template = payload.providerTemplate;
  if (!template) {
    checks.push({ id: "provider-fields", label: "Provider Fields", level: "blocking", summary: "Provider template data is missing." });
    return;
  }
  if (!template.providerKind) {
    checks.push({ id: "provider-kind", label: "Provider Kind", level: "blocking", summary: "Provider kind is required." });
  }
  if (template.apiKey) {
    permissions.push("Will configure an API key for the provider.");
  }
  if (template.baseUrl && isPrivateUrl(template.baseUrl)) {
    checks.push({ id: "provider-url", label: "Base URL", level: "warning", summary: "Base URL points to a private/local address." });
  }
  permissions.push("Will create or update a provider configuration.");
}

function validateSkillSource(
  payload: FridayDeepLinkPayload,
  checks: FridayDeepLinkCheck[],
  permissions: string[],
): void {
  const source = payload.skillSource;
  if (!source) {
    checks.push({ id: "skill-fields", label: "Skill Fields", level: "blocking", summary: "Skill source data is missing." });
    return;
  }
  if (!source.url) {
    checks.push({ id: "skill-url", label: "Source URL", level: "blocking", summary: "Skill source URL is required." });
  } else if (isPrivateUrl(source.url)) {
    checks.push({ id: "skill-url-private", label: "Source URL", level: "warning", summary: "Source URL points to a private/local address." });
  }
  permissions.push("Will download and install a skill from an external source.");
  permissions.push("Skill will go through preflight verification before activation.");
}

function validateMcpServer(
  payload: FridayDeepLinkPayload,
  checks: FridayDeepLinkCheck[],
  permissions: string[],
): void {
  const server = payload.mcpServer;
  if (!server) {
    checks.push({ id: "mcp-fields", label: "MCP Fields", level: "blocking", summary: "MCP server data is missing." });
    return;
  }
  if (!server.name) {
    checks.push({ id: "mcp-name", label: "Server Name", level: "blocking", summary: "MCP server name is required." });
  }
  if (server.transport === "stdio" && !server.command) {
    checks.push({ id: "mcp-command", label: "Command", level: "blocking", summary: "stdio transport requires a command." });
  }
  if ((server.transport === "sse" || server.transport === "streamable-http") && !server.url) {
    checks.push({ id: "mcp-url", label: "Server URL", level: "blocking", summary: `${server.transport} transport requires a URL.` });
  }
  if (server.command) {
    permissions.push(`Will execute command: ${server.command}`);
  }
  permissions.push("Will add an MCP server to the runtime configuration.");
}

function validateWorkflowTemplate(
  payload: FridayDeepLinkPayload,
  checks: FridayDeepLinkCheck[],
  permissions: string[],
): void {
  const template = payload.workflowTemplate;
  if (!template) {
    checks.push({ id: "workflow-fields", label: "Workflow Fields", level: "blocking", summary: "Workflow template data is missing." });
    return;
  }
  if (!template.url) {
    checks.push({ id: "workflow-url", label: "Template URL", level: "blocking", summary: "Workflow template URL is required." });
  }
  permissions.push("Will import a workflow template.");
}

function validateMarketplaceAsset(
  payload: FridayDeepLinkPayload,
  checks: FridayDeepLinkCheck[],
  permissions: string[],
): void {
  const asset = payload.marketplaceAsset;
  if (!asset) {
    checks.push({ id: "asset-fields", label: "Asset Fields", level: "blocking", summary: "Marketplace asset data is missing." });
    return;
  }
  if (!asset.assetId) {
    checks.push({ id: "asset-id", label: "Asset ID", level: "blocking", summary: "Marketplace asset ID is required." });
  }
  permissions.push("Will install a marketplace asset.");
}
