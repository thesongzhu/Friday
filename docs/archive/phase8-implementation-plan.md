> Superseded: this implementation plan is historical. Use `docs/current-source-of-truth.md` for the active architecture and contract baseline.

## 1. File structure
```text
src/api/
  index.ts                                                       (new)

  model/
    friday-api-common.types.ts                                  (new)
    friday-api-auth.types.ts                                    (new)
    friday-api-workflow.types.ts                                (new)
    friday-api-realtime.types.ts                                (new)
    friday-api-fleet.types.ts                                   (new)
    friday-api-security.types.ts                                (new)
    friday-api-conflict.types.ts                                (new)
    friday-api-route.types.ts                                   (new)

  auth/
    friday-auth-service.types.ts                                (new)
    friday-auth-service.ts                                      (new)
    friday-rbac-policy.ts                                       (new)
    friday-token-validator.ts                                   (new)
    friday-rate-limit-service.types.ts                          (new)
    friday-rate-limit-service.ts                                (new)
    friday-auth-middleware.ts                                   (new)

  persistence/
    friday-user-repository.ts                                   (new)
    friday-auth-session-repository.ts                           (new)
    friday-api-token-repository.ts                              (new, user/service token reads + revocation)
    friday-rate-limit-counter-repository.ts                     (new)
    friday-realtime-event-repository.ts                         (new)
    friday-realtime-checkpoint-repository.ts                    (new)
    friday-workflow-conflict-repository.ts                      (new)

  realtime/
    friday-realtime-event-bus.types.ts                          (new)
    friday-realtime-event-bus.ts                                (new)
    friday-realtime-subscription-service.ts                     (new)
    friday-realtime-ws-gateway.ts                               (new)

  fleet/
    friday-fleet-dashboard-service.types.ts                     (new)
    friday-fleet-dashboard-repository.ts                        (new)
    friday-fleet-health-calculator.ts                           (new)
    friday-fleet-trust-calculator.ts                            (new)
    friday-fleet-dashboard-service.ts                           (new)

  conflicts/
    friday-workflow-conflict-service.types.ts                   (new)
    friday-workflow-conflict-service.ts                         (new)

  legacy/
    friday-legacy-decommission.types.ts                         (new)
    friday-legacy-decommission-service.ts                       (new)
    friday-legacy-write-freeze-guard.ts                         (new)

  http/
    friday-http-context.types.ts                                (new)
    friday-http-error-mapper.ts                                 (new)
    friday-http-route-registry.ts                               (new)

    routes/
      friday-auth-routes.ts                                     (new)
      friday-workflow-routes.ts                                 (new)
      friday-workflow-builder-routes.ts                         (new)
      friday-workflow-run-routes.ts                             (new)
      friday-workflow-conflict-routes.ts                        (new)
      friday-fleet-routes.ts                                    (new)
      friday-security-routes.ts                                 (new)
      friday-realtime-routes.ts                                 (new)

  runtime/
    friday-api-runtime.types.ts                                 (new)
    friday-api-runtime.ts                                       (new)

src/state/sqlite/migrations/
  v002-phase8-api-foundation.ts                                 (new)
  index.ts                                                      (modify: register v002)

src/config/
  friday-config.types.ts                                        (modify: remove mirror config, add auth/rate-limit/realtime config)
  friday-config.schema.ts                                       (modify)
  friday-config-io.ts                                           (modify: migrate deprecated keys on load/write)

src/workflows/services/
  friday-workflow-execution-service.ts                          (modify: emit granular run/node events)
  friday-workflow-crud-service.ts                               (modify: emit workflow/version publish events)

src/workflows/builder/model/
  friday-workflow-builder-draft.types.ts                        (modify: conflict metadata fields)

src/workflows/builder/services/
  friday-workflow-builder-compositor-service.ts                 (modify: conflict detection + conflict record creation)

src/satellites/services/
  friday-satellite-heartbeat-service.ts                         (modify: emit satellite health events)
  friday-satellite-pairing-service.ts                           (modify: emit trust/revocation events)
  friday-satellite-capability-service.ts                        (modify: emit capability-updated events)

src/satellites/runtime/
  friday-satellite-runtime.ts                                   (modify: wire event publisher deps)
  friday-satellite-runtime.types.ts                             (modify)

src/state/paths/
  resolve-state-dir.ts                                          (modify: drop legacy-first fallback path behavior)

src/state/mirror/
  friday-compatibility-mirror.ts                                (modify: frozen/no-op legacy writes + deprecation markers)
  friday-compatibility-mirror.types.ts                          (modify: deprecation states)

src/state/index.ts                                              (modify: remove mirror-write counters from runtime summary)

test/unit/state/sqlite/
  v002-phase8-api-foundation-schema.test.ts                     (new)

test/unit/api/auth/
  friday-auth-service.test.ts                                   (new)
  friday-token-validator.test.ts                                (new)
  friday-rbac-policy.test.ts                                    (new)
  friday-rate-limit-service.test.ts                             (new)
  friday-auth-middleware.test.ts                                (new)

test/unit/api/realtime/
  friday-realtime-event-repository.test.ts                      (new)
  friday-realtime-subscription-service.test.ts                  (new)
  friday-realtime-ws-gateway.test.ts                            (new)

test/unit/api/fleet/
  friday-fleet-dashboard-repository.test.ts                     (new)
  friday-fleet-health-calculator.test.ts                        (new)
  friday-fleet-trust-calculator.test.ts                         (new)
  friday-fleet-dashboard-service.test.ts                        (new)

test/unit/api/conflicts/
  friday-workflow-conflict-service.test.ts                      (new)

test/unit/api/http/routes/
  friday-auth-routes.test.ts                                    (new)
  friday-workflow-routes.test.ts                                (new)
  friday-workflow-builder-routes.test.ts                        (new)
  friday-workflow-run-routes.test.ts                            (new)
  friday-workflow-conflict-routes.test.ts                       (new)
  friday-fleet-routes.test.ts                                   (new)
  friday-security-routes.test.ts                                (new)
  friday-realtime-routes.test.ts                                (new)

test/unit/api/legacy/
  friday-legacy-decommission-service.test.ts                    (new)
  friday-legacy-write-freeze-guard.test.ts                      (new)
```

