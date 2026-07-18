import type {
  CreateFridayMemoryGuardServiceDeps,
  FridayMemoryGuardContext,
  FridayMemoryGuardNamespaceResolution,
  FridayMemoryGuardService,
} from "../model/friday-memory-guard.types.js";

import type {
  FridayMemoryItem,
  FridayMemoryNamespace,
  FridayMemoryPruneOptions,
  FridayMemoryPruneResult,
  FridayMemorySearchQuery,
  FridayMemorySearchResult,
  FridayMemoryStoreInput,
} from "../../model/friday-memory.types.js";

import { FridayDomainError } from "#errors";

import {
  FRIDAY_MEMORY_GUARD_AUTO_PRUNE_BATCH_SIZE,
  FRIDAY_MEMORY_GUARD_CHANNEL_SEGMENT,
  FRIDAY_MEMORY_GUARD_ERROR_CODES,
  FRIDAY_MEMORY_GUARD_KEY_REGEX,
  FRIDAY_MEMORY_GUARD_MAX_CONTENT_BYTES,
  FRIDAY_MEMORY_GUARD_MAX_KEY_LENGTH,
  FRIDAY_MEMORY_GUARD_MAX_METADATA_BYTES,
  FRIDAY_MEMORY_GUARD_MAX_NAMESPACE_LENGTH,
  FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
  FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT,
  FRIDAY_MEMORY_GUARD_MAX_TAG_LENGTH,
  FRIDAY_MEMORY_GUARD_NAMESPACE_REGEX,
  FRIDAY_MEMORY_GUARD_PII_MODE,
  FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
  FRIDAY_MEMORY_GUARD_RESERVED_NAMESPACE_PREFIXES,
  FRIDAY_MEMORY_GUARD_SCOPE_PREFIX_MAX_NAMESPACES,
  FRIDAY_MEMORY_GUARD_TAG_REGEX,
  FRIDAY_MEMORY_GUARD_TENANT_PREFIX,
  FRIDAY_MEMORY_GUARD_USER_SEGMENT,
} from "../friday-memory-guard.constants.js";

import { assertTsDurableMemoryWriteEnabled } from "../friday-ts-durable-memory-write-guard.js";
import { sanitizeFridayMemoryQuery } from "./friday-memory-query-sanitizer.js";

// ─── Helpers ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

// ─── Namespace resolution ───

function buildScopePrefix(context: FridayMemoryGuardContext): string {
  const { subject } = context;
  if (subject.accessLevel === "system") {
    return "";
  }
  const parts = [FRIDAY_MEMORY_GUARD_TENANT_PREFIX, subject.hubId];
  // Initiative H.3: channel-level namespace isolation
  if (subject.channelKind) {
    parts.push(FRIDAY_MEMORY_GUARD_CHANNEL_SEGMENT, subject.channelKind);
  }
  if (subject.userId) {
    parts.push(FRIDAY_MEMORY_GUARD_USER_SEGMENT, subject.userId);
  }
  return parts.join(".");
}

function isExpandedChannelUserNamespaceInScope(
  namespace: string,
  context: FridayMemoryGuardContext,
): boolean {
  if (context.subject.accessLevel === "system") {
    return true;
  }
  if (!context.subject.userId) {
    return false;
  }

  const channelPrefix = [
    FRIDAY_MEMORY_GUARD_TENANT_PREFIX,
    context.subject.hubId,
    FRIDAY_MEMORY_GUARD_CHANNEL_SEGMENT,
  ].join(".");
  const userSegment = `.${FRIDAY_MEMORY_GUARD_USER_SEGMENT}.${context.subject.userId}`;

  return namespace.startsWith(`${channelPrefix}.`)
    && (namespace.includes(`${userSegment}.`) || namespace.endsWith(userSegment));
}

function isNamespaceAccessibleInContext(
  namespace: string,
  context: FridayMemoryGuardContext,
  scopePrefix: string,
): boolean {
  if (!scopePrefix) {
    return true;
  }
  return isNamespaceInScope(namespace, scopePrefix) || isExpandedChannelUserNamespaceInScope(namespace, context);
}

