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

  it("can surface UIUX non-channel closure reports without satisfying strict UI proof", () => {
    expect(script).toContain("uiux_closure_report_in=\"${MISSION_SPINE_UIUX_CLOSURE_REPORT:-}\"");
    expect(script).toContain("\"uiux_product_closure_report\": {");
    expect(script).toContain("\"non_channel_status\": \"$uiux_non_channel_status\"");
    expect(script).toContain("\"uiux_non_channel_report_never_satisfies_strict_ui_device_proof\": true");
    expect(script).toContain("&& \"$ui_device_status\" == \"passed\"");
  });
});
