> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

I’m producing a single-pass implementation plan for Phase 2, and I’ll start by loading your workspace context files (`SOUL.md`, `USER.md`, recent memory, and `MEMORY.md`) before reading the two Friday architecture docs and Phase 0/1 code touchpoints.

---

I’ve confirmed the workspace and docs paths. Next I’m reading `BOOTSTRAP.md`, identity/context files, and checking whether today/yesterday memory notes exist so I can follow your session rules before designing Phase 2.

---

Workspace bootstrap/context files are loaded. I’m now extracting the exact architecture and skill-system sections plus current `src/` layout so the Phase 2 file plan matches existing Phase 0/1 boundaries.

---

I’ve pulled the architecture protocol and DDL sections. Next I’m extracting the precise `SkillRunState` and learning-event contract details so the durable run/ledger plan aligns with Phase 1 runtime types.

---

# Phase 2 Plan: Satellite Runtime Formalization + Durable Run/Event Ledger

## Scope guardrails
- Add only new files under `src/` and new tests under `test/unit/`.
- Do not modify existing Phase 0/1 files in `src/config/`, `src/state/`, `src/skills/`, `src/hub/services/`.
- Use existing V001 schema only. No migrations.
- Use existing `FridaySqliteLayer` transaction/read APIs and `better-sqlite3`.
- Keep all new types/services Friday-namespaced.

## 1. Project structure (new files only)

```text
src/
  satellites/
    model/
      friday-satellite.types.ts
      friday-satellite-protocol.types.ts
      friday-satellite-health.types.ts
      friday-outbox.types.ts
    persistence/
      friday-satellite-repository.ts
      friday-satellite-pairing-request-repository.ts
      friday-satellite-capability-repository.ts
      friday-satellite-heartbeat-repository.ts
      friday-outbox-message-repository.ts
      friday-stream-checkpoint-repository.ts
      friday-api-token-repository.ts
    protocol/
      friday-resume-cursor-signer.ts
      friday-ack-resume-validator.ts
    services/
      friday-satellite-registration-service.ts
      friday-satellite-pairing-service.ts
      friday-satellite-capability-service.ts
      friday-satellite-heartbeat-service.ts
      friday-satellite-offline-sweeper.ts
      friday-outbox-queue-service.ts
      friday-satellite-sync-service.ts
    runtime/
      friday-satellite-runtime.types.ts
      friday-satellite-runtime.ts
    index.ts
  ledger/
    learning/
      friday-learning-event-ledger.types.ts
      friday-learning-event-ledger.ts
    runs/
      friday-skill-run-store.types.ts
      friday-skill-run-store.ts
      friday-skill-run-checkpoint-writer.ts
    index.ts
  jobs/
    retention/
      friday-retention.types.ts
      friday-retention-job.ts
    index.ts
```

---

## 2. Satellite model (registration/pairing/heartbeat/capability)

### Core interfaces (`src/satellites/model/friday-satellite.types.ts`)
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

