import { describe, expect, it } from "vitest";
import { AGENT_OS_NAV_ITEMS, resolvePageTitle } from "../../../ui/src/lib/routes/agent-os-nav";

describe("agent os navigation", () => {
  it("keeps the shell focused on the assistant-first control flow", () => {
    expect(AGENT_OS_NAV_ITEMS.map((item) => item.path)).toEqual([
      "/assistant",
      "/marketplace",
      "/workflows",
      "/skills",
      "/fleet",
      "/automations",
      "/observability",
      "/settings",
      "/command-center",
    ]);
  });

  it("maps the assistant and deferred legacy routes to the correct titles", () => {
    expect(resolvePageTitle("/")).toBe("Assistant");
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
