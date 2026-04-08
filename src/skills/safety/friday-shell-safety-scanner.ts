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
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const seenOnThisLine = new Set<string>();

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
