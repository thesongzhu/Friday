import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInitialTuiState,
  DEFAULT_TUI_CONFIG,
  type FridayTuiState,
} from "../../../src/tui/friday-tui.types.js";
import {
  createFridayTuiApiClient,
  type FridayTuiApiClientDeps,
} from "../../../src/tui/friday-tui-api-client.js";
import {
  createFridayTuiRenderer,
} from "../../../src/tui/friday-tui-renderer.js";
import {
  parseTuiInput,
  createFridayTuiController,
  type FridayTuiControllerDeps,
} from "../../../src/tui/friday-tui-controller.js";

// ─── Initial State ───

describe("createInitialTuiState", () => {
  it("returns default state", () => {
    const state = createInitialTuiState();
    expect(state.currentView).toBe("dashboard");
    expect(state.hubStatus).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.jobs).toEqual([]);
    expect(state.pairings).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.isConnected).toBe(false);
    expect(state.error).toBeNull();
  });
});

// ─── Default Config ───

describe("DEFAULT_TUI_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_TUI_CONFIG.apiBaseUrl).toBe("http://127.0.0.1:4145");
    expect(DEFAULT_TUI_CONFIG.refreshIntervalMs).toBe(5_000);
    expect(DEFAULT_TUI_CONFIG.maxEvents).toBe(200);
    expect(DEFAULT_TUI_CONFIG.realtimeEnabled).toBe(true);
  });
});

// ─── API Client ───

describe("FridayTuiApiClient", () => {
  function makeApiDeps(overrides: Partial<FridayTuiApiClientDeps> = {}): FridayTuiApiClientDeps {
    return {
      fetchJson: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      baseUrl: "http://localhost:4145",
      ...overrides,
    };
  }

  it("getHubStatus calls correct URL", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, data: { version: "1.0", uptime: 300, activeSessions: 2, runningJobs: 1, connectedSatellites: 1 } });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.getHubStatus();
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith("http://localhost:4145/v1/status", undefined);
  });

  it("listSessions unwraps items into tui summaries", async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: "sess-001",
            key: "discord:acct:chat",
            channel: "discord",
            status: "active",
            createdAt: "2026-02-25T10:00:00Z",
            lastActivityAt: "2026-02-25T10:05:00Z",
          },
        ],
      },
    });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.listSessions();
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith("http://localhost:4145/v1/sessions", undefined);
    expect(result).toEqual({
      ok: true,
      data: [
        {
          sessionId: "sess-001",
          channelId: "discord",
          status: "active",
          createdAt: "2026-02-25T10:00:00Z",
          lastActivityAt: "2026-02-25T10:05:00Z",
        },
      ],
    });
  });

  it("listJobs calls correct URL", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, data: [] });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.listJobs();
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith("http://localhost:4145/v1/jobs", undefined);
  });

  it("listPendingPairings maps current pairing shape", async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          satelliteId: "sat-001",
          displayName: "Edge Node",
          type: "edge",
          pairingCode: "PAIR-1234",
          expiresAt: "2026-02-26T00:00:00Z",
        },
      ],
    });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.listPendingPairings();
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith("http://localhost:4145/v1/satellites/pairing", undefined);
    expect(result).toEqual({
      ok: true,
      data: [
        {
          satelliteId: "sat-001",
          displayName: "Edge Node",
          type: "edge",
          pairingCode: "PAIR-1234",
          status: "pending_approval",
          expiresAt: "2026-02-26T00:00:00Z",
        },
      ],
    });
  });

  it("approvePairing POSTs to correct URL", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, data: { token: "tok-123" } });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.approvePairing("sat-001");
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith(
      "http://localhost:4145/v1/satellites/sat-001/pairing/approve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejectPairing POSTs with reason", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, data: { rejectedAt: "2026-02-25T00:00:00Z" } });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.rejectPairing("sat-001", "not trusted");
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith(
      "http://localhost:4145/v1/satellites/sat-001/pairing/reject",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "not trusted" }),
      }),
    );
  });

  it("triggerHeartbeat POSTs to correct URL", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, data: { triggered: true } });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.triggerHeartbeat();
    expect(result.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith(
      "http://localhost:4145/v1/heartbeat/trigger",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("wraps fetch errors as ok=false result", async () => {
    const fetchJson = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.getHubStatus();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  it("surfaces API envelope errors as ok=false result", async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "FORBIDDEN", message: "Forbidden" },
    });
    const client = createFridayTuiApiClient(makeApiDeps({ fetchJson }));

    const result = await client.listJobs();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("FORBIDDEN");
      expect(result.error).toContain("Forbidden");
    }
  });
});

