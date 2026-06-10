import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import { createFridayMcpServerUpgradeLifecycleService } from "../../../src/autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import { createFridayMutatingActionGate } from "../../../src/security/friday-mutating-action-gate.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for the autonomy MCP-server
 * upgrade-lifecycle (orphan off-route leak audit, 2026-06-10 defense-in-depth).
 *
 * registerShadowVersion/recordCanaryResult/promote/rollback were ROUTE-only-
 * guarded (assertAutonomyLifecycleTestOracleAllowed). This proves each method
 * fail-closes by default (flag unset) BEFORE the canonical-ticket check and any
 * state write. With the test-oracle flag the guard is open (and the method then
 * reaches its canonical-ticket requirement instead of the retirement 503).
 */

const RETIRED_CODE = "TS_RUNTIME_AUTONOMY_LIFECYCLE_RETIRED";

describe("FridayMcpServerUpgradeLifecycleService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;
  let stateDir: string;

  beforeEach(() => {
    db = createTestDb();
    stateDir = mkdtempSync(join(tmpdir(), "friday-mcp-lifecycle-guard-"));
  });

  afterEach(() => {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function buildService(allowTestOnlyAutonomyLifecycleExecution?: boolean) {
    return createFridayMcpServerUpgradeLifecycleService({
      db,
      stateRepo: createFridayAutonomySubjectUpgradeStateRepository(),
      mcpAdapter: {
        listServers: () => [{ id: "stdio-echo", transport: "stdio", command: "node", args: ["server.js"] }],
        listTools: async () => [{ serverId: "stdio-echo", name: "echo", inputSchema: { type: "object" } }],
      },
      nowIso: () => "2026-06-10T00:00:00.000Z",
      stateDir,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => "2026-06-10T00:00:00.000Z",
        ticketIdGenerator: () => "ticket-1",
      }),
      ...(allowTestOnlyAutonomyLifecycleExecution === undefined
        ? {}
        : { allowTestOnlyAutonomyLifecycleExecution }),
    });
  }

  const shadowInput = {
    serverId: "stdio-echo",
    shadowVersionId: "stdio-echo@shadow",
    runtimeVersion: "f27377c",
    providerModel: "claude-sonnet-4-20250514",
    actor: { kind: "user" as const, id: "user-1", principalId: "user-1" },
    surface: "api:/v1/autonomy/mcp-servers/shadow",
    planDigest: "mcp-plan-1",
  };

  it("registerShadowVersion fails closed by default: throws 503 fail_closed", () => {
    const service = buildService();
    let caught: unknown;
    try {
      service.registerShadowVersion(shadowInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe(RETIRED_CODE);
    expect((caught as FridayDomainError).httpStatus).toBe(503);
  });

  it("promote and rollback also fail closed by default", async () => {
    const service = buildService();
    expect(() =>
      service.promote({ ...shadowInput, surface: "api:/v1/autonomy/mcp-servers/promote" }),
    ).toThrow(expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }));
    expect(() =>
      service.rollback({ ...shadowInput, surface: "api:/v1/autonomy/mcp-servers/rollback" }),
    ).toThrow(expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }));
    await expect(
      service.recordCanaryResult({ ...shadowInput, surface: "api:/v1/autonomy/mcp-servers/canary" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  });

  it("also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() => service.registerShadowVersion(shadowInput)).toThrow(
      expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }),
    );
  });

  it("getLifecycleEvidence (read) stays live without the flag", () => {
    const service = buildService();
    expect(service.getLifecycleEvidence({ serverId: "stdio-echo" })).toBeNull();
  });

  it("passes the guard when the flag is enabled (reaches the canonical-ticket requirement, not the 503)", () => {
    const service = buildService(true);
    // Guard open: registerShadowVersion now reaches its canonical-ticket check and
    // throws a DIFFERENT error (no valid canonical approval), NOT the retirement 503,
    // proving the method guard no longer blocks the legacy path.
    let caught: unknown;
    try {
      service.registerShadowVersion(shadowInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).not.toBe(RETIRED_CODE);
  });
});
