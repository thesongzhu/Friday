import type { ISODateTime, JsonObject, JsonValue, UUID } from "#workflows";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
  FridaySatelliteType,
} from "#satellites";
import type { FridayPage, FridayPaginationQuery } from "./friday-api-common.types.js";

// ─── Health / Trust Bands ───

export type FridayHealthState = "healthy" | "degraded" | "critical";
export type FridayTrustBand = "low" | "medium" | "high";
export type FridayFleetRemediationRiskClass =
  | "safe_probe"
  | "bounded_repair"
  | "destructive_or_sensitive";
export type FridayFleetRemediationActionStatus =
  | "ready"
  | "blocked"
  | "completed"
  | "skipped";
export type FridayFleetRuntimeRecoveryState =
  | "stable"
  | "retrying"
  | "degraded"
  | "halted";

// ─── Fleet Overview ───

export interface FridayFleetOverviewResponse {
  generatedAt: ISODateTime;
  totals: {
    satellites: number;
    pending: number;
    paired: number;
    online: number;
    degraded: number;
    offline: number;
    revoked: number;
  };
  queue: {
    queued: number;
    leased: number;
    failed: number;
    deadLetter: number;
  };
  workflows: {
    activeRuns: number;
    completed1h: number;
    failed1h: number;
  };
  health: {
    score: number;
    state: FridayHealthState;
    reasons: string[];
  };
  trust: {
    averageScore: number;
    lowTrustCount: number;
    restrictedCount: number;
    revokedCount: number;
  };
}

// ─── Satellite Card ───

export interface FridayFleetSatelliteCard {
  satelliteId: UUID;
  type: FridaySatelliteType;
  displayName: string;
  pairingStatus: FridaySatellitePairingStatus;
  trustLevel: FridaySatelliteTrustLevel;
  trustScore: number;
  trustBand: FridayTrustBand;
  healthScore: number;
  healthState: FridayHealthState;
  lastSeenAt?: ISODateTime;
  heartbeatAgeMs?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  loadAvg1m?: number;
  queueDepth?: number;
  activeRuns?: number;
  tags: string[];
  alerts: string[];
}

export interface FridayListFleetSatellitesQuery extends FridayPaginationQuery {
  pairingStatus?: FridaySatellitePairingStatus;
  trustLevel?: FridaySatelliteTrustLevel;
  healthState?: FridayHealthState;
  q?: string;
}
export interface FridayListFleetSatellitesResponse extends FridayPage<FridayFleetSatelliteCard> {}

// ─── Satellite Detail ───

export interface FridayFleetSatelliteDetailResponse {
  satellite: FridayFleetSatelliteCard;
  capabilities: Array<{
    key: string;
    available: boolean;
    limits?: JsonObject;
    metadata?: JsonObject;
  }>;
  queue: {
    queued: number;
    leased: number;
    failed: number;
    deadLetter: number;
  };
  workflowLoad: {
    queuedNodes: number;
    runningNodes: number;
    retryingNodes: number;
    blockedOfflineNodes: number;
  };
  runtimeRecovery: FridayFleetSatelliteRuntimeRecovery;
  trustBreakdown: FridaySatelliteTrustBreakdown;
  healthBreakdown: FridaySatelliteHealthBreakdown;
  remediation: FridayFleetRemediationPlan;
}

export interface FridayFleetRemediationActionExecutionResult {
  satelliteId: UUID;
  actionId: string;
  status: FridayFleetRemediationActionStatus;
  message: string;
  affectedCount?: number;
  followUpActionId?: string;
  executedAt: ISODateTime;
}

export interface FridayFleetRemediationAction {
  actionId: string;
  title: string;
  summary: string;
  reason: string;
  riskClass: FridayFleetRemediationRiskClass;
  status: FridayFleetRemediationActionStatus;
  routeTarget?: "/assistant" | "/fleet" | "/observability";
  requiresApproval: boolean;
}

export interface FridayFleetRemediationPlan {
  generatedAt: ISODateTime;
  satelliteId: UUID;
  status: "stable" | "attention_required" | "blocked";
  summary: string;
  reasons: string[];
  actions: FridayFleetRemediationAction[];
}

export interface FridayFleetSatelliteRuntimeRecovery {
  state: FridayFleetRuntimeRecoveryState;
  continuationMode: "already_dispatched_only";
  offlinePlanningMode: "deferred";
  summary: string;
  reasons: string[];
  queueRecoveryState: "stable" | "retrying" | "blocked";
  syncRecoveryState: "stable" | "recovering" | "blocked";
  requiresOperatorIntervention: boolean;
  autoRetryActive: boolean;
  nextOperatorAction:
    | "monitor_only"
    | "restore_heartbeat"
    | "re_authorize_satellite"
    | "requeue_expired_leases"
    | "expire_stale_messages"
    | "resume_blocked_work";
}

// ─── Health Breakdown ───

export interface FridaySatelliteHealthBreakdown {
  heartbeatScore: number;
  resourceScore: number;
  queueScore: number;
  reliabilityScore: number;
  finalScore: number;
  state: FridayHealthState;
}

// ─── Trust Breakdown ───

export interface FridaySatelliteTrustBreakdown {
  identityScore: number;
  statusScore: number;
  hygieneScore: number;
  incidentPenalty: number;
  finalScore: number;
  band: FridayTrustBand;
  reasons: string[];
}

// ─── Security Center ───

export interface FridaySecurityCenterResponse {
  generatedAt: ISODateTime;
  tokens: {
    active: number;
    expired: number;
    revoked24h: number;
    highPrivilegeActive: number;
  };
  satellites: {
    restricted: number;
    trusted: number;
    revoked: number;
    pendingPairings: number;
  };
  findings: Array<{
    id: UUID;
    severity: "low" | "medium" | "high";
    type: "token_scope_risk" | "revocation_gap" | "offline_high_privilege" | "trust_mismatch";
    message: string;
    satelliteId?: UUID;
    tokenId?: UUID;
    detectedAt: ISODateTime;
  }>;
}
