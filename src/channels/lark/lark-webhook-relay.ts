/**
 * Lark webhook relay service.
 *
 * The channel plugin owns event normalization/business logic while this relay
 * owns HTTP webhook ingress state and challenge/event dispatch semantics.
 */

export interface LarkWebhookRelayResult {
  accepted: boolean;
  statusCode: number;
  challenge?: string;
  code?:
    | "LARK_LISTENER_INACTIVE"
    | "LARK_PAYLOAD_INVALID"
    | "LARK_EVENT_IGNORED";
}

export interface LarkWebhookRelayService {
  start(onEvent: (event: Record<string, unknown>) => void): Promise<void>;
  stop(): Promise<void>;
  isListening(): boolean;
  handleHttpWebhook(rawBody: string): LarkWebhookRelayResult;
}

export function createLarkWebhookRelayService(): LarkWebhookRelayService {
  let listening = false;
  let onEvent: ((event: Record<string, unknown>) => void) | null = null;

  return {
    async start(handler) {
      listening = true;
      onEvent = handler;
    },
    async stop() {
      listening = false;
      onEvent = null;
    },
    isListening() {
      return listening;
    },
    handleHttpWebhook(rawBody) {
      if (!listening || !onEvent) {
        return {
          accepted: false,
          statusCode: 503,
          code: "LARK_LISTENER_INACTIVE",
        };
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch (err) {
      console.warn("[friday][lark-webhook-relay] operation failed:", err instanceof Error ? err.message : String(err));
        return {
          accepted: false,
          statusCode: 400,
          code: "LARK_PAYLOAD_INVALID",
        };
      }

      // URL verification challenge event.
      if (payload.type === "url_verification") {
        return {
          accepted: true,
          statusCode: 200,
          challenge: typeof payload.challenge === "string" ? payload.challenge : "",
        };
      }

      const header = payload.header as Record<string, unknown> | undefined;
      const eventType = typeof header?.event_type === "string" ? header.event_type : undefined;
      if (eventType === "im.message.receive_v1") {
        onEvent(payload);
        return {
          accepted: true,
          statusCode: 200,
        };
      }

      return {
        accepted: true,
        statusCode: 200,
        code: "LARK_EVENT_IGNORED",
      };
    },
  };
}

