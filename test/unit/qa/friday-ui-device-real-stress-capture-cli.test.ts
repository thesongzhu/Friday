import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-real-stress-capture.mjs";
const stressBridge = "scripts/ops/friday-ui-device-stress-events.mjs";
const missionId = "codex-organic-mission-real-stress-contract";

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function event(surface: string, name: string, evidenceRef: string, truth = "derived_from_real_same_run_capture_not_final_proof") {
  return {
    surface,
    event: name,
    mission_id: missionId,
    evidence_ref: evidenceRef,
    truth_label: truth,
    captured_at: "2026-06-26T23:30:00.000Z",
  };
}

function writeEvents(path: string, evidenceRef: string, overrides: { mission?: string; truth?: string } = {}) {
  const rows = [
    event("mobile", "mission_intake_submitted", evidenceRef, overrides.truth),
    event("desktop", "same_mission_projection_visible", evidenceRef, overrides.truth),
    event("desktop", "real_provider_execution_receipt_visible", evidenceRef, overrides.truth),
    event("timeline", "bounded_page_1_visible", evidenceRef, overrides.truth),
    event("timeline", "bounded_page_2_visible", evidenceRef, overrides.truth),
    event("timeline", "memory_candidate_review_only", evidenceRef, overrides.truth),
    event("desktop", "duplicate_preflight_visible", evidenceRef, overrides.truth),
    event("mobile", "duplicate_preflight_visible", evidenceRef, overrides.truth),
    event("desktop", "stale_label_visible", evidenceRef, overrides.truth),
    event("desktop", "offline_label_visible", evidenceRef, overrides.truth),
    event("desktop", "error_label_visible", evidenceRef, overrides.truth),
  ].map((row) => overrides.mission ? { ...row, mission_id: overrides.mission } : row);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function writeBackend(path: string, overrides: Record<string, unknown> = {}) {
  writeJson(path, {
    proof: "mission_spine_backend_api_live_pressure",
    status: "passed",
    deepseek_live_api_pressure: {
      status: "passed",
      real_external_api: true,
      mission_bound_ask_count: 20,
    },
    local_real_http_pressure: {
      status: "passed",
      mission_bound_ask_count: 50,
    },
    invalid_key_negative: {
      status: "passed",
      asserts: ["no_hidden_fallback", "no_ledger", "no_completion"],
    },
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
    ...overrides,
  });
}

function writeObjective(path: string, overrides: Record<string, unknown> = {}) {
  writeJson(path, {
    proof: "mission_spine_objective_backend_wire_coverage",
    status: "passed",
    executed_tests: [
      { filter: "mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary" },
      { filter: "mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger" },
      { filter: "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak" },
      { filter: "mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion" },
      { filter: "reconnect_resumes_missed_stream_frames" },
    ],
    covered_requirements: ["no_hidden_fallback", "no_secret_leak"],
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
    ...overrides,
  });
}

function writeInputs(root: string) {
  const evidence = join(root, "same-run-visible-evidence.json");
  const backend = join(root, "backend-live-proof.json");
  const objective = join(root, "objective-coverage.json");
  const events = join(root, "same-run-events.jsonl");
  writeJson(evidence, { mission_id: missionId, truth_label: "real_same_run_visible_evidence_not_endbar" });
  writeBackend(backend);
  writeObjective(objective);
  writeEvents(events, evidence);
  return { evidence, backend, objective, events };
}

describe("friday-ui-device-real-stress-capture", () => {
  it("packages real backend pressure plus same-mission UI/workbench events into stress capture input", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-real-stress-capture-"));
    try {
      const inputs = writeInputs(root);
      const outDir = join(root, "out");
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--backend-live-proof=${inputs.backend}`,
        `--objective-coverage=${inputs.objective}`,
        `--events=${inputs.events}`,
        `--out-dir=${outDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as { status?: string; rawReport?: string; stressCapture?: string };
      expect(result.status).toBe("ready");
      expect(result.rawReport).toBe(join(outDir, "real-stress-source-report.json"));
      expect(result.stressCapture).toBe(join(outDir, "stress-capture.json"));

      const stress = JSON.parse(readFileSync(result.stressCapture ?? "", "utf8")) as {
        truth_label?: string;
        mission_bound_ask_count?: number;
        evidence_ref?: string;
      };
      expect(stress.truth_label).toBe("ui_device_stress_capture_real_same_run_not_endbar");
      expect(stress.mission_bound_ask_count).toBe(20);
      expect(stress.evidence_ref).toBe(result.rawReport);

      const bridgeOut = join(root, "stress-events.jsonl");
      const bridgeStdout = execFileSync("node", [
        stressBridge,
        `--mission-id=${missionId}`,
        `--stress-capture=${result.stressCapture}`,
        `--out=${bridgeOut}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(JSON.parse(bridgeStdout).status).toBe("ready");
      const rows = readFileSync(bridgeOut, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.event === "pressure_20_50_consecutive_asks_visible")).toHaveLength(20);
      expect(rows).toContainEqual(expect.objectContaining({ event: "network_error_visible" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without same-mission UI/workbench visible events", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-real-stress-capture-no-ui-"));
    try {
      const inputs = writeInputs(root);
      writeEvents(inputs.events, inputs.evidence, { mission: "codex-organic-mission-other" });
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--backend-live-proof=${inputs.backend}`,
        `--objective-coverage=${inputs.objective}`,
        `--events=${inputs.events}`,
        `--out-dir=${join(root, "out")}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("event_mission_mismatch");
      expect(existsSync(join(root, "out", "stress-capture.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects fixture/mock event evidence and incomplete backend proof", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-real-stress-capture-blocked-"));
    try {
      const inputs = writeInputs(root);
      writeEvents(inputs.events, inputs.evidence, { truth: "synthetic_mock_fixture_events" });
      writeBackend(inputs.backend, {
        deepseek_live_api_pressure: {
          status: "passed",
          real_external_api: false,
          mission_bound_ask_count: 3,
        },
      });
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--backend-live-proof=${inputs.backend}`,
        `--objective-coverage=${inputs.objective}`,
        `--events=${inputs.events}`,
        `--out-dir=${join(root, "out")}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      const codes = output.blockers?.map((blocker) => blocker.code) ?? [];
      expect(codes).toContain("deepseek_live_not_real_external_api");
      expect(codes).toContain("deepseek_live_ask_count_out_of_range");
      expect(codes).toContain("event_truth_label_forbidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
