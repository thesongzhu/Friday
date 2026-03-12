> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 2 Code Review Package (Round 2)

## Build & Test Results
- TypeScript compilation: CLEAN (zero errors)
- Test suite: 286 tests passed (42 test files), 0 failures
- Duration: 995ms

## Round 1 Issues Fixed (all 11)
1. [HIGH] Full handshake auth with challenge signature, nonce, algorithm negotiation, ephemeral keys
2. [HIGH] Token expiry enforced in lookup query
3. [HIGH] Token version stored in label, validated during handshake
4. [HIGH] Idempotent enqueue returns existing ID on duplicate
5. [MEDIUM] Cursor stream/seq binding validated in push()
6. [MEDIUM] Epoch bumped at runtime boot
7. [MEDIUM] Capability revision persisted in hub_settings
8. [MEDIUM] rejectPairing ownership check added
9. [MEDIUM] Heartbeat boundary changed to >= 30000
10. [LOW] 5 handshake rejection tests added
11. [LOW] Checkpoint rollback failure test added

## Source Code (Phase 2 files only)

### `src/jobs/index.ts`
```ts
export * from "./retention/friday-retention.types.js";
export { createFridayRetentionJob } from "./retention/friday-retention-job.js";
```

### `src/jobs/retention/friday-retention-job.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySatellitePairingRequestRepository } from "../../satellites/persistence/friday-satellite-pairing-request-repository.js";
import type { FridaySatelliteHeartbeatRepository } from "../../satellites/persistence/friday-satellite-heartbeat-repository.js";
import type { FridayOutboxMessageRepository } from "../../satellites/persistence/friday-outbox-message-repository.js";
import type { FridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import type { FridaySkillRunStore } from "../../ledger/runs/friday-skill-run-store.js";
import type {
  FridayRetentionPolicy,
  FridayRetentionJobResult,
} from "./friday-retention.types.js";
import { FRIDAY_DEFAULT_RETENTION_POLICY } from "./friday-retention.types.js";

export interface FridayRetentionJob {
  run(nowIso?: string): FridayRetentionJobResult;
}

export interface CreateRetentionJobDeps {
  db: FridaySqliteLayer;
  pairingRequestRepo: FridaySatellitePairingRequestRepository;
  heartbeatRepo: FridaySatelliteHeartbeatRepository;
  outboxRepo: FridayOutboxMessageRepository;
  learningLedger: FridayLearningEventLedger;
  skillRunStore: FridaySkillRunStore;
  policy?: FridayRetentionPolicy;
  nowIso: () => string;
}

function subtractDays(isoDate: string, days: number): string {
  const ms = new Date(isoDate).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

export function createFridayRetentionJob(deps: CreateRetentionJobDeps): FridayRetentionJob {
  const policy = deps.policy ?? FRIDAY_DEFAULT_RETENTION_POLICY;

  return {
    run(nowIsoOverride?) {
      const nowIso = nowIsoOverride ?? deps.nowIso();

      // All cleanup runs in one write transaction for atomicity
      return deps.db.withWriteTransaction((db) => {
        // 1. Mark stale pending pairing requests as expired
        const pairingCutoff = nowIso;
        const staleRequests = deps.pairingRequestRepo.listPendingExpiredBefore(db, pairingCutoff);
        for (const req of staleRequests) {
          deps.pairingRequestRepo.updateStatus(db, req.id, "expired", null, nowIso);
        }
        const markedPairingExpired = staleRequests.length;

        // 2. Delete old resolved pairing requests
        const pairingDeleteCutoff = subtractDays(nowIso, policy.pairingRequestsDays);
        const deletedPairingRequests = deps.pairingRequestRepo.deleteResolvedBefore(
          db,
          pairingDeleteCutoff,
        );

        // 3. Delete old heartbeat rows
        const heartbeatCutoff = subtractDays(nowIso, policy.heartbeatsDays);
        const deletedHeartbeats = deps.heartbeatRepo.deleteBefore(db, heartbeatCutoff);

        // 4. Mark TTL-breached outbox rows as expired
        const markedOutboxExpired = deps.outboxRepo.expireByTtl(db, nowIso);

        // 5. Delete old terminal outbox rows
        const outboxDeleteCutoff = subtractDays(nowIso, policy.outboxTerminalDays);
        const deletedOutboxTerminal = deps.outboxRepo.deleteTerminalBefore(db, outboxDeleteCutoff);

        // 6. Delete old learning events
        const learningCutoff = subtractDays(nowIso, policy.learningEventsDays);
        const deletedLearningEvents = db
          .prepare("DELETE FROM learning_events WHERE ts < ?")
          .run(learningCutoff).changes;

        // 7. Delete terminal skill run snapshots
        const skillRunCutoff = subtractDays(nowIso, policy.skillRunTerminalDays);
        let deletedSkillRuns = 0;
        for (const status of ["completed", "failed", "cancelled"]) {
          const result = db
            .prepare(
              "DELETE FROM memory_items WHERE namespace = 'skill_runs' AND tags_json LIKE ? AND updated_at < ?",
            )
            .run(`%"status:${status}"%`, skillRunCutoff);
          deletedSkillRuns += result.changes;
        }

        return {
          markedPairingExpired,
          deletedPairingRequests,
          deletedHeartbeats,
          markedOutboxExpired,
          deletedOutboxTerminal,
          deletedLearningEvents,
          deletedSkillRuns,
        };
      });
    },
  };
}
```

### `src/jobs/retention/friday-retention.types.ts`
```ts
export interface FridayRetentionPolicy {
  learningEventsDays: number;
  heartbeatsDays: number;
  pairingRequestsDays: number;
  outboxTerminalDays: number;
  skillRunTerminalDays: number;
}

export const FRIDAY_DEFAULT_RETENTION_POLICY: FridayRetentionPolicy = {
  learningEventsDays: 90,
  heartbeatsDays: 7,
  pairingRequestsDays: 7,
  outboxTerminalDays: 14,
  skillRunTerminalDays: 30,
};

export interface FridayRetentionJobResult {
  markedPairingExpired: number;
  deletedPairingRequests: number;
  deletedHeartbeats: number;
  markedOutboxExpired: number;
  deletedOutboxTerminal: number;
  deletedLearningEvents: number;
  deletedSkillRuns: number;
}
```

### `src/ledger/index.ts`
```ts
// Learning event ledger
export * from "./learning/friday-learning-event-ledger.types.js";
export { createFridayLearningEventLedger } from "./learning/friday-learning-event-ledger.js";

// Skill run store
export * from "./runs/friday-skill-run-store.types.js";
export { createFridaySkillRunStore } from "./runs/friday-skill-run-store.js";
export { createFridaySkillRunCheckpointWriter } from "./runs/friday-skill-run-checkpoint-writer.js";
```

### `src/ledger/learning/friday-learning-event-ledger.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayLearningEventAppendInput,
  FridayLearningEventKind,
} from "./friday-learning-event-ledger.types.js";

export interface FridayLearningEventLedger {
  appendEvent(input: FridayLearningEventAppendInput): { inserted: boolean };
  appendBatch(inputs: FridayLearningEventAppendInput[]): Array<{ eventId: string; inserted: boolean }>;
  listByUser(input: {
    userId: string;
    kinds?: FridayLearningEventKind[];
    fromTs?: string;
    toTs?: string;
    limit?: number;
  }): FridayLearningEventAppendInput[];
  pruneBefore(cutoffIso: string): number;
}

export interface CreateLearningEventLedgerDeps {
  db: FridaySqliteLayer;
}

export function createFridayLearningEventLedger(
  deps: CreateLearningEventLedgerDeps,
): FridayLearningEventLedger {
  return {
    appendEvent(input) {
      return deps.db.withWriteTransaction((db) => {
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO learning_events (
              event_id, ts, user_id, session_id, run_id, kind, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.eventId,
            input.ts,
            input.userId,
            input.sessionId ?? null,
            input.runId ?? null,
            input.kind,
            JSON.stringify(input.payload),
            input.ts,
          );
        return { inserted: result.changes > 0 };
      });
    },

    appendBatch(inputs) {
      return deps.db.withWriteTransaction((db) => {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO learning_events (
            event_id, ts, user_id, session_id, run_id, kind, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        return inputs.map((input) => {
          const result = stmt.run(
            input.eventId,
            input.ts,
            input.userId,
            input.sessionId ?? null,
            input.runId ?? null,
            input.kind,
            JSON.stringify(input.payload),
            input.ts,
          );
          return { eventId: input.eventId, inserted: result.changes > 0 };
        });
      });
    },

    listByUser(input) {
      return deps.db.withReadConnection((db) => {
        let sql = "SELECT * FROM learning_events WHERE user_id = ?";
        const params: unknown[] = [input.userId];

        if (input.kinds?.length) {
          const placeholders = input.kinds.map(() => "?").join(", ");
          sql += ` AND kind IN (${placeholders})`;
          params.push(...input.kinds);
        }

        if (input.fromTs) {
          sql += " AND ts >= ?";
          params.push(input.fromTs);
        }

        if (input.toTs) {
          sql += " AND ts <= ?";
          params.push(input.toTs);
        }

        sql += " ORDER BY ts DESC";

        if (input.limit) {
          sql += " LIMIT ?";
          params.push(input.limit);
        }

        const rows = db.prepare(sql).all(...params) as Array<{
          event_id: string;
          ts: string;
          user_id: string;
          session_id: string | null;
          run_id: string | null;
          kind: FridayLearningEventKind;
          payload_json: string;
        }>;

        return rows.map((row) => ({
          eventId: row.event_id,
          ts: row.ts,
          userId: row.user_id,
          sessionId: row.session_id ?? undefined,
          runId: row.run_id ?? undefined,
          kind: row.kind,
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        }));
      });
    },

    pruneBefore(cutoffIso) {
      return deps.db.withWriteTransaction((db) => {
        const result = db
          .prepare("DELETE FROM learning_events WHERE ts < ?")
          .run(cutoffIso);
        return result.changes;
      });
    },
  };
}
```

### `src/ledger/learning/friday-learning-event-ledger.types.ts`
```ts
export type FridayLearningEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "user_correction"
  | "error_incident"
  | "workflow_outcome";

export interface FridayLearningEventAppendInput {
  eventId: string;
  ts: string;
  userId: string;
  sessionId?: string;
  runId?: string;
  kind: FridayLearningEventKind;
  payload: Record<string, unknown>;
}
```

### `src/ledger/runs/friday-skill-run-checkpoint-writer.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningEventAppendInput } from "../learning/friday-learning-event-ledger.types.js";
import type { FridaySkillRunSnapshot } from "./friday-skill-run-store.types.js";

export interface FridaySkillRunCheckpointWriter {
  persistCheckpoint<TState>(input: {
    run: FridaySkillRunSnapshot<TState>;
    learningEvent?: FridayLearningEventAppendInput;
  }): { runPersisted: true; eventInserted?: boolean };
}

export interface CreateCheckpointWriterDeps {
  db: FridaySqliteLayer;
}

const NAMESPACE = "skill_runs";

/**
 * Persists a skill run snapshot and an optional learning event
 * atomically within a single SQLite write transaction.
 */
export function createFridaySkillRunCheckpointWriter(
  deps: CreateCheckpointWriterDeps,
): FridaySkillRunCheckpointWriter {
  return {
    persistCheckpoint<TState>(input: {
      run: FridaySkillRunSnapshot<TState>;
      learningEvent?: FridayLearningEventAppendInput;
    }) {
      return deps.db.withWriteTransaction((db) => {
        const snapshot = input.run;

        // 1. Upsert run snapshot in memory_items
        db.prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        ).run(
          snapshot.runId,
          NAMESPACE,
          snapshot.runId,
          JSON.stringify(snapshot),
          JSON.stringify([
            `skill:${snapshot.skillId}`,
            `status:${snapshot.status}`,
            `user:${snapshot.userId}`,
          ]),
          snapshot.startedAt,
          snapshot.updatedAt,
        );

        // 2. Append learning event (optional)
        let eventInserted: boolean | undefined;
        if (input.learningEvent) {
          const ev = input.learningEvent;
          const result = db
            .prepare(
              `INSERT OR IGNORE INTO learning_events (
                event_id, ts, user_id, session_id, run_id, kind, payload_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ev.eventId,
              ev.ts,
              ev.userId,
              ev.sessionId ?? null,
              ev.runId ?? null,
              ev.kind,
              JSON.stringify(ev.payload),
              ev.ts,
            );
          eventInserted = result.changes > 0;
        }

        return { runPersisted: true as const, eventInserted };
      });
    },
  };
}
```

### `src/ledger/runs/friday-skill-run-store.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { SkillRunStatus } from "../../skills/model/friday-skill-runtime.types.js";
import type { FridaySkillRunSnapshot, FridaySkillRunListInput } from "./friday-skill-run-store.types.js";

export interface FridaySkillRunStore {
  upsertRun<TState>(snapshot: FridaySkillRunSnapshot<TState>): void;
  getRun<TState = unknown>(runId: string): FridaySkillRunSnapshot<TState> | null;
  listRuns(input?: FridaySkillRunListInput): FridaySkillRunSnapshot[];
  pruneTerminalRunsBefore(cutoffIso: string): number;
}

export interface CreateSkillRunStoreDeps {
  db: FridaySqliteLayer;
}

const NAMESPACE = "skill_runs";

/** Terminal statuses that can be pruned. */
const TERMINAL_STATUSES: SkillRunStatus[] = ["completed", "failed", "cancelled"];

export function createFridaySkillRunStore(
  deps: CreateSkillRunStoreDeps,
): FridaySkillRunStore {
  return {
    upsertRun<TState>(snapshot: FridaySkillRunSnapshot<TState>) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        ).run(
          snapshot.runId,
          NAMESPACE,
          snapshot.runId,
          JSON.stringify(snapshot),
          JSON.stringify([`skill:${snapshot.skillId}`, `status:${snapshot.status}`, `user:${snapshot.userId}`]),
          snapshot.startedAt,
          snapshot.updatedAt,
        );
      });
    },

    getRun<TState = unknown>(runId: string): FridaySkillRunSnapshot<TState> | null {
      return deps.db.withReadConnection((db) => {
        const row = db
          .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
          .get(NAMESPACE, runId) as { value_json: string } | undefined;
        if (!row) return null;
        return JSON.parse(row.value_json) as FridaySkillRunSnapshot<TState>;
      });
    },

    listRuns(input) {
      return deps.db.withReadConnection((db) => {
        let sql = "SELECT value_json FROM memory_items WHERE namespace = ?";
        const params: unknown[] = [NAMESPACE];

        // We filter by tags to support skill/status/user filtering
        if (input?.skillId) {
          sql += " AND tags_json LIKE ?";
          params.push(`%"skill:${input.skillId}"%`);
        }
        if (input?.status) {
          sql += " AND tags_json LIKE ?";
          params.push(`%"status:${input.status}"%`);
        }
        if (input?.userId) {
          sql += " AND tags_json LIKE ?";
          params.push(`%"user:${input.userId}"%`);
        }

        sql += " ORDER BY updated_at DESC";

        if (input?.limit) {
          sql += " LIMIT ?";
          params.push(input.limit);
        }

        const rows = db.prepare(sql).all(...params) as Array<{ value_json: string }>;
        return rows.map((row) => JSON.parse(row.value_json) as FridaySkillRunSnapshot);
      });
    },

    pruneTerminalRunsBefore(cutoffIso) {
      return deps.db.withWriteTransaction((db) => {
        // Build tag-based filter for terminal statuses
        let total = 0;
        for (const status of TERMINAL_STATUSES) {
          const result = db
            .prepare(
              "DELETE FROM memory_items WHERE namespace = ? AND tags_json LIKE ? AND updated_at < ?",
            )
            .run(NAMESPACE, `%"status:${status}"%`, cutoffIso);
          total += result.changes;
        }
        return total;
      });
    },
  };
}
```

### `src/ledger/runs/friday-skill-run-store.types.ts`
```ts
import type { SkillRunState, SkillRunStatus } from "../../skills/model/friday-skill-runtime.types.js";

export interface FridaySkillRunSnapshot<TState = unknown> extends SkillRunState<TState> {
  sessionId: string;
  userId: string;
  channel: string;
  lastTransitionAt: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySkillRunListInput {
  skillId?: string;
  status?: SkillRunStatus;
  userId?: string;
  limit?: number;
}
```

### `src/satellites/index.ts`
```ts
// Model types
export * from "./model/friday-satellite.types.js";
export * from "./model/friday-satellite-protocol.types.js";
export * from "./model/friday-satellite-health.types.js";
export * from "./model/friday-outbox.types.js";

// Persistence
export { createFridaySatelliteRepository } from "./persistence/friday-satellite-repository.js";
export { createFridaySatellitePairingRequestRepository } from "./persistence/friday-satellite-pairing-request-repository.js";
export { createFridaySatelliteCapabilityRepository } from "./persistence/friday-satellite-capability-repository.js";
export { createFridaySatelliteHeartbeatRepository } from "./persistence/friday-satellite-heartbeat-repository.js";
export { createFridayOutboxMessageRepository } from "./persistence/friday-outbox-message-repository.js";
export { createFridayStreamCheckpointRepository } from "./persistence/friday-stream-checkpoint-repository.js";
export { createFridayApiTokenRepository } from "./persistence/friday-api-token-repository.js";

// Protocol
export { createFridayResumeCursorSigner } from "./protocol/friday-resume-cursor-signer.js";
export { createFridayAckResumeValidator } from "./protocol/friday-ack-resume-validator.js";

// Services
export { createFridaySatelliteRegistrationService } from "./services/friday-satellite-registration-service.js";
export { createFridaySatellitePairingService } from "./services/friday-satellite-pairing-service.js";
export { createFridaySatelliteCapabilityService } from "./services/friday-satellite-capability-service.js";
export { createFridaySatelliteHeartbeatService } from "./services/friday-satellite-heartbeat-service.js";
export { createFridaySatelliteOfflineSweeper } from "./services/friday-satellite-offline-sweeper.js";
export { createFridayOutboxQueueService } from "./services/friday-outbox-queue-service.js";
export { createFridaySatelliteSyncService } from "./services/friday-satellite-sync-service.js";

// Runtime
export * from "./runtime/friday-satellite-runtime.types.js";
export { createFridaySatelliteRuntime } from "./runtime/friday-satellite-runtime.js";
```

### `src/satellites/model/friday-outbox.types.ts`
```ts
export type FridayOutboxStatus =
  | "queued"
  | "leased"
  | "acked"
  | "failed"
  | "dead_letter"
  | "expired";

export interface FridayOutboxEnqueueInput {
  satelliteId: string;
  queueKey: string;
  messageType: string;
  payloadCiphertext: string;
  nonce: string;
  keyId: string;
  idempotencyKey: string;
  maxAttempts?: number;
  deliverAfter?: string;
  expiresAt?: string;
}

export interface FridayOutboxMessageRow {
  id: string;
  satellite_id: string;
  queue_key: string;
  message_type: string;
  payload_ciphertext: string;
  nonce: string;
  key_id: string;
  idempotency_key: string;
  status: FridayOutboxStatus;
  attempts: number;
  max_attempts: number;
  deliver_after: string | null;
  expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  leased_until: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayOutboxLeasedItem {
  id: string;
  seq: number;
  payloadCiphertext: string;
  messageType: string;
}
```

### `src/satellites/model/friday-satellite-health.types.ts`
```ts
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
```

### `src/satellites/model/friday-satellite-protocol.types.ts`
```ts
/**
 * Protocol types for satellite ACK/resume that extend
 * the base WS frame types in friday-hub-gateway-ingress.types.ts.
 *
 * The core FridayWsAckFrame, FridayWsResumeFrame, and FridayWsEventFrame
 * already exist in the hub service types — we DO NOT redefine them here.
 * This file contains only protocol-layer abstractions for cursor signing
 * and ack/resume validation.
 */

export interface FridayResumeCursorPayload {
  seq: number;
  streamId: string;
  epoch: number;
  issuedAt: string;
}

export type FridayResumeValidationResult =
  | { ok: true; effectiveSeq: number }
  | {
      ok: false;
      code: "AUTH_UNAUTHORIZED" | "STREAM_EPOCH_STALE" | "STREAM_CURSOR_OUT_OF_RANGE";
      message: string;
    };

export interface FridayStreamCheckpoint {
  satelliteId: string;
  streamId: string;
  seq: number;
  updatedAt: string;
}
```

### `src/satellites/model/friday-satellite.types.ts`
```ts
export type FridaySatelliteType = "phone" | "desktop" | "rpi" | "cloud-vm" | "custom";

export type FridaySatellitePairingStatus =
  | "pending"
  | "paired"
  | "online"
  | "degraded"
  | "offline"
  | "revoked";

export type FridaySatelliteTrustLevel = "restricted" | "trusted";

export interface FridaySatelliteRuntimeInfo {
  platform: string;
  arch: string;
  appVersion: string;
  nodeVersion: string;
}

export interface FridaySatelliteRegistrationInput {
  type: FridaySatelliteType;
  displayName: string;
  publicKey: string;
  runtime: FridaySatelliteRuntimeInfo;
  transport: "ws" | "http-poll" | "mixed";
  requestedByIp?: string;
  requestedByUserAgent?: string;
  capabilityReport?: FridaySatelliteCapabilityReport;
}

export interface FridaySatelliteCapabilityReport {
  satelliteId: string;
  revision: number;
  generatedAt: string;
  runtime: { os: string; arch: string; appVersion: string; nodeVersion: string };
  capabilities: FridaySatelliteCapabilityEntry[];
}

export interface FridaySatelliteCapabilityEntry {
  key: string;
  available: boolean;
  metadata?: Record<string, unknown>;
  limits?: { maxConcurrency?: number; timeoutMs?: number; maxPayloadBytes?: number };
}

export interface FridaySatelliteHeartbeatInput {
  satelliteId: string;
  ts: string;
  metrics?: { cpuPercent?: number; memoryPercent?: number; loadAvg1m?: number };
  queueDepth?: number;
  activeRuns?: number;
  lastSuccessfulCommandAt?: string;
  failureRate1m?: number;
  explicitDisconnect?: boolean;
  details?: Record<string, unknown>;
}

export interface FridaySatelliteRow {
  id: string;
  type: FridaySatelliteType;
  display_name: string;
  pairing_status: FridaySatellitePairingStatus;
  trust_level: FridaySatelliteTrustLevel;
  public_key: string;
  token_version: number;
  local_ip: string | null;
  external_ip: string | null;
  transport: string;
  platform: string;
  arch: string;
  app_version: string;
  node_version: string;
  tags_json: string;
  metadata_json: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface FridaySatellitePairingRequestRow {
  id: string;
  satellite_id: string;
  code: string;
  nonce: string;
  requested_by_ip: string | null;
  requested_by_user_agent: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: string;
  resolved_at: string | null;
  resolver_user_id: string | null;
  satellite_payload_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayApiTokenRow {
  id: string;
  user_id: string | null;
  principal_type: string;
  label: string;
  token_hash: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
```

### `src/satellites/persistence/friday-api-token-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridayApiTokenRow } from "../model/friday-satellite.types.js";

export interface InsertApiTokenInput {
  id: string;
  userId: string | null;
  principalType: string;
  label: string;
  tokenHash: string;
  scopes: string[];
  expiresAt?: string;
  nowIso: string;
}

export interface FridayApiTokenRepository {
  insertToken(db: Database.Database, input: InsertApiTokenInput): void;
  getByHash(db: Database.Database, tokenHash: string, nowIso?: string): FridayApiTokenRow | undefined;
  revokeAllForSatellite(db: Database.Database, satelliteId: string, nowIso: string): number;
}

export function createFridayApiTokenRepository(): FridayApiTokenRepository {
  return {
    insertToken(db, input) {
      db.prepare(
        `INSERT INTO api_tokens (
          id, user_id, principal_type, label, token_hash,
          scopes_json, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.principalType,
        input.label,
        input.tokenHash,
        JSON.stringify(input.scopes),
        input.expiresAt ?? null,
        input.nowIso,
        input.nowIso,
      );
    },

    getByHash(db, tokenHash, nowIso?) {
      const now = nowIso ?? new Date().toISOString();
      return db
        .prepare(
          "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .get(tokenHash, now) as FridayApiTokenRow | undefined;
    },

    revokeAllForSatellite(db, satelliteId, nowIso) {
      // Revoke tokens where the label contains the satellite ID
      // (tokens are labeled "satellite:<satelliteId>")
      const result = db
        .prepare(
          `UPDATE api_tokens
           SET revoked_at = ?, updated_at = ?
           WHERE principal_type = 'satellite'
             AND label LIKE ?
             AND revoked_at IS NULL`,
        )
        .run(nowIso, nowIso, `satellite:${satelliteId}%`);
      return result.changes;
    },
  };
}
```

### `src/satellites/persistence/friday-outbox-message-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayOutboxEnqueueInput,
  FridayOutboxMessageRow,
  FridayOutboxLeasedItem,
  FridayOutboxStatus,
} from "../model/friday-outbox.types.js";

export interface FridayOutboxMessageRepository {
  insertMessage(db: Database.Database, id: string, input: FridayOutboxEnqueueInput, nowIso: string): void;
  leaseBatch(
    db: Database.Database,
    satelliteId: string,
    limit: number,
    leaseUntilIso: string,
    nowIso: string,
  ): FridayOutboxLeasedItem[];
  ackUpToSeq(db: Database.Database, satelliteId: string, seq: number, ackedAt: string): number;
  getMessage(db: Database.Database, id: string): FridayOutboxMessageRow | undefined;
  updateStatusAndError(
    db: Database.Database,
    id: string,
    status: FridayOutboxStatus,
    errorCode: string | null,
    errorMessage: string | null,
    deliverAfter: string | null,
    nowIso: string,
  ): void;
  incrementAttempts(db: Database.Database, id: string): void;
  requeueExpiredLeases(db: Database.Database, nowIso: string): number;
  expireByTtl(db: Database.Database, nowIso: string): number;
  deleteTerminalBefore(db: Database.Database, cutoffIso: string): number;
}

export function createFridayOutboxMessageRepository(): FridayOutboxMessageRepository {
  return {
    insertMessage(db, id, input, nowIso) {
      db.prepare(
        `INSERT OR IGNORE INTO outbox_messages (
          id, satellite_id, queue_key, message_type, payload_ciphertext,
          nonce, key_id, idempotency_key, status, max_attempts,
          deliver_after, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.satelliteId,
        input.queueKey,
        input.messageType,
        input.payloadCiphertext,
        input.nonce,
        input.keyId,
        input.idempotencyKey,
        input.maxAttempts ?? 10,
        input.deliverAfter ?? null,
        input.expiresAt ?? null,
        nowIso,
        nowIso,
      );
    },

    leaseBatch(db, satelliteId, limit, leaseUntilIso, nowIso) {
      // Select eligible messages: queued, deliver_after satisfied, not expired
      const rows = db
        .prepare(
          `SELECT id, rowid AS seq, payload_ciphertext, message_type
           FROM outbox_messages
           WHERE satellite_id = ?
             AND status = 'queued'
             AND (deliver_after IS NULL OR deliver_after <= ?)
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(satelliteId, nowIso, nowIso, limit) as Array<{
        id: string;
        seq: number;
        payload_ciphertext: string;
        message_type: string;
      }>;

      if (rows.length === 0) return [];

      const update = db.prepare(
        "UPDATE outbox_messages SET status = 'leased', leased_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        update.run(leaseUntilIso, nowIso, row.id);
      }

      return rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        payloadCiphertext: r.payload_ciphertext,
        messageType: r.message_type,
      }));
    },

    ackUpToSeq(db, satelliteId, seq, ackedAt) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'acked', acked_at = ?, leased_until = NULL, updated_at = ?
           WHERE satellite_id = ? AND status = 'leased' AND rowid <= ?`,
        )
        .run(ackedAt, ackedAt, satelliteId, seq);
      return result.changes;
    },

    getMessage(db, id) {
      return db
        .prepare("SELECT * FROM outbox_messages WHERE id = ?")
        .get(id) as FridayOutboxMessageRow | undefined;
    },

    updateStatusAndError(db, id, status, errorCode, errorMessage, deliverAfter, nowIso) {
      db.prepare(
        `UPDATE outbox_messages
         SET status = ?, last_error_code = ?, last_error_message = ?,
             deliver_after = ?, leased_until = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(status, errorCode, errorMessage, deliverAfter, nowIso, id);
    },

    incrementAttempts(db, id) {
      db.prepare("UPDATE outbox_messages SET attempts = attempts + 1 WHERE id = ?").run(id);
    },

    requeueExpiredLeases(db, nowIso) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'queued', leased_until = NULL, updated_at = ?
           WHERE status = 'leased' AND leased_until < ?`,
        )
        .run(nowIso, nowIso);
      return result.changes;
    },

    expireByTtl(db, nowIso) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'expired', updated_at = ?
           WHERE status IN ('queued', 'failed', 'leased') AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .run(nowIso, nowIso);
      return result.changes;
    },

    deleteTerminalBefore(db, cutoffIso) {
      const result = db
        .prepare(
          "DELETE FROM outbox_messages WHERE status IN ('acked', 'dead_letter', 'expired') AND updated_at < ?",
        )
        .run(cutoffIso);
      return result.changes;
    },
  };
}
```

### `src/satellites/persistence/friday-satellite-capability-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySatelliteCapabilityEntry } from "../model/friday-satellite.types.js";

export interface FridaySatelliteCapabilityRow {
  id: string;
  satellite_id: string;
  key: string;
  available: number;
  metadata_json: string | null;
  limits_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridaySatelliteCapabilityRepository {
  upsertCapabilities(
    db: Database.Database,
    satelliteId: string,
    capabilities: FridaySatelliteCapabilityEntry[],
    nowIso: string,
    idGenerator: () => string,
  ): void;
  listBySatellite(db: Database.Database, satelliteId: string): FridaySatelliteCapabilityRow[];
}

export function createFridaySatelliteCapabilityRepository(): FridaySatelliteCapabilityRepository {
  return {
    upsertCapabilities(db, satelliteId, capabilities, nowIso, idGenerator) {
      const upsert = db.prepare(
        `INSERT INTO satellite_capabilities (id, satellite_id, key, available, metadata_json, limits_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(satellite_id, key) DO UPDATE SET
           available = excluded.available,
           metadata_json = excluded.metadata_json,
           limits_json = excluded.limits_json,
           updated_at = excluded.updated_at`,
      );

      for (const cap of capabilities) {
        upsert.run(
          idGenerator(),
          satelliteId,
          cap.key,
          cap.available ? 1 : 0,
          cap.metadata ? JSON.stringify(cap.metadata) : null,
          cap.limits ? JSON.stringify(cap.limits) : null,
          nowIso,
          nowIso,
        );
      }
    },

    listBySatellite(db, satelliteId) {
      return db
        .prepare("SELECT * FROM satellite_capabilities WHERE satellite_id = ? ORDER BY key")
        .all(satelliteId) as FridaySatelliteCapabilityRow[];
    },
  };
}
```

### `src/satellites/persistence/friday-satellite-heartbeat-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySatelliteHeartbeatInput } from "../model/friday-satellite.types.js";

export interface FridaySatelliteHeartbeatRow {
  id: string;
  satellite_id: string;
  ts: string;
  status: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  load_avg_1m: number | null;
  queue_depth: number | null;
  active_runs: number | null;
  details_json: string | null;
}

export interface FridaySatelliteHeartbeatRepository {
  insertHeartbeat(
    db: Database.Database,
    id: string,
    input: FridaySatelliteHeartbeatInput,
    computedStatus: string,
  ): void;
  getLatestBySatellite(
    db: Database.Database,
    satelliteId: string,
  ): FridaySatelliteHeartbeatRow | undefined;
  deleteBefore(db: Database.Database, cutoffIso: string): number;
}

export function createFridaySatelliteHeartbeatRepository(): FridaySatelliteHeartbeatRepository {
  return {
    insertHeartbeat(db, id, input, computedStatus) {
      db.prepare(
        `INSERT INTO satellite_heartbeats (
          id, satellite_id, ts, status, cpu_percent, memory_percent,
          load_avg_1m, queue_depth, active_runs, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.satelliteId,
        input.ts,
        computedStatus,
        input.metrics?.cpuPercent ?? null,
        input.metrics?.memoryPercent ?? null,
        input.metrics?.loadAvg1m ?? null,
        input.queueDepth ?? null,
        input.activeRuns ?? null,
        input.details ? JSON.stringify(input.details) : null,
      );
    },

    getLatestBySatellite(db, satelliteId) {
      return db
        .prepare(
          "SELECT * FROM satellite_heartbeats WHERE satellite_id = ? ORDER BY ts DESC LIMIT 1",
        )
        .get(satelliteId) as FridaySatelliteHeartbeatRow | undefined;
    },

    deleteBefore(db, cutoffIso) {
      const result = db
        .prepare("DELETE FROM satellite_heartbeats WHERE ts < ?")
        .run(cutoffIso);
      return result.changes;
    },
  };
}
```

### `src/satellites/persistence/friday-satellite-pairing-request-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySatellitePairingRequestRow } from "../model/friday-satellite.types.js";

export interface InsertPairingRequestInput {
  id: string;
  satelliteId: string;
  code: string;
  nonce: string;
  requestedByIp?: string;
  requestedByUserAgent?: string;
  expiresAt: string;
  nowIso: string;
}

export interface FridaySatellitePairingRequestRepository {
  insertRequest(db: Database.Database, input: InsertPairingRequestInput): void;
  getRequest(db: Database.Database, id: string): FridaySatellitePairingRequestRow | undefined;
  getRequestBySatelliteId(
    db: Database.Database,
    satelliteId: string,
    status: string,
  ): FridaySatellitePairingRequestRow | undefined;
  updateStatus(
    db: Database.Database,
    id: string,
    status: "approved" | "rejected" | "expired",
    resolverUserId: string | null,
    nowIso: string,
  ): void;
  listPendingExpiredBefore(db: Database.Database, cutoffIso: string): FridaySatellitePairingRequestRow[];
  deleteResolvedBefore(db: Database.Database, cutoffIso: string): number;
}

export function createFridaySatellitePairingRequestRepository(): FridaySatellitePairingRequestRepository {
  return {
    insertRequest(db, input) {
      db.prepare(
        `INSERT INTO satellite_pairing_requests (
          id, satellite_id, code, nonce, requested_by_ip, requested_by_user_agent,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        input.id,
        input.satelliteId,
        input.code,
        input.nonce,
        input.requestedByIp ?? null,
        input.requestedByUserAgent ?? null,
        input.expiresAt,
        input.nowIso,
        input.nowIso,
      );
    },

    getRequest(db, id) {
      return db
        .prepare("SELECT * FROM satellite_pairing_requests WHERE id = ?")
        .get(id) as FridaySatellitePairingRequestRow | undefined;
    },

    getRequestBySatelliteId(db, satelliteId, status) {
      return db
        .prepare(
          "SELECT * FROM satellite_pairing_requests WHERE satellite_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(satelliteId, status) as FridaySatellitePairingRequestRow | undefined;
    },

    updateStatus(db, id, status, resolverUserId, nowIso) {
      db.prepare(
        `UPDATE satellite_pairing_requests
         SET status = ?, resolved_at = ?, resolver_user_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, nowIso, resolverUserId, nowIso, id);
    },

    listPendingExpiredBefore(db, cutoffIso) {
      return db
        .prepare(
          "SELECT * FROM satellite_pairing_requests WHERE status = 'pending' AND expires_at < ?",
        )
        .all(cutoffIso) as FridaySatellitePairingRequestRow[];
    },

    deleteResolvedBefore(db, cutoffIso) {
      const result = db
        .prepare(
          "DELETE FROM satellite_pairing_requests WHERE status IN ('approved', 'rejected', 'expired') AND updated_at < ?",
        )
        .run(cutoffIso);
      return result.changes;
    },
  };
}
```

### `src/satellites/persistence/friday-satellite-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteRow,
  FridaySatelliteRegistrationInput,
} from "../model/friday-satellite.types.js";

export interface FridaySatelliteRepository {
  insertSatellite(db: Database.Database, input: InsertSatelliteInput): void;
  getSatellite(db: Database.Database, id: string): FridaySatelliteRow | undefined;
  updatePairingStatus(
    db: Database.Database,
    id: string,
    status: FridaySatellitePairingStatus,
    nowIso: string,
  ): void;
  updateLastSeen(db: Database.Database, id: string, nowIso: string): void;
  incrementTokenVersion(db: Database.Database, id: string, nowIso: string): void;
  listByStatus(
    db: Database.Database,
    statuses: FridaySatellitePairingStatus[],
  ): FridaySatelliteRow[];
}

export interface InsertSatelliteInput {
  id: string;
  registration: FridaySatelliteRegistrationInput;
  nowIso: string;
}

export function createFridaySatelliteRepository(): FridaySatelliteRepository {
  return {
    insertSatellite(db, input) {
      const { id, registration: r, nowIso } = input;
      db.prepare(
        `INSERT INTO satellites (
          id, type, display_name, pairing_status, trust_level, public_key,
          token_version, transport, platform, arch, app_version, node_version,
          tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 'restricted', ?, 1, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      ).run(
        id,
        r.type,
        r.displayName,
        r.publicKey,
        r.transport,
        r.runtime.platform,
        r.runtime.arch,
        r.runtime.appVersion,
        r.runtime.nodeVersion,
        nowIso,
        nowIso,
      );
    },

    getSatellite(db, id) {
      return db
        .prepare("SELECT * FROM satellites WHERE id = ? AND deleted_at IS NULL")
        .get(id) as FridaySatelliteRow | undefined;
    },

    updatePairingStatus(db, id, status, nowIso) {
      db.prepare(
        "UPDATE satellites SET pairing_status = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowIso, id);
    },

    updateLastSeen(db, id, nowIso) {
      db.prepare(
        "UPDATE satellites SET last_seen_at = ?, updated_at = ? WHERE id = ?",
      ).run(nowIso, nowIso, id);
    },

    incrementTokenVersion(db, id, nowIso) {
      db.prepare(
        "UPDATE satellites SET token_version = token_version + 1, updated_at = ? WHERE id = ?",
      ).run(nowIso, id);
    },

    listByStatus(db, statuses) {
      const placeholders = statuses.map(() => "?").join(", ");
      return db
        .prepare(
          `SELECT * FROM satellites WHERE pairing_status IN (${placeholders}) AND deleted_at IS NULL`,
        )
        .all(...statuses) as FridaySatelliteRow[];
    },
  };
}
```

### `src/satellites/persistence/friday-stream-checkpoint-repository.ts`
```ts
import type Database from "better-sqlite3";

/**
 * Manages protocol epoch and per-stream ack checkpoints
 * using the hub_settings table.
 */
export interface FridayStreamCheckpointRepository {
  getEpoch(db: Database.Database): number;
  bumpEpoch(db: Database.Database, nowIso: string): number;
  getLastAckedSeq(db: Database.Database, satelliteId: string, streamId: string): number;
  setLastAckedSeq(
    db: Database.Database,
    input: { satelliteId: string; streamId: string; seq: number; nowIso: string },
  ): void;
}

const EPOCH_KEY = "protocol_epoch";

function checkpointKey(satelliteId: string, streamId: string): string {
  return `ack_checkpoint:${satelliteId}:${streamId}`;
}

export function createFridayStreamCheckpointRepository(): FridayStreamCheckpointRepository {
  return {
    getEpoch(db) {
      const row = db
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(EPOCH_KEY) as { value_json: string } | undefined;
      if (!row) return 0;
      return JSON.parse(row.value_json) as number;
    },

    bumpEpoch(db, nowIso) {
      const current = this.getEpoch(db);
      const next = current + 1;
      db.prepare(
        `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, 1, ?, ?, NULL, NULL)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           revision = hub_settings.revision + 1,
           updated_at = excluded.updated_at`,
      ).run(EPOCH_KEY, JSON.stringify(next), nowIso, nowIso);
      return next;
    },

    getLastAckedSeq(db, satelliteId, streamId) {
      const key = checkpointKey(satelliteId, streamId);
      const row = db
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(key) as { value_json: string } | undefined;
      if (!row) return 0;
      return JSON.parse(row.value_json) as number;
    },

    setLastAckedSeq(db, input) {
      const key = checkpointKey(input.satelliteId, input.streamId);
      db.prepare(
        `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, 1, ?, ?, NULL, NULL)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           revision = hub_settings.revision + 1,
           updated_at = excluded.updated_at`,
      ).run(key, JSON.stringify(input.seq), input.nowIso, input.nowIso);
    },
  };
}
```

### `src/satellites/protocol/friday-ack-resume-validator.ts`
```ts
import type { FridayWsResumeFrame } from "../../hub/services/friday-hub-gateway-ingress.types.js";
import type { FridayResumeValidationResult } from "../model/friday-satellite-protocol.types.js";
import type { FridayResumeCursorSigner } from "./friday-resume-cursor-signer.js";

export interface FridayAckResumeValidator {
  validateResume(frame: FridayWsResumeFrame, currentEpoch: number): FridayResumeValidationResult;
}

export function createFridayAckResumeValidator(
  cursorSigner: FridayResumeCursorSigner,
): FridayAckResumeValidator {
  return {
    validateResume(frame, currentEpoch) {
      // 1. Verify cursor HMAC
      let cursorPayload;
      try {
        cursorPayload = cursorSigner.verify(frame.cursor);
      } catch {
        return {
          ok: false,
          code: "AUTH_UNAUTHORIZED",
          message: "Resume cursor HMAC verification failed",
        };
      }

      // 2. Check epoch matches current
      if (cursorPayload.epoch !== currentEpoch || frame.epoch !== currentEpoch) {
        return {
          ok: false,
          code: "STREAM_EPOCH_STALE",
          message: `Epoch mismatch: cursor=${cursorPayload.epoch}, frame=${frame.epoch}, current=${currentEpoch}`,
        };
      }

      // 3. Check stream ID matches
      if (cursorPayload.streamId !== frame.streamId) {
        return {
          ok: false,
          code: "AUTH_UNAUTHORIZED",
          message: "Stream ID in cursor does not match frame stream ID",
        };
      }

      // 4. Check seq consistency
      if (cursorPayload.seq !== frame.lastAckedSeq) {
        return {
          ok: false,
          code: "STREAM_CURSOR_OUT_OF_RANGE",
          message: `Cursor seq ${cursorPayload.seq} does not match frame lastAckedSeq ${frame.lastAckedSeq}`,
        };
      }

      return {
        ok: true,
        effectiveSeq: frame.lastAckedSeq,
      };
    },
  };
}
```

### `src/satellites/protocol/friday-resume-cursor-signer.ts`
```ts
import { createHmac } from "node:crypto";
import type { FridayResumeCursorPayload } from "../model/friday-satellite-protocol.types.js";

export interface FridayResumeCursorSigner {
  sign(input: FridayResumeCursorPayload): string;
  verify(cursor: string): FridayResumeCursorPayload;
}

/**
 * Creates an HMAC-based cursor signer for resume protocol.
 * The cursor is `base64(JSON payload).base64(HMAC-SHA256 signature)`.
 */
export function createFridayResumeCursorSigner(secretKey: string): FridayResumeCursorSigner {
  function computeHmac(data: string): string {
    return createHmac("sha256", secretKey).update(data).digest("base64url");
  }

  return {
    sign(input) {
      const payloadJson = JSON.stringify(input);
      const payloadB64 = Buffer.from(payloadJson).toString("base64url");
      const sig = computeHmac(payloadB64);
      return `${payloadB64}.${sig}`;
    },

    verify(cursor) {
      const dotIndex = cursor.indexOf(".");
      if (dotIndex === -1) {
        throw new Error("Invalid cursor format: missing signature separator");
      }
      const payloadB64 = cursor.substring(0, dotIndex);
      const sig = cursor.substring(dotIndex + 1);

      const expectedSig = computeHmac(payloadB64);
      if (sig !== expectedSig) {
        throw new Error("Invalid cursor: HMAC verification failed");
      }

      const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
      return JSON.parse(payloadJson) as FridayResumeCursorPayload;
    },
  };
}
```

### `src/satellites/runtime/friday-satellite-runtime.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayRetentionPolicy } from "../../jobs/retention/friday-retention.types.js";
import type { FridaySatelliteRuntime } from "./friday-satellite-runtime.types.js";

import { createFridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import { createFridaySatellitePairingRequestRepository } from "../persistence/friday-satellite-pairing-request-repository.js";
import { createFridaySatelliteCapabilityRepository } from "../persistence/friday-satellite-capability-repository.js";
import { createFridaySatelliteHeartbeatRepository } from "../persistence/friday-satellite-heartbeat-repository.js";
import { createFridayOutboxMessageRepository } from "../persistence/friday-outbox-message-repository.js";
import { createFridayStreamCheckpointRepository } from "../persistence/friday-stream-checkpoint-repository.js";
import { createFridayApiTokenRepository } from "../persistence/friday-api-token-repository.js";
import { createFridayResumeCursorSigner } from "../protocol/friday-resume-cursor-signer.js";
import { createFridayAckResumeValidator } from "../protocol/friday-ack-resume-validator.js";
import { createFridaySatelliteRegistrationService } from "../services/friday-satellite-registration-service.js";
import { createFridaySatellitePairingService } from "../services/friday-satellite-pairing-service.js";
import { createFridaySatelliteCapabilityService } from "../services/friday-satellite-capability-service.js";
import { createFridaySatelliteHeartbeatService } from "../services/friday-satellite-heartbeat-service.js";
import { createFridaySatelliteOfflineSweeper } from "../services/friday-satellite-offline-sweeper.js";
import { createFridayOutboxQueueService } from "../services/friday-outbox-queue-service.js";
import { createFridaySatelliteSyncService } from "../services/friday-satellite-sync-service.js";
import { createFridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import { createFridaySkillRunStore } from "../../ledger/runs/friday-skill-run-store.js";
import { createFridaySkillRunCheckpointWriter } from "../../ledger/runs/friday-skill-run-checkpoint-writer.js";
import { createFridayRetentionJob } from "../../jobs/retention/friday-retention-job.js";

export interface CreateFridaySatelliteRuntimeOptions {
  db: FridaySqliteLayer;
  cursorSecret: string;
  idGenerator: () => string;
  nowIso: () => string;
  retentionPolicy?: FridayRetentionPolicy;
  pairingTtlMs?: number;
  expectedHeartbeatIntervalMs?: number;
}

/**
 * Wires all Phase 2 repositories, services, ledgers, and retention
 * into a single runtime composition.
 */
export function createFridaySatelliteRuntime(
  options: CreateFridaySatelliteRuntimeOptions,
): FridaySatelliteRuntime {
  const {
    db,
    cursorSecret,
    idGenerator,
    nowIso,
    retentionPolicy,
    pairingTtlMs,
    expectedHeartbeatIntervalMs,
  } = options;

  // Repositories
  const satelliteRepo = createFridaySatelliteRepository();
  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const capabilityRepo = createFridaySatelliteCapabilityRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();
  const checkpointRepo = createFridayStreamCheckpointRepository();
  const apiTokenRepo = createFridayApiTokenRepository();

  // Protocol
  const cursorSigner = createFridayResumeCursorSigner(cursorSecret);
  const ackValidator = createFridayAckResumeValidator(cursorSigner);

  // Bump epoch on runtime boot per protocol design
  db.withWriteTransaction((writerDb) => {
    checkpointRepo.bumpEpoch(writerDb, nowIso());
  });

  // Ledger
  const learningLedger = createFridayLearningEventLedger({ db });
  const skillRunStore = createFridaySkillRunStore({ db });
  const checkpointWriter = createFridaySkillRunCheckpointWriter({ db });

  // Services
  const registration = createFridaySatelliteRegistrationService({
    db,
    satelliteRepo,
    pairingRequestRepo,
    capabilityRepo,
    idGenerator,
    nowIso,
    pairingTtlMs,
  });

  const pairing = createFridaySatellitePairingService({
    db,
    satelliteRepo,
    pairingRequestRepo,
    apiTokenRepo,
    checkpointRepo,
    idGenerator,
    nowIso,
  });

  const capabilities = createFridaySatelliteCapabilityService({
    db,
    satelliteRepo,
    capabilityRepo,
    idGenerator,
    nowIso,
    revisionCache: new Map(),
  });

  const heartbeat = createFridaySatelliteHeartbeatService({
    db,
    satelliteRepo,
    heartbeatRepo,
    idGenerator,
    nowIso,
    expectedIntervalMs: expectedHeartbeatIntervalMs,
  });

  const offlineSweeper = createFridaySatelliteOfflineSweeper({
    db,
    satelliteRepo,
    nowIso,
  });

  const outbox = createFridayOutboxQueueService({
    db,
    outboxRepo,
    idGenerator,
    nowIso,
  });

  const sync = createFridaySatelliteSyncService({
    db,
    checkpointRepo,
    outboxRepo,
    cursorSigner,
    ackValidator,
    nowIso,
  });

  // Retention
  const retention = createFridayRetentionJob({
    db,
    pairingRequestRepo,
    heartbeatRepo,
    outboxRepo,
    learningLedger,
    skillRunStore,
    policy: retentionPolicy,
    nowIso,
  });

  return {
    registration,
    pairing,
    capabilities,
    heartbeat,
    offlineSweeper,
    outbox,
    sync,
    learningLedger,
    skillRunStore,
    checkpointWriter,
    retention,
  };
}
```

### `src/satellites/runtime/friday-satellite-runtime.types.ts`
```ts
import type { FridaySatelliteRegistrationService } from "../services/friday-satellite-registration-service.js";
import type { FridaySatellitePairingService } from "../services/friday-satellite-pairing-service.js";
import type { FridaySatelliteCapabilityService } from "../services/friday-satellite-capability-service.js";
import type { FridaySatelliteHeartbeatService } from "../services/friday-satellite-heartbeat-service.js";
import type { FridaySatelliteOfflineSweeper } from "../services/friday-satellite-offline-sweeper.js";
import type { FridayOutboxQueueService } from "../services/friday-outbox-queue-service.js";
import type { FridaySatelliteSyncService } from "../services/friday-satellite-sync-service.js";
import type { FridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import type { FridaySkillRunStore } from "../../ledger/runs/friday-skill-run-store.js";
import type { FridaySkillRunCheckpointWriter } from "../../ledger/runs/friday-skill-run-checkpoint-writer.js";
import type { FridayRetentionJob } from "../../jobs/retention/friday-retention-job.js";

/**
 * Composite runtime surface that exposes all Phase 2 services
 * for integration with hub transport endpoints.
 */
export interface FridaySatelliteRuntime {
  registration: FridaySatelliteRegistrationService;
  pairing: FridaySatellitePairingService;
  capabilities: FridaySatelliteCapabilityService;
  heartbeat: FridaySatelliteHeartbeatService;
  offlineSweeper: FridaySatelliteOfflineSweeper;
  outbox: FridayOutboxQueueService;
  sync: FridaySatelliteSyncService;
  learningLedger: FridayLearningEventLedger;
  skillRunStore: FridaySkillRunStore;
  checkpointWriter: FridaySkillRunCheckpointWriter;
  retention: FridayRetentionJob;
}
```

### `src/satellites/services/friday-outbox-queue-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayOutboxEnqueueInput,
  FridayOutboxLeasedItem,
  FridayOutboxStatus,
} from "../model/friday-outbox.types.js";
import type { FridayOutboxMessageRepository } from "../persistence/friday-outbox-message-repository.js";

export interface FridayOutboxQueueService {
  enqueue(input: FridayOutboxEnqueueInput): { id: string };
  leaseBatch(input: {
    satelliteId: string;
    limit: number;
    leaseMs: number;
    nowIso?: string;
  }): FridayOutboxLeasedItem[];
  ackUpToSeq(input: {
    satelliteId: string;
    streamId: string;
    seq: number;
    ackedAt?: string;
  }): { acked: number };
  failLeasedMessage(input: {
    messageId: string;
    satelliteId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    nowIso?: string;
  }): { status: FridayOutboxStatus; nextDeliverAfter?: string };
  requeueExpiredLeases(nowIso?: string): number;
  expireByTtl(nowIso?: string): number;
}

export interface CreateOutboxQueueServiceDeps {
  db: FridaySqliteLayer;
  outboxRepo: FridayOutboxMessageRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

/** Base retry backoff: 5 seconds, doubled per attempt. */
const BASE_RETRY_MS = 5_000;

export function createFridayOutboxQueueService(
  deps: CreateOutboxQueueServiceDeps,
): FridayOutboxQueueService {
  return {
    enqueue(input) {
      const id = deps.idGenerator();
      const nowIso = deps.nowIso();
      return deps.db.withWriteTransaction((db) => {
        deps.outboxRepo.insertMessage(db, id, input, nowIso);

        // INSERT OR IGNORE may have been a no-op if idempotency_key already exists.
        // Check if our id was actually inserted; if not, look up the existing row.
        const existing = db
          .prepare(
            "SELECT id FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?",
          )
          .get(input.satelliteId, input.idempotencyKey) as { id: string } | undefined;

        return { id: existing?.id ?? id };
      });
    },

    leaseBatch(input) {
      const nowIso = input.nowIso ?? deps.nowIso();
      const leaseUntilIso = new Date(new Date(nowIso).getTime() + input.leaseMs).toISOString();

      return deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.leaseBatch(db, input.satelliteId, input.limit, leaseUntilIso, nowIso);
      });
    },

    ackUpToSeq(input) {
      const ackedAt = input.ackedAt ?? deps.nowIso();
      const acked = deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.ackUpToSeq(db, input.satelliteId, input.seq, ackedAt);
      });
      return { acked };
    },

    failLeasedMessage(input) {
      const nowIso = input.nowIso ?? deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        const msg = deps.outboxRepo.getMessage(db, input.messageId);
        if (!msg) {
          throw new Error(`Outbox message not found: ${input.messageId}`);
        }
        if (msg.satellite_id !== input.satelliteId) {
          throw new Error("Message does not belong to this satellite");
        }

        // Non-retryable or max attempts → dead_letter
        if (!input.retryable || msg.attempts >= msg.max_attempts) {
          deps.outboxRepo.updateStatusAndError(
            db,
            input.messageId,
            "dead_letter",
            input.errorCode,
            input.errorMessage,
            null,
            nowIso,
          );
          return { status: "dead_letter" as const };
        }

        // Retryable → back to queued with exponential backoff
        const backoffMs = BASE_RETRY_MS * Math.pow(2, msg.attempts - 1);
        const nextDeliverAfter = new Date(new Date(nowIso).getTime() + backoffMs).toISOString();

        deps.outboxRepo.updateStatusAndError(
          db,
          input.messageId,
          "queued",
          input.errorCode,
          input.errorMessage,
          nextDeliverAfter,
          nowIso,
        );

        return { status: "queued" as const, nextDeliverAfter };
      });
    },

    requeueExpiredLeases(nowIso?) {
      const now = nowIso ?? deps.nowIso();
      return deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.requeueExpiredLeases(db, now);
      });
    },

    expireByTtl(nowIso?) {
      const now = nowIso ?? deps.nowIso();
      return deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.expireByTtl(db, now);
      });
    },
  };
}
```

### `src/satellites/services/friday-satellite-capability-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySatelliteCapabilityReport } from "../model/friday-satellite.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatelliteCapabilityRepository } from "../persistence/friday-satellite-capability-repository.js";

export interface FridaySatelliteCapabilityService {
  updateCapabilities(report: FridaySatelliteCapabilityReport): {
    accepted: boolean;
    reason?: string;
  };
}

export interface CreateCapabilityServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  capabilityRepo: FridaySatelliteCapabilityRepository;
  idGenerator: () => string;
  nowIso: () => string;
  /** @deprecated Kept for API compatibility; revision is now persisted in hub_settings. */
  revisionCache?: Map<string, number>;
}

const REVISION_KEY_PREFIX = "capability_revision:";

export function createFridaySatelliteCapabilityService(
  deps: CreateCapabilityServiceDeps,
): FridaySatelliteCapabilityService {
  return {
    updateCapabilities(report) {
      return deps.db.withWriteTransaction((db) => {
        // Enforce monotonic revision from persisted state
        const revisionKey = `${REVISION_KEY_PREFIX}${report.satelliteId}`;
        const revRow = db
          .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
          .get(revisionKey) as { value_json: string } | undefined;
        const lastRevision = revRow ? (JSON.parse(revRow.value_json) as number) : 0;

        if (report.revision <= lastRevision) {
          return {
            accepted: false,
            reason: `Stale revision: received ${report.revision}, last seen ${lastRevision}`,
          };
        }

        const satellite = deps.satelliteRepo.getSatellite(db, report.satelliteId);
        if (!satellite) {
          return { accepted: false, reason: `Satellite not found: ${report.satelliteId}` };
        }

        const nowIso = deps.nowIso();

        deps.capabilityRepo.upsertCapabilities(
          db,
          report.satelliteId,
          report.capabilities,
          nowIso,
          deps.idGenerator,
        );

        // Persist the revision durably
        db.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, 1, ?, ?, NULL, NULL)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             revision = hub_settings.revision + 1,
             updated_at = excluded.updated_at`,
        ).run(revisionKey, JSON.stringify(report.revision), nowIso, nowIso);

        return { accepted: true };
      });
    },
  };
}
```

### `src/satellites/services/friday-satellite-heartbeat-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridaySatelliteHeartbeatInput,
  FridaySatellitePairingStatus,
} from "../model/friday-satellite.types.js";
import { computeFridaySatelliteStatus } from "../model/friday-satellite-health.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatelliteHeartbeatRepository } from "../persistence/friday-satellite-heartbeat-repository.js";

export interface FridaySatelliteHeartbeatResult {
  accepted: true;
  now: string;
  expectedIntervalMs: number;
  status: FridaySatellitePairingStatus;
}

export interface FridaySatelliteHeartbeatService {
  recordHeartbeat(input: FridaySatelliteHeartbeatInput): FridaySatelliteHeartbeatResult;
}

export interface CreateHeartbeatServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  heartbeatRepo: FridaySatelliteHeartbeatRepository;
  idGenerator: () => string;
  nowIso: () => string;
  expectedIntervalMs?: number;
}

/** Default expected heartbeat interval: 15 seconds. */
const DEFAULT_EXPECTED_INTERVAL_MS = 15_000;

export function createFridaySatelliteHeartbeatService(
  deps: CreateHeartbeatServiceDeps,
): FridaySatelliteHeartbeatService {
  const expectedIntervalMs = deps.expectedIntervalMs ?? DEFAULT_EXPECTED_INTERVAL_MS;

  return {
    recordHeartbeat(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        const satellite = deps.satelliteRepo.getSatellite(db, input.satelliteId);
        if (!satellite) {
          throw new Error(`Satellite not found: ${input.satelliteId}`);
        }

        // Compute new status
        const newStatus = computeFridaySatelliteStatus({
          nowIso,
          lastHeartbeatTs: input.ts,
          failureRate1m: input.failureRate1m,
          explicitDisconnect: input.explicitDisconnect,
          currentStatus: satellite.pairing_status as FridaySatellitePairingStatus,
        });

        // Record heartbeat
        const heartbeatId = deps.idGenerator();
        deps.heartbeatRepo.insertHeartbeat(db, heartbeatId, input, newStatus);

        // Update satellite status and last_seen
        if (newStatus !== satellite.pairing_status) {
          deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, newStatus, nowIso);
        }
        deps.satelliteRepo.updateLastSeen(db, input.satelliteId, nowIso);

        return {
          accepted: true as const,
          now: nowIso,
          expectedIntervalMs,
          status: newStatus,
        };
      });
    },
  };
}
```

### `src/satellites/services/friday-satellite-offline-sweeper.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySatellitePairingStatus } from "../model/friday-satellite.types.js";
import { computeFridaySatelliteStatus } from "../model/friday-satellite-health.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";

export interface FridaySatelliteOfflineSweeperResult {
  markedDegraded: number;
  markedOffline: number;
}

export interface FridaySatelliteOfflineSweeper {
  sweep(nowIso?: string): FridaySatelliteOfflineSweeperResult;
}

export interface CreateOfflineSweeperDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  nowIso: () => string;
}

export function createFridaySatelliteOfflineSweeper(
  deps: CreateOfflineSweeperDeps,
): FridaySatelliteOfflineSweeper {
  return {
    sweep(nowIsoOverride?) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = nowIsoOverride ?? deps.nowIso();
        let markedDegraded = 0;
        let markedOffline = 0;

        // Check all potentially stale satellites (online, degraded, paired)
        const candidates = deps.satelliteRepo.listByStatus(db, [
          "online",
          "degraded",
          "paired",
        ]);

        for (const sat of candidates) {
          const newStatus = computeFridaySatelliteStatus({
            nowIso,
            lastHeartbeatTs: sat.last_seen_at ?? undefined,
            currentStatus: sat.pairing_status as FridaySatellitePairingStatus,
          });

          if (newStatus !== sat.pairing_status) {
            deps.satelliteRepo.updatePairingStatus(
              db,
              sat.id,
              newStatus,
              nowIso,
            );
            if (newStatus === "degraded") markedDegraded++;
            if (newStatus === "offline") markedOffline++;
          }
        }

        return { markedDegraded, markedOffline };
      });
    },
  };
}
```

### `src/satellites/services/friday-satellite-pairing-service.ts`
```ts
import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatellitePairingRequestRepository } from "../persistence/friday-satellite-pairing-request-repository.js";
import type { FridayApiTokenRepository } from "../persistence/friday-api-token-repository.js";
import type { FridayStreamCheckpointRepository } from "../persistence/friday-stream-checkpoint-repository.js";

