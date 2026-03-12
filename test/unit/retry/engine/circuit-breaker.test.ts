import { describe, it, expect, beforeEach } from "vitest";

import {
  createCircuitBreakerManager,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "../../../../src/retry/engine/circuit-breaker.js";

import type {
  CircuitBreakerConfig,
  CircuitBreakerManagerInstance,
} from "../../../../src/retry/engine/circuit-breaker.js";

// ─── Helpers ───

function createTestManager(
  config?: Partial<CircuitBreakerConfig>,
  startTime: number = 1000000,
) {
  let currentTime = startTime;
  const manager = createCircuitBreakerManager(
    { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config },
    () => currentTime,
  );

  return {
    manager,
    advanceTime(ms: number) {
      currentTime += ms;
    },
    getTime() {
      return currentTime;
    },
  };
}

// ─── Tests ───

describe("CircuitBreaker", () => {
  describe("DEFAULT_CIRCUIT_BREAKER_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5);
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs).toBe(30000);
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenSuccessThreshold).toBe(1);
    });
  });

  describe("initial state", () => {
    it("starts in closed state for new targets", () => {
      const { manager } = createTestManager();
      const snap = manager.getSnapshot("target-a");
      expect(snap.state).toBe("closed");
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.totalTrips).toBe(0);
    });

    it("allows requests in closed state", () => {
      const { manager } = createTestManager();
      expect(manager.isAllowed("target-a")).toBe(true);
    });
  });

  describe("closed → open transition", () => {
    it("trips after reaching failure threshold", () => {
      const { manager } = createTestManager({ failureThreshold: 3 });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("closed");

      manager.recordFailure("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("open");
      expect(manager.getSnapshot("target-a").totalTrips).toBe(1);
    });

    it("rejects requests when open", () => {
      const { manager } = createTestManager({ failureThreshold: 2 });
      manager.recordFailure("target-a");
      manager.recordFailure("target-a");

      expect(manager.isAllowed("target-a")).toBe(false);
    });

    it("resets failure count on success", () => {
      const { manager } = createTestManager({ failureThreshold: 3 });
      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      manager.recordSuccess("target-a");

      const snap = manager.getSnapshot("target-a");
      expect(snap.state).toBe("closed");
      expect(snap.consecutiveFailures).toBe(0);
    });
  });

  describe("open → half_open transition", () => {
    it("transitions to half_open after reset timeout", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("open");

      advanceTime(5000);
      const snap = manager.getSnapshot("target-a");
      expect(snap.state).toBe("half_open");
    });

    it("allows one probe request in half_open", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(5000);

      expect(manager.isAllowed("target-a")).toBe(true);
    });

    it("rejects additional half_open requests while probe is in flight", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(5000);

      expect(manager.isAllowed("target-a")).toBe(true);
      expect(manager.isAllowed("target-a")).toBe(false);
    });

    it("does not transition before timeout elapses", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(4999);

      expect(manager.getSnapshot("target-a").state).toBe("open");
      expect(manager.isAllowed("target-a")).toBe(false);
    });
  });

  describe("half_open → closed transition", () => {
    it("closes circuit after success in half_open", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenSuccessThreshold: 1,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(5000);
      manager.recordSuccess("target-a");

      const snap = manager.getSnapshot("target-a");
      expect(snap.state).toBe("closed");
      expect(snap.consecutiveFailures).toBe(0);
    });

    it("requires multiple successes when threshold > 1", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenSuccessThreshold: 3,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(5000);

      manager.recordSuccess("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("half_open");

      manager.recordSuccess("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("half_open");

      manager.recordSuccess("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("closed");
    });

    it("allows a new probe after previous half_open probe resolves", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenSuccessThreshold: 2,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(5000);

      expect(manager.isAllowed("target-a")).toBe(true);
      expect(manager.isAllowed("target-a")).toBe(false);

      manager.recordSuccess("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("half_open");
      expect(manager.isAllowed("target-a")).toBe(true);
    });
  });

  describe("half_open → open transition", () => {
    it("re-opens on failure during half_open", () => {
      const { manager, advanceTime } = createTestManager({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      advanceTime(5000);
      manager.recordFailure("target-a");

      const snap = manager.getSnapshot("target-a");
      expect(snap.state).toBe("open");
      expect(snap.totalTrips).toBe(2);
    });
  });

  describe("per-target isolation", () => {
    it("tracks targets independently", () => {
      const { manager } = createTestManager({ failureThreshold: 2 });

      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      manager.recordFailure("target-b");

      expect(manager.getSnapshot("target-a").state).toBe("open");
      expect(manager.getSnapshot("target-b").state).toBe("closed");
      expect(manager.getSnapshot("target-b").consecutiveFailures).toBe(1);
    });
  });

  describe("reset", () => {
    it("resets a single target", () => {
      const { manager } = createTestManager({ failureThreshold: 2 });
      manager.recordFailure("target-a");
      manager.recordFailure("target-a");
      expect(manager.getSnapshot("target-a").state).toBe("open");

      manager.reset("target-a");
      const snap = manager.getSnapshot("target-a");
      expect(snap.state).toBe("closed");
      expect(snap.totalTrips).toBe(0);
    });

    it("resets all targets", () => {
      const { manager } = createTestManager({ failureThreshold: 1 });
      manager.recordFailure("target-a");
      manager.recordFailure("target-b");

      manager.resetAll();

      expect(manager.getSnapshot("target-a").state).toBe("closed");
      expect(manager.getSnapshot("target-b").state).toBe("closed");
    });
  });

  describe("getAllSnapshots", () => {
    it("returns snapshots for all tracked targets", () => {
      const { manager } = createTestManager();
      manager.recordFailure("target-a");
      manager.recordSuccess("target-b");

      const snapshots = manager.getAllSnapshots();
      expect(snapshots).toHaveLength(2);
      const targets = snapshots.map((s) => s.target).sort();
      expect(targets).toEqual(["target-a", "target-b"]);
    });
  });
});
