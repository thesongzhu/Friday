import { createHash } from "node:crypto";

import { FridayDomainError } from "#errors";
import {
  FRIDAY_SESSION_DEFAULT_ACCOUNT_ID,
  FRIDAY_SESSION_ERROR_CODES,
  FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES,
} from "#sessions";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import {
  FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT,
} from "#sessions";
import type {
  FridaySessionArchiveResponse,
  FridaySessionCompactRequest,
  FridaySessionCompactResponse,
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
  FridaySessionOutboundRequest,
  FridaySessionOutboundResponse,
  FridaySessionPruneRequest,
  FridaySessionPruneResponse,
  FridaySessionRunRequest,
  FridaySessionRunResponse,
  FridaySessionSweepResponse,
} from "../../model/friday-api-session.types.js";
import type { FridaySessionService } from "#sessions";
import type { FridaySessionChatKind, FridaySessionMessageRecord, FridaySessionStatus } from "#sessions";
import type { FridaySessionMemoryExtractionService } from "#sessions";
import { isFridaySessionSendAllowed } from "#sessions";
import type { FridayProviderTenantContext } from "#providers";
import type { FridayChannelRegistry } from "#channels";
import type { FridayAgentRunConstraints } from "../../../agent/model/friday-agent.types.js";
import type { FridayAuthPrincipal } from "../../model/friday-api-auth.types.js";
import {
  assertBoundPrincipalAuthorityForOperation,
  isUnauthenticatedPublicPrincipal,
} from "../../../security/friday-owner-session-channel-capability.js";
import { buildPublicV1AgentRunIsolation } from "./friday-public-v1-agent-isolation.js";

// ─── Dependencies ───

export interface FridaySessionRoutesDeps {
  sessionService: FridaySessionService;
  extractionService?: FridaySessionMemoryExtractionService;
  channelRegistry?: FridayChannelRegistry;
  nowIso?: () => string;
  routeSessionsViaRust?: boolean;
  rustSessionLifecycleBridge?: FridayRustSessionLifecycleBridge;
  runSession?: (input: {
    sessionKey: string;
    task: string;
    providerId?: string;
    model?: string;
    replyToMessageId?: string;
    timezone?: string;
    timeoutMs?: number;
    principalId?: string;
    scopes?: string[];
    constraints?: FridayAgentRunConstraints;
    disabledToolNames?: string[];
    tenantContext?: FridayProviderTenantContext;
    persistTaskMessage?: boolean;
    taskAlreadyInHistory?: boolean;
  }) => Promise<FridaySessionRunResponse["run"]>;
  /**
   * Test-oracle only: allow the legacy TypeScript session lifecycle/message
   * mutations (create/messages.create/archive/reset/delete/prune/sweep/compact,
   * fork create/merge) in isolated mock/unit/e2e validation. Production/runtime
   * callers must leave this unset so session execution stays fail-closed until
   * Rust owns the session lifecycle entrypoint.
   */
  allowTestOnlySessionExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript session agent-run execution
   * (POST /v1/sessions/:sessionKey/run) in isolated mock/unit/e2e validation.
   * Production/runtime callers must leave this unset so session agent-run
   * execution stays fail-closed until Rust owns the session run entrypoint.
   */
  allowTestOnlySessionRunExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript session memory extraction
   * mutations (memory/extract, memory/remember, memory/extraction/retry) in
   * isolated mock/unit/e2e validation. Production/runtime callers must leave
   * this unset so session memory extraction stays fail-closed until Rust owns
   * the session memory extraction entrypoint.
   */
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
}