export interface FridaySatellitePairingApprovalInput {
  satelliteId: string;
  requestId: string;
  resolverUserId: string;
  scopes: string[];
  tokenTtlMs?: number;
}

export interface FridaySatellitePairingApprovalResult {
  token: string;
  tokenId: string;
  expiresAt?: string;
  configRevision: number;
  tokenVersion: number;
}

export interface FridaySatellitePairingRejectionInput {
  satelliteId: string;
  requestId: string;
  resolverUserId: string;
  reason?: string;
}

export type FridayHandshakeAlgorithm = "xchacha20-poly1305" | "aes-256-gcm";

export interface FridaySatelliteHandshakeInput {
  satelliteId: string;
  token: string;
  signedChallenge: string;
  challengeNonce: string;
  clientEphemeralPublicKey: string;
  supportedAlgorithms: FridayHandshakeAlgorithm[];
}

export interface FridaySatelliteHandshakeResult {
  accepted: true;
  streamId: string;
  epoch: number;
  algorithm: FridayHandshakeAlgorithm;
  serverEphemeralPublicKey: string;
}

export interface FridaySatelliteRevokeInput {
  satelliteId: string;
  revokeTokens?: boolean;
  reason?: string;
}

export interface FridaySatellitePairingService {
  approvePairing(input: FridaySatellitePairingApprovalInput): FridaySatellitePairingApprovalResult;
  rejectPairing(input: FridaySatellitePairingRejectionInput): void;
  completeHandshake(input: FridaySatelliteHandshakeInput): FridaySatelliteHandshakeResult;
  revokeSatellite(input: FridaySatelliteRevokeInput): void;
}

