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
    expect(source).toContain("accessibilityCaptureStatus");
    expect(source).toContain("Runner output is END-BAR only if strict UI/device readiness passes");
  });

  it("threads channel deferral through harvest, readiness, and gap report without counting it as proof", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-shortlist-runner.sh", "utf8");

    expect(source).toContain("--defer-channel-proof");
    expect(source).toContain("defer_channel_proof=\"${FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF:-0}\"");
    expect(source).toContain("harvest_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("readiness_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("gap_args+=(\"--defer-channel-proof\")");
    expect(source).toContain("real channel, timeline, stress, and negative-control evidence");
  });
});
