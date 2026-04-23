import type { ISODateTime, JsonValue, UUID } from "#workflows";
import type { FridayFleetOverviewResponse } from "./friday-api-fleet.types.js";
import type { FridayPage, FridayPaginationQuery } from "./friday-api-common.types.js";

// ─── Topics ───

export type FridayRealtimeTopic =
  | "workflow"
  | "workflow.run"
  | "workflow.node"
  | "workflow.conflict"
  | "satellite"
  | "fleet"
  | "security"
  | "diagnosis"
  | "approval"
  | "rules"
  | "execution"
  | "acceptance"
  | "retry"
  | "playbook";

// ─── Subscription ───

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

// ─── Event Names ───

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
  | "security.satellite.revoked"
  | "diagnosis.incident.opened"
  | "diagnosis.recorded"
  | "autofix.action.planned"
  | "autofix.action.pending_approval"
  | "autofix.action.approved"
  | "autofix.action.rejected"
  | "autofix.action.executed"
  | "autofix.action.rolled_back"
  // ─── Execution-control events ───
  | "rules.bundle.created"
  | "rules.bundle.updated"
  | "rules.rule.created"
  | "rules.rule.updated"
  | "rules.evaluation.completed"
  | "execution.node.started"
  | "execution.node.completed"
  | "execution.node.failed"
  | "acceptance.gate.evaluated"
  | "acceptance.gate.passed"
  | "acceptance.gate.failed"
  | "retry.attempt.scheduled"
  | "retry.attempt.started"
  | "retry.attempt.exhausted"
  | "retry.dlq.enqueued"
  | "playbook.selected"
  | "playbook.candidate.created"
  | "playbook.candidate.promoted"
  | "playbook.score.recalculated"
  | "playbook.rollback.completed";

// ─── Event Payload Map ───

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
  "diagnosis.incident.opened": {
    incidentId: UUID;
    userId: UUID;
    runId?: UUID;
    category: string;
    severity: string;
    signature: string;
    status: string;
  };
  "diagnosis.recorded": {
    diagnosisId: UUID;
    incidentId?: UUID;
    confidence: number;
    errorFingerprint: string;
  };
  "autofix.action.planned": {
    actionId: UUID;
    incidentId: UUID;
    runId?: UUID;
    riskTier: number;
    status: string;
    outcome: string | null;
    approvalStatus?: string;
  };
  "autofix.action.pending_approval": {
    actionId: UUID;
    incidentId: UUID;
    runId?: UUID;
    riskTier: number;
    status: string;
    outcome: string | null;
    approvalStatus?: string;
  };
  "autofix.action.approved": {
    actionId: UUID;
    incidentId: UUID;
    runId?: UUID;
    riskTier: number;
    status: string;
    outcome: string | null;
    approvalStatus?: string;
  };
  "autofix.action.rejected": {
    actionId: UUID;
    incidentId: UUID;
    runId?: UUID;
    riskTier: number;
    status: string;
    outcome: string | null;
    approvalStatus?: string;
  };
  "autofix.action.executed": {
    actionId: UUID;
    incidentId: UUID;
    runId?: UUID;
    riskTier: number;
    status: string;
    outcome: string | null;
    approvalStatus?: string;
  };
  "autofix.action.rolled_back": {
    actionId: UUID;
    incidentId: UUID;
    runId?: UUID;
    riskTier: number;
    status: string;
    outcome: string | null;
    approvalStatus?: string;
  };

  // ─── Rules events ───
  "rules.bundle.created": { bundleId: string; name: string };
  "rules.bundle.updated": { bundleId: string; fields: string[] };
  "rules.rule.created": { ruleId: string; bundleId?: string; resource: string; action: string };
  "rules.rule.updated": { ruleId: string; fields: string[] };
  "rules.evaluation.completed": { evaluationId: string; resource: string; decision: string; ruleCount: number };

  // ─── Execution events ───
  "execution.node.started": { executionId: string; runId: string; nodeId: string; attempt: number };
  "execution.node.completed": { executionId: string; runId: string; nodeId: string; attempt: number; durationMs: number };
  "execution.node.failed": { executionId: string; runId: string; nodeId: string; attempt: number; errorCode: string; errorMessage: string };

  // ─── Acceptance events ───
  "acceptance.gate.evaluated": { resultId: string; executionId: string; runId: string; verdict: string; suiteCount: number };
  "acceptance.gate.passed": { resultId: string; executionId: string; runId: string };
  "acceptance.gate.failed": { resultId: string; executionId: string; runId: string; failedSuites: string[] };

  // ─── Retry events ───
  "retry.attempt.scheduled": { contextId: string; runId: string; nodeId: string; attempt: number; nextAttemptAt: string };
  "retry.attempt.started": { contextId: string; runId: string; nodeId: string; attempt: number };
  "retry.attempt.exhausted": { contextId: string; runId: string; nodeId: string; totalAttempts: number; failureCategory: string };
  "retry.dlq.enqueued": { entryId: string; contextId: string; failureCategory: string; reason: string };

  // ─── Playbook events ───
  "playbook.selected": { playbookId: string; workflowType: string; runId?: string; reason: string };
  "playbook.candidate.created": { candidateId: string; workflowType: string; fingerprint: string };
  "playbook.candidate.promoted": { candidateId: string; playbookId: string; decision: string };
  "playbook.score.recalculated": { playbookId: string; score: number; sampleSize: number };
  "playbook.rollback.completed": { playbookId: string; fromVersion: number; toVersion: number; reason: string };
}

