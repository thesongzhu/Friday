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
  matchedBy: Array<"fts" | "semantic" | "substring">;
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
