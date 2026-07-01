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
    expect(script).toContain("\"selected_ui_device_evidence_dir\": $uiux_selected_evidence_dir_json");
    expect(script).toContain("\"ui_device_readiness_candidate_runs\": $uiux_readiness_candidate_runs_json");
    expect(script).toContain("\"action_traceability\": {");
    expect(script).toContain("\"product_runtime_action_ids\": $uiux_product_runtime_action_ids_json");
    expect(script).toContain("\"product_actions_missing_runtime_evidence\": $uiux_product_actions_missing_runtime_evidence_json");
    expect(script).toContain("\"residual_destinations_with_blockers\": $uiux_residual_destinations_with_blockers_json");
    expect(script).toContain("\"uiux_non_channel_report_never_satisfies_strict_ui_device_proof\": true");
    expect(script).toContain("&& \"$ui_device_status\" == \"passed\"");
  });

  it("requires channel live proof wrappers to match the current HEAD", () => {
    expect(script).toContain("current_head=\"$(git -C \"$root\" rev-parse HEAD)\"");
    expect(script).toContain("jq -e --arg current_head \"$current_head\"");
    expect(script).toContain("(.head // .git_sha // .github.sha // .github.head_sha // \"\") == $current_head");
    expect(script).toContain("channel_live_proof_status=\"blocked_wrapper_not_current_head_or_strict_schema\"");
    expect(script).toContain("\"current_head\": \"$current_head\"");
    expect(script).toContain("\"proof_head\": \"$channel_live_proof_head\"");
  });
});
