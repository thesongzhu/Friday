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
