import { describe, expect, it } from "vitest";
import type {
  FridayAcceptanceRunSummary,
  FridayAgentLoopRunRecord,
  FridayIssueCard,
  FridayObservabilityAlertSummary,
  FridayObservabilityOverview,
  FridayRetryCircuitBreakerSummary,
  FridayRetryEscalationSummary,
} from "@friday-operator-client";
import {
  buildObservabilityActionQueue,
  buildObservabilityHref,
  formatObservabilityFocusLabel,
} from "../../../ui/src/lib/observability/view-models";

describe("observability view models", () => {
  it("builds focused observability deep links", () => {
    expect(
      buildObservabilityHref({
        focus: "alerts",
        alertId: "alert-1",
        issueId: "issue-1",
      }),
    ).toBe("/observability?focus=alerts&alertId=alert-1&issueId=issue-1");
  });

  it("prioritizes issue and alert action cards ahead of secondary operational cues", () => {
    const overview: FridayObservabilityOverview = {
      generatedAt: "2026-03-08T10:00:00.000Z",
      traces: {
        totalTraces: 5,
        erroredTraces: 1,
        avgDurationMs: 180,
      },
      audit: {
        totalEntries: 6,
        byOutcome: { success: 5, failure: 1 },
      },
      alerts: {
        activeAlerts: 1,
        highestSeverity: "critical",
      },
      health: {
        status: "degraded",
        message: "API health degraded",
        components: [
          {
            name: "API",
            module: "api",
            status: "degraded",
            message: "Latency increased",
          },
        ],
      },
    };

    const issues: FridayIssueCard[] = [
      {
        id: "issue-1",
        kind: "approval_required",
        incidentId: "incident-1",
        title: "Approve fallback provider fix",
        summary: "Friday needs approval before switching providers.",
        severity: "critical",
        status: "open",
        createdAt: "2026-03-08T10:00:00.000Z",
        routeTarget: "/assistant",
      },
    ];

    const alerts: FridayObservabilityAlertSummary[] = [
      {
        id: "alert-1",
        ruleId: "rule-1",
        ruleName: "API availability",
        severity: "critical",
        status: "firing",
        summary: "API availability dropped below threshold",
        module: "api",
        detectedAt: "2026-03-08T09:50:00.000Z",
        notifiedChannelCount: 1,
        currentEscalationTier: 1,
      },
    ];

    const acceptanceResults: FridayAcceptanceRunSummary[] = [
      {
        id: "acceptance-1",
        executionId: "execution-1",
        artifactType: "workflow",
        artifactUri: "workflow://release",
        state: "failed",
        overallVerdict: "failed",
        overallSeverity: "high",
        checksTotal: 4,
        checksFailed: 1,
        checksWarned: 0,
        durationMs: 1200,
        createdAt: "2026-03-08T10:00:00.000Z",
      },
    ];

    const retryEscalations: FridayRetryEscalationSummary[] = [
      {
        id: "retry-1",
        traceId: "trace-1",
        target: "provider:openai",
        failureCategory: "rate_limit",
        reason: "Retries exceeded the escalation threshold",
        channel: "slack",
        attemptCount: 4,
        totalCost: {
          tokens: 3000,
          apiCalls: 4,
          computeMs: 2200,
        },
        acknowledged: false,
        escalatedAt: "2026-03-08T10:00:00.000Z",
      },
    ];

    const retryCircuitBreakers: FridayRetryCircuitBreakerSummary[] = [
      {
        targetId: "provider:openai",
        state: "open",
        consecutiveFailures: 4,
        failureThreshold: 3,
        lastOpenedAt: "2026-03-08T10:00:00.000Z",
        tripCount: 2,
        updatedAt: "2026-03-08T10:05:00.000Z",
      },
    ];

    const agentLoopRuns: FridayAgentLoopRunRecord[] = [
      {
        run: {
          loopRunId: "loop-1",
          incidentId: "incident-2",
          status: "halted",
          policySnapshot: {
            retryBudget: 2,
            cooldownMinutes: 15,
          },
          verificationPassed: false,
          rollbackAttempted: true,
          haltReason: "Repeated failures exhausted the retry budget.",
          createdAt: "2026-03-08T10:00:00.000Z",
          updatedAt: "2026-03-08T10:03:00.000Z",
        },
        incident: null,
        action: null,
      },
    ];

    const queue = buildObservabilityActionQueue({
      overview,
      alerts,
      issues,
      acceptanceResults,
      retryEscalations,
      retryCircuitBreakers,
      agentLoopRuns,
    });

    expect(queue[0]).toMatchObject({
      id: "issue:issue-1",
      focus: "alerts",
    });
    expect(queue[1]).toMatchObject({
      id: "alert:alert-1",
      focus: "alerts",
    });
    expect(queue.some((item) => item.id === "acceptance:acceptance-1")).toBe(true);
    expect(queue.some((item) => item.id === "loop:loop-1")).toBe(true);
  });

  it("formats operator focus labels for the action-first page", () => {
    expect(formatObservabilityFocusLabel("overview")).toBe("Overview");
    expect(formatObservabilityFocusLabel("retry")).toBe("Retry");
    expect(formatObservabilityFocusLabel("loop")).toBe("Agent loop");
  });
});
