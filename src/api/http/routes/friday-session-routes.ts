import { FridayDomainError } from "#errors";
import {
  FRIDAY_SESSION_ERROR_CODES,
  FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES,
} from "#sessions";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import {
  FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT,
} from "#sessions";
import type {
  FridaySessionArchiveResponse,
  FridaySessionCreateRequest,
  FridaySessionCreateResponse,
  FridaySessionForkListResponse,
  FridaySessionForkRequest,
  FridaySessionForkResponse,
  FridaySessionGetResponse,
  FridaySessionListResponse,
  FridaySessionMemoryExtractionRetryResponse,
  FridaySessionMemoryExtractionStatusResponse,
  FridaySessionMemoryExtractRequest,
  FridaySessionMemoryExtractResponse,
  FridaySessionMemoryNamespaceResponse,
  FridaySessionMemoryRememberRequest,
  FridaySessionMemoryRememberResponse,
  FridaySessionMergeRequest,
  FridaySessionMergeResponse,
  FridaySessionMessageCreateRequest,
  FridaySessionMessageCreateResponse,
  FridaySessionMessageListResponse,
  FridaySessionPruneRequest,
  FridaySessionPruneResponse,
  FridaySessionRunRequest,
  FridaySessionRunResponse,
  FridaySessionSweepResponse,
} from "../../model/friday-api-session.types.js";
import type { FridaySessionService } from "#sessions";
import type { FridaySessionStatus } from "#sessions";
import type { FridaySessionMemoryExtractionService } from "#sessions";

// ─── Dependencies ───

export interface FridaySessionRoutesDeps {
  sessionService: FridaySessionService;
  extractionService?: FridaySessionMemoryExtractionService;
  runSession?: (input: {
    sessionKey: string;
    task: string;
    providerId?: string;
    model?: string;
    timezone?: string;
    timeoutMs?: number;
    principalId?: string;
    scopes?: string[];
    persistTaskMessage?: boolean;
    taskAlreadyInHistory?: boolean;
  }) => Promise<FridaySessionRunResponse["run"]>;
}

// ─── Metadata sanitization (VULN-1: Prototype Pollution DoS) ───

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively sanitize a metadata value, rejecting forbidden keys that could
 * cause prototype pollution and using null-prototype objects to prevent
 * accidental prototype chain access.
 */
function sanitizeMetadataValue(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value; // primitives pass through

  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeMetadataValue(item, `${path}[${i}]`));
  }

  // Plain objects → create null-prototype copy with only safe own keys
  const src = value as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;

  for (const key of Object.keys(src)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Forbidden metadata key '${key}' at ${path}.${key}`,
        { httpStatus: 400 },
      );
    }
    out[key] = sanitizeMetadataValue(src[key], `${path}.${key}`);
  }

  return out;
}

/**
 * Sanitize a top-level metadata field. If present, must be a plain object.
 * Returns the sanitized null-prototype object, or undefined if not provided.
 */
function sanitizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "metadata must be a plain object",
      { httpStatus: 400 },
    );
  }
  return sanitizeMetadataValue(metadata, "metadata") as Record<string, unknown>;
}

// ─── Validation helpers ───

function validateCreateSessionBody(body: unknown): asserts body is FridaySessionCreateRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.channel !== "string" || !b.channel) {
    errors.push("channel is required and must be a non-empty string");
  }
  if (typeof b.chatId !== "string" || !b.chatId) {
    errors.push("chatId is required and must be a non-empty string");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateCreateMessageBody(body: unknown): asserts body is FridaySessionMessageCreateRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.role !== "string" || !b.role) {
    errors.push("role is required and must be a non-empty string");
  }
  if (b.content === undefined || b.content === null) {
    errors.push("content is required");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      `Invalid message body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateRunBody(body: unknown): asserts body is FridaySessionRunRequest {
  if (body == null) {
    return;
  }
  if (typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      "Request body must be an object when provided",
      { httpStatus: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.task !== undefined && (typeof b.task !== "string" || b.task.trim() === "")) {
    errors.push("task must be a non-empty string when provided");
  }
  if (b.providerId !== undefined && (typeof b.providerId !== "string" || b.providerId.trim() === "")) {
    errors.push("providerId must be a non-empty string when provided");
  }
  if (b.model !== undefined && (typeof b.model !== "string" || b.model.trim() === "")) {
    errors.push("model must be a non-empty string when provided");
  }
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== "string" || b.timezone.trim() === "") {
      errors.push("timezone must be a non-empty IANA timezone string when provided");
    } else {
      try {
        Intl.DateTimeFormat("en-US", { timeZone: b.timezone.trim() }).format(new Date());
      } catch {
        errors.push("timezone is not a valid IANA timezone");
      }
    }
  }
  if (
    b.timeoutMs !== undefined &&
    (typeof b.timeoutMs !== "number" || !Number.isFinite(b.timeoutMs) || b.timeoutMs < 1)
  ) {
    errors.push("timeoutMs must be a positive number when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      `Invalid run body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validatePruneBody(body: unknown): asserts body is FridaySessionPruneRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;

  if (typeof b.olderThan !== "string" || !b.olderThan) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      "olderThan is required and must be a non-empty ISO 8601 date string",
      { httpStatus: 400 },
    );
  }

  // Validate ISO date format
  validateIsoDate(b.olderThan, "olderThan");
}