## 2. Type definitions
```ts
// src/api/model/friday-api-common.types.ts
import type { ISODateTime, JsonObject, JsonValue, UUID } from "../../workflows/model/friday-workflow.types.js";

export type FridayHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type FridayPrincipalType = "user" | "satellite" | "service" | "workflow-runner";

export interface FridayPaginationQuery {
  cursor?: string;
  limit?: number; // default 50, max 200
}
export interface FridayPage<TItem> {
  items: TItem[];
  nextCursor?: string;
}

export interface FridayRequestMeta {
  requestId: string;
  traceId?: string;
  receivedAt: ISODateTime;
  ip?: string;
  userAgent?: string;
}

export interface FridayApiError {
  code: string;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
  retryAfterMs?: number;
}
export interface FridayApiErrorResponse {
  ok: false;
  error: FridayApiError;
  requestId: string;
}
export interface FridayApiSuccessResponse<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface FridayHttpContext<TParams, TQuery, TBody> extends FridayRequestMeta {
  params: TParams;
  query: TQuery;
  body: TBody;
  headers: Record<string, string | undefined>;
  principal: FridayAuthPrincipal | null;
}
export type FridayRouteHandler<TParams, TQuery, TBody, TResponse> = (
  ctx: FridayHttpContext<TParams, TQuery, TBody>,
) => Promise<TResponse>;

export interface FridayRouteDefinition<TParams, TQuery, TBody, TResponse> {
  operationId: string;
  method: FridayHttpMethod;
  path: string;
  auth:
    | { public: true }
    | { public: false; anyOfScopes: FridayScope[]; anyOfRoles?: FridayRole[] };
  rateLimitPolicyId?: FridayRateLimitPolicyId;
  handler: FridayRouteHandler<TParams, TQuery, TBody, TResponse>;
}

// src/api/model/friday-api-auth.types.ts
export type FridayRole = "owner" | "admin" | "operator" | "viewer";
export type FridayTokenKind = "access" | "refresh" | "api" | "satellite";

export type FridayScope =
  | "hub.admin"
  | "workflow.read"
  | "workflow.write"
  | "workflow.run"
  | "workflow.conflict.resolve"
  | "satellite.read"
  | "satellite.write"
  | "fleet.read"
  | "security.read"
  | "security.write"
  | "session.read"
  | "session.write"
  | "diagnosis.read"
  | "diagnosis.write"
  | "skill.read"
  | "skill.write";

export type FridayRateLimitPolicyId =
  | "auth.login"
  | "auth.refresh"
  | "auth.logout"
  | "workflow.start_run"
  | "workflow.publish"
  | "workflow.resolve_conflict"
  | "realtime.subscribe"
  | "realtime.pull"
  | "realtime.ws_connect";

export interface FridayAuthPrincipal {
  principalType: FridayPrincipalType;
  principalId: string;
  userId?: UUID;
  role?: FridayRole;
  scopes: FridayScope[];
  tokenId: UUID;
  tokenKind: FridayTokenKind;
  issuedAt: ISODateTime;
  expiresAt?: ISODateTime;
  sessionId?: UUID;
  tokenVersion?: number;
}

export interface FridayAccessTokenClaims {
  tokenId: UUID;
  principalType: FridayPrincipalType;
  principalId: string;
  userId?: UUID;
  role?: FridayRole;
  scopes: FridayScope[];
  iat: number;
  exp: number;
  sid?: UUID;
  ver?: number;
}
export interface FridayValidatedToken {
  principal: FridayAuthPrincipal;
  rawToken: string;
  claims?: FridayAccessTokenClaims;
}

export interface FridayLoginRequest {
  email?: string;
  password?: string;
  localPassphrase?: string;
  rememberMe?: boolean;
}
export interface FridayLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  user: {
    id: UUID;
    email?: string;
    displayName: string;
    role: FridayRole;
  };
}
export interface FridayRefreshRequest {
  refreshToken: string;
}
export interface FridayRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
}
export interface FridayLogoutRequest {
  refreshToken?: string;
  allSessions?: boolean;
}
export interface FridayLogoutResponse {
  ok: true;
}
export interface FridayAuthMeResponse {
  user: {
    id: UUID;
    email?: string;
    displayName: string;
    role: FridayRole;
  };
  scopes: FridayScope[];
  sessionExpiresAt?: ISODateTime;
}

export interface FridayRateLimitPolicy {
  id: FridayRateLimitPolicyId;
  windowMs: number;
  maxHits: number;
  keyBy: "ip" | "principal" | "principal+route" | "session";
}
export interface FridayRateLimitDecision {
  allowed: boolean;
  policyId: FridayRateLimitPolicyId;
  limit: number;
  remaining: number;
  resetAt: ISODateTime;
}

// src/api/model/friday-api-workflow.types.ts
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  WorkflowRunStatus,
  NodeAttemptStatus,
} from "../../workflows/model/friday-workflow.types.js";
import type { FridayWorkflowDraftEntity } from "../../workflows/builder/model/friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderValidationReport } from "../../workflows/builder/model/friday-workflow-builder-validation.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../workflows/model/friday-workflow-graph.types.js";
import type { FridayWorkflowSpecV1 } from "../../workflows/model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../../workflows/builder/model/friday-workflow-builder-canvas.types.js";

export interface FridayListWorkflowsQuery extends FridayPaginationQuery {
  tag?: string;
  archived?: boolean;
}
export interface FridayListWorkflowsResponse extends FridayPage<FridayWorkflowEntity> {}

export interface FridayCreateWorkflowRequest {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  graph: FridayCompiledWorkflowGraphV2;
}
export interface FridayCreateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version: FridayWorkflowVersionEntity;
}

export interface FridayGetWorkflowResponse {
  workflow: FridayWorkflowEntity;
  latestVersion: FridayWorkflowVersionEntity;
  publishedVersion?: FridayWorkflowVersionEntity;
}
export interface FridayUpdateWorkflowRequest {
  expectedRevision: number;
  etag: string;
  name?: string;
  description?: string;
  tags?: string[];
  graph?: FridayCompiledWorkflowGraphV2;
}
export interface FridayUpdateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version?: FridayWorkflowVersionEntity;
}
export interface FridayArchiveWorkflowResponse {
  archived: true;
}
export interface FridayPublishWorkflowRequest {
  versionNumber?: number;
  changeNote?: string;
}
export interface FridayPublishWorkflowResponse {
  publishedVersion: FridayWorkflowVersionEntity;
}
export interface FridayListVersionsQuery extends FridayPaginationQuery {}
export interface FridayListVersionsResponse extends FridayPage<FridayWorkflowVersionEntity> {}

export interface FridayCreateDraftRequest {
  title: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  ownerUserId?: UUID;
  baseWorkflowVersionId?: UUID;
}
export interface FridayCreateDraftResponse {
  draft: FridayWorkflowDraftEntity;
}
export interface FridayListDraftsResponse extends FridayPage<FridayWorkflowDraftEntity> {}
export interface FridayGetDraftResponse {
  draft: FridayWorkflowDraftEntity;
}
export interface FridaySaveDraftRequest {
  expectedRevision: number;
  lockToken: string;
  title?: string;
  spec?: FridayWorkflowSpecV1;
  visual?: FridayWorkflowVisualGraphV1;
  autosave?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}
export interface FridaySaveDraftResponse {
  draft: FridayWorkflowDraftEntity;
}
export interface FridayAutosaveDraftRequest {
  lockToken: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
}
export interface FridayAutosaveDraftResponse {
  draft: FridayWorkflowDraftEntity | null;
}
export interface FridayCompileDraftResponse {
  compiled: FridayCompiledWorkflowGraphV2;
  validation: FridayWorkflowBuilderValidationReport;
}
export interface FridayPublishDraftRequest {
  workflowId: UUID;
  lockToken: string;
  createdByUserId?: UUID;
  changeNote?: string;
  publishNow: boolean;
}
export interface FridayPublishDraftResponse {
  workflowId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}

export interface FridayAcquireWorkflowLockRequest {
  ownerUserId: UUID;
  ownerSessionId?: string;
  ttlSec: number;
}
export interface FridayAcquireWorkflowLockResponse {
  acquired: boolean;
  lock?: {
    workflowId: UUID;
    lockToken: string;
    ownerUserId: UUID;
    ownerSessionId?: string;
    acquiredAt: ISODateTime;
    heartbeatAt: ISODateTime;
    expiresAt: ISODateTime;
  };
  conflict?: {
    workflowId: UUID;
    lockToken: string;
    ownerUserId: UUID;
    ownerSessionId?: string;
    acquiredAt: ISODateTime;
    heartbeatAt: ISODateTime;
    expiresAt: ISODateTime;
  };
}
export interface FridayRenewWorkflowLockRequest {
  lockToken: string;
  ttlSec: number;
}
export interface FridayRenewWorkflowLockResponse {
  lock: FridayAcquireWorkflowLockResponse["lock"];
}
export interface FridayReleaseWorkflowLockRequest {
  lockToken: string;
}
export interface FridayReleaseWorkflowLockResponse {
  released: true;
}

export type FridayWorkflowConflictStatus = "open" | "resolved" | "dismissed";
export type FridayWorkflowConflictKind = "revision_conflict" | "lock_conflict";
export interface FridayWorkflowConflictEntity {
  conflictId: UUID;
  workflowId: UUID;
  draftId: UUID;
  kind: FridayWorkflowConflictKind;
  status: FridayWorkflowConflictStatus;
  baseWorkflowVersionId?: UUID;
  headWorkflowVersionId: UUID;
  detectedAt: ISODateTime;
  resolvedAt?: ISODateTime;
  resolvedByUserId?: UUID;
  summary: string;
  patches: Array<{
    path: string;
    op: "add" | "remove" | "replace";
    baseValue?: JsonValue;
    localValue?: JsonValue;
    headValue?: JsonValue;
  }>;
}
export interface FridayListWorkflowConflictsQuery extends FridayPaginationQuery {
  status?: FridayWorkflowConflictStatus;
}
export interface FridayListWorkflowConflictsResponse extends FridayPage<FridayWorkflowConflictEntity> {}
export interface FridayResolveWorkflowConflictRequest {
  resolution:
    | { strategy: "accept_local" }
    | { strategy: "accept_remote" }
    | {
        strategy: "manual_merge";
        mergedSpec: FridayWorkflowSpecV1;
        mergedVisual: FridayWorkflowVisualGraphV1;
      };
  lockToken: string;
  expectedDraftRevision: number;
}
export interface FridayResolveWorkflowConflictResponse {
  conflict: FridayWorkflowConflictEntity;
  draft: FridayWorkflowDraftEntity;
}

export interface FridayStartRunRequest {
  workflowId: UUID;
  workflowVersionId?: UUID;
  triggerType: string;
  triggerPayload?: JsonObject;
  dryRun?: boolean;
}
export interface FridayStartRunResponse {
  run: FridayWorkflowRunEntity;
}
export interface FridayGetRunResponse {
  run: FridayWorkflowRunEntity;
}
export interface FridayListRunNodesQuery extends FridayPaginationQuery {
  status?: NodeAttemptStatus;
}
export interface FridayListRunNodesResponse extends FridayPage<FridayWorkflowRunNodeEntity> {}
export interface FridayRunTimelineEntry {
  seq: number;
  streamId: string;
  event: string;
  emittedAt: ISODateTime;
  nodeId?: string;
  attempt?: number;
  status?: WorkflowRunStatus | NodeAttemptStatus;
  payload: JsonObject;
}
export interface FridayGetRunTimelineQuery extends FridayPaginationQuery {
  afterSeq?: number;
}
export interface FridayGetRunTimelineResponse extends FridayPage<FridayRunTimelineEntry> {}

export interface FridayCancelRunRequest {
  reason?: string;
}
export interface FridayCancelRunResponse {
  run: FridayWorkflowRunEntity;
}
export interface FridayRetryRunRequest {
  nodeIds?: string[];
}
export interface FridayRetryRunResponse {
  run: FridayWorkflowRunEntity;
  retriedNodes: string[];
}

// src/api/model/friday-api-fleet.types.ts
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
  FridaySatelliteType,
} from "../../satellites/model/friday-satellite.types.js";

export type FridayHealthState = "healthy" | "degraded" | "critical";
export type FridayTrustBand = "low" | "medium" | "high";

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
  trustBreakdown: FridaySatelliteTrustBreakdown;
  healthBreakdown: FridaySatelliteHealthBreakdown;
}

export interface FridaySatelliteHealthBreakdown {
  heartbeatScore: number;
  resourceScore: number;
  queueScore: number;
  reliabilityScore: number;
  finalScore: number;
  state: FridayHealthState;
}
export interface FridaySatelliteTrustBreakdown {
  identityScore: number;
  statusScore: number;
  hygieneScore: number;
  incidentPenalty: number;
  finalScore: number;
  band: FridayTrustBand;
  reasons: string[];
}

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

// src/api/model/friday-api-realtime.types.ts
export type FridayRealtimeTopic =
  | "workflow"
  | "workflow.run"
  | "workflow.node"
  | "workflow.conflict"
  | "satellite"
  | "fleet"
  | "security"
  | "diagnosis"
  | "approval";

export interface FridayRealtimeSubscription {
  subscriptionId: UUID;
  streamId: string;
  topic: FridayRealtimeTopic;
  workflowId?: UUID;
  runId?: UUID;
  satelliteId?: UUID;
  fromSeq?: number;
  includeSnapshot?: boolean;
}

export type FridayRealtimeEventName =
  | "workflow.updated"
  | "workflow.version.published"
  | "workflow.conflict.opened"
  | "workflow.conflict.resolved"
  | "workflow.run.started"
  | "workflow.run.paused"
  | "workflow.run.completed"
  | "workflow.run.failed"
  | "workflow.run.cancelled"
  | "workflow.node.queued"
  | "workflow.node.started"
  | "workflow.node.retrying"
  | "workflow.node.completed"
  | "workflow.node.failed"
  | "workflow.node.blocked_offline"
  | "satellite.updated"
  | "satellite.heartbeat"
  | "satellite.trust.updated"
  | "fleet.summary.updated"
  | "security.token.revoked"
  | "security.satellite.revoked";

export interface FridayRealtimeEventPayloadMap {
  "workflow.updated": { workflowId: UUID; revision: number; etag: string };
  "workflow.version.published": { workflowId: UUID; versionId: UUID; versionNumber: number };
  "workflow.conflict.opened": { conflictId: UUID; workflowId: UUID; draftId: UUID; kind: string };
  "workflow.conflict.resolved": { conflictId: UUID; workflowId: UUID; draftId: UUID; strategy: string };
  "workflow.run.started": { runId: UUID; workflowId: UUID; workflowVersionId: UUID };
  "workflow.run.paused": { runId: UUID; reason?: string };
  "workflow.run.completed": { runId: UUID; finishedAt: ISODateTime };
  "workflow.run.failed": { runId: UUID; error: { code: string; message: string } };
  "workflow.run.cancelled": { runId: UUID; cancelledBy?: UUID; reason?: string };
  "workflow.node.queued": { runId: UUID; nodeId: string; attempt: number };
  "workflow.node.started": { runId: UUID; nodeId: string; attempt: number; satelliteId?: UUID };
  "workflow.node.retrying": { runId: UUID; nodeId: string; attempt: number; nextAttemptAt: ISODateTime };
  "workflow.node.completed": { runId: UUID; nodeId: string; attempt: number; output?: JsonValue };
  "workflow.node.failed": { runId: UUID; nodeId: string; attempt: number; error: { code: string; message: string } };
  "workflow.node.blocked_offline": { runId: UUID; nodeId: string; attempt: number; satelliteId?: UUID; since: ISODateTime };
  "satellite.updated": { satelliteId: UUID; pairingStatus: string; trustLevel: string };
  "satellite.heartbeat": { satelliteId: UUID; ts: ISODateTime; status: string };
  "satellite.trust.updated": { satelliteId: UUID; trustScore: number; trustBand: string };
  "fleet.summary.updated": FridayFleetOverviewResponse;
  "security.token.revoked": { tokenId: UUID; principalType: string; principalId?: string };
  "security.satellite.revoked": { satelliteId: UUID; reason?: string };
}

export interface FridayRealtimeEventEnvelope<TEvent extends FridayRealtimeEventName = FridayRealtimeEventName> {
  eventId: UUID;
  streamId: string;
  seq: number;
  event: TEvent;
  payload: FridayRealtimeEventPayloadMap[TEvent];
  emittedAt: ISODateTime;
  correlationId?: string;
  stateVersion?: {
    workflow?: number;
    fleet?: number;
    security?: number;
  };
}

export type FridayRealtimeClientFrame =
  | { type: "hello"; token: string; subscriptions?: FridayRealtimeSubscription[] }
  | { type: "subscribe"; subscriptions: FridayRealtimeSubscription[] }
  | { type: "unsubscribe"; subscriptionIds: UUID[] }
  | { type: "ack"; streamId: string; seq: number; epoch: number; cursor?: string }
  | { type: "resume"; streamId: string; lastAckedSeq: number; epoch: number; cursor: string; subscriptions: FridayRealtimeSubscription[] }
  | { type: "ping"; at: ISODateTime };

export type FridayRealtimeServerFrame =
  | {
      type: "hello_ack";
      connId: UUID;
      protocolVersion: "1.0";
      serverVersion: string;
      epoch: number;
      now: ISODateTime;
    }
  | { type: "event"; envelope: FridayRealtimeEventEnvelope }
  | { type: "subscribed"; accepted: FridayRealtimeSubscription[]; rejected: Array<{ subscriptionId: UUID; code: string; message: string }> }
  | { type: "ack_ok"; streamId: string; seq: number }
  | { type: "pong"; at: ISODateTime }
  | { type: "resync_required"; streamId: string; reason: "STREAM_EPOCH_STALE" | "STREAM_CURSOR_OUT_OF_RANGE" | "CURSOR_INVALID"; snapshotEndpoint: string }
  | { type: "error"; code: string; message: string; retryable?: boolean; retryAfterMs?: number };

// HTTP fallback realtime DTOs
export interface FridayRealtimeSubscribeRequest {
  subscriptions: FridayRealtimeSubscription[];
}
export interface FridayRealtimeSubscribeResponse {
  subscriptions: FridayRealtimeSubscription[];
  epoch: number;
}
export interface FridayRealtimePullRequest {
  streamId: string;
  cursor?: string;
  afterSeq?: number;
  limit?: number;
}
export interface FridayRealtimePullResponse extends FridayPage<FridayRealtimeEventEnvelope> {
  streamId: string;
  epoch: number;
  nextCursor?: string;
  fullResyncRequired?: boolean;
}
export interface FridayRealtimeAckRequest {
  streamId: string;
  seq: number;
  epoch: number;
  cursor?: string;
}
export interface FridayRealtimeAckResponse {
  accepted: true;
  streamId: string;
  seq: number;
}
```

