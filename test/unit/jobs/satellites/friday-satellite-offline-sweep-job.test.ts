import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridaySatelliteOfflineSweepJob,
  DEFAULT_OFFLINE_SWEEP_CONFIG,
  type FridaySatelliteOfflineSweepDeps,
} from "../../../../src/jobs/satellites/friday-satellite-offline-sweep-job.js";

// ─── Helpers ───

function makeDeps(overrides: Partial<FridaySatelliteOfflineSweepDeps> = {}): FridaySatelliteOfflineSweepDeps {
  return {
    nowIso: () => "2026-02-25T12:00:00Z",
    config: { ...DEFAULT_OFFLINE_SWEEP_CONFIG, intervalMs: 100, jitterMs: 0 },
    listActiveSatellites: vi.fn().mockResolvedValue([]),
    updateSatelliteStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Tests ───

describe("FridaySatelliteOfflineSweepJob", () => {
  let deps: FridaySatelliteOfflineSweepDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("runOnce", () => {
    it("returns zero counts when no active satellites exist", async () => {
      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.satellitesChecked).toBe(0);
      expect(result.markedDegraded).toBe(0);
      expect(result.markedOffline).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("marks satellites with no lastSeenAt as offline", async () => {
      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "online", lastSeenAt: null },
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.satellitesChecked).toBe(1);
      expect(result.markedOffline).toBe(1);
      expect(deps.updateSatelliteStatus).toHaveBeenCalledWith("sat-001", "offline");
    });

    it("marks satellites past offline threshold as offline", async () => {
      // 2 minutes ago — past 90s threshold
      const lastSeen = new Date(new Date("2026-02-25T12:00:00Z").getTime() - 120_000).toISOString();

      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "online", lastSeenAt: lastSeen },
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.markedOffline).toBe(1);
      expect(deps.updateSatelliteStatus).toHaveBeenCalledWith("sat-001", "offline");
    });

    it("marks satellites past degraded threshold but within offline as degraded", async () => {
      // 45 seconds ago — past 30s degraded threshold but within 90s offline threshold
      const lastSeen = new Date(new Date("2026-02-25T12:00:00Z").getTime() - 45_000).toISOString();

      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "online", lastSeenAt: lastSeen },
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.markedDegraded).toBe(1);
      expect(deps.updateSatelliteStatus).toHaveBeenCalledWith("sat-001", "degraded");
    });

    it("skips satellites already in the correct status", async () => {
      // 2 minutes ago — already offline
      const lastSeen = new Date(new Date("2026-02-25T12:00:00Z").getTime() - 120_000).toISOString();

      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "offline", lastSeenAt: lastSeen },
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.satellitesChecked).toBe(1);
      expect(result.markedOffline).toBe(0);
      expect(result.markedDegraded).toBe(0);
      expect(deps.updateSatelliteStatus).not.toHaveBeenCalled();
    });

    it("skips degraded status update if already degraded", async () => {
      // 45 seconds ago — already degraded
      const lastSeen = new Date(new Date("2026-02-25T12:00:00Z").getTime() - 45_000).toISOString();

      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "degraded", lastSeenAt: lastSeen },
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.markedDegraded).toBe(0);
      expect(deps.updateSatelliteStatus).not.toHaveBeenCalled();
    });

    it("does not mark recently seen satellites", async () => {
      // 10 seconds ago — within all thresholds
      const lastSeen = new Date(new Date("2026-02-25T12:00:00Z").getTime() - 10_000).toISOString();

      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "online", lastSeenAt: lastSeen },
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.markedDegraded).toBe(0);
      expect(result.markedOffline).toBe(0);
      expect(deps.updateSatelliteStatus).not.toHaveBeenCalled();
    });

    it("handles multiple satellites with mixed states", async () => {
      const now = new Date("2026-02-25T12:00:00Z").getTime();
      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "online", lastSeenAt: null }, // → offline
          { id: "sat-002", pairingStatus: "online", lastSeenAt: new Date(now - 120_000).toISOString() }, // → offline
          { id: "sat-003", pairingStatus: "online", lastSeenAt: new Date(now - 45_000).toISOString() }, // → degraded
          { id: "sat-004", pairingStatus: "online", lastSeenAt: new Date(now - 5_000).toISOString() }, // → stays online
        ]),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.satellitesChecked).toBe(4);
      expect(result.markedOffline).toBe(2);
      expect(result.markedDegraded).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("records error when updating status fails", async () => {
      deps = makeDeps({
        listActiveSatellites: vi.fn().mockResolvedValue([
          { id: "sat-001", pairingStatus: "online", lastSeenAt: null },
        ]),
        updateSatelliteStatus: vi.fn().mockRejectedValue(new Error("write failed")),
      });

      const job = createFridaySatelliteOfflineSweepJob(deps);
      const result = await job.runOnce();

      expect(result.markedOffline).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("write failed");
    });
  });

  describe("lifecycle", () => {
    it("starts and stops without errors", () => {
      const job = createFridaySatelliteOfflineSweepJob(deps);

      expect(job.isRunning()).toBe(false);
      job.start();
      expect(job.isRunning()).toBe(true);
      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    it("start is idempotent", () => {
      const job = createFridaySatelliteOfflineSweepJob(deps);

      job.start();
      job.start();
      expect(job.isRunning()).toBe(true);
      job.stop();
    });

    it("stop is idempotent", () => {
      const job = createFridaySatelliteOfflineSweepJob(deps);

      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    it("uses default config when none provided", async () => {
      const depsNoConfig = makeDeps();
      delete (depsNoConfig as any).config;
      const job = createFridaySatelliteOfflineSweepJob(depsNoConfig);

      const result = await job.runOnce();
      expect(result.satellitesChecked).toBe(0);
    });
  });
});
