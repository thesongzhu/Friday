import type {
  FridayFleetRemediationActionStatus,
  FridayFleetRemediationRiskClass,
  FridayFleetSatelliteDetailResponse,
  FridayFleetSatelliteRuntimeRecovery,
} from "@/lib/api/types";

export type FridayFleetFocus = "details" | "recovery" | "queue" | "trust";

export function formatFleetTimestamp(value?: string): string {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString();
}

export function buildFleetHref(satelliteId?: string | null, focus: FridayFleetFocus = "details"): string {
  const params = new URLSearchParams();
  if (satelliteId) {
    params.set("satelliteId", satelliteId);
  }
  params.set("focus", focus);
  const query = params.toString();
  return query.length > 0 ? `/fleet?${query}` : "/fleet";
}

export function formatFleetHeartbeatAge(value?: number): string {
  if (!Number.isFinite(value) || value == null) return "No heartbeat";
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms ago`;
  if (value < 60_000) return `${Math.round(value / 1000)} s ago`;
  return `${Math.round(value / 60_000)} min ago`;
}

export function toneForFleetHealth(status?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  if (status === "critical") return "danger";
  return "neutral";
}

export function toneForFleetTrust(level?: string): "neutral" | "success" | "warning" | "danger" {
  if (level === "trusted") return "success";
  if (level === "restricted") return "warning";
  if (level === "revoked") return "danger";
  return "neutral";
}

export function toneForFleetPairing(status?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "online") return "success";
  if (status === "degraded" || status === "pending" || status === "paired") return "warning";
  if (status === "offline" || status === "revoked") return "danger";
  return "neutral";
}

export interface FridayFleetRecoveryStep {
  id: string;
  title: string;
  summary: string;
  reason: string;
  tone: "neutral" | "success" | "warning" | "danger";
  routeTarget: "/assistant" | "/fleet" | "/observability";
  actionId?: string;
  status?: FridayFleetRemediationActionStatus;
  riskClass?: FridayFleetRemediationRiskClass;
  requiresApproval?: boolean;
}

export interface FridayFleetRuntimeRecoveryCard {
  title: string;
  summary: string;
  tone: "neutral" | "success" | "warning" | "danger";
  nextActionLabel: string;
  queueRecoveryLabel: string;
  syncRecoveryLabel: string;
  continuationLabel: string;
  offlinePlanningLabel: string;
  requiresOperatorIntervention: boolean;
  autoRetryActive: boolean;
  reasons: string[];
}

function toneForRuntimeRecovery(
  state?: FridayFleetSatelliteRuntimeRecovery["state"],
): "neutral" | "success" | "warning" | "danger" {
  if (state === "stable") return "success";
  if (state === "retrying" || state === "degraded") return "warning";
  if (state === "halted") return "danger";
  return "neutral";
}

function labelForRuntimeAction(
  action?: FridayFleetSatelliteRuntimeRecovery["nextOperatorAction"],
): string {
  switch (action) {
    case "re_authorize_satellite":
      return "Re-authorize this satellite";
    case "restore_heartbeat":
      return "Restore heartbeat and runtime health";
    case "requeue_expired_leases":
      return "Requeue expired or failed work";
    case "resume_blocked_work":
      return "Resume or re-place blocked workflow work";
    default:
      return "Monitor only";
  }
}

function labelForRecoveryState(state: "stable" | "retrying" | "recovering" | "blocked"): string {
  switch (state) {
    case "stable":
      return "Stable";
    case "retrying":
      return "Retrying";
    case "recovering":
      return "Recovering";
    case "blocked":
      return "Blocked";
  }
}

export function buildFleetRuntimeRecoveryCard(
  detail?: FridayFleetSatelliteDetailResponse | null,
): FridayFleetRuntimeRecoveryCard | null {
  if (!detail) return null;

  const runtimeRecovery = detail.runtimeRecovery;
  return {
    title:
      runtimeRecovery.state === "stable"
        ? "Bounded continuation is healthy"
        : runtimeRecovery.state === "retrying"
          ? "Bounded continuation is retrying"
          : runtimeRecovery.state === "degraded"
            ? "Bounded continuation is degraded"
            : "Bounded continuation is halted",
    summary: runtimeRecovery.summary,
    tone: toneForRuntimeRecovery(runtimeRecovery.state),
    nextActionLabel: labelForRuntimeAction(runtimeRecovery.nextOperatorAction),
    queueRecoveryLabel: labelForRecoveryState(runtimeRecovery.queueRecoveryState),
    syncRecoveryLabel: labelForRecoveryState(runtimeRecovery.syncRecoveryState),
    continuationLabel: "Already-dispatched work only",
    offlinePlanningLabel: "Deferred",
    requiresOperatorIntervention: runtimeRecovery.requiresOperatorIntervention,
    autoRetryActive: runtimeRecovery.autoRetryActive,
    reasons: runtimeRecovery.reasons,
  };
}

export function buildFleetRecoverySteps(detail?: FridayFleetSatelliteDetailResponse | null): FridayFleetRecoveryStep[] {
  if (!detail) {
    return [];
  }

  if (detail.remediation.actions.length > 0) {
    return detail.remediation.actions.map((action) => {
      const remediationActionId =
        "actionId" in action && typeof action.actionId === "string"
          ? action.actionId
          : "id" in action && typeof action.id === "string"
            ? action.id
            : undefined;
      const tone =
        action.riskClass === "destructive_or_sensitive"
          ? "danger"
          : action.status === "ready"
            ? "warning"
            : action.status === "completed"
              ? "success"
              : "neutral";
      const routeTarget =
        remediationActionId === "re_authorize_satellite" || remediationActionId === "restore_heartbeat"
          ? "/assistant"
          : remediationActionId === "expire_stale_messages"
            ? "/observability"
            : "/fleet";
      return {
        id: remediationActionId ?? "unknown_remediation_action",
        title: action.title,
        summary: action.summary,
        reason: action.reason,
        tone,
        routeTarget,
        actionId: remediationActionId,
        status: action.status,
        riskClass: action.riskClass,
        requiresApproval: action.requiresApproval,
      };
    });
  }

  const steps: FridayFleetRecoveryStep[] = [];

  if (detail.satellite.pairingStatus === "revoked") {
    steps.push({
      id: "revoked-node",
      title: "Re-authorize or replace this node",
      summary: "This satellite is revoked, so Friday should not place new work on it until trust is restored.",
      reason: "Revoked nodes are a hard stop for placement and bounded remediation.",
      tone: "danger",
      routeTarget: "/assistant",
    });
  } else if (detail.satellite.pairingStatus === "offline" || detail.healthBreakdown.state !== "healthy") {
    steps.push({
      id: "restore-heartbeat",
      title: "Restore node health before moving more work",
      summary: "Bring the node back to a healthy heartbeat state, then let Friday retry blocked or degraded tasks.",
      reason: "Heartbeat and health problems cascade into blocked placement and repeated retries.",
      tone: detail.satellite.pairingStatus === "offline" ? "danger" : "warning",
      routeTarget: "/assistant",
    });
  }

  if (detail.queue.failed + detail.queue.deadLetter > 0) {
    steps.push({
      id: "inspect-queue",
      title: "Inspect the blocked queue and dead letters",
      summary: "Friday has evidence about which jobs failed or fell into dead-letter state and can guide the next bounded recovery.",
      reason: "Failed queue entries usually tell you whether to retry, re-place, or stop the node.",
      tone: "warning",
      routeTarget: "/observability",
    });
  }

  if (detail.workflowLoad.blockedOfflineNodes > 0) {
    steps.push({
      id: "resume-blocked-work",
      title: "Resume or re-place blocked workflow work",
      summary: "Some workflow nodes are explicitly blocked offline and need placement or recovery attention.",
      reason: "Blocked workflow nodes are the clearest user-visible impact of a degraded satellite.",
      tone: "warning",
      routeTarget: "/fleet",
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: "monitor-only",
      title: "No urgent fleet recovery is needed right now",
      summary: "This node is currently healthy enough to keep running bounded distributed work.",
      reason: "Friday can keep monitoring without asking you to take an action yet.",
      tone: "success",
      routeTarget: "/fleet",
    });
  }

  return steps.slice(0, 3);
}