// ─── Renderer ───

describe("FridayTuiRenderer", () => {
  const renderer = createFridayTuiRenderer();

  it("renderFrame produces output for dashboard view", () => {
    const state = createInitialTuiState();
    const output = renderer.renderFrame(state);
    expect(output).toContain("Friday TUI");
    expect(output).toContain("Dashboard");
    expect(output).toContain("Quick Summary");
  });

  it("renderFrame shows hub status when available", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      hubStatus: {
        version: "2.1.0",
        uptime: 3600,
        activeSessions: 3,
        runningJobs: 2,
        connectedSatellites: 1,
      },
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("v2.1.0");
    expect(output).toContain("60m"); // 3600s → 60m
  });

  it("renderFrame shows loading for null hub status", () => {
    const state = createInitialTuiState();
    const output = renderer.renderFrame(state);
    expect(output).toContain("loading");
  });

  it("renderFrame renders sessions view", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      currentView: "sessions",
      sessions: [
        { sessionId: "sess-001", channelId: "discord", status: "active", createdAt: "2026-02-25T10:00:00Z", lastActivityAt: null },
      ],
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("Sessions");
    expect(output).toContain("sess-001");
    expect(output).toContain("discord");
  });

  it("renderFrame renders empty sessions", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      currentView: "sessions",
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("No sessions");
  });

  it("renderFrame renders jobs view", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      currentView: "jobs",
      jobs: [
        { jobId: "j-001", name: "heartbeat-runner", status: "running", lastRunAt: "2026-02-25T11:59:00Z", nextRunAt: null },
      ],
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("Jobs");
    expect(output).toContain("heartbeat-runner");
  });

  it("renderFrame renders pairing view with commands hint", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      currentView: "pairing",
      pairings: [
        { satelliteId: "sat-001", displayName: "Edge Node", type: "edge", pairingCode: "XYZW-5678", status: "pending", expiresAt: "2026-02-26T00:00:00Z" },
      ],
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("Satellite Pairing");
    expect(output).toContain("Edge Node");
    expect(output).toContain("XYZW-5678");
    expect(output).toContain("approve");
  });

  it("renderFrame renders events view", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      currentView: "events",
      events: [
        { id: "e-1", type: "heartbeat", message: "Heartbeat OK", timestamp: "2026-02-25T12:00:05Z" },
      ],
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("Events");
    expect(output).toContain("heartbeat");
    expect(output).toContain("Heartbeat OK");
  });

  it("renderHelp lists all commands", () => {
    const output = renderer.renderHelp();
    expect(output).toContain("Dashboard");
    expect(output).toContain("Sessions");
    expect(output).toContain("Quit");
    expect(output).toContain("approve");
    expect(output).toContain("heartbeat");
  });

  it("renderStatusBar shows connection status", () => {
    const connected: FridayTuiState = { ...createInitialTuiState(), isConnected: true };
    const disconnected: FridayTuiState = { ...createInitialTuiState(), isConnected: false };

    expect(renderer.renderStatusBar(connected)).toContain("connected");
    expect(renderer.renderStatusBar(disconnected)).toContain("disconnected");
  });

  it("renderFrame shows error message in dashboard", () => {
    const state: FridayTuiState = {
      ...createInitialTuiState(),
      error: "Hub unreachable",
    };
    const output = renderer.renderFrame(state);
    expect(output).toContain("Hub unreachable");
  });
});

