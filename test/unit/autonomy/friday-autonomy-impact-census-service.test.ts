import { describe, expect, it } from "vitest";

import { createFridayAutonomyImpactCensusService } from "../../../src/autonomy/services/friday-autonomy-impact-census-service.js";
import type { FridayAutonomySubjectRecord } from "../../../src/autonomy/model/friday-autonomy-subject.types.js";

describe("FridayAutonomyImpactCensusService", () => {
  it("derives compatibility drift across the six autonomy subject kinds", () => {
    const subjects: FridayAutonomySubjectRecord[] = [
      {
        kind: "skill",
        id: "skill-1",
        displayName: "Skill One",
        status: "installed",
        activeVersion: "1.0.0",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        details: {
          minHubVersion: "2.0.0",
          runtimeApiVersion: "1",
        },
      },
      {
        kind: "workflow",
        id: "wf-1",
        displayName: "Workflow One",
        status: "published",
        activeVersion: "2",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        details: {
          latestVersionNumber: 3,
          publishedVersionNumber: 2,
        },
      },
      {
        kind: "plugin",
        id: "plugin-1",
        displayName: "Plugin One",
        status: "enabled",
        activeVersion: "1.2.3",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        details: {
          enabled: true,
          minHubVersion: "1.0.0",
          apiVersion: "1",
        },
      },
      {
        kind: "provider_profile",
        id: "prov-1",
        displayName: "Provider One",
        status: "enabled",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        details: {
          authMode: "api-key",
          keySourceKind: "env-ref",
          validationStatus: "failed",
          supportedModels: ["claude-sonnet-4-20250514"],
        },
      },
      {
        kind: "mcp_server",
        id: "mcp-1",
        displayName: "MCP One",
        status: "loaded",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        details: {
          toolCount: 0,
          resourceCount: 0,
        },
      },
      {
        kind: "channel_adapter",
        id: "irc",
        displayName: "IRC",
        status: "disconnected",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        details: {
          credentialStatus: "missing",
          running: false,
        },
      },
    ];

    const service = createFridayAutonomyImpactCensusService({
      inventory: { list: () => subjects },
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });

    const snapshots = service.list();

    expect(snapshots.map((snapshot) => `${snapshot.subject.kind}:${snapshot.derivedCompatibilityStatus}`)).toEqual([
      "skill:blocked",
      "workflow:adaptation_required",
      "plugin:compatible",
      "provider_profile:adaptation_required",
      "mcp_server:adaptation_required",
      "channel_adapter:blocked",
    ]);

    const plugin = snapshots.find((snapshot) => snapshot.subject.kind === "plugin");
    expect(plugin?.statusDrift).toBe(true);
    expect(plugin?.findings.every((finding) => finding.passed)).toBe(true);

    const workflow = snapshots.find((snapshot) => snapshot.subject.kind === "workflow");
    expect(workflow?.findings.some((finding) => finding.id === "workflow_version_gap" && finding.passed === false)).toBe(true);
  });
});
