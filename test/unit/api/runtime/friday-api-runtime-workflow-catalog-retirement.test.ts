import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { createFridayApiRuntime } from "#api";
import type { CreateFridayApiRuntimeDeps, FridayAuthPrincipal } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";
import {
  createTestSpec,
  createTestVisual,
} from "../../workflows/builder/_helpers/create-test-spec.helper.js";

const NOW = "2026-06-05T00:00:00.000Z";

// Unique markers seeded as raw private/command/secret data so the assertions
// can prove the redacted compatibility projections never surface them.
const GRAPH_API_KEY_SECRET = "GRAPH_NODE_API_KEY_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret
const GRAPH_COMMAND_SECRET = "rm -rf /tmp/GRAPH_RAW_COMMAND_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret
const RUN_TRIGGER_SECRET = "RUN_TRIGGER_PAYLOAD_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret
const DRAFT_ARG_SECRET = "DRAFT_STEP_ARG_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret
const DRAFT_INPUT_SECRET = "DRAFT_INPUT_DEFAULT_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret
const DRAFT_TEST_SECRET = "DRAFT_TEST_CASE_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret
const DRAFT_OWNER_SECRET = "draft-owner-user-id-secret-marker"; // pragma: allowlist secret -- test marker, not a real secret
const DRAFT_SOURCE_URL_SECRET = "https://private-source.example/DRAFT_SOURCE_URL_SECRET_MARKER"; // pragma: allowlist secret -- test marker, not a real secret

