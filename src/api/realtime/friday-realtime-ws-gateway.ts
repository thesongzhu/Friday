import type {
  FridayRealtimeClientFrame,
  FridayRealtimeEventEnvelope,
  FridayRealtimeServerFrame,
  FridayRealtimeSubscription,
} from "../model/friday-api-realtime.types.js";
import type { FridayAuthPrincipal } from "../model/friday-api-auth.types.js";
import { FridayTokenValidationError } from "../auth/friday-token-validator.js";
import type { FridayTokenValidator } from "../auth/friday-token-validator.js";
import type { FridayRealtimeSubscriptionService } from "./friday-realtime-subscription-service.js";
import type { FridayRealtimeEventBus } from "./friday-realtime-event-bus.types.js";
import { FRIDAY_ERROR_CODES } from "#errors";

// ─── Connection state ───

export interface FridayWsConnection {
  connId: string;
  principal: FridayAuthPrincipal | null;
  subscriptions: Map<string, FridayRealtimeSubscription>;
  authenticated: boolean;
}

// ─── Gateway interface ───

export interface FridayRealtimeWsGateway {
  handleClientFrame(
    conn: FridayWsConnection,
    frame: FridayRealtimeClientFrame,
  ): FridayRealtimeServerFrame[];
  createConnection(connId: string): FridayWsConnection;
  shouldDeliverEvent(
    conn: FridayWsConnection,
    envelope: FridayRealtimeEventEnvelope,
  ): boolean;
}

export interface CreateFridayRealtimeWsGatewayDeps {
  tokenValidator: FridayTokenValidator;
  subscriptionService: FridayRealtimeSubscriptionService;
  eventBus: FridayRealtimeEventBus;
  nowIso: () => string;
  serverVersion: string;
  currentEpoch: number;
}

// ─── Factory ───

