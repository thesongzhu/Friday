/**
 * E2E: Verify that the Friday API server boots and responds to HTTP.
 *
 * Tests both the low-level components (createFridayApiRuntime + createFridayHttpServer)
 * and the high-level runFridayCliLoop (with process.exit mocked via the `exit` dep).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS, createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import { createFridayApiRuntime, createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import { createFridayProviderService } from "#providers";
import { runFridayCliLoop } from "#cli";

// ─── Constants ───

const TOKEN_SECRET = "cli-test-secret";
const NOW = "2025-06-15T10:00:00.000Z";

// ─── In-memory DB ───

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (d: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  };
}

// ─── Free port discovery ───

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ─── ID generator ───

function createIdGenerator(): () => string {
  let counter = 0;
  return () => `tid-${String(++counter).padStart(6, "0")}`;
}

// ─── Tests ───

describe("CLI start runtime (http server boot)", () => {
  let httpServer: FridayHttpServer | null = null;
  let sqlite: FridaySqliteLayer | null = null;

  afterEach(async () => {
    if (httpServer) {
      await httpServer.close().catch(() => {});
      httpServer = null;
    }
    if (sqlite) {
      sqlite.close();
      sqlite = null;
    }
  });

  it("run_loop_starts_http_server", async () => {
    sqlite = createTestDb();
    const idGenerator = createIdGenerator();

    const providerService = createFridayProviderService({
      db: sqlite,
      idGenerator,
      nowIso: () => NOW,
    });

    const apiRuntime = createFridayApiRuntime({
      db: sqlite,
      idGenerator,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      allowPasswordlessLocalLogin: true, // E2E tests use passwordless login
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604_800,
      providerService,
      computeChecksum: (content: string) =>
        crypto.createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test" }),
      invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({ output: payload }),
    });

    const port = await findFreePort();

    httpServer = createFridayHttpServer({
      routes: apiRuntime.routes,
      wsGateway: apiRuntime.wsGateway,
      middleware: apiRuntime.middleware,
      port,
      host: "127.0.0.1",
    });

    await httpServer.listen();

    // Verify routing works: a non-existent path should return exactly 404
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/v1/nonexistent-path`);
    expect(notFoundRes.status).toBe(404);

    // Verify a real route responds with a non-404 status.
    // POST /v1/auth/login is always registered and is public (no auth required).
    const authRes = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(authRes.status).not.toBe(404);

    // GET /v1/auth/me requires auth — should return 401
    const meRes = await fetch(`http://127.0.0.1:${port}/v1/auth/me`);
    expect(meRes.status).toBe(401);
  });

  it("run_loop_graceful_shutdown", async () => {
    sqlite = createTestDb();
    const idGenerator = createIdGenerator();

    const providerService = createFridayProviderService({
      db: sqlite,
      idGenerator,
      nowIso: () => NOW,
    });

    const apiRuntime = createFridayApiRuntime({
      db: sqlite,
      idGenerator,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      allowPasswordlessLocalLogin: true, // E2E tests use passwordless login
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604_800,
      providerService,
      computeChecksum: (content: string) =>
        crypto.createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test" }),
      invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({ output: payload }),
    });

    const port = await findFreePort();

    httpServer = createFridayHttpServer({
      routes: apiRuntime.routes,
      wsGateway: apiRuntime.wsGateway,
      middleware: apiRuntime.middleware,
      port,
      host: "127.0.0.1",
    });

    await httpServer.listen();

    // Confirm it's running — 404 proves the server is responding
    const resBefore = await fetch(`http://127.0.0.1:${port}/v1/nonexistent-path`);
    expect(resBefore.status).toBe(404);

    // Graceful close
    await httpServer.close();
    httpServer = null;

    // Port should be closed — fetch should fail
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/nonexistent-path`).then((r) => r.status),
    ).rejects.toThrow();
  });

  it("run_friday_cli_loop_starts_and_shuts_down", async () => {
    sqlite = createTestDb();
    const idGenerator = createIdGenerator();

    const providerService = createFridayProviderService({
      db: sqlite,
      idGenerator,
      nowIso: () => NOW,
    });

    const apiRuntime = createFridayApiRuntime({
      db: sqlite,
      idGenerator,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      allowPasswordlessLocalLogin: true, // E2E tests use passwordless login
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604_800,
      providerService,
      computeChecksum: (content: string) =>
        crypto.createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test" }),
      invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({ output: payload }),
    });

    const port = await findFreePort();

    // Track exit calls instead of actually exiting
    let exitCode: number | null = null;
    const mockExit = (code: number) => {
      exitCode = code;
    };

    // Build a minimal hub stub that provides apiRuntime
    const stubHub = {
      start: async () => {},
      stop: async () => {},
      status: () => ({ state: "running" as const, skillCount: 0, upSince: NOW }),
      apiRuntime,
    };

    // Start the CLI run loop with mocked exit
    const loopPromise = runFridayCliLoop({
      hub: stubHub as Parameters<typeof runFridayCliLoop>[0]["hub"],
      port,
      host: "127.0.0.1",
      exit: mockExit,
    });

    // Give the server time to start listening
    await new Promise((r) => setTimeout(r, 200));

    // Verify the server is actually responding
    const res = await fetch(`http://127.0.0.1:${port}/v1/auth/me`);
    expect(res.status).toBe(401);

    // Trigger shutdown via SIGINT (the run loop listens for this)
    process.emit("SIGINT", "SIGINT");

    // Wait for the loop promise to resolve
    await loopPromise;

    // Verify exit was called with code 0 (graceful)
    expect(exitCode).toBe(0);
  });

  it("state_dir_creates_files", () => {
    // Verify that when we create a SQLite database with an on-disk path,
    // the file actually gets created. This mirrors what createFridayHub
    // does when given a stateDir.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-test-"));
    const dbPath = path.join(tmpDir, "friday.db");

    try {
      // Use the proper layer factory which handles WAL mode before transactions
      const layer = createFridaySqliteLayer({
        dbPath,
        readPoolSize: 1,
        pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      });

      // The sqlite file should exist
      expect(fs.existsSync(dbPath)).toBe(true);

      // Verify the file has some content (migrations ran)
      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);

      layer.close();
    } finally {
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
