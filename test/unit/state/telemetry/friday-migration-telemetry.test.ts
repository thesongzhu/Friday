import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createFridayMigrationTelemetryWriter,
  type FridayMigrationTelemetryEvent,
  type FridayMigrationTelemetrySummary,
} from "#state";

describe("friday-migration-telemetry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-telemetry-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes JSONL event records", () => {
    const writer = createFridayMigrationTelemetryWriter({
      stateDir: tmpDir,
      fileName: "events.jsonl",
      summaryFileName: "summary.json",
    });

    writer.record({
      type: "sqlite-migration",
      status: "ok",
      message: "Applied v001",
    });

    writer.record({
      type: "consistency-check",
      status: "mismatch",
      entityType: "settings",
      entityKey: "theme",
    });

    const jsonlPath = path.join(tmpDir, "telemetry", "events.jsonl");
    expect(fs.existsSync(jsonlPath)).toBe(true);

    const lines = fs
      .readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as FridayMigrationTelemetryEvent);

    expect(lines).toHaveLength(2);
    expect(lines[0].runId).toBe(writer.runId);
    expect(lines[0].type).toBe("sqlite-migration");
    expect(lines[0].status).toBe("ok");
    expect(lines[0].at).toBeTruthy();
    expect(lines[1].type).toBe("consistency-check");
    expect(lines[1].status).toBe("mismatch");
  });

  it("writes summary JSON on finalize", () => {
    const writer = createFridayMigrationTelemetryWriter({
      stateDir: tmpDir,
      fileName: "events.jsonl",
      summaryFileName: "summary.json",
    });

    writer.finalize({
      finishedAt: new Date().toISOString(),
      appliedMigrations: [1],
      mirrorWrites: { ok: 5, mismatch: 1, error: 0 },
      consistencyChecks: { ok: 3, mismatch: 0, error: 0 },
    });

    const summaryPath = path.join(tmpDir, "telemetry", "summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(
      fs.readFileSync(summaryPath, "utf-8"),
    ) as FridayMigrationTelemetrySummary;

    expect(summary.runId).toBe(writer.runId);
    expect(summary.startedAt).toBe(writer.startedAt);
    expect(summary.appliedMigrations).toEqual([1]);
    expect(summary.mirrorWrites.ok).toBe(5);
    expect(summary.consistencyChecks.ok).toBe(3);
  });

  it("includes runId and timestamps in events", () => {
    const fixedDate = new Date("2025-01-01T00:00:00Z");
    const writer = createFridayMigrationTelemetryWriter({
      stateDir: tmpDir,
      fileName: "events.jsonl",
      summaryFileName: "summary.json",
      now: () => fixedDate,
    });

    expect(writer.runId).toBeTruthy();
    expect(writer.startedAt).toBe("2025-01-01T00:00:00.000Z");

    writer.record({ type: "sqlite-migration", status: "ok" });

    const jsonlPath = path.join(tmpDir, "telemetry", "events.jsonl");
    const line = JSON.parse(
      fs.readFileSync(jsonlPath, "utf-8").trim(),
    ) as FridayMigrationTelemetryEvent;

    expect(line.runId).toBe(writer.runId);
    expect(line.at).toBe("2025-01-01T00:00:00.000Z");
  });
});
