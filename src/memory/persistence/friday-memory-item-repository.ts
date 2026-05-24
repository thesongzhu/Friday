import type Database from "better-sqlite3";
import type {
  FridayMemoryFtsHit,
  FridayMemoryItem,
  FridayMemoryNamespace,
  FridayMemoryPruneOptions,
  FridayMemorySearchQuery,
} from "../model/friday-memory.types.js";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import { FRIDAY_MEMORY_DEFAULT_LIMIT, FRIDAY_MEMORY_ERROR_CODES } from "../friday-memory.constants.js";

// ─── Row shape ───

interface MemoryItemRow {
  id: string;
  namespace: string;
  key: string;
  value_json: string;
  content_text: string | null;
  source: string;
  tags_json: string;
  tags_text: string;
  metadata_json: string;
  ttl_seconds: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  memory_type: string | null;
  confidence: number | null;
  access_count: number;
  last_accessed_at: string | null;
}

// ─── Interface ───

export interface FridayMemoryItemRepository {
  insert(db: Database.Database, item: FridayMemoryItem): void;
  getById(db: Database.Database, id: string): FridayMemoryItem | null;
  findLatestByApiRequestIdempotencyKey(
    db: Database.Database,
    input: {
      principalId: string;
      idempotencyKey: string;
    },
  ): FridayMemoryItem | null;
  list(
    db: Database.Database,
    input?: {
      namespace?: FridayMemoryNamespace | FridayMemoryNamespace[];
      source?: string | string[];
      tagsAny?: string[];
      includeExpired?: boolean;
      limit?: number;
      nowIso?: string;
    },
  ): FridayMemoryItem[];
  deleteById(db: Database.Database, id: string): boolean;
  prune(
    db: Database.Database,
    options: FridayMemoryPruneOptions & { nowIso: string },
  ): string[];
  searchFts(
    db: Database.Database,
    input: FridayMemorySearchQuery & { nowIso: string; limit: number },
  ): FridayMemoryFtsHit[];
  /**
   * Increment access_count by 1 and set last_accessed_at = nowIso for every
   * id in `itemIds`.
   *
   * B3 cognition policy (conservative): callers should invoke this ONLY when
   * an item is actually returned through an intentional memory search/recall
   * path used by the agent (e.g. `memoryService.search()` after merge),
   * NOT on every raw repository read (`getById`, `list`). This makes the
   * counter mean "served to the agent as part of recall," not "row was
   * fetched by some internal lookup."
   *
   * Returns the number of rows actually updated.
   */
  recordAccess(
    db: Database.Database,
    input: { itemIds: readonly string[]; nowIso: string },
  ): number;
}

// ─── Helpers ───

function rowToItem(row: MemoryItemRow): FridayMemoryItem {
  const tagsJson: unknown = safeJsonParse<unknown>(row.tags_json);
  const tags: string[] = Array.isArray(tagsJson) ? (tagsJson as string[]) : [];
  const metadata: Record<string, unknown> =
    safeJsonParse<Record<string, unknown>>(row.metadata_json) ?? {};

  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    content: row.content_text ?? row.value_json,
    source: row.source,
    tags,
    metadata,
    ttlSeconds: row.ttl_seconds ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memoryType: (row.memory_type as FridayMemoryItem["memoryType"]) ?? undefined,
    confidence: row.confidence ?? undefined,
    accessCount: row.access_count ?? undefined,
    lastAccessedAt: row.last_accessed_at ?? undefined,
  };
}

function toArray(val: string | string[] | undefined): string[] | undefined {
  if (val === undefined) return undefined;
  return Array.isArray(val) ? val : [val];
}

function shouldPruneExpiredByDefault(options: FridayMemoryPruneOptions): boolean {
  return options.expiredOnly !== false && !options.olderThan;
}

// ─── FTS safety ───

