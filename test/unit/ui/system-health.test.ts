import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSystemHealth } from "../../../ui/src/hooks/use-system-health";
import { healthApi } from "@/lib/api/health";

vi.mock("@/lib/api/health", () => ({
  healthApi: {
    getCapabilityHealth: vi.fn(),
  },
}));

describe("loadSystemHealth", () => {
  beforeEach(() => {
    vi.mocked(healthApi.getCapabilityHealth).mockReset();
  });

  it("keeps Hub-reported unavailable separate from offline", async () => {
    vi.mocked(healthApi.getCapabilityHealth).mockResolvedValue({
      capabilities: {
        system: {
          healthStatus: "unavailable",
        },
      },
    } as never);

    await expect(loadSystemHealth()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("reports offline only when the health request fails", async () => {
    vi.mocked(healthApi.getCapabilityHealth).mockRejectedValue(new Error("ECONNREFUSED"));

    const health = await loadSystemHealth();

    expect(health.status).toBe("offline");
    expect(health.raw).toBeInstanceOf(Error);
  });
});
