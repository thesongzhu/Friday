/**
 * Shared skip-detection module for test quality scripts.
 *
 * Detects all common patterns that skip tests in vitest/jest:
 *   - it.skip / test.skip / describe.skip (with optional whitespace)
 *   - it.skipIf / test.skipIf / describe.skipIf
 *   - it.concurrent.skip
 *   - bracket notation: it["skip"] / test["skip"] / describe["skip"] (single or double quotes)
 *   - bracket notation: it["skipIf"] / test["skipIf"] / describe["skipIf"] (single or double quotes)
 *   - x-prefixed: xit / xdescribe / xtest
 *   - alias detection: const alias = it.skip; alias(...)
 *   - alias detection: bracket assignment, concurrent assignment, destructuring
 *
 * Comments, strings, and template literals are masked before scanning
 * to prevent false positives from text content.
 *
 * @param {string} content  Full file content
 * @returns {{ line: number, label: string, snippet: string }[]}
 */
export function detectSkippedTests(content) {
  const results = [];
  const lines = content.split("\n");

  // Mask comments and strings so we don't match skip patterns inside them.
  // Snippets are still sourced from original lines for readable output.
  const masked = maskCommentsAndStrings(content);

  // Helper: given a character offset, return the 1-based line number.
  function offsetToLine(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text[i] === "\n") line++;
    }
    return line;
  }

  // Helper: check if a position in the masked content is inside a masked-out region
  // (i.e., the character at that position is a space where the original had content).
  // We use this for bracket-notation detection which needs original content.
  function isInsideMaskedRegion(offset) {
    // Check if the character at the match start is part of a masked-out region.
    // A masked region replaces content with spaces, so if the keyword part of the
    // match is all spaces in the masked content, it's inside a comment/string.
    return masked[offset] === " " && content[offset] !== " ";
  }

  // Helper: push a finding.
  function addResult(line, label, snippetLine) {
    const snippet = lines[snippetLine - 1].trim().slice(0, 120);
    results.push({ line, label, snippet });
  }

  // ── Direct patterns (applied to masked content with gm flags) ──
  // These patterns don't involve bracket-notation strings, so masked content works fine.

  const maskedPatterns = [
    // dot-notation skip/skipIf (allow optional whitespace around dots)
    { regex: /\b(it|test|describe)\s*\.\s*concurrent\s*\.\s*skip\s*\(/gm, label: "$1.concurrent.skip" },
    { regex: /\b(it|test|describe)\s*\.\s*skipIf\s*\(/gm, label: "$1.skipIf" },
    { regex: /\b(it|test|describe)\s*\.\s*skip\s*\(/gm, label: "$1.skip" },

    // x-prefixed (xit, xdescribe, xtest) — word-boundary safe
    { regex: /\bxit\s*\(/gm, label: "xit" },
    { regex: /\bxdescribe\s*\(/gm, label: "xdescribe" },
    { regex: /\bxtest\s*\(/gm, label: "xtest" },
  ];

  // Track which (line, label) combos we've already recorded to avoid duplicates
  const seen = new Set();

  for (const { regex, label: labelTpl } of maskedPatterns) {
    let m;
    while ((m = regex.exec(masked)) !== null) {
      const label = labelTpl.replace("$1", m[1] || "");
      const line = offsetToLine(masked, m.index);
      const key = `${line}:${label}`;
      if (!seen.has(key)) {
        const alreadyHasMoreSpecific = results.some(
          (r) => r.line === line && r.label.length > label.length && r.label.includes(label.replace(/\[.*/, ""))
        );
        if (!alreadyHasMoreSpecific) {
          seen.add(key);
          addResult(line, label, line);
        }
      }
    }
  }

  // ── Bracket-notation patterns ──
  // These need to see the actual string content ("skip"/"skipIf") inside brackets,
  // so we scan original content but verify the match isn't inside a comment/template.
  const bracketPatterns = [
    { regex: /\b(it|test|describe)\s*\[\s*["']skip["']\s*\]\s*\(/gm, label: '$1["skip"]' },
    { regex: /\b(it|test|describe)\s*\[\s*["']skipIf["']\s*\]\s*\(/gm, label: '$1["skipIf"]' },
  ];

  for (const { regex, label: labelTpl } of bracketPatterns) {
    let m;
    while ((m = regex.exec(content)) !== null) {
      // Verify the match start (the keyword like "it") isn't in a masked region
      if (isInsideMaskedRegion(m.index)) continue;

      const label = labelTpl.replace("$1", m[1] || "");
      const line = offsetToLine(content, m.index);
      const key = `${line}:${label}`;
      if (!seen.has(key)) {
        seen.add(key);
        addResult(line, label, line);
      }
    }
  }

  // Remove less-specific duplicates on the same line
  // e.g. if line has both "it.concurrent.skip" and "it.skip", keep only concurrent.skip
  const toRemove = new Set();
  for (let i = 0; i < results.length; i++) {
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      if (
        results[i].line === results[j].line &&
        results[j].label.includes(results[i].label) &&
        results[j].label.length > results[i].label.length
      ) {
        toRemove.add(i);
      }
    }
  }

  const filtered = results.filter((_, i) => !toRemove.has(i));
  results.length = 0;
  results.push(...filtered);

  // ── Alias detection ──
  // Collect all alias names into a Set, then scan for calls to those aliases.

  const aliasNames = new Set();

  // Form 1: dot-notation assignment — const mySkip = it.skip
  const aliasDotRegex =
    /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:it|test|describe)\s*\.\s*(?:skip|skipIf)\b/gm;
  let aliasMatch;
  while ((aliasMatch = aliasDotRegex.exec(masked)) !== null) {
    aliasNames.add(aliasMatch[1]);
  }

  // Form 2: bracket-notation assignment — const mySkip = it["skip"] / it['skip']
  // Scan original content but verify not inside masked region
  const aliasBracketRegex =
    /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:it|test|describe)\s*\[\s*["'](?:skip|skipIf)["']\s*\]/gm;
  while ((aliasMatch = aliasBracketRegex.exec(content)) !== null) {
    if (!isInsideMaskedRegion(aliasMatch.index)) {
      aliasNames.add(aliasMatch[1]);
    }
  }

  // Form 3: concurrent assignment — const mySkip = it.concurrent.skip
  const aliasConcurrentRegex =
    /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:it|test|describe)\s*\.\s*concurrent\s*\.\s*(?:skip|skipIf)\b/gm;
  while ((aliasMatch = aliasConcurrentRegex.exec(masked)) !== null) {
    aliasNames.add(aliasMatch[1]);
  }

  // Form 4: destructuring — const { skip } = it / const { skip: mySkip } = it
  const aliasDestructRegex =
    /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:it|test|describe)\b/gm;
  while ((aliasMatch = aliasDestructRegex.exec(masked)) !== null) {
    const inner = aliasMatch[1];
    // Parse each binding: "skip" or "skip: myAlias" or "skipIf: myAlias"
    const bindings = inner.split(",");
    for (const binding of bindings) {
      const trimmed = binding.trim();
      // Match "skip" or "skipIf" with optional rename
      const bindMatch = trimmed.match(/^(skip|skipIf)(?:\s*:\s*([a-zA-Z_$][a-zA-Z0-9_$]*))?$/);
      if (bindMatch) {
        aliasNames.add(bindMatch[2] || bindMatch[1]);
      }
    }
  }

  // Scan for calls to aliased names in the masked content
  for (const alias of aliasNames) {
    const callRegex = new RegExp(`\\b${escapeRegex(alias)}\\s*\\(`, "gm");
    let cm;
    while ((cm = callRegex.exec(masked)) !== null) {
      const line = offsetToLine(masked, cm.index);
      const key = `${line}:alias:${alias}`;
      if (!seen.has(key)) {
        seen.add(key);
        const snippet = lines[line - 1].trim().slice(0, 120);
        results.push({ line, label: `alias(${alias})`, snippet });
      }
    }
  }

  // Sort by line number for consistent output
  results.sort((a, b) => a.line - b.line);

  return results;
}

/**
 * Replace the content of comments, strings, and template literals with spaces,
 * preserving newlines so that line numbers remain aligned. This prevents
 * false-positive matches on skip-like text inside comments or string values.
 *
 * Masks:
 *   - Single-line comments: // ... to end of line
 *   - Multi-line comments: /* ... * /
 *   - Double-quoted strings: "..." (handles escaped quotes \")
 *   - Single-quoted strings: '...' (handles escaped quotes \')
 *   - Template literals: `...` (handles escaped backticks \`)
 *
 * @param {string} content  Raw file content
 * @returns {string}  Content with comments/strings replaced by spaces (newlines kept)
 */
export function maskCommentsAndStrings(content) {
  const len = content.length;
  const result = [];
  let i = 0;

  while (i < len) {
    // Single-line comment: // to end of line
    if (content[i] === "/" && i + 1 < len && content[i + 1] === "/") {
      result.push(" ", " ");
      i += 2;
      while (i < len && content[i] !== "\n") {
        result.push(" ");
        i++;
      }
      continue;
    }

    // Multi-line comment: /* ... */
    if (content[i] === "/" && i + 1 < len && content[i + 1] === "*") {
      result.push(" ", " ");
      i += 2;
      while (i < len) {
        if (content[i] === "*" && i + 1 < len && content[i + 1] === "/") {
          result.push(" ", " ");
          i += 2;
          break;
        }
        result.push(content[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // Double-quoted string: "..."
    if (content[i] === '"') {
      result.push('"');
      i++;
      while (i < len && content[i] !== '"') {
        if (content[i] === "\\" && i + 1 < len) {
          result.push(content[i] === "\n" ? "\n" : " ");
          i++;
          result.push(content[i] === "\n" ? "\n" : " ");
          i++;
          continue;
        }
        result.push(content[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < len) { result.push('"'); i++; }
      continue;
    }

    // Single-quoted string: '...'
    if (content[i] === "'") {
      result.push("'");
      i++;
      while (i < len && content[i] !== "'") {
        if (content[i] === "\\" && i + 1 < len) {
          result.push(content[i] === "\n" ? "\n" : " ");
          i++;
          result.push(content[i] === "\n" ? "\n" : " ");
          i++;
          continue;
        }
        result.push(content[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < len) { result.push("'"); i++; }
      continue;
    }

    // Template literal: `...`
    if (content[i] === "`") {
      result.push("`");
      i++;
      while (i < len && content[i] !== "`") {
        if (content[i] === "\\" && i + 1 < len) {
          result.push(content[i] === "\n" ? "\n" : " ");
          i++;
          result.push(content[i] === "\n" ? "\n" : " ");
          i++;
          continue;
        }
        result.push(content[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < len) { result.push("`"); i++; }
      continue;
    }

    // Normal character — pass through
    result.push(content[i]);
    i++;
  }

  return result.join("");
}

/** Escape special regex characters in a string. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
