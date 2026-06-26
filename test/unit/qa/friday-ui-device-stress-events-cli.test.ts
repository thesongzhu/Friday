import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-stress-events.mjs";
const missionId = "mission_ui_device_stress_events";

function writeStress(root: string, overrides: Record<string, unknown> = {}) {
  const evidence = join(root, "real-stress-report.json");
  writeFileSync(evidence, "real same-run stress capture bytes\n");
  const stress = join(root, "stress-capture.json");
  writeFileSync(stress, JSON.stringify({
    truth_label: "ui_device_stress_capture_real_same_run_not_endbar",
    mission_id: missionId,
    evidence_ref: evidence,
    mission_bound_ask_count: 20,
    consecutive: true,
    duplicate_surface_count: 2,
    provider_ack_not_done: true,
    invalid_key_error_visible: true,
    quota_error_visible: true,
    network_error_visible: true,
    reconnect_stale_verified: true,
    no_secret_leak: true,
    no_hidden_fallback: true,
    captured_at: "2026-06-26T16:45:00.000Z",
    ...overrides,
  }, null, 2));
  return { stress, evidence };
}

describe("friday-ui-device-stress-events", () => {
  it("bridges a real same-run stress capture into repeatable event rows", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-stress-events-"));
    try {
      const { stress, evidence } = writeStress(root);
      const out = join(root, "stress-events.jsonl");
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--stress-capture=${stress}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as { status?: string; outputRows?: number };
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(result.status).toBe("ready");
      expect(result.outputRows).toBe(28);
      expect(rows.filter((row) => row.event === "pressure_20_50_consecutive_asks_visible")).toHaveLength(20);
      expect(rows.filter((row) => row.event === "duplicate_preflight_visible")).toHaveLength(2);
      expect(rows).toContainEqual(expect.objectContaining({
        event: "invalid_key_error_visible",
        evidence_ref: evidence,
      }));
      expect(rows).toContainEqual(expect.objectContaining({
        surface: "timeline",
        event: "no_hidden_fallback_verified",
      }));
      expect(new Set(rows.map((row) => row.truth_label))).toEqual(new Set([
        "derived_from_real_same_run_stress_capture_not_final_proof",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on screenshot/mock stress evidence without writing events", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-stress-events-blocked-"));
    try {
      const screenshot = join(root, "screenshot.png");
      writeFileSync(screenshot, "not stress evidence\n");
      const { stress } = writeStress(root, {
        truth_label: "synthetic_mock_screenshot_only_stress_sample",
        evidence_ref: screenshot,
      });
      const out = join(root, "stress-events.jsonl");
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--stress-capture=${stress}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("truth_label_forbidden");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the full stress envelope before emitting rows", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-stress-events-incomplete-"));
    try {
      const { stress } = writeStress(root, {
        mission_bound_ask_count: 19,
        duplicate_surface_count: 1,
        network_error_visible: false,
      });
      const out = join(root, "stress-events.jsonl");
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--stress-capture=${stress}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "mission_bound_ask_count_out_of_range",
        "duplicate_surface_count_too_low",
        "network_error_visible_not_true",
      ]));
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
