**Session x Memory Auto-Extraction Design**

## 1. Scope
- Auto extraction is queued when a session transitions to `idle`.
- Manual extraction supports explicit `"remember this"` flows during a live session.
- Both write to the user shared namespace resolved by `sessionService.getSessionMemoryNamespace(sessionKey)`.
- Implementation is a wrapper around existing `FridaySessionService`, `FridayMemoryService`, and `FridayProviderService`.

## 2. Core Architecture
- Add `FridaySessionMemoryExtractionService` for queueing, processing, manual extraction, status, and retry.
- Add a durable queue table `session_memory_extraction_jobs` (SQLite migration `v006`) to persist extraction jobs.
- Add a session lifecycle job that marks idle candidates and enqueues extraction for newly idle sessions.
- Extraction worker processes queued jobs in batches of unextracted messages (`memoryExtractStatus = 'pending'`), calls BYOK LLM, stores memory items, then marks message statuses `extracted` / `skipped` / `failed`.

## 3. Constants (new)
File: `src/sessions/friday-session-memory-extraction.constants.ts`
```ts
export const FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE = 24;
export const FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE = 100;
export const FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_BATCHES = 8;
export const FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_ITEMS_PER_BATCH = 10;
export const FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_JOB_MAX_ATTEMPTS = 3;
export const FRIDAY_SESSION_MEMORY_EXTRACTION_RETRY_BASE_DELAY_MS = 30_000;
export const FRIDAY_SESSION_MEMORY_EXTRACTION_WORKER_CLAIM_LIMIT = 10;

export const FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_AUTO = "source:auto";
export const FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_MANUAL = "source:manual";
export const FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_PREFIX_KIND = "memory_kind";

export const FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES = {
  INVALID_INPUT: "SESSION_MEMORY_EXTRACTION_INVALID_INPUT",
  SESSION_NOT_FOUND: "SESSION_MEMORY_EXTRACTION_SESSION_NOT_FOUND",
  MESSAGE_SCOPE_VIOLATION: "SESSION_MEMORY_EXTRACTION_MESSAGE_SCOPE_VIOLATION",
  PROVIDER_ERROR: "SESSION_MEMORY_EXTRACTION_PROVIDER_ERROR",
  PARSE_ERROR: "SESSION_MEMORY_EXTRACTION_PARSE_ERROR",
  QUEUE_CONFLICT: "SESSION_MEMORY_EXTRACTION_QUEUE_CONFLICT",
  JOB_NOT_FOUND: "SESSION_MEMORY_EXTRACTION_JOB_NOT_FOUND",
} as const;
```

## 4. Types (new)
File: `src/sessions/model/friday-session-memory-extraction.types.ts`
```ts
export type FridaySessionMemoryExtractionTrigger = "auto" | "manual" | "retry";
export type FridaySessionMemoryExtractionJobStatus = "queued" | "running" | "completed" | "failed";
export type FridaySessionMemoryExtractionItemKind = "fact" | "decision" | "preference" | "action_item";

export interface FridaySessionMemoryExtractionJobRecord {
  id: string;
  sessionKey: string;
  trigger: FridaySessionMemoryExtractionTrigger;
  status: FridaySessionMemoryExtractionJobStatus;
  requestedMessageIds?: string[];
  batchSize: number;
  maxBatches: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridaySessionMemoryExtractionRunResult {
  jobId?: string;
  sessionKey: string;
  trigger: FridaySessionMemoryExtractionTrigger;
  mode: "queued" | "inline";
  queued: boolean;
  processedMessageCount: number;
  extractedMessageCount: number;
  skippedMessageCount: number;
  failedMessageCount: number;
  memoryItemsCreated: number;
}

export interface FridaySessionMemoryExtractionStatus {
  sessionKey: string;
  pendingMessages: number;
  extractedMessages: number;
  skippedMessages: number;
  failedMessages: number;
  queuedJobs: number;
  runningJobs: number;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface FridaySessionMemoryRetryResult {
  sessionsQueued: string[];
  resetMessageCount: number;
}

export interface FridaySessionMemoryExtractionLlmItem {
  kind: FridaySessionMemoryExtractionItemKind;
  content: string;
  sourceMessageIds: string[];
  tags?: string[];
}

export interface FridaySessionMemoryExtractionLlmResponse {
  items: FridaySessionMemoryExtractionLlmItem[];
}
```

## 5. Service Interface (new)
File: `src/sessions/services/friday-session-memory-extraction-service.types.ts`
```ts
import type { FridaySessionMemoryExtractionRunResult, FridaySessionMemoryExtractionStatus, FridaySessionMemoryRetryResult, FridaySessionMemoryExtractionTrigger } from "../model/friday-session-memory-extraction.types.js";
import type { FridaySqliteLayer } from "#state";
import type { FridaySessionService } from "#sessions";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";

export interface FridaySessionMemoryExtractionService {
  extractFromSession(
    sessionKey: string,
    options?: {
      trigger?: FridaySessionMemoryExtractionTrigger; // auto/manual/retry
      mode?: "queue" | "inline"; // default: auto->queue, manual/retry->inline
      batchSize?: number;
      maxBatches?: number;
    },
  ): Promise<FridaySessionMemoryExtractionRunResult>;

  extractSpecificMessages(
    sessionKey: string,
    messageIds: string[],
    options?: {
      mode?: "queue" | "inline"; // default inline
    },
  ): Promise<FridaySessionMemoryExtractionRunResult>;

  getExtractionStatus(sessionKey: string): Promise<FridaySessionMemoryExtractionStatus>;

  retryFailedExtractions(sessionKey?: string): Promise<FridaySessionMemoryRetryResult>;
}

export interface CreateFridaySessionMemoryExtractionServiceDeps {
  db: FridaySqliteLayer;
  sessionService: FridaySessionService;
  memoryService: FridayMemoryService;
  providerService: FridayProviderService;
  idGenerator: () => string;
  nowIso: () => string;
}
```

