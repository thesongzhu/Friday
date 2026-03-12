# Friday Memory Core Design

## Constants (`src/memory/friday-memory.constants.ts`)
```ts
export const FRIDAY_MEMORY_FTS_TABLE = "memory_items_fts";
export const FRIDAY_MEMORY_EMBEDDINGS_TABLE = "memory_embeddings";

export const FRIDAY_MEMORY_DEFAULT_LIMIT = 20;
export const FRIDAY_MEMORY_MAX_LIMIT = 100;
export const FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT = 250;

export const FRIDAY_MEMORY_DEFAULT_FTS_WEIGHT = 0.45;
export const FRIDAY_MEMORY_DEFAULT_SEMANTIC_WEIGHT = 0.55;

export const FRIDAY_MEMORY_DEFAULT_SOURCE = "system";
export const FRIDAY_MEMORY_DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d

export const FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export const FRIDAY_MEMORY_ERROR_CODES = {
  NOT_FOUND: "MEMORY_NOT_FOUND",
  EMBEDDING_UNAVAILABLE: "MEMORY_EMBEDDING_UNAVAILABLE",
  EMBEDDING_UNSUPPORTED_PROVIDER: "MEMORY_EMBEDDING_UNSUPPORTED_PROVIDER",
  SEARCH_EMPTY_QUERY: "MEMORY_SEARCH_EMPTY_QUERY",
} as const;
```

## Types (`src/memory/model/friday-memory.types.ts`)
```ts
export type FridayMemoryNamespace = string;

export interface FridayMemoryItem {
  id: string;
  namespace: FridayMemoryNamespace;
  key: string; // compatibility with existing v001 schema
  content: string;
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
  ttlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayMemoryEmbedding {
  id: string;
  itemId: string;
  providerId: string;
  model: string;
  dimensions: number;
  vector: number[];
  createdAt: string;
  updatedAt: string;
}

export interface FridayMemorySearchQuery {
  text: string;
  namespace?: FridayMemoryNamespace | FridayMemoryNamespace[];
  source?: string | string[];
  tagsAny?: string[];
  tagsAll?: string[];
  includeExpired?: boolean;
  limit?: number;
  minScore?: number;
  weights?: {
    fts: number;
    semantic: number;
  };
}

export interface FridayMemorySearchResult {
  item: FridayMemoryItem;
  score: number;
  ftsScore: number;
  semanticScore: number;
  matchedBy: Array<"fts" | "semantic">;
  snippet: string;
}

export interface FridayMemoryStoreInput {
  namespace: FridayMemoryNamespace;
  content: string;
  source?: string;
  key?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  expiresAt?: string;
}

export interface FridayMemoryPruneOptions {
  namespace?: FridayMemoryNamespace | FridayMemoryNamespace[];
  source?: string | string[];
  tagsAny?: string[];
  expiredOnly?: boolean;
  olderThan?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface FridayMemoryPruneResult {
  deletedCount: number;
  deletedIds: string[];
  dryRun: boolean;
}

export interface FridayMemoryFtsHit {
  itemId: string;
  score: number;
  snippet: string;
}

export interface FridayMemorySemanticHit {
  itemId: string;
  score: number;
}
```

## SQL DDL (`src/state/sqlite/migrations/v004-memory-core.ts`)
```ts
import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V004_MEMORY_CORE_SQL = `
-- ============================================================
-- V004: Core memory storage + hybrid search
-- Extends existing v001 memory_items table for compatibility.
-- ============================================================