## 3. Route definitions
`FridayRouteDefinition<TParams, TQuery, TBody, TResponse>` is used for every route.  
Signatures below are the Phase 8 API contract.

### Auth
- `POST /v1/auth/login`: `FridayRouteHandler<{}, {}, FridayLoginRequest, FridayLoginResponse>` (`public`)
- `POST /v1/auth/refresh`: `FridayRouteHandler<{}, {}, FridayRefreshRequest, FridayRefreshResponse>` (`public`)
- `POST /v1/auth/logout`: `FridayRouteHandler<{}, {}, FridayLogoutRequest, FridayLogoutResponse>` (`authenticated`)
- `GET /v1/auth/me`: `FridayRouteHandler<{}, {}, {}, FridayAuthMeResponse>` (`authenticated`)

### Workflow CRUD
- `GET /v1/workflows`: `FridayRouteHandler<{}, FridayListWorkflowsQuery, {}, FridayListWorkflowsResponse>` (`workflow.read`)
- `POST /v1/workflows`: `FridayRouteHandler<{}, {}, FridayCreateWorkflowRequest, FridayCreateWorkflowResponse>` (`workflow.write`)
- `GET /v1/workflows/:workflowId`: `FridayRouteHandler<{workflowId: UUID}, {}, {}, FridayGetWorkflowResponse>` (`workflow.read`)
- `PATCH /v1/workflows/:workflowId`: `FridayRouteHandler<{workflowId: UUID}, {}, FridayUpdateWorkflowRequest, FridayUpdateWorkflowResponse>` (`workflow.write`)
- `DELETE /v1/workflows/:workflowId`: `FridayRouteHandler<{workflowId: UUID}, {}, {}, FridayArchiveWorkflowResponse>` (`workflow.write`)
- `POST /v1/workflows/:workflowId/publish`: `FridayRouteHandler<{workflowId: UUID}, {}, FridayPublishWorkflowRequest, FridayPublishWorkflowResponse>` (`workflow.write`)
- `GET /v1/workflows/:workflowId/versions`: `FridayRouteHandler<{workflowId: UUID}, FridayListVersionsQuery, {}, FridayListVersionsResponse>` (`workflow.read`)

