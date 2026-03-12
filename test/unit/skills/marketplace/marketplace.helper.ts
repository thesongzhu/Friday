import Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import type { SkillManifestV2 } from "#skills";

/**
 * Creates an in-memory SQLite database with all V001 schema tables
 * and wraps it in a minimal FridaySqliteLayer for testing.
 */
export function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  // Insert a test user for FK constraints
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (db: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

/** Counter-based ID generator for deterministic tests. */
export function createTestIdGenerator(): () => string {
  let counter = 0;
  return () => `test-id-${String(++counter).padStart(4, "0")}`;
}

/** Deterministic timestamp for tests. */
export const NOW = "2025-06-15T12:00:00.000Z";
export const EARLIER = "2025-06-15T06:00:00.000Z";
export const MUCH_EARLIER = "2025-05-01T00:00:00.000Z";

/** Minimal valid manifest for tests. */
export function createTestManifest(overrides?: Partial<SkillManifestV2>): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Test Author" },
    tags: [],
    runtime: {
      kind: "node",
      entrypoint: "index.js",
      minHubVersion: "0.1.0",
      apiVersion: "1",
      timeoutMsDefault: 30000,
    },
    triggers: {
      intents: ["test"],
      phrases: ["test"],
      channels: [],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: false,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux"],
    },
    inputs: [],
    outputs: [],
    permissions: {
      grants: [
        {
          id: "net",
          resource: "network",
          action: "connect",
          required: true,
          reason: "Needs network access",
        },
      ],
      promptOn: ["network.connect"],
    },
    executionTargets: {
      allowedSatelliteTypes: ["desktop"],
      requiredCapabilities: [],
    },
    ...overrides,
  };
}