export interface FridayRustSessionLifecycleBridge {
  createSession(input: {
    channel: string;
    chatId: string;
    userId?: string;
    accountId?: string;
    chatKind?: FridaySessionChatKind;
    metadata?: Record<string, unknown>;
    principal: FridayAuthPrincipal;
  }): Promise<FridaySessionCreateResponse>;
  appendMessage(input: {
    sessionKey: string;
    role: FridaySessionMessageRecord["role"];
    content: unknown;
    contentText?: string;
    toolCalls?: unknown[];
    tokenCount?: number;
    idempotencyKey?: string;
    parentMessageId?: string;
    metadata?: Record<string, unknown>;
    timestamp?: string;
    principal: FridayAuthPrincipal;
  }): Promise<FridaySessionMessageCreateResponse>;
  getMemoryNamespace(input: {
    sessionKey: string;
    principal: FridayAuthPrincipal;
  }): Promise<FridaySessionMemoryNamespaceResponse>;
  /**
   * (CORE-RUNNABLE-001 / CORE-A CR-3) Execute a session-scoped agent RUN on the Rust-owned loop and
   * return the run result. OPTIONAL so a bridge that only implements the storage lifecycle ops
   * still satisfies the interface (an absent `runSession` ⇒ `sessions.run` stays fail-closed 503,
   * exactly as when the Rust route is off). The production adapter
   * ({@link createFridayRustHubSessionLifecycleDispatchAdapter}) implements this REALLY over the
   * sealed-WS agent-run transport + the owner-gated answer readback.
   */
  runSession?(input: {
    sessionKey: string;
    task: string;
    principalId: string;
    providerId?: string;
    model?: string;
    timezone?: string;
    timeoutMs?: number;
  }): Promise<FridaySessionRunResponse["run"]>;
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

function buildTenantContext(principal: unknown): FridayProviderTenantContext | undefined {
  if (!principal || typeof principal !== "object") {
    return undefined;
  }
  const record = principal as {
    userId?: unknown;
    principalId?: unknown;
    tenantId?: unknown;
  };
  const userId = typeof record.userId === "string" && record.userId.trim().length > 0
    ? record.userId.trim()
    : typeof record.principalId === "string" && record.principalId.trim().length > 0
      ? record.principalId.trim()
      : undefined;
  if (!userId) {
    return undefined;
  }
  const tenantId = typeof record.tenantId === "string" && record.tenantId.trim().length > 0
    ? record.tenantId.trim()
    : userId;
  return {
    hubId: tenantId,
    userId,
  };
}

export function assertSessionReadPrincipal(
  principal: FridayAuthPrincipal | null | undefined,
  operation: string,
): FridayAuthPrincipal {
  if (isUnauthenticatedPublicPrincipal(principal)) {
    throw new FridayDomainError(
      "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      `${operation} reads sensitive session data and requires a bound owner/session/channel principal.`,
      { httpStatus: 401 },
    );
  }
  const bound = principal as FridayAuthPrincipal;
  const hasReadAuthority =
    bound.scopes.includes("session.read") ||
    bound.role === "owner" ||
    bound.role === "admin" ||
    bound.role === "operator";
  if (!hasReadAuthority) {
    throw new FridayDomainError(
      "OWNER_SESSION_CHANNEL_PRINCIPAL_AUTHORITY_REQUIRED",
      `${operation} requires session.read authority.`,
      { httpStatus: 403 },
    );
  }
  return bound;
}

export function sessionReadScopeForPrincipal(principal: FridayAuthPrincipal): { accountId: string; userId?: string } {
  const tenantContext = buildTenantContext(principal);
  if (!tenantContext?.hubId) {
    throw new FridayDomainError(
      "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      "session read requires a bound tenant/user principal.",
      { httpStatus: 401 },
    );
  }
  return {
    accountId: tenantContext.hubId,
    ...(tenantContext.userId ? { userId: tenantContext.userId } : {}),
  };
}

function assertSessionReadableByPrincipal(
  session: { accountId?: string; userId?: string } | null | undefined,
  principal: FridayAuthPrincipal,
  operation: string,
): void {
  if (!session) {
    return;
  }
  const scope = sessionReadScopeForPrincipal(principal);
  const sessionAccountId = typeof session.accountId === "string" ? session.accountId.trim() : "";
  const sessionUserId = typeof session.userId === "string" ? session.userId.trim() : "";
  const isPrivilegedOperatorRead = principal.role === "admin" || principal.role === "operator";
  const isLegacyUnownedDefaultSession =
    sessionAccountId === FRIDAY_SESSION_DEFAULT_ACCOUNT_ID && sessionUserId.length === 0;
  if (isPrivilegedOperatorRead && isLegacyUnownedDefaultSession) {
    return;
  }
  const accountMatches = sessionAccountId.length > 0 && sessionAccountId === scope.accountId;
  const userMatches = !scope.userId || (sessionUserId.length > 0 && sessionUserId === scope.userId);
  if (!accountMatches || !userMatches) {
    throw new FridayDomainError(
      "SESSION_OWNER_MISMATCH",
      `${operation} refuses to read a session outside the bound principal scope.`,
      { httpStatus: 404 },
    );
  }
}

async function assertExistingSessionReadable(
  sessionService: FridaySessionService,
  key: string,
  principal: FridayAuthPrincipal,
  operation: string,
): Promise<FridaySessionGetResponse["session"]> {
  const session = await sessionService.getSession(key);
  if (!session) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      `Session '${key}' not found`,
      { httpStatus: 404 },
    );
  }
  assertSessionReadableByPrincipal(session, principal, operation);
  return session;
}

