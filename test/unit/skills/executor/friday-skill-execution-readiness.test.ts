import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { evaluateFridaySkillExecutionReadiness } from "#skills";

describe("evaluateFridaySkillExecutionReadiness", () => {
  it("keeps security-review ready on linux when ripgrep is unavailable", () => {
    const manifest = JSON.parse(
      readFileSync("/Users/jarvis/Projects/Friday/skills/security-review/skill.manifest.json", "utf8"),
    ) as {
      runtime: { kind: "node" };
      requirements: {
        bins: string[];
        env: string[];
        config: string[];
        os: Array<"darwin" | "linux" | "win32">;
      };
      executionTargets: {
        allowedSatelliteTypes: Array<"desktop" | "cloud-vm">;
        requiredCapabilities: string[];
      };
    };

    const readiness = evaluateFridaySkillExecutionReadiness({
      manifest,
      env: {
        PATH: "",
      },
      platform: "linux",
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });
});
