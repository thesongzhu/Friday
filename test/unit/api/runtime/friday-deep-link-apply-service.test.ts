import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayDeepLinkApplyService } from "../../../../src/api/runtime/friday-deep-link-apply-service.js";
import type { FridayProviderService } from "#providers";
import type { FridaySkillConverterService } from "#skills/converter";
import type {
  FridayWorkflowBuilderImportExportService,
  FridayWorkflowSpecBundleV1,
} from "#workflows";

function makeProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({
      id: "provider-1",
      name: "Imported OpenAI",
    } as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok", checkedAt: "2026-04-21T00:00:00.000Z" } as never)),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async () => ({ defaultProviderId: "", fallbackProviderIds: [] })),
    runWithFallback: vi.fn(async () => ({ result: null, route: null, attempts: [] } as never)),
    resolveRoute: vi.fn(async () => null),
    recordUsage: vi.fn(async () => undefined),
    getProviderDoctorReport: vi.fn(async () => ({} as never)),
    getProviderUsageSummary: vi.fn(async () => ({} as never)),
    getProviderRoutingExplainReport: vi.fn(async () => ({} as never)),
    initiateAnthropicOAuth: vi.fn(async () => ({} as never)),
    completeAnthropicOAuthCallback: vi.fn(async () => ({} as never)),
    listAuthProfiles: vi.fn(async () => []),
    activateAuthProfile: vi.fn(async () => ({} as never)),
    getLlmBudgetConfig: vi.fn(async () => null),
    setLlmBudgetConfig: vi.fn(async () => ({} as never)),
    getLlmBudgetStatus: vi.fn(async () => ({} as never)),
    getProviderHealthSnapshot: vi.fn(async () => []),
    pinRoute: vi.fn(async () => undefined),
    clearRoutePenalty: vi.fn(async () => false),
    clearRoutePenaltyByProvider: vi.fn(async () => 0),
    clearRoutePenaltyForUser: vi.fn(async () => 0),
    clearProviderRoutePenalty: vi.fn(async () => false),
    explainRouting: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function makeConverterService(): FridaySkillConverterService {
  return {
    listConverters: vi.fn(() => []),
    detect: vi.fn(async () => null),
    convert: vi.fn(async () => ({} as never)),
    import: vi.fn(async () => ({
      converterId: "code-repo",
      detectedFormat: "code-repo",
      imports: [
        {
          skillId: "imported-skill",
          skillDir: "/tmp/imported-skill",
          installed: true,
          issues: [],
        },
      ],
      registryRefreshed: true,
    })),
    pack: vi.fn(async () => ({} as never)),
  };
}

function makeWorkflowImportExport(): Pick<FridayWorkflowBuilderImportExportService, "importBundle"> {
  return {
    importBundle: vi.fn(() => ({
      draft: {
        draftId: "draft-1",
        workflowId: "wf-1",
        title: "Imported Workflow",
      },
      validation: { valid: true, errors: [], warnings: [] },
      warnings: [],
    } as never)),
  };
}

describe("createFridayDeepLinkApplyService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies provider-template payloads through providerService.createProvider", async () => {
    const providerService = makeProviderService();
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      providerService,
      converterService: makeConverterService(),
      workflowImportExport: makeWorkflowImportExport(),
    });

    const result = await service.apply({
      version: 1,
      type: "provider-template",
      label: "Imported OpenAI",
      providerTemplate: {
        providerKind: "openai",
        apiKey: "sk-test", // pragma: allowlist secret -- fixture value for provider-template import coverage
        model: "gpt-4o-mini",
      },
    });

    expect(result).toEqual({
      applied: true,
      resourceType: "provider-template",
      resourceId: "provider-1",
      message: 'Imported provider template OpenAI API as "Imported OpenAI".',
    });
    expect(providerService.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: "openai",
      name: "Imported OpenAI",
      authMode: "api-key",
      defaultModel: "gpt-4o-mini",
      supportedModels: ["gpt-4o-mini"],
      validateOnSave: false,
    }));
  });

  it("applies skill-source payloads through converterService.import", async () => {
    const converterService = makeConverterService();
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
    });

    const result = await service.apply({
      version: 1,
      type: "skill-source",
      label: "Install skill",
      skillSource: {
        url: "https://example.com/skill-repo",
      },
    });

    expect(result).toEqual({
      applied: true,
      resourceType: "skill-source",
      resourceId: "imported-skill",
      message: 'Imported skill "imported-skill" from https://example.com/skill-repo.',
    });
    expect(converterService.import).toHaveBeenCalledWith({
      source: { uri: "https://example.com/skill-repo" },
      formatHint: "auto",
      target: "managed",
      refreshRegistry: true,
    });
  });

  it("applies workflow-template payloads by fetching and importing a workflow bundle", async () => {
    const workflowImportExport = makeWorkflowImportExport();
    const bundle: FridayWorkflowSpecBundleV1 = {
      bundleSchemaVersion: "1.0",
      exportedAt: "2026-04-21T00:00:00.000Z",
      source: { type: "draft", id: "draft-src", workflowId: "wf-src" },
      workflow: { name: "Imported Workflow" },
      draft: { draftId: "draft-src", revision: 1, title: "Imported Workflow" },
      spec: {
        schemaVersion: "1.0",
        workflowId: "wf-src",
        name: "Imported Workflow",
        description: "Imported from bundle",
        startStepId: "step-1",
        trigger: { type: "manual" },
        inputs: [],
        steps: [{ id: "step-1", type: "data", value: { ok: true } }],
        edges: [],
        outputs: [],
        errorPolicy: { onFailure: "fail_fast", notifyUser: false },
        tests: [],
      },
      visual: {
        schemaVersion: "1.0",
        workflowId: "wf-src",
        viewport: { x: 0, y: 0, zoom: 1 },
        panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
        nodes: [{ nodeId: "step-1", x: 0, y: 0 }],
        edges: [],
      },
      checksum: "checksum",
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => bundle,
    })));

    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "wf-import-1",
      providerService: makeProviderService(),
      converterService: makeConverterService(),
      workflowImportExport,
    });

    const result = await service.apply({
      version: 1,
      type: "workflow-template",
      label: "Import workflow",
      workflowTemplate: {
        url: "https://example.com/workflow.json",
      },
    });

    expect(result).toEqual({
      applied: true,
      resourceType: "workflow-template",
      resourceId: "draft-1",
      message: 'Imported workflow template as draft "Imported Workflow".',
    });
    expect(workflowImportExport.importBundle).toHaveBeenCalledWith(bundle, "wf-import-1");
  });

  it("returns an honest unsupported result for marketplace assets", async () => {
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      providerService: makeProviderService(),
      converterService: makeConverterService(),
      workflowImportExport: makeWorkflowImportExport(),
    });

    const result = await service.apply({
      version: 1,
      type: "marketplace-asset",
      label: "Install asset",
      marketplaceAsset: {
        assetId: "asset-1",
      },
    });

    expect(result).toEqual({
      applied: false,
      resourceType: "marketplace-asset",
      message: "Deep link apply for marketplace-asset is not yet supported by the marketplace install surface.",
    });
  });
});
