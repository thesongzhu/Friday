import type { HomeWidgetId } from "@/lib/packs/pack-registry";

const VISIT_STORAGE_KEY = "friday.intent.page-visits";
const MAX_HISTORY = 50;

interface PageVisit {
  path: string;
  ts: number;
}

function readVisits(): PageVisit[] {
  try {
    const raw = localStorage.getItem(VISIT_STORAGE_KEY);
    return raw ? JSON.parse(raw) as PageVisit[] : [];
  } catch {
    return [];
  }
}

function writeVisits(visits: PageVisit[]): void {
  try {
    localStorage.setItem(VISIT_STORAGE_KEY, JSON.stringify(visits.slice(-MAX_HISTORY)));
  } catch {
    // Ignore storage errors
  }
}

/** Record a page visit for intent tracking. */
export function recordPageVisit(path: string): void {
  const visits = readVisits();
  visits.push({ path, ts: Date.now() });
  writeVisits(visits);
}

/** Get the top N most visited paths in the last 7 days. */
export function getFrequentPages(topN = 5): string[] {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const visits = readVisits().filter((v) => v.ts > cutoff);
  const counts = new Map<string, number>();
  for (const v of visits) {
    counts.set(v.path, (counts.get(v.path) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([path]) => path);
}

/**
 * Compute a smart widget order based on current context.
 * Returns a suggested reorder of widget IDs, or null if no smart suggestion.
 */
export function computeIntentWidgetOrder(input: {
  currentWidgetOrder: HomeWidgetId[];
  hasActiveAlerts: boolean;
  hasActiveRuns: boolean;
  hasPendingApprovals: boolean;
  hasScheduledSoon: boolean;
  hour: number;
}): HomeWidgetId[] | null {
  const { currentWidgetOrder, hasActiveAlerts, hasActiveRuns, hasPendingApprovals, hasScheduledSoon, hour } = input;

  // Don't interfere if user has a custom order with few widgets
  if (currentWidgetOrder.length <= 2) return null;

  const priority: HomeWidgetId[] = [];
  const rest: HomeWidgetId[] = [...currentWidgetOrder];

  function promote(id: HomeWidgetId) {
    const idx = rest.indexOf(id);
    if (idx >= 0) {
      rest.splice(idx, 1);
      priority.push(id);
    }
  }

  // Active work always first
  if (hasActiveRuns) promote("active_now");

  // Pending approvals high priority
  if (hasPendingApprovals) promote("pending_approvals");

  // Morning (6-12): scheduled work matters most
  if (hour >= 6 && hour < 12 && hasScheduledSoon) promote("scheduled_soon");

  // Evening (18-24): results matter most
  if (hour >= 18) promote("recent_results");

  // If nothing was promoted, no change needed
  if (priority.length === 0) return null;

  return [...priority, ...rest];
}
