import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSummary,
  isAgentRunStartFailClosed,
  isAutonomySkillLifecycleFailClosed,
  isObservabilityAlertDestinationCreateFailClosed,
  isWorkflowCatalogCreateFailClosed,
  isWorkflowRunStartFailClosed,
  normalizeLiveProviderMode,
  resolveGateSuiteReportRoot,
  resolveRetiredAgentRunScenarioExclusions,
  resolveRetiredAutonomySkillLifecycleScenarioExclusions,
  resolveRetiredObservabilityScenarioExclusions,
  resolveRetiredWorkflowCatalogScenarioExclusions,
  resolveRetiredWorkflowRunScenarioExclusions,
  shouldExcludeProviderScenarios,
  summarizeRun,
} from "../../../scripts/ops/run-real-green-gate.mjs";

describe("run-real-green-gate helpers", () => {
  it("preserves provider and browser attempt counters in suite summaries", () => {
    expect(summarizeRun({
      runId: "run-1",
      suite: "daily",
      reportRoot: "/tmp/report",
      resultCounts: { passed: 2 },
      failureClassCounts: {},
      defectBucketCounts: {},
      providerLanes: {},
      providerAttemptCount: 2,
      browserProbeAttemptCount: 1,
    })).toMatchObject({
      providerAttemptCount: 2,
      browserProbeAttemptCount: 1,
    });
  });

  it("keeps suite detail reports inside the RGG artifact root", () => {
    expect(resolveGateSuiteReportRoot("/tmp/rgg", "public-surface")).toBe(
      join("/tmp/rgg", "suites", "public-surface"),
    );
  });

  it("defaults to full live-provider proof unless economy mode is explicit", () => {
    expect(normalizeLiveProviderMode(undefined)).toBe("full");
    expect(normalizeLiveProviderMode("")).toBe("full");
    expect(normalizeLiveProviderMode("FULL")).toBe("full");
    expect(normalizeLiveProviderMode("economy")).toBe("economy");
    expect(normalizeLiveProviderMode("unknown")).toBe("full");
    expect(shouldExcludeProviderScenarios("full")).toBe(false);
    expect(shouldExcludeProviderScenarios("economy")).toBe(true);
  });

  it("detects fail-closed agent run start retirement from the manifest", () => {
    expect(isAgentRunStartFailClosed({
      surfaces: [
        {
          id: "agent_runs_start",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isAgentRunStartFailClosed({
      surfaces: [
        {
          id: "agent_runs_start",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
  });

  it("excludes agent-run-start-dependent RGG scenarios while the route is fail-closed", () => {
    expect(resolveRetiredAgentRunScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l3-destructive-request-visible-approval-gate",
        reason: "POST /v1/agent/runs is classified fail_closed in the TS runtime retirement manifest.",
      },
      {
        scenarioId: "l3-channel-origin-unified-task-state-contract",
        reason: "POST /v1/agent/runs is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("detects fail-closed workflow run start retirement from the manifest", () => {
    expect(isWorkflowRunStartFailClosed({
      surfaces: [
        {
          id: "workflow_runs_start",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isWorkflowRunStartFailClosed({
      surfaces: [
        {
          id: "workflow_runs_start",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
  });

  it("excludes workflow-run-start-dependent RGG scenarios while the route is fail-closed", () => {
    expect(resolveRetiredWorkflowRunScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l5-workflow-approval-roundtrip",
        reason: "POST /v1/workflow-runs is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("detects fail-closed workflow catalog create retirement from the manifest", () => {
    expect(isWorkflowCatalogCreateFailClosed({
      surfaces: [
        {
          id: "workflows_create",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isWorkflowCatalogCreateFailClosed({
      surfaces: [
        {
          id: "workflows_create",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
    expect(isWorkflowCatalogCreateFailClosed({ surfaces: [] })).toBe(false);
  });

  it("excludes workflow-catalog-authoring-dependent RGG scenarios while workflows.create is fail-closed", () => {
    expect(resolveRetiredWorkflowCatalogScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l3-workflow-browser-authoring",
        reason: "POST /v1/workflows is classified fail_closed in the TS runtime retirement manifest.",
      },
      {
        scenarioId: "l8-workflow-approval-soak",
        reason: "POST /v1/workflows is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("detects fail-closed autonomy skill upgrade-lifecycle retirement from the manifest", () => {
    expect(isAutonomySkillLifecycleFailClosed({
      surfaces: [
        {
          id: "autonomy_skills_promote",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isAutonomySkillLifecycleFailClosed({
      surfaces: [
        {
          id: "autonomy_skills_promote",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
    expect(isAutonomySkillLifecycleFailClosed({ surfaces: [] })).toBe(false);
  });

  it("excludes the live skill-upgrade-lifecycle RGG scenario while autonomy.skills.* is fail-closed", () => {
    expect(resolveRetiredAutonomySkillLifecycleScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l5-phase-06-skill-upgrade-lifecycle",
        reason: "POST /v1/autonomy/skills/:skillId/{shadow,canary,promote,rollback} is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("detects fail-closed observability alert-destination create retirement from the manifest", () => {
    expect(isObservabilityAlertDestinationCreateFailClosed({
      surfaces: [
        {
          id: "observability_alert_destinations_create",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isObservabilityAlertDestinationCreateFailClosed({
      surfaces: [
        {
          id: "observability_alert_destinations_create",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
    expect(isObservabilityAlertDestinationCreateFailClosed({ surfaces: [] })).toBe(false);
  });

  it("excludes the invalid-alert-destination-create RGG scenario while observability alert create is fail-closed", () => {
    expect(resolveRetiredObservabilityScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l2-observability-alert-destination-create-invalid-fails-closed",
        reason: "POST /v1/observability/alert-destinations is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("preserves retired runtime scenario exclusions in the terminal summary", () => {
    const summary = buildSummary({
      runId: "run-1",
      repoRoot: "/tmp/friday",
      branch: "codex/ts-runtime-retire-agent-runs",
      liveProviderMode: "economy",
      phaseStatus: {
        preflight: { status: "completed" },
        smoke: { status: "completed" },
        dailyCore: { status: "completed" },
        publicSurface: { status: "completed" },
        externalChannels: { status: "completed" },
        branchConformance: { status: "completed" },
        skillConformance: { status: "completed" },
      },
      preflight: {
        envTruth: {
          auth: { ok: true },
          providerLaneRequirements: { fallbackRequired: false },
          providerLanes: { default: true },
          prerequisites: { externalChannels: { status: "ready" } },
        },
      },
      smoke: { resultCounts: { passed: 1 } },
      dailyCore: { resultCounts: { passed: 1 } },
      publicSurface: { resultCounts: { passed: 1 } },
      externalChannels: { resultCounts: { passed: 1 } },
      branchConformance: { shouldMerge: true },
      skillConformance: { ok: true },
      retiredAgentRunScenarioExclusions: [
        {
          scenarioId: "l3-channel-origin-unified-task-state-contract",
          reason: "POST /v1/agent/runs is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
      retiredWorkflowRunScenarioExclusions: [
        {
          scenarioId: "l5-workflow-approval-roundtrip",
          reason: "POST /v1/workflow-runs is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
      retiredWorkflowCatalogScenarioExclusions: [
        {
          scenarioId: "l3-workflow-browser-authoring",
          reason: "POST /v1/workflows is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
      retiredAutonomySkillLifecycleScenarioExclusions: [
        {
          scenarioId: "l5-phase-06-skill-upgrade-lifecycle",
          reason: "POST /v1/autonomy/skills/:skillId/{shadow,canary,promote,rollback} is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
      retiredObservabilityScenarioExclusions: [
        {
          scenarioId: "l2-observability-alert-destination-create-invalid-fails-closed",
          reason: "POST /v1/observability/alert-destinations is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
    });

    expect(summary.retiredObservabilityScenarioExclusions).toEqual([
      {
        scenarioId: "l2-observability-alert-destination-create-invalid-fails-closed",
        reason: "POST /v1/observability/alert-destinations is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
    expect(summary.retiredWorkflowCatalogScenarioExclusions).toEqual([
      {
        scenarioId: "l3-workflow-browser-authoring",
        reason: "POST /v1/workflows is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
    expect(summary.retiredAutonomySkillLifecycleScenarioExclusions).toEqual([
      {
        scenarioId: "l5-phase-06-skill-upgrade-lifecycle",
        reason: "POST /v1/autonomy/skills/:skillId/{shadow,canary,promote,rollback} is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
    expect(summary.retiredAgentRunScenarioExclusions).toEqual([
      {
        scenarioId: "l3-channel-origin-unified-task-state-contract",
        reason: "POST /v1/agent/runs is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
    expect(summary.retiredWorkflowRunScenarioExclusions).toEqual([
      {
        scenarioId: "l5-workflow-approval-roundtrip",
        reason: "POST /v1/workflow-runs is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
    expect(summary.gate).toEqual({
      passed: true,
      reasons: [],
    });
  });
});
