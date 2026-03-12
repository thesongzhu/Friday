import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridaySatelliteNodesService,
  type FridaySatelliteNodesServiceDeps,
  type FridaySatelliteNodeRecord,
} from "../../../src/nodes/friday-satellite-nodes-service.js";

// ─── Helpers ───

function makeSatellite(overrides: Partial<FridaySatelliteNodeRecord> = {}): FridaySatelliteNodeRecord {
  return {
    satelliteId: "sat-001",
    displayName: "Edge Satellite",
    type: "edge",
    pairingStatus: "online",
    lastSeenAt: "2026-02-25T12:00:00Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<FridaySatelliteNodesServiceDeps> = {}): FridaySatelliteNodesServiceDeps {
  return {
    listPairedSatellites: vi.fn().mockResolvedValue([makeSatellite()]),
    getSatellite: vi.fn().mockResolvedValue(makeSatellite()),
    sendCommand: vi.fn().mockResolvedValue({ success: true, response: "ok", durationMs: 42 }),
    ...overrides,
  };
}

// ─── Tests ───

describe("FridaySatelliteNodesService", () => {
  let deps: FridaySatelliteNodesServiceDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("discover", () => {
    it("returns paired satellites as FridayNodeInfo", async () => {
      const service = createFridaySatelliteNodesService(deps);
      const nodes = await service.discover(new AbortController().signal);

      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toEqual({
        nodeId: "sat-001",
        name: "Edge Satellite",
        kind: "edge",
        status: "online",
        lastSeen: "2026-02-25T12:00:00Z",
        metadata: undefined,
      });
    });

    it("maps status correctly — online, offline, revoked, unknown", async () => {
      deps = makeDeps({
        listPairedSatellites: vi.fn().mockResolvedValue([
          makeSatellite({ satelliteId: "s1", pairingStatus: "online" }),
          makeSatellite({ satelliteId: "s2", pairingStatus: "offline" }),
          makeSatellite({ satelliteId: "s3", pairingStatus: "revoked" }),
          makeSatellite({ satelliteId: "s4", pairingStatus: "pending_approval" }),
        ]),
      });

      const service = createFridaySatelliteNodesService(deps);
      const nodes = await service.discover(new AbortController().signal);

      expect(nodes[0].status).toBe("online");
      expect(nodes[1].status).toBe("offline");
      expect(nodes[2].status).toBe("offline"); // revoked → offline
      expect(nodes[3].status).toBe("unknown"); // pending → unknown
    });

    it("handles null lastSeenAt", async () => {
      deps = makeDeps({
        listPairedSatellites: vi.fn().mockResolvedValue([
          makeSatellite({ lastSeenAt: null }),
        ]),
      });

      const service = createFridaySatelliteNodesService(deps);
      const nodes = await service.discover(new AbortController().signal);

      expect(nodes[0].lastSeen).toBeUndefined();
    });
  });

  describe("get", () => {
    it("returns a satellite as FridayNodeInfo", async () => {
      const service = createFridaySatelliteNodesService(deps);
      const node = await service.get("sat-001", new AbortController().signal);

      expect(node).not.toBeNull();
      expect(node!.nodeId).toBe("sat-001");
      expect(node!.name).toBe("Edge Satellite");
    });

    it("returns null when satellite is not found", async () => {
      deps = makeDeps({ getSatellite: vi.fn().mockResolvedValue(null) });
      const service = createFridaySatelliteNodesService(deps);
      const node = await service.get("sat-999", new AbortController().signal);

      expect(node).toBeNull();
    });
  });

  describe("control", () => {
    it("sends a command and returns result", async () => {
      const service = createFridaySatelliteNodesService(deps);
      const result = await service.control("sat-001", "restart", { force: true }, 5000);

      expect(result).toEqual({
        nodeId: "sat-001",
        command: "restart",
        success: true,
        response: "ok",
        error: undefined,
        durationMs: 42,
      });
      expect(deps.sendCommand).toHaveBeenCalledWith("sat-001", "restart", { force: true }, 5000);
    });

    it("propagates command failure", async () => {
      deps = makeDeps({
        sendCommand: vi.fn().mockResolvedValue({
          success: false,
          error: "satellite unreachable",
          durationMs: 1000,
        }),
      });

      const service = createFridaySatelliteNodesService(deps);
      const result = await service.control("sat-001", "ping");

      expect(result.success).toBe(false);
      expect(result.error).toBe("satellite unreachable");
    });
  });
});
