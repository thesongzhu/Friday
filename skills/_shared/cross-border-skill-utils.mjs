import { asString, compact } from "./friday-runtime-skill-utils.mjs";

const MAX_LINE_LENGTH = 280;
const MAX_LINES = 80;

export function readSkillInputText(input, ...keys) {
  const fields = keys.length > 0 ? keys : ["text", "notes"];
  for (const key of fields) {
    const value = input?.[key];
    const text = asString(value);
    if (text) {
      return text;
    }
    if (value && typeof value === "object") {
      const nested = asString(value.text)
        || asString(value.summary)
        || asString(value.value);
      if (nested) {
        return nested;
      }
      try {
        const serialized = JSON.stringify(value);
        if (serialized && serialized !== "{}" && serialized !== "[]") {
          return serialized;
        }
      } catch {
        // ignore non-serializable shapes; fall through
      }
    }
  }
  return "";
}

export function tokenizeNotes(text) {
  const value = asString(text);
  if (!value) return [];
  return value
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_LINES)
    .map((line) => (line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line));
}

export function bucketLines(lines, buckets) {
  const result = {};
  for (const bucket of buckets) {
    result[bucket.id] = {
      id: bucket.id,
      label: bucket.label,
      keywords: [...bucket.keywords],
      lines: [],
    };
  }
  for (const line of lines) {
    const lower = line.toLowerCase();
    let placed = false;
    for (const bucket of buckets) {
      if (bucket.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
        result[bucket.id].lines.push(line);
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (!result.__other__) {
        result.__other__ = { id: "other", label: "Other", keywords: [], lines: [] };
      }
      result.__other__.lines.push(line);
    }
  }
  const orderedBuckets = buckets
    .map((bucket) => result[bucket.id])
    .filter((bucket) => bucket.lines.length > 0)
    .map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      count: bucket.lines.length,
      examples: bucket.lines.slice(0, 3),
    }));
  if (result.__other__ && result.__other__.lines.length > 0) {
    orderedBuckets.push({
      id: "other",
      label: result.__other__.label,
      count: result.__other__.lines.length,
      examples: result.__other__.lines.slice(0, 3),
    });
  }
  return orderedBuckets;
}

export function detectKeywordMatches(text, keywords) {
  const lower = asString(text).toLowerCase();
  if (!lower) return [];
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
}

export function summarizeBuckets(buckets, opts = {}) {
  const { headline = "Findings", emptyMessage = "No findings detected." } = opts;
  if (buckets.length === 0) {
    return emptyMessage;
  }
  const parts = buckets.map(
    (bucket) => `${bucket.label} (${String(bucket.count)}): ${compact(bucket.examples[0] ?? "", 140)}`,
  );
  return `${headline}: ${parts.join(" | ")}`;
}

export function buildLanguageSummary(lines) {
  let zhCount = 0;
  let enCount = 0;
  for (const line of lines) {
    if (/[一-鿿]/.test(line)) {
      zhCount += 1;
    }
    if (/[A-Za-z]/.test(line)) {
      enCount += 1;
    }
  }
  if (zhCount > 0 && enCount > zhCount) return "bilingual_en_dominant";
  if (zhCount > enCount) return "bilingual_zh_dominant";
  if (zhCount > 0 && enCount > 0) return "bilingual_balanced";
  if (zhCount > 0) return "zh";
  if (enCount > 0) return "en";
  return "unknown";
}

export function clampHighlights(items, maxCount = 5) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, maxCount).map((item) => compact(asString(item), 220));
}

export function buildEmptyResult(skillLabel, outputKey) {
  const summary = `${skillLabel}: no notes were provided, so Friday returned an empty bundle without inventing findings.`;
  return {
    [outputKey]: summary,
    summary,
    nextStep: `Add concrete notes for ${skillLabel.toLowerCase()} and rerun so Friday can cluster real signals.`,
    details: {
      skillLabel,
      outputKey,
      lineCount: 0,
      buckets: [],
      language: "unknown",
      hasInput: false,
    },
  };
}
