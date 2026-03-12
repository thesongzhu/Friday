import * as crypto from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayRealtimeEventEnvelope,
  FridayRealtimeSubscription,
  FridayRealtimeTopic,
} from "../model/friday-api-realtime.types.js";
import type { FridayAuthPrincipal, FridayScope } from "../model/friday-api-auth.types.js";
import type { FridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import type { FridayRealtimeCheckpointRepository } from "../persistence/friday-realtime-checkpoint-repository.js";
import { principalHasAnyScope } from "../auth/friday-rbac-policy.js";

// ─── Topic → required scopes ───

const TOPIC_SCOPES: Record<FridayRealtimeTopic, FridayScope[]> = {
  "workflow": ["workflow.read"],
  "workflow.run": ["workflow.read"],
  "workflow.node": ["workflow.read"],
  "workflow.conflict": ["workflow.read", "workflow.conflict.resolve"],
  "satellite": ["satellite.read"],
  "fleet": ["fleet.read"],
  "security": ["security.read"],
  "diagnosis": ["diagnosis.read"],
  "approval": ["workflow.run"],
  "rules": ["rules.read"],
  "execution": ["execution.read"],
  "acceptance": ["acceptance.read"],
  "retry": ["retry.read"],
  "playbook": ["playbook.read"],
};

// ─── Topic → allowed stream prefixes ───

const TOPIC_STREAM_PREFIXES: Record<FridayRealtimeTopic, string[]> = {
  "workflow": ["workflow:"],
  "workflow.run": ["run:"],
  "workflow.node": ["run:"],
  "workflow.conflict": ["workflow:"],
  "satellite": ["satellite:"],
  "fleet": ["fleet:"],
  "security": ["security:"],
  "diagnosis": ["diagnosis:"],
  "approval": ["workflow:", "run:"],
  "rules": ["rules:"],
  "execution": ["execution:"],
  "acceptance": ["acceptance:"],
  "retry": ["retry:"],
  "playbook": ["playbook:"],
};

// ─── Cursor HMAC helpers ───

function computeCursorHmac(
  streamId: string,
  seq: number,
  epoch: number,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${streamId}:${seq}:${epoch}`)
    .digest("hex");
}

function verifyCursorHmac(
  cursor: string,
  streamId: string,
  seq: number,
  epoch: number,
  secret: string,
): boolean {
  const expected = computeCursorHmac(streamId, seq, epoch, secret);
  if (cursor.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cursor), Buffer.from(expected));
}

// ─── Service interface ───

export interface FridayRealtimeSubscriptionService {
  validateSubscriptions(
    subscriptions: FridayRealtimeSubscription[],
    principal: FridayAuthPrincipal,
  ): {
    accepted: FridayRealtimeSubscription[];
    rejected: Array<{ subscriptionId: string; code: string; message: string }>;
  };

  /** Check if a principal is authorized for a given stream based on their subscriptions/scopes. */
  isStreamAuthorized(
    principal: FridayAuthPrincipal,
    streamId: string,
    acceptedSubscriptions?: Map<string, FridayRealtimeSubscription>,
  ): boolean;

  pullEvents(
    streamId: string,
    afterSeq: number,
    limit: number,
  ): FridayRealtimeEventEnvelope[];

  ackEvent(
    principalId: string,
    streamId: string,
    seq: number,
    epoch: number,
    cursor?: string,
  ): { accepted: boolean };

  getCheckpoint(
    principalId: string,
    streamId: string,
  ): { lastAckedSeq: number; epoch: number; cursor?: string } | null;

  /** Generate cursor HMAC for a given stream/seq/epoch. */
  generateCursor(streamId: string, seq: number, epoch: number): string;

  /** Verify cursor HMAC for a given stream/seq/epoch. */
  verifyCursor(cursor: string, streamId: string, seq: number, epoch: number): boolean;
}

export interface CreateFridayRealtimeSubscriptionServiceDeps {
  db: FridaySqliteLayer;
  eventRepo: FridayRealtimeEventRepository;
  checkpointRepo: FridayRealtimeCheckpointRepository;
  nowIso: () => string;
  currentEpoch: number;
  cursorSecret?: string;
}

// ─── Factory ───

export function createFridayRealtimeSubscriptionService(
  deps: CreateFridayRealtimeSubscriptionServiceDeps,
): FridayRealtimeSubscriptionService {
  const cursorSecret = deps.cursorSecret ?? "friday-default-cursor-secret";

  /** Check if a streamId is valid for the given topic based on prefix rules. */
  function isStreamValidForTopic(topic: FridayRealtimeTopic, streamId: string): boolean {
    const prefixes = TOPIC_STREAM_PREFIXES[topic];
    if (!prefixes) return false;
    return prefixes.some((prefix) => streamId.startsWith(prefix));
  }

  return {
    validateSubscriptions(subscriptions, principal) {
      const accepted: FridayRealtimeSubscription[] = [];
      const rejected: Array<{ subscriptionId: string; code: string; message: string }> = [];

      for (const sub of subscriptions) {
        const requiredScopes = TOPIC_SCOPES[sub.topic];
        if (!requiredScopes) {
          rejected.push({
            subscriptionId: sub.subscriptionId,
            code: "UNKNOWN_TOPIC",
            message: `Unknown topic: ${sub.topic}`,
          });
          continue;
        }

        if (!principalHasAnyScope(principal.scopes, requiredScopes)) {
          rejected.push({
            subscriptionId: sub.subscriptionId,
            code: "INSUFFICIENT_SCOPE",
            message: `Missing required scope for topic ${sub.topic}`,
          });
          continue;
        }

        // Validate topic → stream binding
        if (!isStreamValidForTopic(sub.topic, sub.streamId)) {
          rejected.push({
            subscriptionId: sub.subscriptionId,
            code: "INVALID_STREAM_BINDING",
            message: `Stream '${sub.streamId}' is not valid for topic '${sub.topic}'`,
          });
          continue;
        }

        accepted.push(sub);
      }

      return { accepted, rejected };
    },

    isStreamAuthorized(principal, streamId, acceptedSubscriptions) {
      // If we have accepted subscriptions, check if the stream is in them
      if (acceptedSubscriptions) {
        for (const sub of acceptedSubscriptions.values()) {
          if (sub.streamId === streamId) return true;
        }
        return false;
      }

      // Fallback: derive topic from stream prefix and check scopes
      for (const [topic, prefixes] of Object.entries(TOPIC_STREAM_PREFIXES)) {
        if (prefixes.some((prefix: string) => streamId.startsWith(prefix))) {
          const requiredScopes = TOPIC_SCOPES[topic as FridayRealtimeTopic];
          if (requiredScopes && principalHasAnyScope(principal.scopes, requiredScopes)) {
            return true;
          }
        }
      }
      return false;
    },

    pullEvents(streamId, afterSeq, limit) {
      return deps.db.withReadConnection((db) =>
        deps.eventRepo.listAfterSeq(db, streamId, afterSeq, limit),
      );
    },

    ackEvent(principalId, streamId, seq, epoch, cursor) {
      if (epoch !== deps.currentEpoch) {
        return { accepted: false };
      }

      deps.db.withWriteTransaction((db) => {
        deps.checkpointRepo.upsert(db, principalId, streamId, seq, epoch, cursor, deps.nowIso());
      });

      return { accepted: true };
    },

    getCheckpoint(principalId, streamId) {
      const checkpoint = deps.db.withReadConnection((db) =>
        deps.checkpointRepo.get(db, principalId, streamId),
      );

      if (!checkpoint) return null;

      return {
        lastAckedSeq: checkpoint.last_acked_seq,
        epoch: checkpoint.epoch,
        cursor: checkpoint.cursor ?? undefined,
      };
    },

    generateCursor(streamId, seq, epoch) {
      return computeCursorHmac(streamId, seq, epoch, cursorSecret);
    },

    verifyCursor(cursor, streamId, seq, epoch) {
      return verifyCursorHmac(cursor, streamId, seq, epoch, cursorSecret);
    },
  };
}
