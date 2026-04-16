import type {
  FridayFleetOverviewResponse,
  FridayFleetPairingDiagnostics,
  FridayFleetRemediationAction,
  FridayFleetRemediationActionExecutionResult,
  FridayFleetRemediationPlan,
  FridayFleetRouteSelection,
  FridayFleetSatelliteCard,
  FridayFleetSatelliteDetailResponse,
  FridayFleetSatelliteRuntimeRecovery,
  FridayHealthState,
  FridayListFleetSatellitesQuery,
  FridayListFleetSatellitesResponse,
  FridaySecurityCenterResponse,
} from "../model/friday-api-fleet.types.js";
import { FridayDomainError } from "#errors";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
  FridaySatelliteType,
} from "#satellites";
import type {
  CreateFridayFleetDashboardServiceDeps,
  FridayFleetDashboardService,
} from "./friday-fleet-dashboard-service.types.js";
import { createFridayFleetDashboardRepository } from "./friday-fleet-dashboard-repository.js";
import type {
  FridayPairingRequestRow,
  FridaySatelliteWithHeartbeatRow,
} from "./friday-fleet-dashboard-repository.js";
import { calculateSatelliteHealth, healthStateFromScore } from "./friday-fleet-health-calculator.js";
import { calculateSatelliteTrust } from "./friday-fleet-trust-calculator.js";
import type { JsonObject } from "#workflows";

type FridayFleetSatelliteRecoveryInput = Pick<
  FridayFleetSatelliteDetailResponse,
  "satellite" | "queue" | "workflowLoad" | "healthBreakdown"
>;

function parseJsonOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn("[friday][fleet-dashboard-service] operation failed:", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

function buildSatelliteCard(
  row: FridaySatelliteWithHeartbeatRow,
  nowMs: number,
  deadLetterCount: number,
  failedNodeCount1h: number,
  totalNodeCount1h: number,
): FridayFleetSatelliteCard {
  const heartbeatAgeMs =
    row.hb_ts ? nowMs - new Date(row.hb_ts).getTime() : null;

  const healthBreakdown = calculateSatelliteHealth({
    lastHeartbeatAgeMs: heartbeatAgeMs,
    cpuPercent: row.cpu_percent,
    memoryPercent: row.memory_percent,
    loadAvg1m: row.load_avg_1m,
    queueDepth: row.queue_depth,
    deadLetterCount,
    failedNodeCount1h,
    totalNodeCount1h,
  });

  const trustBreakdown = calculateSatelliteTrust({
    pairingStatus: row.pairing_status as FridaySatellitePairingStatus,
    trustLevel: row.trust_level as FridaySatelliteTrustLevel,
    hasRevokedTokens: false,
    hasExpiredHighPrivTokens: false,
    recentRevocationCount: 0,
    recentSecurityFindingsCount: 0,
  });

  const alerts: string[] = [];
  if (healthBreakdown.state === "critical") {
    alerts.push("Health is critical");
  }
  if (trustBreakdown.band === "low") {
    alerts.push("Trust is low");
  }

  return {
    satelliteId: row.id,
    type: row.type as FridaySatelliteType,
    displayName: row.display_name,
    pairingStatus: row.pairing_status as FridaySatellitePairingStatus,
    trustLevel: row.trust_level as FridaySatelliteTrustLevel,
    trustScore: trustBreakdown.finalScore,
    trustBand: trustBreakdown.band,
    healthScore: healthBreakdown.finalScore,
    healthState: healthBreakdown.state,
    lastSeenAt: row.last_seen_at ?? undefined,
    heartbeatAgeMs: heartbeatAgeMs ?? undefined,
    cpuPercent: row.cpu_percent ?? undefined,
    memoryPercent: row.memory_percent ?? undefined,
    loadAvg1m: row.load_avg_1m ?? undefined,
    queueDepth: row.queue_depth ?? undefined,
    activeRuns: row.active_runs ?? undefined,
    tags: parseJsonOr<string[]>(row.tags_json, []),
    alerts,
  };
}

function buildPairingDiagnostics(
  row: FridaySatelliteWithHeartbeatRow,
  pendingRequest: FridayPairingRequestRow | null,
  nowMs: number,
): FridayFleetPairingDiagnostics {
  const heartbeatAgeMs = row.hb_ts ? nowMs - new Date(row.hb_ts).getTime() : null;
  const heartbeatState = !row.hb_ts
    ? "missing"
    : heartbeatAgeMs !== null && heartbeatAgeMs <= 30_000
      ? "fresh"
      : "stale";

  const reasons: string[] = [];
  if (row.pairing_status === "pending") {
    reasons.push("Satellite pairing is still pending operator approval.");
  } else if (row.pairing_status === "revoked") {
    reasons.push("Satellite trust has been revoked and must be re-authorized before recovery continues.");
  }

  if (heartbeatState === "missing") {
    reasons.push("No recent heartbeat has been recorded for this satellite.");
  } else if (heartbeatState === "stale") {
    reasons.push("Heartbeat telemetry is stale and runtime recovery should stay operator-visible.");
  }

  return {
    transport:
      row.transport === "ws" || row.transport === "http-poll" || row.transport === "mixed"
        ? row.transport
        : "unknown",
    heartbeatState,
    lastHeartbeatAt: row.hb_ts ?? undefined,
    runtime: {
      platform: row.platform,
      arch: row.arch,
      appVersion: row.app_version,
      nodeVersion: row.node_version,
    },
    pendingRequest: pendingRequest
      ? {
          requestId: pendingRequest.id,
          pairingCode: pendingRequest.code,
          status: pendingRequest.status,
          expiresAt: pendingRequest.expires_at,
        }
      : undefined,
    requiresReauthorization: row.pairing_status === "pending" || row.pairing_status === "revoked",
    reasons,
  };
}

function buildRouteSelection(
  detail: Pick<FridayFleetSatelliteDetailResponse, "workflowLoad" | "healthBreakdown" | "runtimeRecovery" | "pairingDiagnostics" | "queue">,
): FridayFleetRouteSelection {
  if (detail.pairingDiagnostics.requiresReauthorization) {
    return {
      target: "/fleet",
      state: "blocked",
      reason: "Pairing and trust recovery must finish in Fleet before Friday resumes bounded node work.",
    };
  }

  if (detail.workflowLoad.blockedOfflineNodes > 0) {
    return {
      target: "/assistant",
      state: "recover",
      reason: "Already-dispatched work is blocked offline and needs operator-guided continuation.",
    };
  }

  if (
    detail.healthBreakdown.state !== "healthy"
    || detail.queue.failed > 0
    || detail.queue.deadLetter > 0
  ) {
    return {
      target: "/fleet",
      state: "recover",
      reason: "Fleet recovery is the next safe surface for heartbeat, queue, and remediation work.",
    };
  }

  return {
    target: "/observability",
    state: "monitor",
    reason: "No immediate repair is required; monitor runtime health and diagnostics in Observability.",
  };
}

function buildRemediationPlan(
  detail: Omit<FridayFleetSatelliteDetailResponse, "remediation">,
  generatedAt: string,
): FridayFleetRemediationPlan {
  const actions: FridayFleetRemediationAction[] = [];
  const requiresApproval =
    detail.satellite.pairingStatus === "revoked" ||
    detail.satellite.pairingStatus === "pending";

  if (
    detail.satellite.pairingStatus === "revoked" ||
    detail.satellite.pairingStatus === "pending"
  ) {
    actions.push({
      actionId: "re_authorize_satellite",
      title: "Re-authorize this satellite",
      summary:
        "The satellite must be paired or trusted again before deeper remediation can continue.",
      reason:
        "Pairing or trust is not healthy enough for automated recovery actions.",
      status: "blocked",
      riskClass: "destructive_or_sensitive",
      requiresApproval: true,
      routeTarget: "/fleet",
    });
  }

  if (detail.healthBreakdown.state !== "healthy") {
    actions.push({
      actionId: "restore_heartbeat",
      title: "Restore heartbeat and runtime health",
      summary:
        "Bring the satellite back to a healthy heartbeat state before moving additional work.",
      reason:
        "Heartbeat, degraded health, or stale telemetry currently block safe fleet remediation.",
      status: "blocked",
      riskClass: "safe_probe",
      requiresApproval: false,
      routeTarget: "/fleet",
    });
  }

  if (detail.queue.failed > 0 || detail.queue.deadLetter > 0) {
    actions.push({
      actionId: "requeue_expired_leases",
      title: "Requeue failed or expired leases",
      summary:
        "Recover retryable satellite work by requeueing failed or expired lease entries.",
      reason:
        "Failed or dead-letter queue entries can often be recovered with bounded retry.",
      status: "ready",
      riskClass: "bounded_repair",
      requiresApproval,
      routeTarget: "/fleet",
    });
    actions.push({
      actionId: "expire_stale_messages",
      title: "Expire stale queue messages",
      summary:
        "Clear stale queue messages so the node can continue from a clean queue boundary.",
      reason:
        "Stale queue messages increase retry churn and can block fresh remediation attempts.",
      status: "ready",
      riskClass: "bounded_repair",
      requiresApproval,
      routeTarget: "/fleet",
    });
  }

  if (detail.workflowLoad.blockedOfflineNodes > 0) {
    actions.push({
      actionId: "resume_blocked_work",
      title: "Resume blocked workflow work",
      summary:
        "Bring the satellite back into service or re-place blocked work before users notice more delay.",
      reason:
        "Workflow nodes are already blocked waiting for this satellite to recover.",
      status: "blocked",
      riskClass: "bounded_repair",
      requiresApproval,
      routeTarget: "/assistant",
    });
  }

  if (actions.length === 0) {
    actions.push({
      actionId: "monitor_only",
      title: "No urgent remediation required",
      summary:
        "This satellite is healthy enough to keep handling bounded distributed work.",
      reason: "No failed queue entries, blocked nodes, or degraded trust/health signals were detected.",
      status: "skipped",
      riskClass: "safe_probe",
      requiresApproval: false,
      routeTarget: "/observability",
    });
  }

  const blockedReasons = actions
    .filter((action) => action.status === "blocked")
    .map((action) => action.reason);
  const readyReasons = actions
    .filter((action) => action.status === "ready")
    .map((action) => action.reason);

  return {
    generatedAt,
    satelliteId: detail.satellite.satelliteId,
    status: blockedReasons.length > 0
      ? "blocked"
      : readyReasons.length > 0
        ? "attention_required"
        : "stable",
    summary: blockedReasons.length > 0
      ? "Fleet remediation is blocked until trust or health preconditions are restored."
      : readyReasons.length > 0
        ? "Fleet remediation is available for bounded recovery actions."
        : "No immediate fleet remediation is required.",
    reasons: blockedReasons.length > 0 ? blockedReasons : readyReasons,
    actions,
  };
}

function buildRuntimeRecovery(
  detail: FridayFleetSatelliteRecoveryInput,
): FridayFleetSatelliteRuntimeRecovery {
  const reasons: string[] = [];

  if (
    detail.satellite.pairingStatus === "revoked" ||
    detail.satellite.pairingStatus === "pending"
  ) {
    reasons.push(
      "Trust and pairing must be restored before Friday can continue bounded remediation on this satellite.",
    );
  }
  if (detail.healthBreakdown.state !== "healthy") {
    reasons.push(
      "Heartbeat, runtime health, or telemetry freshness are not healthy enough for autonomous continuation.",
    );
  }
  if (detail.queue.failed + detail.queue.deadLetter > 0) {
    reasons.push(
      "Failed or dead-letter queue entries require bounded queue recovery before this node is considered stable.",
    );
  }
  if (detail.workflowLoad.blockedOfflineNodes > 0) {
    reasons.push(
      "Already-dispatched workflow work is blocked offline and must be resumed or re-placed after recovery.",
    );
  }

  const queueRecoveryState =
    detail.queue.failed + detail.queue.deadLetter > 0
      ? "blocked"
      : detail.workflowLoad.retryingNodes > 0
        ? "retrying"
        : "stable";
  const syncRecoveryState =
    detail.satellite.pairingStatus === "revoked" ||
      detail.satellite.pairingStatus === "pending"
      ? "blocked"
      : detail.healthBreakdown.state !== "healthy"
        ? "recovering"
        : "stable";

  let state: FridayFleetSatelliteRuntimeRecovery["state"] = "stable";
  let nextOperatorAction: FridayFleetSatelliteRuntimeRecovery["nextOperatorAction"] =
    "monitor_only";

  if (
    detail.satellite.pairingStatus === "revoked" ||
    detail.satellite.pairingStatus === "pending"
  ) {
    state = "halted";
    nextOperatorAction = "re_authorize_satellite";
  } else if (detail.healthBreakdown.state !== "healthy") {
    state = "degraded";
    nextOperatorAction = "restore_heartbeat";
  } else if (detail.queue.failed > 0 || detail.queue.deadLetter > 0) {
    state = "retrying";
    nextOperatorAction = "requeue_expired_leases";
  } else if (detail.workflowLoad.blockedOfflineNodes > 0) {
    state = "degraded";
    nextOperatorAction = "resume_blocked_work";
  }

  return {
    state,
    continuationMode: "already_dispatched_only",
    offlinePlanningMode: "deferred",
    summary:
      state === "stable"
        ? "This satellite can continue bounded already-dispatched work without operator action."
        : state === "retrying"
          ? "Friday is retrying bounded recovery for already-dispatched work while keeping new risky continuation blocked."
          : state === "degraded"
            ? "Friday can keep bounded continuation semantics, but operator-visible recovery is required before this node should take more work."
            : "Friday has halted bounded continuation on this satellite until trust or approval preconditions are restored.",
    reasons:
      reasons.length > 0
        ? reasons
        : [
            "Already-dispatched work may continue within the current trust boundary, and richer offline plan generation remains deferred.",
          ],
    queueRecoveryState,
    syncRecoveryState,
    requiresOperatorIntervention: state === "degraded" || state === "halted",
    autoRetryActive: state === "retrying",
    nextOperatorAction,
  };
}

// ─── Factory ───

export function createFridayFleetDashboardService(
  deps: CreateFridayFleetDashboardServiceDeps,
): FridayFleetDashboardService {
  const repo = createFridayFleetDashboardRepository();

  return {
    getOverview() {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const oneHourAgo = new Date(nowMs - 3_600_000).toISOString();

      return deps.db.withReadConnection((db) => {
        const statusCounts = repo.getPairingStatusCounts(db);
        const queueStats = repo.getGlobalQueueStats(db);
        const runStats = repo.getWorkflowRunStats(db, oneHourAgo);

        const countMap: Record<string, number> = {};
        let totalSatellites = 0;
        for (const row of statusCounts) {
          countMap[row.pairing_status] = row.count;
          totalSatellites += row.count;
        }

        // Compute global health from satellite data
        const satellites = repo.listSatellitesWithHeartbeat(db);
        let healthSum = 0;
        let trustSum = 0;
        let lowTrustCount = 0;
        let restrictedCount = 0;
        let runtimeOnlineCount = 0;
        let runtimeDegradedCount = 0;
        let runtimeOfflineCount = 0;
        const healthReasons: string[] = [];

        for (const sat of satellites) {
          const hbAge = sat.hb_ts
            ? nowMs - new Date(sat.hb_ts).getTime()
            : null;
          const dlCount = repo.getDeadLetterCount(db, sat.id);
          const failedCount = repo.getFailedNodeCount1h(db, sat.id, oneHourAgo);
          const totalCount = repo.getTotalNodeCount1h(db, sat.id, oneHourAgo);
          const health = calculateSatelliteHealth({
            lastHeartbeatAgeMs: hbAge,
            cpuPercent: sat.cpu_percent,
            memoryPercent: sat.memory_percent,
            loadAvg1m: sat.load_avg_1m,
            queueDepth: sat.queue_depth,
            deadLetterCount: dlCount,
            failedNodeCount1h: failedCount,
            totalNodeCount1h: totalCount,
          });
          healthSum += health.finalScore;
          if (hbAge === null || hbAge > 90_000) {
            runtimeOfflineCount++;
          } else if (health.state === "healthy") {
            runtimeOnlineCount++;
          } else {
            runtimeDegradedCount++;
          }

          // Real trust inputs from DB — api_tokens uses user_id for user tokens;
          // for satellites, we match by principal_type + a label or ID convention.
          const hasRevokedTokens = (db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND revoked_at IS NOT NULL",
            )
            .get(sat.id) as { count: number }).count > 0;
          const hasExpiredHighPrivTokens = (db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <= ? AND revoked_at IS NULL AND (scopes_json LIKE '%hub.admin%' OR scopes_json LIKE '%security.write%')",
            )
            .get(sat.id, now) as { count: number }).count > 0;
          const recentRevocationCount = (db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND revoked_at IS NOT NULL AND revoked_at >= ?",
            )
            .get(sat.id, oneHourAgo) as { count: number }).count;

          const trust = calculateSatelliteTrust({
            pairingStatus: sat.pairing_status as FridaySatellitePairingStatus,
            trustLevel: sat.trust_level as FridaySatelliteTrustLevel,
            hasRevokedTokens,
            hasExpiredHighPrivTokens,
            recentRevocationCount,
            recentSecurityFindingsCount: 0,
          });
          trustSum += trust.finalScore;
          if (trust.band === "low") lowTrustCount++;
          if (sat.trust_level === "restricted") restrictedCount++;
        }

        const avgHealth = satellites.length > 0 ? Math.round(healthSum / satellites.length) : 100;
        const avgTrust = satellites.length > 0 ? Math.round(trustSum / satellites.length) : 100;

        if (avgHealth < 55) healthReasons.push("Average fleet health is critical");
        else if (avgHealth < 80) healthReasons.push("Average fleet health is degraded");

        return {
          generatedAt: now,
          totals: {
            satellites: totalSatellites,
            pending: countMap["pending"] ?? 0,
            paired: countMap["paired"] ?? 0,
            online: runtimeOnlineCount,
            degraded: runtimeDegradedCount,
            offline: runtimeOfflineCount,
            revoked: countMap["revoked"] ?? 0,
          },
          queue: {
            queued: queueStats.queued_count ?? 0,
            leased: queueStats.leased_count ?? 0,
            failed: queueStats.failed_count ?? 0,
            deadLetter: queueStats.dead_letter_count ?? 0,
          },
          workflows: {
            activeRuns: runStats.active_runs ?? 0,
            completed1h: runStats.completed_1h ?? 0,
            failed1h: runStats.failed_1h ?? 0,
          },
          health: {
            score: avgHealth,
            state: healthStateFromScore(avgHealth),
            reasons: healthReasons,
          },
          trust: {
            averageScore: avgTrust,
            lowTrustCount,
            restrictedCount,
            revokedCount: countMap["revoked"] ?? 0,
          },
        };
      });
    },

    listSatellites(input) {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const oneHourAgo = new Date(nowMs - 3_600_000).toISOString();

      return deps.db.withReadConnection((db) => {
        let rows = repo.listSatellitesWithHeartbeat(db);

        // Apply filters
        if (input.pairingStatus) {
          rows = rows.filter((r) => r.pairing_status === input.pairingStatus);
        }
        if (input.trustLevel) {
          rows = rows.filter((r) => r.trust_level === input.trustLevel);
        }
        if (input.q) {
          const q = input.q.toLowerCase();
          rows = rows.filter(
            (r) =>
              r.display_name.toLowerCase().includes(q) ||
              r.id.toLowerCase().includes(q),
          );
        }

        const limit = Math.min(input.limit ?? 50, 200);
        const startIdx = input.cursor
          ? rows.findIndex((r) => r.id === input.cursor) + 1
          : 0;
        const slice = rows.slice(startIdx, startIdx + limit);

        const cards: FridayFleetSatelliteCard[] = slice.map((row) => {
          const dlCount = repo.getDeadLetterCount(db, row.id);
          const failedCount = repo.getFailedNodeCount1h(db, row.id, oneHourAgo);
          const totalCount = repo.getTotalNodeCount1h(db, row.id, oneHourAgo);
          return buildSatelliteCard(row, nowMs, dlCount, failedCount, totalCount);
        });

        // Health state filter (post-computation)
        const filtered = input.healthState
          ? cards.filter((c) => c.healthState === input.healthState)
          : cards;

        const nextCursor =
          slice.length === limit ? slice[slice.length - 1]?.id : undefined;

        return {
          items: filtered,
          nextCursor,
        };
      });
    },

    getSatelliteDetail(satelliteId) {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const oneHourAgo = new Date(nowMs - 3_600_000).toISOString();

      return deps.db.withReadConnection((db) => {
        const rows = repo.listSatellitesWithHeartbeat(db);
        const row = rows.find((r) => r.id === satelliteId);
        if (!row) return null;

        const dlCount = repo.getDeadLetterCount(db, satelliteId);
        const failedCount = repo.getFailedNodeCount1h(db, satelliteId, oneHourAgo);
        const totalCount = repo.getTotalNodeCount1h(db, satelliteId, oneHourAgo);

        const card = buildSatelliteCard(row, nowMs, dlCount, failedCount, totalCount);

        const caps = repo.getCapabilities(db, satelliteId);
        const queueStats = repo.getQueueStatsBySatellite(db, satelliteId);
        const workflowLoad = repo.getWorkflowLoadBySatellite(db, satelliteId);
        const latestPairingRequest = repo.getLatestPairingRequest(db, satelliteId);

        const heartbeatAgeMs =
          row.hb_ts ? nowMs - new Date(row.hb_ts).getTime() : null;

        const healthBreakdown = calculateSatelliteHealth({
          lastHeartbeatAgeMs: heartbeatAgeMs,
          cpuPercent: row.cpu_percent,
          memoryPercent: row.memory_percent,
          loadAvg1m: row.load_avg_1m,
          queueDepth: row.queue_depth,
          deadLetterCount: dlCount,
          failedNodeCount1h: failedCount,
          totalNodeCount1h: totalCount,
        });

        const trustBreakdown = calculateSatelliteTrust({
          pairingStatus: row.pairing_status as FridaySatellitePairingStatus,
          trustLevel: row.trust_level as FridaySatelliteTrustLevel,
          hasRevokedTokens: false,
          hasExpiredHighPrivTokens: false,
          recentRevocationCount: 0,
          recentSecurityFindingsCount: 0,
        });

        const pairingDiagnostics = buildPairingDiagnostics(row, latestPairingRequest, nowMs);

        const detailBase = {
          satellite: card,
          capabilities: caps.map((c) => ({
            key: c.key,
            available: c.available === 1,
            limits: c.limits_json ? parseJsonOr<JsonObject>(c.limits_json, {}) : undefined,
            metadata: c.metadata_json ? parseJsonOr<JsonObject>(c.metadata_json, {}) : undefined,
          })),
          queue: {
            queued: queueStats?.queued_count ?? 0,
            leased: queueStats?.leased_count ?? 0,
            failed: queueStats?.failed_count ?? 0,
            deadLetter: queueStats?.dead_letter_count ?? 0,
          },
          workflowLoad: {
            queuedNodes: workflowLoad?.queued_nodes ?? 0,
            runningNodes: workflowLoad?.running_nodes ?? 0,
            retryingNodes: workflowLoad?.retrying_nodes ?? 0,
            blockedOfflineNodes: workflowLoad?.blocked_offline_nodes ?? 0,
          },
          pairingDiagnostics,
          trustBreakdown,
          healthBreakdown,
        } satisfies Omit<
          FridayFleetSatelliteDetailResponse,
          "remediation" | "runtimeRecovery" | "routeSelection"
        >;

        const runtimeRecovery = buildRuntimeRecovery(detailBase);
        const detail: Omit<FridayFleetSatelliteDetailResponse, "remediation"> = {
          ...detailBase,
          runtimeRecovery,
          routeSelection: buildRouteSelection({
            ...detailBase,
            runtimeRecovery,
          }),
        };

        return {
          ...detail,
          remediation: buildRemediationPlan(detail, now),
        };
      });
    },

    getSatelliteRemediationPlan(satelliteId) {
      const detail = this.getSatelliteDetail(satelliteId);
      return detail?.remediation ?? null;
    },

    async executeSatelliteRemediationAction(input) {
      const detail = this.getSatelliteDetail(input.satelliteId);
      if (!detail) {
        throw new FridayDomainError(
          "SATELLITE_NOT_FOUND",
          `Satellite '${input.satelliteId}' not found`,
          { httpStatus: 404 },
        );
      }

      const action = detail.remediation.actions.find(
        (candidate) => candidate.actionId === input.actionId,
      );
      if (!action) {
        throw new FridayDomainError(
          "UNSUPPORTED_REMEDIATION_ACTION",
          `Unsupported remediation action '${input.actionId}'`,
          { httpStatus: 400 },
        );
      }

      if (action.status !== "ready") {
        return {
          satelliteId: input.satelliteId,
          actionId: input.actionId,
          status: "blocked",
          message: action.reason,
          followUpActionId: action.actionId,
          executedAt: deps.nowIso(),
        };
      }

      if (!deps.outboxQueueService) {
        return {
          satelliteId: input.satelliteId,
          actionId: input.actionId,
          status: "blocked",
          message: "Outbox queue remediation is not available in this runtime.",
          executedAt: deps.nowIso(),
        };
      }

      const now = deps.nowIso();
      if (input.actionId === "requeue_expired_leases") {
        const affectedCount = await deps.outboxQueueService.requeueExpiredLeases(now);
        return {
          satelliteId: input.satelliteId,
          actionId: input.actionId,
          status: "completed",
          affectedCount,
          message: `Requeued ${affectedCount} expired or failed lease(s).`,
          executedAt: now,
        };
      }

      if (input.actionId === "expire_stale_messages") {
        const affectedCount = await deps.outboxQueueService.expireByTtl(now);
        return {
          satelliteId: input.satelliteId,
          actionId: input.actionId,
          status: "completed",
          affectedCount,
          message: `Expired ${affectedCount} stale queue message(s).`,
          executedAt: now,
        };
      }

      throw new FridayDomainError(
        "UNSUPPORTED_REMEDIATION_ACTION",
        `Unsupported remediation action '${input.actionId}'`,
        { httpStatus: 400 },
      );
    },

    getSecurityCenter() {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const twentyFourHoursAgo = new Date(nowMs - 86_400_000).toISOString();

      return deps.db.withReadConnection((db) => {
        // Token stats
        const activeTokens = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
            )
            .get(now) as { count: number }
        ).count;

        const expiredTokens = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ? AND revoked_at IS NULL",
            )
            .get(now) as { count: number }
        ).count;

        const revokedTokens24h = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at >= ?",
            )
            .get(twentyFourHoursAgo) as { count: number }
        ).count;

        // Count high-privilege tokens
        const allActiveTokens = db
          .prepare(
            "SELECT scopes_json FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          )
          .all(now) as Array<{ scopes_json: string }>;

        const highPrivilegeActive = allActiveTokens.filter((t) => {
          const scopes = parseJsonOr<string[]>(t.scopes_json, []);
          return scopes.includes("hub.admin") || scopes.includes("security.write");
        }).length;

        // Satellite stats
        const statusCounts = repo.getPairingStatusCounts(db);
        const scMap: Record<string, number> = {};
        for (const s of statusCounts) {
          scMap[s.pairing_status] = s.count;
        }

        const pendingPairings = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM satellite_pairing_requests WHERE status = 'pending'",
            )
            .get() as { count: number }
        ).count;

        // Real restricted/trusted counts from trust_level column
        const restrictedSatellites = (db
          .prepare(
            "SELECT COUNT(*) as count FROM satellites WHERE deleted_at IS NULL AND trust_level = 'restricted'",
          )
          .get() as { count: number }).count;
        const trustedSatellites = (db
          .prepare(
            "SELECT COUNT(*) as count FROM satellites WHERE deleted_at IS NULL AND trust_level = 'trusted'",
          )
          .get() as { count: number }).count;

        // Build findings (lightweight security scan)
        const findings: FridaySecurityCenterResponse["findings"] = [];

        if (highPrivilegeActive > 3) {
          findings.push({
            id: deps.idGenerator(),
            severity: "medium",
            type: "token_scope_risk",
            message: `${highPrivilegeActive} high-privilege tokens are active`,
            detectedAt: now,
          });
        }

        return {
          generatedAt: now,
          tokens: {
            active: activeTokens,
            expired: expiredTokens,
            revoked24h: revokedTokens24h,
            highPrivilegeActive,
          },
          satellites: {
            restricted: restrictedSatellites,
            trusted: trustedSatellites,
            revoked: scMap["revoked"] ?? 0,
            pendingPairings,
          },
          findings,
        };
      });
    },
  };
}
