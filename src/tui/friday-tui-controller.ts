/**
 * TUI Controller — Orchestrates the TUI lifecycle: processes commands,
 * refreshes state via the API client, and triggers re-renders.
 *
 * @module tui/friday-tui-controller
 */

import type {
  FridayTuiCommand,
  FridayTuiConfig,
  FridayTuiEvent,
  FridayTuiState,
  FridayTuiView,
} from "./friday-tui.types.js";
import { createInitialTuiState, DEFAULT_TUI_CONFIG } from "./friday-tui.types.js";
import type { FridayTuiApiClient } from "./friday-tui-api-client.js";
import type { FridayTuiRenderer } from "./friday-tui-renderer.js";

// ─── Deps ───

export interface FridayTuiControllerDeps {
  readonly apiClient: FridayTuiApiClient;
  readonly renderer: FridayTuiRenderer;
  readonly config?: FridayTuiConfig;
  readonly nowIso: () => string;

  /** Write rendered output to the terminal. */
  readonly write: (text: string) => void;

  /** Subscribe to user input lines (from readline). Returns unsubscribe. */
  readonly onInput: (cb: (line: string) => void) => () => void;

  /** Subscribe to realtime events (SSE/WebSocket). Returns unsubscribe. */
  readonly onRealtimeEvent?: (cb: (event: FridayTuiEvent) => void) => () => void;
}

// ─── Interface ───

export interface FridayTuiController {
  start(): Promise<void>;
  stop(): void;
  getState(): FridayTuiState;
  processCommand(cmd: FridayTuiCommand): Promise<void>;
  processInputLine(line: string): Promise<void>;
  isRunning(): boolean;
}

// ─── Command Parsing ───

export function parseTuiInput(line: string): FridayTuiCommand | null {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed) return null;

  const viewMap: Record<string, FridayTuiView> = {
    d: "dashboard",
    dashboard: "dashboard",
    s: "sessions",
    sessions: "sessions",
    j: "jobs",
    jobs: "jobs",
    p: "pairing",
    pairing: "pairing",
    e: "events",
    events: "events",
    h: "help",
    help: "help",
  };

  if (viewMap[trimmed]) {
    return { kind: "navigate", view: viewMap[trimmed] };
  }

  if (trimmed === "r" || trimmed === "refresh") {
    return { kind: "refresh" };
  }

  if (trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
    return { kind: "quit" };
  }

  if (trimmed === "heartbeat") {
    return { kind: "trigger_heartbeat" };
  }

  if (trimmed.startsWith("approve ")) {
    const satelliteId = line.trim().slice("approve ".length).trim();
    if (satelliteId) return { kind: "approve_pairing", satelliteId };
  }

  if (trimmed.startsWith("reject ")) {
    const rest = line.trim().slice("reject ".length).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) {
      return { kind: "reject_pairing", satelliteId: rest };
    }
    return {
      kind: "reject_pairing",
      satelliteId: rest.slice(0, spaceIdx),
      reason: rest.slice(spaceIdx + 1).trim() || undefined,
    };
  }

  return null;
}

// ─── Factory ───

export function createFridayTuiController(
  deps: FridayTuiControllerDeps,
): FridayTuiController {
  const config = deps.config ?? DEFAULT_TUI_CONFIG;
  let state: FridayTuiState = createInitialTuiState();
  let running = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let unsubInput: (() => void) | null = null;
  let unsubRealtime: (() => void) | null = null;

  function updateState(patch: Partial<FridayTuiState>): void {
    state = { ...state, ...patch };
  }

  function render(): void {
    deps.write(deps.renderer.renderFrame(state));
  }

  async function refresh(): Promise<void> {
    const [hubResult, sessionsResult, jobsResult, pairingsResult] = await Promise.all([
      deps.apiClient.getHubStatus(),
      deps.apiClient.listSessions(),
      deps.apiClient.listJobs(),
      deps.apiClient.listPendingPairings(),
    ]);

    updateState({
      hubStatus: hubResult.ok ? hubResult.data : state.hubStatus,
      sessions: sessionsResult.ok ? sessionsResult.data : state.sessions,
      jobs: jobsResult.ok ? jobsResult.data : state.jobs,
      pairings: pairingsResult.ok ? pairingsResult.data : state.pairings,
      isConnected: hubResult.ok,
      lastRefreshedAt: deps.nowIso(),
      error: hubResult.ok ? null : hubResult.error,
    });
  }

  function addEvent(event: FridayTuiEvent): void {
    const events = [...state.events, event];
    if (events.length > config.maxEvents) {
      events.splice(0, events.length - config.maxEvents);
    }
    updateState({ events });
  }

  const controller: FridayTuiController = {
    async start() {
      if (running) return;
      running = true;

      // Initial fetch
      await refresh();
      render();

      // Periodic refresh
      refreshTimer = setInterval(() => {
        void refresh().then(() => { if (running) render(); });
      }, config.refreshIntervalMs);

      // User input
      unsubInput = deps.onInput((line) => {
        void controller.processInputLine(line);
      });

      // Realtime events
      if (config.realtimeEnabled && deps.onRealtimeEvent) {
        unsubRealtime = deps.onRealtimeEvent((event) => {
          addEvent(event);
          if (running && state.currentView === "events") {
            render();
          }
        });
      }
    },

    stop() {
      running = false;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      if (unsubInput) {
        unsubInput();
        unsubInput = null;
      }
      if (unsubRealtime) {
        unsubRealtime();
        unsubRealtime = null;
      }
    },

    getState() {
      return state;
    },

    async processCommand(cmd: FridayTuiCommand) {
      switch (cmd.kind) {
        case "navigate":
          updateState({ currentView: cmd.view });
          render();
          break;

        case "refresh":
          await refresh();
          render();
          break;

        case "approve_pairing": {
          const result = await deps.apiClient.approvePairing(cmd.satelliteId);
          if (result.ok) {
            addEvent({
              id: `evt-${Date.now()}`,
              type: "pairing.approved",
              message: `Approved satellite ${cmd.satelliteId}`,
              timestamp: deps.nowIso(),
            });
            await refresh();
          } else {
            updateState({ error: result.error });
          }
          render();
          break;
        }

        case "reject_pairing": {
          const result = await deps.apiClient.rejectPairing(cmd.satelliteId, cmd.reason);
          if (result.ok) {
            addEvent({
              id: `evt-${Date.now()}`,
              type: "pairing.rejected",
              message: `Rejected satellite ${cmd.satelliteId}`,
              timestamp: deps.nowIso(),
            });
            await refresh();
          } else {
            updateState({ error: result.error });
          }
          render();
          break;
        }

        case "trigger_heartbeat": {
          const result = await deps.apiClient.triggerHeartbeat();
          if (result.ok) {
            addEvent({
              id: `evt-${Date.now()}`,
              type: "heartbeat.triggered",
              message: "Heartbeat triggered manually",
              timestamp: deps.nowIso(),
            });
          } else {
            updateState({ error: result.error });
          }
          render();
          break;
        }

        case "quit":
          controller.stop();
          break;
      }
    },

    async processInputLine(line: string) {
      const cmd = parseTuiInput(line);
      if (!cmd) return;
      await controller.processCommand(cmd);
    },

    isRunning() {
      return running;
    },
  };

  return controller;
}
