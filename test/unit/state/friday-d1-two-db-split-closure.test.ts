import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import {
  createFridayMemoryService,
  FRIDAY_MEMORY_ERROR_CODES,
} from "#memory";
import { createFridaySessionService } from "#sessions";
import {
  FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
  FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV,
  initializeFridayState,
} from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";

import { createTestDb, createTestIdGenerator } from "../satellites/_helpers/create-test-db.helper.js";

const roots: string[] = [];
const NOW = "2026-06-18T00:00:00.000Z";

function tempRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `friday-d1-split-${tag}-`));
  roots.push(root);
  return root;
}

function createRustHubSchemaDb(root: string, version: number): string {
  const dbPath = join(root, "rust-hub.sqlite");
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(version);
  } finally {
    db.close();
  }
  return dbPath;
}

function countRows(db: FridaySqliteLayer, table: string): number {
  return db.withReadConnection((conn) => {
    const row = conn.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  });
}

function providerServiceThatMustNotRun(): FridayProviderService {
  return {
    listProviders: vi.fn(),
    getProvider: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn(),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn(() => {
      throw new Error("provider routing must not run while D1 TS memory writes are fail-closed");
    }),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    setBudgetConfig: vi.fn(),
  } as unknown as FridayProviderService;
}

describe("D1 two-DB split closure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on Rust schema mismatch before opening friday.db", () => {
    const root = tempRoot("schema");
    const rustDbPath = createRustHubSchemaDb(root, FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION + 1);

    expect(() =>
      initializeFridayState({
        env: {
          FRIDAY_STATE_DIR: root,
          [FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV]: rustDbPath,
        },
      }),
    ).toThrow(expect.objectContaining({
      code: "RUST_HUB_SCHEMA_VERSION_MISMATCH",
    }));
    expect(existsSync(join(root, "friday.db"))).toBe(false);
  });

  it("keeps legacy TS memory/session write legs 503 without adding split rows", async () => {
    const db = createTestDb();
    try {
      const memoryBefore = countRows(db, "memory_items");
      const sessionsBefore = countRows(db, "sessions");
      const messagesBefore = countRows(db, "session_messages");

      const memoryService = createFridayMemoryService({
        db,
        providerService: providerServiceThatMustNotRun(),
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
        tsMemoryWritesEnabled: false,
      });
      await expect(memoryService.store("d1", "do not split")).rejects.toMatchObject({
        code: FRIDAY_MEMORY_ERROR_CODES.TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED,
        httpStatus: 503,
      });

      const sessionService = createFridaySessionService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
      });
      await expect(sessionService.createSession({ channel: "d1", chatId: "split" })).rejects.toMatchObject({
        code: "TS_RUNTIME_SESSION_RETIRED",
        httpStatus: 503,
      });

      expect(countRows(db, "memory_items")).toBe(memoryBefore);
      expect(countRows(db, "sessions")).toBe(sessionsBefore);
      expect(countRows(db, "session_messages")).toBe(messagesBefore);
    } finally {
      db.close();
    }
  });
});
