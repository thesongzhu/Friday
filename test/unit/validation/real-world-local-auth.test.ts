import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayTokenValidator } from "#api";
import {
  loadMintTokenSecret,
  mintLocalAdminAccessToken,
} from "../../../validation/real-world/lib/local-auth.mjs";

describe("real-world local auth token secret resolution", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("prefers the token secret file over a repo .env fallback", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-real-world-auth-"));
    const envFilePath = path.join(tempDir, ".env");
    const tokenSecretFile = path.join(tempDir, "token.secret");
    fs.writeFileSync(envFilePath, "FRIDAY_TOKEN_SECRET=stale-dotenv-secret\n", "utf8");
    fs.writeFileSync(tokenSecretFile, "runtime-file-secret\n", "utf8");

    const result = loadMintTokenSecret({
      processEnv: {},
      tokenSecretFile,
      envFilePath,
    });

    expect(result).toEqual({
      secret: "runtime-file-secret",
      source: tokenSecretFile,
    });
  });

  it("still prefers the exported FRIDAY_TOKEN_SECRET env var when present", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-real-world-auth-"));
    const tokenSecretFile = path.join(tempDir, "token.secret");
    fs.writeFileSync(tokenSecretFile, "runtime-file-secret\n", "utf8");

    const result = loadMintTokenSecret({
      processEnv: {
        FRIDAY_TOKEN_SECRET: "process-env-secret",
      },
      tokenSecretFile,
    });

    expect(result).toEqual({
      secret: "process-env-secret",
      source: "FRIDAY_TOKEN_SECRET",
    });
  });

  it("ignores stale repo .env FRIDAY_TOKEN_SECRET when minting a local admin token", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-real-world-auth-"));
    const envFilePath = path.join(tempDir, ".env");
    const tokenSecretFile = path.join(tempDir, "token.secret");
    const stateDbPath = path.join(tempDir, "friday.db");
    fs.writeFileSync(envFilePath, "FRIDAY_TOKEN_SECRET=stale-dotenv-secret\n", "utf8");
    fs.writeFileSync(tokenSecretFile, "runtime-file-secret\n", "utf8");

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT,
          display_name TEXT,
          role TEXT NOT NULL,
          last_login_at TEXT
        );
      `);
      db.prepare(`
        INSERT INTO users (id, email, display_name, role, last_login_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "admin-001",
        "admin@friday.dev",
        "Admin",
        "admin",
        "2026-04-04T04:00:00.000Z",
      );
    } finally {
      db.close();
    }

    const minted = mintLocalAdminAccessToken({
      processEnv: {},
      envFilePath,
      stateDbPath,
      tokenSecretFile,
    });

    expect(minted.metadata.tokenSecretSource).toBe(tokenSecretFile);

    const validator = createFridayTokenValidator({
      tokenSecret: "runtime-file-secret",
      nowMs: () => Date.now(),
      lookupTokenRevocation: () => false,
    });
    const validated = validator.validate(minted.accessToken);

    expect(validated.principal.principalId).toBe("admin-001");
    expect(validated.principal.role).toBe("admin");
  });
});
