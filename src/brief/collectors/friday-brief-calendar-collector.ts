import {
  buildSkippedCollectionResult,
  type FridayBriefCollector,
  type FridayBriefCollectorContext,
  runCollectorSafely,
} from "./friday-brief-collector.types.js";
import type { FridayBriefEvent } from "../friday-brief.types.js";

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean }>;
  htmlLink?: string;
}

interface OutlookCalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: { address?: string } };
  responseStatus?: { response?: string };
}

export interface FridayBriefCalendarCollectorDeps {
  resolveSecret: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
}

async function collectGoogleCalendar(
  fetchImpl: typeof fetch,
  token: string,
  ctx: FridayBriefCollectorContext,
  calendarIds: readonly string[],
  includeDeclined: boolean,
): Promise<FridayBriefEvent[]> {
  const ids = calendarIds.length > 0 ? calendarIds : ["primary"];
  const out: FridayBriefEvent[] = [];
  for (const id of ids) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`);
    url.searchParams.set("timeMin", ctx.fromIso);
    url.searchParams.set("timeMax", ctx.toIso);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "50");
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctx.signal,
    });
    if (!response.ok) continue;
    const parsed = (await response.json()) as { items?: GoogleCalendarEvent[] };
    for (const evt of parsed.items ?? []) {
      const selfAttendance = evt.attendees?.find((a) => a.self);
      if (!includeDeclined && selfAttendance?.responseStatus === "declined") continue;
      const occurredAt = evt.start?.dateTime ?? (evt.start?.date ? `${evt.start.date}T00:00:00Z` : ctx.fromIso);
      out.push({
        source: "calendar",
        occurredAt,
        externalId: `gcal:${id}:${evt.id}`,
        summary: `Calendar: ${evt.summary ?? "(untitled)"}`,
        detail: evt.description,
        url: evt.htmlLink,
        tags: [id, selfAttendance?.responseStatus ?? "unknown"],
      });
    }
  }
  return out;
}

async function collectOutlookCalendar(
  fetchImpl: typeof fetch,
  token: string,
  ctx: FridayBriefCollectorContext,
  calendarIds: readonly string[],
  includeDeclined: boolean,
): Promise<FridayBriefEvent[]> {
  const ids = calendarIds.length > 0 ? calendarIds : ["primary"];
  const out: FridayBriefEvent[] = [];
  for (const id of ids) {
    const endpoint = id === "primary"
      ? "https://graph.microsoft.com/v1.0/me/calendarView"
      : `https://graph.microsoft.com/v1.0/me/calendars/${id}/calendarView`;
    const url = new URL(endpoint);
    url.searchParams.set("startDateTime", ctx.fromIso);
    url.searchParams.set("endDateTime", ctx.toIso);
    url.searchParams.set("$top", "50");
    url.searchParams.set(
      "$select",
      "id,subject,bodyPreview,start,end,organizer,responseStatus",
    );
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctx.signal,
    });
    if (!response.ok) continue;
    const parsed = (await response.json()) as { value?: OutlookCalendarEvent[] };
    for (const evt of parsed.value ?? []) {
      const status = evt.responseStatus?.response;
      if (!includeDeclined && status === "declined") continue;
      out.push({
        source: "calendar",
        occurredAt: evt.start?.dateTime ?? ctx.fromIso,
        externalId: `outlook-cal:${id}:${evt.id}`,
        summary: `Calendar: ${evt.subject ?? "(untitled)"}`,
        detail: evt.bodyPreview,
        actor: evt.organizer?.emailAddress?.address,
        tags: [id, status ?? "unknown"],
      });
    }
  }
  return out;
}

export function createFridayBriefCalendarCollector(
  deps: FridayBriefCalendarCollectorDeps,
): FridayBriefCollector {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    source: "calendar",
    isEnabled(config) {
      return config.sources.calendar.enabled;
    },
    async collect(ctx: FridayBriefCollectorContext) {
      const cfg = ctx.config.sources.calendar;
      if (!cfg.enabled) return buildSkippedCollectionResult("calendar", "source_disabled");
      if (!cfg.provider) return buildSkippedCollectionResult("calendar", "provider_not_chosen");
      const token = deps.resolveSecret(cfg.credentialRefKey);
      if (!token) return buildSkippedCollectionResult("calendar", "missing_token");

      return runCollectorSafely("calendar", async () => {
        const events = cfg.provider === "google"
          ? await collectGoogleCalendar(fetchImpl, token, ctx, cfg.calendarIds, cfg.includeDeclined)
          : await collectOutlookCalendar(fetchImpl, token, ctx, cfg.calendarIds, cfg.includeDeclined);
        return { events };
      });
    },
  };
}
