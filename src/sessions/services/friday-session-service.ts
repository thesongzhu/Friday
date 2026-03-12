import { FridayDomainError } from "#errors";

import { randomUUID } from "node:crypto";

import {
  FRIDAY_SESSION_ARCHIVE_TIMEOUT_MS,
  FRIDAY_SESSION_DEFAULT_MESSAGE_LIMIT,
  FRIDAY_SESSION_ERROR_CODES,
  FRIDAY_SESSION_FORK_DEFAULT_ARCHIVE_ON_MERGE,
  FRIDAY_SESSION_FORK_DEFAULT_CONTEXT_MESSAGE_COUNT,
  FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT,
  FRIDAY_SESSION_FORK_TIMEOUT_MS,
  FRIDAY_SESSION_HARD_DELETE_TIMEOUT_MS,
  FRIDAY_SESSION_IDLE_TIMEOUT_MS,
  FRIDAY_SESSION_MAX_MESSAGE_LIMIT,
  FRIDAY_SESSION_PRUNE_TIMEOUT_MS,
} from "../friday-session.constants.js";
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
} from "../model/friday-session.types.js";
import { createFridaySessionRepository } from "../persistence/friday-session-repository.js";
import { createFridaySessionMessageRepository } from "../persistence/friday-session-message-repository.js";
import { buildFridaySubagentSessionKey, canonicalizeFridaySessionKey, normalizeFridaySessionKey, parseFridaySessionKey } from "./friday-session-key.js";
import { resolveFridaySessionMemoryNamespace } from "./friday-session-memory-namespace.js";
import { resolveFridaySessionSendPolicy } from "./friday-session-send-policy.js";
import type { CreateFridaySessionServiceDeps, FridaySessionService, FridaySessionSweepResult } from "./friday-session-service.types.js";

// ─── Factory ───

