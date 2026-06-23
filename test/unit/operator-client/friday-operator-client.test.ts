import { describe, expect, it, vi } from "vitest";

import { createFridayOperatorClient } from "@friday-operator-client";

describe("createFridayOperatorClient", () => {
  it("adds idempotency keys to write operations and keeps trusted-device platform", async () => {
    const transport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        device: {
          id: "device-1",
          label: "Operator Browser",
          fingerprint: "fp-1",
          platform: "browser",
          trustScope: "trusted_private_network",
          status: "active",
          registeredAt: "2026-03-07T00:00:00.000Z",
        },
      }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({
      transport,
      createIdempotencyKey: () => "idem-123",
    });

    const device = await client.registerRemoteDevice({
      label: "Operator Browser",
      fingerprint: "fp-1",
      platform: "browser",
    });

    expect(transport.post).toHaveBeenCalledWith("/v1/system/remote/devices/register", {
      label: "Operator Browser",
      fingerprint: "fp-1",
      platform: "browser",
      idempotencyKey: "idem-123",
    });
    expect(device.platform).toBe("browser");
  });

  it("builds a remote session query string when filters are supplied", async () => {
    const transport = {
      get: vi.fn().mockResolvedValue({ items: [] }),
      post: vi.fn(),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });
    await client.listRemoteSessions({
      deviceId: "device-1",
      status: "active",
      limit: 5,
    });

    expect(transport.get).toHaveBeenCalledWith(
      "/v1/system/remote/sessions?deviceId=device-1&status=active&limit=5",
    );
  });

  it("posts a governed heartbeat for remote sessions with idempotency", async () => {
    const activeSession = {
      id: "remote-session-1",
      deviceId: "device-1",
      devicePlatform: "browser",
      status: "active",
      connectedAt: "2026-06-22T00:00:00.000Z",
      lastSeenAt: "2026-06-22T00:01:00.000Z",
    };
    const transport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ session: activeSession }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({
      transport,
      createIdempotencyKey: () => "heartbeat-idem",
    });
    const result = await client.heartbeatRemoteSession("remote/session 1");

    expect(transport.post).toHaveBeenCalledWith(
      "/v1/system/remote/sessions/remote%2Fsession%201/heartbeat",
      { idempotencyKey: "heartbeat-idem" },
    );
    expect(result.session).toEqual(activeSession);
  });

  it("passes through missing remote session heartbeat responses", async () => {
    const transport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ session: null }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({
      transport,
      createIdempotencyKey: () => "heartbeat-null-idem",
    });
    const result = await client.heartbeatRemoteSession("missing-session");

    expect(transport.post).toHaveBeenCalledWith(
      "/v1/system/remote/sessions/missing-session/heartbeat",
      { idempotencyKey: "heartbeat-null-idem" },
    );
    expect(result.session).toBeNull();
  });

  it("builds system event listing routes in JSON mode by default", async () => {
    const transport = {
      get: vi.fn().mockResolvedValue({ items: [] }),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });
    await client.listEvents();
    await client.listEvents({ afterSeq: 10, limit: 25 });

    expect(transport.get).toHaveBeenCalledWith("/v1/system/events?stream=false");
    expect(transport.get).toHaveBeenCalledWith("/v1/system/events?stream=false&afterSeq=10&limit=25");
  });

  it("builds diagnosis, auto-fix, and assistant routes with the shared contract", async () => {
    const transport = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ templates: [] })
        .mockResolvedValueOnce({ items: [] }),
      post: vi
        .fn()
        .mockResolvedValueOnce({ summary: "generate a skill", suggestedTemplateIds: ["generate-skill"] })
        .mockResolvedValueOnce({ templateId: "generate-skill", status: "executed", summary: "ok", routeTarget: "/assistant" })
        .mockResolvedValueOnce({ wizard: { wizardId: "guided-assistant", contextId: "ctx-1", title: "Guided Assistant", status: "awaiting_input", currentStepId: "goal", steps: [], collectedValues: {} } })
        .mockResolvedValueOnce({ wizard: { wizardId: "guided-assistant", contextId: "ctx-1", title: "Guided Assistant", status: "ready", currentStepId: "clarification", steps: [], collectedValues: { goal: "Generate a skill" } } })
        .mockResolvedValueOnce({ action: { actionId: "action-1" } }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });

    await client.listDiagnosisIncidents({ status: "open", limit: 3 });
    await client.listAutoFixActions({ status: "planned", incidentId: "incident-1", limit: 4 });
    await client.resolveAssistantIntent("Generate a git summary skill");
    await client.listAssistantTemplates();
    await client.executeAssistantTemplate({
      templateId: "generate-skill",
      parameters: { goal: "Summarize git changes" },
      assistantSessionKey: "ui:assistant:assistant-shell",
    });
    await client.startAssistantWizard("guided-assistant", "ui:assistant:assistant-shell");
    await client.continueAssistantWizard({
      wizardId: "guided-assistant",
      contextId: "ctx-1",
      values: { goal: "Generate a skill" },
      assistantSessionKey: "ui:assistant:assistant-shell",
    });
    await client.approveAutoFixAction("action-1", "Looks safe");
    await client.listAssistantIssues(5);

    expect(transport.get).toHaveBeenCalledWith("/v1/diagnosis/incidents?status=open&limit=3");
    expect(transport.get).toHaveBeenCalledWith(
      "/v1/auto-fix/actions?status=planned&incidentId=incident-1&limit=4",
    );
    expect(transport.post).toHaveBeenCalledWith("/v1/uix/intents/resolve", {
      text: "Generate a git summary skill",
    });
    expect(transport.get).toHaveBeenCalledWith("/v1/uix/templates");
    expect(transport.post).toHaveBeenCalledWith("/v1/uix/templates/generate-skill/execute", {
      parameters: { goal: "Summarize git changes" },
      assistantSessionKey: "ui:assistant:assistant-shell",
    });
    expect(transport.post).toHaveBeenCalledWith("/v1/uix/wizards/guided-assistant/start", {
      assistantSessionKey: "ui:assistant:assistant-shell",
    });
    expect(transport.post).toHaveBeenCalledWith("/v1/uix/wizards/guided-assistant/continue", {
      contextId: "ctx-1",
      values: { goal: "Generate a skill" },
      assistantSessionKey: "ui:assistant:assistant-shell",
    });
    expect(transport.post).toHaveBeenCalledWith("/v1/auto-fix/actions/action-1/approve", {
      reason: "Looks safe",
    });
    expect(transport.get).toHaveBeenCalledWith("/v1/uix/issues?limit=5");
  });

  it("builds agent-loop routes with the shared contract", async () => {
    const transport = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          policy: {
            id: "default",
            mode: "tiered_supervised",
            paused: false,
            autoApplyLowRisk: true,
            maxAttemptsPerFingerprint: 3,
            cooldownMinutes: 30,
            requireRollbackPlan: true,
            requireAcceptanceCheck: true,
            updatedAt: "2026-03-07T00:00:00.000Z",
          },
        })
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          run: {
            run: {
              loopRunId: "loop-run-1",
              userId: "user-1",
              incidentId: "incident-1",
              fingerprint: "fp-1",
              trigger: "incident_opened",
              status: "awaiting_approval",
              riskTier: 2,
              approvalRequired: true,
              attemptNumber: 1,
              rollbackAttempted: false,
              rollbackSucceeded: false,
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
            },
            incident: null,
            action: null,
          },
        }),
      post: vi
        .fn()
        .mockResolvedValueOnce({ run: { run: { loopRunId: "loop-run-1" }, incident: null, action: null } })
        .mockResolvedValueOnce({ run: { run: { loopRunId: "loop-run-1" }, incident: null, action: null } }),
      patch: vi.fn(),
      put: vi.fn().mockResolvedValueOnce({
        policy: {
          id: "default",
          mode: "tiered_supervised",
          paused: true,
          autoApplyLowRisk: true,
          maxAttemptsPerFingerprint: 3,
          cooldownMinutes: 30,
          requireRollbackPlan: true,
          requireAcceptanceCheck: true,
          updatedAt: "2026-03-07T00:00:00.000Z",
        },
      }),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });

    await client.getAgentLoopPolicy();
    await client.updateAgentLoopPolicy({ paused: true });
    await client.listAgentLoopRuns({ status: "awaiting_approval", limit: 5 });
    await client.pauseAgentLoopRun("loop-run-1");
    await client.resumeAgentLoopRun("loop-run-1");

    expect(transport.get).toHaveBeenCalledWith("/v1/agent-loop/policy");
    expect(transport.put).toHaveBeenCalledWith("/v1/agent-loop/policy", { paused: true });
    expect(transport.get).toHaveBeenCalledWith("/v1/agent-loop/runs?status=awaiting_approval&limit=5");
    expect(transport.post).toHaveBeenCalledWith("/v1/agent-loop/runs/loop-run-1/pause", {});
    expect(transport.post).toHaveBeenCalledWith("/v1/agent-loop/runs/loop-run-1/resume", {});
  });

  it("builds agent-loop expert mode updates against the PUT route", async () => {
    const transport = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn().mockResolvedValue({
        expertMode: {
          enabled: false,
          allowedUserIds: [],
          allowedWorkspaceIds: [],
          allowedEnvironments: [],
          contextInferenceAllowed: false,
          multiStepHypothesisSearchAllowed: false,
          safeProbeExecutionAllowed: false,
          crossSurfaceOrchestrationAllowed: false,
          highRiskFinalApprovalRequired: true,
          productionDestructiveActionApprovalRequired: true,
          probeBudget: { maxProbesPerRun: 0, maxRuntimeMs: 0 },
          timeBudgetMinutes: 0,
          updatedAt: "2026-03-07T00:00:00.000Z",
        },
      }),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });
    await client.updateAgentLoopExpertMode({ enabled: false });

    expect(transport.put).toHaveBeenCalledWith("/v1/agent-loop/expert-mode", { enabled: false });
    expect(transport.patch).not.toHaveBeenCalled();
  });

  it("builds observability routes with the shared contract", async () => {
    const transport = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          overview: {
            traces: { totalTraces: 1, errorTraces: 0, okTraces: 1, avgDurationMs: 12, activeTraces: 0 },
            audit: { totalEntries: 2, byCategory: {}, byOutcome: {}, byModule: {} },
            alerts: { activeAlerts: 0, bySeverity: {}, byStatus: {}, highestSeverity: null, totalRules: 1 },
            health: null,
            generatedAt: "2026-03-07T00:00:00.000Z",
          },
        })
        .mockResolvedValueOnce({
          series: {
            metricName: "friday.learning.failures.total",
            points: [],
            bucketSize: "5m",
            startTime: "2026-03-07T00:00:00.000Z",
            endTime: "2026-03-07T01:00:00.000Z",
          },
        })
        .mockResolvedValueOnce({ items: [], nextCursor: undefined })
        .mockResolvedValueOnce({ items: [], nextCursor: undefined })
        .mockResolvedValueOnce({ items: [], nextCursor: undefined }),
      post: vi.fn().mockResolvedValueOnce({
        alert: {
          id: "alert-1",
          ruleId: "rule-1",
          ruleName: "API availability",
          severity: "critical",
          status: "acknowledged",
          summary: "API availability dropped below threshold",
          module: "api",
          detectedAt: "2026-03-07T00:00:00.000Z",
          acknowledgedAt: "2026-03-07T00:10:00.000Z",
          notifiedChannelCount: 1,
          currentEscalationTier: 1,
        },
      }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });

    await client.getObservabilityOverview();
    await client.getObservabilityTimeSeries({
      metricName: "friday.learning.failures.total",
      startTime: "2026-03-07T00:00:00.000Z",
      endTime: "2026-03-07T01:00:00.000Z",
      bucketSize: "5m",
    });
    await client.searchObservabilityTraces({ module: "learning", status: "error", limit: 5 });
    await client.searchObservabilityAudit({ module: "uix", outcome: "failure", limit: 3 });
    await client.listObservabilityAlerts({ module: "learning", severity: "critical", status: "firing", limit: 4 });
    await client.acknowledgeObservabilityAlert("alert-1", "Assistant-first triage");

    expect(transport.get).toHaveBeenCalledWith("/v1/observability/overview");
    expect(transport.get).toHaveBeenCalledWith(
      "/v1/observability/time-series?metricName=friday.learning.failures.total&startTime=2026-03-07T00%3A00%3A00.000Z&endTime=2026-03-07T01%3A00%3A00.000Z&bucketSize=5m",
    );
    expect(transport.get).toHaveBeenCalledWith("/v1/observability/traces?module=learning&status=error&limit=5");
    expect(transport.get).toHaveBeenCalledWith("/v1/observability/audit?module=uix&outcome=failure&limit=3");
    expect(transport.get).toHaveBeenCalledWith(
      "/v1/observability/alerts?module=learning&severity=critical&status=firing&limit=4",
    );
    expect(transport.post).toHaveBeenCalledWith("/v1/observability/alerts/alert-1/acknowledge", {
      note: "Assistant-first triage",
    });
  });

  it("builds workflow overview, visualization, and deploy routes with the shared contract", async () => {
    const transport = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ overview: { workflow: { id: "wf-1" }, drafts: [], recentRuns: [], latestRunNodeTimeline: [], latestEvidenceExports: [], versionHistory: [] } })
        .mockResolvedValueOnce({ visualization: { workflow: { id: "wf-1" }, targetKind: "draft", spec: { workflowId: "wf-1", name: "Workflow", steps: [], edges: [] }, visual: { workflowId: "wf-1", viewport: { x: 0, y: 0, zoom: 1 }, panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false }, nodes: [], edges: [] }, recentRuns: [], nodeTimeline: [], latestEvidenceExports: [] } }),
      post: vi.fn().mockResolvedValueOnce({
        deployment: {
          workflowId: "wf-1",
          draftId: "draft-1",
          workflowVersionId: "version-2",
          versionNumber: 2,
          published: true,
          triggerSync: { requested: true, synced: true },
          validation: { valid: true, issues: [], generatedAt: "2026-03-07T00:00:00.000Z" },
          evidence: { traceSummary: "observed" },
        },
      }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });

    await client.getWorkflowOverview("wf-1", { recentRunLimit: 6 });
    await client.getWorkflowVisualization("wf-1", { draftId: "draft-1", timelineLimit: 12 });
    await client.deployWorkflowDraft("wf-1", "draft-1", {
      runNow: true,
      includeExport: true,
      resyncTriggers: true,
    });

    expect(transport.get).toHaveBeenCalledWith("/v1/workflows/wf-1/overview?recentRunLimit=6");
    expect(transport.get).toHaveBeenCalledWith("/v1/workflows/wf-1/visualization?draftId=draft-1&timelineLimit=12");
    expect(transport.post).toHaveBeenCalledWith("/v1/workflows/wf-1/drafts/draft-1/deploy", {
      runNow: true,
      includeExport: true,
      resyncTriggers: true,
    });
  });

  it("builds communication persona preference routes with the shared contract", async () => {
    const transport = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          persona: {
            category: "communication",
            mbti: "INFJ",
            settings: {
              tone: "warm",
              verbosity: "balanced",
              structure: "structured",
              questionStyle: "guided",
              directness: "balanced",
              emojiStyle: "light",
              jargonTolerance: "medium",
              assumptionStyle: "balanced",
              confirmationStyle: "explicit",
            },
            inheritedFrom: {
              mbti: "explicit",
              settings: {
                tone: "template",
                verbosity: "template",
                structure: "template",
                questionStyle: "template",
                directness: "template",
                emojiStyle: "template",
                jargonTolerance: "template",
                assumptionStyle: "template",
                confirmationStyle: "template",
              },
            },
            preview: {
              styleLabel: "warm/balanced/structured",
              sampleClarifier: "I can help with that. Which outcome matters most here?",
              sampleBoundary: "This is a high-risk step. I need your approval before I continue.",
            },
          },
        }),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn().mockResolvedValue({ preferences: [] }),
      del: vi.fn().mockResolvedValue({ deleted: true }),
    };

    const client = createFridayOperatorClient({ transport });

    await client.listCommunicationPreferences();
    await client.updateCommunicationPreferences([
      { category: "communication", key: "persona.tone", value: "warm" },
    ]);
    await client.deleteCommunicationPreference("pref-1");
    const persona = await client.getCommunicationPersona();

    expect(transport.get).toHaveBeenCalledWith("/v1/uix/preferences?category=communication");
    expect(transport.put).toHaveBeenCalledWith("/v1/uix/preferences", {
      preferences: [{ category: "communication", key: "persona.tone", value: "warm" }],
    });
    expect(transport.del).toHaveBeenCalledWith("/v1/uix/preferences/pref-1");
    expect(transport.get).toHaveBeenCalledWith("/v1/uix/persona");
    expect(persona.mbti).toBe("INFJ");
  });

  it("builds shipped UIX snapshot, diagnostics, profile, and investigation routes", async () => {
    const transport = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ snapshot: { generatedAt: "2026-03-07T00:00:00.000Z", runs: [], pendingApprovals: [], scheduledAutomations: [] } })
        .mockResolvedValueOnce({ snapshot: { generatedAt: "2026-03-07T00:00:00.000Z", approvals: [], alerts: [], recentRuns: [] } })
        .mockResolvedValueOnce({ assistant: { generatedAt: "2026-03-07T00:00:00.000Z", taskProfilePresets: [], recentRuns: [], mcpServerStates: [], supportedPreprocessors: [] } })
        .mockResolvedValueOnce({ profileType: "beginner", onboardedAt: null }),
      post: vi.fn().mockResolvedValue({ runId: "ctx-1", wizardId: "guided-assistant" }),
      patch: vi.fn(),
      put: vi.fn().mockResolvedValue({ profileType: "developer", onboardedAt: "2026-03-07T00:00:00.000Z" }),
      del: vi.fn(),
    };

    const client = createFridayOperatorClient({ transport });

    await client.getUixHomeSnapshot();
    await client.getUixAssistantInboxSnapshot();
    await client.getUixDiagnostics();
    await client.getUserProfile();
    await client.updateUserProfile({ profileType: "developer", onboardedAt: "2026-03-07T00:00:00.000Z" });
    await client.investigateUix({ goalCategoryId: "guided-assistant", assistantSessionKey: "ui:assistant" });

    expect(transport.get).toHaveBeenCalledWith("/v1/uix/home-snapshot");
    expect(transport.get).toHaveBeenCalledWith("/v1/uix/assistant-inbox-snapshot");
    expect(transport.get).toHaveBeenCalledWith("/v1/uix/diagnostics");
    expect(transport.get).toHaveBeenCalledWith("/v1/uix/user-profile");
    expect(transport.put).toHaveBeenCalledWith("/v1/uix/user-profile", {
      profileType: "developer",
      onboardedAt: "2026-03-07T00:00:00.000Z",
    });
    expect(transport.post).toHaveBeenCalledWith("/v1/uix/investigate", {
      goalCategoryId: "guided-assistant",
      assistantSessionKey: "ui:assistant",
    });
  });

  it("sends acceptance test delete etags in the DELETE body", async () => {
    const transport = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      del: vi.fn().mockResolvedValue({ deleted: true, testId: "test-1" }),
    };

    const client = createFridayOperatorClient({ transport });
    await client.deleteAcceptanceTest("test-1", "etag-1");

    expect(transport.del).toHaveBeenCalledWith("/v1/acceptance/tests/test-1", {
      body: JSON.stringify({ etag: "etag-1" }),
      headers: { "Content-Type": "application/json" },
    });
  });
});
