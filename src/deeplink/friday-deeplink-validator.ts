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
import {
  createFridayAgentSsrfGuard,
  FridaySsrfBlockedError,
} from "../agent/security/friday-agent-ssrf-guard.js";
import { redactFridaySkillCandidateSourceUri } from "../skills/converter/services/friday-skill-candidate-store.js";

const REDACTED_SECRET_VALUE = "[redacted]";
const deepLinkPreviewSsrfGuard = createFridayAgentSsrfGuard();

function isPrivateUrl(urlString: string): boolean {
  try {
    deepLinkPreviewSsrfGuard.validate(urlString);
    return false;
  } catch (err) {
    if (!(err instanceof FridaySsrfBlockedError)) {
      console.warn("[friday][deeplink-validator] URL safety check failed:", err instanceof Error ? err.message : String(err));
    }
    return true;
  }
}

function isValidSha256(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

function sanitizeDeepLinkPayloadForPreview(payload: FridayDeepLinkPayload): FridayDeepLinkPayload {
  const sanitized: FridayDeepLinkPayload = { ...payload };

  if (payload.providerTemplate?.apiKey) {
    sanitized.providerTemplate = {
      ...payload.providerTemplate,
      apiKey: REDACTED_SECRET_VALUE,
    };
  }

  if (payload.skillSource?.url) {
    sanitized.skillSource = {
      ...payload.skillSource,
      url: redactFridaySkillCandidateSourceUri(payload.skillSource.url),
    };
  }

  if (payload.workflowTemplate?.url) {
    sanitized.workflowTemplate = {
      ...payload.workflowTemplate,
      url: redactFridaySkillCandidateSourceUri(payload.workflowTemplate.url),
    };
  }

  return sanitized;
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
  }

  const hasBlocking = checks.some((check) => check.level === "blocking");
  const hasWarning = checks.some((check) => check.level === "warning");

  return {
    valid: !hasBlocking,
    payload: sanitizeDeepLinkPayloadForPreview(payload),
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
    permissions.push("Provider API key will be previewed only and redacted.");
  }
  if (template.baseUrl && isPrivateUrl(template.baseUrl)) {
    checks.push({ id: "provider-url", label: "Base URL", level: "warning", summary: "Base URL points to a private/local address." });
  }
  permissions.push("Provider template preview does not create, update, enable, or validate a provider.");
  permissions.push("Provider setup must use the provider lifecycle with explicit validation and promotion before availability.");
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
    checks.push({
      id: "skill-url-private",
      label: "Source URL",
      level: "blocking",
      summary: "Source URL points to a private/local address and cannot be used for skill-source deep-link staging.",
    });
  }
  permissions.push("Will stage an external skill candidate for review.");
  permissions.push("Skill will not be installed or made available until lifecycle validation, approval, and promotion complete.");
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
  } else if (isPrivateUrl(template.url)) {
    checks.push({ id: "workflow-url-private", label: "Template URL", level: "blocking", summary: "Workflow template URL points to a private/local address." });
  }
  permissions.push("Will import an external workflow template as a draft.");
  permissions.push("Draft must be reviewed before publish, deploy, or run.");
}
