import { describe, expect, it, vi } from "vitest";

import type { FridayWorkflowBuilderRuntime, FridayWorkflowRuntime } from "#workflows";
import { FridayDomainError } from "#errors";
import { createFridayWorkflowProductService } from "../../../src/workflows/services/friday-workflow-product-service.js";

/**
 * TS Runtime Retirement — METHOD-level guard for workflow deployment.
 *
 * The workflow-deploy retirement was ROUTE-only
 * (friday-workflow-product-routes asserts `allowTestOnlyWorkflowDeployExecution`
 * before POST .../deploy). The UIX deploy-workflow card (`deployWorkflowCard`)
 * and the cross-border pack service (preset `deployDraft` during pack
 * enablement) reach the method directly, bypassing the route guard.
 *
 * `materializeGeneratedSession` shares the same deploy flag: it is NOT a read —
 * it persists a workflow row + draft (the deploy-preparation step) and is
 * reached only via the UIX assistant create/continue/generate-workflow flows,
 * which also bypass the route guard.
 *
 * These tests prove the guard now lives on the METHODS: in default/live config
 * (test-oracle flag unset) `deployDraft` and `materializeGeneratedSession` fail
 * closed BEFORE any workflow read, lock acquisition, compile, publish, trigger
 * resync, run start, or workflow/draft persist. With the explicit test-oracle
 * flag enabled the legacy path proceeds past the guard (full legacy deployment
 * behavior is covered by friday-workflow-product-service.test.ts, which now
 * opts in explicitly).
 */

const RETIRED_CODE = "TS_RUNTIME_WORKFLOW_DEPLOY_RETIRED";
const NOW = "2026-06-09T00:00:00.000Z";

function makeGuardDeps() {
  const builderRuntime = {
    collaboration: {
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
    },
    compositor: {
      compileDraft: vi.fn(),
      publishDraft: vi.fn(),
    },
    drafts: {
      getDraft: vi.fn(),
      // materializeGeneratedSession persists a draft via this in both branches.
      createDraft: vi.fn(() => {
        throw new Error("createDraft must not run when materialize is fail-closed");
      }),
    },
    importExport: {
      exportDraft: vi.fn(),
    },
  } as unknown as FridayWorkflowBuilderRuntime;
  const workflowRuntime = {
    crud: {
      getWorkflow: vi.fn(() => null),
      // materializeGeneratedSession persists a workflow row via this in the
      // draft-present branch — must never run while fail-closed.
      createWorkflow: vi.fn(() => {
        throw new Error("createWorkflow must not run when materialize is fail-closed");
      }),
    },
    triggers: {
      syncPublishedVersionTriggers: vi.fn(),
    },
    execution: {
      startRun: vi.fn(),
    },
  } as unknown as FridayWorkflowRuntime;
  return { builderRuntime, workflowRuntime };
}

function buildService(input: {
  builderRuntime: FridayWorkflowBuilderRuntime;
  workflowRuntime: FridayWorkflowRuntime;
  allowTestOnlyWorkflowDeployExecution?: boolean;
  workflowGenerator?: unknown;
}) {
  return createFridayWorkflowProductService({
    builderRuntime: input.builderRuntime,
    workflowRuntime: input.workflowRuntime,
    db: {
      withReadConnection: () => {
        throw new Error("db must not be read when deployDraft is fail-closed");
      },
    },
    idGenerator: () => "id-1",
    nowIso: () => NOW,
    ...(input.workflowGenerator === undefined ? {} : { workflowGenerator: input.workflowGenerator as never }),
    ...(input.allowTestOnlyWorkflowDeployExecution === undefined
      ? {}
      : { allowTestOnlyWorkflowDeployExecution: input.allowTestOnlyWorkflowDeployExecution }),
  });
}

