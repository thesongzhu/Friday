import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync("rust-core/scripts/mission-spine-closure-audit-gate.sh", "utf8");

describe("mission-spine closure audit gate contract", () => {
  it("reports fresh backend live proof without weakening strict closure", () => {
    expect(script).toContain("deepseek_status=\"satisfied_by_last_backend_live_proof\"");
    expect(script).toContain("[[ \"$mode\" == \"--report\" && \"$backend_live_proof_status\" == \"passed\" && \"$deepseek_status\" != \"passed\" ]]");
    expect(script).toContain("\"report_mode_can_satisfy_deepseek_from_last_backend_live_proof\": true");
    expect(script).toContain("&& \"$deepseek_status\" == \"passed\" \\");
    expect(script).toContain("strict_mode_runs_live_positive_gates\": true");
  });
});
