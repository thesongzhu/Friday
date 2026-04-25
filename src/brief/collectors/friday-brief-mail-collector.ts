import {
  buildSkippedCollectionResult,
  type FridayBriefCollector,
  type FridayBriefCollectorContext,
  runCollectorSafely,
} from "./friday-brief-collector.types.js";
import type { FridayBriefEvent } from "../friday-brief.types.js";

interface GmailMessageListItem {
  id: string;
  threadId: string;
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
  labelIds?: string[];
}

interface OutlookMessage {
  id: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  subject?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  sender?: { emailAddress?: { address?: string } };
}

export interface FridayBriefMailCollectorDeps {
  resolveSecret: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
}

function headerValue(msg: GmailMessage, name: string): string | undefined {
  const header = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value;
}

async function collectGmail(
  fetchImpl: typeof fetch,
  token: string,
  ctx: FridayBriefCollectorContext,
  vipSenders: readonly string[],
  includeReceived: boolean,
): Promise<FridayBriefEvent[]> {
  const fromSec = Math.floor(new Date(ctx.fromIso).getTime() / 1000);
  const queries: string[] = [`after:${fromSec} (in:sent`];
  if (includeReceived) {
    const vipQuery = vipSenders.length > 0
      ? ` OR (in:inbox (${vipSenders.map((s) => `from:${s}`).join(" OR ")}))`
      : "";
    queries.push(`${vipQuery})`);
  } else {
    queries.push(")");
  }
  const query = queries.join("");
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(query)}`;
  const listRes = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!listRes.ok) throw new Error(`gmail_http_${String(listRes.status)}`);
  const list = (await listRes.json()) as { messages?: GmailMessageListItem[] };
  const out: FridayBriefEvent[] = [];
  for (const item of list.messages ?? []) {
    const detailRes = await fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal },
    );
    if (!detailRes.ok) continue;
    const msg = (await detailRes.json()) as GmailMessage;
    const subject = headerValue(msg, "Subject") ?? "(no subject)";
    const from = headerValue(msg, "From") ?? "";
    const occurredAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : ctx.toIso;
    const sent = msg.labelIds?.includes("SENT");
    out.push({
      source: "mail",
      occurredAt,
      externalId: `gmail:${item.id}`,
      summary: `${sent ? "Sent" : "Received"}: ${subject}`,
      detail: msg.snippet,
      actor: from,
      tags: sent ? ["sent"] : ["received"],
    });
  }
  return out;
}

async function collectOutlook(
  fetchImpl: typeof fetch,
  token: string,
  ctx: FridayBriefCollectorContext,
  vipSenders: readonly string[],
  includeReceived: boolean,
): Promise<FridayBriefEvent[]> {
  const out: FridayBriefEvent[] = [];
  const query = `?$top=50&$select=id,subject,bodyPreview,from,sender,receivedDateTime,sentDateTime`;
  const sentFilter = `&$filter=sentDateTime ge ${ctx.fromIso}`;
  const sentRes = await fetchImpl(
    `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages${query}${sentFilter}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal },
  );
  if (!sentRes.ok) throw new Error(`outlook_http_${String(sentRes.status)}`);
  const sent = (await sentRes.json()) as { value: OutlookMessage[] };
  for (const msg of sent.value ?? []) {
    out.push({
      source: "mail",
      occurredAt: msg.sentDateTime ?? ctx.toIso,
      externalId: `outlook:${msg.id}`,
      summary: `Sent: ${msg.subject ?? "(no subject)"}`,
      detail: msg.bodyPreview,
      actor: msg.from?.emailAddress?.address,
      tags: ["sent"],
    });
  }
  if (includeReceived) {
    const vipFilter = vipSenders.length > 0
      ? ` and (${vipSenders.map((s) => `from/emailAddress/address eq '${s.replace(/'/g, "''")}'`).join(" or ")})`
      : "";
    const inboxFilter = `&$filter=receivedDateTime ge ${ctx.fromIso}${vipFilter}`;
    const inboxRes = await fetchImpl(
      `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages${query}${inboxFilter}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal },
    );
    if (inboxRes.ok) {
      const inbox = (await inboxRes.json()) as { value: OutlookMessage[] };
      for (const msg of inbox.value ?? []) {
        out.push({
          source: "mail",
          occurredAt: msg.receivedDateTime ?? ctx.toIso,
          externalId: `outlook:${msg.id}`,
          summary: `Received: ${msg.subject ?? "(no subject)"}`,
          detail: msg.bodyPreview,
          actor: msg.from?.emailAddress?.address,
          tags: ["received"],
        });
      }
    }
  }
  return out;
}

export function createFridayBriefMailCollector(
  deps: FridayBriefMailCollectorDeps,
): FridayBriefCollector {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    source: "mail",
    isEnabled(config) {
      return config.sources.mail.enabled;
    },
    async collect(ctx: FridayBriefCollectorContext) {
      const cfg = ctx.config.sources.mail;
      if (!cfg.enabled) return buildSkippedCollectionResult("mail", "source_disabled");
      if (!cfg.provider) return buildSkippedCollectionResult("mail", "provider_not_chosen");
      const token = deps.resolveSecret(cfg.credentialRefKey);
      if (!token) return buildSkippedCollectionResult("mail", "missing_token");

      return runCollectorSafely("mail", async () => {
        const events = cfg.provider === "gmail"
          ? await collectGmail(fetchImpl, token, ctx, cfg.vipSenders, cfg.includeReceived)
          : await collectOutlook(fetchImpl, token, ctx, cfg.vipSenders, cfg.includeReceived);
        return { events };
      });
    },
  };
}
