import { describe, expect, it } from "vitest";

import { resolveScenarioBlockers } from "../../../validation/real-world/lib/env-truth.mjs";

function makeEnvTruth(prerequisites) {
  return {
    auth: { ok: true },
    providerLanes: { default: { laneKey: "default" } },
    providerLaneRequirements: { fallbackRequired: false },
    prerequisites: {
      desktop: { status: "missing", source: "FRIDAY_REAL_WORLD_DESKTOP_READY" },
      externalChannels: { status: "missing", source: "FRIDAY_REAL_WORLD_EXTERNAL_CHANNELS_READY" },
      externalAlerts: { status: "missing", source: "FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY" },
      cloud: { status: "missing", source: "FRIDAY_REAL_WORLD_CLOUD_READY" },
      satellite: { status: "missing", source: "FRIDAY_REAL_WORLD_SATELLITE_READY" },
      mcp: { status: "missing", source: "FRIDAY_REAL_WORLD_MCP_READY" },
      packaging: { status: "missing", source: "FRIDAY_REAL_WORLD_PACKAGING_READY" },
      multiTenantSecurity: { status: "missing", source: "FRIDAY_REAL_WORLD_MULTI_TENANT_READY" },
      ...prerequisites,
    },
  };
}

describe("real-world env truth external_alerts blockers", () => {
  it("blocks scenarios with external_alerts.ready precondition when env is missing", () => {
    const envTruth = makeEnvTruth({});
    const blockers = resolveScenarioBlockers(
      { id: "scenario-x", preconditions: ["external_alerts.ready"], providerLane: "none" },
      envTruth,
    );
    expect(blockers.some((blocker) => blocker.startsWith("external_alerts.ready=missing"))).toBe(true);
  });

  it("does not block scenarios when external_alerts.ready precondition is satisfied", () => {
    const envTruth = makeEnvTruth({
      externalAlerts: { status: "ready", source: "FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY" },
    });
    const blockers = resolveScenarioBlockers(
      { id: "scenario-x", preconditions: ["external_alerts.ready"], providerLane: "none" },
      envTruth,
    );
    expect(blockers.filter((blocker) => blocker.startsWith("external_alerts.ready"))).toHaveLength(0);
  });

  it("surfaces missing-env detail when external_alerts is declared but env shape is incomplete", () => {
    const envTruth = makeEnvTruth({
      externalAlerts: {
        status: "missing",
        source: "FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY",
        missingEnv: [
          "FRIDAY_REAL_WORLD_ALERT_SLACK_WEBHOOK_URL",
          "FRIDAY_REAL_WORLD_ALERT_SMTP_HOST",
        ],
        note: "External alerts were declared ready, but neither Slack webhook nor SMTP proof env is complete.",
      },
    });
    const blockers = resolveScenarioBlockers(
      { id: "scenario-x", preconditions: ["external_alerts.ready"], providerLane: "none" },
      envTruth,
    );
    const blocker = blockers.find((entry) => entry.startsWith("external_alerts.ready"));
    expect(blocker).toBeDefined();
    expect(blocker).toContain("[missing env:");
    expect(blocker).toContain("FRIDAY_REAL_WORLD_ALERT_SLACK_WEBHOOK_URL");
  });
});
