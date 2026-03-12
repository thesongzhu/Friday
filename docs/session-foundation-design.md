**Session Foundation Design (v005)**

**Scope lock**
1. Per-channel session isolation.
2. Cross-channel memory sharing by user namespace.
3. SQLite-first session store with lifecycle and message history.
4. Friday naming/style constraints (`Friday*`, `FRIDAY_*`, `createFriday*`, `SESSION_*`).

### 1) Constants File Spec

`src/sessions/friday-session.constants.ts`

```ts
export const FRIDAY_SESSION_DEFAULT_ACCOUNT_ID = "default";
export const FRIDAY_SESSION_SUBAGENT_PREFIX = "subagent";

export const FRIDAY_SESSION_STATUS_ACTIVE = "active";
export const FRIDAY_SESSION_STATUS_IDLE = "idle";
export const FRIDAY_SESSION_STATUS_ARCHIVED = "archived";
export const FRIDAY_SESSION_STATUS_PRUNED = "pruned";

export const FRIDAY_SESSION_DEFAULT_MESSAGE_LIMIT = 50;
export const FRIDAY_SESSION_MAX_MESSAGE_LIMIT = 500;

export const FRIDAY_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30m
export const FRIDAY_SESSION_ARCHIVE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const FRIDAY_SESSION_PRUNE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const FRIDAY_SESSION_HARD_DELETE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d after pruned

export const FRIDAY_SESSION_KEY_SEGMENT_MAX_LENGTH = 128;
export const FRIDAY_SESSION_KEY_SEGMENT_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const FRIDAY_SESSION_MEMORY_NAMESPACE_PREFIX = "tenant.default.user";
export const FRIDAY_SESSION_MEMORY_NAMESPACE_SHARED_SEGMENT = "shared";
export const FRIDAY_SESSION_MEMORY_SOURCE_PREFIX = "session";

export const FRIDAY_SESSION_ERROR_CODES = {
  INVALID_KEY: "SESSION_INVALID_KEY",
  INVALID_INPUT: "SESSION_INVALID_INPUT",
  NOT_FOUND: "SESSION_NOT_FOUND",
  INVALID_STATUS_TRANSITION: "SESSION_INVALID_STATUS_TRANSITION",
  MESSAGE_VALIDATION_ERROR: "SESSION_MESSAGE_VALIDATION_ERROR",
  MESSAGE_IDEMPOTENCY_CONFLICT: "SESSION_MESSAGE_IDEMPOTENCY_CONFLICT",
  MEMORY_NAMESPACE_UNRESOLVABLE: "SESSION_MEMORY_NAMESPACE_UNRESOLVABLE",
  PRUNE_VALIDATION_ERROR: "SESSION_PRUNE_VALIDATION_ERROR",
} as const;
```

---

### 2) Types File Spec (all interfaces)

`src/sessions/model/friday-session.types.ts`

```ts
export type FridaySessionStatus = "active" | "idle" | "archived" | "pruned";
export type FridaySessionRole = "system" | "user" | "assistant" | "tool";
export type FridaySessionChatKind = "dm" | "group" | "channel" | "thread";

export interface FridaySessionKeyParts {
  kind: "conversation" | "subagent";
  channel?: string;
  accountId?: string;
  chatId?: string;
  parentKey?: string;
  taskId?: string;
  canonicalKey: string;
}

export interface FridaySessionRecord {
  id: string;
  key: string;
  channel: string;
  accountId: string;
  chatId: string;
  userId?: string;
  chatKind: FridaySessionChatKind;
  status: FridaySessionStatus;
  memoryNamespace?: string;
  parentSessionKey?: string;
  rootSessionKey?: string;
  forkedFromMessageId?: string;
  metadata: Record<string, unknown>;
  contextInputTokens: number;
  contextOutputTokens: number;
  contextTotalTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  statusChangedAt?: string;
  idleAt?: string;
  archivedAt?: string;
  prunedAt?: string;
}

export interface FridaySessionMessageRecord {
  id: string;
  sessionId: string;
  sessionKey: string;
  sequence: number;
  role: FridaySessionRole;
  content: unknown;
  contentText: string;
  toolCalls?: unknown[];
  tokenCount: number;
  idempotencyKey?: string;
  parentMessageId?: string;
  metadata: Record<string, unknown>;
  memoryExtractStatus: "pending" | "extracted" | "skipped" | "failed";
  memoryExtractedAt?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridaySessionMessageInput {
  role: FridaySessionRole;
  content: unknown;
  contentText?: string;
  toolCalls?: unknown[];
  tokenCount?: number;
  idempotencyKey?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface FridaySessionCreateInput {
  channel: string;
  chatId: string;
  userId?: string;
  accountId?: string;
  chatKind?: FridaySessionChatKind;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionListInput {
  channel?: string;
  accountId?: string;
  userId?: string;
  status?: FridaySessionStatus;
  limit?: number;
  cursor?: string;
}

export interface FridaySessionPruneResult {
  archivedToPrunedCount: number;
  hardDeletedCount: number;
  sessionKeys: string[];
}
```