function resolveNamespace(
  requestedNamespace: string,
  context: FridayMemoryGuardContext,
): FridayMemoryGuardNamespaceResolution {
  const scopePrefix = buildScopePrefix(context);

  if (context.subject.accessLevel === "system") {
    return {
      requestedNamespace,
      effectiveNamespace: requestedNamespace,
      scopePrefix: "",
    };
  }

  if (scopePrefix && isNamespaceAccessibleInContext(requestedNamespace, context, scopePrefix)) {
    return {
      requestedNamespace,
      effectiveNamespace: requestedNamespace,
      scopePrefix,
    };
  }

  // For tenants, prefix namespace with scope
  const effectiveNamespace = scopePrefix
    ? `${scopePrefix}.${requestedNamespace}`
    : requestedNamespace;

  return {
    requestedNamespace,
    effectiveNamespace,
    scopePrefix,
  };
}

function isNamespaceInScope(namespace: string, scopePrefix: string): boolean {
  if (!scopePrefix) return true; // system access — everything is in scope
  return namespace.startsWith(`${scopePrefix}.`) || namespace === scopePrefix;
}

function isReservedNamespace(namespace: string): boolean {
  return FRIDAY_MEMORY_GUARD_RESERVED_NAMESPACE_PREFIXES.some(
    (prefix) => namespace === prefix || namespace.startsWith(`${prefix}.`),
  );
}

// ─── Validation ───

function validateNamespace(namespace: string): void {
  if (!namespace || typeof namespace !== "string") {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID,
      "namespace is required and must be a non-empty string",
      { httpStatus: 400 },
    );
  }
  if (namespace.length > FRIDAY_MEMORY_GUARD_MAX_NAMESPACE_LENGTH) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID,
      `namespace must not exceed ${FRIDAY_MEMORY_GUARD_MAX_NAMESPACE_LENGTH} characters`,
      { httpStatus: 400 },
    );
  }
  if (!FRIDAY_MEMORY_GUARD_NAMESPACE_REGEX.test(namespace)) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID,
      "namespace must match pattern: lowercase alphanumeric segments separated by dots",
      { httpStatus: 400 },
    );
  }
}

function validateKey(key: string): void {
  if (key.length > FRIDAY_MEMORY_GUARD_MAX_KEY_LENGTH) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.KEY_INVALID,
      `key must not exceed ${FRIDAY_MEMORY_GUARD_MAX_KEY_LENGTH} characters`,
      { httpStatus: 400 },
    );
  }
  if (!FRIDAY_MEMORY_GUARD_KEY_REGEX.test(key)) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.KEY_INVALID,
      "key must match pattern: alphanumeric start, followed by alphanumeric, dots, underscores, colons, or hyphens",
      { httpStatus: 400 },
    );
  }
}

function validateContent(content: string): void {
  if (byteLength(content) > FRIDAY_MEMORY_GUARD_MAX_CONTENT_BYTES) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.CONTENT_TOO_LARGE,
      `content must not exceed ${FRIDAY_MEMORY_GUARD_MAX_CONTENT_BYTES} bytes`,
      { httpStatus: 400 },
    );
  }
}

function validateTags(tags: string[]): void {
  if (tags.length > FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.TAGS_TOO_MANY,
      `tags count must not exceed ${FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT}`,
      { httpStatus: 400 },
    );
  }
  for (const tag of tags) {
    if (tag.length > FRIDAY_MEMORY_GUARD_MAX_TAG_LENGTH) {
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.TAG_TOO_LONG,
        `tag '${tag}' exceeds maximum length of ${FRIDAY_MEMORY_GUARD_MAX_TAG_LENGTH}`,
        { httpStatus: 400 },
      );
    }
    if (!FRIDAY_MEMORY_GUARD_TAG_REGEX.test(tag)) {
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.TAG_INVALID,
        `tag '${tag}' must match pattern: lowercase alphanumeric start, followed by alphanumeric, dots, underscores, colons, or hyphens`,
        { httpStatus: 400 },
      );
    }
  }
}

function validateMetadata(metadata: Record<string, unknown>): void {
  const serialized = JSON.stringify(metadata);
  if (byteLength(serialized) > FRIDAY_MEMORY_GUARD_MAX_METADATA_BYTES) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.METADATA_TOO_LARGE,
      `metadata must not exceed ${FRIDAY_MEMORY_GUARD_MAX_METADATA_BYTES} bytes when serialized`,
      { httpStatus: 400 },
    );
  }
}

