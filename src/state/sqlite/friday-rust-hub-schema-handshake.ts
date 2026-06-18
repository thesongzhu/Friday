import { existsSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { FridayDomainError } from "#errors";

export const FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV = "FRIDAY_HUB_AGENT_RUN_DB_PATH";
export const FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION = 39;

export type FridayRustHubSchemaHandshakeStatus = "ok" | "skipped";

export interface FridayRustHubSchemaHandshakeResult {
  status: FridayRustHubSchemaHandshakeStatus;
  dbPath: string;
  expectedVersion: number;
  actualVersion?: number;
  reason?: "rust_hub_db_not_present";
  source: "env" | "state_dir";
}

export interface VerifyFridayRustHubSchemaHandshakeOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: number;
}

function readConfiguredRustHubDbPath(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env[FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV]?.trim();
  return configured && configured.length > 0 ? configured : undefined;
}

function readRustHubSchemaVersion(dbPath: string): number {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version?: unknown } | undefined;
    const version = row?.version;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new FridayDomainError(
        "RUST_HUB_SCHEMA_HANDSHAKE_FAILED",
        "Rust hub schema_version row is missing or invalid; refusing to open the split TypeScript runtime.",
        { httpStatus: 500, details: { dbPath } },
      );
    }
    return version;
  } catch (error) {
    if (error instanceof FridayDomainError) {
      throw error;
    }
    throw new FridayDomainError(
      "RUST_HUB_SCHEMA_HANDSHAKE_FAILED",
      "Rust hub schema handshake failed; refusing to open the split TypeScript runtime.",
      {
        httpStatus: 500,
        details: {
          dbPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  } finally {
    db?.close();
  }
}

export function verifyFridayRustHubSchemaHandshake(
  options: VerifyFridayRustHubSchemaHandshakeOptions,
): FridayRustHubSchemaHandshakeResult {
  const env = options.env ?? process.env;
  const expectedVersion = options.expectedVersion ?? FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION;
  const configuredPath = readConfiguredRustHubDbPath(env);
  const dbPath = configuredPath ?? join(options.stateDir, "rust-hub.sqlite");
  const source: FridayRustHubSchemaHandshakeResult["source"] = configuredPath ? "env" : "state_dir";

  if (!configuredPath && !existsSync(dbPath)) {
    return {
      status: "skipped",
      reason: "rust_hub_db_not_present",
      dbPath,
      expectedVersion,
      source,
    };
  }

  const actualVersion = readRustHubSchemaVersion(dbPath);
  if (actualVersion !== expectedVersion) {
    throw new FridayDomainError(
      "RUST_HUB_SCHEMA_VERSION_MISMATCH",
      `Rust hub schema version mismatch: expected ${expectedVersion}, found ${actualVersion}; refusing to open the split TypeScript runtime.`,
      {
        httpStatus: 500,
        details: {
          dbPath,
          expectedVersion,
          actualVersion,
          source,
        },
      },
    );
  }

  return {
    status: "ok",
    dbPath,
    expectedVersion,
    actualVersion,
    source,
  };
}
