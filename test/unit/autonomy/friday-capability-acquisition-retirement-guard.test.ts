import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  createFridayAutonomyPolicyService,
  createFridayCapabilityAcquisitionService,
  type FridayAutonomyPolicyService,
  type FridayStandingAgendaService,
} from "../../../src/autonomy/index.js";
import { createFridayAgentControlledAutonomyTool } from "#agent";
import { createTestDb, createTestIdGenerator } from "../satellites/_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for capability acquisition.
 *
 * The capability-acquisition retirement was ROUTE-only
 * (friday-autonomy-routes asserts `allowTestOnlyCapabilityAcquisitionExecution`
 * before the acquisition routes). The agent controlled-autonomy tool
 * (`acquisition_start`/`acquisition_approve`/`acquisition_cancel`) and the
 * standing-agenda service (`runAgendaItem` → `acquisitionService.startRun`)
 * reach the service methods directly, bypassing the route guard.
 *
 * These tests prove the guard now lives on the METHODS: in default/live config
 * (test-oracle flag unset) `startRun`/`approveRun`/`cancelRun` fail closed
 * BEFORE any run-row write. With the explicit test-oracle flag enabled the
 * legacy paths still work. Reads (`plan`/`getRun`) stay live, mirroring the
 * route surface (which asserts only on the run-mutation routes).
 */

const RETIRED_CODE = "TS_RUNTIME_CAPABILITY_ACQUISITION_RETIRED";

describe("FridayCapabilityAcquisitionService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;
  let policyService: FridayAutonomyPolicyService;

  beforeEach(() => {
    db = createTestDb();
    policyService = createFridayAutonomyPolicyService({
      db,
      nowIso: () => "2026-06-09T00:00:00.000Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlyCapabilityAcquisitionExecution?: boolean) {
    // No capabilitySnapshotGetter: the service falls back to the canonical
    // empty runtime capability matrix, which is enough for guard placement
    // proofs (run creation/cancellation, not capability competence).
    return createFridayCapabilityAcquisitionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-06-09T00:00:00.000Z",
      policyService,
      ...(allowTestOnlyCapabilityAcquisitionExecution === undefined
        ? {}
        : { allowTestOnlyCapabilityAcquisitionExecution }),
    });
  }

  function countAcquisitionRunRows(): number {
    return db.withReadConnection((reader) =>
      (reader
        .prepare("SELECT COUNT(*) AS c FROM friday_capability_acquisition_runs")
        .get() as { c: number }).c,
    );
  }

  it("startRun fails closed by default: throws 503 fail_closed and writes no run row", async () => {
    const service = buildService();

    let caught: unknown;
    try {
      await service.startRun({ userId: "test-user", goal: "do a thing", requiredCapabilities: ["text"] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_capability_acquisition_entrypoint_required",
    });
    expect(countAcquisitionRunRows()).toBe(0);
  });

  it("approveRun and cancelRun fail closed by default and when the flag is explicitly false", async () => {
    const defaultService = buildService();
    await expect(defaultService.approveRun("run-1")).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });

    let cancelCaught: unknown;
    try {
      defaultService.cancelRun("run-1");
    } catch (error) {
      cancelCaught = error;
    }
    expect(cancelCaught).toBeInstanceOf(FridayDomainError);
    expect((cancelCaught as FridayDomainError).code).toBe(RETIRED_CODE);

    const explicitlyOff = buildService(false);
    await expect(
      explicitlyOff.startRun({ userId: "test-user", goal: "do a thing", requiredCapabilities: ["text"] }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
    expect(countAcquisitionRunRows()).toBe(0);
  });

  it("plan and getRun stay live without the flag (reads are not retired)", async () => {
    const service = buildService();
    const planned = await service.plan({ userId: "test-user", goal: "do a thing", requiredCapabilities: ["text"] });
    expect(planned.id.startsWith("plan-")).toBe(true);
    expect(service.getRun("missing-run")).toBeNull();
    expect(countAcquisitionRunRows()).toBe(0);
  });

  it("runs normally when the test-oracle flag is enabled (legacy path preserved)", async () => {
    const service = buildService(true);
    const run = await service.startRun({
      userId: "test-user",
      goal: "do a thing",
      requiredCapabilities: ["text"],
    });
    expect(countAcquisitionRunRows()).toBe(1);
    const cancelled = service.cancelRun(run.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("agent controlled-autonomy tool caller observes the 503-class error as a tool error, not a crash", async () => {
    const service = buildService();
    const tool = createFridayAgentControlledAutonomyTool({
      policyService,
      acquisitionService: service,
      standingAgendaService: {} as unknown as FridayStandingAgendaService,
      defaultUserId: "test-user",
    });

    const result = await tool.execute(
      { action: "acquisition_start", goal: "do a thing" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("fail-closed");
    expect(countAcquisitionRunRows()).toBe(0);
  });
});
