const AUTO_FIX_TITLE_PREFIX_PATTERN = /^(?:Auto-fixed|Auto-fix|Failed fix):\s*/i;
const MAX_AUTO_FIX_TITLE_BASE_LENGTH = 160;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeAutoFixTitleBase(value: string): string {
  let normalized = normalizeWhitespace(value);
  let previous = "";

  while (normalized.length > 0 && normalized !== previous) {
    previous = normalized;
    normalized = normalizeWhitespace(normalized.replace(AUTO_FIX_TITLE_PREFIX_PATTERN, ""));
  }

  if (normalized.length === 0) {
    return "remediation";
  }

  if (normalized.length <= MAX_AUTO_FIX_TITLE_BASE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_AUTO_FIX_TITLE_BASE_LENGTH - 3).trimEnd()}...`;
}

export function buildAutoFixPlanTitle(lessonTitle: string): string {
  return `Auto-fix: ${normalizeAutoFixTitleBase(lessonTitle)}`;
}

export function buildAutoFixedLessonTitle(planTitle: string): string {
  return `Auto-fixed: ${normalizeAutoFixTitleBase(planTitle)}`;
}

export function buildFailedFixLessonTitle(planTitle: string): string {
  return `Failed fix: ${normalizeAutoFixTitleBase(planTitle)}`;
}
