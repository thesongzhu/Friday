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
        fetchJson<FridayTuiHubStatus>(`${baseUrl}/v1/status`),
      );
    },

    listSessions() {
      return safeCall(() =>
        fetchJson<FridayTuiSessionSummary[]>(`${baseUrl}/v1/sessions`),
      );
    },

    listJobs() {
      return safeCall(() =>
        fetchJson<FridayTuiJobSummary[]>(`${baseUrl}/v1/jobs`),
      );
    },

    listPendingPairings() {
      return safeCall(() =>
        fetchJson<FridayTuiPairingSummary[]>(`${baseUrl}/v1/satellites/pairing`),
      );
    },

    approvePairing(satelliteId: string) {
      return safeCall(() =>
        fetchJson<{ token: string }>(`${baseUrl}/v1/satellites/${satelliteId}/pairing/approve`, {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        }),
      );
    },

    rejectPairing(satelliteId: string, reason?: string) {
      return safeCall(() =>
        fetchJson<{ rejectedAt: string }>(`${baseUrl}/v1/satellites/${satelliteId}/pairing/reject`, {
          method: "POST",
          body: JSON.stringify({ reason }),
          headers: { "Content-Type": "application/json" },
        }),
      );
    },

    triggerHeartbeat() {
      return safeCall(() =>
        fetchJson<{ triggered: boolean }>(`${baseUrl}/v1/heartbeat/trigger`, {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  };
}
