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
}
