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
import type { FridayMemoryGuardServiceFactory } from "#memory";
import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_ERROR_CODES, FRIDAY_MEMORY_MAX_LIMIT } from "#memory";

// ─── Dependencies ───

export interface FridayMemoryRoutesDeps {
  memoryGuardFactory: FridayMemoryGuardServiceFactory;
}

// ─── Validation helpers ───

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
  return [
    // ─── Store ───
    {
      operationId: "memory.store",
      method: "POST",
      path: "/v1/memory/store",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const item = await memory.store(body.namespace, body.content, {
          source: body.source,
          key: body.key,
          tags: body.tags,
          metadata: body.metadata,
          ttlSeconds: body.ttlSeconds,
          expiresAt: body.expiresAt,
        });
        return { item };
      },
    },

    // ─── Store (alias: POST /v1/memory/items) ───
    {
      operationId: "memory.items.create",
      method: "POST",
      path: "/v1/memory/items",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const item = await memory.store(body.namespace, body.content, {
          source: body.source,
          key: body.key,
          tags: body.tags,
          metadata: body.metadata,
          ttlSeconds: body.ttlSeconds,
          expiresAt: body.expiresAt,
        });
        return { item };
      },
    },

    // ─── Search ───
    {
      operationId: "memory.search",
      method: "POST",
      path: "/v1/memory/search",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<FridayMemorySearchResponse> {
        validateSearchBody(ctx.body);
        const body = ctx.body;
        const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
        const items = await memory.search(body.query, {
          namespace: body.namespace,
          source: body.source,
          tagsAny: body.tagsAny,
          tagsAll: body.tagsAll,
          includeExpired: body.includeExpired,
          limit: body.limit,
          minScore: body.minScore,
          weights: body.weights,
        });
        return { items };
      },
    },

    // ─── Get ───
    {
      operationId: "memory.get",
      method: "GET",
      path: "/v1/memory/items/:id",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
        return { item };
      },
    },

    // ─── List ───
    {
      operationId: "memory.list",
      method: "GET",
      path: "/v1/memory/items",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
        const items = await memory.list({
          namespace,
          source,
          includeExpired,
          limit,
        });
        return { items };
      },
    },

    // ─── Delete ───
    {
      operationId: "memory.delete",
      method: "DELETE",
      path: "/v1/memory/items/:id",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<FridayDeleteMemoryItemResponse> {
        const { id } = ctx.params as { id: string };
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
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