export interface CreatePairingServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  pairingRequestRepo: FridaySatellitePairingRequestRepository;
  apiTokenRepo: FridayApiTokenRepository;
  checkpointRepo: FridayStreamCheckpointRepository;
  idGenerator: () => string;
  nowIso: () => string;
  /** Optional override for ephemeral key generation (testing). */
  generateEphemeralKeyPair?: () => { publicKey: string; privateKey: string };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Ordered by preference — strongest first. */
const ALGORITHM_PREFERENCE: FridayHandshakeAlgorithm[] = [
  "xchacha20-poly1305",
  "aes-256-gcm",
];

function negotiateAlgorithm(
  clientAlgorithms: FridayHandshakeAlgorithm[],
): FridayHandshakeAlgorithm | undefined {
  for (const preferred of ALGORITHM_PREFERENCE) {
    if (clientAlgorithms.includes(preferred)) {
      return preferred;
    }
  }
  return undefined;
}

function verifyChallengeSignature(
  publicKeyPem: string,
  challengeNonce: string,
  signedChallenge: string,
): boolean {
  try {
    const verifier = createVerify("SHA256");
    verifier.update(challengeNonce);
    verifier.end();
    return verifier.verify(publicKeyPem, signedChallenge, "base64");
  } catch {
    return false;
  }
}

function defaultGenerateEphemeralKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Extract token version from the token label. Format: "satellite:<id>:v<version>" */
function extractTokenVersionFromLabel(label: string): number | undefined {
  const match = label.match(/:v(\d+)$/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

export function createFridaySatellitePairingService(
  deps: CreatePairingServiceDeps,
): FridaySatellitePairingService {
  return {
    approvePairing(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        // Validate request exists and is pending
        const request = deps.pairingRequestRepo.getRequest(db, input.requestId);
        if (!request) {
          throw new Error(`Pairing request not found: ${input.requestId}`);
        }
        if (request.status !== "pending") {
          throw new Error(`Pairing request is not pending: ${request.status}`);
        }
        if (request.satellite_id !== input.satelliteId) {
          throw new Error("Pairing request does not belong to this satellite");
        }
        if (new Date(request.expires_at) < new Date(nowIso)) {
          throw new Error("Pairing request has expired");
        }

        // Update request to approved
        deps.pairingRequestRepo.updateStatus(db, input.requestId, "approved", input.resolverUserId, nowIso);

        // Update satellite to paired
        deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, "paired", nowIso);

        // Generate and store token
        const plainToken = randomBytes(32).toString("hex");
        const tokenId = deps.idGenerator();
        const expiresAt = input.tokenTtlMs
          ? new Date(new Date(nowIso).getTime() + input.tokenTtlMs).toISOString()
          : undefined;

        const satellite = deps.satelliteRepo.getSatellite(db, input.satelliteId);
        const tokenVersion = satellite?.token_version ?? 1;

        deps.apiTokenRepo.insertToken(db, {
          id: tokenId,
          userId: null,
          principalType: "satellite",
          label: `satellite:${input.satelliteId}:v${tokenVersion}`,
          tokenHash: hashToken(plainToken),
          scopes: input.scopes,
          expiresAt,
          nowIso,
        });

        return {
          token: plainToken,
          tokenId,
          expiresAt,
          configRevision: 1,
          tokenVersion,
        };
      });
    },

    rejectPairing(input) {
      deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const request = deps.pairingRequestRepo.getRequest(db, input.requestId);
        if (!request) {
          throw new Error(`Pairing request not found: ${input.requestId}`);
        }
        if (request.status !== "pending") {
          throw new Error(`Pairing request is not pending: ${request.status}`);
        }
        if (request.satellite_id !== input.satelliteId) {
          throw new Error("Pairing request does not belong to this satellite");
        }

        deps.pairingRequestRepo.updateStatus(db, input.requestId, "rejected", input.resolverUserId, nowIso);
      });
    },

    completeHandshake(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        // Validate token (with expiry check)
        const tokenRow = deps.apiTokenRepo.getByHash(db, hashToken(input.token), nowIso);
        if (!tokenRow) {
          throw new Error("Invalid or revoked token");
        }

        // Validate satellite
        const satellite = deps.satelliteRepo.getSatellite(db, input.satelliteId);
        if (!satellite) {
          throw new Error(`Satellite not found: ${input.satelliteId}`);
        }
        if (satellite.pairing_status === "revoked") {
          throw new Error("Satellite has been revoked");
        }

        // Token label must reference this satellite
        if (!tokenRow.label.startsWith(`satellite:${input.satelliteId}`)) {
          throw new Error("Token does not belong to this satellite");
        }

        // Issue 3: Validate token version against satellite's current token_version
        const tokenLabelVersion = extractTokenVersionFromLabel(tokenRow.label);
        if (tokenLabelVersion !== undefined && tokenLabelVersion !== satellite.token_version) {
          throw new Error(
            `Token version mismatch: token=${tokenLabelVersion}, satellite=${satellite.token_version}`,
          );
        }

        // Validate nonce binding — must match the nonce issued during registration
        const pairingRequest = deps.pairingRequestRepo.getRequestBySatelliteId(
          db,
          input.satelliteId,
          "approved",
        );
        if (!pairingRequest || pairingRequest.nonce !== input.challengeNonce) {
          throw new Error("Challenge nonce does not match issued nonce");
        }

        // Verify challenge signature against satellite's public key and nonce
        if (
          !verifyChallengeSignature(
            satellite.public_key,
            input.challengeNonce,
            input.signedChallenge,
          )
        ) {
          throw new Error("Challenge signature verification failed");
        }

        // Negotiate algorithm
        const algorithm = negotiateAlgorithm(input.supportedAlgorithms);
        if (!algorithm) {
          throw new Error("No supported algorithm in common");
        }

        // Generate server ephemeral key pair
        const genKeyPair = deps.generateEphemeralKeyPair ?? defaultGenerateEphemeralKeyPair;
        const ephemeral = genKeyPair();

        // Update satellite to online and last_seen
        deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, "online", nowIso);
        deps.satelliteRepo.updateLastSeen(db, input.satelliteId, nowIso);

        // Get or bump epoch
        const epoch = deps.checkpointRepo.getEpoch(db) || deps.checkpointRepo.bumpEpoch(db, nowIso);
        const streamId = deps.idGenerator();

        return {
          accepted: true as const,
          streamId,
          epoch,
          algorithm,
          serverEphemeralPublicKey: ephemeral.publicKey,
        };
      });
    },

    revokeSatellite(input) {
      deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, "revoked", nowIso);

        if (input.revokeTokens !== false) {
          deps.apiTokenRepo.revokeAllForSatellite(db, input.satelliteId, nowIso);
          deps.satelliteRepo.incrementTokenVersion(db, input.satelliteId, nowIso);
        }
      });
    },
  };
}
```

### `src/satellites/services/friday-satellite-registration-service.ts`
```ts
import { randomBytes } from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySatelliteRegistrationInput } from "../model/friday-satellite.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatellitePairingRequestRepository } from "../persistence/friday-satellite-pairing-request-repository.js";
import type { FridaySatelliteCapabilityRepository } from "../persistence/friday-satellite-capability-repository.js";

