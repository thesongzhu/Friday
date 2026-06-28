import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ios-live-write-read-proof-events.mjs";
const missionId = "mission-mobile-live-roundtrip-cli";
const workItemId = "work-mobile-live-roundtrip-cli";
const headSha = "abcdef12".repeat(5);

function proof(overrides: Record<string, unknown> = {}) {
  return {
    truth_label: "ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof",
    status: "pass",
    generated_at_utc: "2026-06-24T10:00:00Z",
    mission_id: missionId,
    work_item_id: workItemId,
    surface_kind: "mobile",
    delivery_route: "ios://friday-mobile/live-write-read-roundtrip/cli",
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
      endpoint: { host: "127.0.0.1", port: 59151 },
    },
    caveat: "Mobile live write-read artifact only; not END-BAR, not GO-LIVE, not UI/device proof.",
    ...overrides,
  };
}

function writeProof(tempDir: string, value = proof()) {
  const path = join(tempDir, "mobile-roundtrip-proof.json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

describe("friday-ios-live-write-read-proof-events", () => {
  it("converts a redacted mobile write-read artifact into same-run mobile events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-events-"));
    try {
      const proofPath = writeProof(tempDir);
      const outPath = join(tempDir, "events.jsonl");
      const stdout = execFileSync("node", [
        script,
        `--proof=${proofPath}`,
        `--out=${outPath}`,
        `--head-sha=${headSha}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as { status?: string; eventCount?: number; headSha?: string; blockers?: unknown[] };
      expect(result.status).toBe("ready");
      expect(result.eventCount).toBe(5);
      expect(result.headSha).toBe(headSha);
      expect(JSON.stringify(result)).toContain("no_explicit_ui_actions");
      expect(result.blockers).toEqual([]);

      const rows = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        surface?: string;
        event?: string;
        mission_id?: string;
        evidence_ref?: string;
        headSha?: string;
        work_item_id?: string;
      }>;
      expect(rows.map((row) => row.event)).toEqual([
        "mission_intake_submitted",
        "mission_intake_ready",
        "mission_bound_provider_action_visible",
        "proof_receipt_visible_before_done",
        "same_mission_projection_visible",
      ]);
      expect(new Set(rows.map((row) => row.surface))).toEqual(new Set(["mobile"]));
      expect(new Set(rows.map((row) => row.mission_id))).toEqual(new Set([missionId]));
      expect(new Set(rows.map((row) => row.work_item_id))).toEqual(new Set([workItemId]));
      expect(new Set(rows.map((row) => row.evidence_ref))).toEqual(new Set([proofPath]));
      expect(new Set(rows.map((row) => row.headSha))).toEqual(new Set([headSha]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exports action runtime evidence only from explicit UI action rows", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-action-events-"));
    try {
      const proofPath = writeProof(tempDir, proof({
        ui_actions: [
          {
            surface: "mobile",
            screen: "fridayChat",
            action_id: "chat:typing",
            runtimeActionId: "mobile/fridayChat/act",
            capability_id: "ask_friday_chat",
            status: "pass",
            evidence_ref: "proof://mobile-chat-send",
          },
        ],
      }));
      const actionOut = join(tempDir, "action-runtime-evidence.json");
      const eventOut = join(tempDir, "events.jsonl");
      const stdout = execFileSync("node", [
        script,
        `--proof=${proofPath}`,
        `--out=${eventOut}`,
        `--action-runtime-out=${actionOut}`,
        `--head-sha=${headSha}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as { actionRuntimeEvidence?: { status?: string; count?: number } };
      expect(result.actionRuntimeEvidence).toEqual(expect.objectContaining({ status: "ready", count: 1 }));
      const actionEvidence = JSON.parse(readFileSync(actionOut, "utf8")) as {
        truth?: string;
        status?: string;
        headSha?: string;
        actions?: Array<{ surface?: string; screen?: string; action_id?: string; capability_id?: string; status?: string; evidence_ref?: string; headSha?: string }>;
      };
      expect(actionEvidence.truth).toBe("action_runtime_evidence_from_explicit_ios_ui_actions_not_endbar");
      expect(actionEvidence.status).toBe("ready");
      expect(actionEvidence.headSha).toBe(headSha);
      expect(actionEvidence.actions).toEqual([
        expect.objectContaining({
          surface: "mobile",
          screen: "fridayChat",
          action_id: "mobile/fridayChat/act",
          source_action_id: "chat:typing",
          capability_id: "ask_friday_chat",
          status: "pass",
          evidence_ref: "proof://mobile-chat-send",
          headSha,
        }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when explicit UI action rows are malformed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-action-events-bad-"));
    try {
      const proofPath = writeProof(tempDir, proof({
        ui_actions: [
          { surface: "desktop", screen: "fridayChat", action_id: "chat:typing", status: "pass" },
          { surface: "mobile", screen: "", action_id: "", status: "pending" },
        ],
      }));
      const result = spawnSync("node", [
        script,
        `--proof=${proofPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "ui_action_surface_mismatch",
        "ui_action_missing_screen",
        "ui_action_missing_action_or_capability",
        "ui_action_status_not_pass",
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts shared-mission duplicate-existing preflight when the same WorkItem is visible", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-events-duplicate-"));
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
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-events-blocked-"));
    try {
      const proofPath = writeProof(tempDir, proof({
        read_projection: {
          mission_id: missionId,
          work_item_ids: ["work-other"],
          contains_written_work_item: false,
          generated_at_ms: 1782290000000,
          endpoint: { host: "127.0.0.1", port: 59151 },
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
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-events-sensitive-"));
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

  it("rejects malformed head sha metadata", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-roundtrip-events-head-"));
    try {
      const proofPath = writeProof(tempDir);
      const result = spawnSync("node", [
        script,
        `--proof=${proofPath}`,
        "--head-sha=not a sha",
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("head_sha_unexpected_shape");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
