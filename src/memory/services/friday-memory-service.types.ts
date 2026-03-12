import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type {
  FridayMemoryItem,
  FridayMemoryNamespace,
  FridayMemoryPruneOptions,
  FridayMemoryPruneResult,
  FridayMemorySearchQuery,
  FridayMemorySearchResult,
  FridayMemoryStoreInput,
} from "../model/friday-memory.types.js";

export interface FridayMemoryService {
  store(
    namespace: FridayMemoryNamespace,
    content: string,
    metadata?: Omit<FridayMemoryStoreInput, "namespace" | "content">,
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
