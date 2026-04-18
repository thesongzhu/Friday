import { describe, expect, it } from "vitest";

import { createFridayAutonomyUpgradePlannerService } from "../../../src/autonomy/services/friday-autonomy-upgrade-planner-service.js";
import type { FridayUpgradeImpactSnapshot } from "../../../src/autonomy/model/friday-autonomy-impact.types.js";

describe("FridayAutonomyUpgradePlannerService", () => {
  it("recommends noop, patch, regenerate, and deprecate flows from impact census results", () => {
    const snapshots: FridayUpgradeImpactSnapshot[] = [
      {
        subject: {
          kind: "plugin",
          id: "plugin-ok",
          displayName: "Plugin OK",
          status: "enabled",
          compatibilityStatus: "unknown",
          promotionChannel: "none",
        },
        recordedCompatibilityStatus: "unknown",
        derivedCompatibilityStatus: "compatible",
        requiresAdaptation: false,
        statusDrift: true,
        findings: [],
      },
      {
        subject: {
          kind: "provider_profile",
          id: "prov-bad",
          displayName: "Provider Bad",
          status: "enabled",
          compatibilityStatus: "unknown",
          promotionChannel: "none",
        },
        recordedCompatibilityStatus: "unknown",
        derivedCompatibilityStatus: "blocked",
        requiresAdaptation: true,
        statusDrift: true,
        findings: [
          {
            id: "provider_credentials",
            severity: "blocking",
            passed: false,
            message: "Provider requires credentials but no key source is configured.",
          },
        ],
      },
      {
        subject: {
          kind: "skill",
          id: "skill-drift",
          displayName: "Skill Drift",
          status: "installed",
          compatibilityStatus: "unknown",
          promotionChannel: "none",
        },
        recordedCompatibilityStatus: "unknown",
        derivedCompatibilityStatus: "adaptation_required",
        requiresAdaptation: true,
        statusDrift: true,
        findings: [
          {
            id: "skill_installed_version",
            severity: "warning",
            passed: false,
            message: "Skill does not have an installed or active version.",
          },
        ],
      },
      {
        subject: {
          kind: "channel_adapter",
          id: "irc",
          displayName: "IRC",
          status: "disconnected",
          compatibilityStatus: "unknown",
          promotionChannel: "none",
        },
        recordedCompatibilityStatus: "unknown",
        derivedCompatibilityStatus: "blocked",
        requiresAdaptation: true,
        statusDrift: true,
        findings: [
          {
            id: "api_version_supported",
            severity: "blocking",
            passed: false,
            message: "API version 2 is not supported by the current hub.",
          },
        ],
      },
    ];

    const service = createFridayAutonomyUpgradePlannerService({
      census: { list: () => snapshots },
    });

    expect(service.listDecisions()).toEqual([
      expect.objectContaining({
        subjectKind: "plugin",
        strategy: "noop",
        nextStage: "shadow",
      }),
      expect.objectContaining({
        subjectKind: "provider_profile",
        strategy: "patch",
        nextStage: "adapt",
        blockerAction: "Configure real credentials before replay or canary.",
      }),
      expect.objectContaining({
        subjectKind: "skill",
        strategy: "regenerate",
        nextStage: "adapt",
      }),
      expect.objectContaining({
        subjectKind: "channel_adapter",
        strategy: "deprecate",
        nextStage: "adapt",
      }),
    ]);
  });
});
