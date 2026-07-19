import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import {
  hashIdempotencyPayload,
  throwIdempotencyConflict,
} from "../../api/http/routes/friday-route-idempotency.js";
import type {
  FridayOutboxEnqueueInput,
  FridayOutboxLeasedItem,
  FridayOutboxMessageRow,
  FridayOutboxStatus,
} from "../model/friday-outbox.types.js";
import type { FridayOutboxMessageRepository } from "../persistence/friday-outbox-message-repository.js";

export interface FridayOutboxQueueService {
  enqueue(input: FridayOutboxEnqueueInput): { id: string };
  getMessage(messageId: string): FridayOutboxMessageRow | null;
  leaseBatch(input: {
    satelliteId: string;
    limit: number;
    leaseMs: number;
    nowIso?: string;
  }): FridayOutboxLeasedItem[];
  ackMessage(input: {
    satelliteId: string;
    messageId: string;
    ackedAt?: string;
  }): { acked: boolean };
  ackUpToSeq(input: {
    satelliteId: string;
    streamId: string;
    seq: number;
    ackedAt?: string;
  }): { acked: number };
  failLeasedMessage(input: {
    messageId: string;
    satelliteId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    nowIso?: string;
  }): { status: FridayOutboxStatus; nextDeliverAfter?: string };
  requeueExpiredLeases(nowIso?: string): number;
  expireByTtl(nowIso?: string): number;
}

export interface CreateOutboxQueueServiceDeps {
  db: FridaySqliteLayer;
  outboxRepo: FridayOutboxMessageRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

/** Base retry backoff: 5 seconds, doubled per attempt. */
const BASE_RETRY_MS = 5_000;

export function createFridayOutboxQueueService(
  deps: CreateOutboxQueueServiceDeps,
): FridayOutboxQueueService {
  return {
    enqueue(input) {
      const id = deps.idGenerator();
      const nowIso = deps.nowIso();
      // Digest over the STABLE message identity only. The transport ciphertext/nonce carry a
      // per-dispatch timestamp (see the workflow satellite dispatch payload's `requestedAt`),
      // so digesting them would false-positive on a legitimate same-key re-dispatch — which
      // MUST stay an idempotent no-op (no-degrade). Divergence in the routing identity, on the
      // other hand, is a genuine reuse-of-key-for-a-different-message conflict.
      const payloadDigest = hashIdempotencyPayload({
        satelliteId: input.satelliteId,
        queueKey: input.queueKey,
        messageType: input.messageType,
        keyId: input.keyId,
      });
      return deps.db.withWriteTransaction((db) => {
        // A pre-existing row for this (satellite_id, idempotency_key) with a DIFFERENT stored
        // digest is the same key reused for a DIFFERENT message identity: surface the typed 409
        // conflict rather than silently resolving to the existing id.
        const existing = db
          .prepare(
            "SELECT id, payload_digest FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?",
          )
          .get(input.satelliteId, input.idempotencyKey) as
          | { id: string; payload_digest: string | null }
          | undefined;
        if (existing) {
          if (existing.payload_digest === null) {
            // Legacy pre-v100 row (NULL digest): BACKFILL the canonical digest onto the row on the
            // FIRST digest-bearing enqueue so a SUBSEQUENT enqueue that reuses this
            // (satellite_id, idempotency_key) with a DIFFERENT message identity then hits the typed
            // 409 branch below. Without this the null short-circuits the guard, so a divergent
            // re-enqueue is silently resolved to the existing id instead of being flagged. Scoped to
            // `payload_digest IS NULL` so it stamps a legacy row exactly once and never overwrites an
            // already-stamped digest; atomic with the conflict decision inside this
            // withWriteTransaction. Does NOT insert a row or alter the idempotent-replay path.
            db
              .prepare(
                "UPDATE outbox_messages SET payload_digest = ? WHERE satellite_id = ? AND idempotency_key = ? AND payload_digest IS NULL",
              )
              .run(payloadDigest, input.satelliteId, input.idempotencyKey);
          } else if (existing.payload_digest !== payloadDigest) {
            throwIdempotencyConflict(input.idempotencyKey, "outbox.enqueue");
          }
          // Same identity (idempotent retry) → resolve to the existing id, unchanged behavior.
          return { id: existing.id };
        }

        deps.outboxRepo.insertMessage(db, id, input, nowIso, payloadDigest);
        return { id };
      });
    },

    leaseBatch(input) {
      const nowIso = input.nowIso ?? deps.nowIso();
      const leaseUntilIso = new Date(new Date(nowIso).getTime() + input.leaseMs).toISOString();

      return deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.leaseBatch(db, input.satelliteId, input.limit, leaseUntilIso, nowIso);
      });
    },

    getMessage(messageId) {
      return deps.db.withReadConnection((db) => deps.outboxRepo.getMessage(db, messageId) ?? null);
    },

    ackMessage(input) {
      const ackedAt = input.ackedAt ?? deps.nowIso();
      const acked = deps.db.withWriteTransaction((db) =>
        deps.outboxRepo.ackById(db, input.satelliteId, input.messageId, ackedAt),
      );
      return { acked };
    },

    ackUpToSeq(input) {
      const ackedAt = input.ackedAt ?? deps.nowIso();
      const acked = deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.ackUpToSeq(db, input.satelliteId, input.seq, ackedAt);
      });
      return { acked };
    },

    failLeasedMessage(input) {
      const nowIso = input.nowIso ?? deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        const msg = deps.outboxRepo.getMessage(db, input.messageId);
        if (!msg) {
          throw new FridayDomainError("OUTBOX_MESSAGE_NOT_FOUND", `Outbox message not found: ${input.messageId}`, { httpStatus: 404 });
        }
        if (msg.satellite_id !== input.satelliteId) {
          throw new FridayDomainError("OUTBOX_MESSAGE_MISMATCH", "Message does not belong to this satellite", { httpStatus: 403 });
        }

        // Non-retryable or max attempts → dead_letter
        if (!input.retryable || msg.attempts >= msg.max_attempts) {
          deps.outboxRepo.updateStatusAndError(
            db,
            input.messageId,
            "dead_letter",
            input.errorCode,
            input.errorMessage,
            null,
            nowIso,
          );
          return { status: "dead_letter" as const };
        }

        // Retryable → back to queued with exponential backoff
        const backoffMs = BASE_RETRY_MS * Math.pow(2, msg.attempts - 1);
        const nextDeliverAfter = new Date(new Date(nowIso).getTime() + backoffMs).toISOString();

        deps.outboxRepo.updateStatusAndError(
          db,
          input.messageId,
          "queued",
          input.errorCode,
          input.errorMessage,
          nextDeliverAfter,
          nowIso,
        );

        return { status: "queued" as const, nextDeliverAfter };
      });
    },

    requeueExpiredLeases(nowIso?) {
      const now = nowIso ?? deps.nowIso();
      return deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.requeueExpiredLeases(db, now);
      });
    },

    expireByTtl(nowIso?) {
      const now = nowIso ?? deps.nowIso();
      return deps.db.withWriteTransaction((db) => {
        return deps.outboxRepo.expireByTtl(db, now);
      });
    },
  };
}
