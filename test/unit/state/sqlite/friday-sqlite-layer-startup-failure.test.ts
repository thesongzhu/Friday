import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  instances: [] as Array<{ open: boolean }>,
  failNextPragma: null as string | null,
  failAfterPragmaMatches: 0,
}));

vi.mock("better-sqlite3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-sqlite3")>();
  const RealDatabase = actual.default as unknown as new (...args: unknown[]) => { open: boolean };
  function CapturingDatabase(...args: unknown[]) {
    const db = new RealDatabase(...args);
    const originalPragma = db.pragma.bind(db);
    db.pragma = ((source: string, options?: unknown) => {
      if (captured.failNextPragma && source.includes(captured.failNextPragma)) {
        if (captured.failAfterPragmaMatches > 0) {
          captured.failAfterPragmaMatches -= 1;
          return originalPragma(source, options as never);
        }
        captured.failNextPragma = null;
        throw new Error(`forced pragma failure: ${source}`);
      }
      return originalPragma(source, options as never);
    }) as typeof db.pragma;
    captured.instances.push(db);
    return db;
  }
  Object.assign(CapturingDatabase, actual.default);
  return {
    ...actual,
    default: CapturingDatabase,
  };
});

describe("friday-sqlite-layer startup failure", () => {
  let tmpDir: string;

  afterEach(() => {
    captured.instances.length = 0;
    captured.failNextPragma = null;
    captured.failAfterPragmaMatches = 0;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("closes the writer connection when startup migration validation fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sqlite-layer-startup-failure-"));
    const dbPath = path.join(tmpDir, "future.db");
    const { default: RealDatabase } = await vi.importActual<typeof import("better-sqlite3")>(
      "better-sqlite3",
    );
    const seed = new RealDatabase(dbPath);
    seed.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (999, 'v999-future-build', 'future-checksum', '2026-05-18T00:00:00.000Z');
    `);
    seed.close();

    const { createFridaySqliteLayer } = await import("#state");

    expect(() =>
      createFridaySqliteLayer({
        dbPath,
        readPoolSize: 1,
        pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      }),
    ).toThrow(/newer than this Friday build/i);

    expect(captured.instances).toHaveLength(1);
    expect(captured.instances[0].open).toBe(false);
  });

  it("closes the writer connection when startup pragma setup fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sqlite-layer-startup-pragma-"));
    captured.failNextPragma = "foreign_keys";
    const { createFridaySqliteLayer } = await import("#state");

    expect(() =>
      createFridaySqliteLayer({
        dbPath: path.join(tmpDir, "pragma-failure.db"),
        readPoolSize: 1,
        pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      }),
    ).toThrow(/forced pragma failure/i);

    expect(captured.instances).toHaveLength(1);
    expect(captured.instances[0].open).toBe(false);
  });

  it("closes the writer connection when startup busy-timeout restore fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sqlite-layer-startup-restore-"));
    captured.failNextPragma = "busy_timeout = 5000";
    const { createFridaySqliteLayer } = await import("#state");

    expect(() =>
      createFridaySqliteLayer({
        dbPath: path.join(tmpDir, "restore-failure.db"),
        readPoolSize: 1,
        pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      }),
    ).toThrow(/forced pragma failure/i);

    expect(captured.instances).toHaveLength(1);
    expect(captured.instances[0].open).toBe(false);
  });

  it("closes writer and partially opened read connections when read-pool setup fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sqlite-layer-startup-read-pool-"));
    captured.failNextPragma = "query_only";
    captured.failAfterPragmaMatches = 1;
    const { createFridaySqliteLayer } = await import("#state");

    expect(() =>
      createFridaySqliteLayer({
        dbPath: path.join(tmpDir, "read-pool-failure.db"),
        readPoolSize: 2,
        pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      }),
    ).toThrow(/forced pragma failure/i);

    expect(captured.instances).toHaveLength(3);
    expect(captured.instances.every((instance) => instance.open === false)).toBe(true);
  });
});
