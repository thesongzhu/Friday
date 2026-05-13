import { describe, expect, it } from "vitest";

import type { FridayAgentToolDefinition } from "../../../../src/agent/model/friday-agent.types.js";
import { resolveFridayAgentToolRouting } from "../../../../src/agent/runtime/friday-agent-tool-routing.js";

function tool(name: string): FridayAgentToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
  };
}

const tools = [
  "read",
  "write",
  "edit",
  "exec",
  "web_fetch",
  "web_search",
  "skills_list",
  "skill_run",
  "task_status",
  "capabilities",
].map(tool);

describe("resolveFridayAgentToolRouting", () => {
  it("routes explicit workspace read-tool tasks to code tools before web keyword matching", () => {
    const routing = resolveFridayAgentToolRouting({
      task: "Call the `read` tool with path `README.md` from the current workspace root, then answer with the top H1 heading only. Do not use web search for this workspace file.",
      tools,
    });

    expect(routing.profile).toBe("code");
    expect(routing.selectedToolPacks).toEqual(["code"]);
    expect(routing.selectedToolNames).toEqual(["read"]);
    expect(routing.deferredToolNames).toEqual([]);
  });

  it("keeps ordinary web lookup tasks on the web profile", () => {
    const routing = resolveFridayAgentToolRouting({
      task: "Search the latest TypeScript release notes and include source URLs.",
      tools,
    });

    expect(routing.profile).toBe("web");
    expect(routing.selectedToolPacks).toEqual(["web"]);
    expect(routing.selectedToolNames).toContain("web_search");
    expect(routing.selectedToolNames).not.toContain("read");
  });
});
