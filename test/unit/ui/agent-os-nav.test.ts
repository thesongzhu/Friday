import { describe, expect, it } from "vitest";
import { AGENT_OS_NAV_ITEMS, AGENT_OS_NAV_PRIMARY, AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "../../../ui/src/lib/routes/agent-os-nav";

describe("agent os navigation", () => {
  it("primary nav reflects the task-first shell surfaces", () => {
    expect(AGENT_OS_NAV_PRIMARY.map((item) => item.path)).toEqual([
      "/home",
      "/chat",
      "/packs",
      "/assistant",
    ]);
  });

  it("advanced nav contains operator and system pages", () => {
    expect(AGENT_OS_NAV_ADVANCED.map((item) => item.path)).toEqual([
      "/channels",
      "/skills",
      "/workflows",
      "/automations",
      "/memory",
      "/mcp",
      "/usage",
      "/sessions",
    ]);
  });

  it("AGENT_OS_NAV_ITEMS combines primary and advanced", () => {
    expect(AGENT_OS_NAV_ITEMS).toEqual([...AGENT_OS_NAV_PRIMARY, ...AGENT_OS_NAV_ADVANCED]);
  });

  it("maps routes to the correct page titles", () => {
    expect(resolvePageTitle("/")).toEqual({ zh: "首页", en: "Home" });
    expect(resolvePageTitle("/chat")).toEqual({ zh: "聊天", en: "Chat" });
    expect(resolvePageTitle("/home")).toEqual({ zh: "首页", en: "Home" });
    expect(resolvePageTitle("/flow/build-new")).toEqual({ zh: "引导流程", en: "Guided Flow" });
    expect(resolvePageTitle("/assistant")).toEqual({ zh: "助手", en: "Assistant" });
    expect(resolvePageTitle("/marketplace")).toEqual({ zh: "资产市场", en: "Marketplace" });
    expect(resolvePageTitle("/skills")).toEqual({ zh: "能力包", en: "Skills" });
    expect(resolvePageTitle("/workflows/123")).toEqual({ zh: "自动化", en: "Workflows" });
    expect(resolvePageTitle("/fleet")).toEqual({ zh: "执行节点", en: "Fleet" });
    expect(resolvePageTitle("/automations")).toEqual({ zh: "任务队列", en: "Task Queue" });
    expect(resolvePageTitle("/memory")).toEqual({ zh: "记忆", en: "Memory" });
    expect(resolvePageTitle("/observability")).toEqual({ zh: "可观测性", en: "Observability" });
    expect(resolvePageTitle("/settings")).toEqual({ zh: "设置", en: "Settings" });
    expect(resolvePageTitle("/command-center")).toEqual({ zh: "操作控制台", en: "Operator Console" });
    expect(resolvePageTitle("/sessions")).toEqual({ zh: "会话", en: "Sessions" });
    expect(resolvePageTitle("/mcp")).toEqual({ zh: "MCP 服务", en: "MCP Servers" });
    expect(resolvePageTitle("/usage")).toEqual({ zh: "用量与成本", en: "Usage & Cost" });
  });
});