describe("FridayWorkflowProductService TS-retirement method guard (deployDraft)", () => {
  it("fails closed by default: throws 503 fail_closed before any read, lock, compile, or run", async () => {
    const { builderRuntime, workflowRuntime } = makeGuardDeps();
    const service = buildService({ builderRuntime, workflowRuntime });

    let caught: unknown;
    try {
      await service.deployDraft({
        workflowId: "wf-1",
        draftId: "draft-1",
        actorUserId: "user-1",
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
      replacement: "rust_owned_workflow_deployment_entrypoint_required",
    });

    // The guard runs BEFORE any state read or side effect.
    expect(workflowRuntime.crud.getWorkflow).not.toHaveBeenCalled();
    expect(builderRuntime.collaboration.acquireLock).not.toHaveBeenCalled();
    expect(builderRuntime.compositor.compileDraft).not.toHaveBeenCalled();
    expect(builderRuntime.compositor.publishDraft).not.toHaveBeenCalled();
    expect(workflowRuntime.triggers.syncPublishedVersionTriggers).not.toHaveBeenCalled();
    expect(workflowRuntime.execution.startRun).not.toHaveBeenCalled();
  });

  it("fails closed when the flag is explicitly false (only exact `true` opts in)", async () => {
    const { builderRuntime, workflowRuntime } = makeGuardDeps();
    const service = buildService({
      builderRuntime,
      workflowRuntime,
      allowTestOnlyWorkflowDeployExecution: false,
    });

    await expect(
      service.deployDraft({ workflowId: "wf-1", draftId: "draft-1", actorUserId: "user-1" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
    expect(workflowRuntime.crud.getWorkflow).not.toHaveBeenCalled();
  });

  it("proceeds past the guard when the test-oracle flag is enabled (legacy errors, not the retirement code)", async () => {
    const { builderRuntime, workflowRuntime } = makeGuardDeps();
    const service = buildService({
      builderRuntime,
      workflowRuntime,
      allowTestOnlyWorkflowDeployExecution: true,
    });

    // With the flag on, the next failure is the legacy domain error for an
    // unknown workflow — proving the guard no longer blocks the method.
    await expect(
      service.deployDraft({ workflowId: "wf-missing", draftId: "draft-1", actorUserId: "user-1" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND", httpStatus: 404 });
    expect(workflowRuntime.crud.getWorkflow).toHaveBeenCalledWith("wf-missing");
  });
});

describe("FridayWorkflowProductService TS-retirement method guard (materializeGeneratedSession)", () => {
  it("fails closed by default: throws 503 fail_closed before any generator read or workflow/draft persist", async () => {
    const { builderRuntime, workflowRuntime } = makeGuardDeps();
    // A generator stub whose getSession is booby-trapped — proves the guard
    // fires BEFORE the generator is even consulted.
    const getSession = vi.fn(() => {
      throw new Error("generator.getSession must not run when materialize is fail-closed");
    });
    const service = buildService({
      builderRuntime,
      workflowRuntime,
      workflowGenerator: { getSession },
    });

    let caught: unknown;
    try {
      await service.materializeGeneratedSession({ sessionId: "sess-1", actorUserId: "user-1" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_workflow_deployment_entrypoint_required",
    });

    // The guard runs BEFORE any generator read or persist side effect.
    expect(getSession).not.toHaveBeenCalled();
    expect(workflowRuntime.crud.createWorkflow).not.toHaveBeenCalled();
    expect(builderRuntime.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("fails closed when the flag is explicitly false (only exact `true` opts in)", async () => {
    const { builderRuntime, workflowRuntime } = makeGuardDeps();
    const getSession = vi.fn(() => {
      throw new Error("generator.getSession must not run when materialize is fail-closed");
    });
    const service = buildService({
      builderRuntime,
      workflowRuntime,
      workflowGenerator: { getSession },
      allowTestOnlyWorkflowDeployExecution: false,
    });

    await expect(
      service.materializeGeneratedSession({ sessionId: "sess-1", actorUserId: "user-1" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
    expect(getSession).not.toHaveBeenCalled();
    expect(workflowRuntime.crud.createWorkflow).not.toHaveBeenCalled();
    expect(builderRuntime.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("proceeds past the guard when the test-oracle flag is enabled (reaches the legacy generator-availability check, not the retirement code)", async () => {
    const { builderRuntime, workflowRuntime } = makeGuardDeps();
    // No workflowGenerator wired: with the flag on, the guard is passed and the
    // method reaches its legacy WORKFLOW_GENERATOR_UNAVAILABLE check — proving
    // the guard no longer blocks the method.
    const service = buildService({
      builderRuntime,
      workflowRuntime,
      allowTestOnlyWorkflowDeployExecution: true,
    });

    await expect(
      service.materializeGeneratedSession({ sessionId: "sess-1", actorUserId: "user-1" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_GENERATOR_UNAVAILABLE", httpStatus: 503 });
  });
});
