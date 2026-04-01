export type FridayMemoryNamespace = string;

// ─── Memory type classification (Initiative D.1) ───

/**
 * Classifies what kind of knowledge a memory item represents.
 *
 * - fact: objective information (API keys, config values, URLs, technical facts)
 * - preference: user preferences, style choices, workflow preferences
 * - procedure: how-to knowledge, step sequences, operational procedures
 * - episode: a specific past event or interaction outcome
 * - correction: explicit user correction of a prior agent response
 */
export type FridayMemoryType =
  | "fact"
  | "preference"
  | "procedure"
  | "episode"
  | "correction";

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
  /** Semantic type of this memory. */
  memoryType?: FridayMemoryType;
  /** Confidence score (0.0–1.0). Higher = more reliable. */
  confidence?: number;
  /** Number of times this memory has been retrieved. */
  accessCount?: number;
  /** ISO timestamp of last retrieval. */
  lastAccessedAt?: string;
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
  /** Filter by memory type (Initiative D.1). */
  memoryType?: FridayMemoryType | FridayMemoryType[];
  /** Boost results by confidence score. Default: false. */
  boostByConfidence?: boolean;
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
  /** Semantic type of this memory (Initiative D.1). */
  memoryType?: FridayMemoryType;
  /** Initial confidence score (0.0–1.0). Default: 1.0 for user-supplied, 0.8 for extracted. */
  confidence?: number;
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
