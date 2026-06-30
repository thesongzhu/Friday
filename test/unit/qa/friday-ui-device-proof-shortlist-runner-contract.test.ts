import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("friday-ui-device-proof-shortlist-runner contract", () => {
  it("threads real accessibility click captures through the strict UI/device evidence chain", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("--accessibility-capture");
    expect(source).toContain("accessibility_captures=()");
    expect(source).toContain("friday-ui-device-accessibility-click-capture.mjs");
    expect(source).toContain("--mission-id=${mission_id}");
    expect(source).toContain("accessibility-click-events.jsonl");
    expect(source).toContain("runtime_evidence_dirs+=(\"${accessibility_capture_dir}\")");
    expect(source).toContain("require_file_if_set \"accessibility evidence_ref\" \"${accessibility_evidence_ref}\"");
    expect(source).toContain("shared_extra_evidence+=(\"${accessibility_evidence_ref}\")");
    expect(source).toContain("accessibilityCaptureStatus");
    expect(source).toContain("Runner output is END-BAR only if strict UI/device readiness passes");
  });

  it("threads channel deferral through harvest, readiness, and gap report without counting it as proof", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("--defer-channel-proof");
    expect(source).toContain("defer_channel_proof=\"${FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF:-0}\"");
    expect(source).toContain("harvest_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("readiness_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("[ -n \"${timeline_capture}\" ] && { [ -n \"${channel_capture}\" ] || [ \"${defer_channel_proof}\" = \"1\" ]; }");
    expect(source).toContain("if node \"${capture_dir_args[@]}\"; then");
    expect(source).toContain("capture_dir_status=\"blocked\"");
    expect(source).toContain("capture_dir_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("capture_dir_status=\"ready_channel_deferred_non_strict\"");
    expect(source).toContain("closure_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("[[ \"${capture_dir_status}\" == ready* ]]");
    expect(source).toContain("gap_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("real channel, timeline, stress, and negative-control evidence");
  });

  it("can bind the runner to an exact existing Mission instead of only creating a shared-id Mission", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("[--mission-id codex-organic-mission-...]");
    expect(source).toContain("mission_id_arg=\"${FRIDAY_MISSION_SPINE_UI_PROOF_MISSION_ID:-}\"");
    expect(source).toContain("die \"--shared-id and --mission-id are mutually exclusive\"");
    expect(source).toContain("capture_args+=(\"--mission-id\" \"${mission_id_arg}\")");
  });

  it("threads real stress captures through the existing stress event bridge", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("--stress-capture");
    expect(source).toContain("stress_captures=()");
    expect(source).toContain("friday-ui-device-stress-events.mjs");
    expect(source).toContain("--mission-id=${mission_id}");
    expect(source).toContain("--stress-capture=${stress_capture}");
    expect(source).toContain("--out=${stress_events}");
    expect(source).toContain("--require-ready");
    expect(source).toContain("same_run_events+=(\"${stress_events}\")");
    expect(source).toContain("stress_evidence_ref=\"$(node -e");
    expect(source).toContain("require_file_if_set \"stress evidence_ref\" \"${stress_evidence_ref}\"");
    expect(source).toContain("shared_extra_evidence+=(\"${stress_evidence_ref}\")");
    expect(source).toContain("capture_dir_args+=(\"--shared-extra-evidence=${path}\")");
    expect(source).toContain("stressCaptureStatus");
  });

  it("auto-packages real backend pressure proof into stress evidence when same-run events are present", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("stress_capture_status=\"auto_ready\"");
    expect(source).toContain("stress_capture_status=\"auto_blocked\"");
    expect(source).toContain("friday-ui-device-real-stress-capture.mjs");
    expect(source).toContain("--backend-live-proof=${backend_live_proof}");
    expect(source).toContain("--objective-coverage=${objective_coverage}");
    expect(source).toContain("--events=${auto_stress_events}");
    expect(source).toContain("event_inputs+=(\"${auto_stress_bridge}\")");
    expect(source).toContain("same_run_events+=(\"${auto_stress_bridge}\")");
  });

  it("can derive non-channel workbench timeline inputs from the Rust Hub DB", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("--workbench-db");
    expect(source).toContain("workbench_db=\"${FRIDAY_WORKBENCH_DB_PATH:-}\"");
    expect(source).toContain("cargo run -p friday-hub --bin mission_workbench_projection");
    expect(source).toContain("workbench-timeline-capture.json");
    expect(source).toContain("friday-workbench-snapshot-events.mjs");
    expect(source).toContain("--allow-partial-events");
    expect(source).toContain("workbench_events_status=");
    expect(source).toContain("same_run_events+=(\"${workbench_events}\")");
    expect(source).toContain("readiness_args+=(\"--workbench-db\" \"${workbench_db}\")");
    expect(source).toContain("MISSION_ID=\"${mission_id}\" FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS");
    expect(source).toContain("workbenchTimelineStatus");
  });

  it("threads external action-runtime evidence into closure and readiness reports", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("closure_args+=(\"--runtime-evidence=${path}\")");
    expect(source).toContain("readiness_args+=(\"--design-action-runtime-evidence-dir\" \"${dir}\")");
    expect(source).toContain("readiness_args+=(\"--design-action-runtime-evidence\" \"${path}\")");
  });

  it("threads selected visual evidence into product closure without treating it as runtime evidence", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("--selected-visual-evidence-dir");
    expect(source).toContain("selected_visual_evidence_dirs=()");
    expect(source).toContain("closure_args+=(\"--selected-visual-evidence-dir=${dir}\")");
    expect(source).toContain("selectedVisualProofStatus");
  });

  it("keeps the readiness report file parseable JSON while preserving wrapper logs", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("readiness_stdout=\"${readiness_out}.stdout\"");
    expect(source).toContain("bash \"${readiness_args[@]}\" >\"${readiness_stdout}\"");
    expect(source).toContain("node - \"${readiness_stdout}\" \"${readiness_out}\"");
    expect(source).toContain("no parseable readiness JSON object suffix");
    expect(source).toContain("fs.writeFileSync(outPath, `${JSON.stringify(readiness, null, 2)}\\n`)");
  });

  it("keeps gap reports useful when strict capture-dir assembly is blocked", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("gap-report-events.jsonl");
    expect(source).toContain("friday-ui-device-events-merge.mjs");
    expect(source).toContain("gap_event_status=\"report_only_events_ready\"");
    expect(source).toContain("gapEventStatus");
    expect(source).toContain("gap_mobile=\"${mobile_capture}\"");
    expect(source).toContain("if [ -s \"${gap_manifest}\" ]; then");
  });

  it("derives summary fullProofGaps from the latest gap report instead of stale bundle defaults", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("\"${readiness_out}\" \"${gap_out}\"");
    expect(source).toContain("const gapReport = readOptionalJson(gapReportPath)");
    expect(source).toContain("function deriveFullProofGaps(bundle, gapReport)");
    expect(source).toContain("if (isChannelDeferredOnly(gapReport)) return [\"same_mission_mobile_desktop_channel_capture\"]");
    expect(source).toContain("initialFullProofGaps: bundle.fullProofGaps || []");
    expect(source).toContain("fullProofGaps,");
  });

  it("lets readiness derive workbench events while channel proof is deferred", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-readiness.sh", "utf8");

    expect(source).toContain("[ -z \"${CHANNEL_EVIDENCE:-}\" ] && [ \"${DEFER_CHANNEL_PROOF}\" != \"1\" ]");
    expect(source).toContain("args+=(\"--defer-channel-proof\")");
    expect(source).toContain("node \"${args[@]}\" >\"$stdout_out\"");
  });
});
