import { describe, expect, it, vi } from "vitest";
import { createFridayAgentCapabilitiesTool } from "#agent";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

function signalWithContext(readOnly: boolean): AbortSignal {
  const controller = new AbortController();
  return attachFridayAgentToolExecutionContext(controller.signal, {
    runId: "run-1",
    sessionKey: "agent:run:run-1",
    readOnly,
  });
}

describe("createFridayAgentCapabilitiesTool", () => {
  it("returns deterministic capability facts for a read-only run", async () => {
    const getSnapshot = vi.fn(async ({ readOnly }: { readOnly: boolean }) => ({
      readOnly,
      messaging: { enabled: true, kinds: ["discord"] },
      mcp: { enabled: false, serverCount: 0 },
      provider: {
        available: true,
        configuredCount: 2,
        mutationBlockedByReadOnly: readOnly,
      },
      browser: { activeMode: "host_chrome_visible", targetBrowser: "Google Chrome" },
      system: { enabled: true },
      desktop: { connected: false },
      companion: { connected: false },
    }));
    const tool = createFridayAgentCapabilitiesTool({ getSnapshot });

    const result = await tool.execute({}, signalWithContext(true));

    expect(getSnapshot).toHaveBeenCalledWith({ readOnly: true });
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.readOnly).toBe(true);
    expect(parsed.messaging).toEqual({ enabled: true, kinds: ["discord"] });
    expect(parsed.mcp).toEqual({ enabled: false, serverCount: 0 });
    expect(parsed.provider).toEqual({
      available: true,
      configuredCount: 2,
      mutationBlockedByReadOnly: true,
    });
  });

  it("defaults readOnly to false when no execution context is attached", async () => {
    const getSnapshot = vi.fn(async ({ readOnly }: { readOnly: boolean }) => ({
      readOnly,
      messaging: { enabled: false, kinds: [] },
      mcp: { enabled: false, serverCount: 0 },
      provider: { available: true, configuredCount: 0, mutationBlockedByReadOnly: readOnly },
      browser: {},
      system: { enabled: false },
      desktop: { connected: false },
      companion: { connected: false },
    }));
    const tool = createFridayAgentCapabilitiesTool({ getSnapshot });

    const result = await tool.execute({}, new AbortController().signal);

    expect(getSnapshot).toHaveBeenCalledWith({ readOnly: false });
    expect(JSON.parse(result.content)).toMatchObject({ readOnly: false });
  });
});
