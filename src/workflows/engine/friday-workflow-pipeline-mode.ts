export type FridayPipelineMode = "shadow" | "warn" | "enforce";

export interface FridayPipelineRuntimeConfig {
  enabled: boolean;
  mode: FridayPipelineMode;
}

export interface FridayPipelineRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  retryBudgetMax: number;
  circuitBreakerThreshold: number;
}

type WarnFn = (message: string) => void;

const FRIDAY_PIPELINE_MODE_VALUES = new Set<FridayPipelineMode>([
  "shadow",
  "warn",
  "enforce",
]);

const DEFAULT_PIPELINE_RETRY_CONFIG: FridayPipelineRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  retryBudgetMax: 10,
  circuitBreakerThreshold: 5,
};

function parsePipelineEnabled(raw: string | undefined): boolean {
  if (!raw) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "off" || normalized === "no") {
    return false;
  }
  return true;
}

function parsePipelineMode(
  raw: string | undefined,
  warn: WarnFn,
): FridayPipelineMode {
  if (!raw) {
    return "enforce";
  }
  const normalized = raw.trim().toLowerCase();
  if (FRIDAY_PIPELINE_MODE_VALUES.has(normalized as FridayPipelineMode)) {
    return normalized as FridayPipelineMode;
  }
  warn(
    `[friday] Invalid FRIDAY_PIPELINE_MODE=\"${raw}\"; falling back to \"enforce\"`,
  );
  return "enforce";
}

export function resolveFridayPipelineRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: WarnFn = (message) => console.warn(message),
): FridayPipelineRuntimeConfig {
  return {
    enabled: parsePipelineEnabled(env.FRIDAY_PIPELINE_ENABLE),
    mode: parsePipelineMode(env.FRIDAY_PIPELINE_MODE, warn),
  };
}

function parsePositiveInteger(
  raw: string | undefined,
  envName: string,
  fallback: number,
  warn: WarnFn,
): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  warn(
    `[friday] Invalid ${envName}="${raw}"; falling back to ${fallback}`,
  );
  return fallback;
}

export function resolveFridayPipelineRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: Partial<FridayPipelineRetryConfig> = {},
  warn: WarnFn = (message) => console.warn(message),
): FridayPipelineRetryConfig {
  const fallback = {
    ...DEFAULT_PIPELINE_RETRY_CONFIG,
    ...defaults,
  };

  return {
    maxAttempts: parsePositiveInteger(
      env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS,
      "FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS",
      fallback.maxAttempts,
      warn,
    ),
    baseDelayMs: parsePositiveInteger(
      env.FRIDAY_PIPELINE_RETRY_BASE_DELAY_MS,
      "FRIDAY_PIPELINE_RETRY_BASE_DELAY_MS",
      fallback.baseDelayMs,
      warn,
    ),
    retryBudgetMax: parsePositiveInteger(
      env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX,
      "FRIDAY_PIPELINE_RETRY_BUDGET_MAX",
      fallback.retryBudgetMax,
      warn,
    ),
    circuitBreakerThreshold: parsePositiveInteger(
      env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD,
      "FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD",
      fallback.circuitBreakerThreshold,
      warn,
    ),
  };
}
