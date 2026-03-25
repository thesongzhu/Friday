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
    expect(reportStructuredFailure.mock.calls[0]?.[0]).not.toHaveProperty("runId");
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
    expect(reportStructuredFailure.mock.calls[0]?.[0]).not.toHaveProperty("runId");
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
    expect(reportStructuredFailure.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(warnSpy).toHaveBeenCalledWith(
      "[friday] assistant failure reporting failed",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("routes review-issues through the bundled starter skill when a skill executor is available", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-1",
      result: Promise.resolve({
        runId: "skill-run-1",
        status: "completed",
        output: {
          summary: "Friday has 2 open issue card(s).",
          nextStep: "Review the approval-gated repair first.",
          details: {
            recommendedTemplateId: "review-issues",
            recommendedSkillId: "autofix-readiness-review",
          },
        },
        stdout: "",
        stderr: "",
        durationMs: 12,
      }),
    }));
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      },
    });

    const response = await service.executeTemplate({
      templateId: "review-issues",
      userId: "user-1",
      parameters: {},
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "review-open-issues",
        userId: "user-1",
        channel: "assistant",
      }),
    );
    expect(response.summary).toContain("open issue");
    expect(response.result).toMatchObject({
      skillId: "review-open-issues",
      nextStep: "Review the approval-gated repair first.",
    });
  });

  it("routes recover-failed-deploy through the bundled recovery skill when a skill executor is available", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-2",
      result: Promise.resolve({
        runId: "skill-run-2",
        status: "completed",
        output: {
          summary: "Failed deploy recovery: root cause points to a workflow publish error.",
          nextStep: "Review the rollback-backed fix before executing anything.",
          details: {
            action: {
              requiresApproval: true,
            },
            recommendedTemplateId: "recover-failed-deploy",
            recommendedSkillId: "autofix-readiness-review",
          },
        },
        stdout: "",
        stderr: "",
        durationMs: 14,
      }),
    }));
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      },
    });

    const response = await service.executeTemplate({
      templateId: "recover-failed-deploy",
      userId: "user-1",
      parameters: {},
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "failed-deploy-recovery-brief",
        userId: "user-1",
        channel: "assistant",
      }),
    );
    expect(response.summary).toContain("Failed deploy recovery");
    expect(response.workflow?.kind).toBe("blocked");
    expect(response.result).toMatchObject({
      skillId: "failed-deploy-recovery-brief",
      requiresApproval: true,
    });
  });

  it("routes idea clarification requests to the new starter templates", () => {
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const resolution = service.resolveIntent({
      text: "Help me clarify this idea before I start building it",
      userId: "user-1",
    });

    expect(resolution.intent).toBe("general_help");
    expect(resolution.suggestedTemplateIds).toEqual([
      "idea-clarifier",
      "implementation-plan-review",
    ]);
  });

  it("routes idea-clarifier through the bundled starter skill when a skill executor is available", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-3",
      result: Promise.resolve({
        runId: "skill-run-3",
        status: "completed",
        output: {
          summary: "Idea clarification: this looks like a workflow request with 2 major clarification gap(s).",
          nextStep: "Answer the first question next: Who is the narrowest first user or operator for this change?",
          details: {
            suggestedSkillId: "implementation-plan-review",
          },
        },
        stdout: "",
        stderr: "",
        durationMs: 10,
      }),
    }));
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      },
    });

    const response = await service.executeTemplate({
      templateId: "idea-clarifier",
      userId: "user-1",
      parameters: {
        goal: "Clarify this idea before I build it",
      },
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "idea-clarifier",
        input: {
          goal: "Clarify this idea before I build it",
        },
      }),
    );
    expect(response.summary).toContain("Idea clarification");
    expect(response.result).toMatchObject({
      skillId: "idea-clarifier",
    });
  });

  it("routes release-doc-sync through the bundled starter skill with apply=true", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-4",
      result: Promise.resolve({
        runId: "skill-run-4",
        status: "completed",
        output: {
          summary: "Release doc sync: updated 3 documentation file(s).",
          nextStep: "Review the generated doc diff, then run your normal release or landing checks.",
          details: {
            updatedFiles: ["README.md", "CHANGELOG.md", "docs/reference/ARCHITECTURE.md"],
          },
        },
        stdout: "",
        stderr: "",
        durationMs: 11,
      }),
    }));
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      },
    });

    const response = await service.executeTemplate({
      templateId: "release-doc-sync",
      userId: "user-1",
      parameters: {
        goal: "Sync the release docs for the assistant starter changes.",
      },
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "release-doc-sync",
        input: {
          goal: "Sync the release docs for the assistant starter changes.",
          apply: true,
        },
      }),
    );
    expect(response.summary).toContain("updated 3 documentation file");
  });

  it("routes benchmark requests to the new wave-2 starter templates", () => {
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const resolution = service.resolveIntent({
      text: "Benchmark this page before I ship it",
      userId: "user-1",
    });

    expect(resolution.intent).toBe("general_help");
    expect(resolution.suggestedTemplateIds).toEqual([
      "page-benchmark-report",
      "release-canary-check",
    ]);
  });

  it("routes security-review requests to the new wave-3 starter templates", () => {
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const resolution = service.resolveIntent({
      text: "Run a security review on auth and token safety",
      userId: "user-1",
    });

    expect(resolution.intent).toBe("general_help");
    expect(resolution.suggestedTemplateIds).toEqual([
      "security-review",
      "workspace-diff-review",
    ]);
  });

  it("routes release-canary-check through the bundled starter skill when a skill executor is available", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-5",
      result: Promise.resolve({
        runId: "skill-run-5",
        status: "completed",
        output: {
          summary: "Release canary check: 1 page passed without blocking canary issues.",
          nextStep: "Keep this canary report as the current local reference.",
          details: {
            pages: [],
          },
        },
        stdout: "",
        stderr: "",
        durationMs: 11,
      }),
    }));
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      },
    });

    const response = await service.executeTemplate({
      templateId: "release-canary-check",
      userId: "user-1",
      parameters: {
        goal: "Run a canary check on the assistant route.",
      },
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "release-canary-check",
        input: {
          goal: "Run a canary check on the assistant route.",
        },
      }),
    );
    expect(response.summary).toContain("Release canary check");
  });

  it("routes browser-qa-fix through the bundled starter skill with apply=true", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-6",
      result: Promise.resolve({
        runId: "skill-run-6",
        status: "completed",
        output: {
          summary: "Browser QA fix: updated ui/index.html with a bounded title fix.",
          nextStep: "Review the HTML diff and rerun browser QA.",
          details: {
            targetFile: "/repo/ui/index.html",
          },
        },
        stdout: "",
        stderr: "",
        durationMs: 11,
      }),
    }));
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      },
    });

    const response = await service.executeTemplate({
      templateId: "browser-qa-fix",
      userId: "user-1",
      parameters: {
        goal: "Fix the page title on the settings route.",
        targetFile: "ui/index.html",
      },
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "browser-qa-fix",
        input: {
          goal: "Fix the page title on the settings route.",
          targetFile: "ui/index.html",
          apply: true,
        },
      }),
    );
    expect(response.summary).toContain("bounded title fix");
  });
});