### Builder / Draft CRUD
- `GET /v1/workflows/:workflowId/drafts`: `FridayRouteHandler<{workflowId: UUID}, FridayPaginationQuery, {}, FridayListDraftsResponse>` (`workflow.read`)
- `POST /v1/workflows/:workflowId/drafts`: `FridayRouteHandler<{workflowId: UUID}, {}, FridayCreateDraftRequest, FridayCreateDraftResponse>` (`workflow.write`)
- `GET /v1/workflows/:workflowId/drafts/:draftId`: `FridayRouteHandler<{workflowId: UUID; draftId: UUID}, {}, {}, FridayGetDraftResponse>` (`workflow.read`)
- `PATCH /v1/workflows/:workflowId/drafts/:draftId`: `FridayRouteHandler<{workflowId: UUID; draftId: UUID}, {}, FridaySaveDraftRequest, FridaySaveDraftResponse>` (`workflow.write`)
- `POST /v1/workflows/:workflowId/drafts/:draftId/autosave`: `FridayRouteHandler<{workflowId: UUID; draftId: UUID}, {}, FridayAutosaveDraftRequest, FridayAutosaveDraftResponse>` (`workflow.write`)
- `POST /v1/workflows/:workflowId/drafts/:draftId/compile`: `FridayRouteHandler<{workflowId: UUID; draftId: UUID}, {}, {}, FridayCompileDraftResponse>` (`workflow.read`)
- `POST /v1/workflows/:workflowId/drafts/:draftId/publish`: `FridayRouteHandler<{workflowId: UUID; draftId: UUID}, {}, FridayPublishDraftRequest, FridayPublishDraftResponse>` (`workflow.write`)

