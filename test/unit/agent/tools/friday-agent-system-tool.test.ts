import { describe, expect, it, vi } from "vitest";
import { createFridayAgentSystemTool } from "../../../../src/agent/tools/friday-agent-system-tool.js";
import type { FridaySystemService } from "../../../../src/system/engine/friday-system-service.js";
import type { FridaySystemIntentInput } from "../../../../src/system/model/friday-system.types.js";

function makeSystemService(): FridaySystemService {
  return {
    executeIntent: vi.fn(async (input: FridaySystemIntentInput) => ({
      id: "intent-1",
      action: input.action,
      status: "completed",
      message: "ok",
      createdAt: "2026-05-04T12:00:00.000Z",
      updatedAt: "2026-05-04T12:00:00.000Z",
    })),
  } as unknown as FridaySystemService;
}

describe("friday agent system tool", () => {
  it("does not expose system approval mutation actions to the agent", () => {
    const tool = createFridayAgentSystemTool({ systemService: makeSystemService() });
    const parameters = tool.parameters as {
      properties: Record<string, unknown> & { action: { enum: readonly string[] } };
    };
    const actionProperty = parameters.properties.action;

    expect(actionProperty.enum).not.toContain("approve");
    expect(actionProperty.enum).not.toContain("deny");
    expect(parameters.properties).not.toHaveProperty("actorId");
    expect(parameters.properties).not.toHaveProperty("actorKind");
    expect(parameters.properties).not.toHaveProperty("approvalId");
    expect(parameters.properties).not.toHaveProperty("riskLevel");
    expect(tool.description).not.toContain("approve, deny");
  });

  it("rejects approve and deny actions before calling system service", async () => {
    const systemService = makeSystemService();
    const tool = createFridayAgentSystemTool({ systemService });

    await expect(tool.execute({ action: "approve", target: "clipboard_read" }, new AbortController().signal))
      .resolves.toMatchObject({
        isError: true,
        content: expect.stringContaining("Invalid action"),
      });
    await expect(tool.execute({ action: "deny", target: "clipboard_read" }, new AbortController().signal))
      .resolves.toMatchObject({
        isError: true,
        content: expect.stringContaining("Invalid action"),
      });

    expect(systemService.executeIntent).not.toHaveBeenCalled();
  });

  it("still forwards allowed system actions with runtime-only idempotency keys", async () => {
    const systemService = makeSystemService();
    const tool = createFridayAgentSystemTool({ systemService });

    const result = await tool.execute({
      action: "snapshot",
      actorId: "model-supplied-actor",
      actorKind: "remote",
      idempotencyKey: "run-1:call-1",
      approvalId: "ignored-approval",
      riskLevel: "none",
    }, new AbortController().signal);

    expect(result.isError).toBeUndefined();
    expect(systemService.executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: "snapshot",
      actorId: "agent-runtime",
      actorKind: "agent",
      idempotencyKey: "run-1:call-1",
    }));
    expect(systemService.executeIntent).not.toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "ignored-approval",
    }));
    expect(systemService.executeIntent).not.toHaveBeenCalledWith(expect.objectContaining({
      riskLevel: "none",
    }));
  });

  it("exposes and forwards window focus targets from system snapshots", async () => {
    const systemService = makeSystemService();
    const tool = createFridayAgentSystemTool({ systemService });
    const parameters = tool.parameters as {
      properties: {
        targetKind: { enum: readonly string[] };
        windowId?: unknown;
      };
    };

    const result = await tool.execute({
      action: "focus",
      targetKind: "window",
      windowId: "window:finder:1",
      idempotencyKey: "run-1:call-window-focus",
    }, new AbortController().signal);

    expect(parameters.properties.targetKind.enum).toContain("window");
    expect(parameters.properties.windowId).toBeDefined();
    expect(result.isError).toBeUndefined();
    expect(systemService.executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: "focus",
      targetKind: "window",
      windowId: "window:finder:1",
      actorId: "agent-runtime",
      actorKind: "agent",
    }));
  });
});