function makeProviderService(): FridayProviderService {
  return {
    listProviders: async () => [],
    getProvider: async () => null,
    createProvider: async () => {
      throw new Error("not-implemented");
    },
    updateProvider: async () => {
      throw new Error("not-implemented");
    },
    deleteProvider: async () => undefined,
    validateProvider: async () => ({ status: "ok", checkedAt: NOW }),
    getRoutingConfig: async () => ({ defaultProviderId: "test", fallbackProviderIds: [] }),
    setRoutingConfig: async (input) => input,
    resolveRoute: async () => ({
      provider: {
        id: "test-provider",
        kind: "openai",
        name: "Test Provider",
        baseUrl: "https://example.test",
        enabled: true,
        config: {
          api: "openai-completions",
          authMode: "api-key",
          keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
          supportedModels: ["gpt-4o-mini"],
          validation: { status: "ok", checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "gpt-4o-mini",
    }),
    runWithFallback: async () => {
      throw new Error("not-implemented");
    },
  } as FridayProviderService;
}

function makeDeps(overrides: Partial<CreateFridayApiRuntimeDeps> = {}): CreateFridayApiRuntimeDeps {
  return {
    db: createTestDb(),
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    providerService: makeProviderService(),
    tokenSecret: "unit-test-token-key", // pragma: allowlist secret
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: async () => ({ ok: true }),
    ...overrides,
  };
}

// Minimal valid compiled graph whose single node carries raw command/secret
// data in its `config`. The product service synthesizes spec step `args` from
// node `config`, so this also exercises spec-arg redaction in visualization.
function makeGraphWithSecretConfig(workflowId: string): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: "placeholder",
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          label: "Trigger",
          config: {
            apiKey: GRAPH_API_KEY_SECRET,
            command: GRAPH_COMMAND_SECRET,
          },
        },
      ],
      edges: [],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

const ownerPrincipal: FridayAuthPrincipal = {
  principalType: "user",
  principalId: "tenant-owner",
  userId: "test-user",
  role: "operator",
  scopes: ["workflow.write", "workflow.read"],
  tokenId: "token-owner",
  tokenKind: "access",
  issuedAt: NOW,
};

function invoker(runtime: ReturnType<typeof createFridayApiRuntime>) {
  return (operationId: string, overrides: Record<string, unknown> = {}) => {
    const route = runtime.routes.getRoutes().find((candidate) => candidate.operationId === operationId);
    expect(route, `route ${operationId} should be registered`).toBeDefined();
    return route!.handler({
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: ownerPrincipal,
      requestId: `req-${operationId}`,
      receivedAt: NOW,
      ...overrides,
    } as never);
  };
}

describe("API runtime workflow catalog/builder retirement", () => {
  it("fail-closes workflows.bundles.import by default and not when the test oracle is set", async () => {
    const failClosedDeps = makeDeps();
    const failClosedRuntime = createFridayApiRuntime(failClosedDeps);
    const invokeFailClosed = invoker(failClosedRuntime);

    await expect(
      invokeFailClosed("workflows.bundles.import", {
        params: { workflowId: "wf-import" },
        body: { bundle: { schemaVersion: "1.0" } },
      }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_BUNDLE_IMPORT_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_bundle_import_entrypoint_required",
      },
    });
    failClosedDeps.db.close();

    // With the explicit isolated test oracle, the retirement guard no longer
    // fires (the call proceeds into validation/import and fails for a different
    // reason or succeeds), proving the flag is the only thing gating it.
    const oracleDeps = makeDeps({ allowTestOnlyWorkflowBundleImportExecution: true });
    const oracleRuntime = createFridayApiRuntime(oracleDeps);
    const invokeOracle = invoker(oracleRuntime);
    let oracleError: { code?: string } | undefined;
    try {
      await invokeOracle("workflows.bundles.import", {
        params: { workflowId: "wf-import" },
        body: { bundle: { schemaVersion: "1.0" } },
      });
    } catch (error) {
      oracleError = error as { code?: string };
    }
    expect(oracleError?.code).not.toBe("TS_RUNTIME_WORKFLOW_BUNDLE_IMPORT_RETIRED");
    oracleDeps.db.close();
  });

  it("redacts workflow catalog list/get/version reads", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);
    const invoke = invoker(runtime);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "redacted-catalog-read",
      name: "Redacted Catalog Read",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeGraphWithSecretConfig(workflow.id),
    );

    const listRead = (await invoke("workflows.list", {})) as {
      items: Array<Record<string, unknown>>;
    };
    // The allowlist-built projection never carries these private/runtime fields.
    for (const item of listRead.items) {
      expect(item.ownerUserId).toBeUndefined();
      expect(item.lastVerifiedProviderModel).toBeUndefined();
      expect(item.lastVerifiedRuntimeVersion).toBeUndefined();
      expect(item.deletedBy).toBeUndefined();
      expect(item.shadowVersionId).toBeUndefined();
    }

    const getRead = (await invoke("workflows.get", {
      params: { workflowId: workflow.id },
    })) as {
      workflow: Record<string, unknown>;
      latestVersion: Record<string, unknown>;
    };
    expect(getRead.workflow.ownerUserId).toBeUndefined();
    expect(getRead.latestVersion.createdByUserId).toBeUndefined();
    expect(getRead.latestVersion.graphJson).toMatchObject({ redacted: true });
    expect(JSON.stringify(getRead)).not.toContain(GRAPH_API_KEY_SECRET);
    expect(JSON.stringify(getRead)).not.toContain(GRAPH_COMMAND_SECRET);
    expect(JSON.stringify(getRead)).not.toContain("token-owner");

    const versionsRead = (await invoke("workflows.list.versions", {
      params: { workflowId: workflow.id },
    })) as { items: Array<Record<string, unknown>> };
    expect(versionsRead.items.length).toBeGreaterThan(0);
    for (const item of versionsRead.items) {
      expect(item.createdByUserId).toBeUndefined();
      expect(item.graphJson).toMatchObject({ redacted: true });
    }
    expect(JSON.stringify(versionsRead)).not.toContain(GRAPH_API_KEY_SECRET);
    expect(JSON.stringify(versionsRead)).not.toContain(GRAPH_COMMAND_SECRET);

    const versionRead = (await invoke("workflow.versions.get", {
      params: { versionId: version.id },
    })) as { version: Record<string, unknown> };
    expect(versionRead.version.createdByUserId).toBeUndefined();
    expect(versionRead.version.graphJson).toMatchObject({ redacted: true });
    expect(JSON.stringify(versionRead)).not.toContain(GRAPH_API_KEY_SECRET);
    expect(JSON.stringify(versionRead)).not.toContain(GRAPH_COMMAND_SECRET);

    deps.db.close();
  });

  it("redacts workflow overview and visualization while keeping pure canvas layout", async () => {
    const deps = makeDeps({ allowTestOnlyWorkflowRunExecution: true });
    const runtime = createFridayApiRuntime(deps);
    const invoke = invoker(runtime);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "redacted-product-read",
      name: "Redacted Product Read",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeGraphWithSecretConfig(workflow.id),
    );

    // Seed a draft carrying raw spec args, an input default, a test case, an
    // owner user id, and a private source URL.
    const draft = runtime.draftService.createDraft({
      workflowId: workflow.id,
      title: "Secret Draft",
      ownerUserId: DRAFT_OWNER_SECRET,
      spec: createTestSpec({
        workflowId: workflow.id,
        steps: [
          { id: "step-1", type: "skill_call", ref: "test-skill", args: { token: DRAFT_ARG_SECRET } },
        ],
        inputs: [{ key: "k", type: "string", required: false, defaultValue: DRAFT_INPUT_SECRET }],
        tests: [{ name: "t", inputs: { x: DRAFT_TEST_SECRET }, assertions: [] }],
      }),
      visual: createTestVisual(workflow.id),
      sourceReview: {
        source: "bundle_import",
        sourceUrl: DRAFT_SOURCE_URL_SECRET,
        importedAt: NOW,
        requiresReviewBeforePublish: true,
      },
    });

    // Seed a run carrying a raw trigger payload.
    await invoke("runs.start", {
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        triggerPayload: { secret: RUN_TRIGGER_SECRET },
        dryRun: true,
      },
    });

    const overview = (await invoke("workflows.overview", {
      params: { workflowId: workflow.id },
    })) as { overview: Record<string, unknown> };
    const overviewBody = overview.overview;
    const overviewJson = JSON.stringify(overview);

    const drafts = overviewBody.drafts as Array<Record<string, unknown>>;
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.ownerUserId).toBeUndefined();
      const spec = draft.spec as { steps: Array<Record<string, unknown>> };
      for (const step of spec.steps) {
        expect(step.args).toBeUndefined();
      }
      const sourceReview = draft.sourceReview as Record<string, unknown> | undefined;
      if (sourceReview) {
        expect(sourceReview.sourceUrl).toBeUndefined();
      }
    }
    const latestVersion = overviewBody.latestVersion as Record<string, unknown> | undefined;
    expect(latestVersion?.graphJson).toMatchObject({ redacted: true });
    for (const run of overviewBody.recentRuns as Array<Record<string, unknown>>) {
      expect(run.triggerPayload).toBeUndefined();
      expect(run.context).toBeUndefined();
      expect(run.startedByUserId).toBeUndefined();
    }
    expect(overviewJson).not.toContain(GRAPH_API_KEY_SECRET);
    expect(overviewJson).not.toContain(GRAPH_COMMAND_SECRET);
    expect(overviewJson).not.toContain(RUN_TRIGGER_SECRET);
    expect(overviewJson).not.toContain(DRAFT_ARG_SECRET);
    expect(overviewJson).not.toContain(DRAFT_INPUT_SECRET);
    expect(overviewJson).not.toContain(DRAFT_TEST_SECRET);
    expect(overviewJson).not.toContain(DRAFT_OWNER_SECRET);
    expect(overviewJson).not.toContain(DRAFT_SOURCE_URL_SECRET);

    // Version-target visualization: proves version graphJson redaction and that
    // pure canvas layout is preserved (not over-redacted).
    const visualization = (await invoke("workflows.visualization", {
      params: { workflowId: workflow.id },
    })) as { visualization: Record<string, unknown> };
    const vizBody = visualization.visualization;
    const vizJson = JSON.stringify(visualization);

    const vizVersion = vizBody.version as Record<string, unknown> | undefined;
    if (vizVersion) {
      expect(vizVersion.graphJson).toMatchObject({ redacted: true });
    }
    // The visual graph has no command/secret-bearing config, so it stays
    // available for the UI.
    const vizVisual = vizBody.visual as { nodes?: unknown[] };
    expect(Array.isArray(vizVisual.nodes)).toBe(true);
    expect(vizJson).not.toContain(GRAPH_API_KEY_SECRET);
    expect(vizJson).not.toContain(GRAPH_COMMAND_SECRET);

    // Draft-target visualization: the synthesized/draft spec has a real step
    // whose raw args carry a secret, so the spec-args redaction is load-bearing
    // here (not a vacuous empty-step loop).
    const draftViz = (await invoke("workflows.visualization", {
      params: { workflowId: workflow.id },
      query: { draftId: draft.draftId },
    })) as { visualization: Record<string, unknown> };
    const draftVizSpec = draftViz.visualization.spec as { steps: Array<Record<string, unknown>> };
    expect(draftVizSpec.steps.length).toBeGreaterThan(0);
    for (const step of draftVizSpec.steps) {
      expect(step.args).toBeUndefined();
    }
    const draftVizJson = JSON.stringify(draftViz);
    expect(draftVizJson).not.toContain(DRAFT_ARG_SECRET);
    expect(draftVizJson).not.toContain(DRAFT_INPUT_SECRET);
    expect(draftVizJson).not.toContain(DRAFT_TEST_SECRET);
    expect(draftVizJson).not.toContain(DRAFT_OWNER_SECRET);

    deps.db.close();
  });
});
