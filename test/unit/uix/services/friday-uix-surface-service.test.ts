import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import {
  createFridayUixSurfaceService,
  getFridayUixPreferenceKeys,
} from "../../../../src/uix/services/friday-uix-surface-service.js";
import { getFridayCommunicationPreferenceKeys } from "../../../../src/uix/services/friday-communication-persona.js";
import {
  getFridayReflexConfirmationRequiredPreferenceKeys,
  getFridayReflexPreferenceKeys,
} from "../../../../src/reflex/index.js";

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

  it("blocks high-impact reflex preference writes through the generic UIX API", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: () => "pref-reflex-1",
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
            { category: "reflex", key: "testing.live_llm_policy", value: "allowed_with_cost_notice" },
          ],
        },
      })).toThrowError(FridayDomainError);
    expect(persistence.preferenceRepo.upsert).not.toHaveBeenCalled();
  });

  it("still allows ordinary reflex preferences through the generic UIX API", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: () => "pref-reflex-ordinary",
      nowIso: () => "2026-04-08T17:00:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const result = service.updatePreferences({
      userId: "user-1",
      request: {
        preferences: [
          { category: "reflex", key: "communication.language_policy", value: "zh" },
        ],
      },
    });

    expect(result.created).toBe(1);
    expect(service.listPreferences({ userId: "user-1", category: "reflex" }).items).toEqual([
      expect.objectContaining({ category: "reflex", key: "communication.language_policy", value: "zh" }),
    ]);
  });

  it("covers every current preference key with explicit generic UIX write semantics", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: (() => {
        let counter = 0;
        return () => `pref-all-${++counter}`;
      })(),
      nowIso: () => "2026-06-01T03:10:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    const communicationSamples = new Map<string, unknown>([
      ["persona.mbti", "INTJ"],
      ["persona.tone", "warm"],
      ["persona.verbosity", "concise"],
      ["persona.structure", "structured"],
      ["persona.question_style", "guided"],
      ["persona.directness", "direct"],
      ["persona.emoji_style", "light"],
      ["persona.jargon_tolerance", "high"],
      ["persona.assumption_style", "ask_first"],
      ["persona.confirmation_style", "explicit"],
    ]);
    const uixSamples = new Map<string, unknown>([
      ["user.profile_type", "developer"],
      ["user.onboarded_at", "2026-06-01T03:10:00.000Z"],
      ["display.locale", "en"],
      ["navigation.lastPrimarySurface", "assistant"],
      ["home.pinnedPackIds", ["industry-creator-media"]],
      ["home.packOrder", ["industry-creator-media"]],
      ["home.widgetOrder", ["active_now", "pending_approvals"]],
      ["home.visibleWidgets", ["active_now", "recent_results"]],
      ["packs.customInputs", [{
        name: "Release review",
        description: "Review release evidence.",
        skillIds: ["review"],
        entryPrompts: ["Review this release."],
      }]],
    ]);
    const reflexSamples = new Map<string, unknown>(
      getFridayReflexPreferenceKeys().map((key) => [key, `${key}.sample`]),
    );
    const confirmationRequired = new Set(getFridayReflexConfirmationRequiredPreferenceKeys());
    const ordinaryReflex = [...reflexSamples.entries()]
      .filter(([key]) => !confirmationRequired.has(key));
    const highImpactReflex = [...reflexSamples.entries()]
      .filter(([key]) => confirmationRequired.has(key));

    expect([...communicationSamples.keys()].sort()).toEqual([...getFridayCommunicationPreferenceKeys()].sort());
    expect([...uixSamples.keys()].sort()).toEqual([...getFridayUixPreferenceKeys()].sort());
    expect(ordinaryReflex.length).toBeGreaterThan(0);
    expect(highImpactReflex.length).toBeGreaterThan(0);
    expect(ordinaryReflex.length + highImpactReflex.length).toBe(getFridayReflexPreferenceKeys().length);

    const acceptedPreferences = [
      ...[...communicationSamples.entries()].map(([key, value]) => ({ category: "communication" as const, key, value })),
      ...[...uixSamples.entries()].map(([key, value]) => ({ category: "uix" as const, key, value })),
      ...ordinaryReflex.map(([key, value]) => ({ category: "reflex" as const, key, value })),
    ];

    const result = service.updatePreferences({
      userId: "user-1",
      request: { preferences: acceptedPreferences },
    });

    expect(result.created).toBe(acceptedPreferences.length);
    expect(service.listPreferences({ userId: "user-1" }).items).toHaveLength(acceptedPreferences.length);
    for (const preference of acceptedPreferences) {
      expect(service.listPreferences({ userId: "user-1", category: preference.category }).items)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            category: preference.category,
            key: preference.key,
            value: preference.value,
          }),
        ]));
    }

    for (const [key, value] of highImpactReflex) {
      expect(() =>
        service.updatePreferences({
          userId: "user-1",
          request: {
            preferences: [{ category: "reflex", key, value }],
          },
        })).toThrowError(FridayDomainError);
      expect(service.listPreferences({ userId: "user-1", category: "reflex" }).items
        .some((preference) => preference.key === key)).toBe(false);
    }
  });

  it("rejects invalid canonical MBTI preferences instead of persisting silent fallback", () => {
    const persistence = createPreferencePersistenceHarness();
    const service = createFridayUixSurfaceService({
      db: persistence.db as never,
      preferenceRepo: persistence.preferenceRepo as never,
      idGenerator: () => "pref-invalid-mbti",
      nowIso: () => "2026-06-01T03:10:00.000Z",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
      } as never,
    });

    expect(() =>
      service.updatePreferences({
        userId: "user-1",
        request: {
          preferences: [{ category: "communication", key: "persona.mbti", value: "XXXX" }],
        },
      })).toThrowError(FridayDomainError);
    expect(persistence.preferenceRepo.upsert).not.toHaveBeenCalled();
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

  it("accepts the legacy cross-border-hero wizard id as a live alias", () => {
    const service = createFridayUixSurfaceService({
      idGenerator: () => "wizard-cross-border-hero",
      selfHealing: {
        listIssueCards: vi.fn(() => []),
        reportStructuredFailure: vi.fn(),
      } as never,
    });

    const started = service.startWizard({
      wizardId: "cross-border-hero",
      userId: "user-1",
      assistantSessionKey: "guided:default:user-1-cross-border-hero",
    });

    expect(started.wizard.wizardId).toBe("cross-border-hero");
    expect(started.wizard.title).toBe("Cross-border Hero");
    expect(started.wizard.currentStepId).toBe("goal");
    expect(started.wizard.steps[0]).toMatchObject({
      id: "goal",
      inputKey: "goal",
    });
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

  it("propagates the workflow-deploy retirement 503 from materializeGeneratedSession (generate-workflow caller path, no crash)", async () => {
    // The method-level guard (TS-R1) makes materializeGeneratedSession fail
    // closed in default/live runtime. The UIX generate-workflow action reaches
    // it directly (with a caller-supplied sessionId), bypassing the HTTP route
    // guard — this proves the UIX layer surfaces the 503 rather than crashing,
    // and (since materialize is a no-op when fail-closed and UIX writes nothing
    // before the call) leaves no poisoned state.
    const retirementError = new FridayDomainError(
      "TS_RUNTIME_WORKFLOW_DEPLOY_RETIRED",
      "TypeScript workflow deploy execution is retired in default/live runtime; use the Rust-owned workflow deployment entrypoint.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_workflow_deployment_entrypoint_required",
        },
      },
    );
    const materializeGeneratedSession = vi.fn(async () => {
      throw retirementError;
    });
    const service = createFridayUixSurfaceService({
      idGenerator: () => "assistant-retire-1",
      selfHealing: {
        reportStructuredFailure: vi.fn(),
        listIssueCards: vi.fn(() => []),
      } as never,
      workflowProduct: { materializeGeneratedSession } as never,
    });

    await expect(
      service.executeTemplate({
        templateId: "generate-workflow",
        userId: "user-1",
        parameters: { sessionId: "pre-deploy-persisted-session" },
      }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_DEPLOY_RETIRED",
      httpStatus: 503,
    } satisfies Partial<FridayDomainError>);

    expect(materializeGeneratedSession).toHaveBeenCalledWith({
      sessionId: "pre-deploy-persisted-session",
      actorUserId: "user-1",
    });
  });

  it("propagates the workflow-generator retirement 503 from submitTurn (continueWizard caller path, no crash)", async () => {
    // The continueWizard clarification step reaches continueWorkflowSession ->
    // workflowGenerator.submitTurn, which is now method-guarded. Proves the UIX
    // wizard surface propagates the 503 instead of crashing, and never reaches
    // the downstream materialize since submitTurn fail-closes first.
    const retirementError = new FridayDomainError(
      "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
      "TypeScript workflow generator sessions are retired in default/live runtime; use the Rust-owned workflow generator entrypoint.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_workflow_generator_entrypoint_required",
        },
      },
    );
    const submitTurn = vi.fn(async () => {
      throw retirementError;
    });
    const materializeGeneratedSession = vi.fn();
    const service = createFridayUixSurfaceService({
      idGenerator: () => "assistant-retire-2",
      selfHealing: {
        reportStructuredFailure: vi.fn(),
        listIssueCards: vi.fn(() => []),
      } as never,
      workflowGenerator: {
        startSession: vi.fn(async () => ({
          session: { sessionId: "workflow-session-1" },
          mode: "clarification_required",
          questions: ["Which repository should Friday change first?"],
        })),
        submitTurn,
      } as never,
      workflowProduct: { materializeGeneratedSession } as never,
    });

    const started = service.startWizard({
      wizardId: "guided-assistant",
      userId: "user-1",
    });

    await expect(
      service.continueWizard({
        wizardId: "guided-assistant",
        contextId: started.wizard.contextId,
        userId: "user-1",
        values: { goal: "Generate a release workflow" },
      }),
    ).resolves.toBeDefined();

    // Advance to the clarification step, which drives submitTurn (fail-closed).
    await expect(
      service.continueWizard({
        wizardId: "guided-assistant",
        contextId: started.wizard.contextId,
        userId: "user-1",
        values: { answer: "the release repo" },
      }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
      httpStatus: 503,
    } satisfies Partial<FridayDomainError>);

    expect(submitTurn).toHaveBeenCalled();
    // submitTurn fail-closed BEFORE the downstream materialize.
    expect(materializeGeneratedSession).not.toHaveBeenCalled();
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

  it("falls back to the local issue queue when review-issues starter skill is safety-gated", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-disabled-1",
      result: Promise.resolve({
        runId: "skill-run-disabled-1",
        status: "failed",
        output: {
          code: "CAPABILITY_DISABLED",
          capability: "skill_node_runtime",
          gate: "FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS",
        },
        stdout: "",
        stderr: "Node-based skills are disabled because they execute in-process without isolation. Set FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS=true only in controlled environments.",
        durationMs: 0,
      }),
    }));
    const issues = [{
      id: "issue-1",
      kind: "approval_required",
      incidentId: "incident-1",
      actionId: "action-1",
      approvalRequestId: "approval-1",
      title: "Workflow deploy needs approval",
      summary: "A rollback-backed fix is waiting on approval.",
      severity: "high",
      status: "open",
      createdAt: "2026-04-21T12:00:00.000Z",
      routeTarget: "/assistant",
    }] as const;
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => issues),
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

    expect(execute).toHaveBeenCalledOnce();
    expect(response.summary).toContain("Friday found 1 issue(s) to review.");
    expect(response.result).toMatchObject({
      count: 1,
      issues,
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

  it("falls back to issue-card recovery guidance when recover-failed-deploy starter skill is safety-gated", async () => {
    const execute = vi.fn(() => ({
      runId: "skill-run-disabled-2",
      result: Promise.resolve({
        runId: "skill-run-disabled-2",
        status: "failed",
        output: {
          code: "CAPABILITY_DISABLED",
          capability: "skill_node_runtime",
          gate: "FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS",
        },
        stdout: "",
        stderr: "Node-based skills are disabled because they execute in-process without isolation. Set FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS=true only in controlled environments.",
        durationMs: 0,
      }),
    }));
    const issues = [{
      id: "issue-2",
      kind: "incident",
      incidentId: "incident-2",
      title: "Workflow deploy failed in production",
      summary: "Deploy step is blocked after a publish failure.",
      severity: "critical",
      status: "open",
      createdAt: "2026-04-21T12:05:00.000Z",
      routeTarget: "/assistant",
    }] as const;
    const service = createFridayUixSurfaceService({
      selfHealing: {
        listIssueCards: vi.fn(() => issues),
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

    expect(execute).toHaveBeenCalledOnce();
    expect(response.summary).toContain("deploy-related issue card");
    expect(response.workflow?.kind).toBe("blocked");
    expect(response.result).toMatchObject({
      issue: issues[0],
      count: 1,
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

  // ─── TS Runtime Retirement — GAP G2: DEFAULT-OFF flag guard ───
  // These two tests pin the INVERTED-polarity lever for the UIX starter-skill
  // execution lane (executeStarterSkillTemplate). Default-off = no behavior
  // change today (starter skills execute, zero degradation); flag-on = the lane
  // fails closed with a 503 TS_RUNTIME_SKILL_RUNS_RETIRED BEFORE skillExecutor
  // runs. This is the lever to flip ON only when skill exec is Rust-owned (R11).
  describe("GAP G2 UIX skill-exec retirement guard (DEFAULT-OFF)", () => {
    it("default (enforceUixSkillExecRetirement unset): starter-skill template executes exactly as before", async () => {
      const execute = vi.fn(() => ({
        runId: "skill-run-g2-default",
        result: Promise.resolve({
          runId: "skill-run-g2-default",
          status: "completed",
          output: {
            summary: "Friday has 0 open issue card(s).",
            nextStep: "Nothing to review.",
            details: {},
          },
          stdout: "",
          stderr: "",
          durationMs: 7,
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
        // enforceUixSkillExecRetirement intentionally omitted → default OFF.
      });

      const response = await service.executeTemplate({
        templateId: "review-issues",
        userId: "user-1",
        parameters: {},
      });

      // Guard is INERT by default: the starter skill runs, current behavior preserved.
      expect(execute).toHaveBeenCalledOnce();
      expect(response.status).toBe("executed");
      expect(response.summary).toContain("open issue");
    });

    it("explicit false: behaves identically to default (no throw, skill executes)", async () => {
      const execute = vi.fn(() => ({
        runId: "skill-run-g2-false",
        result: Promise.resolve({
          runId: "skill-run-g2-false",
          status: "completed",
          output: { summary: "Friday has 0 open issue card(s).", details: {} },
          stdout: "",
          stderr: "",
          durationMs: 7,
        }),
      }));
      const service = createFridayUixSurfaceService({
        selfHealing: { listIssueCards: vi.fn(() => []) } as never,
        skillExecutor: { execute, cancel: vi.fn() },
        enforceUixSkillExecRetirement: false,
      });

      const response = await service.executeTemplate({
        templateId: "review-issues",
        userId: "user-1",
        parameters: {},
      });

      expect(execute).toHaveBeenCalledOnce();
      expect(response.status).toBe("executed");
    });

    it("flag ON (enforceUixSkillExecRetirement=true): lane fails closed 503 TS_RUNTIME_SKILL_RUNS_RETIRED before skillExecutor runs", async () => {
      const execute = vi.fn(() => {
        throw new Error("skillExecutor.execute must NOT be reached when the retirement guard is on");
      });
      const service = createFridayUixSurfaceService({
        selfHealing: { listIssueCards: vi.fn(() => []) } as never,
        skillExecutor: {
          execute,
          cancel: vi.fn(),
        },
        enforceUixSkillExecRetirement: true,
      });

      let caught: unknown;
      try {
        await service.executeTemplate({
          templateId: "review-issues",
          userId: "user-1",
          parameters: {},
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(FridayDomainError);
      const domainError = caught as FridayDomainError;
      expect(domainError.code).toBe("TS_RUNTIME_SKILL_RUNS_RETIRED");
      expect(domainError.httpStatus).toBe(503);
      expect(domainError.details).toMatchObject({
        classification: "fail_closed",
        replacement: "rust_owned_skill_run_entrypoint_required",
      });
      // Zero side effects: the executor was never invoked.
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
