/**
 * TUI API Client — Typed HTTP client for the Friday hub API, used by the
 * TUI controller to fetch status, sessions, jobs, and pairing data.
 *
 * @module tui/friday-tui-api-client
 */

import type {
  FridayTuiHubStatus,
  FridayTuiJobSummary,
  FridayTuiPairingSummary,
  FridayTuiSessionSummary,
} from "./friday-tui.types.js";

// ─── Deps ───

export interface FridayTuiApiClientDeps {
  /** Perform an HTTP request and return parsed JSON. */
  readonly fetchJson: <T>(url: string, init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  }) => Promise<T>;
  readonly baseUrl: string;
}

interface FridayApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

interface FridaySessionListEnvelope {
  items?: Array<{
    id: string;
    key: string;
    channel: string;
    status: string;
    createdAt: string;
    lastActivityAt?: string | null;
  }>;
}

interface FridaySatellitePairingEnvelope {
  requestId?: string;
  satelliteId: string;
  displayName: string;
  type: string;
  pairingCode: string;
  status?: string;
  expiresAt: string;
}

// ─── Result ───

export type FridayTuiApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ─── Interface ───

export interface FridayTuiApiClient {
  getHubStatus(): Promise<FridayTuiApiResult<FridayTuiHubStatus>>;
  listSessions(): Promise<FridayTuiApiResult<FridayTuiSessionSummary[]>>;
  listJobs(): Promise<FridayTuiApiResult<FridayTuiJobSummary[]>>;
  listPendingPairings(): Promise<FridayTuiApiResult<FridayTuiPairingSummary[]>>;
  approvePairing(satelliteId: string): Promise<FridayTuiApiResult<{ token: string }>>;
  rejectPairing(satelliteId: string, reason?: string): Promise<FridayTuiApiResult<{ rejectedAt: string }>>;
  triggerHeartbeat(): Promise<FridayTuiApiResult<{ triggered: boolean }>>;
}

// ─── Factory ───

export function createFridayTuiApiClient(
  deps: FridayTuiApiClientDeps,
): FridayTuiApiClient {
  const { fetchJson, baseUrl } = deps;

  async function requestData<T>(
    path: string,
    init?: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const response = await fetchJson<FridayApiEnvelope<T>>(`${baseUrl}${path}`, init);
    if (!response || typeof response !== "object") {
      throw new Error(`Invalid API response from ${path}`);
    }
    if (response.ok !== true) {
      const code = typeof response.error?.code === "string" ? response.error.code : "INTERNAL_ERROR";
      const message = typeof response.error?.message === "string"
        ? response.error.message
        : `Request failed for ${path}`;
      throw new Error(`${code}: ${message}`);
    }
    return response.data as T;
  }

  async function safeCall<T>(fn: () => Promise<T>): Promise<FridayTuiApiResult<T>> {
    try {
      const data = await fn();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    getHubStatus() {
      return safeCall(() =>
        requestData<FridayTuiHubStatus>("/v1/status"),
      );
    },

    listSessions() {
      return safeCall(async () => {
        const response = await requestData<FridaySessionListEnvelope>("/v1/sessions");
        return (response.items ?? []).map((session) => ({
          sessionId: session.id,
          channelId: session.channel,
          status: session.status,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt ?? null,
        }));
      });
    },

    listJobs() {
      return safeCall(() =>
        requestData<FridayTuiJobSummary[]>("/v1/jobs"),
      );
    },

    listPendingPairings() {
      return safeCall(async () => {
        const response = await requestData<FridaySatellitePairingEnvelope[]>("/v1/satellites/pairing");
        return response.map((pairing) => ({
          satelliteId: pairing.satelliteId,
          displayName: pairing.displayName,
          type: pairing.type,
          pairingCode: pairing.pairingCode,
          status: pairing.status ?? "pending_approval",
          expiresAt: pairing.expiresAt,
        }));
      });
    },

    approvePairing(satelliteId: string) {
      return safeCall(() =>
        requestData<{ token: string }>(`/v1/satellites/${satelliteId}/pairing/approve`, {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        }),
      );
    },

    rejectPairing(satelliteId: string, reason?: string) {
      return safeCall(() =>
        requestData<{ rejectedAt: string }>(`/v1/satellites/${satelliteId}/pairing/reject`, {
          method: "POST",
          body: JSON.stringify({ reason }),
          headers: { "Content-Type": "application/json" },
        }),
      );
    },

    triggerHeartbeat() {
      return safeCall(() =>
        requestData<{ triggered: boolean }>(`/v1/heartbeat/trigger`, {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  };
}