`src/sessions/services/friday-session-service.types.ts`

```ts
import type { FridaySqliteLayer } from "#state";
import type {
  FridaySessionCreateInput,
  FridaySessionMessageInput,
  FridaySessionMessageRecord,
  FridaySessionPruneResult,
  FridaySessionRecord,
} from "../model/friday-session.types.js";

export interface FridaySessionService {
  createSession(channel: string, chatId: string, userId?: string): Promise<FridaySessionRecord>;
  getSession(key: string): Promise<FridaySessionRecord | null>;
  getOrCreateSession(key: string): Promise<FridaySessionRecord>;
  addMessage(key: string, message: FridaySessionMessageInput): Promise<FridaySessionMessageRecord>;
  getMessages(key: string, limit?: number, before?: string): Promise<FridaySessionMessageRecord[]>;
  archiveSession(key: string): Promise<FridaySessionRecord>;
  pruneOldSessions(olderThan: string): Promise<FridaySessionPruneResult>;
  getSessionMemoryNamespace(key: string): Promise<string>;
}

export interface CreateFridaySessionServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}
```

---

### 3) Migration DDL (v005)

`src/state/sqlite/migrations/v005-session-foundation.ts`

```ts
export const V005_SESSION_FOUNDATION_SQL = `
-- V005: Session foundation (canonical keys, lifecycle, memory bridge metadata)

ALTER TABLE sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN user_id TEXT;
ALTER TABLE sessions ADD COLUMN memory_namespace TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_key TEXT;
ALTER TABLE sessions ADD COLUMN root_session_key TEXT;
ALTER TABLE sessions ADD COLUMN forked_from_message_id TEXT;
ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;
ALTER TABLE sessions ADD COLUMN idle_at TEXT;
ALTER TABLE sessions ADD COLUMN archived_at TEXT;
ALTER TABLE sessions ADD COLUMN pruned_at TEXT;
ALTER TABLE sessions ADD COLUMN status_changed_at TEXT;
ALTER TABLE sessions ADD COLUMN context_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;

UPDATE sessions
SET account_id = COALESCE(NULLIF(account_id, ''), 'default'),
    chat_id = CASE
      WHEN chat_id IS NULL OR chat_id = '' OR chat_id = 'unknown'
        THEN COALESCE(json_extract(metadata_json, '$.chatId'), session_key, 'unknown')
      ELSE chat_id
    END,
    root_session_key = COALESCE(root_session_key, session_key),
    last_activity_at = COALESCE(last_activity_at, updated_at, created_at),
    status_changed_at = COALESCE(status_changed_at, updated_at, created_at);

ALTER TABLE session_messages ADD COLUMN session_key TEXT;
ALTER TABLE session_messages ADD COLUMN content_text TEXT;
ALTER TABLE session_messages ADD COLUMN tool_calls_json TEXT;
ALTER TABLE session_messages ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_messages ADD COLUMN occurred_at TEXT;
ALTER TABLE session_messages ADD COLUMN parent_message_id TEXT;
ALTER TABLE session_messages ADD COLUMN memory_extract_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (memory_extract_status IN ('pending', 'extracted', 'skipped', 'failed'));
ALTER TABLE session_messages ADD COLUMN memory_extracted_at TEXT;

UPDATE session_messages
SET session_key = COALESCE(
      session_key,
      (SELECT s.session_key FROM sessions s WHERE s.id = session_messages.session_id)
    ),
    content_text = COALESCE(content_text, content_json),
    occurred_at = COALESCE(occurred_at, created_at),
    token_count = COALESCE(
      CASE WHEN token_count > 0 THEN token_count ELSE NULL END,
      CAST(json_extract(token_usage_json, '$.total') AS INTEGER),
      CAST(json_extract(token_usage_json, '$.totalTokens') AS INTEGER),
      0
    );

