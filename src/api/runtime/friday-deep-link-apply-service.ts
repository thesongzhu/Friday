import { FridayDomainError } from "#errors";
import {
  type FridayProviderService,
  getFridayProviderTemplate,
} from "#providers";
import {
  createFridaySkillCandidateSourceProvenance,
  createFridaySkillStageMutatingActionRequest,
  formatFridaySkillCandidateSourceProvenance,
  type FridaySkillConverterService,
  redactFridaySkillCandidateSourceUri,
  redactFridaySkillSourceText,
  redactFridaySkillSourceValue,
} from "#skills/converter";
import type {
  FridayWorkflowBuilderImportExportService,
  FridayWorkflowCrudService,
  FridayWorkflowSpecBundleV1,
} from "#workflows";
import type {
  FridayDeepLinkApplyResult,
  FridayDeepLinkPayload,
} from "../../deeplink/index.js";
import { fetchWithFridayAgentSsrfGuard } from "../../agent/security/friday-agent-fetch-guard.js";
import {
  createFridayAgentSsrfGuard,
  type FridayAgentSsrfGuard,
  FridaySsrfBlockedError,
} from "../../agent/security/friday-agent-ssrf-guard.js";
import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionActor,
  FridayMutatingActionGate,
  FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";
import {
  createFridayMcpAdapter,
  isForbiddenEnvVar,
  isSecretShapedEnvKey,
} from "../../agent/mcp/friday-mcp-adapter.js";
import type { FridayMcpConfigStore } from "../../agent/mcp/friday-mcp-config-store.js";
import type { FridayMcpServerConfig } from "../../agent/mcp/friday-mcp-adapter.types.js";

const WORKFLOW_TEMPLATE_FETCH_TIMEOUT_MS = 15_000;

export interface CreateFridayDeepLinkApplyServiceDeps {
  idGenerator: () => string;
  nowIso: () => string;
  providerService: FridayProviderService;
  converterService?: FridaySkillConverterService;
  workflowImportExport: Pick<FridayWorkflowBuilderImportExportService, "importBundle">;
  workflowCrud: Pick<FridayWorkflowCrudService, "createWorkflow" | "archiveWorkflow">;
  workflowTemplateSsrfGuard?: FridayAgentSsrfGuard;
  canonicalMutationGate?: FridayMutatingActionGate;
  mcpConfigStore?: FridayMcpConfigStore;
}

