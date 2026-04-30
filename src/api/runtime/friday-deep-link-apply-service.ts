import { FridayDomainError } from "#errors";
import {
  type FridayProviderAuthMode,
  type FridayProviderService,
  getFridayProviderTemplate,
} from "#providers";
import type { FridaySkillConverterService } from "#skills/converter";
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

const WORKFLOW_TEMPLATE_FETCH_TIMEOUT_MS = 15_000;

export interface CreateFridayDeepLinkApplyServiceDeps {
  idGenerator: () => string;
  providerService: FridayProviderService;
  converterService?: FridaySkillConverterService;
  workflowImportExport: Pick<FridayWorkflowBuilderImportExportService, "importBundle">;
  workflowTemplateSsrfGuard?: FridayAgentSsrfGuard;
}

export interface FridayDeepLinkApplyService {
  apply(payload: FridayDeepLinkPayload): Promise<FridayDeepLinkApplyResult>;
}

export function createFridayDeepLinkApplyService(
  deps: CreateFridayDeepLinkApplyServiceDeps,
): FridayDeepLinkApplyService {
  return {
    async apply(payload) {
      switch (payload.type) {
        case "provider-template":
          return applyProviderTemplateDeepLink(payload, deps);
        case "skill-source":
          return applySkillSourceDeepLink(payload, deps);
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

  const result = await deps.converterService.import({
    source: { uri: skillSource.url },
    formatHint: "auto",
    target: "managed",
    refreshRegistry: true,
  });

  const firstInstalled = result.imports.find((entry) => entry.installed);
  if (firstInstalled) {
    return {
      applied: true,
      resourceType: payload.type,
      resourceId: firstInstalled.skillId,
      message: `Imported skill "${firstInstalled.skillId}" from ${skillSource.url}.`,
    };
  }

  const issueSummary = result.imports
    .flatMap((entry) => entry.issues.map((issue) => issue.message))
    .filter((message, index, items) => items.indexOf(message) === index)
    .join("; ");

  return {
    applied: false,
    resourceType: payload.type,
    message: issueSummary || `Skill source import did not install any skills from ${skillSource.url}.`,
  };
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
