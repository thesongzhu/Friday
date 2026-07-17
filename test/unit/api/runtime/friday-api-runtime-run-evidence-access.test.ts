import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { createFridayApiRuntime } from "#api";
import type { CreateFridayApiRuntimeDeps, FridayAuthPrincipal } from "#api";
import type { FridayHttpRawTextResponse } from "../../../../src/api/http/friday-http-raw-response.js";
import type { FridayProviderService } from "#providers";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-02-27T00:00:00.000Z";

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

function makeDeps(options: { allowTestOnlyWorkflowRunExecution?: boolean } = {
  allowTestOnlyWorkflowRunExecution: true,
}): CreateFridayApiRuntimeDeps {
  return {
    db: createTestDb(),
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    providerService: makeProviderService(),
    // No durable master key in this unit context: opt into the TEST-ONLY inactive
    // (identity) realtime pseudonymizer so workflow-run realtime publishes do not
    // fail-closed (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1). This test asserts
    // content-redaction of run projections, not identifier opacity.
    allowTestOnlyInactiveRealtimePseudonym: true,
    tokenSecret: "unit-test-token-key", // pragma: allowlist secret
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: async () => ({ ok: true }),
    ...(options.allowTestOnlyWorkflowRunExecution === true
      ? { allowTestOnlyWorkflowRunExecution: true }
      : {}),
  };
}

function makeMinimalGraph(
  workflowId: string,
  workflowVersionId: string,
): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
      ],
      edges: [],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