CREATE INDEX IF NOT EXISTS idx_sessions_channel_account_chat
  ON sessions(channel, account_id, chat_kind, chat_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_status_activity
  ON sessions(user_id, status, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_status_changed
  ON sessions(status, status_changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_archived_pruned
  ON sessions(archived_at, pruned_at);

CREATE INDEX IF NOT EXISTS idx_sessions_memory_namespace
  ON sessions(memory_namespace);

CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_key
  ON sessions(parent_session_key);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_key_occurred
  ON session_messages(session_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_key_sequence
  ON session_messages(session_key, sequence DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_key_idempotency
  ON session_messages(session_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_messages_extract_status
  ON session_messages(memory_extract_status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_messages_parent_message
  ON session_messages(parent_message_id);

CREATE TRIGGER IF NOT EXISTS trg_sessions_delete_messages
BEFORE DELETE ON sessions
BEGIN
  DELETE FROM session_messages WHERE session_id = OLD.id;
END;
`;
```

Design note: v005 extends (does not replace) v001 `sessions`/`session_messages`, preserving lease fields for distributed compatibility.

---

### 4) Repository Interfaces

`src/sessions/persistence/friday-session-repository.ts`

```ts
export interface FridaySessionRepository {
  insert(db: Database.Database, input: FridaySessionCreateInput & { key: string; nowIso: string; memoryNamespace?: string }): FridaySessionRecord;
  getByKey(db: Database.Database, key: string): FridaySessionRecord | null;
  list(db: Database.Database, input: FridaySessionListInput): FridaySessionRecord[];
  updateStatus(db: Database.Database, input: { key: string; from?: FridaySessionStatus[]; to: FridaySessionStatus; nowIso: string }): FridaySessionRecord | null;
  touchActivity(db: Database.Database, input: { key: string; nowIso: string; tokenDelta?: number; messageDelta?: number }): FridaySessionRecord | null;
  markIdleCandidates(db: Database.Database, input: { idleBeforeIso: string; nowIso: string }): number;
  markArchivedCandidates(db: Database.Database, input: { archiveBeforeIso: string; nowIso: string }): number;
  markPrunedCandidates(db: Database.Database, input: { olderThanIso: string; nowIso: string }): string[];
  hardDeletePruned(db: Database.Database, input: { hardDeleteBeforeIso: string }): number;
}
```

`src/sessions/persistence/friday-session-message-repository.ts`

```ts
export interface FridaySessionMessageRepository {
  append(db: Database.Database, input: {
    sessionId: string;
    sessionKey: string;
    role: FridaySessionRole;
    contentJson: string;
    contentText: string;
    toolCallsJson?: string;
    tokenCount: number;
    idempotencyKey?: string;
    parentMessageId?: string;
    metadataJson: string;
    occurredAt: string;
    nowIso: string;
    idGenerator: () => string;
  }): FridaySessionMessageRecord;

  findByIdempotency(db: Database.Database, input: { sessionKey: string; idempotencyKey: string }): FridaySessionMessageRecord | null;

  listBySessionKey(db: Database.Database, input: {
    sessionKey: string;
    limit: number;
    before?: string;
  }): FridaySessionMessageRecord[];
}
```

---

### 5) Service Interface + Implementation Plan

**Key normalization behavior**
1. Canonical main key: `<channel>:<accountId>:<chatId>`.
2. Direct chat collapse: when `chatKind === "dm"` and `userId` exists, `chatId` becomes normalized `userId`.
3. Group/channel/thread isolation: `chatId` stays normalized source `chatId`.
4. Subagent key: `subagent:<parentKey>:<taskId>`, with recursive normalization of `<parentKey>`.
5. Legacy alias handling supported in normalizer only (no `global` / `unknown` fallback).

**Lifecycle behavior**
1. `createSession` inserts as `active`.
2. `addMessage` forces `active`, updates `last_activity_at`, token counters, and `message_count`.
3. Sweeper transitions:
`active -> idle` after `FRIDAY_SESSION_IDLE_TIMEOUT_MS`.
`idle -> archived` after `FRIDAY_SESSION_ARCHIVE_TIMEOUT_MS`.
`archived -> pruned` in `pruneOldSessions(olderThan)`.
4. Hard delete of pruned rows after `FRIDAY_SESSION_HARD_DELETE_TIMEOUT_MS`.

**Memory namespace bridge**
1. `getSessionMemoryNamespace(key)` returns deterministic user namespace:
`tenant.default.user.<normalized-user-segment>.shared`.
2. Same `userId` across channels resolves to same namespace prefix.
3. Session-scoped writes are tagged:
`source = session:<sessionKey>`.
`metadata.sessionKey/channel/accountId/chatId`.
4. Memory queries:
session-only filter uses `source = session:<sessionKey>`.
cross-session uses same namespace without source filter.

---

### 6) API Routes (CRUD + message history)

`src/api/http/routes/friday-session-routes.ts`

1. `GET /v1/sessions` → `sessions.list` (`session.read`)
2. `POST /v1/sessions` → `sessions.create` (`session.write`)
3. `GET /v1/sessions/:sessionKey` → `sessions.get` (`session.read`)
4. `POST /v1/sessions/:sessionKey/archive` → `sessions.archive` (`session.write`)
5. `POST /v1/sessions/prune` → `sessions.prune` (`session.write`)
6. `GET /v1/sessions/:sessionKey/messages` → `sessions.messages.list` (`session.read`)
7. `POST /v1/sessions/:sessionKey/messages` → `sessions.messages.create` (`session.write`)
8. `GET /v1/sessions/:sessionKey/memory-namespace` → `sessions.memory.namespace.get` (`session.read`)

All route validation must be typed assert functions and throw `FridayDomainError` with `SESSION_*` codes.

---

### 7) File Plan

**New files**
1. `src/sessions/friday-session.constants.ts`
2. `src/sessions/model/friday-session.types.ts`
3. `src/sessions/persistence/friday-session-repository.ts`
4. `src/sessions/persistence/friday-session-message-repository.ts`
5. `src/sessions/services/friday-session-key.ts`
6. `src/sessions/services/friday-session-memory-namespace.ts`
7. `src/sessions/services/friday-session-service.types.ts`
8. `src/sessions/services/friday-session-service.ts`
9. `src/sessions/index.ts`
10. `src/state/sqlite/migrations/v005-session-foundation.ts`
11. `src/api/model/friday-api-session.types.ts`
12. `src/api/http/routes/friday-session-routes.ts`

**Modified files**
1. `src/state/sqlite/migrations/index.ts`
2. `src/state/index.ts`
3. `src/api/index.ts`
4. `src/api/runtime/friday-api-runtime.types.ts`
5. `src/api/runtime/friday-api-runtime.ts`
6. `package.json` (add `#sessions` import alias)

---

### 8) Test Plan (all test files)

1. `test/unit/state/sqlite/friday-v005-session-foundation-schema.test.ts`
2. `test/unit/sessions/services/friday-session-key.test.ts`
3. `test/unit/sessions/persistence/friday-session-repository.test.ts`
4. `test/unit/sessions/persistence/friday-session-message-repository.test.ts`
5. `test/unit/sessions/services/friday-session-memory-namespace.test.ts`
6. `test/unit/sessions/services/friday-session-service.test.ts`
7. `test/unit/api/http/routes/friday-session-routes.test.ts`
8. `test/unit/api/runtime/friday-api-runtime-session-registration.test.ts`

Critical assertions:
- DM collapse vs group isolation.
- Subagent key normalization.
- Status transitions and timestamp mutation.
- Idempotency behavior for message append.
- Cross-channel namespace unification by userId.
- `source=session:<key>` filtering behavior for memory bridge metadata.

---

### 9) Adapted from Clawdbot

1. Direct-chat collapse + group isolation strategy adapted from `resolveSessionKey` / `resolveGroupSessionKey` patterns in `sessions-Ct_EthZk.js`.
2. Subagent key prefix convention adapted from `session-key-BWxPj0z_.js` (`subagent:` handling).
3. Store maintenance model adapted from `loadSessionStore`/`updateSessionStore` lifecycle ideas in `sessions-Ct_EthZk.js`, translated to SQL lifecycle sweeps.
4. Explicitly removed Clawdbot fallback keys (`global`/`unknown`) to enforce strict canonical keys and `SESSION_INVALID_KEY` errors.


