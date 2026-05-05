import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { FridaySystemTransportMode } from "../model/friday-system.types.js";

export type FridaySystemCompanionServerMode = "embedded" | "external";
export type FridaySystemNativeCompanionMode = "auto" | "swift" | "node" | "dotnet" | "rust";

export interface ResolveFridaySystemCompanionServerModeInput {
  platform: NodeJS.Platform;
  transportMode: FridaySystemTransportMode;
  explicitServerMode?: string;
  nativeCompanionMode?: FridaySystemNativeCompanionMode;
}

export interface ResolveFridaySystemCompanionAuthTokenInput {
  workspaceRoot: string;
  explicitToken?: string;
  explicitTokenFilePath?: string;
  forceRotate?: boolean;
  randomBytes?: typeof crypto.randomBytes;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveDefaultAuthTokenFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".friday", "run", "system-companion.auth.token");
}

export function resolveFridaySystemCompanionServerMode(
  input: ResolveFridaySystemCompanionServerModeInput,
): FridaySystemCompanionServerMode {
  if (input.explicitServerMode === "external") {
    return "external";
  }
  if (input.transportMode === "named_pipe") {
    return "external";
  }
  if (input.nativeCompanionMode === "dotnet" || input.nativeCompanionMode === "rust") {
    return "external";
  }
  return "embedded";
}

export function resolveFridaySystemCompanionPipeName(
  workspaceRoot: string,
  explicitPipeName?: string,
): string {
  if (explicitPipeName) {
    return explicitPipeName;
  }
  const workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\friday-system-companion-${workspaceHash}`;
}

export function resolveFridaySystemCompanionAuthTokenFilePath(
  workspaceRoot: string,
  explicitTokenFilePath?: string,
): string {
  return explicitTokenFilePath
    ? path.resolve(explicitTokenFilePath)
    : resolveDefaultAuthTokenFilePath(workspaceRoot);
}

async function ensurePrivateRunDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch((error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw err;
    }
  });
}

async function readExistingPrivateToken(tokenFilePath: string): Promise<string | undefined> {
  const existing = await fs.readFile(tokenFilePath, "utf8").catch(() => "");
  const normalizedExisting = normalizeNonEmpty(existing);
  if (!normalizedExisting) {
    return undefined;
  }
  await fs.chmod(tokenFilePath, 0o600).catch((error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw err;
    }
  });
  return normalizedExisting;
}

async function writePrivateToken(
  tokenFilePath: string,
  token: string,
  input: { ensureParentDirectory: boolean },
): Promise<void> {
  if (input.ensureParentDirectory) {
    await ensurePrivateRunDirectory(path.dirname(tokenFilePath));
  }
  await fs.writeFile(tokenFilePath, token, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tokenFilePath, 0o600);
}

export async function resolveFridaySystemCompanionAuthToken(
  input: ResolveFridaySystemCompanionAuthTokenInput,
): Promise<{ token: string; tokenFilePath: string }> {
  const explicitToken = normalizeNonEmpty(input.explicitToken);
  const tokenFilePath = resolveFridaySystemCompanionAuthTokenFilePath(
    input.workspaceRoot,
    input.explicitTokenFilePath,
  );
  const usesDefaultRunTokenPath = tokenFilePath === resolveDefaultAuthTokenFilePath(input.workspaceRoot);
  if (usesDefaultRunTokenPath) {
    await ensurePrivateRunDirectory(path.dirname(tokenFilePath));
  }
  if (explicitToken) {
    await writePrivateToken(tokenFilePath, explicitToken, {
      ensureParentDirectory: usesDefaultRunTokenPath,
    });
    return {
      token: explicitToken,
      tokenFilePath,
    };
  }

  const existing = input.forceRotate ? undefined : await readExistingPrivateToken(tokenFilePath);
  if (existing) {
    return {
      token: existing,
      tokenFilePath,
    };
  }

  const randomBytes = input.randomBytes ?? crypto.randomBytes;
  const generated = randomBytes(32).toString("hex");
  await writePrivateToken(tokenFilePath, generated, {
    ensureParentDirectory: usesDefaultRunTokenPath,
  });
  return {
    token: generated,
    tokenFilePath,
  };
}
