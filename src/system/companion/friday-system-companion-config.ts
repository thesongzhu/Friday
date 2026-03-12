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
  randomBytes?: typeof crypto.randomBytes;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
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
    : path.join(workspaceRoot, ".friday", "run", "system-companion.auth.token");
}

export async function resolveFridaySystemCompanionAuthToken(
  input: ResolveFridaySystemCompanionAuthTokenInput,
): Promise<{ token: string; tokenFilePath: string }> {
  const explicitToken = normalizeNonEmpty(input.explicitToken);
  const tokenFilePath = resolveFridaySystemCompanionAuthTokenFilePath(
    input.workspaceRoot,
    input.explicitTokenFilePath,
  );
  if (explicitToken) {
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, explicitToken, { encoding: "utf8", mode: 0o600 });
    return {
      token: explicitToken,
      tokenFilePath,
    };
  }

  const existing = await fs.readFile(tokenFilePath, "utf8").catch(() => "");
  const normalizedExisting = normalizeNonEmpty(existing);
  if (normalizedExisting) {
    return {
      token: normalizedExisting,
      tokenFilePath,
    };
  }

  const randomBytes = input.randomBytes ?? crypto.randomBytes;
  const generated = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
  await fs.writeFile(tokenFilePath, generated, { encoding: "utf8", mode: 0o600 });
  return {
    token: generated,
    tokenFilePath,
  };
}