describe("API runtime run evidence access control", () => {
  it("keeps workflow evidence export mutation fail-closed outside test-oracle wiring", async () => {
    const deps = makeDeps({ allowTestOnlyWorkflowRunExecution: false });
    const runtime = createFridayApiRuntime(deps);
    const route = runtime.routes.getRoutes().find((candidate) => candidate.operationId === "runs.evidence.export");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { runId: "run-retired" },
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-owner",
        userId: "test-user",
        role: "operator",
        scopes: ["workflow.write", "workflow.read"],
        tokenId: "token-owner",
        tokenKind: "access",
        issuedAt: NOW,
      },
      requestId: "req-retired-export",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_RUN_EVIDENCE_EXPORT_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_run_evidence_export_entrypoint_required",
      },
    });

    deps.db.close();
  });

  it("blocks non-owner principal from run metadata route as well", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "run-read-auth-test",
      name: "Run Read Auth Test",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeMinimalGraph(workflow.id, "placeholder"),
    );

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.start");
    const getRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.get");
    expect(startRoute).toBeDefined();
    expect(getRoute).toBeDefined();

    const ownerPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-owner",
      userId: "test-user",
      role: "viewer",
      scopes: ["workflow.write", "workflow.read"],
      tokenId: "token-owner",
      tokenKind: "access",
      issuedAt: NOW,
    };
    const intruderPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-intruder",
      userId: "user-intruder",
      role: "viewer",
      scopes: ["workflow.read"],
      tokenId: "token-intruder",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const started = await startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        dryRun: true,
      },
      headers: {},
      principal: ownerPrincipal,
      requestId: "req-start-run-read",
      receivedAt: NOW,
    } as never) as { run: { id: string } };

    await expect(getRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: intruderPrincipal,
      requestId: "req-run-read-deny",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "WORKFLOW_RUN_FORBIDDEN",
      httpStatus: 403,
    });

    await expect(getRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: ownerPrincipal,
      requestId: "req-run-read-allow",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      run: { id: started.run.id },
    });

    deps.db.close();
  });

  it("allows owner principal and blocks non-owner/non-tenant principal", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "evidence-auth-test",
      name: "Evidence Auth Test",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeMinimalGraph(workflow.id, "placeholder"),
    );

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.start");
    const evidenceRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.evidence");
    expect(startRoute).toBeDefined();
    expect(evidenceRoute).toBeDefined();

    const ownerPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-owner",
      userId: "test-user",
      role: "viewer",
      scopes: ["workflow.write", "workflow.read"],
      tokenId: "token-owner",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const intruderPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-intruder",
      userId: "user-intruder",
      role: "viewer",
      scopes: ["workflow.read"],
      tokenId: "token-intruder",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const started = await startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        dryRun: true,
      },
      headers: {},
      principal: ownerPrincipal,
      requestId: "req-start",
      receivedAt: NOW,
    } as never) as { run: { id: string } };

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: intruderPrincipal,
      requestId: "req-deny",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "WORKFLOW_RUN_EVIDENCE_FORBIDDEN",
      httpStatus: 403,
    });

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: ownerPrincipal,
      requestId: "req-allow",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      run: { id: started.run.id },
    });

    deps.db.close();
  });

  it("allows same-tenant principals by tenantId and blocks other tenants", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "evidence-auth-tenant-context",
      name: "Evidence Auth Tenant Context",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeMinimalGraph(workflow.id, "placeholder"),
    );

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.start");
    const evidenceRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.evidence");
    expect(startRoute).toBeDefined();
    expect(evidenceRoute).toBeDefined();

    const ownerPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "user-owner",
      tenantId: "tenant-shared",
      userId: "test-user",
      role: "viewer",
      scopes: ["workflow.write", "workflow.read"],
      tokenId: "token-owner-tenant",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const sameTenantPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "user-peer",
      tenantId: "tenant-shared",
      userId: "peer-user-id",
      role: "viewer",
      scopes: ["workflow.read"],
      tokenId: "token-peer",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const otherTenantPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "user-other",
      tenantId: "tenant-other",
      userId: "other-user-id",
      role: "viewer",
      scopes: ["workflow.read"],
      tokenId: "token-other",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const started = await startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        dryRun: true,
      },
      headers: {},
      principal: ownerPrincipal,
      requestId: "req-start-tenant-context",
      receivedAt: NOW,
    } as never) as { run: { id: string } };

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: sameTenantPrincipal,
      requestId: "req-tenant-allow",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      run: { id: started.run.id },
    });

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: otherTenantPrincipal,
      requestId: "req-tenant-deny",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "WORKFLOW_RUN_EVIDENCE_FORBIDDEN",
      httpStatus: 403,
    });

    deps.db.close();
  });

  it("allows privileged hub.admin principals to read cross-tenant run evidence", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "evidence-auth-admin",
      name: "Evidence Auth Admin",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeMinimalGraph(workflow.id, "placeholder"),
    );

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.start");
    const evidenceRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.evidence");
    expect(startRoute).toBeDefined();
    expect(evidenceRoute).toBeDefined();

    const tenantOwnerPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-owner",
      userId: "test-user",
      role: "viewer",
      scopes: ["workflow.write", "workflow.read"],
      tokenId: "token-owner",
      tokenKind: "access",
      issuedAt: NOW,
    };
    const adminPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-admin",
      userId: "admin-user",
      role: "viewer",
      scopes: ["workflow.read", "hub.admin"],
      tokenId: "token-admin",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const started = await startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        dryRun: true,
      },
      headers: {},
      principal: tenantOwnerPrincipal,
      requestId: "req-start-admin",
      receivedAt: NOW,
    } as never) as { run: { id: string } };

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: adminPrincipal,
      requestId: "req-admin",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      run: { id: started.run.id },
    });

    deps.db.close();
  });

  it("allows originating satellite principal and blocks unrelated satellite principal", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "evidence-auth-satellite",
      name: "Evidence Auth Satellite",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeMinimalGraph(workflow.id, "placeholder"),
    );

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.start");
    const evidenceRoute = runtime.routes.getRoutes().find((route) => route.operationId === "runs.evidence");
    expect(startRoute).toBeDefined();
    expect(evidenceRoute).toBeDefined();

    const satelliteOwnerPrincipal: FridayAuthPrincipal = {
      principalType: "satellite",
      principalId: "sat-1",
      role: "viewer",
      scopes: ["workflow.write", "workflow.read"],
      tokenId: "token-sat-1",
      tokenKind: "access",
      issuedAt: NOW,
    };
    const otherSatellitePrincipal: FridayAuthPrincipal = {
      principalType: "satellite",
      principalId: "sat-2",
      role: "viewer",
      scopes: ["workflow.read"],
      tokenId: "token-sat-2",
      tokenKind: "access",
      issuedAt: NOW,
    };

    deps.db.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO satellites (
           id, type, display_name, pairing_status, trust_level, public_key,
           token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "sat-1",
        "desktop",
        "Satellite One",
        "active",
        "trusted",
        "pub-key-1",
        1,
        "ws",
        "darwin",
        "arm64",
        "1.0.0",
        "20.11.0",
        "[]",
        NOW,
        NOW,
      );
    });

    const started = await startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        dryRun: true,
      },
      headers: {},
      principal: satelliteOwnerPrincipal,
      requestId: "req-start-sat",
      receivedAt: NOW,
    } as never) as { run: { id: string } };

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: satelliteOwnerPrincipal,
      requestId: "req-sat-allow",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      run: { id: started.run.id },
    });

    await expect(evidenceRoute!.handler({
      params: { runId: started.run.id },
      query: {},
      body: null,
      headers: {},
      principal: otherSatellitePrincipal,
      requestId: "req-sat-deny",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "WORKFLOW_RUN_EVIDENCE_FORBIDDEN",
      httpStatus: 403,
    });

    deps.db.close();
  });

  it("redacts workflow run read, timeline, evidence export, and download projections", async () => {
    const deps = makeDeps();
    const runtime = createFridayApiRuntime(deps);

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "redacted-workflow-run-read-test",
      name: "Redacted Workflow Run Read Test",
    });
    const version = runtime.workflowCrud.createVersion(
      workflow.id,
      makeMinimalGraph(workflow.id, "placeholder"),
    );

    const ownerPrincipal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-owner",
      userId: "test-user",
      role: "viewer",
      scopes: ["workflow.write", "workflow.read"],
      tokenId: "token-owner",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const route = (operationId: string) => {
      const found = runtime.routes.getRoutes().find((candidate) => candidate.operationId === operationId);
      expect(found).toBeDefined();
      return found!;
    };
    const invoke = (operationId: string, overrides: Record<string, unknown>) =>
      route(operationId).handler({
        params: {},
        query: {},
        body: null,
        headers: {},
        principal: ownerPrincipal,
        requestId: `req-${operationId}`,
        receivedAt: NOW,
        ...overrides,
      } as never);

    const started = await invoke("runs.start", {
      body: {
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        triggerPayload: {
          privateTranscript: "raw-transcript-secret",
          providerId: "provider-secret",
        },
        dryRun: true,
      },
    }) as { run: { id: string } };
    const runId = started.run.id;

    deps.db.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO realtime_events (
           event_id, stream_id, seq, event, payload_json, emitted_at,
           correlation_id, state_version_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt-private-timeline",
        `run:${runId}`,
        999,
        "workflow.node.private",
        JSON.stringify({
          nodeId: "trigger",
          attempt: 1,
          status: "completed",
          privateTranscript: "raw-transcript-secret",
          filePath: "/private/tmp/friday/private-evidence.json",
          providerId: "provider-secret",
        }),
        NOW,
        "correlation-secret",
        null,
        NOW,
      );
    });

    const runRead = await invoke("runs.get", {
      params: { runId },
    }) as { run: Record<string, unknown> };
    expect(runRead.run.triggerPayload).toBeUndefined();
    expect(runRead.run.context).toBeUndefined();
    expect(runRead.run.startedByUserId).toBeUndefined();
    expect(JSON.stringify(runRead)).not.toContain("raw-transcript-secret");
    expect(JSON.stringify(runRead)).not.toContain("token-owner");

    const nodesRead = await invoke("runs.list.nodes", {
      params: { runId },
    }) as { items: Array<Record<string, unknown>> };
    for (const node of nodesRead.items) {
      expect(node.input).toBeUndefined();
      expect(node.output).toBeUndefined();
      expect(node.satelliteId).toBeUndefined();
      expect(node.leaseOwner).toBeUndefined();
      expect(node.idempotencyKey).toBe("redacted");
    }

    const timelineRead = await invoke("runs.timeline", {
      params: { runId },
      query: { afterSeq: 998, limit: 5 },
    }) as { items: Array<Record<string, unknown>> };
    expect(timelineRead.items).toHaveLength(1);
    expect(timelineRead.items[0]!.payload).toMatchObject({
      redacted: true,
      shape: {
        kind: "object",
      },
    });
    expect(JSON.stringify(timelineRead)).not.toContain("raw-transcript-secret");
    expect(JSON.stringify(timelineRead)).not.toContain("/private/tmp/friday");
    expect(JSON.stringify(timelineRead)).not.toContain("provider-secret");

    await invoke("runs.evidence.export", {
      params: { runId },
      body: {},
    });

    const exportsList = await invoke("runs.evidence.exports.list", {
      params: { runId },
    }) as { items: Array<Record<string, unknown>> };
    expect(exportsList.items).toHaveLength(1);
    const exportId = exportsList.items[0]!.exportId as string;
    expect(exportsList.items[0]!.artifactId).toBe("redacted");
    expect(exportsList.items[0]!.uri).toBe(`friday://workflow-runs/${runId}/evidence-exports/${exportId}.json`);
    expect(exportsList.items[0]!.filePersisted).toBe(false);
    expect(JSON.stringify(exportsList)).not.toContain("file://");

    const exportDetail = await invoke("runs.evidence.exports.get", {
      params: { runId, exportId },
    }) as { export: Record<string, unknown>; evidence: Record<string, unknown> };
    expect(exportDetail.export.artifactId).toBe("redacted");
    expect(exportDetail.export.uri).toBe(`friday://workflow-runs/${runId}/evidence-exports/${exportId}.json`);
    expect(JSON.stringify(exportDetail)).not.toContain("file://");

    const download = await invoke("runs.evidence.exports.download", {
      params: { runId, exportId },
    }) as FridayHttpRawTextResponse;
    expect(download.__fridayRawTextResponse).toBe(true);
    expect(download.headers?.["X-Friday-Evidence-File-Persisted"]).toBe("false");
    const downloaded = JSON.parse(download.body) as Record<string, unknown>;
    expect(JSON.stringify(downloaded)).not.toContain("file://");
    expect(JSON.stringify(downloaded)).not.toContain("/private/tmp/friday");
    expect(JSON.stringify(downloaded)).not.toContain("raw-transcript-secret");
    expect((downloaded.export as Record<string, unknown>).artifactId).toBe("redacted");

    deps.db.close();
  });
});
