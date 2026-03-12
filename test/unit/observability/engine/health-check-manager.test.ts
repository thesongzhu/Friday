import { describe, it, expect, beforeEach } from "vitest";
import { FridayHealthCheckManager } from "../../../../src/observability/engine/health-check-manager.js";
import type { ComponentHealth } from "../../../../src/observability/engine/health-check-manager.js";

// ─── Test Helpers ───

function makeHealthyCheck(name: string, module: "api" | "rules" | "node-runner" = "api"): () => Promise<ComponentHealth> {
  return async () => ({
    name,
    module,
    status: "healthy",
    dependencies: [],
    lastCheckedAt: new Date().toISOString(),
    checkDurationMs: 5,
  });
}

function makeDegradedCheck(name: string, module: "api" | "rules" = "api"): () => Promise<ComponentHealth> {
  return async () => ({
    name,
    module,
    status: "degraded",
    message: "Some dependencies slow",
    dependencies: [
      {
        name: "database",
        status: "healthy",
        responseTimeMs: 500,
        lastCheckedAt: new Date().toISOString(),
      },
    ],
    lastCheckedAt: new Date().toISOString(),
    checkDurationMs: 510,
  });
}

function makeUnhealthyCheck(name: string): () => Promise<ComponentHealth> {
  return async () => ({
    name,
    module: "api",
    status: "unhealthy",
    message: "Database connection lost",
    dependencies: [
      {
        name: "database",
        status: "unhealthy",
        message: "Connection refused",
        lastCheckedAt: new Date().toISOString(),
      },
    ],
    lastCheckedAt: new Date().toISOString(),
    checkDurationMs: 3000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FridayHealthCheckManager", () => {
  let manager: FridayHealthCheckManager;

  beforeEach(() => {
    manager = new FridayHealthCheckManager();
  });

  // ─── Registration ───

  describe("registration", () => {
    it("registers and lists health checks", () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      manager.registerCheck("rules", "rules", makeHealthyCheck("rules", "rules"));

      const checks = manager.getRegisteredChecks();
      expect(checks).toContain("api");
      expect(checks).toContain("rules");
      expect(checks).toHaveLength(2);
    });

    it("unregisters a health check", () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      expect(manager.unregisterCheck("api")).toBe(true);
      expect(manager.getRegisteredChecks()).toHaveLength(0);
    });

    it("returns false when unregistering non-existent check", () => {
      expect(manager.unregisterCheck("nonexistent")).toBe(false);
    });
  });

  // ─── Single Component Check ───

  describe("checkComponent", () => {
    it("runs a single component check", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      const result = await manager.checkComponent("api");

      expect(result).not.toBeNull();
      expect(result!.name).toBe("api");
      expect(result!.status).toBe("healthy");
    });

    it("returns null for unregistered component", async () => {
      const result = await manager.checkComponent("unknown");
      expect(result).toBeNull();
    });

    it("catches exceptions and reports unhealthy", async () => {
      manager.registerCheck("broken", "api", async () => {
        throw new Error("Check crashed");
      });

      const result = await manager.checkComponent("broken");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("unhealthy");
      expect(result!.message).toBe("Check crashed");
    });

    it("stores the result for later retrieval", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      await manager.checkComponent("api");

      const cached = manager.getLastResult("api");
      expect(cached).not.toBeNull();
      expect(cached!.status).toBe("healthy");
    });
  });

  // ─── System-Wide Check ───

  describe("checkAll", () => {
    it("returns healthy when all components are healthy", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      manager.registerCheck("rules", "rules", makeHealthyCheck("rules", "rules"));

      const health = await manager.checkAll();
      expect(health.status).toBe("healthy");
      expect(health.healthyCount).toBe(2);
      expect(health.degradedCount).toBe(0);
      expect(health.unhealthyCount).toBe(0);
      expect(health.message).toContain("All 2 components healthy");
    });

    it("returns degraded when one component is degraded", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      manager.registerCheck("rules", "rules", makeDegradedCheck("rules", "rules"));

      const health = await manager.checkAll();
      expect(health.status).toBe("degraded");
      expect(health.degradedCount).toBe(1);
      expect(health.healthyCount).toBe(1);
    });

    it("returns unhealthy when one component is unhealthy", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      manager.registerCheck("db", "api", makeUnhealthyCheck("db"));

      const health = await manager.checkAll();
      expect(health.status).toBe("unhealthy");
      expect(health.unhealthyCount).toBe(1);
      expect(health.message).toContain("1/2 components unhealthy");
    });

    it("returns unknown when no checks registered", async () => {
      const health = await manager.checkAll();
      expect(health.status).toBe("unknown");
      expect(health.components).toHaveLength(0);
    });

    it("reports individual component results", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      manager.registerCheck("rules", "rules", makeDegradedCheck("rules", "rules"));

      const health = await manager.checkAll();
      expect(health.components).toHaveLength(2);

      const apiComp = health.components.find((c) => c.name === "api");
      const rulesComp = health.components.find((c) => c.name === "rules");
      expect(apiComp!.status).toBe("healthy");
      expect(rulesComp!.status).toBe("degraded");
    });

    it("runs checks in parallel instead of serially", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const delayMs = 120;

      const makeDelayedCheck = (
        name: string,
        module: "api" | "rules",
      ): () => Promise<ComponentHealth> => {
        return async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(delayMs);
          inFlight--;
          return {
            name,
            module,
            status: "healthy",
            dependencies: [],
            lastCheckedAt: new Date().toISOString(),
            checkDurationMs: delayMs,
          };
        };
      };

      manager.registerCheck("api", "api", makeDelayedCheck("api", "api"));
      manager.registerCheck("rules", "rules", makeDelayedCheck("rules", "rules"));

      const started = Date.now();
      const health = await manager.checkAll();
      const elapsedMs = Date.now() - started;

      expect(maxInFlight).toBeGreaterThan(1);
      expect(elapsedMs).toBeLessThan(200);
      expect(health.components).toHaveLength(2);
    });

    it("marks timed-out checks as unhealthy", async () => {
      manager.registerCheck(
        "slow",
        "api",
        async () => {
          await sleep(80);
          return {
            name: "slow",
            module: "api",
            status: "healthy",
            dependencies: [],
            lastCheckedAt: new Date().toISOString(),
            checkDurationMs: 80,
          };
        },
        20,
      );

      const health = await manager.checkAll();
      const slow = health.components.find((component) => component.name === "slow");

      expect(slow).toBeDefined();
      expect(slow!.status).toBe("unhealthy");
      expect(slow!.message).toContain("timed out");
    });
  });

  // ─── Last Results ───

  describe("getLastResults", () => {
    it("returns all cached results", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      manager.registerCheck("rules", "rules", makeHealthyCheck("rules", "rules"));
      await manager.checkAll();

      const results = manager.getLastResults();
      expect(results.size).toBe(2);
      expect(results.get("api")!.status).toBe("healthy");
    });
  });

  // ─── Factory: createCheck ───

  describe("createCheck", () => {
    it("creates a check with healthy dependencies", async () => {
      const check = FridayHealthCheckManager.createCheck("api", "api", [
        { name: "database", check: async () => ({ ok: true, responseTimeMs: 5 }) },
      ]);

      const result = await check();
      expect(result.status).toBe("healthy");
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].status).toBe("healthy");
    });

    it("creates a degraded check when dependency fails", async () => {
      const check = FridayHealthCheckManager.createCheck("api", "api", [
        { name: "database", check: async () => ({ ok: false, message: "Connection refused" }) },
      ]);

      const result = await check();
      expect(result.status).toBe("degraded");
      expect(result.dependencies[0].status).toBe("unhealthy");
    });

    it("handles dependency check exceptions", async () => {
      const check = FridayHealthCheckManager.createCheck("api", "api", [
        { name: "database", check: async () => { throw new Error("timeout"); } },
      ]);

      const result = await check();
      expect(result.status).toBe("degraded");
      expect(result.dependencies[0].status).toBe("unhealthy");
      expect(result.dependencies[0].message).toBe("timeout");
    });

    it("creates a healthy check with no dependencies", async () => {
      const check = FridayHealthCheckManager.createCheck("api", "api");
      const result = await check();
      expect(result.status).toBe("healthy");
      expect(result.dependencies).toHaveLength(0);
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("clears all checks and results", async () => {
      manager.registerCheck("api", "api", makeHealthyCheck("api"));
      await manager.checkAll();
      manager.reset();

      expect(manager.getRegisteredChecks()).toHaveLength(0);
      expect(manager.getLastResult("api")).toBeNull();
    });
  });
});
