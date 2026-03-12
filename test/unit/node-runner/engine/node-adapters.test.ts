import { describe, it, expect, vi } from "vitest";

import { ToolNodeAdapter } from "../../../../src/node-runner/engine/tool-node-adapter.js";
import { AgentNodeAdapter } from "../../../../src/node-runner/engine/agent-node-adapter.js";

import type { FridayNodeExecutionContext } from "../../../../src/node-runner/model/friday-node-runner.types.js";
import type { FridayWorkflowNode } from "../../../../src/workflows/model/friday-workflow-graph.types.js";

function createContext(node: FridayWorkflowNode): FridayNodeExecutionContext {
  return {
    executionId: "exec-1",
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: node.id,
    attemptNumber: 1,
    node,
    inputData: { prompt: "hello", temperature: 0.2 },
    startedAt: "2026-02-24T00:00:00.000Z",
    metadata: {},
  };
}

describe("built-in node adapters", () => {
  it("ToolNodeAdapter loads config and returns pass-through output", async () => {
    const adapter = new ToolNodeAdapter();
    const context = createContext({
      id: "tool-node",
      type: "action",
      label: "Tool",
      config: { actionType: "tool", toolName: "http.fetch" },
    });

    const config = await adapter.load(context);
    const output = await adapter.execute(context, config, { url: "https://example.com" });

    expect(config).toEqual({ actionType: "tool", toolName: "http.fetch" });
    expect(adapter.validateInput(context, config).valid).toBe(true);
    expect(adapter.validateOutput(context, output).valid).toBe(true);
    expect(output).toEqual({ url: "https://example.com" });
  });

  it("AgentNodeAdapter loads config and returns pass-through output", async () => {
    const adapter = new AgentNodeAdapter();
    const context = createContext({
      id: "agent-node",
      type: "ai",
      label: "Agent",
      config: { model: "gpt-5-mini", temperature: 0.1 },
    });

    const config = await adapter.load(context);
    const output = await adapter.execute(context, config, { prompt: "summarize this" });

    expect(config).toEqual({ model: "gpt-5-mini", temperature: 0.1 });
    expect(adapter.validateInput(context, config).valid).toBe(true);
    expect(adapter.validateOutput(context, output).valid).toBe(true);
    expect(output).toEqual({ prompt: "summarize this" });
  });

  it("ToolNodeAdapter calls injected toolExecutor when provided", async () => {
    const toolExecutor = vi.fn().mockResolvedValue({ result: "from-tool-executor" });
    const adapter = new ToolNodeAdapter({ toolExecutor });
    const context = createContext({
      id: "tool-node",
      type: "action",
      label: "Tool",
      config: { actionType: "tool", toolName: "http.fetch" },
    });
    const signal = new AbortController().signal;
    const input = { url: "https://example.com/api" };

    const config = await adapter.load(context, signal);
    const output = await adapter.execute(context, config, input, signal);

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor).toHaveBeenCalledWith(context, config, input, signal);
    expect(output).toEqual({ result: "from-tool-executor" });
  });

  it("AgentNodeAdapter calls injected agentExecutor when provided", async () => {
    const agentExecutor = vi.fn().mockResolvedValue({ completion: "from-agent-executor" });
    const adapter = new AgentNodeAdapter({ agentExecutor });
    const context = createContext({
      id: "agent-node",
      type: "ai",
      label: "Agent",
      config: { model: "gpt-5-mini", temperature: 0.1 },
    });
    const signal = new AbortController().signal;
    const input = { prompt: "summarize this thread" };

    const config = await adapter.load(context, signal);
    const output = await adapter.execute(context, config, input, signal);

    expect(agentExecutor).toHaveBeenCalledTimes(1);
    expect(agentExecutor).toHaveBeenCalledWith(context, config, input, signal);
    expect(output).toEqual({ completion: "from-agent-executor" });
  });

  it("adapters reject work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));

    const tool = new ToolNodeAdapter();
    const agent = new AgentNodeAdapter();
    const toolContext = createContext({
      id: "tool-node",
      type: "action",
      label: "Tool",
      config: { actionType: "tool" },
    });
    const agentContext = createContext({
      id: "agent-node",
      type: "ai",
      label: "Agent",
      config: { model: "gpt-5-mini" },
    });

    await expect(tool.load(toolContext, controller.signal)).rejects.toThrow("user cancelled");
    await expect(agent.load(agentContext, controller.signal)).rejects.toThrow("user cancelled");
  });
});
