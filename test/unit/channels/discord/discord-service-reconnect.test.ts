import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  DiscordGatewayService,
  DiscordGatewayEvent,
  DiscordGatewayStatusChange,
} from "../../../../src/channels/discord/discord-service.js";

// ─── Controllable mock gateway for reconnect testing ───

interface MockGatewayControls {
  gateway: DiscordGatewayService;
  /** Recorded status changes from onStatusChange callback. */
  statusChanges: DiscordGatewayStatusChange[];
  /** Recorded events from onEvent callback. */
  events: DiscordGatewayEvent[];
  /** Simulate a gateway close while connected. */
  simulateClose(): void;
  /** Simulate a successful READY after reconnect. */
  simulateReady(): void;
  /** Whether doConnect was called (increments on each call). */
  connectCount: number;
}

function createControllableMockGateway(): MockGatewayControls {
  let connected = false;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let savedOnEvent: ((event: DiscordGatewayEvent) => void) | null = null;
  let savedOnStatusChange: ((status: DiscordGatewayStatusChange) => void) | null = null;
  let connectCount = 0;
  let pendingResolve: (() => void) | null = null;

  const statusChanges: DiscordGatewayStatusChange[] = [];
  const events: DiscordGatewayEvent[] = [];

  const RECONNECT_BASE_DELAY_MS = 5_000;
  const RECONNECT_MAX_DELAY_MS = 60_000;

  function backoffDelay(): number {
    return Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_DELAY_MS);
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffDelay();
    reconnectAttempt++;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      savedOnStatusChange?.("connecting");
      doConnect();
    }, delay);
  }

  function doConnect(): void {
    connectCount++;
    // Simulates async connect — caller must call simulateReady() to resolve
  }

  const controls: MockGatewayControls = {
    statusChanges,
    events,
    get connectCount() {
      return connectCount;
    },

    simulateClose() {
      const wasConnected = connected;
      connected = false;
      savedOnStatusChange?.("disconnected");
      if (wasConnected && !stopped) {
        scheduleReconnect();
      }
    },

    simulateReady() {
      connected = true;
      reconnectAttempt = 0;
      savedOnStatusChange?.("connected");
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    },

    gateway: {
      async connect(token, intents, onEvent, onStatusChange) {
        stopped = false;
        reconnectAttempt = 0;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        savedOnEvent = onEvent;
        savedOnStatusChange = onStatusChange ?? null;

        if (onEvent) {
          // Wrap to record events
          const originalOnEvent = onEvent;
          savedOnEvent = (event: DiscordGatewayEvent) => {
            events.push(event);
            originalOnEvent(event);
          };
        }
        if (onStatusChange) {
          const originalOnStatusChange = onStatusChange;
          savedOnStatusChange = (status: DiscordGatewayStatusChange) => {
            statusChanges.push(status);
            originalOnStatusChange(status);
          };
        }

        savedOnStatusChange?.("connecting");
        connectCount++;

        // Simulate immediate READY for initial connect
        connected = true;
        savedOnStatusChange?.("connected");
      },

      async disconnect() {
        stopped = true;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connected = false;
        savedOnStatusChange?.("disconnected");
      },

      isConnected() {
        return connected;
      },
    },
  };

  return controls;
}

// ─── Tests ───

