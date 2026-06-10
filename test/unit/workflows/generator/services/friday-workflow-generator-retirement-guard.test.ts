import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridayWorkflowGeneratorService } from "#workflows";
import type {
  CreateFridayWorkflowGeneratorServiceDeps,
  FridayWorkflowGeneratorService,
} from "#workflows";
import { createFridayAgentWorkflowGeneratorTool } from "#agent";
import { createTestDb, createTestIdGenerator } from "../../../satellites/_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for the workflow generator.
 *
 * The workflow-generator retirement was ROUTE-only
 * (friday-workflow-generator-routes asserts `allowTestOnlyWorkflowGeneratorExecution`
 * before each handler). The agent workflow-generator tool, the UIX assistant
 * surface (`startWorkflowSession`), and the reflex candidate pipeline
 * (`generateWorkflowDraft`/`approveGeneratedCandidate`) reach
 * `startSession`/`generateDraft`/`approveAndSave` directly, bypassing the
 * route guard.
 *
 * These tests prove the guard now lives on the METHODS: in default/live config
 * (test-oracle flag unset) the three mutation methods fail closed BEFORE any
 * session-row write or provider call. With the explicit test-oracle flag the
 * legacy path proceeds past the guard (the full legacy behavior is covered by
 * friday-workflow-generator-service.test.ts, which now opts in explicitly).
 */

const RETIRED_CODE = "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED";
const NOW = "2026-06-09T00:00:00.000Z";

describe("FridayWorkflowGeneratorService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    // Any provider call would go through fetch — fail loudly if the guard ever
    // lets a default-config mutation reach the LLM client.
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the generator is fail-closed");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  function buildService(allowTestOnlyWorkflowGeneratorExecution?: boolean): FridayWorkflowGeneratorService {
    const deps = {
      db,
      providerService: {} as never,
      workflowCrud: {} as never,
      skillRegistry: { listSkills: () => [] } as never,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      computeChecksum: (content: string) => `checksum-${content.length}`,
      ...(allowTestOnlyWorkflowGeneratorExecution === undefined
        ? {}
        : { allowTestOnlyWorkflowGeneratorExecution }),
    } satisfies CreateFridayWorkflowGeneratorServiceDeps;
    return createFridayWorkflowGeneratorService(deps);
  }

  function countMemoryItemRows(): number {
    return db.withReadConnection((reader) =>
      (reader.prepare("SELECT COUNT(*) AS c FROM memory_items").get() as { c: number }).c,
    );
  }

  it("startSession fails closed by default: throws 503 fail_closed and persists nothing", async () => {
    const service = buildService();
    const rowsBefore = countMemoryItemRows();

    let caught: unknown;
    try {
      await service.startSession({ goal: "Build a workflow", userId: "u-1", channel: "test" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_workflow_generator_entrypoint_required",
    });
    expect(countMemoryItemRows()).toBe(rowsBefore);
  });

  it("generateDraft and approveAndSave fail closed by default and when the flag is explicitly false", async () => {
    const defaultService = buildService();
    await expect(defaultService.generateDraft("session-1")).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
    await expect(defaultService.approveAndSave("session-1")).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });

    const explicitlyOff = buildService(false);
    await expect(
      explicitlyOff.startSession({ goal: "Build a workflow", userId: "u-1", channel: "test" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  });

  it("proceeds past the guard when the test-oracle flag is enabled (legacy errors, not the retirement code)", async () => {
    const service = buildService(true);

    // With the flag on, the next failure is the legacy domain error for an
    // unknown session — proving the guard no longer blocks the method.
    await expect(service.generateDraft("missing-session")).rejects.toMatchObject({
      code: "GENERATOR_SESSION_NOT_FOUND",
      httpStatus: 404,
    });
    await expect(service.approveAndSave("missing-session")).rejects.toMatchObject({
      code: "GENERATOR_SESSION_NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("agent workflow-generator tool caller observes the 503-class error as a tool error, not a crash", async () => {
    const service = buildService();
    const tool = createFridayAgentWorkflowGeneratorTool({ generatorService: service });

    const result = await tool.execute(
      { action: "start", goal: "Build a workflow" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("retired");
  });

  // ── submitTurn (the off-route generation + provider-spend bypass) ──

  it("submitTurn fails closed by default: throws 503 fail_closed, persists nothing, and never calls the provider", async () => {
    const service = buildService();
    const rowsBefore = countMemoryItemRows();

    let caught: unknown;
    try {
      // fetch is booby-trapped in beforeEach; if the guard let submitTurn reach
      // the requirements analyzer this would throw the fetch error instead.
      await service.submitTurn("any-session", { message: "hello" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_workflow_generator_entrypoint_required",
    });
    // No turn appended, no session row mutated.
    expect(countMemoryItemRows()).toBe(rowsBefore);
  });

  it("submitTurn fails closed when the flag is explicitly false", async () => {
    const explicitlyOff = buildService(false);
    await expect(
      explicitlyOff.submitTurn("any-session", { message: "hello" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  });

  it("submitTurn proceeds past the guard when the test-oracle flag is enabled (legacy not-found, not the retirement code)", async () => {
    const service = buildService(true);
    // With the flag on, the next failure is requireSession's legacy not-found —
    // proving the guard no longer blocks the method (and it runs before any
    // provider call, so the booby-trapped fetch is never reached).
    await expect(
      service.submitTurn("missing-session", { message: "hello" }),
    ).rejects.toMatchObject({ code: "GENERATOR_SESSION_NOT_FOUND", httpStatus: 404 });
  });

  it("agent workflow-generator tool 'turn' caller observes the 503-class error as a tool error, not a crash", async () => {
    const service = buildService();
    const tool = createFridayAgentWorkflowGeneratorTool({ generatorService: service });

    const result = await tool.execute(
      { action: "turn", sessionId: "persisted-session", message: "more detail" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("retired");
  });

  // ── cancelSession (status flip + draft delete) ──

  it("cancelSession fails closed by default and when the flag is explicitly false", async () => {
    const rowsBefore = countMemoryItemRows();
    await expect(buildService().cancelSession("any-session")).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
    await expect(buildService(false).cancelSession("any-session")).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
    // Nothing mutated/deleted while fail-closed.
    expect(countMemoryItemRows()).toBe(rowsBefore);
  });

  it("cancelSession proceeds past the guard when the test-oracle flag is enabled (legacy not-found, not the retirement code)", async () => {
    const service = buildService(true);
    await expect(service.cancelSession("missing-session")).rejects.toMatchObject({
      code: "GENERATOR_SESSION_NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("agent workflow-generator tool 'cancel' caller observes the 503-class error as a tool error, not a crash", async () => {
    const service = buildService();
    const tool = createFridayAgentWorkflowGeneratorTool({ generatorService: service });

    const result = await tool.execute(
      { action: "cancel", sessionId: "persisted-session" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("retired");
  });
});