export interface FridayDeepLinkApplyOptions {
  actor?: FridayMutatingActionActor;
  surface?: string;
  idempotencyKey?: string;
  planDigest?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayDeepLinkApplyService {
  apply(payload: FridayDeepLinkPayload, options?: FridayDeepLinkApplyOptions): Promise<FridayDeepLinkApplyResult>;
}

export function createFridayDeepLinkApplyService(
  deps: CreateFridayDeepLinkApplyServiceDeps,
): FridayDeepLinkApplyService {
  return {
    async apply(payload, options) {
      switch (payload.type) {
        case "provider-template":
          return applyProviderTemplateDeepLink(payload, deps, options);
        case "skill-source":
          return applySkillSourceDeepLink(payload, deps, options);
        case "workflow-template":
          return applyWorkflowTemplateDeepLink(payload, deps);
        case "mcp-server":
          return applyMcpServerDeepLink(payload, deps, options);
      }
    },
  };
}

async function applyProviderTemplateDeepLink(
  payload: FridayDeepLinkPayload,
  _deps: CreateFridayDeepLinkApplyServiceDeps,
  _options: FridayDeepLinkApplyOptions | undefined,
): Promise<FridayDeepLinkApplyResult> {
  const providerTemplate = payload.providerTemplate;
  if (!providerTemplate) {
    throw new FridayDomainError("VALIDATION_FAILED", "Provider template data is missing", { httpStatus: 400 });
  }

  const template = getFridayProviderTemplate(providerTemplate.providerKind);
  if (!template) {
    throw new FridayDomainError(
      "VALIDATION_FAILED",
      `Unknown provider template: ${providerTemplate.providerKind}`,
      { httpStatus: 400 },
    );
  }

  return {
    applied: false,
    resourceType: payload.type,
    message: `Provider template ${template.displayName} is preview-only until provider lifecycle staging, validation, and promotion are wired.`,
  };
}

async function applySkillSourceDeepLink(
  payload: FridayDeepLinkPayload,
  deps: CreateFridayDeepLinkApplyServiceDeps,
  options: FridayDeepLinkApplyOptions | undefined,
): Promise<FridayDeepLinkApplyResult> {
  if (!deps.converterService) {
    return {
      applied: false,
      resourceType: payload.type,
      message: "Skill source import is unavailable because the converter service is not registered.",
    };
  }

  const skillSource = payload.skillSource;
  if (!skillSource?.url) {
    throw new FridayDomainError("VALIDATION_FAILED", "Skill source URL is required", { httpStatus: 400 });
  }

  const canonicalApprovalTicket = assertSkillSourceStageCanonicalApproval({
    deps,
    options,
    sourceUrl: skillSource.url,
  });

  const source = { uri: skillSource.url };
  const result = await importSkillSourceWithRedactedErrors(deps.converterService, source, canonicalApprovalTicket);
  const safeResult = redactFridaySkillSourceValue(result, source) as typeof result;

  const firstCandidate = safeResult.candidates[0];
  const issueSummary = safeResult.validation
    .flatMap((entry) => entry.issues.map((issue) => issue.message))
    .filter((message, index, items) => items.indexOf(message) === index)
    .join("; ");

  return {
    applied: true,
    resourceType: payload.type,
    resourceId: firstCandidate?.candidateId,
    message: issueSummary
      || `Skill source ${redactFridaySkillCandidateSourceUri(skillSource.url)} was staged as ${safeResult.candidates.length} candidate(s). It was not installed or made available.`,
  };
}

async function importSkillSourceWithRedactedErrors(
  converterService: FridaySkillConverterService,
  source: { uri: string },
  canonicalApprovalTicket: FridayMutatingActionTicket,
) {
  try {
    return await converterService.import({
      source,
      formatHint: "auto",
      canonicalApprovalTicket,
    });
  } catch (err) {
    throw redactSkillSourceError(err, source);
  }
}

function redactSkillSourceError(err: unknown, source: { uri: string }): FridayDomainError {
  const provenance = createFridaySkillCandidateSourceProvenance(source);
  const sourceProvenance = {
    sourceKind: provenance.sourceKind,
    sourceDigest: provenance.sourceDigest,
    redactedUri: provenance.redactedUri,
  };

  if (err instanceof FridayDomainError) {
    const details = redactFridaySkillSourceValue(err.details, source, provenance) as Record<string, unknown>;
    return new FridayDomainError(
      err.code,
      redactFridaySkillSourceText(err.message, source, provenance),
      {
        httpStatus: err.httpStatus,
        retryable: err.retryable,
        details: {
          ...details,
          sourceProvenance,
        },
      },
    );
  }

  const fallbackMessage = err instanceof Error ? err.message : String(err);
  return new FridayDomainError(
    "SKILL_SOURCE_DEEPLINK_IMPORT_FAILED",
    `Skill-source deeplink staging failed for ${formatFridaySkillCandidateSourceProvenance(provenance)}: ${redactFridaySkillSourceText(fallbackMessage, source, provenance)}`,
    {
      httpStatus: 422,
      details: { sourceProvenance },
    },
  );
}

function assertSkillSourceStageCanonicalApproval(input: {
  deps: CreateFridayDeepLinkApplyServiceDeps;
  options: FridayDeepLinkApplyOptions | undefined;
  sourceUrl: string;
}): FridayMutatingActionTicket {
  if (!input.deps.canonicalMutationGate) {
    throw new FridayDomainError(
      "SKILL_IMPORT_CANONICAL_GATE_UNAVAILABLE",
      "Skill-source deeplink staging requires the canonical approval gate.",
      { httpStatus: 503 },
    );
  }

  const actor = input.options?.actor ?? {
    kind: "api",
    id: "api:deeplink",
    principalId: "api:deeplink",
  };
  const gateResult = input.deps.canonicalMutationGate.evaluate(
    createFridaySkillStageMutatingActionRequest({
      source: { uri: input.sourceUrl },
      formatHint: "auto",
      actor,
      surface: input.options?.surface ?? "api:/v1/deeplink/apply",
      idempotencyKey: input.options?.idempotencyKey,
      planDigest: input.options?.planDigest,
      canonicalApproval: input.options?.canonicalApproval,
    }),
  );

  if (gateResult.decision !== "allow" || !gateResult.ticket) {
    throw new FridayDomainError(
      gateResult.decision === "requires_approval"
        ? "CANONICAL_APPROVAL_REQUIRED"
        : "CANONICAL_APPROVAL_DENIED",
      gateResult.decision === "requires_approval"
        ? "Skill-source deeplink staging requires canonical approval before any candidate is written."
        : `Skill-source deeplink staging was blocked by the canonical approval gate: ${gateResult.reason}`,
      {
        httpStatus: 403,
        details: {
          canonicalGate: gateResult.evidenceRecord,
        },
      },
    );
  }
  return gateResult.ticket;
}

async function applyWorkflowTemplateDeepLink(
  payload: FridayDeepLinkPayload,
  deps: CreateFridayDeepLinkApplyServiceDeps,
): Promise<FridayDeepLinkApplyResult> {
  const workflowTemplate = payload.workflowTemplate;
  if (!workflowTemplate?.url) {
    throw new FridayDomainError("VALIDATION_FAILED", "Workflow template URL is required", { httpStatus: 400 });
  }

  const ssrfGuard = deps.workflowTemplateSsrfGuard ?? createFridayAgentSsrfGuard();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), WORKFLOW_TEMPLATE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchWithFridayAgentSsrfGuard({
      url: workflowTemplate.url,
      guard: ssrfGuard,
      init: {
        headers: {
          Accept: "application/json",
          "User-Agent": "Friday/1.0",
        },
        signal: abortController.signal,
      },
      options: { maxRedirects: 3 },
    });
  } catch (err) {
    if (err instanceof FridaySsrfBlockedError) {
      throw new FridayDomainError(
        "WORKFLOW_TEMPLATE_URL_BLOCKED",
        "Workflow template URL was blocked by SSRF protection.",
        { httpStatus: 403, cause: err },
      );
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new FridayDomainError(
        "WORKFLOW_TEMPLATE_FETCH_TIMEOUT",
        "Timed out while fetching workflow template.",
        { httpStatus: 504, cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new FridayDomainError(
      "WORKFLOW_TEMPLATE_FETCH_FAILED",
      `Failed to fetch workflow template: ${response.status} ${response.statusText}`,
      { httpStatus: 502 },
    );
  }

  const bundle = await response.json() as FridayWorkflowSpecBundleV1;
  const workflowName = workflowTemplate.name?.trim() || bundle.workflow.name || payload.label || "Imported Workflow";
  const workflow = deps.workflowCrud.createWorkflow({
    slug: createWorkflowTemplateSlug(workflowName, deps.idGenerator()),
    name: workflowName,
    description: bundle.workflow.description ?? "Imported from a Friday workflow-template deep link.",
    tags: [...new Set([...(bundle.workflow.tags ?? []), "deeplink", "external-template"])],
  });
  let result;
  try {
    result = deps.workflowImportExport.importBundle(bundle, workflow.id, undefined, {
      sourceReview: {
        source: "deeplink.workflow_template",
        sourceUrl: redactFridaySkillCandidateSourceUri(workflowTemplate.url),
        importedAt: deps.nowIso(),
        requiresReviewBeforePublish: true,
      },
    });
  } catch (err) {
    deps.workflowCrud.archiveWorkflow(workflow.id, "deeplink.workflow_template");
    throw err;
  }

  return {
    applied: true,
    resourceType: payload.type,
    resourceId: result.draft.draftId,
    workflowId: workflow.id,
    resourceUrl: `/workflows/builder?workflowId=${encodeURIComponent(workflow.id)}&draftId=${encodeURIComponent(result.draft.draftId)}&focus=draft`,
    message: `Imported workflow template as draft "${result.draft.title}". Review confirmation is required before publish or deploy.`,
  };
}

function createWorkflowTemplateSlug(name: string, suffix: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "imported-workflow"}-${suffix.slice(0, 8)}`;
}

async function applyMcpServerDeepLink(
  payload: FridayDeepLinkPayload,
  deps: CreateFridayDeepLinkApplyServiceDeps,
  options: FridayDeepLinkApplyOptions | undefined,
): Promise<FridayDeepLinkApplyResult> {
  const mcpServer = payload.mcpServer;
  if (!mcpServer) {
    throw new FridayDomainError("VALIDATION_FAILED", "MCP server configuration is missing from payload.", { httpStatus: 400 });
  }

  if (mcpServer.transport !== "stdio") {
    return {
      applied: false,
      resourceType: payload.type,
      message: `MCP deeplink apply supports only stdio transport. ${mcpServer.transport} transport is not supported for apply.`,
    };
  }

  if (!mcpServer.command || mcpServer.command.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_FAILED", "MCP server with stdio transport requires a command.", { httpStatus: 400 });
  }

  if (mcpServer.env) {
    const rejectedKeys = Object.keys(mcpServer.env).filter(
      (key) => isForbiddenEnvVar(key) || isSecretShapedEnvKey(key),
    );
    if (rejectedKeys.length > 0) {
      throw new FridayDomainError(
        "MCP_ENV_REJECTED",
        `MCP server env contains forbidden or secret-shaped keys: ${rejectedKeys.join(", ")}`,
        { httpStatus: 400, details: { rejectedKeys } },
      );
    }
  }

  if (!deps.mcpConfigStore) {
    return {
      applied: false,
      resourceType: payload.type,
      message: "MCP config store is not available. MCP deeplink apply requires a state directory.",
    };
  }

  const serverId = mcpServer.name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || `mcp-${deps.idGenerator().slice(0, 8)}`;

  if (!deps.canonicalMutationGate) {
    throw new FridayDomainError(
      "MCP_INSTALL_CANONICAL_GATE_UNAVAILABLE",
      "MCP server deeplink install requires the canonical approval gate.",
      { httpStatus: 503 },
    );
  }

  const actor: FridayMutatingActionActor = options?.actor ?? {
    kind: "api",
    id: "api:deeplink",
    principalId: "api:deeplink",
  };

  const mcpGateResult = deps.canonicalMutationGate.evaluate({
    action: "mcp.deeplink.install_server",
    actor,
    surface: options?.surface ?? "api:/v1/deeplink/apply",
    resource: {
      type: "mcp_server_config",
      id: `mcp-server:${serverId}`,
    },
    mutating: true,
    risk: "high",
    parameters: {
      transport: mcpServer.transport,
      serverName: mcpServer.name,
    },
    idempotencyKey: options?.idempotencyKey,
    planDigest: options?.planDigest,
    canonicalApproval: options?.canonicalApproval,
    localClaims: [{
      guardId: "mcp_install_lifecycle_guard",
      decision: "requires_approval",
      reason: "MCP server installation requires explicit approval before persisting configuration.",
    }],
  });

  if (mcpGateResult.decision !== "allow" || !mcpGateResult.ticket) {
    throw new FridayDomainError(
      mcpGateResult.decision === "requires_approval"
        ? "CANONICAL_APPROVAL_REQUIRED"
        : "CANONICAL_APPROVAL_DENIED",
      mcpGateResult.decision === "requires_approval"
        ? "MCP server deeplink install requires canonical approval before persisting configuration."
        : `MCP server deeplink install was blocked by the canonical approval gate: ${mcpGateResult.reason}`,
      {
        httpStatus: 403,
        details: {
          canonicalGate: mcpGateResult.evidenceRecord,
        },
      },
    );
  }

  const serverConfig: FridayMcpServerConfig = {
    id: serverId,
    transport: "stdio",
    command: mcpServer.command,
    args: mcpServer.args,
    env: mcpServer.env,
  };

  deps.mcpConfigStore.addServer(serverConfig);

  let doctorReady = false;
  let doctorToolCount = 0;
  let doctorError: string | undefined;

  try {
    const probeAdapter = createFridayMcpAdapter({ servers: [serverConfig] });
    const tools = await probeAdapter.listTools({ serverId });
    doctorReady = true;
    doctorToolCount = tools.length;
  } catch (err) {
    doctorReady = false;
    doctorError = err instanceof Error ? err.message : String(err);
  }

  return {
    applied: true,
    resourceType: payload.type,
    resourceId: serverId,
    message: doctorReady
      ? `MCP server "${mcpServer.name}" (stdio) persisted and doctor-verified with ${String(doctorToolCount)} tool(s). Available after runtime restart.`
      : `MCP server "${mcpServer.name}" (stdio) persisted but doctor probe failed: ${doctorError ?? "unknown error"}. Config saved; verify command and retry.`,
  };
}
