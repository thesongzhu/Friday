import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import JSON5 from "json5";

import { FridayDomainError } from "#errors";

import type {
  FridayConfig,
  LoadedFridayConfig,
  LoadFridayConfigOptions,
  WriteFridayConfigOptions,
} from "./friday-config.types.js";
import { buildDefaultFridayConfig, parseFridayConfig } from "./friday-config.schema.js";
import { resolveFridayConfigPath } from "./friday-config-path.js";
import { rotateFridayConfigBackups } from "./friday-config-backup-rotation.js";

export type ParseFridayJson5Result =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parses raw JSON5 config text without validation. */
export function parseFridayJson5(raw: string): ParseFridayJson5Result {
  try {
    const value = JSON5.parse(raw);
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Loads config from disk, applies Zod validation/defaults, returns typed result. */
export function loadFridayConfig(options?: LoadFridayConfigOptions): LoadedFridayConfig {
  const configPath = options?.configPath ?? resolveFridayConfigPath({ env: options?.env });

  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;
    if (code === "ENOENT") {
      return {
        config: buildDefaultFridayConfig(),
        configPath,
        exists: false,
      };
    }
    throw err;
  }
  const parseResult = parseFridayJson5(rawText);

  if (!parseResult.ok) {
    throw new FridayDomainError("CONFIG_PARSE_ERROR", `Failed to parse config at ${configPath}: ${parseResult.error}`, { httpStatus: 500 });
  }

  const config = parseFridayConfig(parseResult.value);
  return {
    config,
    configPath,
    exists: true,
    rawText,
  };
}

/** Validates and writes config atomically, rotating backups before replacement. */
export async function writeFridayConfig(
  config: FridayConfig,
  options?: WriteFridayConfigOptions,
): Promise<void> {
  const configPath = options?.configPath ?? resolveFridayConfigPath();
  const backupCount = options?.backupCount ?? 3;
  const fileMode = options?.fileMode ?? 0o600;

  // Validate config before writing
  parseFridayConfig(config);

  // Ensure directory exists
  const dir = path.dirname(configPath);
  await fsPromises.mkdir(dir, { recursive: true });

  // Rotate backups
  await rotateFridayConfigBackups(configPath, backupCount);

  // Atomic write: write to temp file, then rename
  const tmpPath = path.join(dir, `.config-${crypto.randomUUID()}.tmp`);
  const content = JSON5.stringify(config, null, 2) + os.EOL;

  await fsPromises.writeFile(tmpPath, content, { mode: fileMode });
  await fsPromises.rename(tmpPath, configPath);
}