/** Characters that have special meaning in FTS5 syntax — stripped from each token. */
const FTS5_UNSAFE_CHARS_RE = /[*{}()^:+\-~@#$\\]/g;

/**
 * Builds a safe FTS5 MATCH expression from raw user input.
 * Each word is individually double-quoted to neutralize operators/syntax.
 * Returns null if no valid tokens remain.
 */
function buildSafeFtsQuery(raw: string): string | null {
  // Strip quotes entirely, then split on whitespace
  const cleaned = raw.replace(/['"]/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  // Quote every token as a literal phrase
  const quoted = tokens.map((token) => {
    // Remove any FTS5 special chars from within the token
    const safe = token.replace(FTS5_UNSAFE_CHARS_RE, "");
    if (safe.length === 0) return null;
    // Always quote to neutralize operators like AND, OR, NOT, NEAR
    return `"${safe}"`;
  }).filter((t): t is string => t !== null);

  if (quoted.length === 0) return null;
  return quoted.join(" ");
}

/**
 * Builds an exact-match tag condition using json_each on tags_json.
 * mode "any" → OR across tags; mode "all" → AND across tags.
 */
function buildTagExactConditions(
  tableAlias: string,
  tags: string[],
  mode: "any" | "all",
  params: unknown[],
): string {
  const clauses = tags.map((tag) => {
    params.push(tag);
    return `EXISTS (SELECT 1 FROM json_each(${tableAlias}.tags_json) WHERE value = ?)`;
  });
  const joiner = mode === "all" ? " AND " : " OR ";
  return `(${clauses.join(joiner)})`;
}

// ─── Factory ───

export function createFridayMemoryItemRepository(): FridayMemoryItemRepository {
  return {
    insert(db, item) {
      const tagsJson = JSON.stringify(item.tags);
      const tagsText = item.tags.join(" ");
      const metadataJson = JSON.stringify(item.metadata);

      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, tags_text, metadata_json, ttl_seconds, expires_at, created_at, updated_at, memory_type, confidence, access_count, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.namespace,
        item.key,
        item.content,
        item.content,
        item.source,
        tagsJson,
        tagsText,
        metadataJson,
        item.ttlSeconds ?? null,
        item.expiresAt ?? null,
        item.createdAt,
        item.updatedAt,
        item.memoryType ?? null,
        item.confidence ?? null,
        item.accessCount ?? 0,
        item.lastAccessedAt ?? null,
      );
    },

    getById(db, id) {
      const row = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as
        | MemoryItemRow
        | undefined;
      return row ? rowToItem(row) : null;
    },

    findLatestByApiRequestIdempotencyKey(db, input) {
      const row = db.prepare(
        `SELECT * FROM memory_items
         WHERE json_extract(metadata_json, '$.apiRequest.principalId') = ?
           AND json_extract(metadata_json, '$.apiRequest.idempotencyKey') = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(input.principalId, input.idempotencyKey) as MemoryItemRow | undefined;
      return row ? rowToItem(row) : null;
    },

    list(db, input) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      const namespaces = toArray(input?.namespace);
      if (namespaces && namespaces.length > 0) {
        conditions.push(`namespace IN (${namespaces.map(() => "?").join(",")})`);
        params.push(...namespaces);
      }

      const sources = toArray(input?.source);
      if (sources && sources.length > 0) {
        conditions.push(`source IN (${sources.map(() => "?").join(",")})`);
        params.push(...sources);
      }

      if (input?.tagsAny && input.tagsAny.length > 0) {
        conditions.push(buildTagExactConditions("memory_items", input.tagsAny, "any", params));
      }

      if (!input?.includeExpired) {
        const now = input?.nowIso ?? new Date().toISOString();
        conditions.push("(expires_at IS NULL OR expires_at > ?)");
        params.push(now);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = input?.limit ?? FRIDAY_MEMORY_DEFAULT_LIMIT;
      params.push(limit);

      const rows = db
        .prepare(`SELECT * FROM memory_items ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params) as MemoryItemRow[];

      return rows.map(rowToItem);
    },

    deleteById(db, id) {
      const result = db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
      return result.changes > 0;
    },

    recordAccess(db, input) {
      if (input.itemIds.length === 0) return 0;
      const placeholders = input.itemIds.map(() => "?").join(",");
      const result = db
        .prepare(
          `UPDATE memory_items
              SET access_count = access_count + 1,
                  last_accessed_at = ?
            WHERE id IN (${placeholders})`,
        )
        .run(input.nowIso, ...input.itemIds);
      return result.changes;
    },

    prune(db, options) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      const namespaces = toArray(options.namespace);
      if (namespaces && namespaces.length > 0) {
        conditions.push(`namespace IN (${namespaces.map(() => "?").join(",")})`);
        params.push(...namespaces);
      }

      const sources = toArray(options.source);
      if (sources && sources.length > 0) {
        conditions.push(`source IN (${sources.map(() => "?").join(",")})`);
        params.push(...sources);
      }

      if (options.tagsAny && options.tagsAny.length > 0) {
        conditions.push(buildTagExactConditions("memory_items", options.tagsAny, "any", params));
      }

      if (shouldPruneExpiredByDefault(options)) {
        conditions.push("expires_at IS NOT NULL AND expires_at <= ?");
        params.push(options.nowIso);
      }

      if (options.olderThan) {
        conditions.push("updated_at < ?");
        params.push(options.olderThan);
      }

      const where = `WHERE ${conditions.join(" AND ")}`;
      const limit = options.limit ?? 1000;
      params.push(limit);

      // First select the IDs to delete
      const rows = db
        .prepare(`SELECT id FROM memory_items ${where} ORDER BY updated_at ASC LIMIT ?`)
        .all(...params) as Array<{ id: string }>;

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);

      if (!options.dryRun) {
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(
          ...ids,
        );
      }

      return ids;
    },

    searchFts(db, input) {
      const mainParams: unknown[] = [];
      const filterConditions: string[] = [];
      const filterParams: unknown[] = [];

      // Build safe FTS5 MATCH expression (Fix #2: injection safety)
      const matchExpr = buildSafeFtsQuery(input.text);
      if (!matchExpr) return [];

      mainParams.push(matchExpr);

      // Namespace filter
      const namespaces = toArray(input.namespace);
      if (namespaces && namespaces.length > 0) {
        filterConditions.push(`fts.namespace IN (${namespaces.map(() => "?").join(",")})`);
        filterParams.push(...namespaces);
      }

      // Source filter
      const sources = toArray(input.source);
      if (sources && sources.length > 0) {
        filterConditions.push(`fts.source IN (${sources.map(() => "?").join(",")})`);
        filterParams.push(...sources);
      }

      // Tag filtering (Fix #1: tagsAny / tagsAll)
      if (input.tagsAny && input.tagsAny.length > 0) {
        filterConditions.push(
          buildTagExactConditions("mi", input.tagsAny, "any", filterParams),
        );
      }
      if (input.tagsAll && input.tagsAll.length > 0) {
        filterConditions.push(
          buildTagExactConditions("mi", input.tagsAll, "all", filterParams),
        );
      }

      // Expiry filter
      if (!input.includeExpired) {
        filterConditions.push("(mi.expires_at IS NULL OR mi.expires_at > ?)");
        filterParams.push(input.nowIso);
      }

      const filterWhere = filterConditions.length > 0 ? `AND ${filterConditions.join(" AND ")}` : "";

      const sql = `
        SELECT
          mi.id AS item_id,
          rank * -1.0 AS score,
          snippet(memory_items_fts, 0, '<b>', '</b>', '...', 32) AS snippet
        FROM memory_items_fts fts
        JOIN memory_items mi ON mi.rowid = fts.rowid
        WHERE memory_items_fts MATCH ?
        ${filterWhere}
        ORDER BY rank
        LIMIT ?
      `;

      const allParams = [...mainParams, ...filterParams, input.limit];

      let rows: Array<{ item_id: string; score: number; snippet: string }>;
      try {
        rows = db.prepare(sql).all(...allParams) as Array<{
          item_id: string;
          score: number;
          snippet: string;
        }>;
      } catch (err: unknown) {
        // Wrap SQLite FTS parse failures in FridayDomainError (Fix #2)
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("fts5") || message.includes("MATCH") || message.includes("parse")) {
          throw new FridayDomainError(
            FRIDAY_MEMORY_ERROR_CODES.SEARCH_INVALID_QUERY,
            `Invalid search query: ${message}`,
            { httpStatus: 400 },
          );
        }
        throw err;
      }

      // Normalize scores: FTS5 rank values are somewhat arbitrary; normalize to 0..1
      const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.score), 0.001) : 1;

      return rows.map((row) => ({
        itemId: row.item_id,
        score: row.score / maxScore,
        snippet: row.snippet,
      }));
    },
  };
}