export function createFridaySessionService(
  deps: CreateFridaySessionServiceDeps,
): FridaySessionService {
  const sessionRepo = createFridaySessionRepository();
  const messageRepo = createFridaySessionMessageRepository();

  /** Walk parent chain to find rootSessionKey. */
  function resolveRootSessionKey(parentKey: string): string {
    const parentSession = deps.db.withReadConnection((db) => sessionRepo.getByKey(db, parentKey));
    if (parentSession?.rootSessionKey) {
      return parentSession.rootSessionKey;
    }
    // If parent doesn't exist yet or has no root, walk up via key parsing
    const parentParts = parseFridaySessionKey(parentKey);
    if (parentParts.kind === "subagent" && parentParts.parentKey) {
      return resolveRootSessionKey(parentParts.parentKey);
    }
    // The parent is a conversation key — it is the root
    return parentKey;
  }

  return {
    async createSession(input: FridaySessionCreateInput) {
      const normalizedKey = normalizeFridaySessionKey({
        channel: input.channel,
        chatId: input.chatId,
        userId: input.userId,
        accountId: input.accountId,
        chatKind: input.chatKind,
      });

      const parts = parseFridaySessionKey(normalizedKey);

      // Resolve subagent lineage
      let parentSessionKey: string | undefined;
      let rootSessionKey: string | undefined;

      if (parts.kind === "subagent" && parts.parentKey) {
        parentSessionKey = parts.parentKey;
        rootSessionKey = resolveRootSessionKey(parts.parentKey);
      }

      const now = deps.nowIso();
      const session = deps.db.withWriteTransaction((db) => {
        const newSession = sessionRepo.insert(db, {
          key: normalizedKey,
          channel: input.channel,
          chatId: input.chatId,
          userId: input.userId,
          accountId: input.accountId,
          chatKind: input.chatKind ?? "dm",
          sendPolicy: input.sendPolicy,
          metadata: input.metadata,
          nowIso: now,
          idGenerator: deps.idGenerator,
        });

        // Set lineage fields if subagent
        if (parentSessionKey || rootSessionKey) {
          db.prepare(
            "UPDATE sessions SET parent_session_key = ?, root_session_key = ? WHERE id = ?",
          ).run(
            parentSessionKey ?? null,
            rootSessionKey ?? newSession.key,
            newSession.id,
          );
          return {
            ...newSession,
            parentSessionKey,
            rootSessionKey: rootSessionKey ?? newSession.key,
          };
        }

        return newSession;
      });

      return session;
    },

    async listSessions(input: FridaySessionListInput) {
      return deps.db.withReadConnection((db) => sessionRepo.list(db, input));
    },

    async getSession(key) {
      const canonicalKey = canonicalizeFridaySessionKey(key);
      return deps.db.withReadConnection((db) => sessionRepo.getByKey(db, canonicalKey));
    },

    async getOrCreateSession(key) {
      key = canonicalizeFridaySessionKey(key);
      const parts = parseFridaySessionKey(key);

      const existing = deps.db.withReadConnection((db) => sessionRepo.getByKey(db, key));
      if (existing) {
        // Re-activate if idle
        if (existing.status === "idle") {
          const reactivated = deps.db.withWriteTransaction((db) =>
            sessionRepo.updateStatus(db, {
              key,
              from: ["idle"],
              to: "active",
              nowIso: deps.nowIso(),
            }),
          );
          return reactivated ?? existing;
        }
        return existing;
      }

      const now = deps.nowIso();
      let memoryNamespace: string | undefined;

      // Resolve subagent lineage
      let parentSessionKey: string | undefined;
      let rootSessionKey: string | undefined;

      if (parts.kind === "subagent" && parts.parentKey) {
        parentSessionKey = parts.parentKey;
        rootSessionKey = resolveRootSessionKey(parts.parentKey);
      }

      const session = deps.db.withWriteTransaction((db) => {
        const newSession = sessionRepo.insert(db, {
          key,
          channel: parts.channel ?? "unknown",
          chatId: parts.chatId ?? "unknown",
          accountId: parts.accountId,
          chatKind: "dm",
          nowIso: now,
          memoryNamespace,
          idGenerator: deps.idGenerator,
        });

        const updates: string[] = [];
        const params: unknown[] = [];

        // Set lineage fields if subagent
        if (parentSessionKey) {
          updates.push("parent_session_key = ?");
          params.push(parentSessionKey);
        }
        if (rootSessionKey) {
          updates.push("root_session_key = ?");
          params.push(rootSessionKey);
        }

        // Try to resolve memory namespace after creation
        try {
          memoryNamespace = resolveFridaySessionMemoryNamespace(newSession, (k) =>
            sessionRepo.getByKey(db, k),
          );
          if (memoryNamespace) {
            updates.push("memory_namespace = ?");
            params.push(memoryNamespace);
          }
        } catch {
          // Memory namespace resolution is best-effort for getOrCreate
        }

        if (updates.length > 0) {
          params.push(newSession.id);
          db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...params);
        }

        return {
          ...newSession,
          memoryNamespace,
          parentSessionKey,
          rootSessionKey: rootSessionKey ?? newSession.rootSessionKey,
        };
      });

      return session;
    },

    async addMessage(key, message) {
      key = canonicalizeFridaySessionKey(key);

      // Validate message
      if (!message.role) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
          "Message role is required",
          { httpStatus: 400 },
        );
      }

      const validRoles = ["system", "user", "assistant", "tool"];
      if (!validRoles.includes(message.role)) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
          `Invalid message role: '${message.role}'`,
          { httpStatus: 400 },
        );
      }

      const now = deps.nowIso();
      const contentJson = typeof message.content === "string"
        ? JSON.stringify(message.content)
        : JSON.stringify(message.content);
      const contentText = message.contentText ?? (typeof message.content === "string" ? message.content : JSON.stringify(message.content));
      const tokenCount = message.tokenCount ?? 0;

      return deps.db.withWriteTransaction((db) => {
        // Get or create session
        let session = sessionRepo.getByKey(db, key);
        if (!session) {
          const parts = parseFridaySessionKey(key);
          session = sessionRepo.insert(db, {
            key,
            channel: parts.channel ?? "unknown",
            chatId: parts.chatId ?? "unknown",
            accountId: parts.accountId,
            chatKind: "dm",
            nowIso: now,
            idGenerator: deps.idGenerator,
          });

          // Resolve subagent lineage for auto-created sessions
          if (parts.kind === "subagent" && parts.parentKey) {
            const parentSessionKey = parts.parentKey;
            const rootSessionKey = resolveRootSessionKey(parts.parentKey);

            const updates: string[] = [];
            const params: unknown[] = [];

            updates.push("parent_session_key = ?");
            params.push(parentSessionKey);
            updates.push("root_session_key = ?");
            params.push(rootSessionKey);

            // Try to resolve memory namespace
            try {
              const memoryNamespace = resolveFridaySessionMemoryNamespace(session, (k) =>
                sessionRepo.getByKey(db, k),
              );
              if (memoryNamespace) {
                updates.push("memory_namespace = ?");
                params.push(memoryNamespace);
              }
            } catch {
              // Memory namespace resolution is best-effort
            }

            if (updates.length > 0) {
              params.push(session.id);
              db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...params);
              session = {
                ...session,
                parentSessionKey,
                rootSessionKey,
              };
            }
          }
        }

        // Re-activate if not active
        if (session.status !== "active") {
          sessionRepo.updateStatus(db, {
            key,
            to: "active",
            nowIso: now,
          });
        }

        // Append message
        const { record, isNew } = messageRepo.append(db, {
          sessionId: session.id,
          sessionKey: key,
          role: message.role,
          contentJson,
          contentText,
          toolCallsJson: message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
          tokenCount,
          idempotencyKey: message.idempotencyKey,
          parentMessageId: message.parentMessageId,
          metadataJson: JSON.stringify(message.metadata ?? {}),
          occurredAt: message.timestamp ?? now,
          nowIso: now,
          idGenerator: deps.idGenerator,
        });

        // Only touch activity for new inserts, not idempotent duplicates
        if (isNew) {
          sessionRepo.touchActivity(db, {
            key,
            nowIso: now,
            tokenDelta: { input: 0, output: 0, total: tokenCount },
            messageDelta: 1,
          });
        }

        return record;
      });
    },

    async getMessages(key, limit, before) {
      key = canonicalizeFridaySessionKey(key);

      const effectiveLimit = Math.min(
        limit ?? FRIDAY_SESSION_DEFAULT_MESSAGE_LIMIT,
        FRIDAY_SESSION_MAX_MESSAGE_LIMIT,
      );

      return deps.db.withReadConnection((db) =>
        messageRepo.listBySessionKey(db, {
          sessionKey: key,
          limit: effectiveLimit,
          before,
        }),
      );
    },

    async archiveSession(key) {
      key = canonicalizeFridaySessionKey(key);

      const now = deps.nowIso();
      const session = deps.db.withWriteTransaction((db) =>
        sessionRepo.updateStatus(db, {
          key,
          from: ["active", "idle"],
          to: "archived",
          nowIso: now,
        }),
      );

      if (!session) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.INVALID_STATUS_TRANSITION,
          `Cannot archive session '${key}': not found or not in active/idle status`,
          { httpStatus: 409 },
        );
      }

      return session;
    },

    async pruneOldSessions(olderThan) {
      if (!olderThan) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
          "olderThan timestamp is required for pruning",
          { httpStatus: 400 },
        );
      }

      return deps.db.withWriteTransaction((db) => {
        // Mark archived sessions as pruned
        const sessionKeys = sessionRepo.markPrunedCandidates(db, {
          olderThanIso: olderThan,
          nowIso: deps.nowIso(),
        });

        // Hard-delete pruned sessions older than the hard-delete threshold
        const hardDeleteThresholdMs = new Date(olderThan).getTime() - FRIDAY_SESSION_HARD_DELETE_TIMEOUT_MS;
        const hardDeleteBeforeIso = new Date(hardDeleteThresholdMs).toISOString();
        const hardDeletedCount = sessionRepo.hardDeletePruned(db, {
          hardDeleteBeforeIso,
        });

        return {
          archivedToPrunedCount: sessionKeys.length,
          hardDeletedCount,
          sessionKeys,
        } satisfies FridaySessionPruneResult;
      });
    },

    async sweepLifecycle(): Promise<FridaySessionSweepResult> {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();

      return deps.db.withWriteTransaction((db) => {
        // 0. Fork timeout: archive forks inactive for > fork timeout
        const forkTimeoutBeforeIso = new Date(nowMs - FRIDAY_SESSION_FORK_TIMEOUT_MS).toISOString();
        const forkArchivedCount = sessionRepo.markForkArchivedCandidates(db, {
          forkTimeoutBeforeIso,
          nowIso: now,
        });

        // 1. active → idle (inactive for > idle timeout)
        const idleBeforeIso = new Date(nowMs - FRIDAY_SESSION_IDLE_TIMEOUT_MS).toISOString();
        const idledCount = sessionRepo.markIdleCandidates(db, {
          idleBeforeIso,
          nowIso: now,
        });

        // 2. idle → archived (idle for > archive timeout)
        const archiveBeforeIso = new Date(nowMs - FRIDAY_SESSION_ARCHIVE_TIMEOUT_MS).toISOString();
        const archivedCount = sessionRepo.markArchivedCandidates(db, {
          archiveBeforeIso,
          nowIso: now,
        });

        // 3. archived → pruned (archived for > prune timeout)
        const pruneBeforeIso = new Date(nowMs - FRIDAY_SESSION_PRUNE_TIMEOUT_MS).toISOString();
        const prunedKeys = sessionRepo.markPrunedCandidates(db, {
          olderThanIso: pruneBeforeIso,
          nowIso: now,
        });

        // 4. hard-delete pruned (pruned for > hard-delete timeout)
        const hardDeleteBeforeIso = new Date(nowMs - FRIDAY_SESSION_HARD_DELETE_TIMEOUT_MS).toISOString();
        const hardDeletedCount = sessionRepo.hardDeletePruned(db, {
          hardDeleteBeforeIso,
        });

        return {
          idledCount,
          archivedCount: archivedCount + forkArchivedCount,
          prunedCount: prunedKeys.length,
          hardDeletedCount,
        };
      });
    },

    async getSessionMemoryNamespace(key) {
      key = canonicalizeFridaySessionKey(key);

      const session = deps.db.withReadConnection((db) => sessionRepo.getByKey(db, key));
      if (!session) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
          `Session '${key}' not found`,
          { httpStatus: 404 },
        );
      }

      if (session.memoryNamespace) {
        return session.memoryNamespace;
      }

      return resolveFridaySessionMemoryNamespace(session, (k) =>
        deps.db.withReadConnection((db) => sessionRepo.getByKey(db, k)),
      );
    },

    async forkSession(parentKey, input) {
      parentKey = canonicalizeFridaySessionKey(parentKey);

      const taskId = input?.taskId ?? randomUUID().slice(0, 8);
      const inheritMessageCount = Math.min(
        input?.inheritMessageCount ?? FRIDAY_SESSION_FORK_DEFAULT_CONTEXT_MESSAGE_COUNT,
        FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT,
      );

      const now = deps.nowIso();

      return deps.db.withWriteTransaction((db): FridaySessionForkCreateResult => {
        // Validate parent exists
        const parent = sessionRepo.getByKey(db, parentKey);
        if (!parent) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.FORK_PARENT_NOT_FOUND,
            `Parent session '${parentKey}' not found`,
            { httpStatus: 404 },
          );
        }

        // Build subagent key
        const forkKey = buildFridaySubagentSessionKey(parentKey, taskId);

        // Check for conflict (fork key already exists)
        const existing = sessionRepo.getByKey(db, forkKey);
        if (existing) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.FORK_CONFLICT,
            `Fork session '${forkKey}' already exists`,
            { httpStatus: 409 },
          );
        }

        // Resolve fork point
        let forkedFromMessageId = input?.forkFromMessageId;
        let maxSequence: number | undefined;

        if (forkedFromMessageId) {
          const forkPointMsg = messageRepo.getBySessionAndId(db, {
            sessionKey: parentKey,
            messageId: forkedFromMessageId,
          });
          if (!forkPointMsg) {
            throw new FridayDomainError(
              FRIDAY_SESSION_ERROR_CODES.FORK_POINT_NOT_FOUND,
              `Fork point message '${forkedFromMessageId}' not found in session '${parentKey}'`,
              { httpStatus: 404 },
            );
          }
          maxSequence = forkPointMsg.sequence;
        }

        // Resolve root key
        const rootSessionKey = parent.rootSessionKey ?? parentKey;

        // Resolve memory namespace from parent
        let memoryNamespace = parent.memoryNamespace;
        if (!memoryNamespace) {
          try {
            memoryNamespace = resolveFridaySessionMemoryNamespace(parent, (k) =>
              sessionRepo.getByKey(db, k),
            );
          } catch {
            // Best-effort
          }
        }

        // Resolve fork point BEFORE setting lineage.
        // If no explicit fork point, fall back to the latest parent message.
        if (!forkedFromMessageId) {
          const latestMessages = messageRepo.listForkContextWindow(db, {
            sessionKey: parentKey,
            limit: 1,
          });
          if (latestMessages.length > 0) {
            forkedFromMessageId = latestMessages[0].id;
          }
        }

        // Parse the fork key to get channel/chatId parts
        const forkParts = parseFridaySessionKey(forkKey);

        // Create child session
        const childSession = sessionRepo.insert(db, {
          key: forkKey,
          channel: forkParts.channel ?? parent.channel,
          chatId: forkParts.chatId ?? parent.chatId,
          accountId: forkParts.accountId ?? parent.accountId,
          chatKind: parent.chatKind,
          metadata: input?.metadata,
          nowIso: now,
          memoryNamespace,
          idGenerator: deps.idGenerator,
        });

        // Set lineage with the resolved fork point
        sessionRepo.setForkLineage(db, {
          key: forkKey,
          parentSessionKey: parentKey,
          rootSessionKey,
          forkedFromMessageId,
          memoryNamespace,
        });

        // Copy parent context window as inherited messages
        let inheritedCount = 0;
        if (inheritMessageCount > 0) {
          const contextMessages = messageRepo.listForkContextWindow(db, {
            sessionKey: parentKey,
            limit: inheritMessageCount,
            maxSequence,
          });

          for (const msg of contextMessages) {
            messageRepo.append(db, {
              sessionId: childSession.id,
              sessionKey: forkKey,
              role: msg.role,
              contentJson: JSON.stringify(msg.content),
              contentText: msg.contentText,
              toolCallsJson: msg.toolCalls ? JSON.stringify(msg.toolCalls) : undefined,
              tokenCount: msg.tokenCount,
              parentMessageId: msg.parentMessageId,
              metadataJson: JSON.stringify(msg.metadata),
              occurredAt: msg.occurredAt,
              nowIso: now,
              idGenerator: deps.idGenerator,
              isInherited: true,
              inheritedFromSessionKey: parentKey,
              inheritedFromMessageId: msg.id,
              memoryExtractStatus: "skipped",
            });
            inheritedCount++;
          }
        }

        // Re-read session to get final state with lineage
        const finalSession = sessionRepo.getByKey(db, forkKey);

        return {
          forkSession: finalSession ?? childSession,
          inheritedMessageCount: inheritedCount,
          forkedFromMessageId,
        };
      });
    },

    async listForks(parentKey, input) {
      parentKey = canonicalizeFridaySessionKey(parentKey);

      const statuses = input?.status
        ? [input.status]
        : ["active", "idle"] as const;

      return deps.db.withReadConnection((db) =>
        sessionRepo.listByParentSessionKey(db, {
          parentSessionKey: parentKey,
          statuses: [...statuses],
          limit: input?.limit,
        }),
      );
    },

    async mergeForkSummary(parentKey, input) {
      parentKey = canonicalizeFridaySessionKey(parentKey);

      if (!input.summary) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
          "Summary is required for merge",
          { httpStatus: 400 },
        );
      }

      // Validate parent and fork within a read
      const { fork } = deps.db.withReadConnection((db) => {
        const parent = sessionRepo.getByKey(db, parentKey);
        if (!parent) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.FORK_PARENT_NOT_FOUND,
            `Parent session '${parentKey}' not found`,
            { httpStatus: 404 },
          );
        }

        const forkSession = sessionRepo.getByKey(db, input.forkSessionKey);
        if (!forkSession) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
            `Fork session '${input.forkSessionKey}' not found`,
            { httpStatus: 404 },
          );
        }

        if (forkSession.parentSessionKey !== parentKey) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.FORK_LINEAGE_MISMATCH,
            `Fork session '${input.forkSessionKey}' is not a child of '${parentKey}'`,
            { httpStatus: 409 },
          );
        }

        return { fork: forkSession };
      });

      // Write summary to parent via addMessage (handles idempotency, counters, reactivation)
      const mergeMetadata: Record<string, unknown> = {
        ...input.metadata,
        forkSessionKey: input.forkSessionKey,
        mergeType: "fork_summary",
      };

      const parentMessage = await this.addMessage(parentKey, {
        role: "assistant",
        content: input.summary,
        idempotencyKey: input.idempotencyKey,
        metadata: mergeMetadata,
      });

      // Optionally archive fork
      const archiveFork = input.archiveFork ?? FRIDAY_SESSION_FORK_DEFAULT_ARCHIVE_ON_MERGE;
      let updatedFork = fork;
      if (archiveFork) {
        const now = deps.nowIso();
        const archived = deps.db.withWriteTransaction((db) =>
          sessionRepo.updateStatus(db, {
            key: input.forkSessionKey,
            to: "archived",
            nowIso: now,
          }),
        );
        if (archived) {
          updatedFork = archived;
        }
      }

      return {
        parentMessage,
        forkSession: updatedFork,
      };
    },

    async resetSession(key) {
      key = canonicalizeFridaySessionKey(key);

      const now = deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        const session = sessionRepo.getByKey(db, key);
        if (!session) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
            `Session '${key}' not found`,
            { httpStatus: 404 },
          );
        }

        // Delete all messages for this session
        db.prepare("DELETE FROM session_messages WHERE session_key = ?").run(key);

        // Reset token and message counters, reactivate if needed
        db.prepare(
          `UPDATE sessions SET
            context_input_tokens = 0,
            context_output_tokens = 0,
            context_total_tokens = 0,
            message_count = 0,
            status = 'active',
            status_changed_at = ?,
            last_activity_at = ?,
            updated_at = ?
          WHERE session_key = ?`,
        ).run(now, now, now, key);

        const updated = sessionRepo.getByKey(db, key);
        if (!updated) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
            `Session '${key}' not found after reset`,
            { httpStatus: 500 },
          );
        }

        return updated;
      });
    },

    async setSendPolicy(key, policy) {
      key = canonicalizeFridaySessionKey(key);

      const now = deps.nowIso();
      const updated = deps.db.withWriteTransaction((db) =>
        sessionRepo.updateSendPolicy(db, {
          key,
          sendPolicy: policy,
          nowIso: now,
        }),
      );

      if (!updated) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
          `Session '${key}' not found`,
          { httpStatus: 404 },
        );
      }

      return updated;
    },

    async evaluateSendPolicy(key) {
      key = canonicalizeFridaySessionKey(key);

      const session = deps.db.withReadConnection((db) => sessionRepo.getByKey(db, key));
      if (!session) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
          `Session '${key}' not found`,
          { httpStatus: 404 },
        );
      }

      return resolveFridaySessionSendPolicy({ sessionPolicy: session.sendPolicy });
    },
  };
}