export interface FridaySatelliteRegistrationResult {
  satelliteId: string;
  pairingStatus: "pending";
  pairingRequired: true;
  pairingRequestId: string;
  pairingCode: string;
  expiresAt: string;
  challengeNonce: string;
}

export interface FridaySatelliteRegistrationService {
  register(input: FridaySatelliteRegistrationInput): FridaySatelliteRegistrationResult;
}

export interface CreateRegistrationServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  pairingRequestRepo: FridaySatellitePairingRequestRepository;
  capabilityRepo: FridaySatelliteCapabilityRepository;
  idGenerator: () => string;
  nowIso: () => string;
  pairingTtlMs?: number;
}

/** Default pairing request TTL: 10 minutes. */
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export function createFridaySatelliteRegistrationService(
  deps: CreateRegistrationServiceDeps,
): FridaySatelliteRegistrationService {
  const pairingTtlMs = deps.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;

  return {
    register(input) {
      return deps.db.withWriteTransaction((db) => {
        const satelliteId = deps.idGenerator();
        const requestId = deps.idGenerator();
        const nowIso = deps.nowIso();
        const expiresAt = new Date(new Date(nowIso).getTime() + pairingTtlMs).toISOString();

        // 6-digit pairing code
        const code = randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6);
        const nonce = randomBytes(32).toString("hex");

        // 1. Insert satellite row
        deps.satelliteRepo.insertSatellite(db, { id: satelliteId, registration: input, nowIso });

        // 2. Insert pairing request
        deps.pairingRequestRepo.insertRequest(db, {
          id: requestId,
          satelliteId,
          code,
          nonce,
          requestedByIp: input.requestedByIp,
          requestedByUserAgent: input.requestedByUserAgent,
          expiresAt,
          nowIso,
        });

        // 3. Store initial capabilities if provided
        if (input.capabilityReport) {
          deps.capabilityRepo.upsertCapabilities(
            db,
            satelliteId,
            input.capabilityReport.capabilities,
            nowIso,
            deps.idGenerator,
          );
        }

        return {
          satelliteId,
          pairingStatus: "pending" as const,
          pairingRequired: true as const,
          pairingRequestId: requestId,
          pairingCode: code,
          expiresAt,
          challengeNonce: nonce,
        };
      });
    },
  };
}
```

### `src/satellites/services/friday-satellite-sync-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningEventAppendInput } from "../../ledger/learning/friday-learning-event-ledger.types.js";
import type { FridayResumeValidationResult } from "../model/friday-satellite-protocol.types.js";
import type { FridayResumeCursorSigner } from "../protocol/friday-resume-cursor-signer.js";
import type { FridayAckResumeValidator } from "../protocol/friday-ack-resume-validator.js";
import type { FridayStreamCheckpointRepository } from "../persistence/friday-stream-checkpoint-repository.js";
import type { FridayOutboxMessageRepository } from "../persistence/friday-outbox-message-repository.js";

export interface FridaySyncPullInput {
  satelliteId: string;
  streamId: string;
  lastAckedSeq: number;
  subscriptions: string[];
  resumeCursor?: string;
}

export interface FridaySyncPullResult {
  epoch: number;
  streamId: string;
  events: Array<{ seq: number; event: string; payload: unknown; emittedAt: string }>;
  queueItems: Array<{ id: string; seq: number; messageType: string; payloadCiphertext: string }>;
  nextCursor?: string;
  fullPullRequired?: boolean;
}

export interface FridaySyncPushInput {
  satelliteId: string;
  acks: Array<{ streamId: string; seq: number; epoch: number; cursor?: string }>;
  localEvents?: FridayLearningEventAppendInput[];
}

export interface FridaySyncPushResult {
  acceptedAcks: Array<{ streamId: string; seq: number }>;
  conflicts: Array<{ streamId: string; seq: number; code: string; message: string }>;
}

export interface FridaySatelliteSyncService {
  pull(input: FridaySyncPullInput): FridaySyncPullResult;
  push(input: FridaySyncPushInput): FridaySyncPushResult;
}

export interface CreateSyncServiceDeps {
  db: FridaySqliteLayer;
  checkpointRepo: FridayStreamCheckpointRepository;
  outboxRepo: FridayOutboxMessageRepository;
  cursorSigner: FridayResumeCursorSigner;
  ackValidator: FridayAckResumeValidator;
  nowIso: () => string;
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
}

export function createFridaySatelliteSyncService(
  deps: CreateSyncServiceDeps,
): FridaySatelliteSyncService {
  return {
    pull(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const currentEpoch = deps.checkpointRepo.getEpoch(db);

        // If resume cursor is provided, validate it
        if (input.resumeCursor) {
          const frame = {
            type: "resume" as const,
            lastAckedSeq: input.lastAckedSeq,
            streamId: input.streamId,
            epoch: currentEpoch,
            cursor: input.resumeCursor,
            subscriptions: input.subscriptions,
            emittedAt: nowIso,
          };
          const result: FridayResumeValidationResult = deps.ackValidator.validateResume(
            frame,
            currentEpoch,
          );
          if (!result.ok) {
            return {
              epoch: currentEpoch,
              streamId: input.streamId,
              events: [],
              queueItems: [],
              fullPullRequired: true,
            };
          }
        }

        // Lease queued messages for this satellite
        const leaseMs = 60_000;
        const leaseUntilIso = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
        const queueItems = deps.outboxRepo.leaseBatch(
          db,
          input.satelliteId,
          50,
          leaseUntilIso,
          nowIso,
        );

        // Generate next cursor
        const maxSeq = queueItems.length > 0
          ? Math.max(...queueItems.map((q) => q.seq))
          : input.lastAckedSeq;

        const nextCursor = deps.cursorSigner.sign({
          seq: maxSeq,
          streamId: input.streamId,
          epoch: currentEpoch,
          issuedAt: nowIso,
        });

        return {
          epoch: currentEpoch,
          streamId: input.streamId,
          events: [],
          queueItems,
          nextCursor,
        };
      });
    },

    push(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const currentEpoch = deps.checkpointRepo.getEpoch(db);

        const acceptedAcks: Array<{ streamId: string; seq: number }> = [];
        const conflicts: Array<{ streamId: string; seq: number; code: string; message: string }> = [];

        for (const ack of input.acks) {
          // Epoch validation
          if (ack.epoch !== currentEpoch) {
            conflicts.push({
              streamId: ack.streamId,
              seq: ack.seq,
              code: "STREAM_EPOCH_STALE",
              message: `Epoch mismatch: ack=${ack.epoch}, current=${currentEpoch}`,
            });
            continue;
          }

          // Validate cursor if provided
          if (ack.cursor) {
            try {
              const payload = deps.cursorSigner.verify(ack.cursor);
              if (payload.epoch !== currentEpoch) {
                conflicts.push({
                  streamId: ack.streamId,
                  seq: ack.seq,
                  code: "STREAM_EPOCH_STALE",
                  message: "Cursor epoch does not match current epoch",
                });
                continue;
              }
              // Enforce stream/seq binding
              if (payload.streamId !== ack.streamId || payload.seq !== ack.seq) {
                conflicts.push({
                  streamId: ack.streamId,
                  seq: ack.seq,
                  code: "AUTH_UNAUTHORIZED",
                  message: "Cursor streamId/seq does not match ack payload",
                });
                continue;
              }
            } catch {
              conflicts.push({
                streamId: ack.streamId,
                seq: ack.seq,
                code: "AUTH_UNAUTHORIZED",
                message: "Invalid ack cursor",
              });
              continue;
            }
          }

          // Monotonic checkpoint enforcement
          const lastSeq = deps.checkpointRepo.getLastAckedSeq(
            db,
            input.satelliteId,
            ack.streamId,
          );
          if (ack.seq <= lastSeq) {
            // Idempotent — already acked, still accept
            acceptedAcks.push({ streamId: ack.streamId, seq: ack.seq });
            continue;
          }

          // Advance checkpoint
          deps.checkpointRepo.setLastAckedSeq(db, {
            satelliteId: input.satelliteId,
            streamId: ack.streamId,
            seq: ack.seq,
            nowIso,
          });
          acceptedAcks.push({ streamId: ack.streamId, seq: ack.seq });
        }

        // Persist local events if provided
        if (input.localEvents?.length && deps.learningEventWriter) {
          deps.learningEventWriter(input.localEvents);
        }

        return { acceptedAcks, conflicts };
      });
    },
  };
}
```

## Test Code (Phase 2 files only)

### `test/unit/jobs/retention/friday-retention-job.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySatellitePairingRequestRepository } from "../../../../src/satellites/persistence/friday-satellite-pairing-request-repository.js";
import { createFridaySatelliteHeartbeatRepository } from "../../../../src/satellites/persistence/friday-satellite-heartbeat-repository.js";
import { createFridayOutboxMessageRepository } from "../../../../src/satellites/persistence/friday-outbox-message-repository.js";
import { createFridayLearningEventLedger } from "../../../../src/ledger/learning/friday-learning-event-ledger.js";
import { createFridaySkillRunStore } from "../../../../src/ledger/runs/friday-skill-run-store.js";
import { createFridayRetentionJob } from "../../../../src/jobs/retention/friday-retention-job.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";

describe("FridayRetentionJob", () => {
  let db: FridaySqliteLayer;

  const NOW = "2025-06-15T10:00:00.000Z";

  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();

  function insertSatellite(id: string) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    insertSatellite("sat-1");
  });

  afterEach(() => {
    db.close();
  });

  function createJob(policy?: Partial<{
    learningEventsDays: number;
    heartbeatsDays: number;
    pairingRequestsDays: number;
    outboxTerminalDays: number;
    skillRunTerminalDays: number;
  }>) {
    return createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      nowIso: () => NOW,
      policy: {
        learningEventsDays: 90,
        heartbeatsDays: 7,
        pairingRequestsDays: 7,
        outboxTerminalDays: 14,
        skillRunTerminalDays: 30,
        ...policy,
      },
    });
  }

  it("marks stale pending pairing requests as expired", () => {
    // Expired request
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-1', 'sat-1', '123456', 'nonce', 'pending', '2025-06-14T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    // Non-expired request
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-2', 'sat-1', '654321', 'nonce', 'pending', '2025-06-16T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedPairingExpired).toBe(1);

    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = 'req-1'")
      .get() as { status: string };
    expect(req.status).toBe("expired");
  });

  it("deletes old resolved pairing requests", () => {
    // Old approved request (> 7 days ago)
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-old', 'sat-1', '123456', 'nonce', 'approved', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedPairingRequests).toBe(1);
  });

  it("deletes old heartbeats", () => {
    // Old heartbeat (> 7 days ago)
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-old', 'sat-1', '2025-01-01T00:00:00.000Z', 'online')`,
      )
      .run();

    // Recent heartbeat
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-new', 'sat-1', '2025-06-15T09:00:00.000Z', 'online')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedHeartbeats).toBe(1);
  });

  it("marks TTL-expired outbox messages", () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "msg-expired", {
        satelliteId: "sat-1",
        queueKey: "commands",
        messageType: "test",
        payloadCiphertext: "data",
        nonce: "n",
        keyId: "k",
        idempotencyKey: "idem-1",
        expiresAt: "2025-06-14T00:00:00.000Z", // already expired
      }, NOW);
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedOutboxExpired).toBe(1);
  });

  it("deletes old terminal outbox messages", () => {
    // Insert and ack a message, then backdate it
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "msg-old", {
        satelliteId: "sat-1",
        queueKey: "commands",
        messageType: "test",
        payloadCiphertext: "data",
        nonce: "n",
        keyId: "k",
        idempotencyKey: "idem-2",
      }, "2025-01-01T00:00:00.000Z");
    });
    // Mark as acked with old date
    db.writer
      .prepare(
        "UPDATE outbox_messages SET status = 'acked', updated_at = '2025-01-01T00:00:00.000Z' WHERE id = 'msg-old'",
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedOutboxTerminal).toBe(1);
  });

  it("deletes old learning events", () => {
    db.writer
      .prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES ('evt-old', '2024-01-01T00:00:00.000Z', 'test-user', 'user_message', '{}', '2024-01-01T00:00:00.000Z')`,
      )
      .run();

    db.writer
      .prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES ('evt-new', '2025-06-14T00:00:00.000Z', 'test-user', 'user_message', '{}', '2025-06-14T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedLearningEvents).toBe(1);
  });

  it("deletes old terminal skill run snapshots", () => {
    const store = createFridaySkillRunStore({ db });
    store.upsertRun({
      runId: "run-old",
      skillId: "s",
      version: "1.0",
      status: "completed",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: "2024-01-01T00:00:00.000Z",
    });

    store.upsertRun({
      runId: "run-recent",
      skillId: "s",
      version: "1.0",
      status: "completed",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: NOW,
      updatedAt: NOW,
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: NOW,
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedSkillRuns).toBe(1);
  });

  it("returns all zeros when nothing to clean", () => {
    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedPairingExpired).toBe(0);
    expect(result.deletedPairingRequests).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
    expect(result.markedOutboxExpired).toBe(0);
    expect(result.deletedOutboxTerminal).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
  });

  it("preserves non-expired rows", () => {
    // Recent pending pairing request (not yet expired)
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-fresh', 'sat-1', '000000', 'nonce', 'pending', '2025-06-16T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    // Recent heartbeat
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-fresh', 'sat-1', ?, 'online')`,
      )
      .run(NOW);

    // Running skill run (non-terminal)
    const store = createFridaySkillRunStore({ db });
    store.upsertRun({
      runId: "run-active",
      skillId: "s",
      version: "1.0",
      status: "running",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: "2024-01-01T00:00:00.000Z",
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedPairingExpired).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);

    // Active run preserved
    const run = store.getRun("run-active");
    expect(run).not.toBeNull();
  });
});
```

### `test/unit/ledger/learning/friday-learning-event-ledger.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import type { FridayLearningEventAppendInput } from "../../../../src/ledger/learning/friday-learning-event-ledger.types.js";
import { createFridayLearningEventLedger } from "../../../../src/ledger/learning/friday-learning-event-ledger.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";

