import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evaluateFridaySkillExecutionReadiness } from "#skills";

describe("evaluateFridaySkillExecutionReadiness", () => {
  it("keeps security-review ready on linux when ripgrep is unavailable", () => {
    const manifestPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../skills/security-review/skill.manifest.json",
    );
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
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
