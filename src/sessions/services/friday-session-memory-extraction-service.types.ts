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
   * TS Runtime Retirement (TS-R4/G3) — METHOD-level fail-closed guard for the
   * memory-extraction mutators (`extractFromSession`, `extractSpecificMessages`,
   * `retryFailedExtractions`). Default/live runtime must leave this unset so
   * these methods fail closed for ALL callers — including the
   * `session-memory-extraction` worker job and the `session-lifecycle-sweep`
   * job (both bypass the HTTP route guard
   * `assertSessionMemoryExtractionTestOracleAllowed`), plus the agent
   * memory-extract tool. Guarding here stops the armed, quota-spending inline
   * extraction (worker → inline → processInline → LLM provider call) before any
   * provider call or memory/job DB write. Test-oracle harnesses set it `true` to
   * exercise the legacy extraction. `getExtractionStatus` (read) stays live;
   * only the mutators are retired, mirroring the route surface.
   */
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
}