describe("FridayLearningEventLedger", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  const baseEvent: FridayLearningEventAppendInput = {
    eventId: "evt-001",
    ts: NOW,
    userId: "test-user",
    kind: "user_message",
    payload: { text: "hello world" },
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createLedger() {
    return createFridayLearningEventLedger({ db });
  }

  it("appends event and returns inserted=true", () => {
    const ledger = createLedger();
    const result = ledger.appendEvent(baseEvent);
    expect(result.inserted).toBe(true);
  });

  it("is idempotent on duplicate eventId", () => {
    const ledger = createLedger();
    ledger.appendEvent(baseEvent);
    const result = ledger.appendEvent(baseEvent);
    expect(result.inserted).toBe(false);

    // Only one row in DB
    const count = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM learning_events")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("appendBatch inserts multiple events", () => {
    const ledger = createLedger();
    const events: FridayLearningEventAppendInput[] = [
      { ...baseEvent, eventId: "evt-001" },
      { ...baseEvent, eventId: "evt-002", kind: "assistant_message" },
      { ...baseEvent, eventId: "evt-003", kind: "tool_result" },
    ];

    const results = ledger.appendBatch(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.inserted)).toBe(true);
  });

  it("appendBatch is idempotent for duplicates in batch", () => {
    const ledger = createLedger();
    ledger.appendEvent(baseEvent); // pre-insert

    const results = ledger.appendBatch([
      baseEvent, // duplicate
      { ...baseEvent, eventId: "evt-002" }, // new
    ]);

    expect(results[0]!.inserted).toBe(false);
    expect(results[1]!.inserted).toBe(true);
  });

  it("listByUser returns events for user", () => {
    const ledger = createLedger();
    ledger.appendEvent(baseEvent);
    ledger.appendEvent({ ...baseEvent, eventId: "evt-002", ts: "2025-01-15T10:01:00.000Z" });

    const events = ledger.listByUser({ userId: "test-user" });
    expect(events).toHaveLength(2);
    // Most recent first
    expect(events[0]!.eventId).toBe("evt-002");
  });

  it("listByUser filters by kind", () => {
    const ledger = createLedger();
    ledger.appendEvent({ ...baseEvent, eventId: "evt-001", kind: "user_message" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-002", kind: "assistant_message" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-003", kind: "tool_result" });

    const events = ledger.listByUser({
      userId: "test-user",
      kinds: ["user_message", "tool_result"],
    });
    expect(events).toHaveLength(2);
  });

  it("listByUser filters by time range", () => {
    const ledger = createLedger();
    ledger.appendEvent({ ...baseEvent, eventId: "evt-001", ts: "2025-01-15T09:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-002", ts: "2025-01-15T10:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-003", ts: "2025-01-15T11:00:00.000Z" });

    const events = ledger.listByUser({
      userId: "test-user",
      fromTs: "2025-01-15T09:30:00.000Z",
      toTs: "2025-01-15T10:30:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe("evt-002");
  });

  it("listByUser respects limit", () => {
    const ledger = createLedger();
    for (let i = 1; i <= 5; i++) {
      ledger.appendEvent({
        ...baseEvent,
        eventId: `evt-${String(i).padStart(3, "0")}`,
        ts: `2025-01-15T10:0${i}:00.000Z`,
      });
    }

    const events = ledger.listByUser({ userId: "test-user", limit: 2 });
    expect(events).toHaveLength(2);
  });

  it("pruneBefore deletes old events", () => {
    const ledger = createLedger();
    ledger.appendEvent({ ...baseEvent, eventId: "old-1", ts: "2024-01-01T00:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "old-2", ts: "2024-06-01T00:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "new-1", ts: "2025-01-15T10:00:00.000Z" });

    const deleted = ledger.pruneBefore("2025-01-01T00:00:00.000Z");
    expect(deleted).toBe(2);

    const remaining = ledger.listByUser({ userId: "test-user" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.eventId).toBe("new-1");
  });

  it("stores and retrieves payload correctly", () => {
    const ledger = createLedger();
    const payload = { text: "test", nested: { key: "value" }, arr: [1, 2, 3] };
    ledger.appendEvent({ ...baseEvent, payload });

    const events = ledger.listByUser({ userId: "test-user" });
    expect(events[0]!.payload).toEqual(payload);
  });

  it("handles optional sessionId and runId", () => {
    const ledger = createLedger();
    ledger.appendEvent({
      eventId: "evt-no-session",
      ts: NOW,
      userId: "test-user",
      kind: "error_incident",
      payload: { error: "something" },
    });

    const events = ledger.listByUser({ userId: "test-user" });
    expect(events[0]!.sessionId).toBeUndefined();
    expect(events[0]!.runId).toBeUndefined();
  });
});
```

### `test/unit/ledger/runs/friday-skill-run-checkpoint-writer.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import type { FridaySkillRunSnapshot } from "../../../../src/ledger/runs/friday-skill-run-store.types.js";
import type { FridayLearningEventAppendInput } from "../../../../src/ledger/learning/friday-learning-event-ledger.types.js";
import { createFridaySkillRunCheckpointWriter } from "../../../../src/ledger/runs/friday-skill-run-checkpoint-writer.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";

describe("FridaySkillRunCheckpointWriter", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  const baseSnapshot: FridaySkillRunSnapshot = {
    runId: "run-001",
    skillId: "skill-timer",
    version: "1.0.0",
    status: "running",
    currentStepId: "step-1",
    attemptsByStep: { "step-1": 1 },
    state: { counter: 0 },
    startedAt: NOW,
    updatedAt: NOW,
    sessionId: "session-1",
    userId: "test-user",
    channel: "discord",
    lastTransitionAt: NOW,
  };

  const baseEvent: FridayLearningEventAppendInput = {
    eventId: "evt-001",
    ts: NOW,
    userId: "test-user",
    kind: "workflow_outcome",
    payload: { result: "success" },
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createWriter() {
    return createFridaySkillRunCheckpointWriter({ db });
  }

  it("persists run snapshot without learning event", () => {
    const writer = createWriter();
    const result = writer.persistCheckpoint({ run: baseSnapshot });

    expect(result.runPersisted).toBe(true);
    expect(result.eventInserted).toBeUndefined();

    // Verify in DB
    const row = db.writer
      .prepare("SELECT value_json FROM memory_items WHERE namespace = 'skill_runs' AND key = 'run-001'")
      .get() as { value_json: string };
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row.value_json);
    expect(parsed.runId).toBe("run-001");
  });

  it("persists run snapshot with learning event atomically", () => {
    const writer = createWriter();
    const result = writer.persistCheckpoint({
      run: baseSnapshot,
      learningEvent: baseEvent,
    });

    expect(result.runPersisted).toBe(true);
    expect(result.eventInserted).toBe(true);

    // Both should exist
    const runRow = db.writer
      .prepare("SELECT * FROM memory_items WHERE namespace = 'skill_runs' AND key = 'run-001'")
      .get();
    expect(runRow).toBeTruthy();

    const eventRow = db.writer
      .prepare("SELECT * FROM learning_events WHERE event_id = 'evt-001'")
      .get();
    expect(eventRow).toBeTruthy();
  });

  it("learning event is idempotent on duplicate eventId", () => {
    const writer = createWriter();

    writer.persistCheckpoint({
      run: baseSnapshot,
      learningEvent: baseEvent,
    });

    const result = writer.persistCheckpoint({
      run: { ...baseSnapshot, updatedAt: "2025-01-15T10:01:00.000Z" },
      learningEvent: baseEvent, // same eventId
    });

    expect(result.eventInserted).toBe(false);

    // Only one event row
    const count = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM learning_events WHERE event_id = 'evt-001'")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("updates run snapshot on repeated persist", () => {
    const writer = createWriter();

    writer.persistCheckpoint({ run: baseSnapshot });

    const updatedSnapshot: FridaySkillRunSnapshot = {
      ...baseSnapshot,
      status: "completed",
      updatedAt: "2025-01-15T10:05:00.000Z",
    };

    writer.persistCheckpoint({ run: updatedSnapshot });

    const row = db.writer
      .prepare("SELECT value_json FROM memory_items WHERE namespace = 'skill_runs' AND key = 'run-001'")
      .get() as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.status).toBe("completed");
  });

  it("rolls back run snapshot when learning event insert fails (FK violation)", () => {
    const writer = createWriter();

    // Use an invalid user_id that violates FK constraint on learning_events
    const badEvent: FridayLearningEventAppendInput = {
      eventId: "evt-bad",
      ts: NOW,
      userId: "nonexistent-user-fk-violation",
      kind: "workflow_outcome",
      payload: { result: "fail" },
    };

    expect(() =>
      writer.persistCheckpoint({
        run: { ...baseSnapshot, runId: "run-rollback" },
        learningEvent: badEvent,
      }),
    ).toThrow(); // FK violation

    // Verify run snapshot was NOT persisted (rolled back)
    const runRow = db.writer
      .prepare(
        "SELECT * FROM memory_items WHERE namespace = 'skill_runs' AND key = 'run-rollback'",
      )
      .get();
    expect(runRow).toBeUndefined();

    // Verify event was NOT persisted
    const eventRow = db.writer
      .prepare("SELECT * FROM learning_events WHERE event_id = 'evt-bad'")
      .get();
    expect(eventRow).toBeUndefined();
  });

  it("atomic commit: both run and event persist together", () => {
    const writer = createWriter();

    // First checkpoint with event
    writer.persistCheckpoint({
      run: baseSnapshot,
      learningEvent: baseEvent,
    });

    // Second checkpoint with different run and event
    const result = writer.persistCheckpoint({
      run: { ...baseSnapshot, runId: "run-002" },
      learningEvent: { ...baseEvent, eventId: "evt-002" },
    });

    expect(result.runPersisted).toBe(true);
    expect(result.eventInserted).toBe(true);

    // Both runs should exist
    const runs = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM memory_items WHERE namespace = 'skill_runs'")
      .get() as { cnt: number };
    expect(runs.cnt).toBe(2);

    // Both events should exist
    const events = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM learning_events")
      .get() as { cnt: number };
    expect(events.cnt).toBe(2);
  });
});
```

### `test/unit/ledger/runs/friday-skill-run-store.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import type { FridaySkillRunSnapshot } from "../../../../src/ledger/runs/friday-skill-run-store.types.js";
import { createFridaySkillRunStore } from "../../../../src/ledger/runs/friday-skill-run-store.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";

describe("FridaySkillRunStore", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  interface TestState {
    counter: number;
    items: string[];
  }

  const baseSnapshot: FridaySkillRunSnapshot<TestState> = {
    runId: "run-001",
    skillId: "skill-timer",
    version: "1.0.0",
    status: "running",
    currentStepId: "step-1",
    attemptsByStep: { "step-1": 1 },
    state: { counter: 0, items: ["a", "b"] },
    startedAt: NOW,
    updatedAt: NOW,
    sessionId: "session-1",
    userId: "test-user",
    channel: "discord",
    lastTransitionAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createStore() {
    return createFridaySkillRunStore({ db });
  }

  it("upsertRun and getRun roundtrip", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);

    const retrieved = store.getRun<TestState>("run-001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.runId).toBe("run-001");
    expect(retrieved!.status).toBe("running");
    expect(retrieved!.state.counter).toBe(0);
    expect(retrieved!.state.items).toEqual(["a", "b"]);
    expect(retrieved!.sessionId).toBe("session-1");
    expect(retrieved!.userId).toBe("test-user");
    expect(retrieved!.channel).toBe("discord");
  });

  it("upsertRun updates existing run", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);

    const updated: FridaySkillRunSnapshot<TestState> = {
      ...baseSnapshot,
      status: "completed",
      state: { counter: 5, items: ["a", "b", "c"] },
      updatedAt: "2025-01-15T10:05:00.000Z",
    };
    store.upsertRun(updated);

    const retrieved = store.getRun<TestState>("run-001");
    expect(retrieved!.status).toBe("completed");
    expect(retrieved!.state.counter).toBe(5);
  });

  it("getRun returns null for nonexistent run", () => {
    const store = createStore();
    const result = store.getRun("nonexistent");
    expect(result).toBeNull();
  });

  it("listRuns returns all runs", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({ ...baseSnapshot, runId: "run-002", updatedAt: "2025-01-15T10:01:00.000Z" });

    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
  });

  it("listRuns filters by skillId", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({ ...baseSnapshot, runId: "run-002", skillId: "skill-other" });

    const runs = store.listRuns({ skillId: "skill-timer" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.skillId).toBe("skill-timer");
  });

  it("listRuns filters by status", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-002",
      status: "completed",
    });

    const runs = store.listRuns({ status: "running" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe("run-001");
  });

  it("listRuns filters by userId", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-002",
      userId: "other-user",
    });

    const runs = store.listRuns({ userId: "test-user" });
    expect(runs).toHaveLength(1);
  });

  it("listRuns respects limit", () => {
    const store = createStore();
    for (let i = 1; i <= 5; i++) {
      store.upsertRun({
        ...baseSnapshot,
        runId: `run-${String(i).padStart(3, "0")}`,
        updatedAt: `2025-01-15T10:0${i}:00.000Z`,
      });
    }

    const runs = store.listRuns({ limit: 3 });
    expect(runs).toHaveLength(3);
  });

  it("pruneTerminalRunsBefore deletes old completed/failed/cancelled runs", () => {
    const store = createStore();
    // Old completed
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-old-completed",
      status: "completed",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Old failed
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-old-failed",
      status: "failed",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Recent completed
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-new-completed",
      status: "completed",
      updatedAt: "2025-01-15T10:00:00.000Z",
    });
    // Active running
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-active",
      status: "running",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const deleted = store.pruneTerminalRunsBefore("2025-01-01T00:00:00.000Z");
    expect(deleted).toBe(2); // old completed + old failed

    const remaining = store.listRuns();
    expect(remaining).toHaveLength(2);
  });

  it("preserves metadata field", () => {
    const store = createStore();
    const withMeta: FridaySkillRunSnapshot<TestState> = {
      ...baseSnapshot,
      metadata: { priority: "high", tags: ["urgent"] },
    };
    store.upsertRun(withMeta);

    const retrieved = store.getRun<TestState>("run-001");
    expect(retrieved!.metadata).toEqual({ priority: "high", tags: ["urgent"] });
  });
});
```

### `test/unit/satellites/_helpers/create-test-db.ts`
```ts
import Database from "better-sqlite3";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { runFridayMigrations } from "../../../../src/state/sqlite/friday-migration-runner.js";
import { FRIDAY_SQLITE_MIGRATIONS } from "../../../../src/state/sqlite/migrations/index.js";

/**
 * Creates an in-memory SQLite database with all V001 schema tables
 * and wraps it in a minimal FridaySqliteLayer for testing.
 */
export function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  // Insert a test user for FK constraints on learning_events
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (db: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

/** Counter-based ID generator for deterministic tests. */
export function createTestIdGenerator(): () => string {
  let counter = 0;
  return () => `test-id-${String(++counter).padStart(4, "0")}`;
}
```

### `test/unit/satellites/protocol/friday-ack-resume-validator.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayResumeCursorSigner } from "../../../../src/satellites/protocol/friday-resume-cursor-signer.js";
import { createFridayAckResumeValidator } from "../../../../src/satellites/protocol/friday-ack-resume-validator.js";
import type { FridayWsResumeFrame } from "../../../../src/hub/services/friday-hub-gateway-ingress.types.js";

