import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
  FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV,
  initializeFridayState,
  verifyFridayRustHubSchemaHandshake,
} from "#state";

const roots: string[] = [];

function tempRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `friday-rust-hub-schema-${tag}-`));
  roots.push(root);
  return root;
}

function createRustHubDb(root: string, version: number): string {
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

describe("Friday Rust hub schema handshake", () => {
  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when the configured Rust hub DB schema matches this build", () => {
    const root = tempRoot("match");
    const dbPath = createRustHubDb(root, FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION);

    const result = verifyFridayRustHubSchemaHandshake({
      stateDir: root,
      env: { [FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV]: dbPath },
    });

    expect(result).toMatchObject({
      status: "ok",
      dbPath,
      expectedVersion: FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
      actualVersion: FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
      source: "env",
    });
  });

  it("skips only when no Rust hub DB is configured or present", () => {
    const root = tempRoot("absent");

    const result = verifyFridayRustHubSchemaHandshake({
      stateDir: root,
      env: {},
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "rust_hub_db_not_present",
      dbPath: join(root, "rust-hub.sqlite"),
      source: "state_dir",
    });
  });

  it("checks the stateDir Rust hub DB when no explicit path is configured", () => {
    const root = tempRoot("state-dir");
    const dbPath = createRustHubDb(root, FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION);

    const result = verifyFridayRustHubSchemaHandshake({
      stateDir: root,
      env: {},
    });

    expect(result).toMatchObject({
      status: "ok",
      dbPath,
      expectedVersion: FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
      actualVersion: FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
      source: "state_dir",
    });
  });

  it("fails closed when a configured Rust hub DB is missing", () => {
    const root = tempRoot("missing");
    const missingPath = join(root, "missing-rust-hub.sqlite");

    expect(() =>
      verifyFridayRustHubSchemaHandshake({
        stateDir: root,
        env: { [FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV]: missingPath },
      }),
    ).toThrow(expect.objectContaining({
      code: "RUST_HUB_SCHEMA_HANDSHAKE_FAILED",
    }));
  });

  it("fails closed when the Rust hub DB schema is not this build's peer", () => {
    const root = tempRoot("mismatch");
    const dbPath = createRustHubDb(root, FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION + 1);

    expect(() =>
      verifyFridayRustHubSchemaHandshake({
        stateDir: root,
        env: { [FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV]: dbPath },
      }),
    ).toThrow(expect.objectContaining({
      code: "RUST_HUB_SCHEMA_VERSION_MISMATCH",
    }));
  });

  it("blocks TypeScript state initialization before opening friday.db on mismatch", () => {
    const root = tempRoot("boot");
    const dbPath = createRustHubDb(root, FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION + 1);

    expect(() =>
      initializeFridayState({
        env: {
          FRIDAY_STATE_DIR: root,
          [FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV]: dbPath,
        },
      }),
    ).toThrow(expect.objectContaining({
      code: "RUST_HUB_SCHEMA_VERSION_MISMATCH",
    }));
    expect(existsSync(join(root, "friday.db"))).toBe(false);
  });

  it("pins the expected version to Rust hub_migrations code_max", () => {
    const schemaPath = resolve("rust-core/crates/friday-storage/src/schema.rs");
    const schema = readFileSync(schemaPath, "utf8");
    const hubBlock = schema.slice(
      schema.indexOf("pub fn hub_migrations()"),
      schema.indexOf("pub fn phone_migrations()"),
    );
    expect(hubBlock).toContain("pub fn hub_migrations()");

    const versions = [...hubBlock.matchAll(/version:\s*(\d+)/gu)]
      .map((match) => Number(match[1]))
      .filter((version) => Number.isInteger(version));
    expect(versions.length).toBeGreaterThan(0);
    expect(FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION).toBe(Math.max(...versions));
  });
});