## 6. Extraction Pipeline
- Read eligible messages from `session_messages`:
  - Auto/manual session extraction: `memory_extract_status = 'pending'`.
  - Retry path: `memory_extract_status = 'failed'`.
  - Manual specific: explicit message IDs (must belong to session).
- Batch by `occurred_at ASC`, configurable `batchSize`.
- Call BYOK LLM with prompt: “Extract key facts, decisions, preferences, and action items from this conversation.”
- Require strict JSON output:
```json
{
  "items": [
    {
      "kind": "fact|decision|preference|action_item",
      "content": "short durable memory",
      "sourceMessageIds": ["msg-1", "msg-2"],
      "tags": ["optional.lowercase.tag"]
    }
  ]
}
```
- Validate response:
  - Invalid/malformed JSON -> batch fails -> mark batch messages `failed`.
  - Empty valid items -> mark batch messages `skipped` (manual specific can fallback to verbatim store if desired).
- For each valid item, write with:
  - `namespace`: from `sessionService.getSessionMemoryNamespace(sessionKey)`.
  - `source`: `session:<sessionKey>` (reuse `buildFridaySessionMemorySource`).
  - `tags`: `source:auto` or `source:manual`, `session:<sessionKey>`, `channel:<channel>`, `chat_kind:<chatKind>`, `memory_kind:<kind>`.
  - `metadata`: `sessionKey`, `messageIds`, `trigger`, `jobId`, `accountId`, `chatId`, `extractedAt`.
- Mark message statuses:
  - Source message IDs used in saved items -> `extracted`.
  - Processed but unused -> `skipped`.
  - Batch/provider/parse failure -> `failed`.

## 7. Auto-Extract on Idle
- Add session lifecycle worker job:
  - Mark `active -> idle` using existing timeout semantics.
  - Identify sessions that transitioned this run.
  - For each, call `extractFromSession(sessionKey, { trigger: "auto", mode: "queue" })`.
- Queue dedupe:
  - Enforce one open auto job per session (`queued`/`running`) with partial unique index.

## 8. Manual “Remember This”
- Add explicit API route and command integration:
  - API endpoint calls `extractSpecificMessages(sessionKey, messageIds)`.
  - NLP command handler (“remember this”) resolves target message IDs and calls same method.
- Manual writes include required tags:
  - `source:manual`
  - `session:<sessionKey>`

## 9. Persistence / Migration
File: `src/state/sqlite/migrations/v006-session-memory-extraction.ts`
```sql
CREATE TABLE IF NOT EXISTS session_memory_extraction_jobs (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','manual','retry')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  requested_message_ids_json TEXT,
  batch_size INTEGER NOT NULL,
  max_batches INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_mem_extract_jobs_status_next
  ON session_memory_extraction_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_session_mem_extract_jobs_session_created
  ON session_memory_extraction_jobs(session_key, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_mem_extract_jobs_auto_open
  ON session_memory_extraction_jobs(session_key)
  WHERE trigger = 'auto' AND status IN ('queued','running');
```

## 10. File Plan
- `src/sessions/friday-session-memory-extraction.constants.ts`
- `src/sessions/model/friday-session-memory-extraction.types.ts`
- `src/sessions/persistence/friday-session-memory-extraction-repository.ts`
- `src/sessions/services/friday-session-memory-extraction-llm-client.ts`
- `src/sessions/services/friday-session-memory-extraction-service.types.ts`
- `src/sessions/services/friday-session-memory-extraction-service.ts`
- `src/sessions/index.ts`
- `src/jobs/sessions/friday-session-lifecycle-job.types.ts`
- `src/jobs/sessions/friday-session-lifecycle-job.ts`
- `src/jobs/sessions/friday-session-memory-extraction-job.types.ts`
- `src/jobs/sessions/friday-session-memory-extraction-job.ts`
- `src/jobs/index.ts`
- `src/api/model/friday-api-session.types.ts`
- `src/api/http/routes/friday-session-routes.ts`
- `src/api/runtime/friday-api-runtime.types.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/state/sqlite/migrations/v006-session-memory-extraction.ts`
- `src/state/sqlite/migrations/index.ts`

## 11. API Additions
- `POST /v1/sessions/:sessionKey/memory/extract` (`sessions.memory.extract`)
- `POST /v1/sessions/:sessionKey/memory/remember` (`sessions.memory.remember`)
- `GET /v1/sessions/:sessionKey/memory/extraction` (`sessions.memory.extraction.get`)
- `POST /v1/sessions/memory/extraction/retry` (`sessions.memory.extraction.retry`)

## 12. Test Plan
- `test/unit/sessions/services/friday-session-memory-extraction-service.test.ts`
- `test/unit/sessions/services/friday-session-memory-extraction-llm-client.test.ts`
- `test/unit/sessions/persistence/friday-session-memory-extraction-repository.test.ts`
- `test/unit/jobs/sessions/friday-session-memory-extraction-job.test.ts`
- `test/unit/jobs/sessions/friday-session-lifecycle-job.test.ts`
- `test/unit/api/http/routes/friday-session-routes.test.ts` (new extraction endpoints)
- `test/unit/api/runtime/friday-api-runtime-session-registration.test.ts` (wiring)
- `test/unit/state/sqlite/friday-v006-session-memory-extraction-schema.test.ts`
- Integration test: idle transition queues job, worker writes memory, messages become `extracted/skipped`.
- Integration test: provider failure marks `failed`, `retryFailedExtractions` resets/queues and succeeds on retry.

If you want, I can turn this into a concrete patch set file-by-file next.