export async function assertSessionReadableIfPresent(
  sessionService: FridaySessionService,
  key: string,
  principal: FridayAuthPrincipal,
  operation: string,
): Promise<void> {
  const session = await sessionService.getSession(key);
  assertSessionReadableByPrincipal(session, principal, operation);
}

async function alignSessionWithPrincipalContext(
  sessionService: FridaySessionService,
  sessionKey: string,
  principal: unknown,
): Promise<void> {
  const tenantContext = buildTenantContext(principal);
  if (!tenantContext) {
    return;
  }
  const existingSession = await sessionService.getSession(sessionKey).catch(() => null);
  const normalizedExistingAccountId =
    typeof existingSession?.accountId === "string" && existingSession.accountId.trim().length > 0
      ? existingSession.accountId.trim()
      : undefined;
  const normalizedExistingUserId =
    typeof existingSession?.userId === "string" && existingSession.userId.trim().length > 0
      ? existingSession.userId.trim()
      : undefined;

  const nextAccountId =
    !normalizedExistingAccountId || normalizedExistingAccountId === FRIDAY_SESSION_DEFAULT_ACCOUNT_ID
      ? tenantContext.hubId
      : undefined;
  const nextUserId = normalizedExistingUserId ? undefined : tenantContext.userId;

  if (!nextAccountId && !nextUserId) {
    return;
  }

  await sessionService.alignSessionContext(sessionKey, {
    ...(nextAccountId ? { accountId: nextAccountId } : {}),
    ...(nextUserId ? { userId: nextUserId } : {}),
  });
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

function validateOutboundBody(body: unknown): asserts body is FridaySessionOutboundRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      "Request body is required",
      { httpStatus: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.text !== "string" || b.text.trim().length === 0) {
    errors.push("text is required and must be a non-empty string");
  }

  if (b.images !== undefined) {
    if (!Array.isArray(b.images)) {
      errors.push("images must be an array of strings when provided");
    } else if (b.images.some((image) => typeof image !== "string" || image.trim().length === 0)) {
      errors.push("images must contain only non-empty strings");
    }
  }

  if (b.replyToMessageId !== undefined && (typeof b.replyToMessageId !== "string" || b.replyToMessageId.trim() === "")) {
    errors.push("replyToMessageId must be a non-empty string when provided");
  }

  if (b.metadata !== undefined) {
    sanitizeMetadata(b.metadata);
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      `Invalid outbound body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function toChannelSendChatType(chatKind: FridaySessionChatKind): "direct" | "group" | undefined {
  if (chatKind === "dm") return "direct";
  if (chatKind === "group" || chatKind === "channel" || chatKind === "thread") return "group";
  return undefined;
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
  if (b.useLastUserMessage !== undefined && typeof b.useLastUserMessage !== "boolean") {
    errors.push("useLastUserMessage must be a boolean when provided");
  }
  if (b.providerId !== undefined && (typeof b.providerId !== "string" || b.providerId.trim() === "")) {
    errors.push("providerId must be a non-empty string when provided");
  }
  if (b.model !== undefined && (typeof b.model !== "string" || b.model.trim() === "")) {
    errors.push("model must be a non-empty string when provided");
  }
  if (b.replyToMessageId !== undefined && (typeof b.replyToMessageId !== "string" || b.replyToMessageId.trim() === "")) {
    errors.push("replyToMessageId must be a non-empty string when provided");
  }
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== "string" || b.timezone.trim() === "") {
      errors.push("timezone must be a non-empty IANA timezone string when provided");
    } else {
      try {
        Intl.DateTimeFormat("en-US", { timeZone: b.timezone.trim() }).format(new Date());
      } catch (err) {
        console.warn("[friday][session-routes] operation failed:", err instanceof Error ? err.message : String(err));
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

function validateCompactBody(body: unknown): asserts body is FridaySessionCompactRequest {
  if (body == null || typeof body !== "object") {
    return;
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of ["keepRecent", "maxMessages"] as const) {
    if (
      b[field] !== undefined &&
      (typeof b[field] !== "number" || !Number.isInteger(b[field]) || b[field] < 1)
    ) {
      errors.push(`${field} must be a positive integer when provided`);
    }
  }
  if (b.summary !== undefined && (typeof b.summary !== "string" || b.summary.trim() === "")) {
    errors.push("summary must be a non-empty string when provided");
  }
  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      `Invalid compact body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
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

function buildDeterministicSessionSummary(messages: FridaySessionMessageRecord[]): string {
  const lines = messages
    .map((message) => `${message.role}: ${message.contentText.trim()}`)
    .filter((line) => line.trim().length > 0);
  const joined = lines.join("\n");
  return joined.length <= 2_000
    ? joined
    : `${joined.slice(0, 1_997)}...`;
}

function fingerprintSessionSummary(summary: string): string {
  return createHash("sha256").update(summary).digest("hex").slice(0, 16);
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
  } catch (err) {
        console.warn("[friday][session-routes] operation failed:", err instanceof Error ? err.message : String(err));
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

// ─── Retirement helpers ───
//
// The session mutation surfaces (create/messages.create/archive/reset/delete/
// prune/sweep/compact, fork create/merge, the session agent-run, and the memory
// extraction mutations) run TypeScript product logic or write session/memory
// state. They fail-close by default/live until Rust owns the corresponding
// session lifecycle / agent-run / memory-extraction entrypoints; legacy
// behavior is reachable only through the explicit per-engine test-oracle flags
// above. The outbound channel send (sessions.outbound.send) is a separate
// operator_external_adapter (genuine external channel egress) and is NOT
// guarded here.

function throwRetiredSession(
  code: string,
  label: string,
  replacement: string,
): never {
  throw new FridayDomainError(
    code,
    `${label} is fail-closed in default/live runtime; use the Rust-owned ${replacement} entrypoint.`,
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: `rust_owned_${replacement}_entrypoint_required`,
      },
    },
  );
}

function assertSessionTestOracleAllowed(deps: FridaySessionRoutesDeps): void {
  if (deps.allowTestOnlySessionExecution !== true) {
    throwRetiredSession(
      "TS_RUNTIME_SESSION_RETIRED",
      "TypeScript session execution",
      "session_lifecycle",
    );
  }
}

function rustSessionLifecycleBridgeOrRetired(
  deps: FridaySessionRoutesDeps,
): FridayRustSessionLifecycleBridge {
  if (deps.routeSessionsViaRust === true && deps.rustSessionLifecycleBridge) {
    return deps.rustSessionLifecycleBridge;
  }
  throwRetiredSession(
    "TS_RUNTIME_SESSION_RETIRED",
    "TypeScript session execution",
    "session_lifecycle",
  );
}

function assertSessionWritePrincipal(
  principal: FridayAuthPrincipal | null | undefined,
  operation: Parameters<typeof assertBoundPrincipalAuthorityForOperation>[1],
): FridayAuthPrincipal {
  assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin", "session.write"],
    anyOfRoles: ["owner", "admin", "operator"],
  });
  return principal as FridayAuthPrincipal;
}

