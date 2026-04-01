import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";

describe("friday-sqlite-layer", () => {
  let tmpDir: string;
  let layer: FridaySqliteLayer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sqlite-layer-"));
  });

  afterEach(() => {
    if (layer) layer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates writer + read pool", () => {
    layer = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "test.db"),
      readPoolSize: 2,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });

    expect(layer.writer).toBeTruthy();
    expect(layer.reads.size).toBe(2);
    expect(layer.dbPath).toContain("test.db");
  });

  it("withWriteTransaction commits correctly", () => {
    layer = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "test.db"),
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });

    layer.writer.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");

    layer.withWriteTransaction((db) => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("key1", "value1");
    });

    const row = layer.withReadConnection((db) =>
      db.prepare("SELECT v FROM kv WHERE k = ?").get("key1"),
    ) as { v: string } | undefined;
    expect(row?.v).toBe("value1");
  });

  it("withWriteTransaction rolls back on error", () => {
    layer = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "test.db"),
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });

    layer.writer.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");

    expect(() => {
      layer.withWriteTransaction((db) => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("key1", "value1");
        throw new Error("deliberate failure");
      });
    }).toThrow("deliberate failure");

    const row = layer.withReadConnection((db) =>
      db.prepare("SELECT v FROM kv WHERE k = ?").get("key1"),
    );
    expect(row).toBeUndefined();
  });

  it("close() closes all connections", () => {
    layer = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "test.db"),
      readPoolSize: 2,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });

    layer.close();

    // Writer should be closed - operations should throw
    expect(() => layer.writer.exec("SELECT 1")).toThrow();
  });

  it("checkpoint runs without error", () => {
    layer = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "test.db"),
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });

    expect(() => layer.checkpoint("FULL")).not.toThrow();
  });

  it("allows two processes to initialize the same sqlite file concurrently", async () => {
    const dbPath = path.join(tmpDir, "concurrent.db");
    const workerPath = fileURLToPath(
      new URL("./helpers/create-sqlite-layer-worker.mjs", import.meta.url),
    );

    async function runWorker(): Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }> {
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, dbPath], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    }

    const [first, second] = await Promise.all([runWorker(), runWorker()]);

    expect(first.code, first.stderr || first.stdout).toBe(0);
    expect(second.code, second.stderr || second.stdout).toBe(0);
    expect(JSON.parse(first.stdout.trim())).toMatchObject({ ok: true, dbPath });
    expect(JSON.parse(second.stdout.trim())).toMatchObject({ ok: true, dbPath });
  });

  it("restores the configured busy timeout after startup serialization", () => {
    layer = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "startup-timeout-reset.db"),
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });

    const timeout = layer.writer.pragma("busy_timeout", { simple: true }) as number;
    expect(timeout).toBe(5000);
  });
});
