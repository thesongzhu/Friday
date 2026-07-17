import * as crypto from "node:crypto";
import { FridayDomainError } from "#errors";
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
  /**
   * SEC-EVENT-REDACTION-001 / P0#2 — canonical-hub-owner binding for the realtime
   * read plane. Realtime events are owned by the single canonical hub owner. When
   * this resolver is PROVIDED (production wiring), subscribe / authorize / pull are
   * gated to that owner: a non-canonical principal is DENIED even with matching
   * topic scope and a known stream id, and pulls are owner-scoped at the repo. If
   * it resolves to nullish/blank the gate FAILS CLOSED (denies). When it is OMITTED
   * (legacy/test construction) the pre-existing topic-scope authz is unchanged — so
   * this is additive and never weakens today's behavior. Production MUST provide it.
   */
  resolveCanonicalOwnerId?: () => string | null | undefined;
  /**
   * Test-oracle only: allows the legacy TypeScript realtime checkpoint-ack
   * mutation (`ackEvent`) in isolated test/validation harnesses. Default/live
   * runtime must leave this unset so the method fails closed for ALL ingress
   * (the HTTP /v1/realtime/ack route AND the WS `ack` frame both already gate on
   * the same flag BEFORE calling ackEvent; this method-head guard formalizes
   * that two-site fence as a registered method guard). Reads
   * (validateSubscriptions/pullEvents/getCheckpoint/cursor helpers) stay live.
   * Never default this flag on in production.
   */
  allowTestOnlyRealtimeExecution?: boolean;
}

// ─── Factory ───

export function createFridayRealtimeSubscriptionService(
  deps: CreateFridayRealtimeSubscriptionServiceDeps,
): FridayRealtimeSubscriptionService {
  const cursorSecret = deps.cursorSecret ?? crypto.randomBytes(16).toString("hex");

  // ─── SEC-EVENT-REDACTION-001 / P0#2: canonical-hub-owner gate ───
  // Resolve the canonical owner (fail-closed on throw/blank). Returns `undefined`
  // ONLY when the resolver dep is not configured (legacy/test) — meaning the gate
  // is inactive and the pre-existing topic-scope authz applies unchanged.
  function resolveCanonicalOwner(): string | null | undefined {
    if (!deps.resolveCanonicalOwnerId) return undefined;
    let owner: string | null | undefined;
    try {
      owner = deps.resolveCanonicalOwnerId();
    } catch {
      owner = null;
    }
    return typeof owner === "string" && owner.trim().length > 0 ? owner : null;
  }

  // True when the principal is authorized under the owner gate: allowed if the gate
  // is inactive (undefined), else the principal's identity MUST equal the canonical
  // owner. A configured-but-unresolvable owner (null) fails CLOSED.
  function principalPassesOwnerGate(principal: FridayAuthPrincipal): boolean {
    const canonical = resolveCanonicalOwner();
    if (canonical === undefined) return true; // gate not configured → legacy behavior
    if (canonical === null) return false; // configured but unresolvable → fail-closed
    const identity = principal.userId ?? principal.principalId;
    return typeof identity === "string" && identity === canonical;
  }

  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Defense-in-depth (orphan off-route leak audit, 2026-06-10): the realtime
  // checkpoint-ack mutation has TWO live ingress points — the HTTP /v1/realtime/
  // ack route and the WS `ack` frame — and both already gate on
  // allowTestOnlyRealtimeExecution before calling ackEvent. This method-head
  // guard registers that de-facto two-site fence as a single method guard, so a
  // future THIRD caller of ackEvent cannot bypass it. Fails closed BEFORE the
  // checkpoint upsert unless the explicit test-oracle flag is set. Mirrors the
  // ingress 503 code (TS_RUNTIME_REALTIME_RETIRED).
  function assertRealtimeAckExecutionAllowed(): void {
    if (deps.allowTestOnlyRealtimeExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_REALTIME_RETIRED",
        "TypeScript realtime checkpoint-ack is fail-closed in default/live runtime; use the Rust-owned realtime delivery entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_realtime_entrypoint_required",
          },
        },
      );
    }
  }

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

      // Canonical-owner gate: a non-canonical principal is denied ALL subscriptions
      // (even with matching topic scope) — cross-principal isolation of the owner's
      // realtime streams.
      if (!principalPassesOwnerGate(principal)) {
        return {
          accepted,
          rejected: subscriptions.map((sub) => ({
            subscriptionId: sub.subscriptionId,
            code: "NOT_CANONICAL_OWNER",
            message: "Realtime streams are readable only by the canonical hub owner.",
          })),
        };
      }

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
      // Canonical-owner gate first: a non-canonical principal is never authorized
      // for any realtime stream, even one they know the id of and hold scope for.
      if (!principalPassesOwnerGate(principal)) return false;

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
      // Defense-in-depth: when the owner gate is configured, scope the read to the
      // canonical owner's rows at the repo (excludes NULL-owner sentinel + any other
      // owner). Only the canonical owner reaches here (isStreamAuthorized gates the
      // route/WS callers first), so filtering by that owner is exactly the reader.
      const canonical = resolveCanonicalOwner();
      if (canonical === null) return []; // configured but unresolvable → fail-closed
      const ownerFilter = canonical === undefined ? undefined : canonical;
      return deps.db.withReadConnection((db) =>
        deps.eventRepo.listAfterSeq(db, streamId, afterSeq, limit, ownerFilter),
      );
    },

    ackEvent(principalId, streamId, seq, epoch, cursor) {
      assertRealtimeAckExecutionAllowed();
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
