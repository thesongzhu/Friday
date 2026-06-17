import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSummary,
  isAgentRunStartFailClosed,
  isAutonomySkillLifecycleFailClosed,
  isMemoryDurableItemCreateFailClosed,
  isObservabilityAlertDestinationCreateFailClosed,
  isSessionCreateFailClosed,
  isSkillImportFailClosed,
  isWorkflowCatalogCreateFailClosed,
  isWorkflowRunStartFailClosed,
  normalizeLiveProviderMode,
  resolveEffectiveExternalChannelScenarios,
  resolveGateSuiteReportRoot,
  resolveRetiredAgentRunScenarioExclusions,
  resolveRetiredAutonomySkillLifecycleScenarioExclusions,
  resolveRetiredMemoryDurableWriteScenarioExclusions,
  resolveRetiredObservabilityScenarioExclusions,
  resolveRetiredSessionScenarioExclusions,
  resolveRetiredSkillImportScenarioExclusions,
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

  it("excludes every agent-run-dependent RGG scenario while the route is fail-closed", () => {
    const reason =
      "POST /v1/agent/runs is classified fail_closed in the TS runtime retirement manifest.";
    expect(resolveRetiredAgentRunScenarioExclusions(process.cwd())).toEqual([
      { scenarioId: "l3-memory-api-store-agent-recall-proof", reason },
      { scenarioId: "l3-chat-direct-answer", reason },
      { scenarioId: "l3-agent-replayable-evidence-receipt", reason },
      { scenarioId: "l3-summary-misroute-guard", reason },
      { scenarioId: "l3-vague-goal-awaiting-user-state", reason },
      { scenarioId: "l3-destructive-request-visible-approval-gate", reason },
      { scenarioId: "l3-channel-origin-unified-task-state-contract", reason },
      { scenarioId: "l3-long-summary-direct", reason },
      { scenarioId: "l3-json-extraction", reason },
      { scenarioId: "l3-multi-turn-memory", reason },
      { scenarioId: "l4-file-tool-roundtrip", reason },
      { scenarioId: "l4-missing-file-no-verified-success", reason },
      { scenarioId: "l4-exec-outside-workspace-boundary", reason },
      { scenarioId: "l4-tool-search-deferred-tool-discovery", reason },
      { scenarioId: "l4-context-cost-control-evidence", reason },
      { scenarioId: "l4-tool-guardrail-pre-post-evidence", reason },
      { scenarioId: "l8-agent-core-soak", reason },
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

  it("drops external-channel scenarios that are retirement-excluded, leaving the suite empty when all are excluded", () => {
    // No exclusions -> the full external-channel scenario set remains.
    expect(resolveEffectiveExternalChannelScenarios([])).toEqual(["l6-discord-channel-roundtrip"]);
    expect(resolveEffectiveExternalChannelScenarios(undefined)).toEqual(["l6-discord-channel-roundtrip"]);
    // Excluding l6-discord-channel-roundtrip (sessions.create fail-closed) empties
    // the external-channel suite; the gate must treat this as trivially passed
    // rather than letting the runner throw "No scenarios selected".
    expect(resolveEffectiveExternalChannelScenarios(["l6-discord-channel-roundtrip"])).toEqual([]);
    expect(
      resolveEffectiveExternalChannelScenarios(["unrelated-scenario", "l6-discord-channel-roundtrip"]),
    ).toEqual([]);
  });

  it("passes the gate when external channels are ready but every scenario is retirement-excluded (0 passed)", () => {
    const summary = buildSummary({
      runId: "run-extch-empty",
      repoRoot: "/tmp/friday",
      branch: "main",
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
      externalChannels: { resultCounts: { passed: 0 }, allExternalChannelScenariosExcludedByRetirement: true },
      branchConformance: { shouldMerge: true },
      skillConformance: { ok: true },
    });
    expect(summary.gate).toEqual({ passed: true, reasons: [] });
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

  it("detects fail-closed session create retirement from the manifest", () => {
    expect(isSessionCreateFailClosed({
      surfaces: [
        {
          id: "sessions_create",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isSessionCreateFailClosed({
      surfaces: [
        {
          id: "sessions_create",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
    expect(isSessionCreateFailClosed({ surfaces: [] })).toBe(false);
  });

  it("excludes the discord channel roundtrip RGG scenario while session create is fail-closed", () => {
    expect(resolveRetiredSessionScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l6-discord-channel-roundtrip",
        reason: "POST /v1/sessions is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("detects fail-closed skill import retirement from the manifest", () => {
    expect(isSkillImportFailClosed({
      surfaces: [
        {
          id: "skills_import",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isSkillImportFailClosed({
      surfaces: [
        {
          id: "skills_import",
          classification: "ts_runtime_blocker",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
    expect(isSkillImportFailClosed({ surfaces: [] })).toBe(false);
  });

  it("excludes the skill-upgrade-lifecycle RGG scenario while skill import is fail-closed", () => {
    expect(resolveRetiredSkillImportScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l5-phase-06-skill-upgrade-lifecycle",
        reason: "POST /v1/skills/import is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
  });

  it("detects fail-closed durable memory item create retirement from the manifest", () => {
    expect(isMemoryDurableItemCreateFailClosed({
      surfaces: [
        {
          id: "memory_items_create",
          classification: "fail_closed",
          executes_product_logic: false,
        },
      ],
    })).toBe(true);
    expect(isMemoryDurableItemCreateFailClosed({
      surfaces: [
        {
          id: "memory_items_create",
          classification: "compat_shim",
          executes_product_logic: true,
        },
      ],
    })).toBe(false);
    expect(isMemoryDurableItemCreateFailClosed({ surfaces: [] })).toBe(false);
  });

  it("excludes the memory item create contract while durable TS memory writes are fail-closed", () => {
    expect(resolveRetiredMemoryDurableWriteScenarioExclusions(process.cwd())).toEqual([
      {
        scenarioId: "l2-memory-items-create-contract",
        reason: "POST /v1/memory/items is classified fail_closed in the TS runtime retirement manifest.",
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
      retiredSessionScenarioExclusions: [
        {
          scenarioId: "l6-discord-channel-roundtrip",
          reason: "POST /v1/sessions is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
      retiredMemoryDurableWriteScenarioExclusions: [
        {
          scenarioId: "l2-memory-items-create-contract",
          reason: "POST /v1/memory/items is classified fail_closed in the TS runtime retirement manifest.",
        },
      ],
    });

    expect(summary.retiredSessionScenarioExclusions).toEqual([
      {
        scenarioId: "l6-discord-channel-roundtrip",
        reason: "POST /v1/sessions is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
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
    expect(summary.retiredMemoryDurableWriteScenarioExclusions).toEqual([
      {
        scenarioId: "l2-memory-items-create-contract",
        reason: "POST /v1/memory/items is classified fail_closed in the TS runtime retirement manifest.",
      },
    ]);
    expect(summary.gate).toEqual({
      passed: true,
      reasons: [],
    });
  });
});
