/**
 * Satellite Nodes Service — Bridges satellite pairing system with the
 * generic nodes service, providing satellite-aware discovery and control.
 *
 * @module nodes/friday-satellite-nodes-service
 */

import type { FridayNodeControlResult, FridayNodeInfo } from "./friday-nodes-service.js";

// ─── Types ───

export interface FridaySatelliteNodeRecord {
  readonly satelliteId: string;
  readonly displayName: string;
  readonly type: string;
  readonly pairingStatus: string;
  readonly lastSeenAt: string | null;
  readonly metadata?: Record<string, unknown>;
}

// ─── Deps ───

export interface FridaySatelliteNodesServiceDeps {
  /** List all paired (approved) satellites. */
  readonly listPairedSatellites: () => Promise<ReadonlyArray<FridaySatelliteNodeRecord>>;

  /** Get a single satellite by ID. */
  readonly getSatellite: (satelliteId: string) => Promise<FridaySatelliteNodeRecord | null>;

  /** Send a control command to a satellite via its transport. */
  readonly sendCommand: (
    satelliteId: string,
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{ success: boolean; response?: unknown; error?: string; durationMs?: number }>;
}

// ─── Interface ───

export interface FridaySatelliteNodesService {
  discover(signal: AbortSignal): Promise<FridayNodeInfo[]>;
  get(satelliteId: string, signal: AbortSignal): Promise<FridayNodeInfo | null>;
  control(
    satelliteId: string,
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<FridayNodeControlResult>;
}

// ─── Helpers ───

function toNodeStatus(pairingStatus: string): "online" | "offline" | "unknown" {
  if (pairingStatus === "online") return "online";
  if (pairingStatus === "offline" || pairingStatus === "revoked") return "offline";
  return "unknown";
}

function toNodeInfo(sat: FridaySatelliteNodeRecord): FridayNodeInfo {
  return {
    nodeId: sat.satelliteId,
    name: sat.displayName,
    kind: sat.type,
    status: toNodeStatus(sat.pairingStatus),
    lastSeen: sat.lastSeenAt ?? undefined,
    metadata: sat.metadata,
  };
}

// ─── Factory ───

export function createFridaySatelliteNodesService(
  deps: FridaySatelliteNodesServiceDeps,
): FridaySatelliteNodesService {
  return {
    async discover(_signal: AbortSignal): Promise<FridayNodeInfo[]> {
      const satellites = await deps.listPairedSatellites();
      return satellites.map(toNodeInfo);
    },

    async get(satelliteId: string, _signal: AbortSignal): Promise<FridayNodeInfo | null> {
      const sat = await deps.getSatellite(satelliteId);
      if (!sat) return null;
      return toNodeInfo(sat);
    },

    async control(
      satelliteId: string,
      command: string,
      args?: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<FridayNodeControlResult> {
      const result = await deps.sendCommand(satelliteId, command, args, timeoutMs);
      return {
        nodeId: satelliteId,
        command,
        success: result.success,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      };
    },
  };
}
