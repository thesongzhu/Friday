import { describe, it, expect, vi } from "vitest";
import { createFridayWorkflowEventTriggerBridge } from "#workflows";

describe("FridayWorkflowEventTriggerBridge", () => {
  function createMockTriggerService() {
    return {
      handleEvent: vi.fn().mockResolvedValue(2),
      matchEvent: vi.fn().mockResolvedValue(["run-1"]),
      register: vi.fn(),
      unregister: vi.fn(),
      fireManual: vi.fn(),
      tickCron: vi.fn().mockResolvedValue(0),
      listRegistrations: vi.fn().mockReturnValue([]),
      listAllRegistrations: vi.fn().mockReturnValue([]),
      reloadFromPublishedVersions: vi.fn(),
      syncPublishedVersionTriggers: vi.fn(),
      syncAllPublishedWorkflowTriggers: vi.fn(),
      handleWebhook: vi.fn(),
      setRegistrationEnabled: vi.fn(),
    };
  }

  it("delegates to handleEvent (not legacy matchEvent)", async () => {
    const triggerService = createMockTriggerService();
    const bridge = createFridayWorkflowEventTriggerBridge({ triggerService });

    const result = await bridge.onEvent({
      source: "plugin:slack",
      event: "message.created",
      payload: { text: "hello" },
    });

    expect(result).toBe(2);
    expect(triggerService.handleEvent).toHaveBeenCalledWith({
      source: "plugin:slack",
      event: "message.created",
      payload: { text: "hello" },
    });
    // Must NOT call legacy matchEvent
    expect(triggerService.matchEvent).not.toHaveBeenCalled();
  });

  it("returns 0 when no triggers match", async () => {
    const triggerService = createMockTriggerService();
    triggerService.handleEvent.mockResolvedValue(0);
    const bridge = createFridayWorkflowEventTriggerBridge({ triggerService });

    const result = await bridge.onEvent({
      source: "hub",
      event: "unknown",
      payload: {},
    });

    expect(result).toBe(0);
  });

  it("passes full payload through to trigger service", async () => {
    const triggerService = createMockTriggerService();
    const bridge = createFridayWorkflowEventTriggerBridge({ triggerService });

    const payload = { userId: "u1", action: "deploy", metadata: { version: "1.0" } };
    await bridge.onEvent({
      source: "ci",
      event: "deploy.complete",
      payload,
    });

    expect(triggerService.handleEvent).toHaveBeenCalledWith({
      source: "ci",
      event: "deploy.complete",
      payload,
    });
  });
});
