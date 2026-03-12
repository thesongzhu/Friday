/**
 * Cloud-target env helpers for live E2E.
 *
 * These helpers are intentionally strict: invalid/missing cloud config
 * fails fast before the suite mutates any shared environment.
 */

export type FridayE2eTarget = "local" | "cloud";
export type FridayCloudAuthMode = "access-token" | "email-password" | "local-passphrase";

export interface FridayCloudTokenPair {
  accessToken: string;
  refreshToken?: string;
}

export interface FridayCloudE2eConfig {
  target: "cloud";
  baseUrl: string;
  authMode: FridayCloudAuthMode;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
  password?: string;
  localPassphrase?: string;
  namespace: string;
  allowDestructive: boolean;
  timeoutMs: number;
}

const RAW_TARGET = (process.env.FRIDAY_E2E_TARGET ?? "local").trim().toLowerCase();

export const E2E_TARGET: FridayE2eTarget = RAW_TARGET === "cloud" ? "cloud" : "local";

const CLOUD_AUTH_MODE_SET = new Set<FridayCloudAuthMode>([
  "access-token",
  "email-password",
  "local-passphrase",
]);

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("[Cloud E2E] FRIDAY_E2E_CLOUD_BASE_URL must be non-empty");
  }
  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.origin}${normalizedPath}`;
  } catch {
    throw new Error("[Cloud E2E] FRIDAY_E2E_CLOUD_BASE_URL must be a valid absolute URL");
  }
}

function parseCloudAuthMode(value: string | undefined): FridayCloudAuthMode {
  const raw = (value ?? "access-token").trim().toLowerCase();
  if (!CLOUD_AUTH_MODE_SET.has(raw as FridayCloudAuthMode)) {
    throw new Error(
      "[Cloud E2E] FRIDAY_E2E_CLOUD_AUTH_MODE must be one of: access-token, email-password, local-passphrase",
    );
  }
  return raw as FridayCloudAuthMode;
}

function parseCloudTimeoutMs(value: string | undefined): number {
  if (!value) return 30_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("[Cloud E2E] FRIDAY_E2E_CLOUD_TIMEOUT_MS must be a positive number");
  }
  return Math.floor(parsed);
}

function parseAllowDestructive(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[Cloud E2E] ${name} is required`);
  }
  return value;
}

export function getCloudE2eConfig(): FridayCloudE2eConfig | null {
  if (E2E_TARGET !== "cloud") {
    return null;
  }

  const authMode = parseCloudAuthMode(process.env.FRIDAY_E2E_CLOUD_AUTH_MODE);

  const config: FridayCloudE2eConfig = {
    target: "cloud",
    baseUrl: normalizeBaseUrl(requireEnv("FRIDAY_E2E_CLOUD_BASE_URL")),
    authMode,
    namespace: (process.env.FRIDAY_E2E_CLOUD_NAMESPACE ?? "cloud-e2e").trim() || "cloud-e2e",
    allowDestructive: parseAllowDestructive(process.env.FRIDAY_E2E_CLOUD_ALLOW_DESTRUCTIVE),
    timeoutMs: parseCloudTimeoutMs(process.env.FRIDAY_E2E_CLOUD_TIMEOUT_MS),
  };

  const refreshToken = process.env.FRIDAY_E2E_CLOUD_REFRESH_TOKEN?.trim();
  if (refreshToken) {
    config.refreshToken = refreshToken;
  }

  if (authMode === "access-token") {
    config.accessToken = requireEnv("FRIDAY_E2E_CLOUD_ACCESS_TOKEN").trim();
    return config;
  }

  if (authMode === "email-password") {
    config.email = requireEnv("FRIDAY_E2E_CLOUD_EMAIL").trim();
    config.password = requireEnv("FRIDAY_E2E_CLOUD_PASSWORD");
    return config;
  }

  config.localPassphrase = requireEnv("FRIDAY_E2E_CLOUD_LOCAL_PASSPHRASE");
  return config;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseTokenPair(body: unknown): FridayCloudTokenPair {
  const envelope = body as {
    ok?: boolean;
    data?: {
      accessToken?: string;
      refreshToken?: string;
    };
  };
  if (!envelope?.ok || typeof envelope.data?.accessToken !== "string") {
    throw new Error(`[Cloud E2E] Unexpected login response: ${JSON.stringify(body)}`);
  }
  return {
    accessToken: envelope.data.accessToken,
    refreshToken: envelope.data.refreshToken,
  };
}

export async function ensureCloudTargetReady(
  config: FridayCloudE2eConfig,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${config.baseUrl}/v1/health`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    },
    config.timeoutMs,
  );
  if (!response.ok) {
    throw new Error(
      `[Cloud E2E] Health preflight failed: GET /v1/health returned ${String(response.status)}`,
    );
  }
}

export async function loginCloudAndGetTokenPair(
  baseUrl: string,
  config: FridayCloudE2eConfig,
): Promise<FridayCloudTokenPair> {
  if (config.authMode === "access-token") {
    if (!config.accessToken) {
      throw new Error("[Cloud E2E] access-token mode requires FRIDAY_E2E_CLOUD_ACCESS_TOKEN");
    }
    return {
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
    };
  }

  const loginBody: Record<string, unknown> =
    config.authMode === "email-password"
      ? {
          email: config.email,
          password: config.password,
        }
      : {
          localPassphrase: config.localPassphrase,
        };

  const response = await fetchWithTimeout(
    `${baseUrl}/v1/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loginBody),
    },
    config.timeoutMs,
  );

  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      `[Cloud E2E] Login failed (mode=${config.authMode}) with status ${String(response.status)}: ${JSON.stringify(body)}`,
    );
  }
  return parseTokenPair(body);
}
