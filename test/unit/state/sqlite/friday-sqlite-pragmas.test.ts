import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import {
  applyFridayWritePragmas,
  applyFridayReadPragmas,
} from "#state";

describe("friday-sqlite-pragmas", () => {
  let db: Database.Database;
  let tmpDir: string;

  afterEach(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("applyFridayWritePragmas", () => {
    it("sets WAL, foreign_keys, busy_timeout, synchronous", () => {
      // WAL requires a file-backed database, not :memory:
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pragmas-"));
      db = new Database(path.join(tmpDir, "test.db"));
      applyFridayWritePragmas(db, { busyTimeoutMs: 5000, synchronous: "NORMAL" });

      const journalMode = db.pragma("journal_mode", { simple: true }) as string;
      expect(journalMode.toLowerCase()).toBe("wal");

      const fk = db.pragma("foreign_keys", { simple: true }) as number;
      expect(fk).toBe(1);

      const timeout = db.pragma("busy_timeout", { simple: true }) as number;
      expect(timeout).toBe(5000);

      const sync = db.pragma("synchronous", { simple: true }) as number;
      // NORMAL = 1
      expect(sync).toBe(1);
    });

    it("sets synchronous to FULL when configured", () => {
      db = new Database(":memory:");
      applyFridayWritePragmas(db, { busyTimeoutMs: 3000, synchronous: "FULL" });

      const sync = db.pragma("synchronous", { simple: true }) as number;
      // FULL = 2
      expect(sync).toBe(2);
    });
  });

  describe("applyFridayReadPragmas", () => {
    it("sets foreign_keys, busy_timeout, query_only", () => {
      db = new Database(":memory:");
      applyFridayReadPragmas(db, { busyTimeoutMs: 5000, synchronous: "NORMAL" });

      const fk = db.pragma("foreign_keys", { simple: true }) as number;
      expect(fk).toBe(1);

      const timeout = db.pragma("busy_timeout", { simple: true }) as number;
      expect(timeout).toBe(5000);

      const queryOnly = db.pragma("query_only", { simple: true }) as number;
      expect(queryOnly).toBe(1);
    });
  });
});
