**Session Fork Design (extends current session foundation)**

**1) Core Invariants**
1. Fork keys stay `subagent:<parentKey>:<taskId>` and are always created via `buildFridaySubagentSessionKey(...)` in `src/sessions/services/friday-session-key.ts`.
2. A fork is a normal `sessions` row with `parent_session_key`, `root_session_key`, and `forked_from_message_id` set.
3. Fork inherits parent memory namespace exactly.
4. Parent context is copied into child as read-only inherited messages.
5. Inherited messages do not increment child `message_count` or token counters.

**2) Constants + Error Codes**
Add to `src/sessions/friday-session.constants.ts`:
1. `FRIDAY_SESSION_FORK_DEFAULT_CONTEXT_MESSAGE_COUNT = 20`
2. `FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT = 200`
3. `FRIDAY_SESSION_FORK_TIMEOUT_MS = 2 * 60 * 60 * 1000` (2h)
4. `FRIDAY_SESSION_FORK_DEFAULT_ARCHIVE_ON_MERGE = true`
5. Error codes in `FRIDAY_SESSION_ERROR_CODES`:
`FORK_PARENT_NOT_FOUND`, `FORK_POINT_NOT_FOUND`, `FORK_CONFLICT`, `FORK_MERGE_VALIDATION_ERROR`, `FORK_LINEAGE_MISMATCH` with `SESSION_*` values.

**3) Type Additions**
Update `src/sessions/model/friday-session.types.ts`:
```ts
export interface FridaySessionForkCreateInput {
  taskId?: string;
  inheritMessageCount?: number;
  forkFromMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionForkCreateResult {
  forkSession: FridaySessionRecord;
  inheritedMessageCount: number;
  forkedFromMessageId?: string;
}

export interface FridaySessionForkListInput {
  status?: FridaySessionStatus; // default active+idle
  limit?: number;
}

export interface FridaySessionForkMergeInput {
  forkSessionKey: string;
  summary: string;
  archiveFork?: boolean;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionForkMergeResult {
  parentMessage: FridaySessionMessageRecord;
  forkSession: FridaySessionRecord;
}
```

Extend `FridaySessionMessageRecord` with optional inherited markers:
`inherited?: boolean`, `inheritedFromSessionKey?: string`, `inheritedFromMessageId?: string`.

Update `src/sessions/services/friday-session-service.types.ts`:
1. `forkSession(parentKey, input?)`
2. `listForks(parentKey, input?)`
3. `mergeForkSummary(parentKey, input)`

**4) Persistence + Migration**
Add migration `src/state/sqlite/migrations/v007-session-forks.ts`:
1. `ALTER TABLE session_messages ADD COLUMN is_inherited INTEGER NOT NULL DEFAULT 0`
2. `ALTER TABLE session_messages ADD COLUMN inherited_from_session_key TEXT`
3. `ALTER TABLE session_messages ADD COLUMN inherited_from_message_id TEXT`
4. Indexes:
`idx_session_messages_session_inherited_sequence` on `(session_key, is_inherited, sequence DESC)`
`idx_sessions_parent_status_activity` on `(parent_session_key, status, last_activity_at DESC)`

Register in `src/state/sqlite/migrations/index.ts`.

Extend `src/sessions/persistence/friday-session-message-repository.ts`:
1. Add row mapping for inherited columns.
2. Add `getBySessionAndId(...)`.
3. Add `listForkContextWindow(sessionKey, limit, maxSequence?)`.
4. Extend append input with inherited flags and `memoryExtractStatus` override.

Extend `src/sessions/persistence/friday-session-repository.ts`:
1. `listByParentSessionKey(...)`
2. `setForkLineage(...)` to set `parent_session_key`, `root_session_key`, `forked_from_message_id`, `memory_namespace`.
3. `markForkArchivedCandidates(...)`.

**5) Service Behavior**
Implement in `src/sessions/services/friday-session-service.ts`:

1. `forkSession(parentKey, input?)` (single transaction)
- Validate parent exists.
- Resolve `taskId` (input or generated), build subagent key.
- Resolve fork point:
`input.forkFromMessageId` or latest parent message id.
- Create child session.
- Set lineage (`parentSessionKey`, `rootSessionKey`, `forkedFromMessageId`) and `memoryNamespace` from parent.
- Copy parent context window (default 20) into child as inherited messages:
`is_inherited=1`, `inherited_from_*` set, `memory_extract_status='skipped'`.
- Do not call `touchActivity(... messageDelta ...)` for inherited inserts.

2. `listForks(parentKey, input?)`
- Return direct child sessions where `parent_session_key = parentKey`.
- Default statuses: `active` + `idle`.

3. `mergeForkSummary(parentKey, input)`
- Validate parent exists, fork exists, and `fork.parentSessionKey === parentKey`.
- Write summary into parent via `addMessage(...)` as assistant message with merge metadata.
- Optional archive fork (default true).
- Return created parent message + current fork session.

4. `sweepLifecycle()`
- Add fork timeout archival step using `FRIDAY_SESSION_FORK_TIMEOUT_MS` and `markForkArchivedCandidates(...)`.
- Include this in archived counts.

Update `src/sessions/services/friday-session-memory-extraction-service.ts`:
- Exclude inherited context from pending extraction queries (`is_inherited = 0`).

**6) API Additions**
Update `src/api/model/friday-api-session.types.ts`:
1. `FridaySessionForkRequest/Response`
2. `FridaySessionForkListResponse`
3. `FridaySessionMergeRequest/Response`

Update `src/api/http/routes/friday-session-routes.ts` with:
1. `POST /v1/sessions/:sessionKey/fork`
- `operationId: "sessions.forks.create"`
- scope: `session.write`
2. `GET /v1/sessions/:sessionKey/forks`
- `operationId: "sessions.forks.list"`
- scope: `session.read`
3. `POST /v1/sessions/:sessionKey/merge`
- `operationId: "sessions.forks.merge"`
- scope: `session.write`

Validation rules:
1. `inheritMessageCount` integer in `[0, FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT]`
2. `taskId` non-empty string if provided
3. `forkFromMessageId` non-empty if provided
4. `summary` non-empty string for merge
5. URL decode via existing `decodeSessionKeyParam`.

**7) File Plan**
1. `src/sessions/friday-session.constants.ts`
2. `src/sessions/model/friday-session.types.ts`
3. `src/sessions/services/friday-session-service.types.ts`
4. `src/sessions/services/friday-session-service.ts`
5. `src/sessions/persistence/friday-session-repository.ts`
6. `src/sessions/persistence/friday-session-message-repository.ts`
7. `src/sessions/services/friday-session-memory-extraction-service.ts`
8. `src/sessions/index.ts`
9. `src/api/model/friday-api-session.types.ts`
10. `src/api/http/routes/friday-session-routes.ts`
11. `src/state/sqlite/migrations/v007-session-forks.ts` (new)
12. `src/state/sqlite/migrations/index.ts`

**8) Test Plan**
1. `test/unit/sessions/services/friday-session-service.test.ts`
- fork creates subagent child, lineage set, memory namespace inherited.
- default and custom context window.
- fork point behavior with `forkFromMessageId`.
- inherited messages present and marked.
- inherited messages do not change `messageCount`.
- listForks returns active children.
- merge validates lineage and writes parent summary.
- fork timeout archival path in sweep.

2. `test/unit/sessions/persistence/friday-session-message-repository.test.ts`
- inherited column mapping and append behavior.
- context-window query ordering.

3. `test/unit/sessions/persistence/friday-session-repository.test.ts`
- list by parent key.
- markForkArchivedCandidates behavior.

4. `test/unit/api/http/routes/friday-session-routes.test.ts`
- route count + unique operation IDs updated.
- fork/list/merge request validation and happy paths.
- route map contains new endpoints.

5. `test/unit/api/runtime/friday-api-runtime-session-registration.test.ts`
- new `sessions.forks.*` operation IDs are registered.

6. `test/unit/state/sqlite/friday-v007-session-forks-schema.test.ts` (new)
- new columns and indexes exist.
- migration row `version=7` exists.

7. `test/unit/sessions/services/friday-session-memory-extraction-service.test.ts`
- inherited context messages are excluded from extraction candidates.
