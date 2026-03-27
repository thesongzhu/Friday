import { FridayDomainError } from "#errors";

/**
 * Semver — Lightweight semantic versioning parser and range matcher.
 *
 * Supports standard semver (major.minor.patch[-prerelease][+build]) and
 * common range operators: exact, ^, ~, >=, <=, >, <, hyphen ranges, and
 * space-separated intersections.
 *
 * Pure TypeScript, zero external dependencies.
 *
 * @module packaging/engine/semver
 */

// ─── Parsed Version ───

/** Parsed semantic version components. */
export interface SemverParsed {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

// ─── Regex ───

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/;

// ─── Parse ───

/** Parse a semver string into components. Returns `null` on invalid input. */
export function parseSemver(version: string): SemverParsed | null {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
    build: m[5] ? m[5].split(".") : [],
  };
}

/** Returns true if the string is a valid semver. */
export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null;
}

// ─── Compare ───

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1; // numeric < string
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two semver versions.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 * Build metadata is ignored per the semver spec.
 */
export function compareSemver(a: SemverParsed, b: SemverParsed): number {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d !== 0) return d;

  // No prerelease on either → equal
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  // Prerelease has lower precedence than release
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** Compare two semver version strings. */
export function compareSemverStr(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new FridayDomainError("VALIDATION_ERROR", `Invalid semver: ${!pa ? a : b}`, { httpStatus: 400 });
  return compareSemver(pa, pb);
}

// ─── Range Matching ───

/** A single comparator: operator + version. */
interface Comparator {
  readonly op: ">=" | "<=" | ">" | "<" | "=";
  readonly version: SemverParsed;
}

/** A range is a union (||) of intersections (space-separated comparators). */
type RangeSet = readonly (readonly Comparator[])[];

function satisfiesComparator(v: SemverParsed, c: Comparator): boolean {
  const cmp = compareSemver(v, c.version);
  switch (c.op) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
  }
}

function parseComparator(raw: string): Comparator | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!m) return null;

  const opRaw = m[1] ?? "=";
  if (opRaw !== ">=" && opRaw !== "<=" && opRaw !== ">" && opRaw !== "<" && opRaw !== "=") {
    return null;
  }
  const op: Comparator["op"] = opRaw;
  const version = parseSemver(m[2]);
  if (!version) return null;
  return { op, version };
}

function expandCaret(version: SemverParsed): readonly Comparator[] {
  const lower: Comparator = { op: ">=", version };
  let upper: Comparator;
  if (version.major !== 0) {
    upper = {
      op: "<",
      version: { major: version.major + 1, minor: 0, patch: 0, prerelease: [], build: [] },
    };
  } else if (version.minor !== 0) {
    upper = {
      op: "<",
      version: { major: 0, minor: version.minor + 1, patch: 0, prerelease: [], build: [] },
    };
  } else {
    upper = {
      op: "<",
      version: { major: 0, minor: 0, patch: version.patch + 1, prerelease: [], build: [] },
    };
  }
  return [lower, upper];
}

function expandTilde(version: SemverParsed): readonly Comparator[] {
  const lower: Comparator = { op: ">=", version };
  const upper: Comparator = {
    op: "<",
    version: { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [], build: [] },
  };
  return [lower, upper];
}

function parseRangeIntersection(raw: string): readonly Comparator[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const comparators: Comparator[] = [];

  // Handle hyphen range: "1.0.0 - 2.0.0"
  const hyphenMatch = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphenMatch) {
    const lower = parseSemver(hyphenMatch[1]);
    const upper = parseSemver(hyphenMatch[2]);
    if (!lower || !upper) {
      return [];
    }
    return [
      { op: ">=", version: lower },
      { op: "<=", version: upper },
    ];
  }

  // Split on whitespace for space-separated comparators
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (part.startsWith("^")) {
      const v = parseSemver(part.slice(1));
      if (!v) return [];
      comparators.push(...expandCaret(v));
    } else if (part.startsWith("~")) {
      const v = parseSemver(part.slice(1));
      if (!v) return [];
      comparators.push(...expandTilde(v));
    } else {
      const c = parseComparator(part);
      if (!c) return [];
      comparators.push(c);
    }
  }

  return comparators.length > 0 ? comparators : [];
}

function parseRange(range: string): RangeSet {
  const trimmed = range.trim();

  if (!trimmed) {
    return [];
  }

  // Handle wildcard
  if (trimmed === "*") {
    return [[{ op: ">=", version: { major: 0, minor: 0, patch: 0, prerelease: [], build: [] } }]];
  }

  const intersections = range
    .split("||")
    .map((part) => parseRangeIntersection(part));

  if (intersections.length === 0 || intersections.some((intersection) => intersection.length === 0)) {
    return [];
  }

  return intersections;
}

/**
 * Check if a version satisfies a semver range.
 *
 * Supported range syntax:
 * - Exact: `1.2.3`
 * - Caret: `^1.2.3` (compatible with major)
 * - Tilde: `~1.2.3` (compatible with minor)
 * - Operators: `>=1.0.0`, `<2.0.0`, `>1.0.0 <=2.0.0`
 * - Hyphen: `1.0.0 - 2.0.0`
 * - Union: `>=1.0.0 <2.0.0 || >=3.0.0`
 * - Wildcard: `*`
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;

  const rangeSet = parseRange(range);
  if (rangeSet.length === 0) return false;
  return rangeSet.some((intersection) =>
    intersection.every((c) => satisfiesComparator(v, c)),
  );
}

/**
 * Returns true if a semver range string has valid syntax.
 */
export function isValidSemverRange(range: string): boolean {
  return parseRange(range).length > 0;
}

/**
 * Find the highest version from a list that satisfies a range.
 * Returns `null` if no version satisfies.
 */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  let best: string | null = null;
  let bestParsed: SemverParsed | null = null;

  for (const v of versions) {
    if (!satisfiesRange(v, range)) continue;
    const parsed = parseSemver(v);
    if (!parsed) continue;
    if (!bestParsed || compareSemver(parsed, bestParsed) > 0) {
      best = v;
      bestParsed = parsed;
    }
  }
  return best;
}

/**
 * Check if two semver ranges can be simultaneously satisfied.
 * Returns true if there could exist a version satisfying both ranges.
 *
 * This is a heuristic: it tests a set of boundary versions from each range.
 * For production use with large registries, test against actual available versions.
 */
export function rangesIntersect(rangeA: string, rangeB: string): boolean {
  // Quick path: try a large set of synthetic versions
  const testVersions: string[] = [];
  for (let major = 0; major <= 20; major++) {
    for (let minor = 0; minor <= 20; minor++) {
      testVersions.push(`${major}.${minor}.0`);
    }
  }
  return testVersions.some(
    (v) => satisfiesRange(v, rangeA) && satisfiesRange(v, rangeB),
  );
}
