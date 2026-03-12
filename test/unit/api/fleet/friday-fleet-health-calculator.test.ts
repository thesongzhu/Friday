import { describe, it, expect } from "vitest";
import {
  calculateSatelliteHealth,
  healthStateFromScore,
  type FridayHealthCalculatorInput,
} from "#api";

describe("FridayFleetHealthCalculator", () => {
  function makeInput(overrides: Partial<FridayHealthCalculatorInput> = {}): FridayHealthCalculatorInput {
    return {
      lastHeartbeatAgeMs: 10_000,
      cpuPercent: 20,
      memoryPercent: 30,
      loadAvg1m: 0.2,
      queueDepth: 5,
      deadLetterCount: 0,
      failedNodeCount1h: 0,
      totalNodeCount1h: 10,
      ...overrides,
    };
  }

  // ─── healthStateFromScore ───

  it("returns 'healthy' for score >= 80", () => {
    expect(healthStateFromScore(80)).toBe("healthy");
    expect(healthStateFromScore(100)).toBe("healthy");
  });

  it("returns 'degraded' for score 55-79", () => {
    expect(healthStateFromScore(55)).toBe("degraded");
    expect(healthStateFromScore(79)).toBe("degraded");
  });

  it("returns 'critical' for score < 55", () => {
    expect(healthStateFromScore(54)).toBe("critical");
    expect(healthStateFromScore(0)).toBe("critical");
  });

  // ─── Heartbeat score ───

  it("heartbeat < 30s → heartbeatScore = 100", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 5_000 }));
    expect(result.heartbeatScore).toBe(100);
  });

  it("heartbeat = 30s → heartbeatScore = 100", () => {
    // At exactly 30s, ratio = 0, so score = 100
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 30_000 }));
    expect(result.heartbeatScore).toBe(100);
  });

  it("heartbeat = 60s → heartbeatScore = 70 (midpoint of linear decay)", () => {
    // At 60s: ratio = (60_000-30_000)/60_000 = 0.5, score = 100 - 0.5*60 = 70
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 60_000 }));
    expect(result.heartbeatScore).toBe(70);
  });

  it("heartbeat = 90s → heartbeatScore = 40 (end of linear decay)", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 90_000 }));
    expect(result.heartbeatScore).toBe(40);
  });

  it("heartbeat > 90s → heartbeatScore = 10", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 120_000 }));
    expect(result.heartbeatScore).toBe(10);
  });

  it("null heartbeat → heartbeatScore = 0", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: null }));
    expect(result.heartbeatScore).toBe(0);
  });

  // ─── Resource score ───

  it("low resource usage → high resource score", () => {
    const result = calculateSatelliteHealth(
      makeInput({ cpuPercent: 10, memoryPercent: 15, loadAvg1m: 0.1 }),
    );
    // max(10, 15, 10) = 15; score = 100 - 15 = 85
    expect(result.resourceScore).toBe(85);
  });

  it("high CPU usage → low resource score", () => {
    const result = calculateSatelliteHealth(
      makeInput({ cpuPercent: 90, memoryPercent: 30, loadAvg1m: 0.2 }),
    );
    // max(90, 30, 20) = 90; score = 100 - 90 = 10
    expect(result.resourceScore).toBe(10);
  });

  it("null resource values treated as 0", () => {
    const result = calculateSatelliteHealth(
      makeInput({ cpuPercent: null, memoryPercent: null, loadAvg1m: null }),
    );
    expect(result.resourceScore).toBe(100);
  });

  // ─── Queue score ───

  it("empty queue → queueScore = 100", () => {
    const result = calculateSatelliteHealth(makeInput({ queueDepth: 0 }));
    expect(result.queueScore).toBe(100);
  });

  it("queue depth 50 → queueScore = 50", () => {
    const result = calculateSatelliteHealth(makeInput({ queueDepth: 50 }));
    expect(result.queueScore).toBe(50);
  });

  it("queue depth >= 100 → queueScore = 0", () => {
    const result = calculateSatelliteHealth(makeInput({ queueDepth: 100 }));
    expect(result.queueScore).toBe(0);

    const over = calculateSatelliteHealth(makeInput({ queueDepth: 200 }));
    expect(over.queueScore).toBe(0);
  });

  // ─── Reliability score ───

  it("no dead letters and no failures → reliabilityScore = 100", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 0, failedNodeCount1h: 0, totalNodeCount1h: 10 }),
    );
    expect(result.reliabilityScore).toBe(100);
  });

  it("dead letters reduce reliability", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 3, failedNodeCount1h: 0, totalNodeCount1h: 0 }),
    );
    // 100 - min(3*10, 50) = 100 - 30 = 70
    expect(result.reliabilityScore).toBe(70);
  });

  it("high dead letter count caps at -50", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 10, failedNodeCount1h: 0, totalNodeCount1h: 0 }),
    );
    // 100 - min(100, 50) = 50
    expect(result.reliabilityScore).toBe(50);
  });

  it("failed nodes reduce reliability", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 0, failedNodeCount1h: 5, totalNodeCount1h: 10 }),
    );
    // failRate = 0.5, penalty = min(50, 50) = 50; score = 100 - 50 = 50
    expect(result.reliabilityScore).toBe(50);
  });

  // ─── Composite score ───

  it("perfect health → score ≈ 100 → healthy", () => {
    const result = calculateSatelliteHealth(
      makeInput({
        lastHeartbeatAgeMs: 5_000,
        cpuPercent: 10,
        memoryPercent: 10,
        loadAvg1m: 0.05,
        queueDepth: 0,
        deadLetterCount: 0,
        failedNodeCount1h: 0,
        totalNodeCount1h: 10,
      }),
    );
    // hb=100, resource=90, queue=100, reliability=100
    // 0.35*100 + 0.25*90 + 0.20*100 + 0.20*100 = 35+22.5+20+20 = 97.5 → 98
    expect(result.finalScore).toBeGreaterThanOrEqual(95);
    expect(result.state).toBe("healthy");
  });

  it("terrible health → low score → critical", () => {
    const result = calculateSatelliteHealth(
      makeInput({
        lastHeartbeatAgeMs: null,
        cpuPercent: 95,
        memoryPercent: 90,
        loadAvg1m: 2.0,
        queueDepth: 200,
        deadLetterCount: 10,
        failedNodeCount1h: 10,
        totalNodeCount1h: 10,
      }),
    );
    expect(result.finalScore).toBeLessThan(55);
    expect(result.state).toBe("critical");
  });

  it("borderline degraded health", () => {
    // Calibrate to get score ~65
    const result = calculateSatelliteHealth(
      makeInput({
        lastHeartbeatAgeMs: 60_000, // hb=70
        cpuPercent: 50,             // resource=50
        memoryPercent: 40,
        loadAvg1m: 0.2,
        queueDepth: 30,             // queue=70
        deadLetterCount: 1,
        failedNodeCount1h: 1,
        totalNodeCount1h: 10,
      }),
    );
    // hb=70, resource=50, queue=70, reliability=80
    // 0.35*70 + 0.25*50 + 0.20*70 + 0.20*80 = 24.5+12.5+14+16 = 67
    expect(result.state).toBe("degraded");
  });
});
