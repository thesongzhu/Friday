import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import { createFridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";

describe("createFridayUixSurfaceService", () => {
  it("marks destructive requests as blocked by policy during intent resolution", () => {
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const resolution = service.resolveIntent({
      text: "Delete the production secret and rotate credentials now",
      userId: "user-1",
    });

    expect(resolution.intent).toBe("general_help");
    expect(resolution.state).toBe("blocked_by_policy");
    expect(resolution.assumptions.length).toBeGreaterThan(0);
    expect(resolution.objective).toContain("Delete the production secret");
    expect(resolution.fallbackPath).toContain("approval");
  });

  it("converges a short ambiguous wizard goal into one decisive follow-up", async () => {
    const service = createFridayUixSurfaceService({
      idGenerator: () => "wizard-context-1",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
        reportStructuredFailure: vi.fn(),
      } as never,
      workflowGenerator: {
        startSession: vi.fn(async () => ({
          session: { sessionId: "workflow-session-1" },
          mode: "clarification_required",
          questions: ["Which repository should Friday change first?"],
        })),
      } as never,
      workflowProduct: {} as never,
    });

    const started = service.startWizard({
      wizardId: "guided-assistant",
      userId: "user-1",
    });

    const response = await service.continueWizard({
      wizardId: "guided-assistant",
      contextId: started.wizard.contextId,
      userId: "user-1",
      values: { goal: "Fix deployment" },
    });

    expect(response.state).toBe("needs_one_answer");
    expect(response.workflow?.deployReady).toBe(false);
    expect(response.unknowns).toContain("Which repository should Friday change first?");
    expect(response.summary).toContain("Which repository");
  });

  it("reports unexpected template failures into self-healing", async () => {
    const reportStructuredFailure = vi.fn();
    const service = createFridayUixSurfaceService({
      idGenerator: () => "assistant-error-1",
      selfHealing: {
        reportStructuredFailure,
        listIssueCards: vi.fn(() => []),
      } as never,
      skillGenerator: {
        startSession: vi.fn(async () => {
          throw new Error("workflow compiler exploded");
        }),
      } as never,
    });

    await expect(
      service.executeTemplate({
        templateId: "generate-skill",
        userId: "user-1",
        parameters: { goal: "Build a summary skill" },
      }),
    ).rejects.toThrow("workflow compiler exploded");

    expect(reportStructuredFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        runId: "assistant:template:assistant-error-1",
        category: "workflow",
        severity: "high",
        message: "workflow compiler exploded",
        correlationId: "assistant-template:generate-skill",
        context: {
          source: "assistant",
          scope: "template",
          detail: "generate-skill",
        },
      }),
    );
  });

  it("does not report expected validation failures into self-healing", async () => {
    const reportStructuredFailure = vi.fn();
    const service = createFridayUixSurfaceService({
      idGenerator: () => "assistant-error-2",
      selfHealing: {
        reportStructuredFailure,
        listIssueCards: vi.fn(() => []),
      } as never,
      skillGenerator: {
        startSession: vi.fn(async () => ({
          mode: "completed",
          session: { sessionId: "skill-session-1" },
          draft: null,
        })),
      } as never,
    });

    await expect(
      service.executeTemplate({
        templateId: "generate-skill",
        userId: "user-1",
        parameters: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" } satisfies Partial<FridayDomainError>);

    expect(reportStructuredFailure).not.toHaveBeenCalled();
  });

  it("wraps unexpected deploy failures as UIX_DEPLOY_FAILED with 422", async () => {
    const reportStructuredFailure = vi.fn();
    const service = createFridayUixSurfaceService({
      idGenerator: () => "assistant-error-3",
      selfHealing: {
        reportStructuredFailure,
        listIssueCards: vi.fn(() => []),
      } as never,
      workflowProduct: {
        materializeGeneratedSession: vi.fn(async () => {
          throw new Error("workflow session exploded");
        }),
      } as never,
    });

    await expect(
      service.executeTemplate({
        templateId: "deploy-workflow",
        userId: "user-1",
        parameters: { sessionId: "workflow-session-1", runNow: true },
      }),
    ).rejects.toMatchObject({
      code: "UIX_DEPLOY_FAILED",
      httpStatus: 422,
      message: "workflow session exploded",
    } satisfies Partial<FridayDomainError>);

    expect(reportStructuredFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "assistant-template:deploy-workflow",
        message: "workflow session exploded",
      }),
    );
  });

  it("preserves deploy domain errors when failure reporting throws", async () => {
    const reportStructuredFailure = vi.fn(() => {
      throw new Error("self-healing pipeline unavailable");
    });
    const missingDraftError = new FridayDomainError(
      "WORKFLOW_GENERATOR_DRAFT_NOT_FOUND",
      "Generate a workflow draft before preparing deploy actions",
      { httpStatus: 404 },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createFridayUixSurfaceService({
      idGenerator: () => "assistant-error-4",
      selfHealing: {
        reportStructuredFailure,
        listIssueCards: vi.fn(() => []),
      } as never,
      workflowProduct: {
        materializeGeneratedSession: vi.fn(async () => {
          throw missingDraftError;
        }),
      } as never,
    });

    await expect(
      service.executeTemplate({
        templateId: "deploy-workflow",
        userId: "user-1",
        parameters: { sessionId: "missing-session-id", runNow: true },
      }),
    ).rejects.toBe(missingDraftError);

    expect(reportStructuredFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "assistant-template:deploy-workflow",
        message: "Generate a workflow draft before preparing deploy actions",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[friday] assistant failure reporting failed",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
