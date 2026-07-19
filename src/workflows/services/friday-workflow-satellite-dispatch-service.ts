import type { FridaySqliteLayer } from "#state";
import { hashIdempotencyPayload } from "../../api/http/routes/friday-route-idempotency.js";
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

interface SatellitePlacementPolicy {
  allowOfflineQueue: boolean;
  preferredSatelliteIds: Set<string>;
  excludedSatelliteIds: Set<string>;
  minTrustLevel?: string;
}

export interface FridayWorkflowSatellitePlacementAuditEvent {
  at: string;
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  attemptId: string;
  attempt: number;
  executionTarget: string;
  requiredCapabilities: string[];
  decisionKind: "hub" | "satellite_dispatched" | "blocked";
  satelliteId?: string;
  blockedCode?: string;
  blockedMessage?: string;
  blockedRetryable?: boolean;
}

export interface CreateFridayWorkflowSatelliteDispatchServiceDeps {
  db: FridaySqliteLayer;
  outbox: FridayOutboxQueueService;
  nowIso: () => string;
  onPlacementDecision?: (event: FridayWorkflowSatellitePlacementAuditEvent) => void;
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

function readStringSet(value: JsonValue | undefined): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(
    value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim()),
  );
}

function readPlacementPolicy(config: Record<string, JsonValue>): SatellitePlacementPolicy {
  const rawPlacement = asRecord(config.satellitePlacement);
  const allowOfflineQueue =
    config.allowOfflineSatelliteQueue === true
    || config.offlineAutonomy === true
    || rawPlacement.allowOfflineQueue === true
    || rawPlacement.allowOffline === true;
  const minTrustLevel = typeof rawPlacement.minTrustLevel === "string" && rawPlacement.minTrustLevel.trim().length > 0
    ? rawPlacement.minTrustLevel.trim()
    : undefined;

  return {
    allowOfflineQueue,
    preferredSatelliteIds: readStringSet(rawPlacement.preferredSatelliteIds ?? config.preferredSatelliteIds),
    excludedSatelliteIds: readStringSet(rawPlacement.excludedSatelliteIds ?? config.excludedSatelliteIds),
    minTrustLevel,
  };
}

function isPlacementStatusEligible(status: string, policy: SatellitePlacementPolicy): boolean {
  if (status === "online") {
    return true;
  }
  return policy.allowOfflineQueue && (status === "degraded" || status === "offline");
}

function trustRank(trustLevel: string): number {
  switch (trustLevel) {
    case "trusted":
      return 3;
    case "standard":
      return 2;
    case "restricted":
      return 1;
    default:
      return 0;
  }
}

