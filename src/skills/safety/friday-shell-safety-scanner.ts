// ─── Shell Safety Scanner ───
// Rules-based scanner that detects dangerous patterns in shell script content.
// Returns findings with severity levels: blocking, warning, advisory.

// ─── Types ───

export interface FridayShellSafetyFinding {
  id: string;
  level: "blocking" | "warning" | "advisory";
  pattern: string;
  line?: number;
  summary: string;
}

export interface FridayShellSafetyScanResult {
  verdict: "safe" | "needs_review" | "dangerous";
  findings: FridayShellSafetyFinding[];
}

// ─── Pattern definitions ───

interface PatternRule {
  id: string;
  level: "blocking" | "warning" | "advisory";
  regex: RegExp;
  summary: string;
}

const BLOCKING_PATTERNS: ReadonlyArray<PatternRule> = [
  {
    id: "rm-rf-root",
    level: "blocking",
    regex: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?|(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*\s+)\/(?:\s|$|;)/,
    summary: "Recursive force-delete from root filesystem",
  },
  {
    id: "rm-rf-root-combined",
    level: "blocking",
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|;)/,
    summary: "Recursive force-delete from root filesystem",
  },
  {
    id: "rm-rf-home",
    level: "blocking",
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+~(?:\/|\s|$|;)/,
    summary: "Recursive force-delete from home directory",
  },
  {
    id: "rm-recursive-dangerous-target",
    level: "blocking",
    regex: /\brm\b(?=[^\n;]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b)(?=[^\n;]*\s(?:"\/(?:["']?(?:\s|$|;)|\*["']?(?:\s|$|;)|(?:etc|bin|sbin|usr|var|lib|lib64|boot|dev|sys|proc|private|System|Applications)(?:\/|["']?(?:\s|$|;)))|'\/(?:["']?(?:\s|$|;)|\*["']?(?:\s|$|;)|(?:etc|bin|sbin|usr|var|lib|lib64|boot|dev|sys|proc|private|System|Applications)(?:\/|["']?(?:\s|$|;)))|\/(?:\s|$|;|\*|(?:etc|bin|sbin|usr|var|lib|lib64|boot|dev|sys|proc|private|System|Applications)(?:\/|\s|$|;))))/,
    summary: "Recursive delete targets root or root-owned system paths",
  },
  // B1 medium-severity sweep — close long-form-flag bypass of rm -rf.
  // The short-form patterns above match `-r` / `-f` / `-rf` / `-rR`, but a
  // crafty author could write `rm --recursive --force /` and avoid every
  // existing pattern. These two patterns match any `rm` invocation where a
  // `--recursive` (long-form) flag appears anywhere in the flag list and the
  // target is `/` or `~`. The intervening `[^\n;]*?` allows arbitrary
  // additional flags (e.g. `--force`, `--no-preserve-root`, `-v`) between
  // `--recursive` and the path. We anchor on `--recursive` only (not also
  // `--force`) because `rm --recursive /` is already destructive on its own.
  {
    id: "rm-recursive-longform-root",
    level: "blocking",
    regex: /\brm\s+(?:[^\n;]*?\s+)?--recursive(?:\s+[^\n;]*?)?\s+\/(?:\s|$|;)/,
    summary: "Recursive delete from root filesystem (long-form --recursive)",
  },
  {
    id: "rm-recursive-longform-home",
    level: "blocking",
    regex: /\brm\s+(?:[^\n;]*?\s+)?--recursive(?:\s+[^\n;]*?)?\s+~(?:\/|\s|$|;)/,
    summary: "Recursive delete from home directory (long-form --recursive)",
  },
  {
    id: "chmod-777",
    level: "blocking",
    regex: /\bchmod\s+777\b/,
    summary: "Setting world-readable/writable/executable permissions",
  },
  {
    id: "sudo-command",
    level: "blocking",
    regex: /\bsudo\b/,
    summary: "Privilege escalation via sudo",
  },
  {
    id: "curl-pipe-sh",
    level: "blocking",
    regex: /\bcurl\b[^|]*\|\s*(?:ba)?sh\b/,
    summary: "Piping curl output directly to shell interpreter",
  },
  {
    id: "wget-pipe-sh",
    level: "blocking",
    regex: /\bwget\b[^|]*\|\s*(?:ba)?sh\b/,
    summary: "Piping wget output directly to shell interpreter",
  },
  {
    id: "eval-variable",
    level: "blocking",
    regex: /\beval\s+.*\$/,
    summary: "eval with variable expansion is a code injection risk",
  },
  {
    id: "mkfs",
    level: "blocking",
    regex: /\bmkfs\b/,
    summary: "Filesystem formatting command detected",
  },
  {
    id: "dd-if",
    level: "blocking",
    regex: /\bdd\s+if=/,
    summary: "Raw block device copy (dd) detected",
  },
];

const WARNING_PATTERNS: ReadonlyArray<PatternRule> = [
  {
    id: "curl-external",
    level: "warning",
    regex: /\bcurl\b/,
    summary: "curl may fetch content from external hosts",
  },
  {
    id: "wget-external",
    level: "warning",
    regex: /\bwget\b/,
    summary: "wget may fetch content from external hosts",
  },
  {
    id: "netcat",
    level: "warning",
    regex: /\b(?:nc|netcat)\b/,
    summary: "Netcat can open arbitrary network connections",
  },
  {
    id: "path-traversal",
    level: "warning",
    regex: /\.\.\//,
    summary: "Path traversal (../) may escape workspace boundaries",
  },
  {
    id: "chmod-broad",
    level: "warning",
    regex: /\bchmod\s+(?:666|775|755)\b/,
    summary: "chmod with broad permissions",
  },
  {
    id: "kill-9",
    level: "warning",
    regex: /\bkill\s+-9\b/,
    summary: "Forceful process termination (kill -9)",
  },
];

const ADVISORY_PATTERNS: ReadonlyArray<PatternRule> = [
  {
    id: "find-root-no-maxdepth",
    level: "advisory",
    regex: /\bfind\s+\/(?!.*-maxdepth\b)/,
    summary: "find from / without -maxdepth may be extremely slow",
  },
  {
    id: "chmod-any",
    level: "advisory",
    regex: /\bchmod\b/,
    summary: "chmod usage detected — verify permissions are appropriate",
  },
  {
    id: "chown-any",
    level: "advisory",
    regex: /\bchown\b/,
    summary: "chown usage detected — verify ownership change is intended",
  },
  {
    id: "pipe-to-shell",
    level: "advisory",
    regex: /\|\s*(?:ba)?sh\b/,
    summary: "Piping output to shell interpreter",
  },
];

const ALL_PATTERNS: ReadonlyArray<PatternRule> = [
  ...BLOCKING_PATTERNS,
  ...WARNING_PATTERNS,
  ...ADVISORY_PATTERNS,
];

const RM_RECURSIVE_DANGEROUS_TARGET_ID = "rm-recursive-dangerous-target";
const RM_RECURSIVE_DANGEROUS_TARGET_PATTERN = "shell-tokenized-rm-recursive-dangerous-target";
const ROOT_OWNED_PATH_PREFIXES = [
  "/Applications",
  "/System",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/private",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
];

// ─── Scanner ───

/**
 * Scan shell script content for dangerous patterns.
 *
 * Each line is tested against all pattern rules. When a pattern matches,
 * a finding is recorded with the line number. Duplicate pattern IDs on the
 * same line are suppressed (but the same pattern on different lines will
 * produce separate findings).
 *
 * Verdict logic:
 *  - "dangerous"    if any blocking finding is present
 *  - "needs_review" if any warning finding is present (and no blocking)
 *  - "safe"         otherwise
 */
export function scanShellScript(content: string): FridayShellSafetyScanResult {
  const findings: FridayShellSafetyFinding[] = [];
  const lines = normalizeShellLineContinuations(content).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const seenOnThisLine = new Set<string>();

    if (detectRmRecursiveDangerousTarget(trimmed)) {
      seenOnThisLine.add(RM_RECURSIVE_DANGEROUS_TARGET_ID);
      findings.push({
        id: RM_RECURSIVE_DANGEROUS_TARGET_ID,
        level: "blocking",
        pattern: RM_RECURSIVE_DANGEROUS_TARGET_PATTERN,
        line: i + 1,
        summary: "Recursive delete targets root or root-owned system paths",
      });
    }

    for (const rule of ALL_PATTERNS) {
      if (seenOnThisLine.has(rule.id)) {
        continue;
      }
      if (rule.regex.test(trimmed)) {
        seenOnThisLine.add(rule.id);
        findings.push({
          id: rule.id,
          level: rule.level,
          pattern: rule.regex.source,
          line: i + 1, // 1-based
          summary: rule.summary,
        });
      }
    }
  }

  const verdict = deriveVerdict(findings);
  return { verdict, findings };
}

function normalizeShellLineContinuations(content: string): string {
  return content.replace(/\\\r?\n[ \t]*/g, "");
}

function detectRmRecursiveDangerousTarget(line: string): boolean {
  for (const segment of splitShellCommandSegments(line)) {
    const tokens = tokenizeShellLikeLine(segment);
    if (startsWithDynamicCommand(segment) && hasRecursiveDangerousOperands(tokens)) {
      return true;
    }
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "rm") continue;

      let hasRecursive = false;
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j];
        if (!token) continue;
        if (token === "--") continue;
        if (token.startsWith("-")) {
          if (token === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(token)) {
            hasRecursive = true;
          }
          continue;
        }
        if (hasRecursive && isDangerousRmTarget(token)) {
          return true;
        }
      }
    }
  }
  return false;
}

