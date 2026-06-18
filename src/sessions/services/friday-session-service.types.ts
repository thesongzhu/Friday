import type { FridaySqliteLayer } from "#state";

import type {
  FridaySessionConversationFocusState,
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
  updateMessageMetadataByIdempotency(
    key: string,
    input: {
      idempotencyKey: string;
      metadataPatch: Record<string, unknown>;
    },
  ): Promise<FridaySessionMessageRecord | null>;
  getMessages(key: string, limit?: number, before?: string): Promise<FridaySessionMessageRecord[]>;
  archiveSession(key: string): Promise<FridaySessionRecord>;
  pruneOldSessions(olderThan: string): Promise<FridaySessionPruneResult>;
  sweepLifecycle(): Promise<FridaySessionSweepResult>;
  getSessionMemoryNamespace(key: string): Promise<string>;
  /**
   * Resolve the ORDERED, DEDUPED set of namespaces to consult on the READ (recall)
   * path. Hardening OFF (default): `[legacy]` (one entry, byte-identical to today).
   * Hardening ON: `[hardened, legacy]` deduped — dual-read so memory written under
   * the legacy namespace is still recalled (no destructive re-key). See
   * {@link resolveFridaySessionMemoryNamespaceCandidates}.
   */
  getSessionMemoryNamespaceCandidates(key: string): Promise<string[]>;
  forkSession(parentKey: string, input?: FridaySessionForkCreateInput): Promise<FridaySessionForkCreateResult>;
  listForks(parentKey: string, input?: FridaySessionForkListInput): Promise<FridaySessionRecord[]>;
  mergeForkSummary(parentKey: string, input: FridaySessionForkMergeInput): Promise<FridaySessionForkMergeResult>;
  /** Reset a session: delete all messages and reset token/message counters. */
  resetSession(key: string): Promise<FridaySessionRecord>;
  /** Set the send policy for a session. Pass undefined/null to clear. */
  setSendPolicy(key: string, policy: FridaySessionSendPolicy | null): Promise<FridaySessionRecord>;
  /** Resolve the effective send policy for a session (session override > default "allow"). */
  evaluateSendPolicy(key: string): Promise<FridaySessionSendPolicy>;
  /** Read the persisted conversation focus state for a session. */
  getConversationFocus(key: string): Promise<FridaySessionConversationFocusState | null>;
  /** Persist or clear the conversation focus state for a session. */
  setConversationFocus(
    key: string,
    focusState: FridaySessionConversationFocusState | null,
  ): Promise<FridaySessionRecord>;
  /** Merge top-level metadata keys into the persisted session metadata document. */
  mergeMetadata(key: string, metadataPatch: Record<string, unknown>): Promise<FridaySessionRecord>;
  /** Align persisted tenant/user context for an existing session and recalculate memory namespace. */
  alignSessionContext(
    key: string,
    input: {
      accountId?: string;
      userId?: string;
    },
  ): Promise<FridaySessionRecord>;
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
  /**
   * TS Runtime Retirement (TS-R4/G3) — METHOD-level fail-closed guard for every
   * legacy TypeScript session write leg. Default/live runtime must leave this
   * unset so session creation, message append/update, lifecycle sweep, fork,
   * merge, reset, metadata/focus/policy updates, context alignment, pruning, and
   * boot-time legacy backfill all fail closed for ALL callers — including
   * schedulers and off-route handlers that bypass the HTTP route guard
   * (`assertSessionTestOracleAllowed` in friday-session-routes). Test-oracle
   * harnesses set it `true` to exercise the legacy in-process mutators. Reads
   * stay live.
   */
  allowTestOnlySessionExecution?: boolean;
}
