import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-macos-live-write-read-proof-events.mjs";
const missionId = "mission-desktop-live-roundtrip-cli";
const workItemId = "work-desktop-live-roundtrip-cli";

function proof(overrides: Record<string, unknown> = {}) {
  return {
    truth_label: "macos_desktop_live_write_read_roundtrip_proof_not_ui_device_proof",
    status: "pass",
    generated_at_utc: "2026-06-24T10:00:00Z",
    mission_id: missionId,
    work_item_id: workItemId,
    surface_kind: "desktop",
    delivery_route: "desktop://hub-console/live-write-read-roundtrip/cli",
    write: {
      status: "ready",
      created_or_ready: true,
      mission_id: missionId,
      work_item_id: workItemId,
      endpoint: { host: "127.0.0.1", port: 48750 },
    },
    read_projection: {
      mission_id: missionId,
      work_item_ids: [workItemId],
      contains_written_work_item: true,
      generated_at_ms: 1782290000000,
      endpoint: { host: "127.0.0.1", port: 48751 },
    },
    caveat: "Desktop live write-read artifact only; not END-BAR, not GO-LIVE, not UI/device proof.",
    ...overrides,
  };
}

function writeProof(tempDir: string, value = proof()) {
  const path = join(tempDir, "desktop-roundtrip-proof.json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

describe("friday-macos-live-write-read-proof-events", () => {
  it("converts a redacted desktop write-read artifact into same-run desktop events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-macos-roundtrip-events-"));
    try {
      const proofPath = writeProof(tempDir);
      const outPath = join(tempDir, "events.jsonl");
      const stdout = execFileSync("node", [
        script,
        `--proof=${proofPath}`,
        `--out=${outPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as { status?: string; eventCount?: number; blockers?: unknown[] };
      expect(result.status).toBe("ready");
      expect(result.eventCount).toBe(5);
      expect(result.blockers).toEqual([]);

      const rows = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        surface?: string;
        event?: string;
        mission_id?: string;
        evidence_ref?: string;
        work_item_id?: string;
      }>;
      expect(rows.map((row) => row.event)).toEqual([
        "mission_intake_submitted",
        "mission_intake_ready",
        "mission_bound_provider_action_visible",
        "proof_receipt_visible_before_done",
        "same_mission_projection_visible",
      ]);
      expect(new Set(rows.map((row) => row.surface))).toEqual(new Set(["desktop"]));
      expect(new Set(rows.map((row) => row.mission_id))).toEqual(new Set([missionId]));
      expect(new Set(rows.map((row) => row.work_item_id))).toEqual(new Set([workItemId]));
      expect(new Set(rows.map((row) => row.evidence_ref))).toEqual(new Set([proofPath]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts shared-mission duplicate-existing preflight when the same WorkItem is visible", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-macos-roundtrip-events-duplicate-"));
    try {
      const proofPath = writeProof(tempDir, proof({
        write: {
          status: "blocked",
          created_or_ready: false,
          mission_id: missionId,
          work_item_id: workItemId,
          blockers: ["duplicate_active_work_item_before_dispatch"],
          duplicate_work_item_id: workItemId,
          accepted_existing_work_item: true,
          endpoint: { host: "127.0.0.1", port: 48750 },
        },
      }));
      const outPath = join(tempDir, "events.jsonl");
      const stdout = execFileSync("node", [
        script,
        `--proof=${proofPath}`,
        `--out=${outPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as { status?: string; eventCount?: number; blockers?: unknown[] };
      expect(result.status).toBe("ready");
      expect(result.eventCount).toBe(5);
      expect(result.blockers).toEqual([]);

      const rows = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        event?: string;
        work_item_id?: string;
      }>;
      expect(rows.map((row) => row.event)).toEqual([
        "mission_intake_submitted",
        "duplicate_preflight_visible",
        "mission_bound_provider_action_visible",
        "proof_receipt_visible_before_done",
        "same_mission_projection_visible",
      ]);
      expect(new Set(rows.map((row) => row.work_item_id))).toEqual(new Set([workItemId]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks artifacts whose read projection does not contain the written WorkItem", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-macos-roundtrip-events-blocked-"));
    try {
      const proofPath = writeProof(tempDir, proof({
        read_projection: {
          mission_id: missionId,
          work_item_ids: ["work-other"],
          contains_written_work_item: false,
          generated_at_ms: 1782290000000,
          endpoint: { host: "127.0.0.1", port: 48751 },
        },
      }));
      const outPath = join(tempDir, "events.jsonl");
      const result = spawnSync("node", [
        script,
        `--proof=${proofPath}`,
        `--out=${outPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("read_projection_missing_work_item");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("read_projection_contains_written_work_item_false");
      expect(() => readFileSync(outPath, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive-looking artifact payloads", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-macos-roundtrip-events-sensitive-"));
    try {
      const proofPath = writeProof(tempDir, proof({ authorization: "Bearer nope" }));
      const result = spawnSync("node", [
        script,
        `--proof=${proofPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("proof_contains_sensitive_marker");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
