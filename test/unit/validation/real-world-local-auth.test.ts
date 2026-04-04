import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadMintTokenSecret } from "../../../validation/real-world/lib/local-auth.mjs";

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
});
