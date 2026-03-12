import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initializeFridayState } from "#state";
import { FRIDAY_SQLITE_MIGRATIONS } from "#state";
import type { FridayStateRuntime } from "#state";

describe("state-index (initializeFridayState)", () => {
  let tmpDir: string;
  let runtime: FridayStateRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-state-init-"));
  });

  afterEach(() => {
    if (runtime) runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes full Phase 0 runtime from temp state dir", () => {
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        stateDir: tmpDir,
        database: { readPoolSize: 1, busyTimeoutMs: 5000, synchronous: "NORMAL" },
        mirror: { enabled: true, mode: "best-effort", consistencyCheckOnStartup: false },
        telemetry: {
          enabled: true,
          fileName: "test-telemetry.jsonl",
          summaryFileName: "test-summary.json",
        },
        backups: { configBackupCount: 1 },
      }),
    );

    runtime = initializeFridayState({ configPath });

    expect(runtime.config.exists).toBe(true);
    expect(runtime.config.config.stateDir).toBe(tmpDir);
    expect(runtime.sqlite).toBeTruthy();
    expect(runtime.sqlite.writer).toBeTruthy();
    expect(runtime.telemetry).toBeTruthy();
    expect(runtime.telemetry.runId).toBeTruthy();
  });

  it("runs migrations during init", () => {
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        stateDir: tmpDir,
        database: { readPoolSize: 1, busyTimeoutMs: 5000, synchronous: "NORMAL" },
      }),
    );

    runtime = initializeFridayState({ configPath });

    // Verify migrations ran by checking for schema_migrations table
    const tables = runtime.sqlite.withReadConnection((db) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .all(),
    ) as Array<{ name: string }>;

    expect(tables).toHaveLength(1);

    // Verify V001 was applied
    const migrations = runtime.sqlite.withReadConnection((db) =>
      db.prepare("SELECT version, name FROM schema_migrations").all(),
    ) as Array<{ version: number; name: string }>;

    expect(migrations).toHaveLength(FRIDAY_SQLITE_MIGRATIONS.length);
    for (let i = 0; i < FRIDAY_SQLITE_MIGRATIONS.length; i++) {
      expect(migrations[i].version).toBe(i + 1);
    }
  });

  it("wires telemetry and close lifecycle", () => {
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        stateDir: tmpDir,
        database: { readPoolSize: 1, busyTimeoutMs: 5000, synchronous: "NORMAL" },
        telemetry: {
          enabled: true,
          fileName: "lifecycle-events.jsonl",
          summaryFileName: "lifecycle-summary.json",
        },
      }),
    );

    runtime = initializeFridayState({ configPath });
    runtime.close();

    // Verify summary was written
    const summaryPath = path.join(tmpDir, "telemetry", "lifecycle-summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    expect(summary.runId).toBe(runtime.telemetry.runId);

    // Prevent double close in afterEach
    runtime = undefined;
  });
});
