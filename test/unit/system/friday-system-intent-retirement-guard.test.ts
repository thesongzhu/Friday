import { afterEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridaySystemService } from "../../../src/system/engine/friday-system-service.js";
import type { FridaySystemService } from "../../../src/system/engine/friday-system-service.js";
import { createFridaySystemUnavailableCompanionBridge } from "../../../src/system/companion/friday-system-local-companion-bridge.js";
import { createFridayAgentSystemTool } from "#agent";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for system intent execution.
 *
 * The system-intent retirement was ROUTE-only (friday-system-routes asserts
 * `allowTestOnlySystemIntentExecution` before POST /v1/system/intents). The
 * agent system tool reaches `executeIntent` directly via
 * `systemService.executeIntent(...)`, bypassing the route guard.
 *
 * These tests prove the guard now lives on the METHOD: in default/live config
 * (test-oracle flag unset) `executeIntent` fails closed BEFORE any
 * approval-rule read, lease mutation, companion call, or exec side effect —
 * no system event is emitted. With the explicit test-oracle flag enabled the
 * legacy path proceeds past the guard. Reads (getSession/getState/listEvents)
 * stay live, mirroring the route surface.
 */

const RETIRED_CODE = "TS_RUNTIME_SYSTEM_INTENT_RETIRED";

function createNowIso() {
  let tick = 0;
  const start = Date.parse("2026-06-09T00:00:00.000Z");
  return () => new Date(start + tick++ * 1000).toISOString();
}

describe("FridaySystemService TS-retirement method guard (executeIntent)", () => {
  const allocatedDbs: FridaySqliteLayer[] = [];

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  async function buildService(
    allowTestOnlySystemIntentExecution?: boolean,
  ): Promise<FridaySystemService> {
    const db = createTestDb();
    allocatedDbs.push(db);
    const nowIso = createNowIso();
    const companionBridge = createFridaySystemUnavailableCompanionBridge({
      id: "companion-retirement-guard",
      platform: "darwin",
      nowIso,
      launchAtLoginEnabled: false,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: false,
      overlayEnabled: false,
      unavailableReason: "companion unavailable in guard test",
    });
    return createFridaySystemService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso,
      workspaceRoot: "/tmp/friday-system-retirement-guard-workspace",
      companionBridge,
      execCommand: async () => {
        throw new Error("execCommand must not run when executeIntent is fail-closed");
      },
      ...(allowTestOnlySystemIntentExecution === undefined
        ? {}
        : { allowTestOnlySystemIntentExecution }),
    });
  }

  it("fails closed by default: throws 503 fail_closed and emits no intent event", async () => {
    const service = await buildService();
    const eventsBefore = service.listEvents().length;

    let caught: unknown;
    try {
      await service.executeIntent({
        action: "recover_ui",
        actorId: "agent-1",
        actorKind: "agent",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_system_intent_execution_entrypoint_required",
    });
    const intentEvents = service
      .listEvents()
      .slice(eventsBefore)
      .filter((event) => event.event.startsWith("system.intent."));
    expect(intentEvents).toEqual([]);
  });

  it("fails closed when the flag is explicitly false (only exact `true` opts in)", async () => {
    const service = await buildService(false);
    await expect(
      service.executeIntent({ action: "recover_ui", actorId: "agent-1", actorKind: "agent" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  });

  it("reads stay live without the flag (getSession/getState/listEvents are not retired)", async () => {
    const service = await buildService();
    const session = await service.getSession();
    expect(session.id).toBeTruthy();
    const state = await service.getState();
    expect(state).toBeTruthy();
    expect(Array.isArray(service.listEvents())).toBe(true);
  });

  it("proceeds past the guard when the test-oracle flag is enabled (legacy execution path)", async () => {
    const service = await buildService(true);

    // The unavailable companion bridge makes recover_ui FAIL inside the legacy
    // path — a legacy 'failed' intent result, not the retirement throw — which
    // proves the guard no longer blocks the method.
    const result = await service.executeIntent({
      action: "recover_ui",
      actorId: "agent-1",
      actorKind: "agent",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toBe("companion unavailable in guard test");
  });

  it("agent system tool caller observes the 503-class error as a tool error, not a crash", async () => {
    const service = await buildService();
    const tool = createFridayAgentSystemTool({ systemService: service });

    const result = await tool.execute(
      { action: "recover_ui" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("fail-closed");
  });
});
