import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridaySatellitePairingExpiryJob,
  DEFAULT_PAIRING_EXPIRY_CONFIG,
  type FridaySatellitePairingExpiryDeps,
} from "../../../../src/jobs/satellites/friday-satellite-pairing-expiry-job.js";

// ─── Helpers ───

function makeDeps(overrides: Partial<FridaySatellitePairingExpiryDeps> = {}): FridaySatellitePairingExpiryDeps {
  return {
    nowIso: () => "2026-02-25T12:00:00Z",
    config: { ...DEFAULT_PAIRING_EXPIRY_CONFIG, intervalMs: 100, jitterMs: 0 },
    listPendingExpiredBefore: vi.fn().mockResolvedValue([]),
    expirePairingRequest: vi.fn().mockResolvedValue(undefined),
    deleteResolvedBefore: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

// ─── Tests ───

describe("FridaySatellitePairingExpiryJob", () => {
  let deps: FridaySatellitePairingExpiryDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("runOnce", () => {
    it("returns zero counts when nothing to expire or clean", async () => {
      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.requestsExpired).toBe(0);
      expect(result.requestsCleaned).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("expires pending requests past their expiry time", async () => {
      deps = makeDeps({
        listPendingExpiredBefore: vi.fn().mockResolvedValue([
          { requestId: "req-001", satelliteId: "sat-001" },
          { requestId: "req-002", satelliteId: "sat-002" },
        ]),
      });

      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.requestsExpired).toBe(2);
      expect(deps.expirePairingRequest).toHaveBeenCalledTimes(2);
      expect(deps.expirePairingRequest).toHaveBeenCalledWith("req-001");
      expect(deps.expirePairingRequest).toHaveBeenCalledWith("req-002");
    });

    it("records errors when individual expiry fails", async () => {
      deps = makeDeps({
        listPendingExpiredBefore: vi.fn().mockResolvedValue([
          { requestId: "req-001", satelliteId: "sat-001" },
        ]),
        expirePairingRequest: vi.fn().mockRejectedValue(new Error("DB error")),
      });

      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.requestsExpired).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("req-001");
      expect(result.errors[0]).toContain("DB error");
    });

    it("records error when listing expired requests fails", async () => {
      deps = makeDeps({
        listPendingExpiredBefore: vi.fn().mockRejectedValue(new Error("connection lost")),
      });

      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("connection lost");
    });

    it("cleans up resolved requests older than retention period", async () => {
      deps = makeDeps({
        deleteResolvedBefore: vi.fn().mockResolvedValue(5),
      });

      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.requestsCleaned).toBe(5);
      expect(deps.deleteResolvedBefore).toHaveBeenCalledTimes(1);
      // Cutoff should be 7 days before now
      const callArg = (deps.deleteResolvedBefore as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const cutoffMs = new Date(callArg).getTime();
      const nowMs = new Date("2026-02-25T12:00:00Z").getTime();
      expect(nowMs - cutoffMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("records error when cleaning resolved requests fails", async () => {
      deps = makeDeps({
        deleteResolvedBefore: vi.fn().mockRejectedValue(new Error("disk full")),
      });

      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("disk full");
    });

    it("handles both phases independently — expiry errors do not block cleanup", async () => {
      deps = makeDeps({
        listPendingExpiredBefore: vi.fn().mockRejectedValue(new Error("expiry error")),
        deleteResolvedBefore: vi.fn().mockResolvedValue(3),
      });

      const job = createFridaySatellitePairingExpiryJob(deps);
      const result = await job.runOnce();

      expect(result.requestsExpired).toBe(0);
      expect(result.requestsCleaned).toBe(3);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("lifecycle", () => {
    it("starts and stops without errors", () => {
      const job = createFridaySatellitePairingExpiryJob(deps);

      expect(job.isRunning()).toBe(false);
      job.start();
      expect(job.isRunning()).toBe(true);
      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    it("start is idempotent", () => {
      const job = createFridaySatellitePairingExpiryJob(deps);

      job.start();
      job.start(); // should not throw or double-schedule
      expect(job.isRunning()).toBe(true);
      job.stop();
    });

    it("stop is idempotent", () => {
      const job = createFridaySatellitePairingExpiryJob(deps);

      job.stop(); // should not throw when already stopped
      expect(job.isRunning()).toBe(false);
    });

    it("uses default config when none provided", async () => {
      const depsNoConfig = makeDeps();
      delete (depsNoConfig as any).config;
      const job = createFridaySatellitePairingExpiryJob(depsNoConfig);

      const result = await job.runOnce();
      expect(result.requestsExpired).toBe(0);
    });
  });
});
