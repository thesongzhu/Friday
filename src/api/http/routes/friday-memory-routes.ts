import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayDeleteMemoryItemResponse,
  FridayGetMemoryItemResponse,
  FridayListMemoryItemsResponse,
  FridayMemoryPruneRequest,
  FridayMemoryPruneResponse,
  FridayMemorySearchRequest,
  FridayMemorySearchResponse,
  FridayMemoryStoreRequest,
  FridayMemoryStoreResponse,
} from "../../model/friday-api-memory.types.js";
import type { FridayMemoryGuardServiceFactory, FridayMemoryItem, FridayMemoryType } from "#memory";
import type { FridayLearnedFactView } from "../../../learning/services/friday-learned-fact-memory-view.js";
import {
  FRIDAY_LEARNED_FACT_SOURCE,
  isLearnedFactSyntheticId,
  matchesLearnedFactQuery,
  readLearnedFactKeyFromSyntheticId,
  toLearnedFactMemoryItem,
  toLearnedFactSearchResult,
} from "../../../learning/services/friday-learned-fact-memory-view.js";
import { isFridayReflexConfirmationRequiredKey } from "../../../reflex/services/friday-reflex-preference-sensitivity.js";
import { FridayDomainError } from "#errors";
import { createFridayMemoryOutputFilter, FRIDAY_MEMORY_ERROR_CODES, FRIDAY_MEMORY_MAX_LIMIT } from "#memory";
import {
  hashIdempotencyPayload,
  readIdempotencyKeyHeader,
  readStoredIdempotencyPayloadHash,
  throwIdempotencyConflict,
} from "./friday-route-idempotency.js";

// ─── Dependencies ───

export interface FridayMemoryRoutesDeps {
  memoryGuardFactory: FridayMemoryGuardServiceFactory;
  listLearnedFacts?: (input: { userId: string; limit: number }) => FridayLearnedFactView[];
  deleteLearnedFact?: (input: { userId: string; key: string }) => boolean;
  findStoreReplay?: (input: { principalId: string; idempotencyKey: string }) => FridayMemoryItem | null;
}

// ─── Validation helpers ───

const FRIDAY_MEMORY_TYPES: readonly FridayMemoryType[] = [
  "fact",
  "preference",
  "procedure",
  "episode",
  "correction",
];

function isFridayMemoryType(value: unknown): value is FridayMemoryType {
  return typeof value === "string" && FRIDAY_MEMORY_TYPES.includes(value as FridayMemoryType);
}

function isFridayMemoryTypeOrArray(value: unknown): value is FridayMemoryType | FridayMemoryType[] {
  return isFridayMemoryType(value)
    || (Array.isArray(value) && value.length > 0 && value.every(isFridayMemoryType));
}