// ─── Input Parser ───

describe("parseTuiInput", () => {
  it("parses navigation shortcuts", () => {
    expect(parseTuiInput("d")).toEqual({ kind: "navigate", view: "dashboard" });
    expect(parseTuiInput("s")).toEqual({ kind: "navigate", view: "sessions" });
    expect(parseTuiInput("j")).toEqual({ kind: "navigate", view: "jobs" });
    expect(parseTuiInput("p")).toEqual({ kind: "navigate", view: "pairing" });
    expect(parseTuiInput("e")).toEqual({ kind: "navigate", view: "events" });
    expect(parseTuiInput("h")).toEqual({ kind: "navigate", view: "help" });
  });

  it("parses full view names", () => {
    expect(parseTuiInput("dashboard")).toEqual({ kind: "navigate", view: "dashboard" });
    expect(parseTuiInput("sessions")).toEqual({ kind: "navigate", view: "sessions" });
  });

  it("parses refresh command", () => {
    expect(parseTuiInput("r")).toEqual({ kind: "refresh" });
    expect(parseTuiInput("refresh")).toEqual({ kind: "refresh" });
  });

  it("parses quit commands", () => {
    expect(parseTuiInput("q")).toEqual({ kind: "quit" });
    expect(parseTuiInput("quit")).toEqual({ kind: "quit" });
    expect(parseTuiInput("exit")).toEqual({ kind: "quit" });
  });

  it("parses heartbeat command", () => {
    expect(parseTuiInput("heartbeat")).toEqual({ kind: "trigger_heartbeat" });
  });

  it("parses approve command", () => {
    expect(parseTuiInput("approve sat-001")).toEqual({ kind: "approve_pairing", satelliteId: "sat-001" });
  });

  it("parses reject command with optional reason", () => {
    expect(parseTuiInput("reject sat-001")).toEqual({ kind: "reject_pairing", satelliteId: "sat-001" });
    expect(parseTuiInput("reject sat-001 not authorized")).toEqual({
      kind: "reject_pairing",
      satelliteId: "sat-001",
      reason: "not authorized",
    });
  });

  it("is case-insensitive", () => {
    expect(parseTuiInput("Dashboard")).toEqual({ kind: "navigate", view: "dashboard" });
    expect(parseTuiInput("QUIT")).toEqual({ kind: "quit" });
  });

  it("returns null for empty input", () => {
    expect(parseTuiInput("")).toBeNull();
    expect(parseTuiInput("   ")).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(parseTuiInput("foobar")).toBeNull();
  });
});

// ─── Controller ───