describe("FridayAckResumeValidator", () => {
  const secret = "test-validator-secret";
  const signer = createFridayResumeCursorSigner(secret);
  const validator = createFridayAckResumeValidator(signer);

  function makeResumeFrame(overrides: Partial<FridayWsResumeFrame> = {}): FridayWsResumeFrame {
    const cursor = signer.sign({
      seq: 10,
      streamId: "stream-001",
      epoch: 5,
      issuedAt: "2025-01-15T10:00:00.000Z",
    });
    return {
      type: "resume",
      lastAckedSeq: 10,
      streamId: "stream-001",
      epoch: 5,
      cursor,
      subscriptions: ["events"],
      emittedAt: "2025-01-15T10:05:00.000Z",
      ...overrides,
    };
  }

  it("accepts valid resume frame", () => {
    const frame = makeResumeFrame();
    const result = validator.validateResume(frame, 5);
    expect(result).toEqual({ ok: true, effectiveSeq: 10 });
  });

  it("rejects tampered cursor", () => {
    const frame = makeResumeFrame({ cursor: "tampered.cursor" });
    const result = validator.validateResume(frame, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AUTH_UNAUTHORIZED");
    }
  });

  it("rejects stale epoch in cursor", () => {
    // Cursor signed with epoch 5, but current epoch is 6
    const frame = makeResumeFrame();
    const result = validator.validateResume(frame, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STREAM_EPOCH_STALE");
    }
  });

  it("rejects epoch mismatch between frame and cursor", () => {
    // Frame says epoch 6 but cursor was signed with epoch 5
    const frame = makeResumeFrame({ epoch: 6 });
    const result = validator.validateResume(frame, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STREAM_EPOCH_STALE");
    }
  });

  it("rejects stream ID mismatch between frame and cursor", () => {
    const frame = makeResumeFrame({ streamId: "different-stream" });
    const result = validator.validateResume(frame, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AUTH_UNAUTHORIZED");
    }
  });

  it("rejects seq mismatch between frame and cursor", () => {
    const frame = makeResumeFrame({ lastAckedSeq: 999 });
    const result = validator.validateResume(frame, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STREAM_CURSOR_OUT_OF_RANGE");
    }
  });
});
```

### `test/unit/satellites/protocol/friday-resume-cursor-signer.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayResumeCursorSigner } from "../../../../src/satellites/protocol/friday-resume-cursor-signer.js";

describe("FridayResumeCursorSigner", () => {
  const secret = "test-secret-key-for-hmac-signing";
  const signer = createFridayResumeCursorSigner(secret);

  const payload = {
    seq: 42,
    streamId: "stream-001",
    epoch: 3,
    issuedAt: "2025-01-15T10:00:00.000Z",
  };

  it("roundtrips sign → verify", () => {
    const cursor = signer.sign(payload);
    const verified = signer.verify(cursor);
    expect(verified).toEqual(payload);
  });

  it("produces a cursor with payload.signature format", () => {
    const cursor = signer.sign(payload);
    expect(cursor).toContain(".");
    const parts = cursor.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });

  it("detects tampered payload", () => {
    const cursor = signer.sign(payload);
    const [payloadB64, sig] = cursor.split(".");
    // Tamper with the payload
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, seq: 999 }),
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;
    expect(() => signer.verify(tampered)).toThrow("HMAC verification failed");
  });

  it("detects tampered signature", () => {
    const cursor = signer.sign(payload);
    const [payloadB64] = cursor.split(".");
    const tampered = `${payloadB64}.invalid-signature`;
    expect(() => signer.verify(tampered)).toThrow("HMAC verification failed");
  });

  it("rejects cursor without separator", () => {
    expect(() => signer.verify("noseparatorhere")).toThrow("missing signature separator");
  });

  it("different secrets produce different signatures", () => {
    const otherSigner = createFridayResumeCursorSigner("different-secret");
    const cursor1 = signer.sign(payload);
    const cursor2 = otherSigner.sign(payload);
    expect(cursor1).not.toEqual(cursor2);
  });

  it("cursor signed by one secret cannot be verified by another", () => {
    const otherSigner = createFridayResumeCursorSigner("different-secret");
    const cursor = signer.sign(payload);
    expect(() => otherSigner.verify(cursor)).toThrow("HMAC verification failed");
  });
});
```

### `test/unit/satellites/services/friday-outbox-queue-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import type { FridayOutboxEnqueueInput } from "../../../../src/satellites/model/friday-outbox.types.js";
import { createFridayOutboxMessageRepository } from "../../../../src/satellites/persistence/friday-outbox-message-repository.js";
import { createFridayOutboxQueueService } from "../../../../src/satellites/services/friday-outbox-queue-service.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";

describe("FridayOutboxQueueService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  function insertSatellite(id: string) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  const baseEnqueue: FridayOutboxEnqueueInput = {
    satelliteId: "sat-1",
    queueKey: "commands",
    messageType: "skill.execute",
    payloadCiphertext: "encrypted-data",
    nonce: "nonce-1",
    keyId: "key-1",
    idempotencyKey: "idem-1",
  };

  beforeEach(() => {
    db = createTestDb();
    insertSatellite("sat-1");
  });

  afterEach(() => {
    db.close();
  });

  function createService(nowIso = NOW) {
    return createFridayOutboxQueueService({
      db,
      outboxRepo: createFridayOutboxMessageRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => nowIso,
    });
  }

  it("enqueues message with queued status", () => {
    const service = createService();
    const { id } = service.enqueue(baseEnqueue);
    expect(id).toBeTruthy();

    const row = db.writer
      .prepare("SELECT status FROM outbox_messages WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("queued");
  });

  it("idempotent enqueue with same idempotency key", () => {
    const service = createService();
    service.enqueue(baseEnqueue);
    // Second enqueue with same key should not throw
    const { id: id2 } = service.enqueue(baseEnqueue);

    const count = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM outbox_messages WHERE satellite_id = 'sat-1'")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("leaseBatch transitions queued → leased", () => {
    const service = createService();
    service.enqueue(baseEnqueue);
    service.enqueue({ ...baseEnqueue, idempotencyKey: "idem-2" });

    const leased = service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    expect(leased).toHaveLength(2);
    expect(leased[0]!.messageType).toBe("skill.execute");

    // Verify DB status
    const rows = db.writer
      .prepare("SELECT status FROM outbox_messages WHERE satellite_id = 'sat-1'")
      .all() as Array<{ status: string }>;
    expect(rows.every((r) => r.status === "leased")).toBe(true);
  });

  it("ackUpToSeq transitions leased → acked", () => {
    const service = createService();
    service.enqueue(baseEnqueue);

    const leased = service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });
    expect(leased).toHaveLength(1);

    const result = service.ackUpToSeq({
      satelliteId: "sat-1",
      streamId: "stream-1",
      seq: leased[0]!.seq,
    });

    expect(result.acked).toBe(1);

    const row = db.writer
      .prepare("SELECT status FROM outbox_messages WHERE id = ?")
      .get(leased[0]!.id) as { status: string };
    expect(row.status).toBe("acked");
  });

  it("failLeasedMessage with retryable goes back to queued", () => {
    const service = createService();
    const { id } = service.enqueue(baseEnqueue);

    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    const result = service.failLeasedMessage({
      messageId: id,
      satelliteId: "sat-1",
      errorCode: "TIMEOUT",
      errorMessage: "Connection timeout",
      retryable: true,
    });

    expect(result.status).toBe("queued");
    expect(result.nextDeliverAfter).toBeTruthy();
  });

  it("failLeasedMessage non-retryable goes to dead_letter", () => {
    const service = createService();
    const { id } = service.enqueue(baseEnqueue);

    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    const result = service.failLeasedMessage({
      messageId: id,
      satelliteId: "sat-1",
      errorCode: "INVALID_PAYLOAD",
      errorMessage: "Cannot parse payload",
      retryable: false,
    });

    expect(result.status).toBe("dead_letter");
  });

  it("failLeasedMessage exceeding max_attempts goes to dead_letter", () => {
    const service = createService();
    const { id } = service.enqueue({ ...baseEnqueue, maxAttempts: 1 });

    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    const result = service.failLeasedMessage({
      messageId: id,
      satelliteId: "sat-1",
      errorCode: "TIMEOUT",
      errorMessage: "Timeout",
      retryable: true,
    });

    expect(result.status).toBe("dead_letter");
  });

  it("requeueExpiredLeases puts expired leases back to queued", () => {
    const service = createService();
    service.enqueue(baseEnqueue);

    // Lease with very short lease time
    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 1, // 1ms lease
      nowIso: NOW,
    });

    // Time passes, lease expires
    const laterService = createService("2025-01-15T10:01:00.000Z");
    const requeued = laterService.requeueExpiredLeases("2025-01-15T10:01:00.000Z");
    expect(requeued).toBe(1);
  });

  it("expireByTtl marks expired messages", () => {
    const service = createService();
    service.enqueue({
      ...baseEnqueue,
      expiresAt: "2025-01-15T09:00:00.000Z", // already expired
    });

    const expired = service.expireByTtl();
    expect(expired).toBe(1);

    const row = db.writer
      .prepare("SELECT status FROM outbox_messages")
      .get() as { status: string };
    expect(row.status).toBe("expired");
  });

  it("does not lease messages with future deliverAfter", () => {
    const service = createService();
    service.enqueue({
      ...baseEnqueue,
      deliverAfter: "2025-01-15T11:00:00.000Z",
    });

    const leased = service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    expect(leased).toHaveLength(0);
  });
});
```

### `test/unit/satellites/services/friday-satellite-capability-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySatelliteRepository } from "../../../../src/satellites/persistence/friday-satellite-repository.js";
import { createFridaySatelliteCapabilityRepository } from "../../../../src/satellites/persistence/friday-satellite-capability-repository.js";
import { createFridaySatelliteCapabilityService } from "../../../../src/satellites/services/friday-satellite-capability-service.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";

describe("FridaySatelliteCapabilityService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  const satelliteRepo = createFridaySatelliteRepository();
  const capabilityRepo = createFridaySatelliteCapabilityRepository();

  beforeEach(() => {
    db = createTestDb();
    // Insert a satellite for FK constraints
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES ('sat-1', 'phone', 'Test', 'paired', 'restricted', 'pk-1', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createService(revisionCache?: Map<string, number>) {
    return createFridaySatelliteCapabilityService({
      db,
      satelliteRepo,
      capabilityRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      revisionCache: revisionCache ?? new Map(),
    });
  }

  it("accepts capability report with new revision", () => {
    const service = createService();
    const result = service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 1,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [
        { key: "camera", available: true },
        { key: "gps", available: false },
      ],
    });

    expect(result.accepted).toBe(true);

    const caps = db.writer
      .prepare("SELECT * FROM satellite_capabilities WHERE satellite_id = 'sat-1' ORDER BY key")
      .all() as Array<Record<string, unknown>>;
    expect(caps).toHaveLength(2);
    expect(caps[0]!.key).toBe("camera");
    expect(caps[1]!.key).toBe("gps");
  });

  it("enforces monotonic revision", () => {
    const cache = new Map<string, number>();
    const service = createService(cache);

    // First report: revision 3
    service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 3,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: true }],
    });

    // Stale report: revision 2
    const result = service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 2,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: false }],
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("Stale revision");
  });

  it("upserts capabilities by (satellite_id, key)", () => {
    const cache = new Map<string, number>();
    const service = createService(cache);

    service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 1,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: true }],
    });

    service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 2,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: false }],
    });

    const caps = db.writer
      .prepare("SELECT available FROM satellite_capabilities WHERE satellite_id = 'sat-1' AND key = 'camera'")
      .get() as { available: number };
    expect(caps.available).toBe(0);
  });

  it("rejects report for unknown satellite", () => {
    const service = createService();
    const result = service.updateCapabilities({
      satelliteId: "nonexistent",
      revision: 1,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [],
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("not found");
  });
});
```

### `test/unit/satellites/services/friday-satellite-heartbeat-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySatelliteRepository } from "../../../../src/satellites/persistence/friday-satellite-repository.js";
import { createFridaySatelliteHeartbeatRepository } from "../../../../src/satellites/persistence/friday-satellite-heartbeat-repository.js";
import { createFridaySatelliteHeartbeatService } from "../../../../src/satellites/services/friday-satellite-heartbeat-service.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";

describe("FridaySatelliteHeartbeatService", () => {
  let db: FridaySqliteLayer;

  const satelliteRepo = createFridaySatelliteRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();

  function insertSatellite(nowIso: string, status = "paired") {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES ('sat-1', 'phone', 'Test', ?, 'restricted', 'pk-1', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(status, nowIso, nowIso);
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("transitions paired → online with fresh heartbeat (< 30s)", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW);

    // Heartbeat timestamp = now (0s age)
    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("online");
  });

  it("transitions to degraded when heartbeat age is 30-90s", () => {
    const NOW = "2025-01-15T10:01:00.000Z"; // 60s after heartbeat ts
    insertSatellite("2025-01-15T10:00:00.000Z");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: "2025-01-15T10:00:00.000Z", // 60s old
    });

    expect(result.status).toBe("degraded");
  });

  it("transitions to offline when heartbeat age > 90s", () => {
    const NOW = "2025-01-15T10:02:00.000Z"; // 120s after heartbeat ts
    insertSatellite("2025-01-15T10:00:00.000Z");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: "2025-01-15T10:00:00.000Z", // 120s old
    });

    expect(result.status).toBe("offline");
  });

  it("transitions to degraded on high failure rate", () => {
    const NOW = "2025-01-15T10:00:10.000Z"; // 10s after heartbeat (fresh)
    insertSatellite("2025-01-15T10:00:00.000Z");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
      failureRate1m: 0.75, // above 0.5 threshold
    });

    expect(result.status).toBe("degraded");
  });

  it("transitions to offline on explicit disconnect", () => {
    const NOW = "2025-01-15T10:00:05.000Z";
    insertSatellite("2025-01-15T10:00:00.000Z", "online");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
      explicitDisconnect: true,
    });

    expect(result.status).toBe("offline");
  });

  it("does not promote revoked satellite", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW, "revoked");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
    });

    expect(result.status).toBe("revoked");
  });

  it("records heartbeat row with metrics", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW);

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
      metrics: { cpuPercent: 45, memoryPercent: 60, loadAvg1m: 1.5 },
      queueDepth: 3,
      activeRuns: 1,
    });

    const row = db.writer
      .prepare("SELECT * FROM satellite_heartbeats WHERE satellite_id = 'sat-1'")
      .get() as Record<string, unknown>;
    expect(row.cpu_percent).toBe(45);
    expect(row.memory_percent).toBe(60);
    expect(row.load_avg_1m).toBe(1.5);
    expect(row.queue_depth).toBe(3);
    expect(row.active_runs).toBe(1);
  });

  it("throws for unknown satellite", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW);

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    expect(() =>
      service.recordHeartbeat({
        satelliteId: "nonexistent",
        ts: NOW,
      }),
    ).toThrow("not found");
  });
});
```

### `test/unit/satellites/services/friday-satellite-offline-sweeper.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySatelliteRepository } from "../../../../src/satellites/persistence/friday-satellite-repository.js";
import { createFridaySatelliteOfflineSweeper } from "../../../../src/satellites/services/friday-satellite-offline-sweeper.js";
import { createTestDb } from "../_helpers/create-test-db.js";

describe("FridaySatelliteOfflineSweeper", () => {
  let db: FridaySqliteLayer;
  const satelliteRepo = createFridaySatelliteRepository();

  function insertSatellite(
    id: string,
    status: string,
    lastSeenAt: string | null,
    createdAt = "2025-01-15T09:00:00.000Z",
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json,
         last_seen_at, created_at, updated_at)
         VALUES (?, 'phone', 'Test', ?, 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
      )
      .run(id, status, lastSeenAt, createdAt, createdAt);
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("marks stale online satellite as degraded (30-90s)", () => {
    // Last seen 60s ago
    insertSatellite("sat-1", "online", "2025-01-15T09:59:00.000Z");
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(1);
    expect(result.markedOffline).toBe(0);

    const sat = db.writer
      .prepare("SELECT pairing_status FROM satellites WHERE id = 'sat-1'")
      .get() as { pairing_status: string };
    expect(sat.pairing_status).toBe("degraded");
  });

  it("marks very stale satellite as offline (> 90s)", () => {
    // Last seen 120s ago
    insertSatellite("sat-1", "online", "2025-01-15T09:58:00.000Z");
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(0);
    expect(result.markedOffline).toBe(1);
  });

  it("leaves revoked satellite untouched", () => {
    insertSatellite("sat-1", "revoked", "2025-01-15T08:00:00.000Z");
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(0);
    expect(result.markedOffline).toBe(0);

    const sat = db.writer
      .prepare("SELECT pairing_status FROM satellites WHERE id = 'sat-1'")
      .get() as { pairing_status: string };
    expect(sat.pairing_status).toBe("revoked");
  });

  it("leaves recently seen online satellite alone", () => {
    // Last seen 10s ago — still online
    insertSatellite("sat-1", "online", "2025-01-15T09:59:50.000Z");
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(0);
    expect(result.markedOffline).toBe(0);
  });

  it("sweeps multiple satellites with mixed statuses", () => {
    insertSatellite("sat-online-fresh", "online", "2025-01-15T09:59:55.000Z");
    insertSatellite("sat-online-stale", "online", "2025-01-15T09:59:00.000Z"); // 60s → degraded
    insertSatellite("sat-degraded-dead", "degraded", "2025-01-15T09:57:00.000Z"); // 180s → offline
    insertSatellite("sat-revoked", "revoked", "2025-01-15T08:00:00.000Z"); // untouched

    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(1);
    expect(result.markedOffline).toBe(1);
  });
});
```

### `test/unit/satellites/services/friday-satellite-pairing-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySatelliteRepository } from "../../../../src/satellites/persistence/friday-satellite-repository.js";
import { createFridaySatellitePairingRequestRepository } from "../../../../src/satellites/persistence/friday-satellite-pairing-request-repository.js";
import { createFridaySatelliteCapabilityRepository } from "../../../../src/satellites/persistence/friday-satellite-capability-repository.js";
import { createFridayApiTokenRepository } from "../../../../src/satellites/persistence/friday-api-token-repository.js";
import { createFridayStreamCheckpointRepository } from "../../../../src/satellites/persistence/friday-stream-checkpoint-repository.js";
import { createFridaySatelliteRegistrationService } from "../../../../src/satellites/services/friday-satellite-registration-service.js";
import {
  createFridaySatellitePairingService,
  type FridayHandshakeAlgorithm,
} from "../../../../src/satellites/services/friday-satellite-pairing-service.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";

