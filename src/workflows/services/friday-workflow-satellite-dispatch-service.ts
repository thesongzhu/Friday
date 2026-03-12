import type { FridaySqliteLayer } from "#state";
import type { JsonValue, UUID } from "../model/friday-workflow.types.js";
import type {
  FridayWorkflowDistributedDispatcher,
  FridayWorkflowDistributedDispatchRequest,
  FridayWorkflowDistributedDispatchResult,
} from "./friday-workflow-execution-service.js";
import type { FridayOutboxQueueService } from "#satellites";

interface PlacementCandidate {
  satelliteId: string;
  pairingStatus: string;
  trustLevel: string;
  queueDepth: number;
  activeRuns: number;
}

export interface CreateFridayWorkflowSatelliteDispatchServiceDeps {
  db: FridaySqliteLayer;
  outbox: FridayOutboxQueueService;
  nowIso: () => string;
}

const DEFAULT_REMOTE_LEASE_MS = 300_000;
const DEFAULT_COMMAND_TTL_MS = 900_000;

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return {};
}

function readExecutionTarget(config: Record<string, JsonValue>): string {
  const value = config.executionTarget;
  return typeof value === "string" && value.trim().length > 0 ? value : "hub";
}

function readCapabilityRequirements(config: Record<string, JsonValue>): string[] {
  const requirements = config.executionCapabilities;
  if (Array.isArray(requirements)) {
    return requirements.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  const singleton = config.executionCapability;
  return typeof singleton === "string" && singleton.trim().length > 0 ? [singleton] : [];
}

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function failureForSatelliteState(satelliteId: string | undefined, status: string): FridayWorkflowDistributedDispatchResult {
  const base = { kind: "blocked" as const, satelliteId, retryable: true };
  switch (status) {
    case "offline":
      return { ...base, code: "SATELLITE_OFFLINE", message: "Target satellite is offline" };
    case "degraded":
      return { ...base, code: "SATELLITE_DEGRADED", message: "Target satellite is degraded" };
    case "pending":
      return { ...base, code: "SATELLITE_PAIRING_PENDING", message: "Target satellite has not completed pairing" };
    case "revoked":
      return { ...base, code: "SATELLITE_REVOKED", message: "Target satellite has been revoked", retryable: false };
    default:
      return { ...base, code: "SATELLITE_UNAVAILABLE", message: "Target satellite is unavailable" };
  }
}

export function createFridayWorkflowSatelliteDispatchService(
  deps: CreateFridayWorkflowSatelliteDispatchServiceDeps,
): FridayWorkflowDistributedDispatcher {
  function listPlacementCandidates(requiredCapabilities: string[]): PlacementCandidate[] {
    return deps.db.withReadConnection((db) => {
      const rows = db.prepare(
        `WITH latest_heartbeat AS (
           SELECT satellite_id, MAX(ts) AS max_ts
           FROM satellite_heartbeats
           GROUP BY satellite_id
         )
         SELECT s.id,
                s.pairing_status,
                s.trust_level,
                COALESCE(h.queue_depth, 0) AS queue_depth,
                COALESCE(h.active_runs, 0) AS active_runs
         FROM satellites s
         LEFT JOIN latest_heartbeat lh ON lh.satellite_id = s.id
         LEFT JOIN satellite_heartbeats h ON h.satellite_id = lh.satellite_id AND h.ts = lh.max_ts
         WHERE s.deleted_at IS NULL`,
      ).all() as Array<{
        id: string;
        pairing_status: string;
        trust_level: string;
        queue_depth: number | null;
        active_runs: number | null;
      }>;

      return rows
        .filter((row) => row.pairing_status === "online")
        .filter((row) => {
          if (requiredCapabilities.length === 0) return true;
          const availableCount = db.prepare(
            `SELECT COUNT(*) AS count
             FROM satellite_capabilities
             WHERE satellite_id = ?
               AND available = 1
               AND key IN (${requiredCapabilities.map(() => "?").join(",")})`,
          ).get(row.id, ...requiredCapabilities) as { count: number };
          return availableCount.count === requiredCapabilities.length;
        })
        .map((row) => ({
          satelliteId: row.id,
          pairingStatus: row.pairing_status,
          trustLevel: row.trust_level,
          queueDepth: row.queue_depth ?? 0,
          activeRuns: row.active_runs ?? 0,
        }))
        .sort((left, right) => {
          const trustDelta = Number(right.trustLevel === "trusted") - Number(left.trustLevel === "trusted");
          if (trustDelta !== 0) return trustDelta;
          if (left.queueDepth !== right.queueDepth) return left.queueDepth - right.queueDepth;
          if (left.activeRuns !== right.activeRuns) return left.activeRuns - right.activeRuns;
          return left.satelliteId.localeCompare(right.satelliteId);
        });
    });
  }

  return {
    async dispatchNode(input: FridayWorkflowDistributedDispatchRequest): Promise<FridayWorkflowDistributedDispatchResult> {
      const config = asRecord(input.node.config);
      const executionTarget = readExecutionTarget(config);
      if (executionTarget === "hub") {
        return { kind: "hub" };
      }

      const requiredCapabilities = readCapabilityRequirements(config);
      let satelliteId: string | undefined;

      if (executionTarget.startsWith("satellite:")) {
        satelliteId = executionTarget.slice("satellite:".length).trim();
        if (!satelliteId) {
          return {
            kind: "blocked",
            code: "SATELLITE_TARGET_INVALID",
            message: "executionTarget satellite id is invalid",
            retryable: false,
          };
        }

        const satellite = deps.db.withReadConnection((db) =>
          db.prepare(
            "SELECT id, pairing_status FROM satellites WHERE id = ? AND deleted_at IS NULL LIMIT 1",
          ).get(satelliteId) as { id: string; pairing_status: string } | undefined,
        );
        if (!satellite) {
          return {
            kind: "blocked",
            satelliteId,
            code: "SATELLITE_TARGET_NOT_FOUND",
            message: "Specified execution target was not found",
            retryable: false,
          };
        }
        if (satellite.pairing_status !== "online") {
          return failureForSatelliteState(satelliteId, satellite.pairing_status);
        }
        if (requiredCapabilities.length > 0) {
          const candidates = listPlacementCandidates(requiredCapabilities);
          if (!candidates.some((candidate) => candidate.satelliteId === satelliteId)) {
            return {
              kind: "blocked",
              satelliteId,
              code: "SATELLITE_CAPABILITY_UNAVAILABLE",
              message: "Specified satellite does not satisfy required capabilities",
              retryable: true,
              details: { requiredCapabilities },
            };
          }
        }
      } else if (executionTarget === "capability-match") {
        const candidates = listPlacementCandidates(requiredCapabilities);
        const candidate = candidates[0];
        if (!candidate) {
          return {
            kind: "blocked",
            code: "SATELLITE_CAPABILITY_UNAVAILABLE",
            message: "No online satellite satisfies the requested execution capabilities",
            retryable: true,
            details: { requiredCapabilities },
          };
        }
        satelliteId = candidate.satelliteId;
      } else {
        return {
          kind: "blocked",
          code: "SATELLITE_TARGET_UNSUPPORTED",
          message: `Unsupported executionTarget '${executionTarget}'`,
          retryable: false,
        };
      }

      const nowIso = deps.nowIso();
      const remoteLeaseMs = typeof input.node.timeoutMs === "number"
        ? Math.max(DEFAULT_REMOTE_LEASE_MS, input.node.timeoutMs)
        : DEFAULT_REMOTE_LEASE_MS;
      const leaseExpiresAt = new Date(new Date(nowIso).getTime() + remoteLeaseMs).toISOString();
      const expiresAt = new Date(new Date(nowIso).getTime() + Math.max(remoteLeaseMs, DEFAULT_COMMAND_TTL_MS)).toISOString();
      const payload = {
        type: "workflow.node.execute",
        runId: input.runId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        attempt: input.attempt,
        node: input.node,
        inputData: input.inputData,
        expressionContext: input.expressionContext,
        requestedAt: nowIso,
      };

      deps.outbox.enqueue({
        satelliteId,
        queueKey: `workflow:${input.runId}`,
        messageType: "workflow.node.execute",
        payloadCiphertext: encodePayload(payload),
        nonce: "inline-transport",
        keyId: "inline-transport:v1",
        idempotencyKey: input.idempotencyKey,
        expiresAt,
      });

      return {
        kind: "satellite_dispatched",
        satelliteId,
        leaseOwner: `satellite:${satelliteId}`,
        leaseExpiresAt,
      };
    },
  };
}