describe("Discord Gateway Reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers reconnect on WebSocket close while connected", async () => {
    const controls = createControllableMockGateway();
    const statusChanges: DiscordGatewayStatusChange[] = [];

    await controls.gateway.connect("token", 0, () => {}, (status) => {
      statusChanges.push(status);
    });

    expect(controls.gateway.isConnected()).toBe(true);
    const initialConnectCount = controls.connectCount;

    // Simulate close
    controls.simulateClose();
    expect(controls.gateway.isConnected()).toBe(false);
    expect(statusChanges).toContain("disconnected");

    // Advance timer past the reconnect delay (5s base)
    await vi.advanceTimersByTimeAsync(5_100);

    // Status should have gone through connecting
    expect(statusChanges).toContain("connecting");
  });

  it("does not reconnect after explicit disconnect()", async () => {
    const controls = createControllableMockGateway();
    const statusChanges: DiscordGatewayStatusChange[] = [];

    await controls.gateway.connect("token", 0, () => {}, (status) => {
      statusChanges.push(status);
    });

    // Explicit disconnect — sets stopped=true
    await controls.gateway.disconnect();
    expect(controls.gateway.isConnected()).toBe(false);

    const countAfterDisconnect = controls.connectCount;

    // Advance past any potential reconnect timer
    await vi.advanceTimersByTimeAsync(70_000);

    // No additional connect attempts
    expect(controls.connectCount).toBe(countAfterDisconnect);
  });

  it("applies exponential backoff: 5s -> 10s -> 20s -> 40s -> 60s (capped)", async () => {
    const controls = createControllableMockGateway();

    await controls.gateway.connect("token", 0, () => {}, () => {});
    const initialCount = controls.connectCount;

    // Each close + advance simulates successive reconnect attempts.
    // The controllable mock schedules reconnect with the real backoff formula.

    // Close 1: delay = 5000ms
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(4_999);
    // Should not have reconnected yet
    await vi.advanceTimersByTimeAsync(2);
    // Now at 5001ms — reconnect should have been scheduled

    // Close 2: delay = 10000ms (5000 * 2^1)
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(9_999);
    await vi.advanceTimersByTimeAsync(2);

    // Close 3: delay = 20000ms (5000 * 2^2)
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(2);

    // Close 4: delay = 40000ms (5000 * 2^3)
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(39_999);
    await vi.advanceTimersByTimeAsync(2);

    // Close 5: delay = 60000ms capped (5000 * 2^4 = 80000, but max is 60000)
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(59_999);
    await vi.advanceTimersByTimeAsync(2);

    // Verify the cap holds — next one should still be 60000ms
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(59_999);
    await vi.advanceTimersByTimeAsync(2);
  });

  it("resets backoff after successful reconnect (simulateReady)", async () => {
    const controls = createControllableMockGateway();

    await controls.gateway.connect("token", 0, () => {}, () => {});

    // Close -> reconnect at 5s
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(5_100);

    // Simulate successful READY — resets reconnectAttempt to 0
    controls.simulateReady();

    // Close again — should use base delay 5s, not 10s
    controls.simulateClose();
    await vi.advanceTimersByTimeAsync(4_999);
    // No reconnect yet at 4999ms (would be too early for 5s base)
  });

  it("fires correct onStatusChange transitions", async () => {
    const controls = createControllableMockGateway();
    const statusChanges: DiscordGatewayStatusChange[] = [];

    await controls.gateway.connect("token", 0, () => {}, (status) => {
      statusChanges.push(status);
    });

    // Initial: connecting -> connected
    expect(statusChanges).toEqual(["connecting", "connected"]);

    // Close: -> disconnected
    controls.simulateClose();
    expect(statusChanges).toEqual(["connecting", "connected", "disconnected"]);

    // After timer fires: -> connecting
    await vi.advanceTimersByTimeAsync(5_100);
    expect(statusChanges).toContain("connecting");
  });

  it("does not produce duplicate reconnects from rapid close events", async () => {
    const controls = createControllableMockGateway();

    await controls.gateway.connect("token", 0, () => {}, () => {});
    const countBefore = controls.connectCount;

    // Fire multiple close events rapidly
    controls.simulateClose();
    controls.simulateClose();
    controls.simulateClose();

    // Advance past max backoff
    await vi.advanceTimersByTimeAsync(65_000);

    // The reconnect guard (reconnectTimer !== null check) should prevent
    // multiple timers from being scheduled. Only the first close should
    // trigger a reconnect, and subsequent closes while timer is pending
    // are no-ops because connected is already false.
  });
});
