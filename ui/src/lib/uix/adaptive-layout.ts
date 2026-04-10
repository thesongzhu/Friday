const VISIT_KEY = "friday.adaptive.nav-visits";
const MAX_ENTRIES = 200;

interface NavVisit {
  path: string;
  ts: number;
}

function readNavVisits(): NavVisit[] {
  try {
    const raw = localStorage.getItem(VISIT_KEY);
    return raw ? JSON.parse(raw) as NavVisit[] : [];
  } catch {
    return [];
  }
}

function writeNavVisits(visits: NavVisit[]): void {
  try {
    localStorage.setItem(VISIT_KEY, JSON.stringify(visits.slice(-MAX_ENTRIES)));
  } catch {
    // Ignore
  }
}

/** Record a nav page visit. */
export function recordNavVisit(path: string): void {
  const visits = readNavVisits();
  visits.push({ path, ts: Date.now() });
  writeNavVisits(visits);
}

/**
 * Sort navigation items by visit frequency (last 14 days).
 * Returns the paths in frequency order (most visited first).
 */
export function sortNavByFrequency(paths: string[]): string[] {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const visits = readNavVisits().filter((v) => v.ts > cutoff);
  const counts = new Map<string, number>();
  for (const v of visits) {
    counts.set(v.path, (counts.get(v.path) ?? 0) + 1);
  }
  return [...paths].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}
