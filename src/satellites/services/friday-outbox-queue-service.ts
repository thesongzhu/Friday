import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import {
  hashIdempotencyPayload,
  reconcileLegacyBackfillDigest,
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

/**
 * Canonical digest over the STABLE outbox message identity (routing fields only — never the
 * per-dispatch transport ciphertext/nonce/timestamp, so a legitimate same-key re-dispatch stays an
 * idempotent no-op). A SINGLE definition consumed by BOTH the incoming-write digest and the
 * recompute over a legacy row's stored columns, so the two can never drift apart. All four fields
 * are persisted columns (`satellite_id, queue_key, message_type, key_id`), which is what makes a
 * legacy (NULL-digest) row's identity provable from the bytes already persisted.
 */
function outboxRoutingIdentityDigest(fields: {
  satelliteId: string;
  queueKey: string;
  messageType: string;
  keyId: string;
}): string {
  return hashIdempotencyPayload({
    satelliteId: fields.satelliteId,
    queueKey: fields.queueKey,
    messageType: fields.messageType,
    keyId: fields.keyId,
  });
}

export function createFridayOutboxQueueService(
  deps: CreateOutboxQueueServiceDeps,
): FridayOutboxQueueService {
  return {
    enqueue(input) {
      const id = deps.idGenerator();
      const nowIso = deps.nowIso();
      // Digest over the STABLE message identity only (see `outboxRoutingIdentityDigest`): the
      // transport ciphertext/nonce carry a per-dispatch timestamp, so digesting them would
      // false-positive on a legitimate same-key re-dispatch — which MUST stay an idempotent no-op
      // (no-degrade). Divergence in the routing identity, on the other hand, is a genuine
      // reuse-of-key-for-a-different-message conflict.
      const payloadDigest = outboxRoutingIdentityDigest({
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
            `SELECT id, satellite_id, queue_key, message_type, key_id, payload_digest
               FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?`,
          )
          .get(input.satelliteId, input.idempotencyKey) as
          | {
              id: string;
              satellite_id: string;
              queue_key: string;
              message_type: string;
              key_id: string;
              payload_digest: string | null;
            }
          | undefined;
        if (existing) {
          // Reconcile through the SINGLE cross-store primitive. For a LEGACY (NULL-digest) row the
          // row's identity is PROVED from the bytes already persisted — the canonical routing-identity
          // digest recomputed from its OWN stored routing columns (all four inputs are persisted),
          // via the SAME `outboxRoutingIdentityDigest` used for the incoming digest, so the incoming
          // routing identity IS `payloadDigest`. A `backfill` outcome means "same identity" ⇒ stamp
          // the legacy row first-write-only; a divergence throws inside the primitive before any
          // stamp, never laundering a divergent re-enqueue's digest onto the row.
          const reconcile = reconcileLegacyBackfillDigest({
            existing: {
              payloadDigest: existing.payload_digest,
              contentIdentity: outboxRoutingIdentityDigest({
                satelliteId: existing.satellite_id,
                queueKey: existing.queue_key,
                messageType: existing.message_type,
                keyId: existing.key_id,
              }),
            },
            incomingDigest: payloadDigest,
            incomingContentIdentity: payloadDigest,
            conflictKey: input.idempotencyKey,
            conflictOperationId: "outbox.enqueue",
          });
          if (reconcile === "backfill") {
            db
              .prepare(
                "UPDATE outbox_messages SET payload_digest = ? WHERE satellite_id = ? AND idempotency_key = ? AND payload_digest IS NULL",
              )
              .run(payloadDigest, input.satelliteId, input.idempotencyKey);
          }
          // Same identity (idempotent retry, or just-backfilled legacy) → resolve to the existing id.
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
