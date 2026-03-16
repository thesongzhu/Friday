import { describe, expect, it, vi } from "vitest";

import { createFridayAgentTaskStatusTool } from "#agent";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

function signalWithContext(readOnly: boolean): AbortSignal {
  const controller = new AbortController();
  return attachFridayAgentToolExecutionContext(controller.signal, {
    runId: "run-123",
    sessionKey: "ui:command-center:test",
    readOnly,
  });
}

describe("createFridayAgentTaskStatusTool", () => {
  it("returns deterministic status for the current run/session", async () => {
    const getSnapshot = vi.fn(async ({ runId, sessionKey, readOnly }) => ({
      readOnly,
      sessionKey,
      trackedRunId: runId,
      task: "Open Facebook",
      runStatus: "executing",
      phase: "executing",
      elapsedMs: 31_000,
      latestTool: "browser",
      activeSubagents: [
        {
          id: "sub-1",
          childRunId: "child-1",
          childSessionKey: "subagent:child-1",
          status: "running" as const,
          task: "Open Facebook",
          createdAt: "2026-03-15T00:00:00.000Z",
        },
      ],
      blockers: [],
    }));
    const tool = createFridayAgentTaskStatusTool({ getSnapshot });

    const result = await tool.execute({}, signalWithContext(true));

    expect(getSnapshot).toHaveBeenCalledWith({
      runId: "run-123",
      sessionKey: "ui:command-center:test",
      readOnly: true,
    });
    expect(JSON.parse(result.content)).toMatchObject({
      readOnly: true,
      trackedRunId: "run-123",
      latestTool: "browser",
      activeSubagents: [{ id: "sub-1", childRunId: "child-1" }],
    });
  });
});