describe("FridayTuiController", () => {
  function makeControllerDeps(overrides: Partial<FridayTuiControllerDeps> = {}): FridayTuiControllerDeps {
    return {
      apiClient: {
        getHubStatus: vi.fn().mockResolvedValue({ ok: true, data: { version: "1.0", uptime: 100, activeSessions: 0, runningJobs: 0, connectedSatellites: 0 } }),
        listSessions: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        listJobs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        listPendingPairings: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        approvePairing: vi.fn().mockResolvedValue({ ok: true, data: { token: "tok" } }),
        rejectPairing: vi.fn().mockResolvedValue({ ok: true, data: { rejectedAt: "2026-02-25T00:00:00Z" } }),
        triggerHeartbeat: vi.fn().mockResolvedValue({ ok: true, data: { triggered: true } }),
      },
      renderer: createFridayTuiRenderer(),
      config: { ...DEFAULT_TUI_CONFIG, refreshIntervalMs: 60_000 }, // long interval to avoid interference
      nowIso: () => "2026-02-25T12:00:00Z",
      write: vi.fn(),
      onInput: vi.fn().mockReturnValue(() => {}),
      ...overrides,
    };
  }

  it("starts with initial state", () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);
    const state = controller.getState();
    expect(state.currentView).toBe("dashboard");
    expect(state.isConnected).toBe(false);
  });

  it("start fetches data and renders", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.start();
    try {
      expect(deps.apiClient.getHubStatus).toHaveBeenCalled();
      expect(deps.write).toHaveBeenCalled();
      expect(controller.getState().isConnected).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it("navigate command changes view", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processCommand({ kind: "navigate", view: "sessions" });
    expect(controller.getState().currentView).toBe("sessions");
  });

  it("refresh command fetches data", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processCommand({ kind: "refresh" });
    expect(deps.apiClient.getHubStatus).toHaveBeenCalled();
    expect(deps.apiClient.listSessions).toHaveBeenCalled();
  });

  it("approve_pairing calls API and adds event", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processCommand({ kind: "approve_pairing", satelliteId: "sat-001" });
    expect(deps.apiClient.approvePairing).toHaveBeenCalledWith("sat-001");
    expect(controller.getState().events.length).toBeGreaterThan(0);
    expect(controller.getState().events[0].type).toBe("pairing.approved");
  });

  it("reject_pairing calls API and adds event", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processCommand({ kind: "reject_pairing", satelliteId: "sat-001", reason: "test" });
    expect(deps.apiClient.rejectPairing).toHaveBeenCalledWith("sat-001", "test");
    expect(controller.getState().events[0].type).toBe("pairing.rejected");
  });

  it("trigger_heartbeat calls API and adds event", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processCommand({ kind: "trigger_heartbeat" });
    expect(deps.apiClient.triggerHeartbeat).toHaveBeenCalled();
    expect(controller.getState().events[0].type).toBe("heartbeat.triggered");
  });

  it("quit command stops controller", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.start();
    await controller.processCommand({ kind: "quit" });
    expect(controller.isRunning()).toBe(false);
  });

  it("processInputLine delegates to processCommand", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processInputLine("s");
    expect(controller.getState().currentView).toBe("sessions");
  });

  it("processInputLine ignores unknown input", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.processInputLine("unknown-command");
    expect(controller.getState().currentView).toBe("dashboard"); // unchanged
  });

  it("sets error state when API call fails", async () => {
    const deps = makeControllerDeps({
      apiClient: {
        ...makeControllerDeps().apiClient,
        approvePairing: vi.fn().mockResolvedValue({ ok: false, error: "not found" }),
        getHubStatus: vi.fn().mockResolvedValue({ ok: true, data: { version: "1.0", uptime: 100, activeSessions: 0, runningJobs: 0, connectedSatellites: 0 } }),
        listSessions: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        listJobs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        listPendingPairings: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        rejectPairing: vi.fn().mockResolvedValue({ ok: true, data: { rejectedAt: "" } }),
        triggerHeartbeat: vi.fn().mockResolvedValue({ ok: true, data: { triggered: true } }),
      },
    });
    const controller = createFridayTuiController(deps);

    await controller.processCommand({ kind: "approve_pairing", satelliteId: "sat-bad" });
    expect(controller.getState().error).toBe("not found");
  });

  it("start is idempotent", async () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    await controller.start();
    await controller.start(); // should not throw
    expect(controller.isRunning()).toBe(true);
    controller.stop();
  });

  it("stop is idempotent", () => {
    const deps = makeControllerDeps();
    const controller = createFridayTuiController(deps);

    controller.stop();
    controller.stop();
    expect(controller.isRunning()).toBe(false);
  });

  it("subscribes to input on start", async () => {
    const onInput = vi.fn().mockReturnValue(() => {});
    const deps = makeControllerDeps({ onInput });
    const controller = createFridayTuiController(deps);

    await controller.start();
    expect(onInput).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("events buffer caps at maxEvents", async () => {
    const deps = makeControllerDeps({
      config: { ...DEFAULT_TUI_CONFIG, refreshIntervalMs: 60_000, maxEvents: 3 },
    });
    const controller = createFridayTuiController(deps);

    // Trigger 5 heartbeats
    for (let i = 0; i < 5; i++) {
      await controller.processCommand({ kind: "trigger_heartbeat" });
    }

    expect(controller.getState().events.length).toBeLessThanOrEqual(3);
  });
});