function enforceReservedNamespacePolicy(
  requestedNamespace: string,
  context: FridayMemoryGuardContext,
): void {
  if (context.subject.accessLevel === "system") return;
  // Check the REQUESTED namespace (before prefixing) to prevent tenants from
  // using reserved prefixes like "system.*" that would otherwise be masked
  // by the tenant prefix.
  if (isReservedNamespace(requestedNamespace)) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_RESERVED,
      `namespace '${requestedNamespace}' is reserved for system use`,
      { httpStatus: 403 },
    );
  }
}

function enforceScopeCheck(
  namespace: string,
  scopePrefix: string,
  context: FridayMemoryGuardContext,
): void {
  if (context.subject.accessLevel === "system") return;
  if (!isNamespaceAccessibleInContext(namespace, context, scopePrefix)) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_GUARD_ERROR_CODES.SCOPE_VIOLATION,
      "access denied: namespace is outside your scope",
      { httpStatus: 403 },
    );
  }
}

// ─── Scope helpers for namespace arrays ───

function scopeNamespaceFilter(
  ns: FridayMemoryNamespace | FridayMemoryNamespace[] | undefined,
  context: FridayMemoryGuardContext,
  scopePrefix: string,
  quotaRepo: CreateFridayMemoryGuardServiceDeps["quotaRepo"],
  db: CreateFridayMemoryGuardServiceDeps["db"],
): FridayMemoryNamespace | FridayMemoryNamespace[] | undefined {
  if (context.subject.accessLevel === "system") {
    // Even for system, reject non-string / non-string[] (except undefined)
    if (ns !== undefined && typeof ns !== "string" && !isStringArray(ns)) {
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID,
        "namespace must be a string, an array of strings, or undefined",
        { httpStatus: 400 },
      );
    }
    return ns;
  }

  if (ns === undefined) {
    // Default: expand scope prefix to include the prefix itself + all descendant namespaces
    if (!scopePrefix) return undefined;
    const descendants = db.withReadConnection((readDb) =>
      quotaRepo.listNamespacesByPrefix(readDb, scopePrefix, FRIDAY_MEMORY_GUARD_SCOPE_PREFIX_MAX_NAMESPACES),
    );
    // Ensure the prefix namespace itself is always included (listNamespacesByPrefix
    // already returns it when items exist, but we guarantee it here for safety)
    const result = descendants.length === 0
      ? [scopePrefix]
      : descendants.includes(scopePrefix)
        ? descendants
        : [scopePrefix, ...descendants];

    // Also include channel-scoped namespaces for the current user.
    // Keep this filtered to the current user segment; default list/search/prune
    // must never sweep every channel namespace in the same hub.
    if (context.subject.userId) {
      const channelPrefix = `${FRIDAY_MEMORY_GUARD_TENANT_PREFIX}.${context.subject.hubId}.${FRIDAY_MEMORY_GUARD_CHANNEL_SEGMENT}`;
      const channelDescendants = db.withReadConnection((readDb) =>
        quotaRepo.listNamespacesByPrefix(readDb, channelPrefix, FRIDAY_MEMORY_GUARD_SCOPE_PREFIX_MAX_NAMESPACES),
      );
      const scopedChannelDescendants = channelDescendants.filter((namespace) =>
        isExpandedChannelUserNamespaceInScope(namespace, context)
      );
      const expanded = [...new Set([...result, ...scopedChannelDescendants])];
      return expanded;
    }

    return result.length === 1 ? result[0] : result;
  }

  if (typeof ns === "string") {
    const resolution = resolveNamespace(ns, context);
    enforceScopeCheck(resolution.effectiveNamespace, scopePrefix, context);
    return resolution.effectiveNamespace;
  }

  if (isStringArray(ns)) {
    return ns.map((n) => {
      const resolution = resolveNamespace(n, context);
      enforceScopeCheck(resolution.effectiveNamespace, scopePrefix, context);
      return resolution.effectiveNamespace;
    });
  }

  // Invalid type (e.g. object, number, boolean) — critical: prevents namespace bypass
  throw new FridayDomainError(
    FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID,
    "namespace must be a string, an array of strings, or undefined",
    { httpStatus: 400 },
  );
}

// ─── Guard service factory ───