function assertSessionRunTestOracleAllowed(deps: FridaySessionRoutesDeps): void {
  if (deps.allowTestOnlySessionRunExecution !== true) {
    throwRetiredSession(
      "TS_RUNTIME_SESSION_RUN_RETIRED",
      "TypeScript session agent-run execution",
      "session_run",
    );
  }
}

function assertSessionMemoryExtractionTestOracleAllowed(deps: FridaySessionRoutesDeps): void {
  if (deps.allowTestOnlySessionMemoryExtractionExecution !== true) {
    throwRetiredSession(
      "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
      "TypeScript session memory extraction",
      "session_memory_extraction",
    );
  }
}

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
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionListResponse> {
        const query = ctx.query as Record<string, string | undefined>;
        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.list");
        const principalScope = sessionReadScopeForPrincipal(principal);

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
          accountId: principalScope.accountId,
          userId: principalScope.userId,
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
      auth: { public: true },
      rateLimitPolicyId: "session.write",
      async handler(ctx): Promise<FridaySessionCreateResponse> {
        validateCreateSessionBody(ctx.body);
        const body = ctx.body;
        const metadata = sanitizeMetadata(body.metadata);
        if (deps.routeSessionsViaRust === true) {
          const principal = assertSessionWritePrincipal(ctx.principal ?? null, "sessions.create");
          return rustSessionLifecycleBridgeOrRetired(deps).createSession({
            channel: body.channel,
            chatId: body.chatId,
            userId: body.userId,
            accountId: body.accountId,
            chatKind: body.chatKind,
            metadata,
            principal,
          });
        }
        assertSessionTestOracleAllowed(deps);
        let session = await deps.sessionService.createSession({
          channel: body.channel,
          chatId: body.chatId,
          userId: body.userId,
          accountId: body.accountId,
          chatKind: body.chatKind,
          metadata,
        });
        await alignSessionWithPrincipalContext(deps.sessionService, session.key, ctx.principal).catch(() => undefined);
        session = await deps.sessionService.getSession(session.key).catch(() => session) ?? session;
        return { session };
      },
    },

    // 3. GET /v1/sessions/:sessionKey — get session
    {
      operationId: "sessions.get",
      method: "GET",
      path: "/v1/sessions/:sessionKey",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionGetResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.get");
        const session = await assertExistingSessionReadable(deps.sessionService, key, principal, "sessions.get");
        return { session };
      },
    },

    // 3b. DELETE /v1/sessions/:sessionKey — delete (archive) session
    {
      operationId: "sessions.delete",
      method: "DELETE",
      path: "/v1/sessions/:sessionKey",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionArchiveResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        assertSessionTestOracleAllowed(deps);
        const session = await deps.sessionService.archiveSession(key);
        return { session };
      },
    },

    // 4. POST /v1/sessions/:sessionKey/archive — archive session
    {
      operationId: "sessions.archive",
      method: "POST",
      path: "/v1/sessions/:sessionKey/archive",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionArchiveResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        assertSessionTestOracleAllowed(deps);
        const session = await deps.sessionService.archiveSession(key);
        return { session };
      },
    },

    // 4b. POST /v1/sessions/:sessionKey/reset — reset session
    {
      operationId: "sessions.reset",
      method: "POST",
      path: "/v1/sessions/:sessionKey/reset",
      auth: { public: true },
      async handler(ctx) {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        assertSessionTestOracleAllowed(deps);
        const session = await deps.sessionService.resetSession(key);
        return { session };
      },
    },

    // 5. POST /v1/sessions/prune — prune old sessions
    {
      operationId: "sessions.prune",
      method: "POST",
      path: "/v1/sessions/prune",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionPruneResponse> {
        validatePruneBody(ctx.body);
        const body = ctx.body;
        assertSessionTestOracleAllowed(deps);
        const result = await deps.sessionService.pruneOldSessions(body.olderThan);
        return { result };
      },
    },

    // 6. POST /v1/sessions/sweep — lifecycle sweep
    {
      operationId: "sessions.sweep",
      method: "POST",
      path: "/v1/sessions/sweep",
      auth: { public: true },
      async handler(): Promise<FridaySessionSweepResponse> {
        assertSessionTestOracleAllowed(deps);
        const result = await deps.sessionService.sweepLifecycle();
        return { result };
      },
    },

    // 6b. POST /v1/sessions/:sessionKey/compact — persist a compacted focus summary
    {
      operationId: "sessions.compact",
      method: "POST",
      path: "/v1/sessions/:sessionKey/compact",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionCompactResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateCompactBody(ctx.body);
        const body = (ctx.body ?? {}) as FridaySessionCompactRequest;
        const keepRecent = Math.min(body.keepRecent ?? 8, FRIDAY_MAX_LIST_LIMIT);
        const maxMessages = Math.min(body.maxMessages ?? FRIDAY_MAX_LIST_LIMIT, FRIDAY_MAX_LIST_LIMIT);
        assertSessionTestOracleAllowed(deps);
        const messages = await deps.sessionService.getMessages(key, maxMessages);
        const compactableCount = Math.max(0, messages.length - keepRecent);
        const compactableMessages = messages.slice(0, compactableCount);
        const summary = body.summary?.trim() || buildDeterministicSessionSummary(compactableMessages);
        const now = deps.nowIso ? deps.nowIso() : new Date().toISOString();
        const focus = await deps.sessionService.getConversationFocus(key).catch(() => null);
        const first = compactableMessages[0];
        const last = compactableMessages[compactableMessages.length - 1];
        await deps.sessionService.setConversationFocus(key, {
          ...(focus ?? { updatedAt: now }),
          currentTopicSummary: summary,
          currentTopicFingerprint: fingerprintSessionSummary(summary),
          currentTopicStartSequence: messages[Math.max(0, compactableCount)]?.sequence ?? (last ? last.sequence + 1 : undefined),
          updatedAt: now,
        });
        await deps.sessionService.mergeMetadata(key, {
          lastCompaction: {
            compactedAt: now,
            compactedMessageCount: compactableMessages.length,
            keptRecentMessageCount: Math.min(keepRecent, messages.length),
            sequenceStart: first?.sequence,
            sequenceEnd: last?.sequence,
          },
        });

        return {
          compaction: {
            sessionKey: key,
            compactedMessageCount: compactableMessages.length,
            keptRecentMessageCount: Math.min(keepRecent, messages.length),
            summary,
            sequenceStart: first?.sequence,
            sequenceEnd: last?.sequence,
            focusUpdatedAt: now,
          },
        };
      },
    },

    // 7. GET /v1/sessions/:sessionKey/messages — list messages
    {
      operationId: "sessions.messages.list",
      method: "GET",
      path: "/v1/sessions/:sessionKey/messages",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionMessageListResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const query = ctx.query as Record<string, string | undefined>;
        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.messages.list");

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

        await assertSessionReadableIfPresent(deps.sessionService, key, principal, "sessions.messages.list");
        const items = await deps.sessionService.getMessages(key, limit, query.before);
        return { items };
      },
    },

    // 7b. GET /v1/sessions/:sessionKey/export — export session transcript
    {
      operationId: "sessions.export",
      method: "GET",
      path: "/v1/sessions/:sessionKey/export",
      auth: { public: true },
      async handler(ctx): Promise<{ content: string; format: string }> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const query = ctx.query as Record<string, string | undefined>;
        const format = query.format === "markdown" ? "markdown" : "json";
        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.export");
        await assertSessionReadableIfPresent(deps.sessionService, key, principal, "sessions.export");
        const messages = await deps.sessionService.getMessages(key, FRIDAY_MAX_LIST_LIMIT);
        if (format === "markdown") {
          const lines = [`# Friday Session: ${key}\n`];
          for (const msg of messages) {
            const obj = msg as unknown as Record<string, unknown>;
            const role = typeof obj.role === "string" ? obj.role : "unknown";
            const msgContent = typeof obj.content === "string" ? obj.content : "";
            const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";
            lines.push(`## ${role} (${createdAt})\n`);
            lines.push(`${msgContent}\n`);
          }
          return { content: lines.join("\n"), format: "markdown" };
        }
        return { content: JSON.stringify({ sessionKey: key, messages }, null, 2), format: "json" };
      },
    },

    // 8. POST /v1/sessions/:sessionKey/messages — create message
    {
      operationId: "sessions.messages.create",
      method: "POST",
      path: "/v1/sessions/:sessionKey/messages",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionMessageCreateResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateCreateMessageBody(ctx.body);
        const body = ctx.body;
        if (deps.routeSessionsViaRust === true) {
          const principal = assertSessionWritePrincipal(ctx.principal ?? null, "sessions.messages.create");
          return rustSessionLifecycleBridgeOrRetired(deps).appendMessage({
            sessionKey: key,
            role: body.role,
            content: body.content,
            contentText: body.contentText,
            toolCalls: body.toolCalls,
            tokenCount: body.tokenCount,
            idempotencyKey: body.idempotencyKey,
            parentMessageId: body.parentMessageId,
            metadata: sanitizeMetadata(body.metadata),
            timestamp: body.timestamp,
            principal,
          });
        }
        assertSessionTestOracleAllowed(deps);
        await deps.sessionService.getOrCreateSession(key).catch(() => undefined);
        await alignSessionWithPrincipalContext(deps.sessionService, key, ctx.principal).catch(() => undefined);
        const message = await deps.sessionService.addMessage(key, body);
        return {
          message,
          hint: "This endpoint stores the message only. To trigger an AI response, use POST /v1/sessions/:sessionKey/run with a { \"task\": \"...\" } body.",
        };
      },
    },

    // 8b. POST /v1/sessions/:sessionKey/outbound — deterministic channel outbound send
    {
      operationId: "sessions.outbound.send",
      method: "POST",
      path: "/v1/sessions/:sessionKey/outbound",
      auth: { public: true },
      rateLimitPolicyId: "session.write",
      async handler(ctx): Promise<FridaySessionOutboundResponse> {
        if (!deps.channelRegistry) {
          throw new FridayDomainError(
            "CHANNEL_OUTBOUND_UNAVAILABLE",
            "Channel outbound delivery is not configured",
            { httpStatus: 501 },
          );
        }

        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateOutboundBody(ctx.body);
        const body = ctx.body;

        const session = await deps.sessionService.getSession(key);
        if (!session) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
            `Session '${key}' not found`,
            { httpStatus: 404 },
          );
        }

        const sendPolicy = await deps.sessionService.evaluateSendPolicy(key);
        if (!isFridaySessionSendAllowed(sendPolicy)) {
          throw new FridayDomainError(
            "CHANNEL_OUTBOUND_BLOCKED",
            `Outbound sends are blocked for session '${key}' by policy '${sendPolicy}'`,
            { httpStatus: 403 },
          );
        }

        const text = body.text.trim();
        const delivery = await deps.channelRegistry.send(session.channel, {
          chatId: session.chatId,
          text,
          images: body.images?.map((image) => image.trim()),
          replyTo: body.replyToMessageId?.trim(),
          chatType: toChannelSendChatType(session.chatKind),
        });
        const metadata = sanitizeMetadata(body.metadata) ?? {};
        const sentAt = deps.nowIso ? deps.nowIso() : new Date().toISOString();
        const message = await deps.sessionService.addMessage(key, {
          role: "assistant",
          content: text,
          contentText: text,
          metadata: {
            ...metadata,
            source: "channel_outbound",
            deliveryStatus: "sent",
            sentAt,
            channelKind: session.channel,
            channelChatId: session.chatId,
            channelMessageId: delivery.messageId,
          },
          idempotencyKey: `channel-outbound:${session.channel}:${delivery.messageId}`,
        });

        return {
          delivery: {
            channel: session.channel,
            chatId: session.chatId,
            messageId: delivery.messageId,
          },
          message,
        };
      },
    },

    // 8c. POST /v1/sessions/:sessionKey/run — run agent against session context (legacy compatibility)
    {
      operationId: "sessions.run",
      method: "POST",
      path: "/v1/sessions/:sessionKey/run",
      auth: { public: true },
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
        const useLastUserMessage = body.useLastUserMessage === true;
        const publicIsolation = buildPublicV1AgentRunIsolation(ctx.principal);
        let task = taskFromBody;
        if (!task && useLastUserMessage && !publicIsolation) {
          const history = await deps.sessionService.getMessages(key, 200);
          const lastUserMessage = [...history]
            .reverse()
            .find((msg) => msg.role === "user" && msg.contentText.trim().length > 0);
          task = lastUserMessage?.contentText.trim();
        }

        if (!task) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
            publicIsolation
              ? "task is required for public session runs; public isolation does not reuse session history"
              : useLastUserMessage
              ? "useLastUserMessage was true, but no user message was found in session history"
              : "task is required unless useLastUserMessage is explicitly true",
            { httpStatus: 400 },
          );
        }

        // (CORE-RUNNABLE-001 / CORE-A CR-3) Rust-owned session-run branch — mirrors the session
        // lifecycle branches (create/messages.create). DEFAULT-OFF: only when `routeSessionsViaRust`
        // is on AND a real bridge is wired does the run dispatch to the Rust-owned loop instead of
        // fail-closing. An absent `runSession` on the bridge fails closed the same as a retired run,
        // so a lifecycle-only bridge never silently no-ops. Placed BEFORE the TS-path oracle guard so
        // flag-OFF is byte-identical (falls through to `assertSessionRunTestOracleAllowed` → 503).
        if (deps.routeSessionsViaRust === true) {
          const bridge = rustSessionLifecycleBridgeOrRetired(deps);
          if (!bridge.runSession) {
            throwRetiredSession(
              "TS_RUNTIME_SESSION_RUN_RETIRED",
              "TypeScript session agent-run execution",
              "session_run",
            );
          }
          const principal = assertSessionWritePrincipal(ctx.principal ?? null, "sessions.run");
          const run = await bridge.runSession({
            sessionKey: key,
            task,
            principalId: principal.principalId,
            ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.timezone?.trim() ? { timezone: body.timezone.trim() } : {}),
            ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
          });
          return {
            run,
            messages: [
              { role: "user" as const, content: task },
              { role: "assistant" as const, content: run.response },
            ],
          };
        }

        assertSessionRunTestOracleAllowed(deps);

        const existingSession = publicIsolation
          ? null
          : await deps.sessionService.getOrCreateSession(key).catch(() => null);
        const principalTenantContext = ctx.principal && !publicIsolation
          ? buildTenantContext(ctx.principal)
          : undefined;
        const tenantContext: FridayProviderTenantContext | undefined = existingSession
          && !publicIsolation
          ? (() => {
            const existingHubId = existingSession.accountId?.trim();
            const hubId = existingHubId && existingHubId !== FRIDAY_SESSION_DEFAULT_ACCOUNT_ID
              ? existingHubId
              : principalTenantContext?.hubId?.trim() || existingHubId;
            if (!hubId) {
              return undefined;
            }
            const userId = existingSession.userId?.trim() || principalTenantContext?.userId?.trim();
            return {
              hubId,
              ...(userId ? { userId } : {}),
            };
          })()
          : principalTenantContext;

        const run = await deps.runSession({
          sessionKey: key,
          task,
          providerId: body.providerId,
          model: body.model,
          replyToMessageId: body.replyToMessageId,
          timezone: body.timezone?.trim(),
          timeoutMs: body.timeoutMs,
          ...(publicIsolation
            ? {
              constraints: publicIsolation.constraints,
              disabledToolNames: publicIsolation.disabledToolNames,
            }
            : {}),
          persistTaskMessage: Boolean(taskFromBody),
          taskAlreadyInHistory: !taskFromBody,
          ...(ctx.principal && !publicIsolation
            ? {
              principalId: ctx.principal.principalId,
              scopes: ctx.principal.scopes,
              tenantContext,
            }
            : {}),
        });

        const messages = publicIsolation
          ? [
            { role: "user" as const, contentText: task },
            { role: "assistant" as const, contentText: run.response },
          ]
          : await deps.sessionService.getMessages(key, 200);
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
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionMemoryNamespaceResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.memory.namespace.get");
        if (deps.routeSessionsViaRust === true) {
          return rustSessionLifecycleBridgeOrRetired(deps).getMemoryNamespace({
            sessionKey: key,
            principal,
          });
        }
        await assertSessionReadableIfPresent(deps.sessionService, key, principal, "sessions.memory.namespace.get");
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
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionForkResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateForkBody(ctx.body);
        const body = (ctx.body ?? {}) as FridaySessionForkRequest;
        const metadata = sanitizeMetadata(body.metadata);
        assertSessionTestOracleAllowed(deps);
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
      auth: { public: true },
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

        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.forks.list");
        await assertSessionReadableIfPresent(deps.sessionService, key, principal, "sessions.forks.list");
        const items = await deps.sessionService.listForks(key, { status, limit });
        return { items };
      },
    },

    // 12. POST /v1/sessions/:sessionKey/merge — merge fork summary
    {
      operationId: "sessions.forks.merge",
      method: "POST",
      path: "/v1/sessions/:sessionKey/merge",
      auth: { public: true },
      async handler(ctx): Promise<FridaySessionMergeResponse> {
        const { sessionKey } = ctx.params as { sessionKey: string };
        const key = decodeSessionKeyParam(sessionKey);
        validateMergeBody(ctx.body);
        const body = ctx.body;
        const metadata = sanitizeMetadata(body.metadata);
        assertSessionTestOracleAllowed(deps);
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
      auth: { public: true },
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
        assertSessionMemoryExtractionTestOracleAllowed(deps);
        await alignSessionWithPrincipalContext(deps.sessionService, key, ctx.principal).catch(() => undefined);
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
      auth: { public: true },
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
        assertSessionMemoryExtractionTestOracleAllowed(deps);
        await alignSessionWithPrincipalContext(deps.sessionService, key, ctx.principal).catch(() => undefined);
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
      auth: { public: true },
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
        const principal = assertSessionReadPrincipal(ctx.principal ?? null, "sessions.memory.extraction.get");
        await assertSessionReadableIfPresent(deps.sessionService, key, principal, "sessions.memory.extraction.get");
        const status = await deps.extractionService.getExtractionStatus(key);
        return { status };
      },
    },

    // 16. POST /v1/sessions/memory/extraction/retry — retry failed extractions
    {
      operationId: "sessions.memory.extraction.retry",
      method: "POST",
      path: "/v1/sessions/memory/extraction/retry",
      auth: { public: true },
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
        assertSessionMemoryExtractionTestOracleAllowed(deps);
        const result = await deps.extractionService.retryFailedExtractions(body.sessionKey);
        return { result };
      },
    },
  ];
}
