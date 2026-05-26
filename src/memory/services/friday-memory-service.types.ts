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

/**
 * B4 / FRI-AUD-006 advisory dedup event. Emitted from `memoryService.store()`
 * AFTER a successful persist when an existing memory in the same namespace
 * scores ≥ threshold against the just-stored candidate.
 *
 * Strictly informational. Per POST_RELEASE_DEFAULT_DECISIONS.md B4 + the
 * 2026-05-26 operator directive: this event NEVER causes Friday to delete,
 * overwrite, merge, or block any user memory. The candidate is already in
 * the durable store by the time the advisory fires. Future product-policy
 * decisions on merge/block semantics remain `policy_pending`.
 */
export interface FridayMemoryDedupAdvisoryEvent {
  kind: "memory.dedup.advisory";
  /** ID of the just-stored candidate memory (the row that triggered the check). */
  candidateItemId: string;
  /** ID of the pre-existing memory the candidate matched against (≠ candidateItemId). */
  existingItemId: string;
  /** Namespace shared by candidate + existing. */
  namespace: FridayMemoryNamespace;
  /** Similarity score of the best match (0–1; from `checkMemoryDuplicate`). */
  bestScore: number;
  /** Threshold used at advisory time (operator-tunable; default 0.92 placeholder). */
  threshold: number;
  /** ISO timestamp at which the candidate was stored. */
  timestamp: string;
}

export type FridayMemoryDedupAdvisorySink = (event: FridayMemoryDedupAdvisoryEvent) => void;

export interface CreateFridayMemoryServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  idGenerator: () => string;
  nowIso: () => string;
  embeddingModel?: string;
  /**
   * B4 / FRI-AUD-006 advisory-only dedup wiring. Optional. If provided,
   * called from `store()` AFTER successful persist when a near-duplicate is
   * detected. The sink MUST NOT throw (the service catches and logs to
   * avoid breaking the store path). The advisory is purely additive; the
   * candidate item is already stored by the time the sink fires.
   */
  dedupAdvisorySink?: FridayMemoryDedupAdvisorySink;
  /**
   * B4 / FRI-AUD-006 dedup-advisory threshold (0–1 similarity score).
   * Placeholder until product policy decides the production value; the
   * default 0.92 matches the dedup helper's default. Affects only the
   * advisory event — never blocks store() and never causes mutation.
   */
  dedupThreshold?: number;
}
