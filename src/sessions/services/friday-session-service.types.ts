import type { FridaySqliteLayer } from "#state";

import type {
  FridaySessionCreateInput,
  FridaySessionForkCreateInput,
  FridaySessionForkCreateResult,
  FridaySessionForkListInput,
  FridaySessionForkMergeInput,
  FridaySessionForkMergeResult,
  FridaySessionListInput,
  FridaySessionMessageInput,
  FridaySessionMessageRecord,
  FridaySessionPruneResult,
  FridaySessionRecord,
  FridaySessionSendPolicy,
} from "../model/friday-session.types.js";

export interface FridaySessionService {
  createSession(input: FridaySessionCreateInput): Promise<FridaySessionRecord>;
  listSessions(input: FridaySessionListInput): Promise<FridaySessionRecord[]>;
  getSession(key: string): Promise<FridaySessionRecord | null>;
  getOrCreateSession(key: string): Promise<FridaySessionRecord>;
  addMessage(key: string, message: FridaySessionMessageInput): Promise<FridaySessionMessageRecord>;
  getMessages(key: string, limit?: number, before?: string): Promise<FridaySessionMessageRecord[]>;
  archiveSession(key: string): Promise<FridaySessionRecord>;
  pruneOldSessions(olderThan: string): Promise<FridaySessionPruneResult>;
  sweepLifecycle(): Promise<FridaySessionSweepResult>;
  getSessionMemoryNamespace(key: string): Promise<string>;
  forkSession(parentKey: string, input?: FridaySessionForkCreateInput): Promise<FridaySessionForkCreateResult>;
  listForks(parentKey: string, input?: FridaySessionForkListInput): Promise<FridaySessionRecord[]>;
  mergeForkSummary(parentKey: string, input: FridaySessionForkMergeInput): Promise<FridaySessionForkMergeResult>;
  /** Reset a session: delete all messages and reset token/message counters. */
  resetSession(key: string): Promise<FridaySessionRecord>;
  /** Set the send policy for a session. Pass undefined/null to clear. */
  setSendPolicy(key: string, policy: FridaySessionSendPolicy | null): Promise<FridaySessionRecord>;
  /** Resolve the effective send policy for a session (session override > default "allow"). */
  evaluateSendPolicy(key: string): Promise<FridaySessionSendPolicy>;
}

export interface FridaySessionSweepResult {
  idledCount: number;
  archivedCount: number;
  prunedCount: number;
  hardDeletedCount: number;
}

export interface CreateFridaySessionServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}
