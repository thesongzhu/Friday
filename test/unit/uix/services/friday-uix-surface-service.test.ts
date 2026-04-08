import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import { createFridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";

describe("createFridayUixSurfaceService", () => {
  function createWizardPersistenceHarness() {
    const persisted = new Map<string, Record<string, unknown>>();
    const db = {
      withWriteTransaction: <T>(callback: (db: Record<string, never>) => T) => callback({}),
      withReadConnection: <T>(callback: (db: Record<string, never>) => T) => callback({}),
    };
    const wizardContextRepo = {
      save: vi.fn((_db: unknown, context: Record<string, unknown>) => {
        persisted.set(String(context.contextId), JSON.parse(JSON.stringify(context)) as Record<string, unknown>);
      }),
      getById: vi.fn((_db: unknown, contextId: string) => {
        const value = persisted.get(contextId);
        return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : null;
      }),
    };
    return { db, wizardContextRepo, persisted };
  }

  function createPreferencePersistenceHarness() {
    const stored = new Map<string, {
      id: string;
      principalId: string;
      category: string;
      key: string;
      value: unknown;
      source: "explicit" | "implicit";
      confidence: number;
      createdAt: string;
      updatedAt: string;
    }>();
    const db = {
      withWriteTransaction: <T>(callback: (db: Record<string, never>) => T) => callback({}),
      withReadConnection: <T>(callback: (db: Record<string, never>) => T) => callback({}),
    };
    const preferenceRepo = {
      listByPrincipal: vi.fn((_db: unknown, input: { principalId: string; category?: string }) =>
        [...stored.values()].filter((item) =>
          item.principalId === input.principalId && (!input.category || item.category === input.category)
        )),
      upsert: vi.fn((_db: unknown, input: {
        id: string;
        principalId: string;
        category: string;
        key: string;
        value: unknown;
        source: "explicit" | "implicit";
        confidence: number;
        nowIso: string;
      }) => {
        const mapKey = `${input.principalId}:${input.category}:${input.key}`;
        const existing = stored.get(mapKey);
        const saved = {
          id: input.id,
          principalId: input.principalId,
          category: input.category,
          key: input.key,
          value: input.value,
          source: input.source,
          confidence: input.confidence,
          createdAt: existing?.createdAt ?? input.nowIso,
          updatedAt: input.nowIso,
        };
        stored.set(mapKey, saved);
        return saved;
      }),
    };
    return { db, preferenceRepo, stored };
  }

  it("writes the latest harness summary into assistant focus for skill generation", async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ key: "ui:assistant:assistant-shell" })),
      getConversationFocus: vi.fn(async () => ({
        currentTopicSummary: "Previous topic",
        updatedAt: "2026-03-07T09:59:00.000Z",
      })),
      setConversationFocus: vi.fn(async () => ({ key: "ui:assistant:assistant-shell" })),
    };
    const service = createFridayUixSurfaceService({
      idGenerator: () => "uix-session-1",
      sessionService: sessionService as never,
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
      skillGenerator: {
        startSession: vi.fn(async () => ({
          session: { sessionId: "skill-session-1" },
          mode: "completed",
          draft: {
            manifest: { id: "generated-skill" },
            validation: { ok: true },
          },
        })),
        getHarnessSummary: vi.fn(async () => ({
          stage: "qa_verdict",
          handoffArtifactId: "handoff-1",
          summary: "Skill draft is ready for review.",
        })),
      } as never,
    });

    await service.executeTemplate({
      templateId: "generate-skill",
      userId: "user-1",
      parameters: { goal: "Build a summary skill" },
      assistantSessionKey: "ui:assistant:assistant-shell",
    });

    expect(sessionService.getOrCreateSession).toHaveBeenCalledWith("ui:assistant:assistant-shell");
    expect(sessionService.setConversationFocus).toHaveBeenCalledWith(
      "ui:assistant:assistant-shell",
      expect.objectContaining({
        currentTopicSummary: "Previous topic",
        lastHarnessStage: "qa_verdict",
        lastHandoffArtifactId: "handoff-1",
        lastHarnessSummary: "Skill draft is ready for review.",
      }),
    );
  });

  it("persists uix user-profile preferences instead of rejecting them", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: (() => {
        let counter = 0;
        return () => `pref-${++counter}`;
      })(),
      nowIso: () => "2026-04-04T02:00:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const result = service.updatePreferences({
      userId: "user-1",
      request: {
        preferences: [
          { category: "uix", key: "user.profile_type", value: "developer" },
          { category: "uix", key: "user.onboarded_at", value: "2026-04-04T02:00:00.000Z" },
        ],
      },
    });

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(service.listPreferences({ userId: "user-1", category: "uix" }).items).toEqual([
      expect.objectContaining({ category: "uix", key: "user.profile_type", value: "developer" }),
      expect.objectContaining({ category: "uix", key: "user.onboarded_at", value: "2026-04-04T02:00:00.000Z" }),
    ]);
  });

  it("persists canonical surface and locale preferences for task-first navigation", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: (() => {
        let counter = 0;
        return () => `pref-nav-${++counter}`;
      })(),
      nowIso: () => "2026-04-08T17:00:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const result = service.updatePreferences({
      userId: "user-1",
      request: {
        preferences: [
          { category: "uix", key: "display.locale", value: "zh" },
          { category: "uix", key: "navigation.lastPrimarySurface", value: "assistant" },
          { category: "uix", key: "home.pinnedPackIds", value: ["industry-creator-media"] },
          { category: "uix", key: "home.packOrder", value: ["industry-creator-media"] },
          { category: "uix", key: "home.widgetOrder", value: ["active_now", "pending_approvals", "recent_results"] },
          { category: "uix", key: "home.visibleWidgets", value: ["active_now", "pending_approvals"] },
        ],
      },
    });

    expect(result.created).toBe(6);
    expect(result.updated).toBe(0);
    expect(service.listPreferences({ userId: "user-1", category: "uix" }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "uix", key: "display.locale", value: "zh" }),
        expect.objectContaining({ category: "uix", key: "navigation.lastPrimarySurface", value: "assistant" }),
        expect.objectContaining({ category: "uix", key: "home.pinnedPackIds", value: ["industry-creator-media"] }),
        expect.objectContaining({ category: "uix", key: "home.packOrder", value: ["industry-creator-media"] }),
        expect.objectContaining({
          category: "uix",
          key: "home.widgetOrder",
          value: ["active_now", "pending_approvals", "recent_results"],
        }),
        expect.objectContaining({ category: "uix", key: "home.visibleWidgets", value: ["active_now", "pending_approvals"] }),
      ]),
    );
  });

  it("rejects unknown widget identifiers in persisted home preferences", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: () => "pref-invalid-1",
      nowIso: () => "2026-04-08T17:00:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    expect(() =>
      service.updatePreferences({
        userId: "user-1",
        request: {
          preferences: [
            { category: "uix", key: "home.widgetOrder", value: ["active_now", "unknown_widget"] },
          ],
        },
      })).toThrowError(FridayDomainError);
  });

  it("writes harness focus for wizard clarification continuations", async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ key: "ui:assistant:assistant-shell" })),
      getConversationFocus: vi.fn(async () => null),
      setConversationFocus: vi.fn(async () => ({ key: "ui:assistant:assistant-shell" })),
    };
    const service = createFridayUixSurfaceService({
      idGenerator: () => "wizard-context-1",
      sessionService: sessionService as never,
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
        submitTurn: vi.fn(async () => ({
          session: { sessionId: "workflow-session-1" },
          mode: "completed",
          workflow: {
            workflowId: "wf-1",
          },
        })),
        getHarnessSummary: vi.fn(async () => ({
          stage: "handoff_ready",
          handoffArtifactId: "handoff-workflow-1",
          summary: "Workflow draft is blocked on browser QA evidence.",
        })),
      } as never,
      workflowProduct: {} as never,
    });

    const started = service.startWizard({
      wizardId: "guided-assistant",
      userId: "user-1",
      assistantSessionKey: "ui:assistant:assistant-shell",
    });

    await service.continueWizard({
      wizardId: "guided-assistant",
      contextId: started.wizard.contextId,
      userId: "user-1",
      values: { goal: "Generate a release workflow" },
    });

    expect(sessionService.setConversationFocus).toHaveBeenCalledWith(
      "ui:assistant:assistant-shell",
      expect.objectContaining({
        lastHarnessStage: "handoff_ready",
        lastHandoffArtifactId: "handoff-workflow-1",
        lastHarnessSummary: "Workflow draft is blocked on browser QA evidence.",
      }),
    );
  });

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

  it("restores a persisted wizard context after restart and continues the flow", async () => {
    const persistence = createWizardPersistenceHarness();
    const workflowGenerator = {
      startSession: vi.fn(async () => ({
        session: { sessionId: "workflow-session-1" },
        mode: "clarification_required",
        questions: ["Which repository should Friday change first?"],
      })),
    };
    const serviceA = createFridayUixSurfaceService({
      db: persistence.db as never,
      wizardContextRepo: persistence.wizardContextRepo as never,
      idGenerator: () => "wizard-context-restore",
      nowIso: (() => {
        const values = [
          "2026-04-01T10:00:00.000Z",
          "2026-04-01T10:05:00.000Z",
        ];
        return () => values.shift() ?? "2026-04-01T10:05:00.000Z";
      })(),
      selfHealing: {
        listIssueCards: vi.fn(() => []),
        reportStructuredFailure: vi.fn(),
      } as never,
      workflowGenerator: workflowGenerator as never,
      workflowProduct: {} as never,
    });

    const started = serviceA.startWizard({
      wizardId: "guided-assistant",
      userId: "user-1",
      assistantSessionKey: "ui:assistant:shell",
      tenantContext: { hubId: "tenant-a", userId: "user-1", channelKind: "assistant" },
    });

    const serviceB = createFridayUixSurfaceService({
      db: persistence.db as never,
      wizardContextRepo: persistence.wizardContextRepo as never,
      idGenerator: () => "wizard-context-unused",
      nowIso: () => "2026-04-01T10:06:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
        reportStructuredFailure: vi.fn(),
      } as never,
      workflowGenerator: workflowGenerator as never,
      workflowProduct: {} as never,
    });

    const response = await serviceB.continueWizard({
      wizardId: "guided-assistant",
      contextId: started.wizard.contextId,
      userId: "user-1",
      values: { goal: "Generate a release workflow" },
    });

    expect(persistence.wizardContextRepo.getById).toHaveBeenCalledWith(expect.any(Object), started.wizard.contextId);
    expect(response.state).toBe("needs_one_answer");
    expect(response.workflow?.sessionId).toBe("workflow-session-1");
    expect(persistence.wizardContextRepo.save).toHaveBeenCalledTimes(2);
    const restored = persistence.persisted.get(started.wizard.contextId);
    expect(restored).toMatchObject({
      principalId: "user-1",
      status: "awaiting_input",
      currentStepId: "clarification",
      assistantSessionKey: "ui:assistant:shell",
      tenantContext: { hubId: "tenant-a", userId: "user-1", channelKind: "assistant" },
      startedAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:06:00.000Z",
    });
  });

  it("rejects continuing a persisted wizard from a different principal", async () => {
    const persistence = createWizardPersistenceHarness();
    const serviceA = createFridayUixSurfaceService({
      db: persistence.db as never,
      wizardContextRepo: persistence.wizardContextRepo as never,
      idGenerator: () => "wizard-context-owner",
      nowIso: () => "2026-04-01T11:00:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
        reportStructuredFailure: vi.fn(),
      } as never,
    });

    const started = serviceA.startWizard({
      wizardId: "guided-assistant",
      userId: "user-1",
    });

    const serviceB = createFridayUixSurfaceService({
      db: persistence.db as never,
      wizardContextRepo: persistence.wizardContextRepo as never,
      idGenerator: () => "wizard-context-attacker",
      nowIso: () => "2026-04-01T11:05:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
        reportStructuredFailure: vi.fn(),
      } as never,
    });

    await expect(
      serviceB.continueWizard({
        wizardId: "guided-assistant",
        contextId: started.wizard.contextId,
        userId: "user-2",
        values: { goal: "Try to hijack the wizard" },
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    } satisfies Partial<FridayDomainError>);
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
