import { describe, expect, it } from "vitest";
import { AGENT_OS_NAV_ITEMS, AGENT_OS_NAV_PRIMARY, AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "../../../ui/src/lib/routes/agent-os-nav";

describe("agent os navigation", () => {
  it("primary nav starts with Chat and includes core pages", () => {
    expect(AGENT_OS_NAV_PRIMARY.map((item) => item.path)).toEqual([
      "/chat",
      "/home",
      "/skills",
      "/workflows",
    ]);
  });

  it("advanced nav contains operator and system pages", () => {
    expect(AGENT_OS_NAV_ADVANCED.map((item) => item.path)).toEqual([
      "/assistant",
      "/fleet",
      "/marketplace",
      "/automations",
      "/observability",
      "/command-center",
      "/settings",
    ]);
  });

  it("AGENT_OS_NAV_ITEMS combines primary and advanced", () => {
    expect(AGENT_OS_NAV_ITEMS).toEqual([...AGENT_OS_NAV_PRIMARY, ...AGENT_OS_NAV_ADVANCED]);
  });

  it("maps routes to the correct page titles", () => {
    expect(resolvePageTitle("/")).toBe("Home");
    expect(resolvePageTitle("/chat")).toBe("Chat");
    expect(resolvePageTitle("/home")).toBe("Home");
    expect(resolvePageTitle("/flow/build-new")).toBe("Guided Flow");
    expect(resolvePageTitle("/assistant")).toBe("Assistant");
    expect(resolvePageTitle("/marketplace")).toBe("Marketplace");
    expect(resolvePageTitle("/skills")).toBe("Skills");
    expect(resolvePageTitle("/workflows/123")).toBe("Workflows");
    expect(resolvePageTitle("/fleet")).toBe("Fleet");
    expect(resolvePageTitle("/automations")).toBe("Task Queue");
    expect(resolvePageTitle("/observability")).toBe("Observability");
    expect(resolvePageTitle("/settings")).toBe("Settings");
    expect(resolvePageTitle("/command-center")).toBe("Operator Console");
  });
});