export function createFridayMemoryGuardService(
  deps: CreateFridayMemoryGuardServiceDeps,
): FridayMemoryGuardService {
  const { core, db, context, rateLimiter, quotaRepo, piiGuard, outputFilter } = deps;
  const scopePrefix = buildScopePrefix(context);
  const tsMemoryWritesEnabled = deps.tsMemoryWritesEnabled ?? true;

  // ─── Error boundary: wraps unknown errors in FridayDomainError ───

  function guardErrorBoundary<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err: unknown) => {
      if (err instanceof FridayDomainError) throw err;
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.INTERNAL,
        err instanceof Error ? err.message : "unexpected guard error",
        { httpStatus: 500, cause: err },
      );
    });
  }

  function consumeRate(action: "write" | "search", namespace: string): void {
    const decision = rateLimiter.consume(action, namespace, deps.nowMs());
    if (!decision.allowed) {
      const isGlobal = decision.key.startsWith("global:");
      const codeMap = {
        "write:true": FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_GLOBAL_WRITE,
        "write:false": FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_NAMESPACE_WRITE,
        "search:true": FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_GLOBAL_SEARCH,
        "search:false": FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_NAMESPACE_SEARCH,
      } as const;
      const code = codeMap[`${action}:${isGlobal}` as keyof typeof codeMap];
      throw new FridayDomainError(
        code,
        `rate limit exceeded for ${action} on ${isGlobal ? "global" : namespace}`,
        {
          httpStatus: 429,
          retryable: true,
          details: {
            retryAfterMs: decision.retryAfterMs,
            resetAt: decision.resetAt,
          },
        },
      );
    }
  }

  function checkQuotaAndPrune(namespace: string, contentBytes: number): void {
    const now = deps.nowIso();
    const approachingItemThreshold = Math.floor(
      FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE * FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
    );
    const approachingByteThreshold = Math.floor(
      FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE * FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
    );

    let usage = db.withReadConnection((readDb) =>
      quotaRepo.getNamespaceUsage(readDb, namespace, now),
    );

    // Auto-prune expired when approaching threshold OR when hard quota exceeded
    if (
      usage.expiredItemCount > 0 &&
      (usage.itemCount + 1 > approachingItemThreshold ||
        usage.totalBytes + contentBytes > approachingByteThreshold)
    ) {
      db.withWriteTransaction((writeDb) => {
        quotaRepo.pruneExpiredOldest(writeDb, {
          namespace,
          nowIso: now,
          limit: FRIDAY_MEMORY_GUARD_AUTO_PRUNE_BATCH_SIZE,
        });
      });

      // Re-check after pruning
      usage = db.withReadConnection((readDb) =>
        quotaRepo.getNamespaceUsage(readDb, namespace, now),
      );
    }

    // Check item count quota (hard limit)
    if (usage.itemCount + 1 > FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE) {
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.QUOTA_ITEMS_EXCEEDED,
        `namespace '${namespace}' has reached the maximum of ${FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE} items`,
        { httpStatus: 429, retryable: false },
      );
    }

    // Check byte quota (hard limit)
    if (usage.totalBytes + contentBytes > FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE) {
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.QUOTA_BYTES_EXCEEDED,
        `namespace '${namespace}' has reached the maximum of ${FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE} bytes`,
        { httpStatus: 429, retryable: false },
      );
    }
  }

  function verifyItemScope(item: FridayMemoryItem): void {
    if (!isNamespaceAccessibleInContext(item.namespace, context, scopePrefix)) {
      throw new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.ITEM_ACCESS_DENIED,
        "access denied: item is outside your scope",
        { httpStatus: 403 },
      );
    }
  }

  return {
    store(
      namespace: FridayMemoryNamespace,
      content: string,
      metadata?: Omit<FridayMemoryStoreInput, "namespace" | "content">,
    ): Promise<FridayMemoryItem> {
      return guardErrorBoundary(async () => {
        // 1. Validate
        validateNamespace(namespace);
        validateContent(content);

        if (metadata?.key !== undefined) {
          validateKey(metadata.key);
        }
        if (metadata?.tags !== undefined) {
          if (!isStringArray(metadata.tags)) {
            throw new FridayDomainError(
              FRIDAY_MEMORY_GUARD_ERROR_CODES.TAG_INVALID,
              "tags must be an array of strings",
              { httpStatus: 400 },
            );
          }
          validateTags(metadata.tags);
        }
        if (metadata?.metadata !== undefined) {
          if (!isRecord(metadata.metadata)) {
            throw new FridayDomainError(
              FRIDAY_MEMORY_GUARD_ERROR_CODES.METADATA_TOO_LARGE,
              "metadata must be a plain object",
              { httpStatus: 400 },
            );
          }
          validateMetadata(metadata.metadata);
        }

        // 2. Namespace isolation — check REQUESTED namespace for reserved prefixes
        const resolution = resolveNamespace(namespace, context);
        enforceReservedNamespacePolicy(resolution.requestedNamespace, context);

        // 3. Legacy TS writes are retired by default. Guard-local quota
        // auto-prune is itself a memory_items delete, so fail before it.
        assertTsDurableMemoryWriteEnabled(tsMemoryWritesEnabled, "memory.store");

        // 4. Rate limit
        consumeRate("write", resolution.effectiveNamespace);

        // 5. Quota
        const contentBytes = byteLength(content);
        checkQuotaAndPrune(resolution.effectiveNamespace, contentBytes);

        // 6. PII policy — scan/redact content AND caller-supplied metadata, and drop tags that
        // themselves contain PII (metadata + tags reach the store via the HTTP route, so they
        // must be covered too). Metadata values are free-form, so PII is redacted in place; a
        // tag is a constrained-charset label, so a "[EMAIL]"-style redaction marker would be an
        // invalid tag — instead a PII-bearing tag is dropped and its pii.* type tag surfaced.
        const piiResult = piiGuard.scanAndTransform(content);
        const metadataRedaction = piiGuard.redactDeep(metadata?.metadata);
        const redactedMetadata = metadataRedaction.value as Record<string, unknown> | undefined;

        const originalTags = metadata?.tags ?? [];
        const tagPiiTypeTags = new Set<string>();
        const cleanTags: string[] = [];
        for (const tag of originalTags) {
          const tagScan = piiGuard.scanAndTransform(tag);
          if (tagScan.matches.length > 0) {
            // Drop the PII-bearing tag (no PII at rest in tags); surface its pii.* type tags.
            tagScan.tagsToAdd.forEach((t) => tagPiiTypeTags.add(t));
          } else {
            cleanTags.push(tag);
          }
        }

        const piiPresent =
          piiResult.matches.length > 0
          || metadataRedaction.tagsToAdd.length > 0
          || tagPiiTypeTags.size > 0;
        const allPiiTags = [
          ...new Set([...piiResult.tagsToAdd, ...metadataRedaction.tagsToAdd, ...tagPiiTypeTags]),
        ];
        // PII_MODE is compile-time "redact" by default (see FRIDAY_MEMORY_GUARD_PII_MODE), but test
        // the variable as a runtime string to support re-configuration without code changes.
        if (piiPresent && (FRIDAY_MEMORY_GUARD_PII_MODE as string) === "block") {
          throw new FridayDomainError(
            FRIDAY_MEMORY_GUARD_ERROR_CODES.PII_BLOCKED,
            `content/metadata/tags contain PII: ${[...new Set([...piiResult.distinctTypes, ...allPiiTags.map((t) => t.split(".").at(-1) ?? t)])].join(", ")}`,
            { httpStatus: 400 },
          );
        }

        // Merge surviving clean tags with discovered pii.* type tags (all charset-valid).
        const mergedTags = [...cleanTags, ...allPiiTags.filter((t) => !cleanTags.includes(t))];

        // Re-validate tag limits after PII merge (PII tags could push over count limits)
        if (mergedTags.length > 0) {
          validateTags(mergedTags);
        }

        // 7. Delegate to core — store redacted content, redacted metadata, PII-stripped tags
        const item = await core.store(resolution.effectiveNamespace, piiResult.transformedContent, {
          ...metadata,
          ...(metadata?.metadata !== undefined ? { metadata: redactedMetadata } : {}),
          tags: mergedTags.length > 0 ? mergedTags : metadata?.tags,
        });

        // 8. Output filter
        return outputFilter.filterItem(item);
      });
    },

    search(
      query: string,
      options?: Omit<FridayMemorySearchQuery, "text">,
    ): Promise<FridayMemorySearchResult[]> {
      return guardErrorBoundary(async () => {
        // 1. Validate query
        if (!query || typeof query !== "string" || !query.trim()) {
          throw new FridayDomainError(
            FRIDAY_MEMORY_GUARD_ERROR_CODES.QUERY_EMPTY,
            "search query must not be empty",
            { httpStatus: 400 },
          );
        }

        // 2. Sanitize query
        const sanitized = sanitizeFridayMemoryQuery(query);
        if (!sanitized) {
          throw new FridayDomainError(
            FRIDAY_MEMORY_GUARD_ERROR_CODES.QUERY_INVALID,
            "search query contains no valid tokens after sanitization",
            { httpStatus: 400 },
          );
        }

        // 3. Namespace isolation
        const scopedNamespace = scopeNamespaceFilter(options?.namespace, context, scopePrefix, quotaRepo, db);

        // 4. Rate limit
        const nsForRate = typeof scopedNamespace === "string"
          ? scopedNamespace
          : Array.isArray(scopedNamespace) && scopedNamespace.length > 0
            ? scopedNamespace[0]
            : scopePrefix || "global";
        consumeRate("search", nsForRate);

        // 5. Clamp limit
        const limit = Math.min(
          options?.limit ?? FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
          FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
        );

        // 6. Delegate to core
        const results = await core.search(sanitized, {
          ...options,
          namespace: scopedNamespace,
          limit,
        });

        // 7. Filter scope + output
        const allowedNamespaces = Array.isArray(scopedNamespace)
          ? new Set(scopedNamespace as string[])
          : scopedNamespace ? new Set([scopedNamespace as string]) : undefined;
        const scopeFiltered = context.subject.accessLevel === "system"
          ? results
          : results.filter((result) =>
              isNamespaceAccessibleInContext(result.item.namespace, context, scopePrefix)
              || (allowedNamespaces?.has(result.item.namespace) ?? false)
            );

        return outputFilter.filterSearchResults(scopeFiltered);
      });
    },

    get(itemId: string): Promise<FridayMemoryItem | null> {
      return guardErrorBoundary(async () => {
        const item = await core.get(itemId);
        if (!item) return null;

        // Scope check
        verifyItemScope(item);

        return outputFilter.filterItem(item);
      });
    },

    list(input?: {
      namespace?: FridayMemoryNamespace | FridayMemoryNamespace[];
      source?: string | string[];
      tagsAny?: string[];
      includeExpired?: boolean;
      limit?: number;
    }): Promise<FridayMemoryItem[]> {
      return guardErrorBoundary(async () => {
        // Scope namespace filter
        const scopedNamespace = scopeNamespaceFilter(input?.namespace, context, scopePrefix, quotaRepo, db);

        const items = await core.list({
          ...input,
          namespace: scopedNamespace,
        });

        // Scope check on all items — allow items from the expanded namespace query.
        // scopedNamespace already restricts which namespaces are queried, so items
        // returned by core.list() are pre-filtered. The scope check here is a safety
        // net. For expanded channel-scoped namespaces, we trust the
        // query filter since it was built from the user's context.
        const allowedNamespaces = Array.isArray(scopedNamespace)
          ? new Set(scopedNamespace as string[])
          : scopedNamespace ? new Set([scopedNamespace as string]) : undefined;
        const scopeFiltered = context.subject.accessLevel === "system"
          ? items
          : items.filter((item) =>
              isNamespaceAccessibleInContext(item.namespace, context, scopePrefix)
              || (allowedNamespaces?.has(item.namespace) ?? false)
            );

        return scopeFiltered.map((item) => outputFilter.filterItem(item));
      });
    },

    delete(itemId: string): Promise<boolean> {
      return guardErrorBoundary(async () => {
        assertTsDurableMemoryWriteEnabled(tsMemoryWritesEnabled, "memory.delete");

        // Scope check first
        const item = await core.get(itemId);
        if (!item) return false;

        verifyItemScope(item);

        // Rate limit
        consumeRate("write", item.namespace);

        return core.delete(itemId);
      });
    },

    prune(options?: FridayMemoryPruneOptions): Promise<FridayMemoryPruneResult> {
      return guardErrorBoundary(async () => {
        assertTsDurableMemoryWriteEnabled(tsMemoryWritesEnabled, "memory.prune");

        // Scope namespace filter
        const scopedNamespace = scopeNamespaceFilter(options?.namespace, context, scopePrefix, quotaRepo, db);

        // Rate limit
        const nsForRate = typeof scopedNamespace === "string"
          ? scopedNamespace
          : Array.isArray(scopedNamespace) && scopedNamespace.length > 0
            ? scopedNamespace[0]
            : scopePrefix || "global";
        consumeRate("write", nsForRate);

        return core.prune({
          ...options,
          namespace: scopedNamespace,
        });
      });
    },
  };
}