export function createFridayRealtimeWsGateway(
  deps: CreateFridayRealtimeWsGatewayDeps,
): FridayRealtimeWsGateway {
  return {
    createConnection(connId) {
      return {
        connId,
        principal: null,
        subscriptions: new Map(),
        authenticated: false,
      };
    },

    handleClientFrame(conn, frame): FridayRealtimeServerFrame[] {
      switch (frame.type) {
        case "hello": {
          try {
            const validated = deps.tokenValidator.validate(frame.token);
            conn.principal = validated.principal;
            conn.authenticated = true;

            const responses: FridayRealtimeServerFrame[] = [
              {
                type: "hello_ack",
                connId: conn.connId,
                protocolVersion: "1.0",
                serverVersion: deps.serverVersion,
                epoch: deps.currentEpoch,
                now: deps.nowIso(),
              },
            ];

            // Process initial subscriptions if provided
            if (frame.subscriptions && frame.subscriptions.length > 0) {
              const result = deps.subscriptionService.validateSubscriptions(
                frame.subscriptions,
                conn.principal,
              );
              for (const sub of result.accepted) {
                conn.subscriptions.set(sub.subscriptionId, sub);
              }
              responses.push({
                type: "subscribed",
                accepted: result.accepted,
                rejected: result.rejected,
              });
            }

            return responses;
          } catch (err) {
            const code =
              err instanceof FridayTokenValidationError ? err.code : FRIDAY_ERROR_CODES.AUTH_FAILED;
            const message =
              err instanceof Error ? err.message : "Authentication failed";
            return [
              {
                type: "error",
                code,
                message,
                retryable: false,
              },
            ];
          }
        }

        case "subscribe": {
          if (!conn.authenticated || !conn.principal) {
            return [
              {
                type: "error",
                code: FRIDAY_ERROR_CODES.NOT_AUTHENTICATED,
                message: "Must send hello frame first",
                retryable: false,
              },
            ];
          }

          const result = deps.subscriptionService.validateSubscriptions(
            frame.subscriptions,
            conn.principal,
          );
          for (const sub of result.accepted) {
            conn.subscriptions.set(sub.subscriptionId, sub);
          }

          return [
            {
              type: "subscribed",
              accepted: result.accepted,
              rejected: result.rejected,
            },
          ];
        }

        case "unsubscribe": {
          for (const subId of frame.subscriptionIds) {
            conn.subscriptions.delete(subId);
          }
          return [];
        }

        case "ack": {
          if (!conn.authenticated || !conn.principal) {
            return [
              {
                type: "error",
                code: FRIDAY_ERROR_CODES.NOT_AUTHENTICATED,
                message: "Must send hello frame first",
                retryable: false,
              },
            ];
          }

          // Verify stream is in accepted subscriptions
          if (!deps.subscriptionService.isStreamAuthorized(conn.principal, frame.streamId, conn.subscriptions)) {
            return [
              {
                type: "error",
                code: FRIDAY_ERROR_CODES.STREAM_NOT_AUTHORIZED,
                message: `Not subscribed to stream '${frame.streamId}'`,
                retryable: false,
              },
            ];
          }

          if (frame.epoch !== deps.currentEpoch) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "STREAM_EPOCH_STALE",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Verify cursor HMAC if provided
          if (frame.cursor && !deps.subscriptionService.verifyCursor(frame.cursor, frame.streamId, frame.seq, frame.epoch)) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "CURSOR_INVALID",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          const ackResult = deps.subscriptionService.ackEvent(
            conn.principal.principalId,
            frame.streamId,
            frame.seq,
            frame.epoch,
            frame.cursor,
          );

          if (ackResult.accepted) {
            return [{ type: "ack_ok", streamId: frame.streamId, seq: frame.seq }];
          }

          return [
            {
              type: "resync_required",
              streamId: frame.streamId,
              reason: "STREAM_EPOCH_STALE",
              snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
            },
          ];
        }

        case "resume": {
          if (!conn.authenticated || !conn.principal) {
            return [
              {
                type: "error",
                code: FRIDAY_ERROR_CODES.NOT_AUTHENTICATED,
                message: "Must send hello frame first",
                retryable: false,
              },
            ];
          }

          if (frame.epoch !== deps.currentEpoch) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "STREAM_EPOCH_STALE",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Verify cursor HMAC
          if (frame.cursor && !deps.subscriptionService.verifyCursor(frame.cursor, frame.streamId, frame.lastAckedSeq, frame.epoch)) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "CURSOR_INVALID",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Re-validate and apply subscriptions
          const result = deps.subscriptionService.validateSubscriptions(
            frame.subscriptions,
            conn.principal,
          );
          for (const sub of result.accepted) {
            conn.subscriptions.set(sub.subscriptionId, sub);
          }

          // Verify stream is in the accepted subscriptions
          if (!deps.subscriptionService.isStreamAuthorized(conn.principal, frame.streamId, conn.subscriptions)) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "STREAM_CURSOR_OUT_OF_RANGE",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Replay events after last acked seq
          const events = deps.subscriptionService.pullEvents(
            frame.streamId,
            frame.lastAckedSeq,
            100,
          );

          const responses: FridayRealtimeServerFrame[] = [
            {
              type: "subscribed",
              accepted: result.accepted,
              rejected: result.rejected,
            },
          ];

          for (const envelope of events) {
            responses.push({ type: "event", envelope });
          }

          return responses;
        }

        case "ping": {
          return [{ type: "pong", at: deps.nowIso() }];
        }

        default: {
          return [{
            type: "error",
            code: "INVALID_FRAME",
            message: `Unknown frame type: ${String((frame as Record<string, unknown>).type)}`,
            retryable: false,
          }];
        }
      }
    },

    shouldDeliverEvent(conn, envelope) {
      if (!conn.authenticated) return false;

      for (const sub of conn.subscriptions.values()) {
        if (envelope.streamId === sub.streamId) {
          return true;
        }
      }

      return false;
    },
  };
}
