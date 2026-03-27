import type Database from "better-sqlite3";
import type {
  FridayMemoryEmbedding,
  FridayMemoryNamespace,
  FridayMemorySemanticHit,
} from "../model/friday-memory.types.js";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import { FRIDAY_MEMORY_ERROR_CODES } from "../friday-memory.constants.js";

// ─── Row shape ───

interface EmbeddingRow {
  id: string;
  item_id: string;
  provider_id: string;
  model: string;
  dimensions: number;
  vector_json: string;
  created_at: string;
  updated_at: string;
}

// ─── Interface ───

export interface FridayMemoryEmbeddingRepository {
  upsert(db: Database.Database, embedding: FridayMemoryEmbedding): void;
  getByItemId(
    db: Database.Database,
    itemId: string,
    model?: string,
  ): FridayMemoryEmbedding | null;
  deleteByItemId(db: Database.Database, itemId: string): number;
  querySimilar(
    db: Database.Database,
    input: {
      queryVector: number[];
      model: string;
      nowIso: string;
      namespace?: FridayMemoryNamespace | FridayMemoryNamespace[];
      source?: string | string[];
      tagsAny?: string[];
      includeExpired?: boolean;
      limit: number;
      candidateLimit: number;
      minScore?: number;
    },
  ): FridayMemorySemanticHit[];
}

// ─── Cosine similarity (JS) ───

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

// ─── Helpers ───

function rowToEmbedding(row: EmbeddingRow): FridayMemoryEmbedding {
  return {
    id: row.id,
    itemId: row.item_id,
    providerId: row.provider_id,
    model: row.model,
    dimensions: row.dimensions,
    vector: safeJsonParse<number[]>(row.vector_json) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toArray(val: string | string[] | undefined): string[] | undefined {
  if (val === undefined) return undefined;
  return Array.isArray(val) ? val : [val];
}

// ─── Factory ───

export function createFridayMemoryEmbeddingRepository(): FridayMemoryEmbeddingRepository {
  return {
    upsert(db, embedding) {
      // Validate vector (Fix #8)
      if (
        !Array.isArray(embedding.vector) ||
        embedding.vector.length === 0 ||
        !embedding.vector.every((v) => Number.isFinite(v))
      ) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.INVALID_VECTOR,
          "Embedding vector must be a non-empty array of finite numbers",
          { httpStatus: 400 },
        );
      }
      if (embedding.vector.length !== embedding.dimensions) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.INVALID_VECTOR,
          `Embedding vector length (${String(embedding.vector.length)}) does not match declared dimensions (${String(embedding.dimensions)})`,
          { httpStatus: 400 },
        );
      }

      const vectorJson = JSON.stringify(embedding.vector);

      db.prepare(
        `INSERT INTO memory_embeddings (id, item_id, provider_id, model, dimensions, vector_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, provider_id, model) DO UPDATE SET
           id = excluded.id,
           dimensions = excluded.dimensions,
           vector_json = excluded.vector_json,
           updated_at = excluded.updated_at`,
      ).run(
        embedding.id,
        embedding.itemId,
        embedding.providerId,
        embedding.model,
        embedding.dimensions,
        vectorJson,
        embedding.createdAt,
        embedding.updatedAt,
      );
    },

    getByItemId(db, itemId, model) {
      let sql = "SELECT * FROM memory_embeddings WHERE item_id = ?";
      const params: unknown[] = [itemId];

      if (model) {
        sql += " AND model = ?";
        params.push(model);
      }

      sql += " LIMIT 1";

      const row = db.prepare(sql).get(...params) as EmbeddingRow | undefined;
      return row ? rowToEmbedding(row) : null;
    },

    deleteByItemId(db, itemId) {
      const result = db
        .prepare("DELETE FROM memory_embeddings WHERE item_id = ?")
        .run(itemId);
      return result.changes;
    },

    querySimilar(db, input) {
      // Fetch candidate embeddings filtered by model
      const conditions: string[] = ["e.model = ?"];
      const params: unknown[] = [input.model];

      const namespaces = toArray(input.namespace);
      if (namespaces && namespaces.length > 0) {
        conditions.push(`mi.namespace IN (${namespaces.map(() => "?").join(",")})`);
        params.push(...namespaces);
      }

      const sources = toArray(input.source);
      if (sources && sources.length > 0) {
        conditions.push(`mi.source IN (${sources.map(() => "?").join(",")})`);
        params.push(...sources);
      }

      if (input.tagsAny && input.tagsAny.length > 0) {
        const tagConditions = input.tagsAny.map(() => "mi.tags_text LIKE ?");
        conditions.push(`(${tagConditions.join(" OR ")})`);
        params.push(...input.tagsAny.map((t) => `%${t}%`));
      }

      if (!input.includeExpired) {
        conditions.push("(mi.expires_at IS NULL OR mi.expires_at > ?)");
        params.push(input.nowIso);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(input.candidateLimit);

      const sql = `
        SELECT e.item_id, e.vector_json
        FROM memory_embeddings e
        JOIN memory_items mi ON mi.id = e.item_id
        ${where}
        ORDER BY e.updated_at DESC
        LIMIT ?
      `;

      const candidateRows = db.prepare(sql).all(...params) as Array<{
        item_id: string;
        vector_json: string;
      }>;

      // Compute cosine similarity in JS
      const scored: FridayMemorySemanticHit[] = [];
      const minScore = input.minScore ?? 0;

      for (const row of candidateRows) {
        const vector = safeJsonParse<number[]>(row.vector_json);
        if (!vector) {
          // Skip rows with unparseable vector JSON
          continue;
        }

        // Skip invalid/malformed vectors (Fix #8: NaN handling)
        if (
          !Array.isArray(vector) ||
          vector.length === 0 ||
          !vector.every((v) => Number.isFinite(v))
        ) {
          continue;
        }

        const similarity = cosineSimilarity(input.queryVector, vector);

        // Skip NaN scores from malformed data
        if (!Number.isFinite(similarity)) continue;

        if (similarity >= minScore) {
          scored.push({
            itemId: row.item_id,
            score: similarity,
          });
        }
      }

      // Sort by similarity descending, then take limit
      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, input.limit);
    },
  };
}