function validateStoreBody(body: unknown): asserts body is FridayMemoryStoreRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.namespace !== "string" || !b.namespace) {
    errors.push("namespace is required and must be a non-empty string");
  }
  if (typeof b.content !== "string" || !b.content) {
    errors.push("content is required and must be a non-empty string");
  }
  if (b.memoryType !== undefined && !isFridayMemoryType(b.memoryType)) {
    errors.push(`memoryType must be one of: ${FRIDAY_MEMORY_TYPES.join(", ")}`);
  }
  if (b.confidence !== undefined) {
    if (typeof b.confidence !== "number" || !Number.isFinite(b.confidence) || b.confidence < 0 || b.confidence > 1) {
      errors.push("confidence must be a number between 0 and 1");
    }
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

function validateSearchBody(body: unknown): asserts body is FridayMemorySearchRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;

  if (typeof b.query !== "string" || !b.query.trim()) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_ERROR_CODES.SEARCH_EMPTY_QUERY,
      "query is required and must be a non-empty string",
      { httpStatus: 400 },
    );
  }

  // Validate numeric fields — reject non-integers (CX R2 fix)
  if (b.limit !== undefined) {
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1) {
      throw new FridayDomainError("VALIDATION_ERROR", "limit must be a positive integer", { httpStatus: 400 });
    }
    b.limit = Math.min(b.limit, 100);
  }

  if (b.minScore !== undefined) {
    const minScore = Number(b.minScore);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new FridayDomainError("VALIDATION_ERROR", "minScore must be a number between 0 and 1", { httpStatus: 400 });
    }
    b.minScore = minScore;
  }

  if (b.weights !== undefined) {
    if (b.weights == null || typeof b.weights !== "object") {
      throw new FridayDomainError("VALIDATION_ERROR", "weights must be an object with fts and semantic numbers", { httpStatus: 400 });
    }
    const w = b.weights as Record<string, unknown>;
    const fts = Number(w.fts);
    const semantic = Number(w.semantic);
    if (!Number.isFinite(fts) || !Number.isFinite(semantic) || fts < 0 || semantic < 0) {
      throw new FridayDomainError("VALIDATION_ERROR", "weights.fts and weights.semantic must be non-negative numbers", { httpStatus: 400 });
    }
    w.fts = fts;
    w.semantic = semantic;
  }

  if (b.memoryType !== undefined && !isFridayMemoryTypeOrArray(b.memoryType)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `memoryType must be one of: ${FRIDAY_MEMORY_TYPES.join(", ")} or a non-empty array of those values`,
      { httpStatus: 400 },
    );
  }

  if (b.boostByConfidence !== undefined && typeof b.boostByConfidence !== "boolean") {
    throw new FridayDomainError("VALIDATION_ERROR", "boostByConfidence must be a boolean", { httpStatus: 400 });
  }
  if (b.boostByAccess !== undefined && typeof b.boostByAccess !== "boolean") {
    throw new FridayDomainError("VALIDATION_ERROR", "boostByAccess must be a boolean", { httpStatus: 400 });
  }
  if (b.applyRetentionDecay !== undefined && typeof b.applyRetentionDecay !== "boolean") {
    throw new FridayDomainError("VALIDATION_ERROR", "applyRetentionDecay must be a boolean", { httpStatus: 400 });
  }
  if (b.retentionHalfLifeDays !== undefined) {
    const retentionHalfLifeDays = Number(b.retentionHalfLifeDays);
    if (!Number.isFinite(retentionHalfLifeDays) || retentionHalfLifeDays <= 0) {
      throw new FridayDomainError("VALIDATION_ERROR", "retentionHalfLifeDays must be a positive number", { httpStatus: 400 });
    }
    b.retentionHalfLifeDays = retentionHalfLifeDays;
  }
}

function validateStoreNumericFields(body: unknown): void {
  if (body == null || typeof body !== "object") return;
  const b = body as Record<string, unknown>;
  if (b.ttlSeconds !== undefined) {
    if (typeof b.ttlSeconds !== "number" || !Number.isInteger(b.ttlSeconds) || b.ttlSeconds < 1) {
      throw new FridayDomainError("VALIDATION_ERROR", "ttlSeconds must be a positive integer", { httpStatus: 400 });
    }
  }
}

function isStringOrStringArray(v: unknown): v is string | string[] {
  return typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
}

function readPrincipalUserId(principal: unknown): string {
  if (!principal || typeof principal !== "object") {
    throw new FridayDomainError("UNAUTHORIZED", "A user principal is required", { httpStatus: 401 });
  }
  const candidate = principal as { userId?: unknown; principalId?: unknown };
  const userId = typeof candidate.userId === "string" && candidate.userId.trim().length > 0
    ? candidate.userId.trim()
    : typeof candidate.principalId === "string" && candidate.principalId.trim().length > 0
      ? candidate.principalId.trim()
      : undefined;
  if (!userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user principal is required", { httpStatus: 401 });
  }
  return userId;
}

function learnedFactRevocationUnavailable(): never {
  throw new FridayDomainError(
    "MEMORY_LEARNED_FACT_REVOCATION_UNAVAILABLE",
    "Learned fact revocation is unavailable in this runtime",
    { httpStatus: 503 },
  );
}