// ─── Event Envelope ───

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

// ─── Client Frames ───

export type FridayRealtimeClientFrame =
  | { type: "hello"; token: string; subscriptions?: FridayRealtimeSubscription[] }
  | { type: "subscribe"; subscriptions: FridayRealtimeSubscription[] }
  | { type: "unsubscribe"; subscriptionIds: UUID[] }
  | { type: "ack"; streamId: string; seq: number; epoch: number; cursor?: string }
  | { type: "resume"; streamId: string; lastAckedSeq: number; epoch: number; cursor: string; subscriptions: FridayRealtimeSubscription[] }
  | { type: "ping"; at: ISODateTime };

// ─── Server Frames ───

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

export interface FridayRealtimeEncryptedFrameEnvelope {
  type: "encrypted";
  envelopeVersion: 1;
  alg: "A256GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export type FridayRealtimeClientWireFrame = FridayRealtimeClientFrame | FridayRealtimeEncryptedFrameEnvelope;
export type FridayRealtimeServerWireFrame = FridayRealtimeServerFrame | FridayRealtimeEncryptedFrameEnvelope;

// ─── HTTP Fallback DTOs ───

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

// ─── Agent Realtime Events ───
// These are API-layer event types used in SSE/WebSocket payloads.
// They may differ from domain-layer FridayAgentEventMap names (e.g.,
// "agent.run.testing" here vs no corresponding domain event yet).
// See src/agent/model/friday-agent.types.ts for the canonical domain events.

export type FridayAgentRunEventType =
  | "agent.run.started"
  | "agent.run.planning"
  | "agent.run.executing"
  | "agent.run.testing"
  | "agent.run.fixing"
  | "agent.run.completed"
  | "agent.run.failed"
  | "agent.run.cancelled";

export interface FridayAgentRunEvent {
  type: FridayAgentRunEventType;
  runId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type FridayAgentToolEventType =
  | "agent.tool.started"
  | "agent.tool.completed"
  | "agent.tool.failed";

export interface FridayAgentToolEvent {
  type: FridayAgentToolEventType;
  runId: string;
  toolName: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type FridayAgentTextEventType =
  | "agent.text.delta"
  | "agent.text.complete";

export interface FridayAgentTextEvent {
  type: FridayAgentTextEventType;
  runId: string;
  text: string;
  timestamp: string;
}

export type FridayAgentRealtimeEvent =
  | FridayAgentRunEvent
  | FridayAgentToolEvent
  | FridayAgentTextEvent;
