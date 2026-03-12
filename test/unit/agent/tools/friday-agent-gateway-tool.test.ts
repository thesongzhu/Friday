import { describe, it, expect, vi } from "vitest";
import { createFridayAgentGatewayTool } from "#agent";
import type { FridayGatewayService } from "../../../../src/hub/services/friday-gateway-service.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function mockGatewayService(overrides?: Partial<FridayGatewayService>): FridayGatewayService {
  return {
    status: vi.fn().mockResolvedValue({
      healthy: true,
      version: "1.2.3",
      uptime: 86400,
      pid: 1234,
      url: "http://localhost:3141",
    }),
    restart: vi.fn().mockResolvedValue({ success: true, message: "Restarted" }),
    configGet: vi.fn().mockResolvedValue({ key: "port", value: 3141 }),
    configSet: vi.fn().mockResolvedValue({ success: true, key: "port", value: 3142 }),
    update: vi.fn().mockResolvedValue({ success: true, message: "Updated", version: "1.3.0" }),
    validateUrl: vi.fn().mockReturnValue({ valid: true }),
    ...overrides,
  };
}

describe("FridayAgentGatewayTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentGatewayTool({ gatewayService: mockGatewayService() });
    expect(tool.name).toBe("gateway");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("action");
  });

  // ─── Status action ───

  it("returns gateway status", async () => {
    const svc = mockGatewayService();
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute({ action: "status" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      healthy: true,
      version: "1.2.3",
      uptime: 86400,
    });
  });

  // ─── Restart action ───

  it("restarts the gateway", async () => {
    const svc = mockGatewayService();
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute({ action: "restart" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe("Restarted");
  });

  it("returns error when restart fails", async () => {
    const svc = mockGatewayService({
      restart: vi.fn().mockResolvedValue({ success: false, message: "Permission denied" }),
    });
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute({ action: "restart" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied");
  });

  // ─── Config get action ───

  it("gets a config key", async () => {
    const svc = mockGatewayService();
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute(
      { action: "config_get", key: "port" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.key).toBe("port");
    expect(parsed.value).toBe(3141);
  });

  it("returns error for missing config key", async () => {
    const svc = mockGatewayService({
      configGet: vi.fn().mockResolvedValue(null),
    });
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute(
      { action: "config_get", key: "nonexistent" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  // ─── Config set action ───

  it("sets a config key", async () => {
    const svc = mockGatewayService();
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute(
      { action: "config_set", key: "port", value: 3142 },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
  });

  it("returns error when value missing for config_set", async () => {
    const tool = createFridayAgentGatewayTool({ gatewayService: mockGatewayService() });

    const result = await tool.execute(
      { action: "config_set", key: "port" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("value");
  });

  // ─── Update action ───

  it("updates the gateway", async () => {
    const svc = mockGatewayService();
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute({ action: "update" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe("1.3.0");
  });

  // ─── Parameter validation ───

  it("returns error for invalid action", async () => {
    const tool = createFridayAgentGatewayTool({ gatewayService: mockGatewayService() });

    const result = await tool.execute({ action: "destroy" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  it("returns error on missing key for config_get", async () => {
    const tool = createFridayAgentGatewayTool({ gatewayService: mockGatewayService() });

    const result = await tool.execute({ action: "config_get" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("key is required");
  });

  // ─── Error handling ───

  it("returns error when service throws", async () => {
    const svc = mockGatewayService({
      status: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });
    const tool = createFridayAgentGatewayTool({ gatewayService: svc });

    const result = await tool.execute({ action: "status" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Connection refused");
  });
});
