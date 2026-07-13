/**
 * Cron matching and next-fire computation utilities.
 *
 * Supports standard 5-field cron expressions: minute hour dom month dow.
 *
 * Timezone semantics (TIME-CLOCK-SEMANTICS-001):
 *   Schedule triggers carry a required `timezone` (FridayScheduleTrigger.timezone,
 *   persisted as cron_timezone). When a non-UTC IANA timezone is supplied the cron
 *   wall-clock is interpreted in that zone, so a "0 9 * * *" schedule fires at 09:00
 *   local time and tracks DST offset shifts (e.g. 14:00 UTC in EST winter, 13:00 UTC
 *   in EDT summer). When the timezone is omitted, empty, or "UTC", behavior is
 *   byte-identical to the historical UTC-only implementation.
 */

import { CronExpressionParser } from "cron-parser";

// ─── Timezone-aware field extraction ───

interface CronDateFields {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

const WEEKDAY_TO_DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function isUtcZone(timeZone: string | undefined): boolean {
  return !timeZone || timeZone === "UTC" || timeZone === "Etc/UTC";
}

/**
 * Extract cron calendar fields from a Date. Defaults to UTC (byte-identical to the
 * historical getUTC* path). For a non-UTC IANA timezone the fields are computed in
 * that timezone via Intl.DateTimeFormat.
 */
function extractCronFields(date: Date, timeZone?: string): CronDateFields {
  if (isUtcZone(timeZone)) {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
    };
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }

  return {
    minute: parseInt(lookup.minute!, 10),
    hour: parseInt(lookup.hour!, 10),
    dom: parseInt(lookup.day!, 10),
    month: parseInt(lookup.month!, 10),
    dow: WEEKDAY_TO_DOW[lookup.weekday!] ?? new Date(date).getUTCDay(),
  };
}

// ─── Cron field matching ───

export function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  const parts = field.split(",");
  for (const part of parts) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) continue;

      if (range === "*") {
        if (value % step === 0) return true;
      } else if (range!.includes("-")) {
        const [startStr, endStr] = range!.split("-");
        const start = parseInt(startStr!, 10);
        const end = parseInt(endStr!, 10);
        if (value >= start && value <= end && (value - start) % step === 0) return true;
      }
      continue;
    }

    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (value >= start && value <= end) return true;
      continue;
    }

    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

/**
 * Check whether a 5-field cron expression matches a given Date.
 *
 * @param timeZone Optional IANA timezone. When omitted/UTC the cron is evaluated in
 *   UTC (unchanged historical behavior); otherwise the cron wall-clock is evaluated
 *   in the supplied timezone.
 */
export function matchesCron(cron: string, date: Date, timeZone?: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minute, hour, dom, month, dow] = fields;
  const f = extractCronFields(date, timeZone);
  return (
    matchesCronField(minute!, f.minute) &&
    matchesCronField(hour!, f.hour) &&
    matchesCronField(dom!, f.dom) &&
    matchesCronField(month!, f.month) &&
    matchesCronField(dow!, f.dow)
  );
}

/**
 * Compute the next fire time after a given date for a 5-field cron expression.
 *
 * For UTC (default) the search is minute-by-minute up to maxMinutes
 * (default 525600 = 1 year), returning null if no match is found within the window.
 *
 * For a non-UTC IANA timezone the next occurrence is resolved with the
 * timezone-aware cron-parser engine (the same engine the job scheduler uses), which
 * yields DST-correct instants and does not double-fire across fall-back overlaps.
 * Returns null on an invalid expression.
 *
 * @param timeZone Optional IANA timezone for interpreting the cron wall-clock.
 */
export function computeNextCronFire(
  cron: string,
  after: Date,
  maxMinutes: number = 525_600,
  timeZone?: string,
): Date | null {
  if (!isUtcZone(timeZone)) {
    // 5-field contract parity with the UTC matcher: reject other arities.
    if (cron.trim().split(/\s+/).length !== 5) return null;
    try {
      const next = CronExpressionParser.parse(cron, {
        currentDate: after,
        tz: timeZone,
      }).next();
      return new Date(next.getTime());
    } catch (err) {
      console.warn(
        "[friday][cron-utils] timezone-aware next-fire computation failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  // ─── UTC path (unchanged) ───
  // Start from the next minute boundary
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < maxMinutes; i++) {
    if (matchesCron(cron, candidate)) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return null;
}
