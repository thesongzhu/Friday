import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const CITATION_PATTERNS = [
  { label: "URL reference", pattern: /https?:\/\/[^\s]+/gi },
  { label: "DOI reference", pattern: /\b10\.\d{4,9}\/[^\s]+/gi },
  { label: "Academic citation", pattern: /\(([A-Z][a-z]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z]+))?),?\s*\d{4}\)/g },
  { label: "Footnote marker", pattern: /\[\d+\]/g },
];

const DATE_PATTERNS = [
  /\b(19|20)\d{2}\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/gi,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];

const AUTHOR_PATTERNS = [
  /\b(?:by|author|written by|reported by|published by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/gi,
  /\b(?:Dr|Prof|Professor)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g,
];

const BIAS_INDICATORS = [
  { label: "emotional language", patterns: [/\b(amazing|terrible|shocking|unbelievable|outrageous|incredible)\b/gi] },
  { label: "absolutist claims", patterns: [/\b(always|never|every single|no one ever|guaranteed|proven fact)\b/gi] },
  { label: "unattributed claims", patterns: [/\b(studies show|experts say|research proves|scientists confirm)\b/gi] },
  { label: "promotional tone", patterns: [/\b(best ever|number one|#1|top rated|exclusive|limited time)\b/gi] },
  { label: "conspiracy markers", patterns: [/\b(they don't want you|hidden truth|cover[- ]?up|wake up|sheeple)\b/gi] },
];

const AUTHORITY_DOMAINS = [
  /\.gov\b/i, /\.edu\b/i, /\.org\b/i, /\.ac\.[a-z]{2}\b/i,
  /nature\.com/i, /science\.org/i, /pubmed/i, /arxiv\.org/i,
  /reuters\.com/i, /apnews\.com/i, /bbc\.co/i,
];

function extractMatches(text, patterns) {
  const results = [];
  for (const p of patterns) {
    const regex = p instanceof RegExp ? p : p.pattern;
    const label = p.label || "match";
    const matches = text.match(regex);
    if (matches) {
      results.push({ label, count: matches.length, samples: matches.slice(0, 3) });
    }
  }
  return results;
}

function scoreCitations(text) {
  const found = extractMatches(text, CITATION_PATTERNS);
  const total = found.reduce((s, f) => s + f.count, 0);
  return { found, total, score: Math.min(total * 15, 40) };
}

function scoreDates(text) {
  const allDates = [];
  for (const p of DATE_PATTERNS) {
    const m = text.match(p);
    if (m) allDates.push(...m);
  }
  const unique = [...new Set(allDates)];
  const hasRecent = unique.some((d) => {
    const year = parseInt(d.match(/(19|20)\d{2}/)?.[0] || "0", 10);
    return year >= 2020;
  });
  return {
    datesFound: unique.slice(0, 5),
    hasRecent,
    score: unique.length > 0 ? (hasRecent ? 20 : 10) : 0,
  };
}

function scoreAuthors(text) {
  const authors = [];
  for (const p of AUTHOR_PATTERNS) {
    let m;
    const regex = new RegExp(p.source, p.flags);
    while ((m = regex.exec(text)) !== null) {
      if (m[1]) authors.push(m[1].trim());
    }
  }
  const unique = [...new Set(authors)];
  return { authors: unique.slice(0, 5), score: unique.length > 0 ? 20 : 0 };
}

function detectBias(text) {
  const flags = [];
  for (const indicator of BIAS_INDICATORS) {
    for (const p of indicator.patterns) {
      const matches = text.match(p);
      if (matches && matches.length > 0) {
        flags.push({ type: indicator.label, count: matches.length, samples: matches.slice(0, 2) });
      }
    }
  }
  const penalty = Math.min(flags.reduce((s, f) => s + f.count * 5, 0), 30);
  return { flags, penalty };
}

function scoreAuthorityDomains(text) {
  const found = [];
  for (const p of AUTHORITY_DOMAINS) {
    if (p.test(text)) found.push(p.source.replace(/\\b/g, "").replace(/\\/g, ""));
  }
  return { domains: found, score: Math.min(found.length * 10, 20) };
}

function reliabilityLabel(score) {
  if (score >= 75) return "high";
  if (score >= 45) return "moderate";
  if (score >= 20) return "low";
  return "very low";
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("source-validation-skill requires a content input.");
  }

  const citations = scoreCitations(content);
  const dates = scoreDates(content);
  const authors = scoreAuthors(content);
  const bias = detectBias(content);
  const authority = scoreAuthorityDomains(content);

  const rawScore = citations.score + dates.score + authors.score + authority.score - bias.penalty;
  const reliabilityScore = Math.max(0, Math.min(100, rawScore));
  const reliability = reliabilityLabel(reliabilityScore);

  const issues = [];
  if (citations.total === 0) issues.push("No citations or references found.");
  if (dates.datesFound.length === 0) issues.push("No dates found; timeliness cannot be assessed.");
  if (!dates.hasRecent && dates.datesFound.length > 0) issues.push("No recent dates detected; content may be outdated.");
  if (authors.authors.length === 0) issues.push("No author attribution detected.");
  if (bias.flags.length > 0) issues.push(`Potential bias detected: ${bias.flags.map((f) => f.type).join(", ")}.`);

  const strengths = [];
  if (citations.total > 2) strengths.push(`Contains ${citations.total} citation(s).`);
  if (authority.domains.length > 0) strengths.push(`References authoritative domains.`);
  if (dates.hasRecent) strengths.push("Includes recent date references.");
  if (authors.authors.length > 0) strengths.push(`Author attribution present: ${authors.authors.join(", ")}.`);

  return {
    summary: `Source reliability: ${reliability} (score ${reliabilityScore}/100) with ${issues.length} issue(s) and ${strengths.length} strength(s).`,
    nextStep: issues.length > 0
      ? `Address the top issue: ${issues[0]}`
      : "Content appears well-sourced; proceed with confidence.",
    details: {
      reliabilityScore,
      reliability,
      citations: { total: citations.total, found: citations.found },
      dates: { found: dates.datesFound, hasRecent: dates.hasRecent },
      authors: authors.authors,
      authorityDomains: authority.domains,
      biasFlags: bias.flags,
      issues,
      strengths,
    },
  };
}
