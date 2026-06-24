import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_device_events_merge";

function writeEvidence(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.json"),
    timeline: join(tempDir, "timeline.json"),
  };
  for (const [role, path] of Object.entries(files)) {
    writeFileSync(path, JSON.stringify({ role, mission_id: missionId }));
  }
  return files;
}

function event(surface: string, name: string, evidenceRef: string, activeMissionId = missionId) {
  return {
    surface,
    event: name,
    mission_id: activeMissionId,
    evidence_ref: evidenceRef,
  };
}

function diagnosticEvent(surface: string, name: string, evidenceRef: string) {
  return {
    ...event(surface, name, evidenceRef),
    truth_label: "derived_from_preflighted_workbench_snapshot_not_final_proof",
    source: "transcript_surface:desktop",
    captured_at: "2026-06-24T20:10:00Z",
  };
}

describe("friday-ui-device-events-merge", () => {
  it("merges repeated event inputs, validates evidence refs, and deduplicates exact rows", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-events-merge-"));
    try {
      const evidence = writeEvidence(tempDir);
      const first = join(tempDir, "first.jsonl");
      const eventsDir = join(tempDir, "events-dir");
      const second = join(eventsDir, "second.jsonl");
      const out = join(tempDir, "merged.jsonl");
      mkdirSync(eventsDir);
      writeFileSync(first, [
        event("mobile", "mission_intake_submitted", evidence.mobile),
        event("mobile", "mission_intake_submitted", evidence.mobile),
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      writeFileSync(second, [
        event("desktop", "mission_workbench_visible", evidence.desktop),
        event("timeline", "bounded_page_1_visible", evidence.timeline),
        event("desktop", "pressure_20_50_consecutive_asks_visible", evidence.desktop),
        event("desktop", "pressure_20_50_consecutive_asks_visible", evidence.desktop),
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");

      const stdout = execFileSync("node", [
        "scripts/ops/friday-ui-device-events-merge.mjs",
        `--mission-id=${missionId}`,
        `--events=${first}`,
        `--events-dir=${eventsDir}`,
        `--mobile=${evidence.mobile}`,
        `--desktop=${evidence.desktop}`,
        `--channel=${evidence.channel}`,
        `--timeline=${evidence.timeline}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        inputRows?: number;
        outputRows?: number;
        deduplicatedRows?: number;
      };
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(result.truth).toBe("ui_device_events_merge_not_proof");
      expect(result.status).toBe("ready");
      expect(result.inputRows).toBe(6);
      expect(result.outputRows).toBe(5);
      expect(result.deduplicatedRows).toBe(1);
      expect(rows).toContainEqual(event("desktop", "mission_workbench_visible", evidence.desktop));
      expect(rows.filter((row) => row.event === "pressure_20_50_consecutive_asks_visible")).toHaveLength(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed on mission mismatch and does not write merged output", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-events-merge-blocked-"));
    try {
      const evidence = writeEvidence(tempDir);
      const input = join(tempDir, "events.jsonl");
      const out = join(tempDir, "merged.jsonl");
      writeFileSync(input, `${JSON.stringify(event("mobile", "mission_intake_submitted", evidence.mobile, "mission_other"))}\n`);

      const result = spawnSync("node", [
        "scripts/ops/friday-ui-device-events-merge.mjs",
        `--mission-id=${missionId}`,
        `--events=${input}`,
        `--mobile=${evidence.mobile}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("event_mission_mismatch");
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves diagnostic provenance fields from derived workbench rows", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-events-merge-provenance-"));
    try {
      const evidence = writeEvidence(tempDir);
      const input = join(tempDir, "events.jsonl");
      const out = join(tempDir, "merged.jsonl");
      writeFileSync(input, `${JSON.stringify(diagnosticEvent(
        "desktop",
        "transcript_browser_visible",
        evidence.desktop,
      ))}\n`);

      const stdout = execFileSync("node", [
        "scripts/ops/friday-ui-device-events-merge.mjs",
        `--mission-id=${missionId}`,
        `--events=${input}`,
        `--desktop=${evidence.desktop}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as {
        status?: string;
        caveat?: string;
      };
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(result.status).toBe("ready");
      expect(result.caveat).toContain("Missing observations must still be captured");
      expect(rows).toEqual([
        diagnosticEvent("desktop", "transcript_browser_visible", evidence.desktop),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
