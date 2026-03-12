import { z } from "zod";
import { migrateDeprecatedConfigKeys } from "./friday-config.types.js";
import type { FridayConfig } from "./friday-config.types.js";

const FridayDatabaseSchema = z.object({
  readPoolSize: z.number().int().min(1).max(16).default(4),
  busyTimeoutMs: z.number().int().min(100).max(60_000).default(5000),
  synchronous: z.enum(["NORMAL", "FULL"]).default("NORMAL"),
});

const FridayTelemetrySchema = z.object({
  enabled: z.boolean().default(true),
  fileName: z.string().default("migration-telemetry.jsonl"),
  summaryFileName: z.string().default("migration-summary.json"),
});

const FridayBackupsSchema = z.object({
  configBackupCount: z.number().int().min(0).max(20).default(3),
});

export const FridayConfigSchema: z.ZodType<FridayConfig> = z.object({
  stateDir: z.string().optional(),
  database: FridayDatabaseSchema.default({
    readPoolSize: 4,
    busyTimeoutMs: 5000,
    synchronous: "NORMAL",
  }),
  telemetry: FridayTelemetrySchema.default({
    enabled: true,
    fileName: "migration-telemetry.jsonl",
    summaryFileName: "migration-summary.json",
  }),
  backups: FridayBackupsSchema.default({
    configBackupCount: 3,
  }),
});

/** Validates unknown input and returns a fully defaulted FridayConfig.
 *  Strips deprecated keys (e.g. mirror.*) before validation. */
export function parseFridayConfig(input: unknown): FridayConfig {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const { cleaned } = migrateDeprecatedConfigKeys(input as Record<string, unknown>);
    return FridayConfigSchema.parse(cleaned);
  }
  return FridayConfigSchema.parse(input);
}

/** Returns a stable default config used when config file does not exist. */
export function buildDefaultFridayConfig(): FridayConfig {
  return FridayConfigSchema.parse({});
}