### Collaboration Locks
- `POST /v1/workflows/:workflowId/locks/acquire`: `FridayRouteHandler<{workflowId: UUID}, {}, FridayAcquireWorkflowLockRequest, FridayAcquireWorkflowLockResponse>` (`workflow.write`)
- `POST /v1/workflows/:workflowId/locks/renew`: `FridayRouteHandler<{workflowId: UUID}, {}, FridayRenewWorkflowLockRequest, FridayRenewWorkflowLockResponse>` (`workflow.write`)
- `POST /v1/workflows/:workflowId/locks/release`: `FridayRouteHandler<{workflowId: UUID}, {}, FridayReleaseWorkflowLockRequest, FridayReleaseWorkflowLockResponse>` (`workflow.write`)

### Conflict resolution
- `GET /v1/workflows/:workflowId/conflicts`: `FridayRouteHandler<{workflowId: UUID}, FridayListWorkflowConflictsQuery, {}, FridayListWorkflowConflictsResponse>` (`workflow.read`)
- `POST /v1/workflows/:workflowId/conflicts/:conflictId/resolve`: `FridayRouteHandler<{workflowId: UUID; conflictId: UUID}, {}, FridayResolveWorkflowConflictRequest, FridayResolveWorkflowConflictResponse>` (`workflow.conflict.resolve`)