// Generate a deterministic RSA key pair for testing
const TEST_KEY_PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const WRONG_KEY_PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function signChallenge(privateKey: string, nonce: string): string {
  const signer = createSign("SHA256");
  signer.update(nonce);
  signer.end();
  return signer.sign(privateKey, "base64");
}

describe("FridaySatellitePairingService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const LATER = "2025-01-15T10:05:00.000Z";

  const satelliteRepo = createFridaySatelliteRepository();
  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const capabilityRepo = createFridaySatelliteCapabilityRepository();
  const apiTokenRepo = createFridayApiTokenRepository();
  const checkpointRepo = createFridayStreamCheckpointRepository();

  const EPHEMERAL_KEY = { publicKey: "test-server-ephemeral-pub", privateKey: "test-server-ephemeral-priv" };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function registerSatellite(publicKey: string = TEST_KEY_PAIR.publicKey as string) {
    const idGen = createTestIdGenerator();
    const regService = createFridaySatelliteRegistrationService({
      db,
      satelliteRepo,
      pairingRequestRepo,
      capabilityRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      pairingTtlMs: 10 * 60 * 1000,
    });
    return regService.register({
      type: "phone",
      displayName: "Test Phone",
      publicKey,
      runtime: { platform: "linux", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
      transport: "ws",
    });
  }

  function createPairingService(nowIso: string = LATER) {
    return createFridaySatellitePairingService({
      db,
      satelliteRepo,
      pairingRequestRepo,
      apiTokenRepo,
      checkpointRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => nowIso,
      generateEphemeralKeyPair: () => EPHEMERAL_KEY,
    });
  }

  function buildHandshakeInput(
    satelliteId: string,
    token: string,
    challengeNonce: string,
    privateKey: string = TEST_KEY_PAIR.privateKey as string,
    algorithms: FridayHandshakeAlgorithm[] = ["xchacha20-poly1305", "aes-256-gcm"],
  ) {
    return {
      satelliteId,
      token,
      signedChallenge: signChallenge(privateKey, challengeNonce),
      challengeNonce,
      clientEphemeralPublicKey: "client-ephemeral-pub-key",
      supportedAlgorithms: algorithms,
    };
  }

  it("approves pairing, issues token, updates statuses", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const result = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read", "write"],
    });

    expect(result.token).toBeTruthy();
    expect(result.tokenId).toBeTruthy();
    expect(result.tokenVersion).toBe(1);

    // Satellite should be paired
    const sat = db.writer
      .prepare("SELECT pairing_status FROM satellites WHERE id = ?")
      .get(reg.satelliteId) as { pairing_status: string };
    expect(sat.pairing_status).toBe("paired");

    // Request should be approved
    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = ?")
      .get(reg.pairingRequestId) as { status: string };
    expect(req.status).toBe("approved");

    // Token should exist in api_tokens with version in label
    const tokens = db.writer
      .prepare("SELECT * FROM api_tokens WHERE principal_type = 'satellite'")
      .all() as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    expect((tokens[0]! as { label: string }).label).toContain(":v1");
  });

  it("rejects expired pairing request", () => {
    const reg = registerSatellite();
    // Use time after expiry
    const pairing = createPairingService("2025-01-15T20:30:00.000Z");

    expect(() =>
      pairing.approvePairing({
        satelliteId: reg.satelliteId,
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
        scopes: ["read"],
      }),
    ).toThrow("expired");
  });

  it("rejects already-approved request", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    expect(() =>
      pairing.approvePairing({
        satelliteId: reg.satelliteId,
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
        scopes: ["read"],
      }),
    ).toThrow("not pending");
  });

  it("rejects pairing with mismatched satellite ID", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    expect(() =>
      pairing.approvePairing({
        satelliteId: "wrong-satellite-id",
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
        scopes: ["read"],
      }),
    ).toThrow("does not belong");
  });

  it("rejectPairing marks request as rejected", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.rejectPairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      reason: "not authorized",
    });

    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = ?")
      .get(reg.pairingRequestId) as { status: string };
    expect(req.status).toBe("rejected");
  });

  it("rejectPairing rejects mismatched satellite ID", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    expect(() =>
      pairing.rejectPairing({
        satelliteId: "wrong-satellite-id",
        requestId: reg.pairingRequestId,
        resolverUserId: "test-user",
      }),
    ).toThrow("does not belong");
  });

  it("completeHandshake validates token, challenge, and returns stream info with algorithm", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    const handshake = pairing.completeHandshake(
      buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
    );

    expect(handshake.accepted).toBe(true);
    expect(handshake.streamId).toBeTruthy();
    expect(handshake.epoch).toBeGreaterThanOrEqual(1);
    expect(handshake.algorithm).toBe("xchacha20-poly1305");
    expect(handshake.serverEphemeralPublicKey).toBe("test-server-ephemeral-pub");
  });

  it("completeHandshake negotiates aes-256-gcm when xchacha20 not offered", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    const handshake = pairing.completeHandshake(
      buildHandshakeInput(
        reg.satelliteId,
        approveResult.token,
        reg.challengeNonce,
        TEST_KEY_PAIR.privateKey as string,
        ["aes-256-gcm"],
      ),
    );

    expect(handshake.algorithm).toBe("aes-256-gcm");
  });

  it("completeHandshake rejects invalid token", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, "invalid-token", reg.challengeNonce),
      ),
    ).toThrow("Invalid or revoked token");
  });

  it("revokeSatellite sets status to revoked and revokes tokens", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    pairing.revokeSatellite({ satelliteId: reg.satelliteId });

    const sat = db.writer
      .prepare("SELECT pairing_status, token_version FROM satellites WHERE id = ?")
      .get(reg.satelliteId) as { pairing_status: string; token_version: number };
    expect(sat.pairing_status).toBe("revoked");
    expect(sat.token_version).toBe(2); // incremented

    // Token should be revoked
    const tokens = db.writer
      .prepare("SELECT revoked_at FROM api_tokens WHERE principal_type = 'satellite'")
      .all() as Array<{ revoked_at: string | null }>;
    expect(tokens[0]!.revoked_at).toBeTruthy();
  });

  it("completeHandshake rejects revoked satellite", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    pairing.revokeSatellite({ satelliteId: reg.satelliteId });

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow(); // Token is revoked
  });

  // --- Issue 10: Handshake rejection tests ---

  it("completeHandshake rejects invalid challenge signature", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Sign with wrong key
    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(
          reg.satelliteId,
          approveResult.token,
          reg.challengeNonce,
          WRONG_KEY_PAIR.privateKey as string,
        ),
      ),
    ).toThrow("Challenge signature verification failed");
  });

  it("completeHandshake rejects wrong nonce", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Use a wrong nonce (different from what was issued)
    const wrongNonce = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, wrongNonce),
      ),
    ).toThrow("Challenge nonce does not match issued nonce");
  });

  it("completeHandshake rejects expired token", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    // Approve with a short TTL (1ms)
    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
      tokenTtlMs: 1,
    });

    // Attempt handshake well after token expiry
    const latePairing = createPairingService("2025-01-16T10:00:00.000Z");
    expect(() =>
      latePairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow("Invalid or revoked token");
  });

  it("completeHandshake rejects revoked satellite (explicit revoke check)", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Revoke satellite but keep tokens (revokeTokens: false)
    // Manually set the satellite status to revoked without revoking tokens
    db.writer
      .prepare("UPDATE satellites SET pairing_status = 'revoked', updated_at = ? WHERE id = ?")
      .run(LATER, reg.satelliteId);

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow("Satellite has been revoked");
  });

  it("completeHandshake rejects token version mismatch", () => {
    const reg = registerSatellite();
    const pairing = createPairingService();

    const approveResult = pairing.approvePairing({
      satelliteId: reg.satelliteId,
      requestId: reg.pairingRequestId,
      resolverUserId: "test-user",
      scopes: ["read"],
    });

    // Simulate a token version bump on the satellite (as if tokens were rotated)
    db.writer
      .prepare("UPDATE satellites SET token_version = 99, updated_at = ? WHERE id = ?")
      .run(LATER, reg.satelliteId);

    expect(() =>
      pairing.completeHandshake(
        buildHandshakeInput(reg.satelliteId, approveResult.token, reg.challengeNonce),
      ),
    ).toThrow("Token version mismatch");
  });
});
```

### `test/unit/satellites/services/friday-satellite-registration-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import type { FridaySatelliteRegistrationInput } from "../../../../src/satellites/model/friday-satellite.types.js";
import { createFridaySatelliteRepository } from "../../../../src/satellites/persistence/friday-satellite-repository.js";
import { createFridaySatellitePairingRequestRepository } from "../../../../src/satellites/persistence/friday-satellite-pairing-request-repository.js";
import { createFridaySatelliteCapabilityRepository } from "../../../../src/satellites/persistence/friday-satellite-capability-repository.js";
import { createFridaySatelliteRegistrationService } from "../../../../src/satellites/services/friday-satellite-registration-service.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";

describe("FridaySatelliteRegistrationService", () => {
  let db: FridaySqliteLayer;

  const NOW = "2025-01-15T10:00:00.000Z";

  const baseInput: FridaySatelliteRegistrationInput = {
    type: "phone",
    displayName: "My Phone",
    publicKey: "pk-abc123",
    runtime: {
      platform: "darwin",
      arch: "arm64",
      appVersion: "1.0.0",
      nodeVersion: "22.0.0",
    },
    transport: "ws",
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    return createFridaySatelliteRegistrationService({
      db,
      satelliteRepo: createFridaySatelliteRepository(),
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      capabilityRepo: createFridaySatelliteCapabilityRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
  }

  it("creates satellite with pending status and pairing request", () => {
    const service = createService();
    const result = service.register(baseInput);

    expect(result.pairingStatus).toBe("pending");
    expect(result.pairingRequired).toBe(true);
    expect(result.satelliteId).toBeTruthy();
    expect(result.pairingRequestId).toBeTruthy();
    expect(result.pairingCode).toMatch(/^\d{6}$/);
    expect(result.challengeNonce).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();

    // Verify DB row
    const satRow = db.writer
      .prepare("SELECT * FROM satellites WHERE id = ?")
      .get(result.satelliteId) as Record<string, unknown>;
    expect(satRow.pairing_status).toBe("pending");
    expect(satRow.trust_level).toBe("restricted");
    expect(satRow.type).toBe("phone");

    // Verify pairing request row
    const reqRow = db.writer
      .prepare("SELECT * FROM satellite_pairing_requests WHERE id = ?")
      .get(result.pairingRequestId) as Record<string, unknown>;
    expect(reqRow.status).toBe("pending");
    expect(reqRow.satellite_id).toBe(result.satelliteId);
  });

  it("stores initial capabilities when provided", () => {
    const service = createService();
    const result = service.register({
      ...baseInput,
      capabilityReport: {
        satelliteId: "ignored", // satelliteId is generated by service
        revision: 1,
        generatedAt: NOW,
        runtime: { os: "darwin", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
        capabilities: [
          { key: "camera", available: true, metadata: { resolution: "1080p" } },
          { key: "microphone", available: false },
        ],
      },
    });

    const caps = db.writer
      .prepare("SELECT * FROM satellite_capabilities WHERE satellite_id = ? ORDER BY key")
      .all(result.satelliteId) as Array<Record<string, unknown>>;
    expect(caps).toHaveLength(2);
    expect(caps[0]!.key).toBe("camera");
    expect(caps[0]!.available).toBe(1);
    expect(caps[1]!.key).toBe("microphone");
    expect(caps[1]!.available).toBe(0);
  });

  it("generates expiry from TTL", () => {
    const service = createFridaySatelliteRegistrationService({
      db,
      satelliteRepo: createFridaySatelliteRepository(),
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      capabilityRepo: createFridaySatelliteCapabilityRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      pairingTtlMs: 5 * 60 * 1000, // 5 minutes
    });

    const result = service.register(baseInput);
    const expiryMs = new Date(result.expiresAt).getTime() - new Date(NOW).getTime();
    expect(expiryMs).toBe(5 * 60 * 1000);
  });
});
```

### `test/unit/satellites/services/friday-satellite-sync-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayResumeCursorSigner } from "../../../../src/satellites/protocol/friday-resume-cursor-signer.js";
import { createFridayAckResumeValidator } from "../../../../src/satellites/protocol/friday-ack-resume-validator.js";
import { createFridayStreamCheckpointRepository } from "../../../../src/satellites/persistence/friday-stream-checkpoint-repository.js";
import { createFridayOutboxMessageRepository } from "../../../../src/satellites/persistence/friday-outbox-message-repository.js";
import { createFridaySatelliteSyncService } from "../../../../src/satellites/services/friday-satellite-sync-service.js";
import { createTestDb } from "../_helpers/create-test-db.js";

describe("FridaySatelliteSyncService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const SECRET = "test-sync-secret";

  const cursorSigner = createFridayResumeCursorSigner(SECRET);
  const ackValidator = createFridayAckResumeValidator(cursorSigner);
  const checkpointRepo = createFridayStreamCheckpointRepository();
  const outboxRepo = createFridayOutboxMessageRepository();

  function insertSatellite(id: string) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    insertSatellite("sat-1");
    // Set up epoch
    db.withWriteTransaction((d) => {
      checkpointRepo.bumpEpoch(d, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    return createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
    });
  }

  it("pull returns epoch and generates cursor", () => {
    const service = createService();
    const result = service.pull({
      satelliteId: "sat-1",
      streamId: "stream-1",
      lastAckedSeq: 0,
      subscriptions: ["events"],
    });

    expect(result.epoch).toBe(1);
    expect(result.streamId).toBe("stream-1");
    expect(result.nextCursor).toBeTruthy();
    expect(result.fullPullRequired).toBeUndefined();
  });

  it("pull with valid resume cursor succeeds", () => {
    const service = createService();
    const cursor = cursorSigner.sign({
      seq: 5,
      streamId: "stream-1",
      epoch: 1,
      issuedAt: NOW,
    });

    const result = service.pull({
      satelliteId: "sat-1",
      streamId: "stream-1",
      lastAckedSeq: 5,
      subscriptions: ["events"],
      resumeCursor: cursor,
    });

    expect(result.fullPullRequired).toBeUndefined();
  });

  it("pull with stale epoch cursor returns fullPullRequired", () => {
    const service = createService();
    const cursor = cursorSigner.sign({
      seq: 5,
      streamId: "stream-1",
      epoch: 999, // wrong epoch
      issuedAt: NOW,
    });

    const result = service.pull({
      satelliteId: "sat-1",
      streamId: "stream-1",
      lastAckedSeq: 5,
      subscriptions: ["events"],
      resumeCursor: cursor,
    });

    expect(result.fullPullRequired).toBe(true);
  });

  it("push accepts acks with correct epoch and advances checkpoint", () => {
    const service = createService();
    const result = service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1 }],
    });

    expect(result.acceptedAcks).toHaveLength(1);
    expect(result.acceptedAcks[0]).toEqual({ streamId: "stream-1", seq: 10 });
    expect(result.conflicts).toHaveLength(0);

    // Verify checkpoint persisted
    const lastSeq = db.withReadConnection((d) =>
      checkpointRepo.getLastAckedSeq(d, "sat-1", "stream-1"),
    );
    expect(lastSeq).toBe(10);
  });

  it("push rejects acks with stale epoch", () => {
    const service = createService();
    const result = service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 999 }],
    });

    expect(result.acceptedAcks).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("STREAM_EPOCH_STALE");
  });

  it("push enforces monotonic checkpoint (idempotent on duplicate)", () => {
    const service = createService();

    // First push
    service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1 }],
    });

    // Second push with lower seq — still accepted (idempotent)
    const result = service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 5, epoch: 1 }],
    });

    expect(result.acceptedAcks).toHaveLength(1);

    // Checkpoint should not regress
    const lastSeq = db.withReadConnection((d) =>
      checkpointRepo.getLastAckedSeq(d, "sat-1", "stream-1"),
    );
    expect(lastSeq).toBe(10);
  });

  it("push rejects ack with tampered cursor", () => {
    const service = createService();
    const result = service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1, cursor: "tampered.cursor" }],
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("AUTH_UNAUTHORIZED");
  });
});
```

