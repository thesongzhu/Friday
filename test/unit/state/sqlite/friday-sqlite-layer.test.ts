import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
});
