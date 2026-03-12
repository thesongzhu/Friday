import type { FridaySatellitePairingStatus } from "./friday-satellite.types.js";

export interface FridaySatelliteHealthTransitionInput {
  nowIso: string;
  lastHeartbeatTs?: string;
  failureRate1m?: number;
  explicitDisconnect?: boolean;
  currentStatus: FridaySatellitePairingStatus;
}

/** Heartbeat age threshold: online if < 30s. */
const ONLINE_THRESHOLD_MS = 30_000;
/** Heartbeat age threshold: degraded if < 90s. */
const DEGRADED_THRESHOLD_MS = 90_000;
/** Failure rate threshold for degraded status. */
const FAILURE_RATE_THRESHOLD = 0.5;

/**
 * Pure function: computes the next satellite status from heartbeat metrics.
 * Terminal statuses (revoked) are never auto-promoted.
 */
export function computeFridaySatelliteStatus(
  input: FridaySatelliteHealthTransitionInput,
): FridaySatellitePairingStatus {
  // Revoked is terminal — never auto-promoted
  if (input.currentStatus === "revoked") {
    return "revoked";
  }

  // Explicit disconnect → offline
  if (input.explicitDisconnect) {
    return "offline";
  }

  // No heartbeat received yet → remain in current status
  if (!input.lastHeartbeatTs) {
    return input.currentStatus;
  }

  const nowMs = new Date(input.nowIso).getTime();
  const lastMs = new Date(input.lastHeartbeatTs).getTime();
  const ageMs = nowMs - lastMs;

  // Heartbeat too old → offline
  if (ageMs > DEGRADED_THRESHOLD_MS) {
    return "offline";
  }

  // Heartbeat somewhat stale or high failure rate → degraded
  if (ageMs >= ONLINE_THRESHOLD_MS || (input.failureRate1m ?? 0) >= FAILURE_RATE_THRESHOLD) {
    return "degraded";
  }

  // Fresh heartbeat, low failure rate → online
  return "online";
}