function validateIsoDate(value: string, label: string): void {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      `${label} must be a valid ISO 8601 date string, got '${value}'`,
      { httpStatus: 400 },
    );
  }
}

const VALID_REMEMBER_MODES = new Set<string>(["queue", "inline"]);

function validateRememberBody(body: unknown): asserts body is FridaySessionMemoryRememberRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.messageIds) || b.messageIds.length === 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      "messageIds must be a non-empty array of strings",
      { httpStatus: 400 },
    );
  }

  for (const id of b.messageIds) {
    if (typeof id !== "string" || !id) {
      throw new FridayDomainError(
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
        "Each messageId must be a non-empty string",
        { httpStatus: 400 },
      );
    }
  }

  if (b.mode !== undefined) {
    if (typeof b.mode !== "string" || !VALID_REMEMBER_MODES.has(b.mode)) {
      throw new FridayDomainError(
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
        "mode must be one of: queue, inline",
        { httpStatus: 400 },
      );
    }
  }
}

const VALID_EXTRACT_TRIGGERS = new Set<string>(["auto", "manual", "retry"]);
const VALID_EXTRACT_MODES = new Set<string>(["queue", "inline"]);

function validateExtractBody(body: unknown): asserts body is FridaySessionMemoryExtractRequest {
  if (body == null || typeof body !== "object") {
    // Allow empty body — defaults apply
    return;
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.trigger !== undefined) {
    if (typeof b.trigger !== "string" || !VALID_EXTRACT_TRIGGERS.has(b.trigger)) {
      errors.push(`trigger must be one of: auto, manual, retry`);
    }
  }
  if (b.mode !== undefined) {
    if (typeof b.mode !== "string" || !VALID_EXTRACT_MODES.has(b.mode)) {
      errors.push(`mode must be one of: queue, inline`);
    }
  }
  if (b.batchSize !== undefined) {
    if (typeof b.batchSize !== "number" || !Number.isInteger(b.batchSize) || b.batchSize < 1) {
      errors.push("batchSize must be a positive integer");
    }
  }
  if (b.maxBatches !== undefined) {
    if (typeof b.maxBatches !== "number" || !Number.isInteger(b.maxBatches) || b.maxBatches < 1) {
      errors.push("maxBatches must be a positive integer");
    }
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      `Invalid extract body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateRetryBody(body: unknown): asserts body is { sessionKey?: string } {
  if (body == null || typeof body !== "object") {
    // Allow empty body — retries all sessions
    return;
  }
  const b = body as Record<string, unknown>;

  if (b.sessionKey !== undefined && (typeof b.sessionKey !== "string" || !b.sessionKey)) {
    throw new FridayDomainError(
      FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      "sessionKey must be a non-empty string when provided",
      { httpStatus: 400 },
    );
  }
}

function decodeSessionKeyParam(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Invalid URL-encoded session key: '${raw}'`,
      { httpStatus: 400 },
    );
  }
  // DX-002: If key doesn't contain ':', auto-prefix with 'local:default:'
  // so simple keys like 'test-session' become 'local:default:test-session'.
  if (!decoded.includes(":")) {
    decoded = `local:default:${decoded}`;
  }
  return decoded;
}