ALTER TABLE memory_items ADD COLUMN content_text TEXT;
ALTER TABLE memory_items ADD COLUMN source TEXT NOT NULL DEFAULT 'system';
ALTER TABLE memory_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_items ADD COLUMN ttl_seconds INTEGER;
ALTER TABLE memory_items ADD COLUMN expires_at TEXT;
ALTER TABLE memory_items ADD COLUMN tags_text TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_updated
  ON memory_items(namespace, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_source_updated
  ON memory_items(source, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_expires_at
  ON memory_items(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, provider_id, model)
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_item
  ON memory_embeddings(item_id);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
  ON memory_embeddings(model);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model_updated
  ON memory_embeddings(model, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts
USING fts5(
  content_text,
  tags_text,
  namespace UNINDEXED,
  source UNINDEXED,
  content='memory_items',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_insert
AFTER INSERT ON memory_items
BEGIN
  INSERT INTO memory_items_fts(rowid, content_text, tags_text, namespace, source)
  VALUES (
    NEW.rowid,
    COALESCE(NEW.content_text, ''),
    COALESCE(NEW.tags_text, ''),
    NEW.namespace,
    NEW.source
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_update
AFTER UPDATE OF content_text, tags_text, namespace, source ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content_text, tags_text, namespace, source)
  VALUES ('delete', OLD.rowid, OLD.content_text, OLD.tags_text, OLD.namespace, OLD.source);

  INSERT INTO memory_items_fts(rowid, content_text, tags_text, namespace, source)
  VALUES (
    NEW.rowid,
    COALESCE(NEW.content_text, ''),
    COALESCE(NEW.tags_text, ''),
    NEW.namespace,
    NEW.source
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_delete
AFTER DELETE ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content_text, tags_text, namespace, source)
  VALUES ('delete', OLD.rowid, OLD.content_text, OLD.tags_text, OLD.namespace, OLD.source);
END;
`;

const V004_CHECKSUM = computeFridayMigrationChecksum(V004_MEMORY_CORE_SQL);

export const V004_MEMORY_CORE_MIGRATION: FridaySqliteMigration = {
  version: 4,
  name: "v004-memory-core",
  sql: V004_MEMORY_CORE_SQL,
  checksum: V004_CHECKSUM,
};
```

## Repository Interfaces

### `src/memory/persistence/friday-memory-item-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayMemoryFtsHit,
  FridayMemoryItem,
  FridayMemoryNamespace,
  FridayMemoryPruneOptions,
  FridayMemorySearchQuery,
} from "../model/friday-memory.types.js";

export interface FridayMemoryItemRepository {
  insert(db: Database.Database, item: FridayMemoryItem): void;
  getById(db: Database.Database, id: string): FridayMemoryItem | null;
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
}

export function createFridayMemoryItemRepository(): FridayMemoryItemRepository;
```

### `src/memory/persistence/friday-memory-embedding-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayMemoryEmbedding,
  FridayMemoryNamespace,
  FridayMemorySemanticHit,
} from "../model/friday-memory.types.js";

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

export function createFridayMemoryEmbeddingRepository(): FridayMemoryEmbeddingRepository;
```

## Memory Service (`src/memory/services/friday-memory-service.types.ts`)
```ts
import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type {
  FridayMemoryItem,
  FridayMemoryNamespace,
  FridayMemoryPruneOptions,
  FridayMemoryPruneResult,
  FridayMemorySearchQuery,
  FridayMemorySearchResult,
} from "../model/friday-memory.types.js";

export interface FridayMemoryService {
  store(
    namespace: FridayMemoryNamespace,
    content: string,
    metadata?: Omit<
      import("../model/friday-memory.types.js").FridayMemoryStoreInput,
      "namespace" | "content"
    >,
  ): Promise<FridayMemoryItem>;

  search(
    query: string,
    options?: Omit<FridayMemorySearchQuery, "text">,
  ): Promise<FridayMemorySearchResult[]>;

  get(itemId: string): Promise<FridayMemoryItem | null>;

  list(input?: {
    namespace?: FridayMemoryNamespace | FridayMemoryNamespace[];
    source?: string | string[];
    tagsAny?: string[];
    includeExpired?: boolean;
    limit?: number;
  }): Promise<FridayMemoryItem[]>;

  delete(itemId: string): Promise<boolean>;

  prune(options?: FridayMemoryPruneOptions): Promise<FridayMemoryPruneResult>;
}

export interface CreateFridayMemoryServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  idGenerator: () => string;
  nowIso: () => string;
  embeddingModel?: string;
}

export function createFridayMemoryService(
  deps: CreateFridayMemoryServiceDeps,
): FridayMemoryService;
```

### Service behavior (core)
1. `store`: validate input; write `memory_items`; attempt BYOK embedding via provider; if embedding fails, do not fail store (graceful fallback).
2. `search`: run FTS always; attempt semantic query embedding + cosine similarity; merge by `itemId` with weighted score; if semantic path fails, return FTS-only.
3. `get/list/delete/prune`: use repositories; `delete` cascades embeddings via FK; prune deletes expired and optional `olderThan` rows.

### BYOK embedding adapter
- Factory: `createFridayMemoryByokEmbeddingClient(...)`.
- Uses `providerService.runWithFallback(...)`.
- Supports provider APIs with embedding endpoints; unsupported APIs throw `FridayDomainError`.
- Errors from embed path are caught by memory service and downgraded to FTS-only behavior.

## API Contracts + Endpoints

### `src/api/model/friday-api-memory.types.ts`
```ts
import type {
  FridayMemoryItem,
  FridayMemoryPruneOptions,
  FridayMemoryPruneResult,
  FridayMemorySearchResult,
  FridayMemoryStoreInput,
} from "#memory";

export interface FridayMemoryStoreRequest extends FridayMemoryStoreInput {}
export interface FridayMemoryStoreResponse {
  item: FridayMemoryItem;
}

export interface FridayMemorySearchRequest {
  query: string;
  namespace?: string | string[];
  source?: string | string[];
  tagsAny?: string[];
  tagsAll?: string[];
  includeExpired?: boolean;
  limit?: number;
  minScore?: number;
  weights?: { fts: number; semantic: number };
}
export interface FridayMemorySearchResponse {
  items: FridayMemorySearchResult[];
}

export interface FridayGetMemoryItemResponse {
  item: FridayMemoryItem;
}

export interface FridayListMemoryItemsResponse {
  items: FridayMemoryItem[];
}

export interface FridayDeleteMemoryItemResponse {
  deleted: true;
}

export interface FridayMemoryPruneRequest extends FridayMemoryPruneOptions {}
export interface FridayMemoryPruneResponse {
  result: FridayMemoryPruneResult;
}
```

### `src/api/http/routes/friday-memory-routes.ts`
```ts
export function createFridayMemoryRoutes(
  deps: { memoryService: FridayMemoryService },
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    { operationId: "memory.store",  method: "POST",   path: "/v1/memory/store",      auth: { public: false, anyOfScopes: ["hub.admin"] }, handler: ... },
    { operationId: "memory.search", method: "POST",   path: "/v1/memory/search",     auth: { public: false, anyOfScopes: ["hub.admin"] }, handler: ... },
    { operationId: "memory.get",    method: "GET",    path: "/v1/memory/items/:id",  auth: { public: false, anyOfScopes: ["hub.admin"] }, handler: ... },
    { operationId: "memory.list",   method: "GET",    path: "/v1/memory/items",      auth: { public: false, anyOfScopes: ["hub.admin"] }, handler: ... },
    { operationId: "memory.delete", method: "DELETE", path: "/v1/memory/items/:id",  auth: { public: false, anyOfScopes: ["hub.admin"] }, handler: ... },
    { operationId: "memory.prune",  method: "POST",   path: "/v1/memory/prune",      auth: { public: false, anyOfScopes: ["hub.admin"] }, handler: ... },
  ];
}
```

## File Plan
1. `src/memory/friday-memory.constants.ts`
2. `src/memory/model/friday-memory.types.ts`
3. `src/memory/search/friday-memory-hybrid.ts`
4. `src/memory/persistence/friday-memory-item-repository.ts`
5. `src/memory/persistence/friday-memory-embedding-repository.ts`
6. `src/memory/services/friday-memory-byok-embedding-client.ts`
7. `src/memory/services/friday-memory-service.types.ts`
8. `src/memory/services/friday-memory-service.ts`
9. `src/memory/index.ts`
10. `src/state/sqlite/migrations/v004-memory-core.ts`
11. `src/state/sqlite/migrations/index.ts` (append v004)
12. `src/api/model/friday-api-memory.types.ts`
13. `src/api/http/routes/friday-memory-routes.ts`
14. `src/api/runtime/friday-api-runtime.types.ts` (add `memoryService`)
15. `src/api/runtime/friday-api-runtime.ts` (register memory routes)
16. `src/api/index.ts` (export memory API types/routes)
17. `package.json` imports: add `"#memory": "./dist/memory/index.js"`

## Test Plan (7 files)
1. `test/unit/state/sqlite/v004-memory-core-schema.test.ts` — new columns, `memory_embeddings`, FTS table, triggers, cascade delete, migration record.
2. `test/unit/memory/persistence/friday-memory-item-repository.test.ts` — CRUD, namespace/source/tag filters, FTS scoring/snippets, TTL exclusion, prune behavior.
3. `test/unit/memory/persistence/friday-memory-embedding-repository.test.ts` — upsert/get/delete, cosine ranking, filter + candidate limits.
4. `test/unit/memory/services/friday-memory-service.test.ts` — store with embedding success, store with embedding failure fallback, hybrid merge, FTS-only fallback, delete/prune flow.
5. `test/unit/memory/services/friday-memory-byok-embedding-client.test.ts` — endpoint mapping per provider API, parse responses, unsupported-provider error handling.
6. `test/unit/api/http/routes/friday-memory-routes.test.ts` — route definitions, auth scopes, request validation, handler/service wiring.
7. `test/unit/api/runtime/friday-api-runtime-memory-registration.test.ts` — runtime registers memory routes and keeps route operation IDs unique.
