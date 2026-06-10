import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";

import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import {
  createFridayMcpServerLifecycleMutatingActionRequest,
  createFridayMcpServerUpgradeLifecycleService,
} from "../../../src/autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayMcpServerUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;
  let stateDir: string;

  beforeEach(() => {
    db = createTestDb();
    stateDir = mkdtempSync(join(tmpdir(), "friday-mcp-lifecycle-"));
  });

  afterEach(() => {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeApproval(input: {
    action: "shadow" | "canary" | "promote" | "rollback";
    shadowVersionId?: string;
    planDigest?: string;
  }): FridayCanonicalApprovalResolution {
    const planDigest = input.planDigest ?? "mcp-plan-1";
    const request = createFridayMcpServerLifecycleMutatingActionRequest({
      action: input.action,
      serverId: "stdio-echo",
      shadowVersionId: input.shadowVersionId ?? "stdio-echo@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: {
        kind: "user",
        id: "user-1",
        principalId: "user-1",
      },
      surface: `api:/v1/autonomy/mcp-servers/${input.action}`,
      planDigest,
      rollback: input.action === "rollback"
        ? { planned: true, planDigest, actions: ["mcp_servers.lifecycle.promote"] }
        : undefined,
    });
    return {
      decision: "approved",
      approvalId: `mcp-${input.action}-approval`,
      decidedByPrincipalId: "user-1",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-04-17T23:15:00.000Z",
    };
  }

  function makeService(options: { listToolsReject?: Error } = {}) {
    const repo = createFridayAutonomySubjectUpgradeStateRepository();
    const canonicalMutationGate = createFridayMutatingActionGate({
      nowIso: () => "2026-04-17T22:15:00.000Z",
      ticketIdGenerator: () => "ticket-1",
    });
    const service = createFridayMcpServerUpgradeLifecycleService({
      db,
      stateRepo: repo,
      mcpAdapter: {
        listServers: () => [{ id: "stdio-echo", transport: "stdio", command: "node", args: ["server.js"] }],
        listTools: options.listToolsReject
          ? async () => {
              throw options.listToolsReject;
            }
          : async () => [{ serverId: "stdio-echo", name: "echo", inputSchema: { type: "object" } }],
      },
      nowIso: () => "2026-04-17T22:15:00.000Z",
      stateDir,
      canonicalMutationGate,
      // TS-runtime-retirement: exercise the legacy lifecycle mutations in these
      // unit tests; default/live runtime leaves this unset so they fail closed
      // (the 503-by-default behavior is asserted in the dedicated guard test).
      allowTestOnlyAutonomyLifecycleExecution: true,
    });
    return { repo, service };
  }

  it("requires canonical approval before shadow can mutate", () => {
    const { repo, service } = makeService();

    expect(() => service.registerShadowVersion({
      serverId: "stdio-echo",
      shadowVersionId: "stdio-echo@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/shadow",
      planDigest: "mcp-plan-1",
    })).toThrow(/canonical approval/i);

    const state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state).toBeNull();
  });

  it("tracks shadow, canary, promote, and rollback metadata for MCP servers", async () => {
    const { repo, service } = makeService();

    service.registerShadowVersion({
      serverId: "stdio-echo",
      shadowVersionId: "stdio-echo@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/shadow",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "shadow" }),
    });

    let state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("shadow");
    expect(state?.shadowVersionId).toBe("stdio-echo@shadow");

    await service.recordCanaryResult({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/canary",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "canary" }),
    });
    state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("canary");
    expect(state?.canaryStats?.sampleSize).toBe(1);
    expect(state?.canaryStats?.successCount).toBe(1);

    service.promote({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/promote",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "promote" }),
    });
    state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("active");
    expect(state?.lastVerifiedAt).toBe("2026-04-17T22:15:00.000Z");

    service.rollback({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/rollback",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "rollback" }),
    });
    state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("rolled_back");
    expect(state?.compatibilityStatus).toBe("adaptation_required");
    expect(state?.shadowVersionId).toBeUndefined();
    expect(state?.canaryStats?.rollbackCount).toBe(1);
    expect(service.getLifecycleEvidence({ serverId: "stdio-echo" })?.stage).toBe("rolled_back");
  });

  it("records failed canary evidence and blocks promote", async () => {
    const { service } = makeService({ listToolsReject: new Error("server offline token=fixture-secret-value") });

    service.registerShadowVersion({
      serverId: "stdio-echo",
      shadowVersionId: "stdio-echo@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/shadow",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "shadow" }),
    });

    await expect(service.recordCanaryResult({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/canary",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "canary" }),
    })).rejects.toMatchObject({ code: "MCP_SERVER_CANARY_RUNTIME_PROOF_FAILED" });

    const evidenceText = readFileSync(join(stateDir, "mcp-server-lifecycle", "stdio-echo.json"), "utf8");
    expect(evidenceText).not.toContain("fixture-secret-value");
    expect(evidenceText).toContain("[REDACTED_SECRET]");

    expect(() => service.promote({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/mcp-servers/promote",
      planDigest: "mcp-plan-1",
      canonicalApproval: makeApproval({ action: "promote" }),
    })).toThrow(/successful canary/i);
  });
});
