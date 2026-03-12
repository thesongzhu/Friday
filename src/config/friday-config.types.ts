export type FridayMirrorMode = "best-effort" | "strict";
export type FridaySqliteSynchronousMode = "NORMAL" | "FULL";

export interface FridayConfig {
  stateDir?: string;
  database: {
    readPoolSize: number;
    busyTimeoutMs: number;
    synchronous: FridaySqliteSynchronousMode;
  };
  telemetry: {
    enabled: boolean;
    fileName: string;
    summaryFileName: string;
  };
  backups: {
    configBackupCount: number;
  };
}

/**
 * @deprecated Phase 8 removed mirror config. This type is retained only
 * for migration-on-load stripping.
 */
export interface FridayDeprecatedMirrorConfig {
  enabled: boolean;
  mode: FridayMirrorMode;
  consistencyCheckOnStartup: boolean;
}

/** Keys that Phase 8 strips on config load. */
export const FRIDAY_DEPRECATED_CONFIG_KEYS = [
  "mirror",
  "mirror.enabled",
  "mirror.mode",
  "mirror.consistencyCheckOnStartup",
] as const;

/**
 * Strips deprecated mirror-related keys from a raw config object.
 * Returns the cleaned object and the list of removed keys.
 */
export function migrateDeprecatedConfigKeys(
  raw: Record<string, unknown>,
): { cleaned: Record<string, unknown>; removedKeys: string[] } {
  const removedKeys: string[] = [];
  const cleaned = { ...raw };
  if ("mirror" in cleaned) {
    removedKeys.push("mirror");
    delete cleaned.mirror;
  }
  return { cleaned, removedKeys };
}

export interface LoadedFridayConfig {
  config: FridayConfig;
  configPath: string;
  exists: boolean;
  rawText?: string;
}

export interface LoadFridayConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export interface WriteFridayConfigOptions {
  configPath?: string;
  backupCount?: number;
  fileMode?: number;
}
