/**
 * TUI Types — State, views, commands, and event types for the terminal UI.
 *
 * @module tui/friday-tui.types
 */

// ─── Views ───

export type FridayTuiView =
  | "dashboard"
  | "sessions"
  | "jobs"
  | "pairing"
  | "events"
  | "help";

// ─── State ───

export interface FridayTuiState {
  readonly currentView: FridayTuiView;
  readonly hubStatus: FridayTuiHubStatus | null;
  readonly sessions: ReadonlyArray<FridayTuiSessionSummary>;
  readonly jobs: ReadonlyArray<FridayTuiJobSummary>;
  readonly pairings: ReadonlyArray<FridayTuiPairingSummary>;
  readonly events: ReadonlyArray<FridayTuiEvent>;
  readonly lastRefreshedAt: string | null;
  readonly isConnected: boolean;
  readonly error: string | null;
}

export interface FridayTuiHubStatus {
  readonly version: string;
  readonly uptime: number;
  readonly activeSessions: number;
  readonly runningJobs: number;
  readonly connectedSatellites: number;
}

export interface FridayTuiSessionSummary {
  readonly sessionId: string;
  readonly channelId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string | null;
}

export interface FridayTuiJobSummary {
  readonly jobId: string;
  readonly name: string;
  readonly status: string;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export interface FridayTuiPairingSummary {
  readonly satelliteId: string;
  readonly displayName: string;
  readonly type: string;
  readonly pairingCode: string;
  readonly status: string;
  readonly expiresAt: string;
}

export interface FridayTuiEvent {
  readonly id: string;
  readonly type: string;
  readonly message: string;
  readonly timestamp: string;
}

// ─── Commands ───

export type FridayTuiCommand =
  | { kind: "navigate"; view: FridayTuiView }
  | { kind: "refresh" }
  | { kind: "approve_pairing"; satelliteId: string }
  | { kind: "reject_pairing"; satelliteId: string; reason?: string }
  | { kind: "trigger_heartbeat" }
  | { kind: "quit" };

// ─── Configuration ───

export interface FridayTuiConfig {
  /** Base URL of the Friday API. */
  readonly apiBaseUrl: string;
  /** Polling interval for refresh (ms). */
  readonly refreshIntervalMs: number;
  /** Maximum events to keep in buffer. */
  readonly maxEvents: number;
  /** Whether to enable realtime event subscription. */
  readonly realtimeEnabled: boolean;
}

export const DEFAULT_TUI_CONFIG: FridayTuiConfig = {
  apiBaseUrl: "http://127.0.0.1:4145",
  refreshIntervalMs: 5_000,
  maxEvents: 200,
  realtimeEnabled: true,
};

// ─── Initial State ───

export function createInitialTuiState(): FridayTuiState {
  return {
    currentView: "dashboard",
    hubStatus: null,
    sessions: [],
    jobs: [],
    pairings: [],
    events: [],
    lastRefreshedAt: null,
    isConnected: false,
    error: null,
  };
}
