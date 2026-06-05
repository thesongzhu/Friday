import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { createFridayApiRuntime } from "#api";
import type { CreateFridayApiRuntimeDeps, FridayAuthPrincipal } from "#api";
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

function makeDeps(): CreateFridayApiRuntimeDeps {
  return {
    db: createTestDb(),
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    providerService: makeProviderService(),
    tokenSecret: "unit-test-token-key", // pragma: allowlist secret
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: async () => ({ ok: true }),
    allowTestOnlyWorkflowRunExecution: true,
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
});
