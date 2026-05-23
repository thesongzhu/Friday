import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  };
});

import {
  appendFridayAuditLog,
  buildFridayAuditRecordBase,
  resolveFridayAuditLogPath,
} from "../../../src/security/friday-audit-log.js";
import type { FridayAuditRecord } from "../../../src/security/friday-audit-log.js";

describe("FridayAuditLog (security)", () => {
  let tmpDir: string;
  let logPath: string;

  function makeRecord(action: string, overrides?: Partial<FridayAuditRecord>): FridayAuditRecord {
    return buildFridayAuditRecordBase({
      id: `audit-${action}`,
      actorType: "user",
      actorId: "user-1",
      action,
      resourceType: "skill",
      resourceId: "skill-1",
      result: "success",
      caller: "test",
      ...overrides,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-audit-sec-test-"));
    logPath = path.join(tmpDir, "audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── resolveFridayAuditLogPath ───

  describe("resolveFridayAuditLogPath", () => {
    it("returns path under .friday directory", () => {
      const result = resolveFridayAuditLogPath("/my/state");
      expect(result).toBe(path.join("/my/state", ".friday", "audit.jsonl"));
    });
  });

  // ─── buildFridayAuditRecordBase ───

  describe("buildFridayAuditRecordBase", () => {
    it("populates forensic fields automatically", () => {
      const record = buildFridayAuditRecordBase({
        id: "test-1",
        actorType: "service",
        action: "test.action",
        resourceType: "test",
      });

      expect(record.ts).toBeDefined();
      expect(typeof record.ts).toBe("string");
      // Should be valid ISO date
      expect(new Date(record.ts).toISOString()).toBe(record.ts);

      expect(record.pid).toBe(process.pid);
      expect(record.nodeVersion).toBe(process.version);
      expect(record.platform).toBe(process.platform);
    });

    it("allows overriding ts", () => {
      const customTs = "2025-01-01T00:00:00.000Z";
      const record = buildFridayAuditRecordBase({
        id: "test-2",
        ts: customTs,
        actorType: "user",
        action: "test.action",
        resourceType: "test",
      });
      expect(record.ts).toBe(customTs);
    });

    it("preserves all provided fields", () => {
      const record = buildFridayAuditRecordBase({
        id: "test-3",
        actorType: "user",
        actorId: "user-42",
        action: "skill.install",
        resourceType: "skill",
        resourceId: "skill-99",
        requestId: "req-1",
        traceId: "trace-1",
        result: "success",
        caller: "MyService.install",
        ip: "127.0.0.1",
        userAgent: "FridayClient/1.0",
        durationMs: 150,
        details: { version: "1.0.0" },
      });

      expect(record.actorId).toBe("user-42");
      expect(record.result).toBe("success");
      expect(record.caller).toBe("MyService.install");
      expect(record.ip).toBe("127.0.0.1");
      expect(record.userAgent).toBe("FridayClient/1.0");
      expect(record.durationMs).toBe(150);
      expect(record.details).toEqual({ version: "1.0.0" });
    });

    it("supports outcome taxonomy fields", () => {
      const record = buildFridayAuditRecordBase({
        id: "test-4",
        actorType: "service",
        action: "auth.login",
        resourceType: "session",
        result: "denied",
        errorCode: "UNAUTHORIZED",
        errorMessage: "Invalid credentials",
      });

      expect(record.result).toBe("denied");
      expect(record.errorCode).toBe("UNAUTHORIZED");
      expect(record.errorMessage).toBe("Invalid credentials");
    });
  });

  // ─── appendFridayAuditLog ───

  describe("appendFridayAuditLog", () => {
    it("creates the file and appends a JSONL line", async () => {
      await appendFridayAuditLog(logPath, makeRecord("install"));
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]) as FridayAuditRecord;
      expect(parsed.action).toBe("install");
    });

    it("appends multiple entries", async () => {
      await appendFridayAuditLog(logPath, makeRecord("install"));
      await appendFridayAuditLog(logPath, makeRecord("enable"));
      await appendFridayAuditLog(logPath, makeRecord("disable"));
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
    });

    it("creates parent directories with secure permissions", async () => {
      const deepPath = path.join(tmpDir, "a", "b", "c", "audit.jsonl");
      await appendFridayAuditLog(deepPath, makeRecord("install"));
      expect(fs.existsSync(deepPath)).toBe(true);

      // Check parent directory permissions (0o700 on platforms that support it)
      if (process.platform !== "win32") {
        const dirStat = fs.statSync(path.dirname(deepPath));
        expect(dirStat.mode & 0o777).toBe(0o700);
      }
    });

    it("writes files with secure permissions (0o600)", async () => {
      await appendFridayAuditLog(logPath, makeRecord("install"));

      if (process.platform !== "win32") {
        const fileStat = fs.statSync(logPath);
        expect(fileStat.mode & 0o777).toBe(0o600);
      }
    });

    it("includes forensic metadata in written records", async () => {
      await appendFridayAuditLog(logPath, makeRecord("install", {
        caller: "TestSuite",
        ip: "10.0.0.1",
        durationMs: 42,
        result: "success",
      }));

      const content = fs.readFileSync(logPath, "utf8");
      const parsed = JSON.parse(content.trim()) as FridayAuditRecord;

      expect(parsed.pid).toBe(process.pid);
      expect(parsed.nodeVersion).toBe(process.version);
      expect(parsed.platform).toBe(process.platform);
      expect(parsed.caller).toBe("TestSuite");
      expect(parsed.ip).toBe("10.0.0.1");
      expect(parsed.durationMs).toBe(42);
      expect(parsed.result).toBe("success");
    });

    it("includes outcome taxonomy in written records", async () => {
      await appendFridayAuditLog(logPath, makeRecord("auth.check", {
        result: "denied",
        errorCode: "FORBIDDEN",
        errorMessage: "Access denied",
      }));

      const content = fs.readFileSync(logPath, "utf8");
      const parsed = JSON.parse(content.trim()) as FridayAuditRecord;

      expect(parsed.result).toBe("denied");
      expect(parsed.errorCode).toBe("FORBIDDEN");
      expect(parsed.errorMessage).toBe("Access denied");
    });

    it("rotates when exceeding maxBytes", async () => {
      for (let i = 0; i < 20; i++) {
        await appendFridayAuditLog(logPath, makeRecord(`action-${String(i)}`), {
          maxBytes: 500,
          keepLines: 5,
        });
      }
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(6); // keepLines + 1 for append-then-check
      // Most recent entries should be kept
      const lastEntry = JSON.parse(lines[lines.length - 1]) as FridayAuditRecord;
      expect(lastEntry.action).toBe("action-19");
    });

    it("maintains secure permissions after rotation", async () => {
      for (let i = 0; i < 10; i++) {
        await appendFridayAuditLog(logPath, makeRecord(`action-${String(i)}`), {
          maxBytes: 200,
          keepLines: 3,
        });
      }

      if (process.platform !== "win32") {
        const fileStat = fs.statSync(logPath);
        expect(fileStat.mode & 0o777).toBe(0o600);
      }
    });

    it("handles concurrent appends without interleaving", async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(appendFridayAuditLog(logPath, makeRecord(`concurrent-${String(i)}`)));
      }
      await Promise.all(promises);
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(10);
      // Each line should be valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line) as FridayAuditRecord;
        expect(parsed.id).toMatch(/^audit-concurrent-\d+$/);
      }
    });

    it("reports rotation errors without hiding the append result", async () => {
      const rotationError = new Error("rotation-read-failed");
      vi.mocked(fsPromises.readFile).mockRejectedValueOnce(rotationError);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onRotationError = vi.fn();

      try {
        await appendFridayAuditLog(logPath, makeRecord("rotation-signal"), {
          maxBytes: 1,
          keepLines: 1,
          onRotationError,
        });
      } finally {
        warnSpy.mockRestore();
      }

      expect(onRotationError).toHaveBeenCalledWith(rotationError, {
        filePath: logPath,
        maxBytes: 1,
        keepLines: 1,
      });
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]) as FridayAuditRecord).action).toBe("rotation-signal");
    });
  });
});
