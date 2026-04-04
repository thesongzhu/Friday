import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const BUG_PATTERNS = [
  { id: "equality-coercion", severity: "medium", label: "Loose equality (== instead of ===)", pattern: /[^=!<>]==[^=]/g },
  { id: "console-log", severity: "low", label: "Console.log left in code", pattern: /\bconsole\.(log|debug|info)\s*\(/g },
  { id: "todo-fixme", severity: "low", label: "TODO/FIXME comment", pattern: /\b(TODO|FIXME|HACK|XXX)\b/g },
  { id: "eval-usage", severity: "high", label: "Use of eval()", pattern: /\beval\s*\(/g },
  { id: "innerhtml", severity: "high", label: "innerHTML assignment (XSS risk)", pattern: /\.innerHTML\s*=/g },
  { id: "var-keyword", severity: "low", label: "Use of var (prefer let/const)", pattern: /\bvar\s+/g },
  { id: "empty-catch", severity: "medium", label: "Empty catch block", pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g },
  { id: "hardcoded-secret", severity: "high", label: "Possible hardcoded secret", pattern: /(?:password|secret|api_?key|token)\s*[:=]\s*["'][^"']{4,}/gi },
  { id: "magic-number", severity: "low", label: "Magic number (unnamed constant)", pattern: /(?<![.\w])(?:(?:return|[=<>!+\-*/])\s+)\d{2,}(?![.\d\w])/g },
  { id: "nested-ternary", severity: "medium", label: "Nested ternary operator", pattern: /\?[^:]*\?/g },
  { id: "no-error-handling", severity: "medium", label: "Promise without catch", pattern: /\.then\s*\([^)]*\)(?!\s*\.catch)/g },
  { id: "sql-concat", severity: "high", label: "SQL string concatenation (injection risk)", pattern: /(?:SELECT|INSERT|UPDATE|DELETE).*\+\s*(?:req\.|input\.|params\.)/gi },
];

const SMELL_PATTERNS = [
  { id: "long-function", label: "Potentially long function", check: (code) => {
    const fns = code.split(/\bfunction\b|\b=>\s*\{/);
    return fns.some((f) => f.split("\n").length > 50);
  }},
  { id: "deep-nesting", label: "Deep nesting detected", check: (code) => {
    const lines = code.split("\n");
    return lines.some((line) => {
      const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
      return indent >= 16;
    });
  }},
  { id: "duplicate-strings", label: "Repeated string literals", check: (code) => {
    const strings = code.match(/["'][^"']{4,}["']/g) || [];
    const freq = {};
    for (const s of strings) freq[s] = (freq[s] || 0) + 1;
    return Object.values(freq).some((c) => c >= 3);
  }},
  { id: "god-object", label: "Large object/class (potential god object)", check: (code) => {
    const classBlocks = code.match(/class\s+\w+[\s\S]*?\n\}/g) || [];
    return classBlocks.some((b) => b.split("\n").length > 100);
  }},
];

const LANGUAGE_HINTS = [
  { lang: "JavaScript/TypeScript", patterns: [/\bconst\b/, /\blet\b/, /\bfunction\b/, /=>/,  /\brequire\b/, /\bimport\b.*\bfrom\b/] },
  { lang: "Python", patterns: [/\bdef\b/, /\bimport\b(?!.*from)/, /\bclass\b.*:/, /\bself\b/, /\bprint\s*\(/] },
  { lang: "Java", patterns: [/\bpublic\s+class\b/, /\bSystem\.out/, /\bvoid\b/, /\bString\[\]/, /\bimport\s+java\./] },
  { lang: "Go", patterns: [/\bfunc\b/, /\bpackage\b/, /\bfmt\./, /\b:=\b/, /\bgo\s+func/] },
  { lang: "Rust", patterns: [/\bfn\b/, /\blet\s+mut\b/, /\bimpl\b/, /\b->\b/, /\bpub\s+fn\b/] },
];

function detectLanguage(code) {
  let best = { lang: "Unknown", score: 0 };
  for (const hint of LANGUAGE_HINTS) {
    const score = hint.patterns.filter((p) => p.test(code)).length;
    if (score > best.score) best = { lang: hint.lang, score };
  }
  return best.lang;
}

function findBugs(code) {
  const issues = [];
  for (const bp of BUG_PATTERNS) {
    const regex = new RegExp(bp.pattern.source, bp.pattern.flags);
    const matches = code.match(regex);
    if (matches && matches.length > 0) {
      const lineNumbers = [];
      const lines = code.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(bp.pattern.source, bp.pattern.flags).test(lines[i])) {
          lineNumbers.push(i + 1);
        }
      }
      issues.push({
        id: bp.id,
        severity: bp.severity,
        label: bp.label,
        occurrences: matches.length,
        lines: lineNumbers.slice(0, 5),
        sample: compact(matches[0], 80),
      });
    }
  }
  return issues;
}

function findSmells(code) {
  const smells = [];
  for (const sp of SMELL_PATTERNS) {
    if (sp.check(code)) {
      smells.push({ id: sp.id, label: sp.label });
    }
  }
  return smells;
}

function computeMetrics(code) {
  const lines = code.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  const comments = lines.filter((l) => /^\s*(\/\/|#|\/\*|\*|""")/.test(l)).length;
  const functions = (code.match(/\b(function|def|fn|func)\b/g) || []).length;
  return { totalLines: lines.length, nonEmptyLines: nonEmpty, commentLines: comments, functionCount: functions };
}

export async function execute(input = {}) {
  const code = asString(input.code ?? input.content ?? input.text);
  if (!code) {
    throw new Error("code-review-skill requires a code input.");
  }

  const language = detectLanguage(code);
  const bugs = findBugs(code);
  const smells = findSmells(code);
  const metrics = computeMetrics(code);

  const highSeverity = bugs.filter((b) => b.severity === "high").length;
  const medSeverity = bugs.filter((b) => b.severity === "medium").length;
  const lowSeverity = bugs.filter((b) => b.severity === "low").length;

  const suggestions = [];
  if (highSeverity > 0) suggestions.push("Fix all high-severity issues immediately (security/correctness risks).");
  if (medSeverity > 0) suggestions.push("Address medium-severity issues to improve robustness.");
  if (smells.length > 0) suggestions.push(`Refactor to resolve ${smells.length} code smell(s).`);
  if (metrics.commentLines === 0 && metrics.nonEmptyLines > 10) suggestions.push("Add comments to improve maintainability.");
  if (suggestions.length === 0) suggestions.push("Code looks clean. Consider adding tests if not already present.");

  return {
    summary: `Code review (${language}): ${bugs.length} issue(s) found (${highSeverity} high, ${medSeverity} medium, ${lowSeverity} low) and ${smells.length} smell(s).`,
    nextStep: suggestions[0],
    details: {
      language,
      metrics,
      issues: bugs,
      smells,
      suggestions,
      severityCounts: { high: highSeverity, medium: medSeverity, low: lowSeverity },
    },
  };
}
