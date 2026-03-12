/**
 * Cron matching and next-fire computation utilities.
 *
 * Supports standard 5-field cron expressions: minute hour dom month dow.
 */

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
 */
export function matchesCron(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minute, hour, dom, month, dow] = fields;
  return (
    matchesCronField(minute!, date.getUTCMinutes()) &&
    matchesCronField(hour!, date.getUTCHours()) &&
    matchesCronField(dom!, date.getUTCDate()) &&
    matchesCronField(month!, date.getUTCMonth() + 1) &&
    matchesCronField(dow!, date.getUTCDay())
  );
}

/**
 * Compute the next fire time after a given date for a 5-field cron expression.
 * Searches minute-by-minute up to maxMinutes (default 525600 = 1 year).
 *
 * Returns null if no matching time found within the search window.
 */
export function computeNextCronFire(
  cron: string,
  after: Date,
  maxMinutes: number = 525_600,
): Date | null {
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
