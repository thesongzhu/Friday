import type { FridayHealthState, FridaySatelliteHealthBreakdown } from "../model/friday-api-fleet.types.js";

// ─── Input ───

export interface FridayHealthCalculatorInput {
  lastHeartbeatAgeMs: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  loadAvg1m: number | null;
  queueDepth: number | null;
  deadLetterCount: number;
  failedNodeCount1h: number;
  totalNodeCount1h: number;
}

// ─── Health state from score ───

export function healthStateFromScore(score: number): FridayHealthState {
  if (score >= 80) return "healthy";
  if (score >= 55) return "degraded";
  return "critical";
}

// ─── Calculator ───

export function calculateSatelliteHealth(
  input: FridayHealthCalculatorInput,
): FridaySatelliteHealthBreakdown {
  // Heartbeat score
  let heartbeatScore: number;
  if (input.lastHeartbeatAgeMs === null) {
    heartbeatScore = 0;
  } else if (input.lastHeartbeatAgeMs < 30_000) {
    heartbeatScore = 100;
  } else if (input.lastHeartbeatAgeMs <= 90_000) {
    // Linear 100 -> 40 from 30s to 90s
    const ratio = (input.lastHeartbeatAgeMs - 30_000) / 60_000;
    heartbeatScore = 100 - ratio * 60;
  } else {
    heartbeatScore = 10;
  }

  // Resource score
  const cpu = input.cpuPercent ?? 0;
  const mem = input.memoryPercent ?? 0;
  const load = input.loadAvg1m !== null ? Math.min(input.loadAvg1m * 100, 100) : 0;
  const resourceScore = Math.max(0, 100 - Math.max(cpu, mem, load));

  // Queue score
  const depth = input.queueDepth ?? 0;
  const queueScore = Math.max(0, 100 - Math.min((depth / 100) * 100, 100));

  // Reliability score
  let reliabilityScore = 100;
  if (input.deadLetterCount > 0) {
    reliabilityScore -= Math.min(input.deadLetterCount * 10, 50);
  }
  if (input.totalNodeCount1h > 0) {
    const failRate = input.failedNodeCount1h / input.totalNodeCount1h;
    reliabilityScore -= Math.min(failRate * 100, 50);
  }
  reliabilityScore = Math.max(0, reliabilityScore);

  // Final composite
  const finalScore = Math.round(
    0.35 * heartbeatScore +
    0.25 * resourceScore +
    0.20 * queueScore +
    0.20 * reliabilityScore,
  );

  const state = healthStateFromScore(finalScore);

  return {
    heartbeatScore: Math.round(heartbeatScore),
    resourceScore: Math.round(resourceScore),
    queueScore: Math.round(queueScore),
    reliabilityScore: Math.round(reliabilityScore),
    finalScore,
    state,
  };
}
