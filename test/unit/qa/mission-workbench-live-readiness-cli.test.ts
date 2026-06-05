import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("check-mission-workbench-live-readiness CLI", () => {
  it("requires explicit isolated setup permission before mutating bootstrap or setup state", () => {
    const source = readFileSync("scripts/qa/check-mission-workbench-live-readiness.mjs", "utf8");

    expect(source).toContain("--allow-isolated-setup");
    expect(source).toContain("FRIDAY_MISSION_WORKBENCH_ALLOW_ISOLATED_SETUP");
    expect(source).toContain("setup_mutations_require_explicit_isolated_runtime");
    expect(source).toContain("isolated_setup_permission_required");
  });
});