function startsWithDynamicCommand(line: string): boolean {
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;]+\s*)*(?:\$\(|`|\$\{?[A-Za-z_])/.test(line.trimStart());
}

function hasRecursiveDangerousOperands(tokens: readonly string[]): boolean {
  let hasRecursive = false;
  for (const token of tokens) {
    if (!token) continue;
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (token === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(token)) {
        hasRecursive = true;
      }
      continue;
    }
    if (hasRecursive && isDangerousRmTarget(token)) {
      return true;
    }
  }
  return false;
}

function tokenizeShellLikeLine(line: string): string[] {
  const normalized = line
    .replace(/\$\{IFS[^}]*\}|\$IFS\b/g, " ")
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:(?:-|\+|=)([^}]*)\}/g, "$1")
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*-([^}]*)\}/g, "$1")
    .replace(/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "$" && (normalized[i + 1] === "'" || normalized[i + 1] === "\"")) {
      quote = normalized[i + 1] as "'" | "\"";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < normalized.length) {
      current += normalized[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(ch) || ch === ";") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function splitShellCommandSegments(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "$" && (line[i + 1] === "'" || line[i + 1] === "\"")) {
      current += ch;
      current += line[i + 1];
      quote = line[i + 1] as "'" | "\"";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) {
        segments.push(current);
      }
      current = "";
      continue;
    }
    current += ch;
  }

  if (current.trim()) {
    segments.push(current);
  }
  return segments;
}

function isDangerousRmTarget(token: string): boolean {
  const target = token.trim();
  if (target === "/" || target === "/*" || target === "/.*" || target === "/.??*") {
    return true;
  }
  if (/^\/\{[^}]*\b(?:etc|bin|sbin|usr|var|lib|lib64|boot|dev|sys|proc|private|System|Applications)\b/.test(target)) {
    return true;
  }
  if (/^\/\.[*?]/.test(target)) {
    return true;
  }
  return ROOT_OWNED_PATH_PREFIXES.some((prefix) =>
    target === prefix ||
    target.startsWith(`${prefix}/`) ||
    target.startsWith(`${prefix}*`) ||
    target === globClassVariant(prefix),
  );
}

function globClassVariant(path: string): string {
  return path.replace(/\/([^/])/, "/[$1]");
}

// ─── Verdict derivation ───

function deriveVerdict(
  findings: FridayShellSafetyFinding[],
): "safe" | "needs_review" | "dangerous" {
  let hasWarning = false;

  for (const f of findings) {
    if (f.level === "blocking") {
      return "dangerous";
    }
    if (f.level === "warning") {
      hasWarning = true;
    }
  }

  return hasWarning ? "needs_review" : "safe";
}