### Run execution + visualization
- `POST /v1/workflow-runs`: `FridayRouteHandler<{}, {}, FridayStartRunRequest, FridayStartRunResponse>` (`workflow.run`)
- `GET /v1/workflow-runs/:runId`: `FridayRouteHandler<{runId: UUID}, {}, {}, FridayGetRunResponse>` (`workflow.read`)
- `GET /v1/workflow-runs/:runId/nodes`: `FridayRouteHandler<{runId: UUID}, FridayListRunNodesQuery, {}, FridayListRunNodesResponse>` (`workflow.read`)
- `GET /v1/workflow-runs/:runId/timeline`: `FridayRouteHandler<{runId: UUID}, FridayGetRunTimelineQuery, {}, FridayGetRunTimelineResponse>` (`workflow.read`)
- `POST /v1/workflow-runs/:runId/cancel`: `FridayRouteHandler<{runId: UUID}, {}, FridayCancelRunRequest, FridayCancelRunResponse>` (`workflow.run`)
- `POST /v1/workflow-runs/:runId/retry`: `FridayRouteHandler<{runId: UUID}, {}, FridayRetryRunRequest, FridayRetryRunResponse>` (`workflow.run`)

### Fleet dashboard + trust/security center
- `GET /v1/fleet/overview`: `FridayRouteHandler<{}, {}, {}, FridayFleetOverviewResponse>` (`fleet.read`)
- `GET /v1/fleet/satellites`: `FridayRouteHandler<{}, FridayListFleetSatellitesQuery, {}, FridayListFleetSatellitesResponse>` (`fleet.read`)
- `GET /v1/fleet/satellites/:satelliteId`: `FridayRouteHandler<{satelliteId: UUID}, {}, {}, FridayFleetSatelliteDetailResponse>` (`fleet.read`)
- `PATCH /v1/fleet/satellites/:satelliteId`: route body reuses existing satellite patch type (`satellite.write`)
- `GET /v1/security/center`: `FridayRouteHandler<{}, {}, {}, FridaySecurityCenterResponse>` (`security.read`)
- `POST /v1/security/tokens/revoke`: route body `{ tokenId: UUID }` (`security.write`)
- `POST /v1/security/satellites/:satelliteId/revoke`: route body `{ reason?: string }` (`security.write`)

