import type { FridayBriefDeliveryClient, FridayBriefDeliveryPayload } from "./delivery/friday-brief-delivery.types.js";
import type {
  FridayBriefChannelKind,
  FridayBriefDeliveryAttempt,
} from "./friday-brief.types.js";

export interface FridayBriefDelivererDeps {
  clients: readonly FridayBriefDeliveryClient[];
  nowIso: () => string;
}

export interface FridayBriefDelivererInput {
  fallbackOrder: readonly FridayBriefChannelKind[];
  payload: FridayBriefDeliveryPayload;
  signal: AbortSignal;
}

export interface FridayBriefDelivererOutput {
  attempts: FridayBriefDeliveryAttempt[];
  /** The first channel that succeeded, if any. */
  deliveredVia?: FridayBriefChannelKind;
}

export interface FridayBriefDeliverer {
  deliver(input: FridayBriefDelivererInput): Promise<FridayBriefDelivererOutput>;
}

export function createFridayBriefDeliverer(
  deps: FridayBriefDelivererDeps,
): FridayBriefDeliverer {
  const byKind = new Map<FridayBriefChannelKind, FridayBriefDeliveryClient>();
  for (const client of deps.clients) byKind.set(client.kind, client);

  return {
    async deliver(input) {
      const attempts: FridayBriefDeliveryAttempt[] = [];
      let deliveredVia: FridayBriefChannelKind | undefined;
      let order = 0;
      for (const kind of input.fallbackOrder) {
        const client = byKind.get(kind);
        if (!client) {
          attempts.push({
            channel: kind,
            order,
            attemptedAt: deps.nowIso(),
            audioAttached: false,
            ok: false,
            error: { code: "CLIENT_MISSING", message: `no client registered for ${kind}` },
            durationMs: 0,
          });
          order += 1;
          continue;
        }
        if (!client.isConfigured()) {
          attempts.push({
            channel: kind,
            order,
            attemptedAt: deps.nowIso(),
            audioAttached: false,
            ok: false,
            error: { code: "NOT_CONFIGURED", message: `${kind} missing required config/credentials` },
            durationMs: 0,
          });
          order += 1;
          continue;
        }
        const started = Date.now();
        const attemptedAt = deps.nowIso();
        try {
          const result = await client.deliver(input.payload, input.signal);
          attempts.push({
            channel: kind,
            order,
            attemptedAt,
            messageId: result.messageId,
            audioAttached: true,
            ok: true,
            durationMs: Date.now() - started,
          });
          deliveredVia = kind;
          break;
        } catch (err) {
          const error = err as Error;
          attempts.push({
            channel: kind,
            order,
            attemptedAt,
            audioAttached: false,
            ok: false,
            error: { code: "DELIVERY_ERROR", message: error.message ?? String(err) },
            durationMs: Date.now() - started,
          });
        }
        order += 1;
      }
      return { attempts, deliveredVia };
    },
  };
}
