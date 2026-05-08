import { FridayDomainError } from "#errors";
import {
  type FridayProviderAuthMode,
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

const WORKFLOW_TEMPLATE_FETCH_TIMEOUT_MS = 15_000;

export interface CreateFridayDeepLinkApplyServiceDeps {
  idGenerator: () => string;
  providerService: FridayProviderService;
  converterService?: FridaySkillConverterService;
  workflowImportExport: Pick<FridayWorkflowBuilderImportExportService, "importBundle">;
  workflowTemplateSsrfGuard?: FridayAgentSsrfGuard;
  canonicalMutationGate?: FridayMutatingActionGate;
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
          return applyProviderTemplateDeepLink(payload, deps);
        case "skill-source":
          return applySkillSourceDeepLink(payload, deps, options);
        case "workflow-template":
          return applyWorkflowTemplateDeepLink(payload, deps);
        case "mcp-server":
          return {
            applied: false,
            resourceType: payload.type,
            message: "Deep link apply for mcp-server is not yet supported by the runtime config surface.",
          };
      }
    },
  };
}

async function applyProviderTemplateDeepLink(
  payload: FridayDeepLinkPayload,
  deps: CreateFridayDeepLinkApplyServiceDeps,
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

  const authMode = resolvePreferredProviderAuthMode(template.authModes, providerTemplate.apiKey);
  if (!authMode) {
    return {
      applied: false,
      resourceType: payload.type,
      message: `Provider template ${template.id} does not expose a supported auth mode for deep link import.`,
    };
  }

  if ((authMode === "api-key" || authMode === "bearer-token" || authMode === "token")
    && (!providerTemplate.apiKey || providerTemplate.apiKey.trim().length === 0)
  ) {
    return {
      applied: false,
      resourceType: payload.type,
      message: `Provider template ${template.id} requires an apiKey for auth mode ${authMode}.`,
    };
  }

  const baseUrl = providerTemplate.baseUrl?.trim() || template.baseUrlHints[0] || "";
  if (baseUrl.length === 0) {
    return {
      applied: false,
      resourceType: payload.type,
      message: `Provider template ${template.id} requires an explicit baseUrl before it can be applied.`,
    };
  }

  const defaultModel = providerTemplate.model?.trim()
    || template.modelDefaults.recommended
    || template.modelDefaults.examples[0];
  if (!defaultModel) {
    return {
      applied: false,
      resourceType: payload.type,
      message: `Provider template ${template.id} does not define a default model for import.`,
    };
  }

  const provider = await deps.providerService.createProvider({
    kind: template.providerKind,
    name: payload.label.trim() || template.displayName,
    baseUrl,
    backendKind: template.backendKind,
    authMode,
    api: template.api,
    apiKey: providerTemplate.apiKey,
    supportedModels: [defaultModel],
    defaultModel,
    deploymentKind: template.deploymentKind,
    regionTag: template.regionTag,
    enabled: true,
    validateOnSave: false,
  });

  return {
    applied: true,
    resourceType: payload.type,
    resourceId: provider.id,
    message: `Imported provider template ${template.displayName} as "${provider.name}".`,
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
  const workflowId = deps.idGenerator();
  const result = deps.workflowImportExport.importBundle(bundle, workflowId);

  return {
    applied: true,
    resourceType: payload.type,
    resourceId: result.draft.draftId,
    message: `Imported workflow template as draft "${result.draft.title}".`,
  };
}

function resolvePreferredProviderAuthMode(
  authModes: readonly FridayProviderAuthMode[],
  apiKey: string | undefined,
): FridayProviderAuthMode | null {
  if (apiKey && authModes.includes("api-key")) {
    return "api-key";
  }
  if (apiKey && authModes.includes("bearer-token")) {
    return "bearer-token";
  }
  if (apiKey && authModes.includes("token")) {
    return "token";
  }
  if (authModes.includes("none")) {
    return "none";
  }
  if (authModes.includes("oauth")) {
    return "oauth";
  }
  if (authModes.includes("external-session")) {
    return "external-session";
  }
  return authModes[0] ?? null;
}