function statusRank(status: string): number {
  switch (status) {
    case "online":
      return 3;
    case "degraded":
      return 2;
    case "offline":
      return 1;
    default:
      return 0;
  }
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
  function listPlacementCandidates(
    requiredCapabilities: string[],
    policy: SatellitePlacementPolicy,
  ): PlacementCandidate[] {
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
        .filter((row) => isPlacementStatusEligible(row.pairing_status, policy))
        .filter((row) => !policy.excludedSatelliteIds.has(row.id))
        .filter((row) => policy.minTrustLevel === undefined || trustRank(row.trust_level) >= trustRank(policy.minTrustLevel))
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
          const preferredDelta =
            Number(policy.preferredSatelliteIds.has(right.satelliteId))
            - Number(policy.preferredSatelliteIds.has(left.satelliteId));
          if (preferredDelta !== 0) return preferredDelta;
          const statusDelta = statusRank(right.pairingStatus) - statusRank(left.pairingStatus);
          if (statusDelta !== 0) return statusDelta;
          const trustDelta = Number(right.trustLevel === "trusted") - Number(left.trustLevel === "trusted");
          if (trustDelta !== 0) return trustDelta;
          if (left.queueDepth !== right.queueDepth) return left.queueDepth - right.queueDepth;
          if (left.activeRuns !== right.activeRuns) return left.activeRuns - right.activeRuns;
          return left.satelliteId.localeCompare(right.satelliteId);
        });
    });
  }

  function emitPlacementAudit(
    input: FridayWorkflowDistributedDispatchRequest,
    executionTarget: string,
    requiredCapabilities: string[],
    result: FridayWorkflowDistributedDispatchResult,
  ): void {
    if (!deps.onPlacementDecision) return;
    const blocked = result.kind === "blocked" ? result : undefined;
    const dispatched = result.kind === "satellite_dispatched" ? result : undefined;
    try {
      deps.onPlacementDecision({
        at: deps.nowIso(),
        runId: input.runId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        attempt: input.attempt,
        executionTarget,
        requiredCapabilities,
        decisionKind: result.kind,
        satelliteId: dispatched?.satelliteId ?? blocked?.satelliteId,
        blockedCode: blocked?.code,
        blockedMessage: blocked?.message,
        blockedRetryable: blocked?.retryable,
      });
    } catch {
      // Audit callback must never alter placement semantics or block dispatch.
    }
  }

  return {
    async dispatchNode(input: FridayWorkflowDistributedDispatchRequest): Promise<FridayWorkflowDistributedDispatchResult> {
      const config = asRecord(input.node.config);
      const executionTarget = readExecutionTarget(config);
      const requiredCapabilities = readCapabilityRequirements(config);
      if (executionTarget === "hub") {
        const hubResult: FridayWorkflowDistributedDispatchResult = { kind: "hub" };
        emitPlacementAudit(input, executionTarget, requiredCapabilities, hubResult);
        return hubResult;
      }

      const placementPolicy = readPlacementPolicy(config);
      let satelliteId: string | undefined;
      let earlyBlocked: FridayWorkflowDistributedDispatchResult | null = null;

      if (executionTarget.startsWith("satellite:")) {
        satelliteId = executionTarget.slice("satellite:".length).trim();
        if (!satelliteId) {
          earlyBlocked = {
            kind: "blocked",
            code: "SATELLITE_TARGET_INVALID",
            message: "executionTarget satellite id is invalid",
            retryable: false,
          };
        } else {
          const satellite = deps.db.withReadConnection((db) =>
            db.prepare(
              "SELECT id, pairing_status FROM satellites WHERE id = ? AND deleted_at IS NULL LIMIT 1",
            ).get(satelliteId) as { id: string; pairing_status: string } | undefined,
          );
          if (!satellite) {
            earlyBlocked = {
              kind: "blocked",
              satelliteId,
              code: "SATELLITE_TARGET_NOT_FOUND",
              message: "Specified execution target was not found",
              retryable: false,
            };
          } else if (!isPlacementStatusEligible(satellite.pairing_status, placementPolicy)) {
            earlyBlocked = failureForSatelliteState(satelliteId, satellite.pairing_status);
          } else if (placementPolicy.excludedSatelliteIds.has(satelliteId)) {
            earlyBlocked = {
              kind: "blocked",
              satelliteId,
              code: "SATELLITE_PLACEMENT_EXCLUDED",
              message: "Specified satellite is excluded by placement policy",
              retryable: false,
            };
          } else if (requiredCapabilities.length > 0) {
            const candidates = listPlacementCandidates(requiredCapabilities, placementPolicy);
            if (!candidates.some((candidate) => candidate.satelliteId === satelliteId)) {
              earlyBlocked = {
                kind: "blocked",
                satelliteId,
                code: "SATELLITE_CAPABILITY_UNAVAILABLE",
                message: "Specified satellite does not satisfy required capabilities",
                retryable: true,
                details: { requiredCapabilities },
              };
            }
          }
        }
      } else if (executionTarget === "capability-match") {
        const candidates = listPlacementCandidates(requiredCapabilities, placementPolicy);
        const candidate = candidates[0];
        if (!candidate) {
          earlyBlocked = {
            kind: "blocked",
            code: "SATELLITE_CAPABILITY_UNAVAILABLE",
            message: "No online satellite satisfies the requested execution capabilities",
            retryable: true,
            details: { requiredCapabilities },
          };
        } else {
          satelliteId = candidate.satelliteId;
        }
      } else {
        earlyBlocked = {
          kind: "blocked",
          code: "SATELLITE_TARGET_UNSUPPORTED",
          message: `Unsupported executionTarget '${executionTarget}'`,
          retryable: false,
        };
      }

      if (earlyBlocked) {
        emitPlacementAudit(input, executionTarget, requiredCapabilities, earlyBlocked);
        return earlyBlocked;
      }

      if (!satelliteId) {
        const fallbackBlocked: FridayWorkflowDistributedDispatchResult = {
          kind: "blocked",
          code: "SATELLITE_PLACEMENT_FAILED",
          message: "Satellite placement did not resolve a target id",
          retryable: false,
        };
        emitPlacementAudit(input, executionTarget, requiredCapabilities, fallbackBlocked);
        return fallbackBlocked;
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

      // Stable logical-payload identity: the dispatch payload MINUS `requestedAt` (the only
      // volatile field — a per-dispatch timestamp). A legit re-dispatch of the SAME node
      // execution carries a fresh `requestedAt` (→ different ciphertext) but the same logical
      // operation, so it MUST stay idempotent (no over-fail); a reused idempotency_key carrying
      // a DIFFERENT logical operation diverges here and surfaces as a typed 409 conflict.
      const logicalPayloadDigest = hashIdempotencyPayload({
        type: payload.type,
        runId: payload.runId,
        workflowId: payload.workflowId,
        workflowVersionId: payload.workflowVersionId,
        nodeId: payload.nodeId,
        attemptId: payload.attemptId,
        attempt: payload.attempt,
        node: payload.node,
        inputData: payload.inputData,
        expressionContext: payload.expressionContext,
        // requestedAt EXCLUDED: per-dispatch timestamp; a legit re-dispatch of the SAME node
        // execution must stay idempotent (no over-fail).
      });

      deps.outbox.enqueue({
        satelliteId,
        queueKey: `workflow:${input.runId}`,
        messageType: "workflow.node.execute",
        payloadCiphertext: encodePayload(payload),
        nonce: "inline-transport",
        keyId: "inline-transport:v1",
        idempotencyKey: input.idempotencyKey,
        logicalPayloadDigest,
        expiresAt,
      });

      const dispatchedResult: FridayWorkflowDistributedDispatchResult = {
        kind: "satellite_dispatched",
        satelliteId,
        leaseOwner: `satellite:${satelliteId}`,
        leaseExpiresAt,
      };
      emitPlacementAudit(input, executionTarget, requiredCapabilities, dispatchedResult);
      return dispatchedResult;
    },
  };
}