### Realtime endpoints (HTTP fallback + WS)
- `GET /v1/realtime/ws`: WebSocket upgrade (auth required)
- `POST /v1/realtime/subscriptions`: `FridayRouteHandler<{}, {}, FridayRealtimeSubscribeRequest, FridayRealtimeSubscribeResponse>` (`workflow.read` or `fleet.read` based on topics)
- `POST /v1/realtime/pull`: `FridayRouteHandler<{}, {}, FridayRealtimePullRequest, FridayRealtimePullResponse>` (`same as subscription scope`)
- `POST /v1/realtime/ack`: `FridayRouteHandler<{}, {}, FridayRealtimeAckRequest, FridayRealtimeAckResponse>` (`same as subscription scope`)

## 4. WebSocket protocol
- Protocol endpoint: `GET /v1/realtime/ws` (Bearer token auth, same principal model as REST).
- Client frames: `hello`, `subscribe`, `unsubscribe`, `ack`, `resume`, `ping`.
- Server frames: `hello_ack`, `event`, `subscribed`, `ack_ok`, `pong`, `resync_required`, `error`.
- Stream model:
  - Stream IDs are deterministic: `workflow:<workflowId>`, `run:<runId>`, `satellite:<satelliteId>`, `fleet:global`, `security:global`.
  - Sequence (`seq`) is monotonic per stream.
  - Event persistence in `realtime_events` enables replay.
- Subscription model:
  - Client subscribes to topics with optional filters (`workflowId`, `runId`, `satelliteId`).
  - Server validates topic-to-scope mapping before accepting.
  - Rejected subscriptions return reason per subscription.
- Reconnection model:
  - Client stores `{streamId, lastAckedSeq, epoch, cursor}`.
  - On reconnect client sends `resume`.
  - Server verifies HMAC cursor, stream binding, seq, and epoch.
  - If valid: replay `seq > lastAckedSeq`.
  - If stale/out-of-range: send `resync_required` and require snapshot REST pull.
- Ack semantics:
  - Ack is monotonic; lower/equal ack is idempotent.
  - Checkpoint persisted in `realtime_checkpoints` keyed by `{principal_id, stream_id}`.
- Retention:
  - `realtime_events` TTL defaults to 24h (configurable).
  - Cleanup job purges old events and keeps last N per hot stream.
- Required event emission coverage:
  - Workflow: update/publish/run lifecycle/node lifecycle/conflicts.
  - Fleet: satellite heartbeat/status/trust and aggregate summary updates.
  - Security: token revocation and satellite revocation.

## 5. Fleet dashboard service
### Service surface
```ts
export interface FridayFleetDashboardService {
  getOverview(): FridayFleetOverviewResponse;
  listSatellites(input: FridayListFleetSatellitesQuery): FridayListFleetSatellitesResponse;
  getSatelliteDetail(satelliteId: UUID): FridayFleetSatelliteDetailResponse;
  getSecurityCenter(): FridaySecurityCenterResponse;
}
```

### Aggregation queries
```sql
-- Latest heartbeat per satellite
WITH latest AS (
  SELECT satellite_id, MAX(ts) AS max_ts
  FROM satellite_heartbeats
  GROUP BY satellite_id
)
SELECT s.id, s.display_name, s.type, s.pairing_status, s.trust_level, s.last_seen_at,
       h.ts, h.cpu_percent, h.memory_percent, h.load_avg_1m, h.queue_depth, h.active_runs
FROM satellites s
LEFT JOIN latest l ON l.satellite_id = s.id
LEFT JOIN satellite_heartbeats h ON h.satellite_id = l.satellite_id AND h.ts = l.max_ts
WHERE s.deleted_at IS NULL;
```

```sql
-- Queue stats by satellite
SELECT satellite_id,
  SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
  SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_count,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
  SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count
FROM outbox_messages
GROUP BY satellite_id;
```

```sql
-- Current run-node load by satellite (latest attempt per node)
WITH latest_attempt AS (
  SELECT run_id, node_id, MAX(attempt) AS max_attempt
  FROM workflow_run_nodes
  GROUP BY run_id, node_id
)
SELECT n.satellite_id,
  SUM(CASE WHEN n.status='queued' THEN 1 ELSE 0 END) AS queued_nodes,
  SUM(CASE WHEN n.status='running' THEN 1 ELSE 0 END) AS running_nodes,
  SUM(CASE WHEN n.status='retrying' THEN 1 ELSE 0 END) AS retrying_nodes,
  SUM(CASE WHEN n.status='blocked_offline' THEN 1 ELSE 0 END) AS blocked_offline_nodes
FROM workflow_run_nodes n
JOIN latest_attempt la
  ON la.run_id=n.run_id AND la.node_id=n.node_id AND la.max_attempt=n.attempt
GROUP BY n.satellite_id;
```

```sql
-- Fleet overview counters
SELECT pairing_status, COUNT(*) AS count
FROM satellites
WHERE deleted_at IS NULL
GROUP BY pairing_status;
```

### Health computation
- `heartbeatScore`:
  - `<30s` age: 100
  - `30-90s`: linear 100 -> 40
  - `>90s`: 10
- `resourceScore`:
  - `100 - max(cpuPercent, memoryPercent, normalizedLoad)`
- `queueScore`:
  - `100 - min((queueDepth / 100) * 100, 100)`
- `reliabilityScore`:
  - Based on dead-letter + failed node rates over 1h window.
- Final:
  - `finalScore = round(0.35*heartbeat + 0.25*resource + 0.20*queue + 0.20*reliability)`
  - `healthy >= 80`, `degraded 55-79`, `critical < 55`