function validateForkBody(body: unknown): asserts body is FridaySessionForkRequest {
  if (body == null || typeof body !== "object") {
    // Allow empty body — defaults apply
    return;
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.taskId !== undefined) {
    if (typeof b.taskId !== "string" || !b.taskId) {
      errors.push("taskId must be a non-empty string when provided");
    }
  }
  if (b.inheritMessageCount !== undefined) {
    if (
      typeof b.inheritMessageCount !== "number" ||
      !Number.isInteger(b.inheritMessageCount) ||
      b.inheritMessageCount < 0 ||
      b.inheritMessageCount > FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT
    ) {
      errors.push(`inheritMessageCount must be an integer in [0, ${FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT}]`);
    }
  }
  if (b.forkFromMessageId !== undefined) {
    if (typeof b.forkFromMessageId !== "string" || !b.forkFromMessageId) {
      errors.push("forkFromMessageId must be a non-empty string when provided");
    }
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      `Invalid fork body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateMergeBody(body: unknown): asserts body is FridaySessionMergeRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.forkSessionKey !== "string" || !b.forkSessionKey) {
    errors.push("forkSessionKey is required and must be a non-empty string");
  }
  if (typeof b.summary !== "string" || !b.summary) {
    errors.push("summary is required and must be a non-empty string");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
      `Invalid merge body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

/** Maximum value for list endpoint limit query parameters. */
const FRIDAY_MAX_LIST_LIMIT = 100;

const VALID_SESSION_STATUSES = new Set<string>(["active", "idle", "archived", "pruned"]);

// ─── Factory ───

export function createFridaySessionRoutes(
  deps: FridaySessionRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // 1. GET /v1/sessions — list sessions
    {
      operationId: "sessions.list",
      method: "GET",
      path: "/v1/sessions",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx): Promise<FridaySessionListResponse> {
        const query = ctx.query as Record<string, string | undefined>;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, FRIDAY_MAX_LIST_LIMIT);
        }

        let status: FridaySessionStatus | undefined;
        if (query.status !== undefined) {
          if (!VALID_SESSION_STATUSES.has(query.status)) {
            throw new FridayDomainError(
              FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
              `status must be one of: active, idle, archived, pruned`,
              { httpStatus: 400 },
            );
          }
          status = query.status as FridaySessionStatus;
        }

        const items = await deps.sessionService.listSessions({
          channel: query.channel,
          accountId: query.accountId,
          userId: query.userId,
          status,
          limit,
          cursor: query.cursor,
        });

        return { items };
      },
    },

    // 2. POST /v1/sessions — create session
    {
      operationId: "sessions.create",
      method: "POST",
      path: "/v1/sessions",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionCreateResponse> {
        validateCreateSessionBody(ctx.body);
        const body = ctx.body;
        const metadata = sanitizeMetadata(body.metadata);
        const session = await deps.sessionService.createSession({
          channel: body.channel,
          chatId: body.chatId,
          userId: body.userId,
          accountId: body.accountId,
          chatKind: body.chatKind,
          metadata,
        });
        return { session };
      },
    },

    // 3. GET /v1/sessions/:sessionKey — get session
    {
      operationId: "sessions.get",
      method: "GET",
      path: "/v1/sessions/:sessionKey",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx): Promise<FridaySessionGetResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const session = await deps.sessionService.getSession(key);
        if (!session) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
            `Session '${key}' not found`,
            { httpStatus: 404 },
          );
        }
        return { session };
      },
    },

    // 4. POST /v1/sessions/:sessionKey/archive — archive session
    {
      operationId: "sessions.archive",
      method: "POST",
      path: "/v1/sessions/:sessionKey/archive",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionArchiveResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const session = await deps.sessionService.archiveSession(key);
        return { session };
      },
    },

    // 4b. POST /v1/sessions/:sessionKey/reset — reset session
    {
      operationId: "sessions.reset",
      method: "POST",
      path: "/v1/sessions/:sessionKey/reset",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx) {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const session = await deps.sessionService.resetSession(key);
        return { session };
      },
    },

    // 5. POST /v1/sessions/prune — prune old sessions
    {
      operationId: "sessions.prune",
      method: "POST",
      path: "/v1/sessions/prune",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionPruneResponse> {
        validatePruneBody(ctx.body);
        const body = ctx.body;
        const result = await deps.sessionService.pruneOldSessions(body.olderThan);
        return { result };
      },
    },

    // 6. POST /v1/sessions/sweep — lifecycle sweep
    {
      operationId: "sessions.sweep",
      method: "POST",
      path: "/v1/sessions/sweep",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(): Promise<FridaySessionSweepResponse> {
        const result = await deps.sessionService.sweepLifecycle();
        return { result };
      },
    },

    // 7. GET /v1/sessions/:sessionKey/messages — list messages
    {
      operationId: "sessions.messages.list",
      method: "GET",
      path: "/v1/sessions/:sessionKey/messages",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx): Promise<FridaySessionMessageListResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const query = ctx.query as Record<string, string | undefined>;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, FRIDAY_MAX_LIST_LIMIT);
        }

        const items = await deps.sessionService.getMessages(key, limit, query.before);
        return { items };
      },
    },

    // 8. POST /v1/sessions/:sessionKey/messages — create message
    {
      operationId: "sessions.messages.create",
      method: "POST",
      path: "/v1/sessions/:sessionKey/messages",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionMessageCreateResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateCreateMessageBody(ctx.body);
        const body = ctx.body;
        const message = await deps.sessionService.addMessage(key, body);
        return { message };
      },
    },

    // 8b. POST /v1/sessions/:sessionKey/run — run agent against session context (legacy compatibility)
    {
      operationId: "sessions.run",
      method: "POST",
      path: "/v1/sessions/:sessionKey/run",
      auth: { public: false, anyOfScopes: ["session.write", "agent.run", "workflow.run"] },
      async handler(ctx): Promise<FridaySessionRunResponse> {
        if (!deps.runSession) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
            "Session run endpoint is not available: agent runtime is not configured",
            { httpStatus: 501 },
          );
        }

        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateRunBody(ctx.body);
        const body = (ctx.body ?? {}) as FridaySessionRunRequest;

        const taskFromBody = body.task?.trim();
        let task = taskFromBody;
        if (!task) {
          const history = await deps.sessionService.getMessages(key, 200);
          const lastUserMessage = [...history]
            .reverse()
            .find((msg) => msg.role === "user" && msg.contentText.trim().length > 0);
          task = lastUserMessage?.contentText.trim();
        }

        if (!task) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
            "No task provided and no user message found in session history",
            { httpStatus: 400 },
          );
        }

        const run = await deps.runSession({
          sessionKey: key,
          task,
          providerId: body.providerId,
          model: body.model,
          timezone: body.timezone?.trim(),
          timeoutMs: body.timeoutMs,
          persistTaskMessage: Boolean(taskFromBody),
          taskAlreadyInHistory: !taskFromBody,
          ...(ctx.principal
            ? {
              principalId: ctx.principal.principalId,
              scopes: ctx.principal.scopes,
            }
            : {}),
        });

        const messages = await deps.sessionService.getMessages(key, 200);
        return {
          run,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.contentText,
          })),
        };
      },
    },

    // 9. GET /v1/sessions/:sessionKey/memory-namespace — get memory namespace
    {
      operationId: "sessions.memory.namespace.get",
      method: "GET",
      path: "/v1/sessions/:sessionKey/memory-namespace",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx): Promise<FridaySessionMemoryNamespaceResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const namespace = await deps.sessionService.getSessionMemoryNamespace(key);
        return { namespace };
      },
    },

    // ─── Fork endpoints ───

    // 10. POST /v1/sessions/:sessionKey/fork — create a fork
    {
      operationId: "sessions.forks.create",
      method: "POST",
      path: "/v1/sessions/:sessionKey/fork",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionForkResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateForkBody(ctx.body);
        const body = (ctx.body ?? {}) as FridaySessionForkRequest;
        const metadata = sanitizeMetadata(body.metadata);
        const result = await deps.sessionService.forkSession(key, {
          taskId: body.taskId,
          inheritMessageCount: body.inheritMessageCount,
          forkFromMessageId: body.forkFromMessageId,
          metadata,
        });
        return { result };
      },
    },

    // 11. GET /v1/sessions/:sessionKey/forks — list forks
    {
      operationId: "sessions.forks.list",
      method: "GET",
      path: "/v1/sessions/:sessionKey/forks",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx): Promise<FridaySessionForkListResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const query = ctx.query as Record<string, string | undefined>;

        let status: FridaySessionStatus | undefined;
        if (query.status !== undefined) {
          if (!VALID_SESSION_STATUSES.has(query.status)) {
            throw new FridayDomainError(
              FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
              `status must be one of: active, idle, archived, pruned`,
              { httpStatus: 400 },
            );
          }
          status = query.status as FridaySessionStatus;
        }

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, FRIDAY_MAX_LIST_LIMIT);
        }

        const items = await deps.sessionService.listForks(key, { status, limit });
        return { items };
      },
    },

    // 12. POST /v1/sessions/:sessionKey/merge — merge fork summary
    {
      operationId: "sessions.forks.merge",
      method: "POST",
      path: "/v1/sessions/:sessionKey/merge",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionMergeResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateMergeBody(ctx.body);
        const body = ctx.body;
        const metadata = sanitizeMetadata(body.metadata);
        const result = await deps.sessionService.mergeForkSummary(key, {
          forkSessionKey: body.forkSessionKey,
          summary: body.summary,
          archiveFork: body.archiveFork,
          idempotencyKey: body.idempotencyKey,
          metadata,
        });
        return { result };
      },
    },

    // ─── Memory extraction endpoints (optional) ───

    // 13. POST /v1/sessions/:sessionKey/memory/extract — trigger extraction
    {
      operationId: "sessions.memory.extract",
      method: "POST",
      path: "/v1/sessions/:sessionKey/memory/extract",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionMemoryExtractResponse> {
        if (!deps.extractionService) {
          throw new FridayDomainError(
            FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
            "Memory extraction service is not configured",
            { httpStatus: 501 },
          );
        }
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateExtractBody(ctx.body);
        const body = (ctx.body ?? {}) as FridaySessionMemoryExtractRequest;
        const result = await deps.extractionService.extractFromSession(key, {
          trigger: body.trigger,
          mode: body.mode,
          batchSize: body.batchSize,
          maxBatches: body.maxBatches,
        });
        return { result };
      },
    },

    // 14. POST /v1/sessions/:sessionKey/memory/remember — remember specific messages
    {
      operationId: "sessions.memory.remember",
      method: "POST",
      path: "/v1/sessions/:sessionKey/memory/remember",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionMemoryRememberResponse> {
        if (!deps.extractionService) {
          throw new FridayDomainError(
            FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
            "Memory extraction service is not configured",
            { httpStatus: 501 },
          );
        }
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateRememberBody(ctx.body);
        const body = ctx.body;
        const result = await deps.extractionService.extractSpecificMessages(
          key,
          body.messageIds,
          { mode: body.mode },
        );
        return { result };
      },
    },

    // 15. GET /v1/sessions/:sessionKey/memory/extraction — get extraction status
    {
      operationId: "sessions.memory.extraction.get",
      method: "GET",
      path: "/v1/sessions/:sessionKey/memory/extraction",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx): Promise<FridaySessionMemoryExtractionStatusResponse> {
        if (!deps.extractionService) {
          throw new FridayDomainError(
            FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
            "Memory extraction service is not configured",
            { httpStatus: 501 },
          );
        }
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const status = await deps.extractionService.getExtractionStatus(key);
        return { status };
      },
    },

    // 16. POST /v1/sessions/memory/extraction/retry — retry failed extractions
    {
      operationId: "sessions.memory.extraction.retry",
      method: "POST",
      path: "/v1/sessions/memory/extraction/retry",
      auth: { public: false, anyOfScopes: ["session.write"] },
      async handler(ctx): Promise<FridaySessionMemoryExtractionRetryResponse> {
        if (!deps.extractionService) {
          throw new FridayDomainError(
            FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
            "Memory extraction service is not configured",
            { httpStatus: 501 },
          );
        }
        validateRetryBody(ctx.body);
        const body = (ctx.body ?? {}) as { sessionKey?: string };
        const result = await deps.extractionService.retryFailedExtractions(body.sessionKey);
        return { result };
      },
    },
  ];
}
