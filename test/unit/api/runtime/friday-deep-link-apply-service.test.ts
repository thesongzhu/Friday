import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayDeepLinkApplyService } from "../../../../src/api/runtime/friday-deep-link-apply-service.js";
import { FridayDomainError } from "#errors";
import {
  createFridaySkillStageMutatingActionRequest,
} from "#skills/converter";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
} from "../../../../src/security/friday-mutating-action-gate.js";
import type { FridayProviderService } from "#providers";
import type { FridaySkillConverterService } from "#skills/converter";
import type {
  FridayWorkflowCrudService,
  FridayWorkflowBuilderImportExportService,
  FridayWorkflowSpecBundleV1,
} from "#workflows";
import type { FridayAgentSsrfGuard } from "#agent";

const NOW = "2026-04-21T00:00:00.000Z";
const PRINCIPAL = {
  kind: "user",
  id: "user-1",
  principalId: "user-1",
};

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
    getCandidate: vi.fn(() => null),
    import: vi.fn(async () => ({
      converterId: "code-repo",
      detectedFormat: "code-repo",
      candidates: [
        {
          candidateId: "candidate-1",
          shadowVersionId: "candidate-1",
          skillId: "imported-skill",
          version: "1.0.0",
          converterId: "code-repo",
          detectedFormat: "code-repo",
          sourceProvenance: {
            sourceKind: "uri",
            sourceDigest: "source-digest-1",
            redactedUri: "https://example.com/imported-skill",
          },
          candidateDir: "/tmp/candidate-1",
          filesDir: "/tmp/candidate-1/files",
          stagedAt: "2026-04-21T00:00:00.000Z",
          validation: { ok: true, issues: [], verifiedAt: "2026-04-21T00:00:00.000Z" },
        },
      ],
      validation: [],
      registryRefreshed: false,
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

function makeWorkflowCrud(): Pick<FridayWorkflowCrudService, "createWorkflow" | "archiveWorkflow"> {
  return {
    createWorkflow: vi.fn((input) => ({
      id: "wf-import-1",
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      tags: input.tags ?? [],
      ownerUserId: input.ownerUserId,
      latestVersionNumber: 0,
      publishedVersionNumber: null,
      isArchived: false,
      revision: 1,
      etag: "wf-etag",
      lastVerifiedAt: null,
      lastVerifiedRuntimeVersion: null,
      lastVerifiedProviderModel: null,
      compatibilityStatus: "unknown",
      promotionChannel: "dev",
      shadowVersionId: null,
      canaryStats: { attempted: 0, succeeded: 0, failed: 0 },
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      deletedBy: null,
    } as never)),
    archiveWorkflow: vi.fn(),
  };
}

function makeSsrfGuard(): FridayAgentSsrfGuard {
  return {
    validate: vi.fn(),
    validateWithDns: vi.fn(async () => undefined),
  };
}

function makeCanonicalMutationGate() {
  return createFridayMutatingActionGate({
    nowIso: () => NOW,
    ticketIdGenerator: () => "ticket-1",
  });
}

function makeSkillSourceApprovalOptions(url: string, secret?: string) {
  const request = createFridaySkillStageMutatingActionRequest({
    source: { uri: url },
    formatHint: "auto",
    actor: PRINCIPAL,
    surface: "api:/v1/deeplink/apply",
    idempotencyKey: "deeplink-stage-1",
  });
  return {
    actor: PRINCIPAL,
    surface: "api:/v1/deeplink/apply",
    idempotencyKey: "deeplink-stage-1",
      canonicalApproval: secret
        ? signFridayCanonicalApproval({
          decision: "approved" as const,
          approvalId: "approval-1",
          decidedByPrincipalId: PRINCIPAL.principalId,
          actionDigest: createFridayMutatingActionDigest(request),
          expiresAt: "2026-04-21T01:00:00.000Z",
        }, secret)
        : {
        decision: "approved" as const,
        approvalId: "approval-1",
        decidedByPrincipalId: PRINCIPAL.principalId,
        actionDigest: createFridayMutatingActionDigest(request),
        expiresAt: "2026-04-21T01:00:00.000Z",
      },
  };
}

describe("createFridayDeepLinkApplyService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps provider-template apply preview-only without writing providers", async () => {
    const providerService = makeProviderService();
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService,
      converterService: makeConverterService(),
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
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
    }, {
      actor: PRINCIPAL,
      surface: "api:/v1/deeplink/apply",
      idempotencyKey: "deeplink-provider-1",
      planDigest: "deeplink-provider-plan-1",
      canonicalApproval: {
        decision: "approved" as const,
        approvalId: "provider-template-approval-1",
        decidedByPrincipalId: PRINCIPAL.principalId,
        actionDigest: "unused-provider-template-digest",
        expiresAt: "2026-04-21T01:00:00.000Z",
      },
    });

    expect(result).toEqual({
      applied: false,
      resourceType: "provider-template",
      message: "Provider template OpenAI API is preview-only until provider lifecycle staging, validation, and promotion are wired.",
    });
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it("does not write provider-template payloads when provider mutation gate profile is off", async () => {
    const providerService = makeProviderService();
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService,
      converterService: makeConverterService(),
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
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

    expect(result.applied).toBe(false);
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it("does not ask canonical gate or create providers for provider-template apply", async () => {
    const providerService = makeProviderService();
    const canonicalMutationGate = makeCanonicalMutationGate();
    const gateSpy = vi.spyOn(canonicalMutationGate, "evaluate");
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService,
      converterService: makeConverterService(),
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate,
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
    expect(result.applied).toBe(false);
    expect(gateSpy).not.toHaveBeenCalled();
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it("stages skill-source payloads as candidates without installing them", async () => {
    const converterService = makeConverterService();
    (converterService.import as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      converterId: "code-repo",
      detectedFormat: "code-repo",
      candidates: [{
        candidateId: "candidate-1",
        skillId: "draft-skill",
      }],
      validation: [],
      registryRefreshed: false,
    });
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
    });
    const sourceUrl = "https://example.com/skill-repo";

    const result = await service.apply({
      version: 1,
      type: "skill-source",
      label: "Install skill",
      skillSource: {
        url: sourceUrl,
      },
    }, makeSkillSourceApprovalOptions(sourceUrl));

    expect(result).toEqual({
      applied: true,
      resourceType: "skill-source",
      resourceId: "candidate-1",
      message: "Skill source https://example.com/skill-repo was staged as 1 candidate(s). It was not installed or made available.",
    });
    expect(converterService.import).toHaveBeenCalledWith(expect.objectContaining({
      source: { uri: "https://example.com/skill-repo" },
      formatHint: "auto",
      canonicalApprovalTicket: expect.objectContaining({
        action: "skills.import.stage_candidate",
        approvalId: "approval-1",
        ticketId: "ticket-1",
      }),
    }));
    expect(converterService.convert).not.toHaveBeenCalled();
  });

  it("redacts token-bearing skill-source URLs from deeplink success messages", async () => {
    const converterService = makeConverterService();
    (converterService.import as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      converterId: "code-repo",
      detectedFormat: "code-repo",
      candidates: [{
        candidateId: "candidate-1",
        skillId: "draft-skill",
      }],
      validation: [],
      registryRefreshed: false,
    });
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
    });
    const sourceUrl = "https://example.com/skill-repo?token=deeplink-secret-token";

    const result = await service.apply({
      version: 1,
      type: "skill-source",
      label: "Install skill",
      skillSource: {
        url: sourceUrl,
      },
    }, makeSkillSourceApprovalOptions(sourceUrl));

    expect(result.message).not.toContain(sourceUrl);
    expect(result.message).not.toContain("deeplink-secret-token");
    expect(result.message).toContain("https://example.com/skill-repo?redacted=1");
  });

  it("accepts production-signed canonical approval and passes the issued ticket to import", async () => {
    const converterService = makeConverterService();
    const secret = "deeplink-production-secret"; // pragma: allowlist secret
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "signed-ticket-1",
        approvalSignatureSecret: secret,
      }),
    });
    const sourceUrl = "https://example.com/skill-repo";

    await service.apply({
      version: 1,
      type: "skill-source",
      label: "Install skill",
      skillSource: {
        url: sourceUrl,
      },
    }, makeSkillSourceApprovalOptions(sourceUrl, secret));

    expect(converterService.import).toHaveBeenCalledWith(expect.objectContaining({
      canonicalApprovalTicket: expect.objectContaining({
        ticketId: "signed-ticket-1",
        approvalId: "approval-1",
        action: "skills.import.stage_candidate",
      }),
    }));
  });

  it("redacts token-bearing skill-source URLs from deeplink validation issue summaries", async () => {
    const converterService = makeConverterService();
    const sourceUrl = "https://example.com/skill-repo?token=deeplink-validation-secret-token";
    (converterService.import as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      converterId: "code-repo",
      detectedFormat: "code-repo",
      candidates: [{
        candidateId: "candidate-1",
        skillId: "draft-skill",
      }],
      validation: [{
        skillId: "draft-skill",
        ok: false,
        issues: [{
          stage: "manifest",
          severity: "warning",
          code: "SOURCE_WARNING",
          message: `source needs review: ${sourceUrl}`,
        }],
      }],
      registryRefreshed: false,
    });
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
    });

    const result = await service.apply({
      version: 1,
      type: "skill-source",
      label: "Install skill",
      skillSource: {
        url: sourceUrl,
      },
    }, makeSkillSourceApprovalOptions(sourceUrl));

    expect(result.message).not.toContain(sourceUrl);
    expect(result.message).not.toContain("deeplink-validation-secret-token");
    expect(result.message).toContain("https://example.com/skill-repo?redacted=1");
  });

  it("redacts token-bearing skill-source URLs from deeplink import errors", async () => {
    const converterService = makeConverterService();
    const sourceUrl = "https://example.com/skill-repo?token=deeplink-error-secret-token";
    (converterService.import as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new FridayDomainError(
        "CONVERTER_GIT_CLONE_FAILED",
        `Failed to clone git repository: ${sourceUrl}`,
        {
          httpStatus: 422,
          details: {
            sourceUri: sourceUrl,
            stderr: `fatal: could not read from ${sourceUrl}`,
          },
        },
      ),
    );
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
    });

    let thrown: unknown;
    try {
      await service.apply({
        version: 1,
        type: "skill-source",
        label: "Install skill",
        skillSource: {
          url: sourceUrl,
        },
      }, makeSkillSourceApprovalOptions(sourceUrl));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).message).not.toContain(sourceUrl);
    expect(JSON.stringify((thrown as FridayDomainError).details)).not.toContain(sourceUrl);
    expect(JSON.stringify((thrown as FridayDomainError).details)).not.toContain("deeplink-error-secret-token");
    expect(JSON.stringify((thrown as FridayDomainError).details)).toContain("sourceProvenance");
  });

  it("blocks skill-source staging before converter side effects when canonical approval is missing", async () => {
    const converterService = makeConverterService();
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "id-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService,
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
      canonicalMutationGate: makeCanonicalMutationGate(),
    });

    await expect(service.apply({
      version: 1,
      type: "skill-source",
      label: "Install skill",
      skillSource: {
        url: "https://example.com/skill-repo",
      },
    })).rejects.toThrow("requires canonical approval");
    expect(converterService.import).not.toHaveBeenCalled();
  });

  it("applies workflow-template payloads by fetching and importing a workflow bundle", async () => {
    const workflowImportExport = makeWorkflowImportExport();
    const workflowCrud = makeWorkflowCrud();
    const ssrfGuard = makeSsrfGuard();
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
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService: makeConverterService(),
      workflowImportExport,
      workflowCrud,
      workflowTemplateSsrfGuard: ssrfGuard,
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
      workflowId: "wf-import-1",
      resourceUrl: "/workflows/builder?workflowId=wf-import-1&draftId=draft-1&focus=draft",
      message: 'Imported workflow template as draft "Imported Workflow". Review confirmation is required before publish or deploy.',
    });
    expect(ssrfGuard.validateWithDns).toHaveBeenCalledWith("https://example.com/workflow.json");
    expect(workflowCrud.createWorkflow).toHaveBeenCalledWith({
      slug: "imported-workflow-wf-impor",
      name: "Imported Workflow",
      description: "Imported from a Friday workflow-template deep link.",
      tags: ["deeplink", "external-template"],
    });
    expect(workflowImportExport.importBundle).toHaveBeenCalledWith(bundle, "wf-import-1", undefined, {
      sourceReview: {
        source: "deeplink.workflow_template",
        sourceUrl: "https://example.com/workflow.json",
        importedAt: NOW,
        requiresReviewBeforePublish: true,
      },
    });
  });

  it("archives the created workflow when workflow-template bundle import fails", async () => {
    const workflowImportExport = makeWorkflowImportExport();
    const workflowCrud = makeWorkflowCrud();
    (workflowImportExport.importBundle as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new FridayDomainError("IMPORT_CHECKSUM_MISMATCH", "Bundle checksum mismatch", { httpStatus: 400 });
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bundleSchemaVersion: "1.0",
        exportedAt: "2026-04-21T00:00:00.000Z",
        source: { type: "draft", id: "draft-src", workflowId: "wf-src" },
        workflow: { name: "Broken Import" },
        spec: {
          schemaVersion: "1.0",
          workflowId: "wf-src",
          name: "Broken Import",
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
        checksum: "bad-checksum",
      }),
    })));
    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "wf-import-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService: makeConverterService(),
      workflowImportExport,
      workflowCrud,
    });

    await expect(service.apply({
      version: 1,
      type: "workflow-template",
      label: "Import workflow",
      workflowTemplate: {
        url: "https://example.com/broken-workflow.json",
      },
    })).rejects.toMatchObject({
      code: "IMPORT_CHECKSUM_MISMATCH",
    });
    expect(workflowCrud.archiveWorkflow).toHaveBeenCalledWith("wf-import-1", "deeplink.workflow_template");
  });

  it("blocks private workflow-template URLs before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = createFridayDeepLinkApplyService({
      idGenerator: () => "wf-import-1",
      nowIso: () => NOW,
      providerService: makeProviderService(),
      converterService: makeConverterService(),
      workflowImportExport: makeWorkflowImportExport(),
      workflowCrud: makeWorkflowCrud(),
    });

    await expect(service.apply({
      version: 1,
      type: "workflow-template",
      label: "Import workflow",
      workflowTemplate: {
        url: "http://127.0.0.1:8080/workflow.json",
      },
    })).rejects.toMatchObject({
      code: "WORKFLOW_TEMPLATE_URL_BLOCKED",
      httpStatus: 403,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

});