function readStoreMetadata(body: FridayMemoryStoreRequest): Record<string, unknown> | undefined {
  return body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : undefined;
}

function readNestedRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStorePreferenceKeyCandidates(body: FridayMemoryStoreRequest): string[] {
  const metadata = readStoreMetadata(body);
  const preference = readNestedRecord(metadata, "preference");
  const reflex = readNestedRecord(metadata, "reflex");
  return [
    body.key,
    readStringValue(metadata, "key"),
    readStringValue(metadata, "preferenceKey"),
    readStringValue(metadata, "reflexPreferenceKey"),
    readStringValue(preference, "key"),
    readStringValue(reflex, "key"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function memoryStoreLooksLikePreferenceActivation(body: FridayMemoryStoreRequest): boolean {
  const metadata = readStoreMetadata(body);
  const preference = readNestedRecord(metadata, "preference");
  const reflex = readNestedRecord(metadata, "reflex");
  if (
    preference
    || reflex
    || readStringValue(metadata, "preferenceKey")
    || readStringValue(metadata, "reflexPreferenceKey")
  ) {
    return true;
  }
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const corpus = [
    body.namespace,
    body.source,
    body.memoryType,
    readStringValue(metadata, "category"),
    readStringValue(metadata, "preferenceCategory"),
    readStringValue(preference, "category"),
    readStringValue(reflex, "category"),
    ...tags,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  return /\b(reflex|preference|preferences|user_preference|explicit_preference)\b/.test(corpus);
}

function enforceMemoryStoreApprovalBoundary(body: FridayMemoryStoreRequest): void {
  const protectedKey = readStorePreferenceKeyCandidates(body)
    .find((key) => isFridayReflexConfirmationRequiredKey(key));
  if (!protectedKey) return;
  if (!memoryStoreLooksLikePreferenceActivation(body) && body.key !== protectedKey) return;
  throw new FridayDomainError(
    "MEMORY_REQUIRES_REVIEW_CENTER_CONFIRMATION",
    `High-impact preference '${protectedKey}' must be confirmed through /v1/reflex/preferences/${protectedKey} before durable activation.`,
    { httpStatus: 409 },
  );
}

function shouldIncludeLearnedFacts(input: {
  namespace?: string | string[];
  source?: string | string[];
  memoryType?: FridayMemoryType | FridayMemoryType[];
}): boolean {
  const namespaces = Array.isArray(input.namespace)
    ? input.namespace
    : input.namespace
      ? [input.namespace]
      : [];
  const sources = Array.isArray(input.source)
    ? input.source
    : input.source
      ? [input.source]
      : [];
  if (sources.length > 0 && !sources.includes(FRIDAY_LEARNED_FACT_SOURCE)) {
    return false;
  }
  const memoryTypes = Array.isArray(input.memoryType)
    ? input.memoryType
    : input.memoryType
      ? [input.memoryType]
      : [];
  if (memoryTypes.length > 0 && !memoryTypes.includes("preference")) {
    return false;
  }
  if (namespaces.length === 0) {
    return true;
  }
  return namespaces.some((value) => value === "preference" || value === "user" || value === "default");
}

function validatePruneBody(body: unknown): asserts body is FridayMemoryPruneRequest {
  if (body == null) return; // null/undefined body is valid (prune all in scope)
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body must be a plain object", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.namespace !== undefined && !isStringOrStringArray(b.namespace)) {
    errors.push("namespace must be a string or array of strings");
  }
  if (b.source !== undefined && !isStringOrStringArray(b.source)) {
    errors.push("source must be a string or array of strings");
  }
  if (b.tagsAny !== undefined && !(Array.isArray(b.tagsAny) && b.tagsAny.every((x) => typeof x === "string"))) {
    errors.push("tagsAny must be an array of strings");
  }
  if (b.expiredOnly !== undefined && typeof b.expiredOnly !== "boolean") {
    errors.push("expiredOnly must be a boolean");
  }
  if (b.olderThan !== undefined) {
    if (typeof b.olderThan !== "string") {
      errors.push("olderThan must be a string (ISO 8601 date)");
    } else {
      const d = new Date(b.olderThan);
      if (isNaN(d.getTime())) {
        errors.push("olderThan must be a valid ISO 8601 date string");
      }
    }
  }
  if (b.limit !== undefined) {
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1) {
      errors.push("limit must be a positive integer");
    }
  }
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") {
    errors.push("dryRun must be a boolean");
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid prune body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

// ─── Factory ───

export function createFridayMemoryRoutes(
  deps: FridayMemoryRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  // Single egress PII filter for list/search. The guard service already filters items it
  // returns, but learned facts are appended in these route handlers AFTER the guard has run
  // (deps.listLearnedFacts). Re-applying the SAME production output filter to the FINAL
  // merged result guarantees no returned field — including appended learned-fact content,
  // metadata, tags, and snippet — can bypass PII redaction. It is idempotent on the
  // already-filtered stored items.
  const outputFilter = createFridayMemoryOutputFilter();
  return [
    // ─── Store ───
    {
      operationId: "memory.store",
      method: "POST",
      path: "/v1/memory/store",
      auth: { public: true },
      rateLimitPolicyId: "memory.write",
      async handler(ctx): Promise<FridayMemoryStoreResponse> {
        // DX-003: Default namespace to "default" if not provided (immutable clone)
        const rawBody = ctx.body != null && typeof ctx.body === "object"
          ? { ...(ctx.body as Record<string, unknown>) }
          : ctx.body;
        if (rawBody != null && typeof rawBody === "object") {
          const b = rawBody as Record<string, unknown>;
          if (b.namespace === undefined || b.namespace === null || b.namespace === "") {
            b.namespace = "default";
          }
        }
        validateStoreNumericFields(rawBody);
        validateStoreBody(rawBody);
        const body = rawBody;
        enforceMemoryStoreApprovalBoundary(body);
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const idempotencyKey = readIdempotencyKeyHeader(ctx.headers);
        if (idempotencyKey) {
          const principalId = readPrincipalUserId(ctx.principal);
          const payloadHash = hashIdempotencyPayload({
            namespace: body.namespace,
            content: body.content,
            source: body.source,
            key: body.key,
            tags: body.tags,
            metadata: body.metadata,
            ttlSeconds: body.ttlSeconds,
            expiresAt: body.expiresAt,
            memoryType: body.memoryType,
            confidence: body.confidence,
          });
          const replay = deps.findStoreReplay?.({ principalId, idempotencyKey });
          if (replay) {
            const replayHash = readStoredIdempotencyPayloadHash(replay.metadata);
            if (replayHash && replayHash !== payloadHash) {
              throwIdempotencyConflict(idempotencyKey, "memory.items.create");
            }
            return { item: replay };
          }
          const metadata =
            body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
              ? { ...(body.metadata as Record<string, unknown>) }
              : {};
          metadata.apiRequest = {
            operationId: "memory.items.create",
            principalId,
            idempotencyKey,
            payloadHash,
            receivedAt: ctx.receivedAt,
          };
          body.metadata = metadata;
        }
        const item = await memory.store(body.namespace, body.content, {
          source: body.source,
          key: body.key,
          tags: body.tags,
          metadata: body.metadata,
          ttlSeconds: body.ttlSeconds,
          expiresAt: body.expiresAt,
          memoryType: body.memoryType,
          confidence: body.confidence,
        });
        return { item };
      },
    },

    // ─── Store (alias: POST /v1/memory/items) ───
    {
      operationId: "memory.items.create",
      method: "POST",
      path: "/v1/memory/items",
      auth: { public: true },
      rateLimitPolicyId: "memory.write",
      async handler(ctx): Promise<FridayMemoryStoreResponse> {
        const rawBody = ctx.body != null && typeof ctx.body === "object"
          ? { ...(ctx.body as Record<string, unknown>) }
          : ctx.body;
        if (rawBody != null && typeof rawBody === "object") {
          const b = rawBody as Record<string, unknown>;
          if (b.namespace === undefined || b.namespace === null || b.namespace === "") {
            b.namespace = "default";
          }
        }
        validateStoreNumericFields(rawBody);
        validateStoreBody(rawBody);
        const body = rawBody;
        enforceMemoryStoreApprovalBoundary(body);
        const principalId = readPrincipalUserId(ctx.principal);
        const idempotencyKey = readIdempotencyKeyHeader(ctx.headers);
        if (idempotencyKey) {
          const payloadHash = hashIdempotencyPayload({
            namespace: body.namespace,
            content: body.content,
            source: body.source,
            key: body.key,
            tags: body.tags,
            metadata: body.metadata,
            ttlSeconds: body.ttlSeconds,
            expiresAt: body.expiresAt,
            memoryType: body.memoryType,
            confidence: body.confidence,
          });
          const replay = deps.findStoreReplay?.({ principalId, idempotencyKey });
          if (replay) {
            const replayHash = readStoredIdempotencyPayloadHash(replay.metadata);
            if (replayHash && replayHash !== payloadHash) {
              throwIdempotencyConflict(idempotencyKey, "memory.items.create");
            }
            return { item: replay };
          }
          const metadata =
            body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
              ? { ...(body.metadata as Record<string, unknown>) }
              : {};
          metadata.apiRequest = {
            operationId: "memory.items.create",
            principalId,
            idempotencyKey,
            payloadHash,
            receivedAt: ctx.receivedAt,
          };
          body.metadata = metadata;
        }
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const item = await memory.store(body.namespace, body.content, {
          source: body.source,
          key: body.key,
          tags: body.tags,
          metadata: body.metadata,
          ttlSeconds: body.ttlSeconds,
          expiresAt: body.expiresAt,
          memoryType: body.memoryType,
          confidence: body.confidence,
        });
        return { item };
      },
    },

    // ─── Search ───
    {
      operationId: "memory.search",
      method: "POST",
      path: "/v1/memory/search",
      auth: { public: true },
      async handler(ctx): Promise<FridayMemorySearchResponse> {
        validateSearchBody(ctx.body);
        const body = ctx.body;
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const userId = readPrincipalUserId(ctx.principal);
        const items = await memory.search(body.query, {
          namespace: body.namespace,
          source: body.source,
          tagsAny: body.tagsAny,
          tagsAll: body.tagsAll,
          includeExpired: body.includeExpired,
          limit: body.limit,
          minScore: body.minScore,
          weights: body.weights,
          memoryType: body.memoryType,
          boostByConfidence: body.boostByConfidence,
          boostByAccess: body.boostByAccess,
          applyRetentionDecay: body.applyRetentionDecay,
          retentionHalfLifeDays: body.retentionHalfLifeDays,
        });
        const learnedItems = deps.listLearnedFacts && shouldIncludeLearnedFacts({
          namespace: body.namespace,
          source: body.source,
          memoryType: body.memoryType,
        })
          ? deps.listLearnedFacts({ userId, limit: body.limit ?? FRIDAY_MEMORY_MAX_LIMIT })
            .filter((fact) => matchesLearnedFactQuery(fact, body.query))
            .map((fact) => toLearnedFactSearchResult(fact, body.query))
          : [];
        return {
          items: [...items, ...learnedItems]
            .sort((a, b) => b.score - a.score)
            .slice(0, body.limit ?? FRIDAY_MEMORY_MAX_LIMIT)
            // Egress PII filter over the merged result (stored + appended learned facts).
            .map((result) => outputFilter.filterSearchResult(result)),
        };
      },
    },

    // ─── Get ───
    {
      operationId: "memory.get",
      method: "GET",
      path: "/v1/memory/items/:id",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetMemoryItemResponse> {
        const { id } = ctx.params as { id: string };
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const item = await memory.get(id);
        if (!item) {
          throw new FridayDomainError(
            FRIDAY_MEMORY_ERROR_CODES.NOT_FOUND,
            `Memory item '${id}' not found`,
            { httpStatus: 404 },
          );
        }
        // SEC-EVENT-REDACTION-001 (round-16): apply the SAME egress filter `memory.list` applies. This
        // single-item public GET previously returned the stored item VERBATIM (content / metadata / tags),
        // so a secret or PII in an item written before the store-time guard existed leaked here while the
        // list route redacted it — a defense-in-depth gap. Routing through `outputFilter.filterItem`
        // closes it (redacts content / metadata secret+PII, drops secret/PII-shaped tags).
        return { item: outputFilter.filterItem(item) };
      },
    },

    // ─── List ───
    {
      operationId: "memory.list",
      method: "GET",
      path: "/v1/memory/items",
      auth: { public: true },
      async handler(ctx): Promise<FridayListMemoryItemsResponse> {
        const query = ctx.query as Record<string, string | undefined>;
        const namespace = query.namespace;
        const source = query.source;
        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError("VALIDATION_ERROR", "limit must be a positive integer", { httpStatus: 400 });
          }
          limit = Math.min(parsed, FRIDAY_MEMORY_MAX_LIMIT);
        }
        const includeExpired = query.includeExpired === "true";

        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const userId = readPrincipalUserId(ctx.principal);
        const items = await memory.list({
          namespace,
          source,
          includeExpired,
          limit,
        });
        const learnedItems = deps.listLearnedFacts && shouldIncludeLearnedFacts({ namespace, source })
          ? deps.listLearnedFacts({ userId, limit: limit ?? FRIDAY_MEMORY_MAX_LIMIT })
            .map((fact) => toLearnedFactMemoryItem(fact))
          : [];
        const combined = [...items, ...learnedItems]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const sliced = typeof limit === "number" ? combined.slice(0, limit) : combined;
        // Egress PII filter over the merged result (stored + appended learned facts).
        return { items: sliced.map((item) => outputFilter.filterItem(item)) };
      },
    },

    // ─── Delete ───
    {
      operationId: "memory.delete",
      method: "DELETE",
      path: "/v1/memory/items/:id",
      auth: { public: true },
      async handler(ctx): Promise<FridayDeleteMemoryItemResponse> {
        const { id } = ctx.params as { id: string };
        if (isLearnedFactSyntheticId(id)) {
          if (!deps.deleteLearnedFact) {
            learnedFactRevocationUnavailable();
          }
          const key = readLearnedFactKeyFromSyntheticId(id);
          if (!key) {
            throw new FridayDomainError(
              FRIDAY_MEMORY_ERROR_CODES.NOT_FOUND,
              `Memory item '${id}' not found`,
              { httpStatus: 404 },
            );
          }
          const deleted = deps.deleteLearnedFact({
            userId: readPrincipalUserId(ctx.principal),
            key,
          });
          if (!deleted) {
            throw new FridayDomainError(
              FRIDAY_MEMORY_ERROR_CODES.NOT_FOUND,
              `Memory item '${id}' not found`,
              { httpStatus: 404 },
            );
          }
          return { deleted: true };
        }
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const deleted = await memory.delete(id);
        if (!deleted) {
          throw new FridayDomainError(
            FRIDAY_MEMORY_ERROR_CODES.NOT_FOUND,
            `Memory item '${id}' not found`,
            { httpStatus: 404 },
          );
        }
        return { deleted: true };
      },
    },

    // ─── Prune ───
    {
      operationId: "memory.prune",
      method: "POST",
      path: "/v1/memory/prune",
      auth: { public: true },
      async handler(ctx): Promise<FridayMemoryPruneResponse> {
        const rawBody = ctx.body ?? {};
        validatePruneBody(rawBody);
        const body = rawBody;
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const result = await memory.prune({
          namespace: body.namespace,
          source: body.source,
          tagsAny: body.tagsAny,
          expiredOnly: body.expiredOnly,
          olderThan: body.olderThan,
          limit: body.limit,
          dryRun: body.dryRun,
        });
        return { result };
      },
    },
  ];
}
