import type {
  FridaySessionMemoryExtractionRunResult,
  FridaySessionMemoryExtractionStatus,
  FridaySessionMemoryExtractionTrigger,
  FridaySessionMemoryRetryResult,
} from "../model/friday-session-memory-extraction.types.js";
import type { FridaySqliteLayer } from "#state";
import type { FridaySessionService } from "./friday-session-service.types.js";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";

export interface FridaySessionMemoryExtractionService {
  extractFromSession(
    sessionKey: string,
    options?: {
      trigger?: FridaySessionMemoryExtractionTrigger;
      mode?: "queue" | "inline";
      batchSize?: number;
      maxBatches?: number;
    },
  ): Promise<FridaySessionMemoryExtractionRunResult>;

  extractSpecificMessages(
    sessionKey: string,
    messageIds: string[],
    options?: {
      mode?: "queue" | "inline";
    },
  ): Promise<FridaySessionMemoryExtractionRunResult>;

  getExtractionStatus(sessionKey: string): Promise<FridaySessionMemoryExtractionStatus>;

  retryFailedExtractions(sessionKey?: string): Promise<FridaySessionMemoryRetryResult>;
}

export interface CreateFridaySessionMemoryExtractionServiceDeps {
  db: FridaySqliteLayer;
  sessionService: FridaySessionService;
  memoryService: FridayMemoryService;
  providerService: FridayProviderService;
  idGenerator: () => string;
  nowIso: () => string;
  /**
   * Test-oracle ONLY. When not explicitly `true`, the three session-memory
   * extraction mutators (`extractFromSession`, `extractSpecificMessages`,
   * `retryFailedExtractions`) fail closed at the METHOD boundary (not just the
   * HTTP route), so every non-route caller — the session lifecycle job, the
   * dedicated memory-extraction job, and the agent memory-extract tool — is
   * fenced out of TS session-memory extraction while runtime ownership is moved
   * to Rust. Production hub bootstrap and the route-fallback runtime leave this
   * unset → fail-closed. Mirrors the route-level
   * `allowTestOnlySessionMemoryExtractionExecution` guard
   * (`assertSessionMemoryExtractionTestOracleAllowed` in
   * `friday-session-routes.ts`) so both layers honor the same flag. Read-only
   * `getExtractionStatus` stays live and is never gated by this flag.
   */
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
}