### Trust computation
- Inputs: `pairingStatus`, `trustLevel`, token hygiene (`revoked_at`, `expires_at`, token_version), recent security findings.
- Formula:
  - `identityScore`: trusted 40, restricted 20
  - `statusScore`: online 30, degraded 20, paired 15, offline 10, pending 5, revoked 0
  - `hygieneScore`: 0..20 from token freshness/high-privilege token exposure
  - `incidentPenalty`: 0..40 based on recent revocations/findings
  - `finalScore = clamp(identity + status + hygiene - incidentPenalty, 0, 100)`
  - `band`: `high >= 70`, `medium 40-69`, `low < 40`

## 6. Legacy decommission
### Remove/deprecate
- Freeze legacy mirror writes immediately:
  - `executeFridayCompatibilityMirrorWrite` executes SQLite write only.
  - Any legacy write callback invocation returns deterministic `LEGACY_WRITE_FROZEN`.
- Remove deprecated config fields and behaviors:
  - Remove `mirror.enabled`, `mirror.mode`, `mirror.consistencyCheckOnStartup`.
  - Add migration-on-load to strip old keys and emit telemetry warning.
- Remove legacy state path preference:
  - Stop preferring old `~/.friday/state` when platform state dir exists.
- Remove deprecated session compatibility shims:
  - Remove old file-session/transcript write path hooks.
  - Keep only SQLite `sessions` and `session_messages` authority.

### Migration helpers
```ts
export interface FridayLegacyDecommissionService {
  runPreflight(): {
    deprecatedConfigKeys: string[];
    legacySessionFilesDetected: number;
    legacyMirrorCallsDetected: number;
  };
  createReadonlyLegacyBackup(): { backupDir: string; createdAt: ISODateTime };
  migrateDeprecatedConfigKeys(): { updated: boolean; removedKeys: string[] };
  freezeLegacyWrites(): { frozen: true; since: ISODateTime };
  verifyNoLegacyWrites(windowStart: ISODateTime): { ok: boolean; violations: string[] };
}
```

### Rollout sequence
1. Apply `v002-phase8-api-foundation`.
2. Enable write freeze guard and config key migration.
3. Run final session/config import helper (if legacy files detected), keep read-only backup.
4. Remove deprecated code paths and exports in same phase branch.
5. Block startup if legacy write code path is still wired.

## 7. Auth layer
### Token types
- `access` token: short-lived user/service token for REST + WS.
- `refresh` token: stored hashed in `auth_sessions`.
- `api` token: stored hashed in `api_tokens` for service automation.
- `satellite` token: stored hashed in `api_tokens`, version-bound to `satellites.token_version`.

### Middleware signatures
```ts
export type FridayHttpMiddleware = (
  ctx: FridayHttpContext<any, any, any>,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface FridayAuthMiddlewareFactory {
  requireAuth(): FridayHttpMiddleware;
  requireAnyScope(scopes: FridayScope[]): FridayHttpMiddleware;
  requireAnyRole(roles: FridayRole[]): FridayHttpMiddleware;
  enforceRateLimit(policyId: FridayRateLimitPolicyId): FridayHttpMiddleware;
}
```

### RBAC model
- `owner`: all scopes.
- `admin`: all operational scopes (`hub.admin`, workflow/satellite/fleet/security/session/diagnosis/skill).
- `operator`: workflow read/write/run, session read/write, satellite/fleet read, diagnosis read.
- `viewer`: read-only (`workflow.read`, `satellite.read`, `fleet.read`, `security.read`, `session.read`, `diagnosis.read`, `skill.read`).

### Rate limiting model
- Storage: SQLite table `api_rate_limit_counters(bucket_key, window_start, hit_count, updated_at)`.
- Policy defaults:
  - `auth.login`: 10/min by IP
  - `auth.refresh`: 30/min by session
  - `workflow.start_run`: 60/min by principal
  - `workflow.publish`: 20/min by principal
  - `workflow.resolve_conflict`: 20/min by principal
  - `realtime.subscribe`: 120/min by principal
  - `realtime.pull`: 300/min by principal
  - `realtime.ws_connect`: 20/min by principal
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## 8. Unit test plan
- Schema/migration tests:
  - `test/unit/state/sqlite/v002-phase8-api-foundation-schema.test.ts`
  - Validate tables/indexes: `realtime_events`, `realtime_checkpoints`, `api_rate_limit_counters`, `workflow_conflicts`.
- Auth tests:
  - Token validation (expired/revoked/version mismatch/signature failure).
  - RBAC allow/deny matrix.
  - Middleware chain behavior (`401`, `403`, `429`) and headers.
  - Rate limiter monotonic counting and window reset.
- Route contract tests:
  - Each new route validates input schema and error mapping.
  - Conflict routes enforce lock token and revision semantics.
  - Fleet/security routes enforce scopes.
- Realtime tests:
  - Subscribe/unsubscribe acceptance + scope filtering.
  - Event publish persists with per-stream sequence.
  - Ack monotonic behavior.
  - Resume success path with replay.
  - Resume stale epoch / invalid cursor -> `resync_required`.
- Fleet dashboard tests:
  - Aggregation query correctness across mixed satellite states.
  - Health score boundaries and state transitions.
  - Trust score banding and penalties.
- Conflict service tests:
  - Detects base-vs-head divergence.
  - Creates conflict record on publish race.
  - Resolve strategies (`accept_local`, `accept_remote`, `manual_merge`) update draft + conflict state.
- Legacy decommission tests:
  - Legacy write callbacks are never executed.
  - Deprecated config keys are migrated and removed.
  - Startup verification fails if legacy writes are still wired.
- Regression updates to existing tests:
  - Config schema tests (mirror keys removed).
  - Workflow execution tests (granular event emission assertions).
  - Satellite service tests (health/trust event emission).