export interface FridaySatelliteRegistrationInput {
  type: FridaySatelliteType;
  displayName: string;
  publicKey: string;
  runtime: { platform: string; arch: string; appVersion: string; nodeVersion: string };
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
  capabilities: Array<{
    key: string;
    available: boolean;
    metadata?: Record<string, unknown>;
    limits?: { maxConcurrency?: number; timeoutMs?: number; maxPayloadBytes?: number };
  }>;
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
```

### Persistence mapping
- `satellites`: registration identity, trust, pairing status, runtime, last seen.
- `satellite_pairing_requests`: pending/approved/rejected/expired pairing request lifecycle.
- `satellite_capabilities`: upsert by `(satellite_id, key)`.
- `satellite_heartbeats`: append heartbeat samples.
- `api_tokens`: scoped device token hash records.
- `hub_settings`: protocol epoch + per-stream last ack checkpoints.

---

## 3. Satellite handshake protocol (pairing flow + token issuance)

### Service contracts

```ts
export interface FridaySatelliteRegistrationService {
  register(input: FridaySatelliteRegistrationInput): Promise<{
    satelliteId: string;
    pairingStatus: "pending";
    pairingRequired: true;
    pairingRequestId: string;
    pairingCode: string;
    expiresAt: string;
    challengeNonce: string;
  }>;
}

export interface FridaySatellitePairingService {
  approvePairing(input: {
    satelliteId: string;
    requestId: string;
    resolverUserId: string;
    scopes: string[];
    tokenTtlMs?: number;
  }): Promise<{
    token: string;
    tokenId: string;
    expiresAt?: string;
    configRevision: number;
    tokenVersion: number;
  }>;
  rejectPairing(input: {
    satelliteId: string;
    requestId: string;
    resolverUserId: string;
    reason?: string;
  }): Promise<void>;
  completeHandshake(input: {
    satelliteId: string;
    token: string;
    signedChallenge: string;
    challengeNonce: string;
    clientEphemeralPublicKey: string;
    supportedAlgorithms: Array<"xchacha20-poly1305" | "aes-256-gcm">;
  }): Promise<{
    accepted: true;
    streamId: string;
    epoch: number;
    algorithm: "xchacha20-poly1305" | "aes-256-gcm";
    serverEphemeralPublicKey: string;
  }>;
  revokeSatellite(input: { satelliteId: string; revokeTokens?: boolean; reason?: string }): Promise<void>;
}
```

### Handshake flow
1. `register`:
   - Insert `satellites` row with `pairing_status='pending'`.
   - Insert `satellite_pairing_requests` row with short code + nonce + expiry.
2. `approvePairing`:
   - Validate request is `pending` and unexpired.
   - Update request `approved`.
   - Update satellite `pairing_status='paired'`.
   - Issue token: generate plaintext token, store hash in `api_tokens`, include scopes.
3. `completeHandshake`:
   - Validate token hash, pairing status not revoked, token version current.
   - Verify signed challenge against satellite `public_key`.
   - Negotiate strongest supported algorithm.
   - Return `streamId`, current `epoch`, and server ephemeral key params.
4. `revokeSatellite`:
   - Set `pairing_status='revoked'`.
   - Revoke existing tokens (set `revoked_at`) and increment `token_version`.

---

## 4. Heartbeat and health monitoring (status transitions per §4.5)

### Health machine (`src/satellites/model/friday-satellite-health.types.ts`)
```ts
export interface FridaySatelliteHealthTransitionInput {
  nowIso: string;
  lastHeartbeatTs?: string;
  failureRate1m?: number;
  explicitDisconnect?: boolean;
  currentStatus: FridaySatellitePairingStatus;
}

export function computeFridaySatelliteStatus(
  input: FridaySatelliteHealthTransitionInput,
): FridaySatellitePairingStatus;
```

### Transition rules
- `online`: heartbeat age `< 30s` and failure rate below threshold.
- `degraded`: heartbeat age `30s-90s` or failure rate above threshold.
- `offline`: heartbeat age `> 90s` or explicit disconnect.
- `revoked`: terminal; never auto-promoted by heartbeat.
- `pending/paired` + valid heartbeat becomes `online` or `degraded`.

### Runtime services
```ts
export interface FridaySatelliteHeartbeatService {
  recordHeartbeat(input: FridaySatelliteHeartbeatInput): Promise<{
    accepted: true;
    now: string;
    expectedIntervalMs: number;
    status: FridaySatellitePairingStatus;
  }>;
}

export interface FridaySatelliteOfflineSweeper {
  sweep(nowIso?: string): Promise<{
    markedDegraded: number;
    markedOffline: number;
  }>;
}
```

---

## 5. Outbox/message queue (state machine per §4.6)

### Queue model (`src/satellites/model/friday-outbox.types.ts`)
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
```

### Queue service contract
```ts
export interface FridayOutboxQueueService {
  enqueue(input: FridayOutboxEnqueueInput): Promise<{ id: string }>;
  leaseBatch(input: {
    satelliteId: string;
    limit: number;
    leaseMs: number;
    nowIso?: string;
  }): Promise<Array<{ id: string; seq: number; payloadCiphertext: string; messageType: string }>>;
  ackUpToSeq(input: {
    satelliteId: string;
    streamId: string;
    seq: number;
    ackedAt?: string;
  }): Promise<{ acked: number }>;
  failLeasedMessage(input: {
    messageId: string;
    satelliteId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    nowIso?: string;
  }): Promise<{ status: FridayOutboxStatus; nextDeliverAfter?: string }>;
  requeueExpiredLeases(nowIso?: string): Promise<number>;
  expireByTtl(nowIso?: string): Promise<number>;
}
```

### Canonical transitions implemented
- `queued -> leased -> acked`
- `leased -> failed -> queued` (retry path)
- `failed -> dead_letter` (max attempts / non-retryable)
- `queued|failed|leased -> expired` (TTL)

---

## 6. Event ledger (append-only learning events per skill doc §3.2)

### Ledger types (`src/ledger/learning/friday-learning-event-ledger.types.ts`)
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

### Ledger service (`src/ledger/learning/friday-learning-event-ledger.ts`)
```ts
export interface FridayLearningEventLedger {
  appendEvent(input: FridayLearningEventAppendInput): Promise<{ inserted: boolean }>;
  appendBatch(input: FridayLearningEventAppendInput[]): Promise<Array<{ eventId: string; inserted: boolean }>>;
  listByUser(input: {
    userId: string;
    kinds?: FridayLearningEventKind[];
    fromTs?: string;
    toTs?: string;
    limit?: number;
  }): Promise<FridayLearningEventAppendInput[]>;
  pruneBefore(cutoffIso: string): Promise<number>;
}
```

### Behavior
- Uses `INSERT OR IGNORE` on `learning_events.event_id` for idempotency.
- Never updates existing rows (append-only).
- Keeps `run_id` optional; if unavailable in Phase 2, store `runId` in payload and leave `run_id` null.

---

## 7. Skill run state persistence (durable `SkillRunState` per §2.6)

### Storage decision
- Persist skill run snapshots in `memory_items` with `namespace='skill_runs'`, `key=runId`.
- `value_json` stores full `SkillRunState<TState>` plus session/user/channel metadata.
- No migration needed; avoids `workflow_runs` FK coupling before Phase 3 workflow execution is fully in place.

### Types (`src/ledger/runs/friday-skill-run-store.types.ts`)
```ts
import type { SkillRunState } from "../../skills/model/friday-skill-runtime.types.js";

export interface FridaySkillRunSnapshot<TState = unknown> extends SkillRunState<TState> {
  sessionId: string;
  userId: string;
  channel: string;
  lastTransitionAt: string;
  metadata?: Record<string, unknown>;
}
```

### Store/service contracts
```ts
export interface FridaySkillRunStore {
  upsertRun<TState>(snapshot: FridaySkillRunSnapshot<TState>): Promise<void>;
  getRun<TState = unknown>(runId: string): Promise<FridaySkillRunSnapshot<TState> | null>;
  listRuns(input?: {
    skillId?: string;
    status?: FridaySkillRunSnapshot["status"];
    userId?: string;
    limit?: number;
  }): Promise<Array<FridaySkillRunSnapshot>>;
  pruneTerminalRunsBefore(cutoffIso: string): Promise<number>;
}
```

### Transactional checkpoint writer (`src/ledger/runs/friday-skill-run-checkpoint-writer.ts`)
```ts
export interface FridaySkillRunCheckpointWriter {
  persistCheckpoint<TState>(input: {
    run: FridaySkillRunSnapshot<TState>;
    learningEvent?: FridayLearningEventAppendInput;
  }): Promise<{ runPersisted: true; eventInserted?: boolean }>;
}
```

- `persistCheckpoint` runs one SQLite write transaction:
  1. Upsert run snapshot in `memory_items`.
  2. Append learning event (optional) in `learning_events`.
- Rollback behavior: if any non-idempotent write fails, both writes roll back.

---

## 8. ACK/resume protocol (resume frames + epoch validation per §4.1)

### Protocol contracts (`src/satellites/model/friday-satellite-protocol.types.ts`)
```ts
export interface FridayWsResumeFrame {
  type: "resume";
  lastAckedSeq: number;
  streamId: string;
  epoch: number;
  cursor: string;
  subscriptions: string[];
  emittedAt: string;
}

export interface FridayWsAckFrame {
  type: "ack";
  seq: number;
  streamId: string;
  epoch: number;
  emittedAt: string;
}
```

### Cursor signer (`src/satellites/protocol/friday-resume-cursor-signer.ts`)
```ts
export interface FridayResumeCursorSigner {
  sign(input: { seq: number; streamId: string; epoch: number; issuedAt: string }): string;
  verify(cursor: string): { seq: number; streamId: string; epoch: number; issuedAt: string };
}
```

### Validator + checkpoint repo
```ts
export interface FridayAckResumeValidator {
  validateResume(input: FridayWsResumeFrame, currentEpoch: number): {
    ok: true;
    effectiveSeq: number;
  } | {
    ok: false;
    code: "AUTH_UNAUTHORIZED" | "STREAM_EPOCH_STALE" | "STREAM_CURSOR_OUT_OF_RANGE";
    message: string;
  };
}

export interface FridayStreamCheckpointRepository {
  getEpoch(): number;
  bumpEpoch(nowIso: string): number;
  getLastAckedSeq(satelliteId: string, streamId: string): number;
  setLastAckedSeq(input: { satelliteId: string; streamId: string; seq: number; nowIso: string }): void;
}
```

### Sync service (`src/satellites/services/friday-satellite-sync-service.ts`)
```ts
export interface FridaySatelliteSyncService {
  pull(input: {
    satelliteId: string;
    streamId: string;
    lastAckedSeq: number;
    subscriptions: string[];
    resumeCursor?: string;
  }): Promise<{
    epoch: number;
    streamId: string;
    events: Array<{ seq: number; event: string; payload: unknown; emittedAt: string }>;
    queueItems: Array<{ id: string; seq: number; messageType: string; payloadCiphertext: string }>;
    nextCursor?: string;
    fullPullRequired?: boolean;
  }>;

  push(input: {
    satelliteId: string;
    acks: Array<{ streamId: string; seq: number; epoch: number; cursor?: string }>;
    localEvents?: FridayLearningEventAppendInput[];
  }): Promise<{
    acceptedAcks: Array<{ streamId: string; seq: number }>;
    conflicts: Array<{ streamId: string; seq: number; code: string; message: string }>;
  }>;
}
```

### Protocol rules implemented
- Epoch stored in `hub_settings` and bumped on runtime boot.
- Cursor is HMAC-signed `(seq, streamId, epoch, issuedAt)`.
- Tampered cursor -> `AUTH_UNAUTHORIZED`.
- Epoch mismatch -> `STREAM_EPOCH_STALE` and client must full re-subscribe.
- Ack checkpoint is monotonic per `(satelliteId, streamId)`.

---

## 9. Retention jobs (events, heartbeats, queue items, run snapshots)

### Retention config (`src/jobs/retention/friday-retention.types.ts`)
```ts
export interface FridayRetentionPolicy {
  learningEventsDays: number;          // default 90
  heartbeatsDays: number;              // default 7
  pairingRequestsDays: number;         // default 7
  outboxTerminalDays: number;          // default 14
  skillRunTerminalDays: number;        // default 30
}
```

### Job contract (`src/jobs/retention/friday-retention-job.ts`)
```ts
export interface FridayRetentionJob {
  run(nowIso?: string): Promise<{
    markedPairingExpired: number;
    deletedPairingRequests: number;
    deletedHeartbeats: number;
    markedOutboxExpired: number;
    deletedOutboxTerminal: number;
    deletedLearningEvents: number;
    deletedSkillRuns: number;
  }>;
}
```

### Cleanup operations
1. Mark stale pending pairing requests as `expired`.
2. Delete old resolved pairing requests.
3. Delete old heartbeat rows.
4. Mark TTL-breached outbox rows as `expired`.
5. Delete old terminal outbox rows (`acked`, `dead_letter`, `expired`).
6. Delete learning events older than policy cutoff.
7. Delete terminal skill run snapshots older than policy cutoff.

---

## 10. Unit test plan

### New test files

```text
test/unit/satellites/protocol/friday-resume-cursor-signer.test.ts
test/unit/satellites/protocol/friday-ack-resume-validator.test.ts
test/unit/satellites/services/friday-satellite-registration-service.test.ts
test/unit/satellites/services/friday-satellite-pairing-service.test.ts
test/unit/satellites/services/friday-satellite-capability-service.test.ts
test/unit/satellites/services/friday-satellite-heartbeat-service.test.ts
test/unit/satellites/services/friday-satellite-offline-sweeper.test.ts
test/unit/satellites/services/friday-outbox-queue-service.test.ts
test/unit/satellites/services/friday-satellite-sync-service.test.ts
test/unit/ledger/learning/friday-learning-event-ledger.test.ts
test/unit/ledger/runs/friday-skill-run-store.test.ts
test/unit/ledger/runs/friday-skill-run-checkpoint-writer.test.ts
test/unit/jobs/retention/friday-retention-job.test.ts
```

### Required cases

1. Registration creates `satellites(pending)` + `satellite_pairing_requests(pending)` with expiry/code/nonce.
2. Pairing approval issues token, stores hash in `api_tokens`, updates statuses, rejects expired request.
3. Handshake rejects invalid token/challenge and revoked satellite.
4. Capability report enforces monotonic revision and upserts by `(satellite_id, key)`.
5. Heartbeat transitions follow `<30s online`, `30-90s degraded`, `>90s offline`.
6. Offline sweeper marks stale satellites correctly and leaves `revoked` untouched.
7. Queue transitions implement canonical state machine and idempotent ack handling.
8. Resume cursor signing verifies tamper detection and stream/epoch matching.
9. Sync pull/push applies ack checkpoints monotonically and returns `STREAM_EPOCH_STALE` on stale epoch.
10. Learning ledger is append-only and idempotent on duplicate `eventId`.
11. Skill run store roundtrips `SkillRunState` JSON and filters by status/skill/user.
12. Checkpoint writer commits run+event atomically and rolls back on failure.
13. Retention job returns deterministic deletion/marking counts and preserves non-expired rows.

---

## Dependencies and wiring

### Existing dependencies reused
- `src/state/sqlite/friday-sqlite.types.ts` (`FridaySqliteLayer`) for all reads/writes/transactions.
- `src/skills/model/friday-skill-runtime.types.ts` (`SkillRunState`) for run snapshot schema.
- `src/hub/services/friday-hub-gateway-ingress.types.ts` for WS frame publishing integration.
- `src/hub/services/friday-hub-memory-state.types.ts` optionally for audit append hooks.

### Runtime dependencies
- `better-sqlite3` (already installed).
- `node:crypto` for token hash, HMAC cursor signing, challenge verification.
- No new npm packages.

### Composition entrypoint
- `createFridaySatelliteRuntime(options)` in `src/satellites/runtime/friday-satellite-runtime.ts` wires repositories + services + ledger + retention into one Phase 2 runtime surface for CC to plug into hub transport endpoints.