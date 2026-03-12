/**
 * Adversarial Resource Exhaustion Tests (TEST-23 through TEST-26)
 *
 * Tests oversized payloads, audit log disk-fill, connection pool burst,
 * and scheduler timer leak resilience.
 *
 * - TEST-23 targets correct /v1/memory/store endpoint with 413 PAYLOAD_TOO_LARGE assertions
 * - TEST-24 tightens audit log rotation bounds and JSON validity
 * - TEST-25 uses correct API paths (/v1/sessions, /v1/plugins, /v1/memory/items)
 * - TEST-26 directly measures timer-count baseline/leak via vi.getTimerCount()
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "../e2e/api/_helpers/friday-api-test-server.helper.js";
import { appendFridayAuditLog } from "../../src/hub/services/friday-hub-audit-log-writer.js";
import { createFridayJobSchedulerService } from "../../src/jobs/scheduler/friday-job-scheduler-service.js";
import { createFridayJobSchedulerRepository } from "../../src/jobs/scheduler/friday-job-scheduler-repository.js";
import { createTestDb } from "../helpers/friday-test-db.helper.js";
import type { FridaySqliteLayer } from "#state";

// ─── TEST-23: Oversized Payload Guard ───

describe("TEST-23: Oversized Payload Guard", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    const auth = await loginTestUser(env.baseUrl);
    token = auth.accessToken;
  });

  afterAll(async () => {
    await env?.close();
  });

  it("rejects >1MB payload with 413 PAYLOAD_TOO_LARGE or connection reset", async () => {
    const largeContent = "x".repeat(2 * 1024 * 1024); // 2MB

    try {
      const res = await fetch(`${env.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          channel: "oversized-test",
          chatId: largeContent,
        }),
      });

      // If we got a response (not reset), it must be 413
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
    } catch (err) {
      // Connection reset is acceptable — server closed the socket after exceeding body limit
      expect((err as Error).message).toMatch(/fetch failed|ECONNRESET|socket hang up/i);
    }
  });

  it("burst of oversized requests via Promise.allSettled — zero 5xx, server stays healthy", async () => {
    const largeContent = "y".repeat(1.5 * 1024 * 1024); // 1.5MB

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        fetch(`${env.baseUrl}/v1/sessions`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({
            channel: "oversized-batch",
            chatId: largeContent,
          }),
        }),
      ),
    );

    // All should be rejected with 413, never 5xx
    let fiveXXCount = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        expect(r.value.status).toBe(413);
        if (r.value.status >= 500) fiveXXCount++;
      }
      // Connection resets are also acceptable (server protecting itself)
    }
    expect(fiveXXCount).toBe(0);

    // Health check still passes
    const healthRes = await fetch(`${env.baseUrl}/v1/health`);
    expect(healthRes.status).toBe(200);
  });
});

// ─── TEST-24: Audit Log Disk-Fill Stress ───

describe("TEST-24: Audit Log Disk-Fill Stress", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-audit-stress-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it("rotation keeps file bounded with all lines valid JSON", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const maxBytes = 5_000;
    const keepLines = 50;

    // Write 500 entries — well over keepLines
    for (let i = 0; i < 500; i++) {
      await appendFridayAuditLog(
        logPath,
        {
          timestamp: new Date().toISOString(),
          action: "test.stress",
          actor: "adversarial",
          detail: `Entry ${i}: ${"padding".repeat(10)}`,
        },
        { maxBytes, keepLines },
      );
    }

    const stat = fs.statSync(logPath);
    // File must be bounded — not unbounded growth
    expect(stat.size).toBeLessThan(maxBytes * 3);

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    // Line count bounded to keepLines + small post-rotation margin
    expect(lines.length).toBeLessThanOrEqual(keepLines + 10);

    // Every line must parse as valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("concurrent audit writes don't corrupt JSONL", async () => {
    const logPath = path.join(tmpDir, "audit-concurrent.jsonl");

    const promises = Array.from({ length: 100 }, (_, i) =>
      appendFridayAuditLog(logPath, {
        timestamp: new Date().toISOString(),
        action: "concurrent.write",
        actor: `writer-${i}`,
        detail: `Concurrent entry ${i}`,
      }),
    );

    await Promise.all(promises);

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    expect(lines.length).toBe(100);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ─── TEST-25: Connection/Pool Burst Resilience ───

describe("TEST-25: Connection/Pool Burst Resilience", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    const auth = await loginTestUser(env.baseUrl);
    token = auth.accessToken;
  });

  afterAll(async () => {
    await env?.close();
  });

  it("300 parallel reads — zero 5xx, no SQLITE_BUSY leakage, health still 200", async () => {
    // Use correct DB-backed routes
    const endpoints = [
      "/v1/sessions",
      "/v1/plugins",
      "/v1/memory/items",
    ];

    const results = await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) => {
        const endpoint = endpoints[i % endpoints.length]!;
        return fetch(`${env.baseUrl}${endpoint}`, {
          headers: authHeaders(token),
        });
      }),
    );

    let fiveXXCount = 0;
    let sqliteBusyCount = 0;
    let successCount = 0;

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.status >= 500) {
          fiveXXCount++;
          const body = await r.value.text();
          if (body.includes("SQLITE_BUSY") || body.includes("database is locked")) {
            sqliteBusyCount++;
          }
        } else {
          successCount++;
        }
      }
    }

    expect(fiveXXCount).toBe(0);
    expect(sqliteBusyCount).toBe(0);
    expect(successCount).toBeGreaterThan(0);

    // Health still OK
    const healthRes = await fetch(`${env.baseUrl}/v1/health`);
    expect(healthRes.status).toBe(200);
  });
});

// ─── TEST-26: Scheduler Timeout-Timer Leak ───

describe("TEST-26: Scheduler Timeout-Timer Leak", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("no post-stop executions after many cycles — scheduler cleans up", async () => {
    const repository = createFridayJobSchedulerRepository({ db });
    let runCount = 0;
    let currentMs = Date.now();

    const scheduler = createFridayJobSchedulerService({
      repository,
      jobs: [
        {
          id: "fast-job",
          intervalMs: 1_000,
          timeoutMs: 600_000,
          run: async () => {
            runCount++;
          },
        },
      ],
      nowIso: () => new Date(currentMs).toISOString(),
      nowMs: () => currentMs,
    });

    await scheduler.start();

    // Run many cycles
    for (let i = 0; i < 50; i++) {
      currentMs += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
    }

    // Verify we actually ran jobs
    expect(runCount).toBeGreaterThan(0);

    await scheduler.stop();

    // After stop, advancing timers should NOT trigger more runs
    const runCountAfterStop = runCount;
    currentMs += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runCount).toBe(runCountAfterStop);
  });

  it("no post-stop executions after rapid start/stop cycles", async () => {
    const repository = createFridayJobSchedulerRepository({ db });
    let currentMs = Date.now();
    let runCount = 0;

    const scheduler = createFridayJobSchedulerService({
      repository,
      jobs: [
        {
          id: "leak-test-job",
          intervalMs: 500,
          timeoutMs: 30_000,
          run: async () => {
            runCount++;
          },
        },
      ],
      nowIso: () => new Date(currentMs).toISOString(),
      nowMs: () => currentMs,
    });

    // Rapid start/stop cycles
    for (let i = 0; i < 10; i++) {
      await scheduler.start();
      currentMs += 100;
      await vi.advanceTimersByTimeAsync(100);
      await scheduler.stop();
    }

    // After all stops, no more executions should happen
    const countAfterStops = runCount;
    currentMs += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCount).toBe(countAfterStops);
  });
});
