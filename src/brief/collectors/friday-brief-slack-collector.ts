import {
  buildSkippedCollectionResult,
  runCollectorSafely,
  type FridayBriefCollector,
  type FridayBriefCollectorContext,
} from "./friday-brief-collector.types.js";
import type { FridayBriefEvent } from "../friday-brief.types.js";

interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  type?: string;
  subtype?: string;
}

export interface FridayBriefSlackCollectorDeps {
  resolveSecret: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

async function callSlack<T>(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  method: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams(params).toString();
  const response = await fetchImpl(`${apiBase}/${method}?${search}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`slack_http_${String(response.status)}`);
  const parsed = (await response.json()) as { ok: boolean; error?: string };
  if (!parsed.ok) throw new Error(`slack_err:${parsed.error ?? "unknown"}`);
  return parsed as T;
}

export function createFridayBriefSlackCollector(
  deps: FridayBriefSlackCollectorDeps,
): FridayBriefCollector {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? "https://slack.com/api";

  return {
    source: "slack",
    isEnabled(config) {
      return config.sources.slack.enabled;
    },
    async collect(ctx: FridayBriefCollectorContext) {
      const cfg = ctx.config.sources.slack;
      if (!cfg.enabled) return buildSkippedCollectionResult("slack", "source_disabled");
      const token = deps.resolveSecret(cfg.tokenRefKey);
      if (!token) return buildSkippedCollectionResult("slack", "missing_token");

      return runCollectorSafely("slack", async () => {
        const conversations = await callSlack<{ channels: SlackConversation[] }>(
          fetchImpl,
          apiBase,
          token,
          "conversations.list",
          {
            types: cfg.includeDms ? "public_channel,private_channel,im,mpim" : "public_channel,private_channel",
            exclude_archived: "true",
            limit: "200",
          },
          ctx.signal,
        );
        const fromTs = (new Date(ctx.fromIso).getTime() / 1000).toFixed(6);
        const toTs = (new Date(ctx.toIso).getTime() / 1000).toFixed(6);
        const wanted = cfg.channels.length > 0 ? new Set(cfg.channels) : null;

        const events: FridayBriefEvent[] = [];
        for (const conv of conversations.channels) {
          if (wanted && !wanted.has(conv.id)) continue;
          try {
            const history = await callSlack<{ messages: SlackMessage[] }>(
              fetchImpl,
              apiBase,
              token,
              "conversations.history",
              {
                channel: conv.id,
                oldest: fromTs,
                latest: toTs,
                limit: "50",
                inclusive: "true",
              },
              ctx.signal,
            );
            for (const msg of history.messages ?? []) {
              if (!msg.text || msg.subtype === "channel_join") continue;
              if (cfg.userId && msg.user !== cfg.userId && !conv.is_im) continue;
              const tsSec = Number(msg.ts);
              const iso = new Date(tsSec * 1000).toISOString();
              events.push({
                source: "slack",
                occurredAt: iso,
                externalId: `${conv.id}:${msg.ts}`,
                summary: `#${conv.name ?? conv.id}: ${msg.text.slice(0, 160)}`,
                detail: msg.text.length > 160 ? msg.text : undefined,
                actor: msg.user,
                tags: [conv.name ?? conv.id, conv.is_im ? "dm" : "channel"],
              });
            }
          } catch (err) {
            events.push({
              source: "slack",
              occurredAt: ctx.toIso,
              externalId: `error:${conv.id}`,
              summary: `Slack history for ${conv.name ?? conv.id} failed: ${(err as Error).message}`,
              tags: ["error"],
            });
          }
        }
        return { events };
      });
    },
  };
}
