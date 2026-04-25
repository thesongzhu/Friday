import type { FridaySqliteLayer } from "#state";
import type { FridayLearningEventAppendInput } from "#ledger";
import type { FridayResumeValidationResult } from "../model/friday-satellite-protocol.types.js";
import type { FridayResumeCursorSigner } from "../protocol/friday-resume-cursor-signer.js";
import type { FridayAckResumeValidator } from "../protocol/friday-ack-resume-validator.js";
import type { FridayStreamCheckpointRepository } from "../persistence/friday-stream-checkpoint-repository.js";
import type { FridayOutboxMessageRepository } from "../persistence/friday-outbox-message-repository.js";

export interface FridaySyncNodeResultInput {
  runId: string;
  nodeId: string;
  attemptId: string;
  attempt: number;
  status: "completed" | "failed";
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export interface FridaySyncPullInput {
  satelliteId: string;
  streamId: string;
  lastAckedSeq: number;
  subscriptions: string[];
  resumeCursor?: string;
  limit?: number;
}

export interface FridaySyncPullResult {
  epoch: number;
  streamId: string;
  events: Array<{ seq: number; event: string; payload: unknown; emittedAt: string }>;
  queueItems: Array<{ id: string; seq: number; messageType: string; payloadCiphertext: string }>;
  nextCursor?: string;
  fullPullRequired?: boolean;
}

export interface FridaySyncPushInput {
  satelliteId: string;
  acks: Array<{ streamId: string; seq: number; epoch: number; cursor?: string }>;
  localEvents?: FridayLearningEventAppendInput[];
  nodeResults?: FridaySyncNodeResultInput[];
}

export interface FridaySyncPushResult {
  acceptedAcks: Array<{ streamId: string; seq: number }>;
  acceptedNodeResults: Array<{ runId: string; nodeId: string; attemptId: string }>;
  conflicts: Array<{ streamId: string; seq: number; code: string; message: string }>;
}

export interface FridaySatelliteSyncService {
  pull(input: FridaySyncPullInput): FridaySyncPullResult;
  push(input: FridaySyncPushInput): Promise<FridaySyncPushResult>;
}

export interface CreateSyncServiceDeps {
  db: FridaySqliteLayer;
  checkpointRepo: FridayStreamCheckpointRepository;
  outboxRepo: FridayOutboxMessageRepository;
  cursorSigner: FridayResumeCursorSigner;
  ackValidator: FridayAckResumeValidator;
  nowIso: () => string;
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  remoteNodeResultWriter?: (input: FridaySyncNodeResultInput & { satelliteId: string }) => Promise<void>;
}

export function createFridaySatelliteSyncService(
  deps: CreateSyncServiceDeps,
): FridaySatelliteSyncService {
  return {
    pull(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const currentEpoch = deps.checkpointRepo.getEpoch(db);

        // If resume cursor is provided, validate it
        if (input.resumeCursor) {
          const frame = {
            type: "resume" as const,
            lastAckedSeq: input.lastAckedSeq,
            streamId: input.streamId,
            epoch: currentEpoch,
            cursor: input.resumeCursor,
            subscriptions: input.subscriptions,
            emittedAt: nowIso,
          };
          const result: FridayResumeValidationResult = deps.ackValidator.validateResume(
            frame,
            currentEpoch,
          );
          if (!result.ok) {
            return {
              epoch: currentEpoch,
              streamId: input.streamId,
              events: [],
              queueItems: [],
              fullPullRequired: true,
            };
          }
        }

        // Lease queued messages for this satellite
        const leaseMs = 60_000;
        const leaseUntilIso = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
        const leaseLimit =
          typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
            ? Math.min(input.limit, 100)
            : 50;
        const subscriptions = input.subscriptions
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0 && entry.includes("."));
        const queueItems = subscriptions.length > 0
          ? deps.outboxRepo.leaseBatch(
            db,
            input.satelliteId,
            leaseLimit,
            leaseUntilIso,
            nowIso,
            subscriptions,
          )
          : [];

        // Generate next cursor
        const maxSeq = queueItems.length > 0
          ? Math.max(...queueItems.map((q) => q.seq))
          : input.lastAckedSeq;

        const nextCursor = deps.cursorSigner.sign({
          seq: maxSeq,
          streamId: input.streamId,
          epoch: currentEpoch,
          issuedAt: nowIso,
        });

        return {
          epoch: currentEpoch,
          streamId: input.streamId,
          events: [],
          queueItems,
          nextCursor,
        };
      });
    },

    async push(input) {
      const acceptedNodeResults: FridaySyncPushResult["acceptedNodeResults"] = [];
      const nodeResultConflicts: FridaySyncPushResult["conflicts"] = [];

      if (input.nodeResults?.length) {
        if (!deps.remoteNodeResultWriter) {
          nodeResultConflicts.push(
            ...input.nodeResults.map((result) => ({
              streamId: `workflow:${result.runId}`,
              seq: 0,
              code: "SATELLITE_NODE_RESULT_UNSUPPORTED",
              message: "This hub does not accept node results via satellite sync push",
            })),
          );
        } else {
          for (const result of input.nodeResults) {
            try {
              await deps.remoteNodeResultWriter({
                ...result,
                satelliteId: input.satelliteId,
              });
              acceptedNodeResults.push({
                runId: result.runId,
                nodeId: result.nodeId,
                attemptId: result.attemptId,
              });
            } catch (err) {
              const record = err as { code?: unknown; message?: unknown };
              nodeResultConflicts.push({
                streamId: `workflow:${result.runId}`,
                seq: 0,
                code: typeof record.code === "string" ? record.code : "SATELLITE_NODE_RESULT_CONFLICT",
                message: typeof record.message === "string" ? record.message : "Satellite node result was rejected",
              });
            }
          }
        }
      }

      const baseResult = deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const currentEpoch = deps.checkpointRepo.getEpoch(db);

        const acceptedAcks: Array<{ streamId: string; seq: number }> = [];
        const conflicts: Array<{ streamId: string; seq: number; code: string; message: string }> = [];

        if (nodeResultConflicts.length > 0) {
          for (const ack of input.acks) {
            conflicts.push({
              streamId: ack.streamId,
              seq: ack.seq,
              code: "SATELLITE_ACK_BLOCKED_BY_NODE_RESULT_CONFLICT",
              message: "Ack was not accepted because one or more node results in the push were rejected",
            });
          }
        }

        for (const ack of nodeResultConflicts.length === 0 ? input.acks : []) {
          // Epoch validation
          if (ack.epoch !== currentEpoch) {
            conflicts.push({
              streamId: ack.streamId,
              seq: ack.seq,
              code: "STREAM_EPOCH_STALE",
              message: `Epoch mismatch: ack=${ack.epoch}, current=${currentEpoch}`,
            });
            continue;
          }

          // Validate cursor if provided
          if (ack.cursor) {
            try {
              const payload = deps.cursorSigner.verify(ack.cursor);
              if (payload.epoch !== currentEpoch) {
                conflicts.push({
                  streamId: ack.streamId,
                  seq: ack.seq,
                  code: "STREAM_EPOCH_STALE",
                  message: "Cursor epoch does not match current epoch",
                });
                continue;
              }
              // Enforce stream/seq binding
              if (payload.streamId !== ack.streamId || payload.seq !== ack.seq) {
                conflicts.push({
                  streamId: ack.streamId,
                  seq: ack.seq,
                  code: "AUTH_UNAUTHORIZED",
                  message: "Cursor streamId/seq does not match ack payload",
                });
                continue;
              }
            } catch (err) {
              console.warn("[friday][satellite-sync-service] invalid ack cursor:", err instanceof Error ? err.message : String(err));
              conflicts.push({
                streamId: ack.streamId,
                seq: ack.seq,
                code: "AUTH_UNAUTHORIZED",
                message: "Invalid ack cursor",
              });
              continue;
            }
          }

          // Monotonic checkpoint enforcement
          const lastSeq = deps.checkpointRepo.getLastAckedSeq(
            db,
            input.satelliteId,
            ack.streamId,
          );
          if (ack.seq <= lastSeq) {
            // Idempotent — already acked, still accept
            acceptedAcks.push({ streamId: ack.streamId, seq: ack.seq });
            continue;
          }

          // Advance checkpoint
          deps.checkpointRepo.setLastAckedSeq(db, {
            satelliteId: input.satelliteId,
            streamId: ack.streamId,
            seq: ack.seq,
            nowIso,
          });
          if (ack.streamId === "outbox" || ack.streamId === `outbox:${input.satelliteId}`) {
            deps.outboxRepo.ackUpToSeq(db, input.satelliteId, ack.seq, nowIso);
          }
          acceptedAcks.push({ streamId: ack.streamId, seq: ack.seq });
        }

        // Persist local events if provided
        if (input.localEvents?.length && deps.learningEventWriter) {
          deps.learningEventWriter(input.localEvents);
        }

        return { acceptedAcks, acceptedNodeResults: [], conflicts };
      });

      return {
        ...baseResult,
        acceptedNodeResults,
        conflicts: [...nodeResultConflicts, ...baseResult.conflicts],
      };
    },
  };
}
