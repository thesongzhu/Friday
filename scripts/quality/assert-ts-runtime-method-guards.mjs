#!/usr/bin/env node
/**
 * TS-Runtime-Retirement: method-guard STRUCTURAL-PRESENCE + manifest anti-shrinkage gate.
 *
 * Second-phase companion to scripts/quality/check-ts-runtime-retirement.mjs.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HONEST SCOPE — read this before trusting a green run.
 *
 * This is a TEXTUAL gate. It verifies the STRUCTURAL PRESENCE of method-head
 * fail-closed guards (after stripping comments + string/template literals so a
 * commented-out or JSDoc'd guard cannot false-pass). It does NOT, and a textual
 * gate CANNOT, verify fail-closed BEHAVIOR — a neutered or inverted guard whose
 * tokens survive (e.g. `if (flag === true) throw`) would still read as "present".
 * Behavior is covered by the per-surface BEHAVIORAL TESTS that this gate requires
 * to EXIST (manifest `behavioralTest`); those run in the CI `test` job and are the
 * real proof that the guard fails closed.
 *
 * WHAT THIS GATE GUARANTEES:
 *   - STRUCTURAL guard presence: every declared mutating method on a registered
 *     service file shows its guard token within its OWN brace-matched body (post
 *     comment/string strip) — not borrowed from a sibling method.
 *   - REGISTRATION of mutators: any PUBLIC verb-prefixed (mutating-named) method
 *     on a registered service file that is NOT in that surface's declared method
 *     list (and not in its justified `allowlistMutators`) FAILS — forcing a new
 *     mutator to be consciously registered or consciously allowlisted.
 *   - PER-SURFACE anti-shrinkage: each registered surface keeps >= its declared
 *     method-count floor, and the set of registered surface IDs cannot shrink —
 *     so "drop a surface + add filler to hold the grand total" is caught.
 *   - A behavioral-test FILE exists for every registered surface (existence only).
 *
 * WHAT THIS GATE DOES *NOT* GUARANTEE (documented limits, by design):
 *   1. Fail-closed BEHAVIOR (see above) — structural presence only; behavior is on
 *      the mandatory behavioral tests in the `test` job.
 *   2. A brand-new off-route surface in a NEW service file — a textual gate has no
 *      seed to discover it. Covered by the route validator (for its route) + the
 *      mandatory behavioral test when the surface is registered. New off-route
 *      surfaces MUST be added here as they are method-fenced.
 *   3. A mutator whose name does NOT match the configurable verb-prefix list
 *      (e.g. `upsertApprovalRule`, `doStartRun`) can evade the registration scan.
 *      The verb list (`mutatorVerbs`) is the heuristic boundary; widen it as new
 *      naming shows up. Reads (`getRun`, `getSession`) are excluded because the
 *      match is VERB-PREFIX (first camelCase segment), not substring.
 *   4. `allowlistMutators` is a conscious escape hatch: a bogus justification on an
 *      allowlist entry would hide a real mutator. The protection is that the entry
 *      is VISIBLE in the manifest diff and reviewed (same model as lowering a floor).
 *   5. The registration scan detects public methods via (a) exported `...Service`
 *      interface members and (b) object-method-shorthand-with-body in the factory
 *      return. A new mutator added to an INTERFACE-based service as a `const`-arrow
 *      that is shorthand-returned but NOT added to the interface would evade (a) and
 *      (b). That shape is rejected by `tsc` in the `build` job (the factory's typed
 *      return performs excess-property checking against the `...Service` interface),
 *      so the build job is the backstop for interface-based services.
 *   6. Regex literals ARE handled by the comment/string stripper (recognized in
 *      regex position and their bodies blanked), so a quote/brace inside a regex
 *      class cannot corrupt scanning. Division `/` stays code (conservative). No
 *      currently-registered service file contains a regex literal that would matter;
 *      if a future one is mis-disambiguated it surfaces as a false-RED (safe), fixed
 *      by extending the tokenizer — never as a silent false-GREEN.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS (the route-blind gap):
 *   The route validator discovers HTTP routes (discoverRoutes over
 *   src/api/http/routes/**) and classifies each one. Its blocker==0 guarantee is
 *   therefore ROUTE-scoped. It is structurally blind to service-method guards:
 *   when a surface is route-retired but its mutating service methods are still
 *   reachable OFF-route (agent tools, UIX/reflex callers, background jobs,
 *   standing-agenda), the route validator sees nothing. PR #628's original commit
 *   ad45080e was exactly this near miss: it added guards to only a SUBSET of each
 *   surface's mutating methods (submitTurn, cancelSession,
 *   materializeGeneratedSession were left route-retired-but-unguarded), and
 *   nothing gated on it.
 *
 * Node: builtins only — no dependencies, no `npm ci` required (the CI job that
 * runs this has no install step).
 *
 * Usage: node scripts/quality/assert-ts-runtime-method-guards.mjs [--repo-root <dir>] [--manifest <path>] [--json]
 *   Exits 0 on full STRUCTURAL coverage + registration + no shrinkage, non-zero otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = "docs/ops/ts-runtime-retirement-manifest.json";

// Fallback mutating-verb list if the manifest does not configure `mutatorVerbs`.
// A method name "mutates" if its first camelCase segment (lower-cased) is one of
// these — VERB-PREFIX, not substring (so `getRun` => "get" is NOT a mutator).
const DEFAULT_MUTATOR_VERBS = [
  "run", "execute", "start", "resume", "retry", "cancel", "create", "update",
  "delete", "approve", "deny", "generate", "submit", "materialize", "sweep",
  "extract", "remember", "dispatch", "publish", "deploy", "apply", "rollback",
];

export function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), manifestPath: DEFAULT_MANIFEST, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--manifest") {
      args.manifestPath = argv[index + 1];
      index += 1;
    } else if (entry === "--repo-root") {
      args.repoRoot = argv[index + 1];
      index += 1;
    } else if (entry === "--json") {
      args.json = true;
    } else if (!entry.startsWith("--")) {
      args.repoRoot = entry;
    }
  }
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Strip line comments, block comments, and string/template literals from TS/JS
 * source, REPLACING their content with spaces while PRESERVING newlines (so line
 * numbers and brace structure outside literals are unchanged). A single
 * left-to-right state machine — NOT sequential regex passes — so `//` inside a
 * "https://..." string, or a `{` inside a string/comment, cannot corrupt the
 * result. Regex literals ARE recognized (in regex position, via the previous
 * significant token) and their bodies blanked, so a quote or brace inside a
 * regex class (e.g. /["{]/) cannot flip the scanner into string mode or delete
 * braces. Ambiguous `/` (division) falls through as code. Code structure
 * (braces, identifiers) outside literals is kept.
 *
 * States: code | line-comment | block-comment | s-string('") | t-string(`) | regex.
 * Template `${...}` expressions are kept as code (so a guard ref inside one is
 * still visible) by tracking brace depth within the template.
 */
export function stripCommentsAndStrings(source) {
  const out = [];
  const n = source.length;
  let i = 0;
  // template stack: each entry tracks `${` brace depth so we know when the
  // expression closes and we re-enter the template string body.
  const templateBraceDepth = [];
  let inTemplateExpr = false;
  // Last significant (non-whitespace, non-comment) source char emitted as code —
  // used to decide whether a `/` begins a regex literal or is a division op.
  let lastSignificant = "";

  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    // Line comment: blank to end of line, keep the newline.
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out.push(source[i] === "\t" ? "\t" : " ");
        i += 1;
      }
      continue;
    }
    // Block comment: blank everything (preserve newlines) until */.
    if (c === "/" && next === "*") {
      out.push(" ");
      out.push(" ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : (source[i] === "\t" ? "\t" : " "));
        i += 1;
      }
      if (i < n) {
        out.push(" ");
        out.push(" ");
        i += 2;
      }
      continue;
    }
    // Regex literal: a `/` is a regex start (not division) when it appears in
    // "regex position" — i.e. the previous significant code char is one that
    // cannot end an expression: `(`, `,`, `=`, `:`, `;`, `[`, `{`, `}`, `!`, `&`,
    // `|`, `?`, `+`, `-`, `*`, `%`, `<`, `>`, `^`, `~`, or nothing (start of
    // input). Otherwise `/` is division and falls through as code. We blank the
    // regex body (preserving the delimiters + length) so an embedded quote/brace
    // cannot flip us into string mode or corrupt brace-matching. Conservative:
    // ambiguous cases stay code (a stray division never blanks a guard).
    if (c === "/" && (lastSignificant === "" || "(,=:;[{}!&|?+-*%<>^~".includes(lastSignificant))) {
      out.push("/");
      i += 1;
      let inClass = false;
      while (i < n) {
        const rc = source[i];
        if (rc === "\\") { out.push(" "); out.push(" "); i += 2; continue; }
        if (rc === "\n") { break; } // unterminated regex on this line — bail safely
        if (rc === "[") { inClass = true; out.push(" "); i += 1; continue; }
        if (rc === "]") { inClass = false; out.push(" "); i += 1; continue; }
        if (rc === "/" && !inClass) { break; }
        out.push(" ");
        i += 1;
      }
      if (i < n && source[i] === "/") {
        out.push("/");
        i += 1;
        // consume + emit flags (letters) as-is so they remain code.
        while (i < n && /[a-z]/i.test(source[i])) { out.push(source[i]); i += 1; }
      }
      lastSignificant = "/";
      continue;
    }
    // Single/double-quoted string: blank contents, keep quotes + newlines.
    if (c === "'" || c === '"') {
      const quote = c;
      out.push(quote);
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out.push(" ");
          out.push(" ");
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < n) {
        out.push(quote);
        i += 1;
      }
      // A `/` after a string value is division, not a regex start.
      lastSignificant = quote;
      continue;
    }
    // Template literal: blank the literal text, but KEEP ${...} expression code.
    if (c === "`") {
      out.push("`");
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out.push(" ");
          out.push(" ");
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          // Enter expression: emit `${`, then recurse via the main loop by
          // pushing a brace-depth tracker and breaking out to code mode.
          out.push("$");
          out.push("{");
          i += 2;
          templateBraceDepth.push(1);
          inTemplateExpr = true;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (!inTemplateExpr && i < n && source[i] === "`") {
        out.push("`");
        i += 1;
      }
      continue;
    }

    // Inside a template expression: keep code, track braces so we know when the
    // expression closes and we should resume blanking the template body.
    if (inTemplateExpr) {
      if (c === "{") {
        templateBraceDepth[templateBraceDepth.length - 1] += 1;
      } else if (c === "}") {
        templateBraceDepth[templateBraceDepth.length - 1] -= 1;
        if (templateBraceDepth[templateBraceDepth.length - 1] === 0) {
          templateBraceDepth.pop();
          inTemplateExpr = templateBraceDepth.length > 0;
          out.push("}");
          i += 1;
          // Resume template body blanking until the next ` or ${.
          while (i < n) {
            if (source[i] === "\\") { out.push(" "); out.push(" "); i += 2; continue; }
            if (source[i] === "`") { out.push("`"); i += 1; break; }
            if (source[i] === "$" && source[i + 1] === "{") {
              out.push("$"); out.push("{"); i += 2;
              templateBraceDepth.push(1);
              inTemplateExpr = true;
              break;
            }
            out.push(source[i] === "\n" ? "\n" : " ");
            i += 1;
          }
          continue;
        }
      }
      if (c.trim() !== "") lastSignificant = c;
      out.push(c);
      i += 1;
      continue;
    }

    if (c.trim() !== "") lastSignificant = c;
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/**
 * Locate every definition-head line for `methodName` in `lines` (already
 * comment/string-stripped). A definition head is the method name immediately
 * followed by `(`, in one of the forms used across the guarded services:
 *   - `async function startRun(` / `function cancelRun(` / `function updatePolicy(`
 *   - object-method shorthand: `async submitTurn(` / `async deployDraft(input) {`
 *   - assigned arrow: `const executeIntent = async (`
 * We exclude bare call sites (a `methodName(` not preceded by async/function and
 * not at a method-definition column). Interface signature lines are tolerated as
 * candidate heads: they simply won't contain the guard token in their body
 * window, and the impl head (which does) satisfies the per-method requirement.
 */
function findDefinitionHeadLines(lines, methodName) {
  const heads = [];
  const nameCall = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(methodName)}\\s*\\(`);
  const assignedArrow = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(methodName)}\\s*=\\s*async\\b`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (assignedArrow.test(line)) {
      heads.push(index);
      continue;
    }
    if (!nameCall.test(line)) {
      continue;
    }
    const isFunctionForm = /\b(?:async\s+)?function\s+/.test(line)
      || /^\s*(?:public|private|protected\s+)?(?:async\s+)?[A-Za-z0-9_$]+\s*\(/.test(line);
    if (!isFunctionForm) {
      continue;
    }
    heads.push(index);
  }
  return heads;
}

/**
 * Find the brace-matched body extent for a method head, on comment/string-stripped
 * lines. Scans forward from headLine to the first `{` that opens the body, then
 * brace-matches to its close. Returns [startLine, endLineExclusive].
 *
 * Robustness: this replaces the old fixed 24-line window. A correctly-placed guard
 * any distance down the body is now in-scope (fixes the head-anchored false-RED),
 * AND the body ends at the method's OWN closing brace, so a sibling method's guard
 * cannot leak into this method's scope (fixes the sibling-borrow false-pass).
 *
 * Interface signature heads (no body — `name(...): T;`) have no `{` before the
 * line's terminating `;`/EOL and yield an empty single-line body; that's fine, the
 * impl head provides the real body. `maxScan` bounds a pathological no-brace case.
 */
function methodBodyRange(lines, headLine, maxScan) {
  const total = lines.length;
  const hardEnd = Math.min(headLine + maxScan, total);
  let openLine = -1;
  let openCol = -1;
  // Find the `{` that opens the body. The head may span multiple lines (long
  // param list); the body `{` is the first unmatched `{` after the param `(`.
  let parenDepth = 0;
  let seenParen = false;
  for (let li = headLine; li < hardEnd; li += 1) {
    const text = lines[li];
    for (let ci = 0; ci < text.length; ci += 1) {
      const ch = text[ci];
      if (ch === "(") { parenDepth += 1; seenParen = true; }
      else if (ch === ")") { parenDepth -= 1; }
      else if (ch === ";" && seenParen && parenDepth <= 0) {
        // Signature line (`name(...): T;`) — no body.
        return [headLine, headLine + 1];
      }
      else if (ch === "{" && seenParen && parenDepth <= 0) {
        openLine = li;
        openCol = ci;
        break;
      }
      else if (ch === "=" && li === headLine) {
        // assigned-arrow form `const x = async (...) => {` — keep scanning for `{`.
      }
    }
    if (openLine >= 0) break;
  }
  if (openLine < 0) {
    // No body brace located within maxScan — fall back to a bounded window so we
    // never silently skip; the per-method check will just look in this slice.
    return [headLine, hardEnd];
  }
  // Brace-match from openLine/openCol to the matching close.
  let depth = 0;
  for (let li = openLine; li < total; li += 1) {
    const text = lines[li];
    const startCol = li === openLine ? openCol : 0;
    for (let ci = startCol; ci < text.length; ci += 1) {
      const ch = text[ci];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return [headLine, li + 1];
        }
      }
    }
  }
  return [headLine, total];
}

/**
 * Extract the set of PUBLIC method names declared on a service file. Public =
 * declared in an exported `... Service` interface signature block (covers the
 * services whose factory returns shorthand property refs), OR an object-method
 * shorthand WITH A BODY (covers services whose factory returns inline methods,
 * e.g. workflow_generator's `async startSession(...) { ... }`). Internal
 * factory-scope `function`/`const`-arrow helpers (executeIntentInternal,
 * runDesktopAction, deleteDraft, runDeploy, createDraftFromVisualization,
 * extractRunFailurePath) are NOT in either form and are correctly excluded.
 *
 * Operates on comment/string-stripped lines.
 */
function collectPublicMethodNames(lines) {
  const names = new Set();
  const total = lines.length;

  // (a) exported `...Service` interface signature members.
  for (let li = 0; li < total; li += 1) {
    const m = lines[li].match(/^export\s+interface\s+([A-Za-z0-9_$]+Service)\s*\{/);
    if (!m) continue;
    // Walk the interface body via brace-match; collect `NAME(` and `NAME:` members.
    let depth = 0;
    let started = false;
    for (let bi = li; bi < total; bi += 1) {
      const text = lines[bi];
      for (let ci = 0; ci < text.length; ci += 1) {
        if (text[ci] === "{") { depth += 1; started = true; }
        else if (text[ci] === "}") { depth -= 1; }
      }
      if (started && bi > li) {
        const sig = text.match(/^\s*([A-Za-z0-9_$]+)\s*[(<:]/);
        if (sig) names.add(sig[1]);
      }
      if (started && depth === 0) break;
    }
  }

  // (b) object-method shorthand WITH a body: `async NAME(...) {` or `NAME(...) {`
  //     or a multiline head whose line is `async NAME(` / `NAME(` at a returned-
  //     object indentation. Distinguish from CALL sites: a call site is `NAME(`
  //     used as an expression (e.g. `foo: createX({` or `await runDeploy()`);
  //     a definition has either `async` immediately before the name, or the line
  //     is purely a method head (indentation + name + `(` and nothing that makes
  //     it an argument/assignment). We require the name to be the first token on
  //     the (trimmed) line OR preceded only by `async`.
  for (let li = 0; li < total; li += 1) {
    const text = lines[li];
    // `async NAME(` definition (object-method, async)
    let m = text.match(/^\s*async\s+([A-Za-z0-9_$]+)\s*\(/);
    if (m) { names.add(m[1]); continue; }
    // plain `NAME(...)` as the FIRST token on the line, NOT a control keyword,
    // NOT followed by `=>` (that'd be inside a call), and the body opens with `{`
    // somewhere — i.e. an object-method shorthand. We additionally require the
    // line not to look like a call argument by excluding a leading `.`/`,`/`(`/`=`
    // context: since it's the first non-space token, that's already satisfied.
    m = text.match(/^\s*([A-Za-z0-9_$]+)\s*\(/);
    if (m) {
      const name = m[1];
      if (["if", "for", "while", "switch", "catch", "return", "await", "function",
        "const", "let", "var", "export", "import", "throw", "new", "typeof",
        "void", "yield", "do", "else"].includes(name)) {
        continue;
      }
      // Must end the head with `{` on this line or be a multiline head; and must
      // NOT be an assignment/property-value call. Heuristic: the line, after the
      // closing `)` (if present), ends with `{` or `:` (return-type then body) or
      // is just `NAME(` (multiline). A trailing `;` or `,` or `)` indicates a call.
      const tail = text.slice(text.indexOf("(") );
      if (/\)\s*(?::[^=]*)?\s*\{?\s*$/.test(tail) && !/=>/.test(text)) {
        names.add(name);
      }
    }
  }
  return names;
}

/** First camelCase segment, lower-cased (e.g. startRun => "start", getRun => "get"). */
function leadingVerb(name) {
  const stripped = name.replace(/^[_$]+/, "");
  const seg = stripped.match(/^[a-z]+/);
  return seg ? seg[0].toLowerCase() : null;
}

export function evaluateSurface(repoRoot, surface, mutatorVerbs) {
  const failures = [];
  const details = { id: surface.id, serviceFile: surface.serviceFile, methods: {} };
  const absolute = path.join(repoRoot, surface.serviceFile);
  if (!fs.existsSync(absolute)) {
    failures.push(`surface ${surface.id}: serviceFile ${surface.serviceFile} not found`);
    return { failures, details };
  }
  const rawSource = fs.readFileSync(absolute, "utf8");
  const source = stripCommentsAndStrings(rawSource);
  const lines = source.split("\n");

  const flag = surface.flag;
  if (typeof flag !== "string" || flag.length === 0) {
    failures.push(`surface ${surface.id}: config missing 'flag'`);
    return { failures, details };
  }

  // Backstop 1: the actual fail-closed throw must exist at least once (post strip),
  // so gutting a shared guard helper's body (while keeping callers) is still caught.
  const throwRegex = new RegExp(`${escapeRegExp(flag)}\\s*!==\\s*true`);
  details.hasFlagThrow = throwRegex.test(source);
  if (!details.hasFlagThrow) {
    failures.push(
      `surface ${surface.id}: no \`${flag} !== true\` fail-closed throw in ${surface.serviceFile} `
      + "(the method-head guard body is missing or was gutted)",
    );
  }

  // The token each guarded method body must contain: the guardHelper call if the
  // surface uses a named helper, else a direct reference to the flag.
  const guardHelper = surface.guardHelper;
  const guardTokenRegex = guardHelper
    ? new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(guardHelper)}\\s*\\(`)
    : new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(flag)}(?![A-Za-z0-9_$])`);

  // ── PHASE A.1: every declared mutating method shows its guard in its OWN body ──
  for (const methodName of surface.mutatingMethods ?? []) {
    const heads = findDefinitionHeadLines(lines, methodName);
    if (heads.length === 0) {
      failures.push(
        `surface ${surface.id}: declared mutating method '${methodName}' has no locatable `
        + `definition head in ${surface.serviceFile} (stale config or matcher needs updating — `
        + "investigate, do NOT remove the method from config to make this pass)",
      );
      details.methods[methodName] = { located: false, guarded: false };
      continue;
    }
    let guarded = false;
    let guardedAtLine = null;
    for (const head of heads) {
      const [bodyStart, bodyEnd] = methodBodyRange(lines, head, 600);
      const bodyText = lines.slice(bodyStart, bodyEnd).join("\n");
      if (guardTokenRegex.test(bodyText)) {
        guarded = true;
        guardedAtLine = head + 1;
        break;
      }
    }
    details.methods[methodName] = { located: true, guarded, guardedAtLine, headLines: heads.map((h) => h + 1) };
    if (!guarded) {
      const tokenLabel = guardHelper ? `${guardHelper}()` : flag;
      failures.push(
        `surface ${surface.id}: mutating method '${methodName}' is route-retired but its `
        + `method-head guard (${tokenLabel}) is MISSING from its own body — a regression `
        + `un-retired this surface off-route while the route validator stays blocker=0 (${surface.serviceFile})`,
      );
    }
  }

  // ── PHASE A.2: detect UNREGISTERED public mutators on this file ──
  // Any PUBLIC verb-prefixed (mutating-named) method that is neither declared in
  // mutatingMethods nor in allowlistMutators FAILS — forcing conscious registration
  // (real new retired mutator) or conscious, justified allowlisting (intentionally
  // live / route-only-covered / different-mechanism guard).
  const declared = new Set(surface.mutatingMethods ?? []);
  const allowlist = new Set((surface.allowlistMutators ?? []).map((a) => a.method));
  const publicNames = collectPublicMethodNames(lines);
  const unregistered = [];
  for (const name of publicNames) {
    const verb = leadingVerb(name);
    if (verb && mutatorVerbs.has(verb) && !declared.has(name) && !allowlist.has(name)) {
      unregistered.push(name);
    }
  }
  unregistered.sort();
  details.unregisteredMutators = unregistered;
  details.allowlistedMutators = [...allowlist].sort();
  for (const name of unregistered) {
    failures.push(
      `surface ${surface.id}: public mutating-named method '${name}' on ${surface.serviceFile} is `
      + "NEITHER a declared mutatingMethod NOR in allowlistMutators. A new off-route mutator may have "
      + "been added unguarded. Register it in mutatingMethods (with its guard) OR, if it is intentionally "
      + "live / route-only-covered / guarded by a different mechanism, add it to allowlistMutators with a "
      + "reason so the de-coverage is consciously reviewed — do NOT rename it to dodge the verb-prefix scan.",
    );
  }

  // Backstop 2: for helper-services, guard-call-site count must cover the declared
  // mutators (catches dropping a guard from one of several methods even if some
  // other path keeps the helper referenced). Counted on the stripped source so a
  // commented-out call no longer inflates the count.
  if (guardHelper) {
    const callSiteRegex = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(guardHelper)}\\s*\\(`, "gu");
    const callSites = (source.match(callSiteRegex) ?? []).length;
    const declRegex = new RegExp(`function\\s+${escapeRegExp(guardHelper)}\\s*\\(`);
    const declCount = declRegex.test(source) ? 1 : 0;
    const effectiveCalls = callSites - declCount;
    const required = (surface.mutatingMethods ?? []).length;
    details.guardHelperCallSites = effectiveCalls;
    details.guardHelperRequired = required;
    if (effectiveCalls < required) {
      failures.push(
        `surface ${surface.id}: ${effectiveCalls} ${guardHelper}() call-site(s) but ${required} `
        + "declared mutating method(s) — a guard call was dropped from at least one method",
      );
    }
  }

  // ── PHASE A.3: behavioral-test FILE existence (structural; existence only) ──
  if (typeof surface.behavioralTest === "string" && surface.behavioralTest.length > 0) {
    const testAbs = path.join(repoRoot, surface.behavioralTest);
    const exists = fs.existsSync(testAbs);
    details.behavioralTest = surface.behavioralTest;
    details.behavioralTestExists = exists;
    if (!exists) {
      failures.push(
        `surface ${surface.id}: declared behavioralTest ${surface.behavioralTest} does NOT exist. `
        + "Behavior (fail-closed) is NOT verifiable textually; the behavioral test in the `test` job is "
        + "the proof. Restore the test file (do not drop the pointer to make this pass).",
      );
    }
  } else {
    details.behavioralTest = null;
    details.behavioralTestExists = false;
    failures.push(
      `surface ${surface.id}: no behavioralTest declared. Every method-retired surface MUST point to a `
      + "behavioral test that proves the guard FAILS CLOSED (this gate only checks structural presence).",
    );
  }

  return { failures, details };
}

export function evaluateManifest(repoRoot, manifest) {
  const failures = [];
  const config = manifest.methodRetiredSurfaces;
  if (!config || typeof config !== "object") {
    failures.push("manifest is missing methodRetiredSurfaces config (method-guard coverage cannot run)");
    return { failures, report: { phaseA: {}, phaseB: {} } };
  }

  const mutatorVerbs = new Set(
    (Array.isArray(config.mutatorVerbs) && config.mutatorVerbs.length > 0
      ? config.mutatorVerbs
      : DEFAULT_MUTATOR_VERBS).map((v) => String(v).toLowerCase()),
  );

  // ── PHASE A: per-surface structural guard presence + registration ──
  const surfaceReports = [];
  let totalDeclaredMethods = 0;
  let surfacesWithBehavioralTest = 0;
  const registeredIds = new Set();
  for (const surface of config.surfaces ?? []) {
    registeredIds.add(surface.id);
    totalDeclaredMethods += (surface.mutatingMethods ?? []).length;
    const { failures: surfaceFailures, details } = evaluateSurface(repoRoot, surface, mutatorVerbs);
    failures.push(...surfaceFailures);
    surfaceReports.push(details);
    if (details.behavioralTestExists) surfacesWithBehavioralTest += 1;
  }

  // ── PHASE B: manifest anti-shrinkage floors ──
  const floor = config.countFloor ?? {};
  const surfacesLength = Array.isArray(manifest.surfaces) ? manifest.surfaces.length : 0;
  const routeFamiliesLength = Array.isArray(manifest.routeFamilies) ? manifest.routeFamilies.length : 0;

  const byClassification = {};
  for (const surface of manifest.surfaces ?? []) {
    const c = surface.classification ?? "<unclassified>";
    byClassification[c] = (byClassification[c] ?? 0) + 1;
  }

  assertFloor(failures, "surfaces.length", surfacesLength, floor.surfacesMin);
  assertFloor(failures, "routeFamilies.length", routeFamiliesLength, floor.routeFamiliesMin);
  assertFloor(failures, "declared guarded methods", totalDeclaredMethods, floor.guardedMethodsMin);

  // PER-SURFACE floor (#5): each registered surface ID must still be present AND
  // keep >= its declared method count. A flat grand total lets "drop a surface +
  // add filler" hold the total; this keyed floor forbids that.
  const perSurface = floor.perSurfaceMethodsMin ?? {};
  const declaredById = {};
  for (const surface of config.surfaces ?? []) {
    declaredById[surface.id] = (surface.mutatingMethods ?? []).length;
  }
  for (const [id, minMethods] of Object.entries(perSurface)) {
    if (!registeredIds.has(id)) {
      failures.push(
        `anti-shrinkage: registered surface '${id}' (floored at ${minMethods} method(s)) was REMOVED from `
        + "methodRetiredSurfaces.surfaces. If intentional, delete its perSurfaceMethodsMin entry IN THIS PR "
        + "so the de-retirement is consciously reviewed — do not drop the surface and backfill the total with filler.",
      );
      continue;
    }
    if ((declaredById[id] ?? 0) < minMethods) {
      failures.push(
        `anti-shrinkage: surface '${id}' declares ${declaredById[id] ?? 0} mutating method(s), below its `
        + `per-surface floor ${minMethods}. A guarded method was removed from this surface. Lower its `
        + "perSurfaceMethodsMin IN THIS PR if intentional.",
      );
    }
  }

  // Anti-shrinkage on behavioral-test coverage: the count of surfaces backed by a
  // real (existing) behavioral test cannot drop below its floor, so one documented
  // missing-test gap can't be copied to null out the others.
  if (typeof floor.behavioralTestsMin === "number") {
    if (surfacesWithBehavioralTest < floor.behavioralTestsMin) {
      failures.push(
        `anti-shrinkage: ${surfacesWithBehavioralTest} surface(s) have an existing behavioral test, below `
        + `floor ${floor.behavioralTestsMin}. A behavioral test was removed/unpointed. Restore it or lower `
        + "behavioralTestsMin IN THIS PR.",
      );
    }
  }

  return {
    failures,
    report: {
      phaseA: {
        surfaceCount: (config.surfaces ?? []).length,
        totalDeclaredMethods,
        surfacesWithBehavioralTest,
        mutatorVerbs: [...mutatorVerbs].sort(),
        surfaces: surfaceReports,
      },
      phaseB: {
        surfacesLength,
        surfacesMin: floor.surfacesMin ?? null,
        routeFamiliesLength,
        routeFamiliesMin: floor.routeFamiliesMin ?? null,
        guardedMethodsTotal: totalDeclaredMethods,
        guardedMethodsMin: floor.guardedMethodsMin ?? null,
        perSurfaceMethodsMin: perSurface,
        behavioralTestsMin: floor.behavioralTestsMin ?? null,
        byClassification,
        baselineCommit: floor.baselineCommit ?? null,
      },
    },
  };
}

function assertFloor(failures, label, actual, min) {
  if (typeof min !== "number") {
    failures.push(`anti-shrinkage: countFloor is missing a numeric floor for ${label}`);
    return;
  }
  if (actual < min) {
    failures.push(
      `anti-shrinkage: ${label} dropped to ${actual}, below baseline floor ${min}. `
      + "A retirement surface/guard was silently removed. If this removal is intentional, "
      + "LOWER the corresponding *Min in methodRetiredSurfaces.countFloor IN THIS PR so the "
      + "de-retirement is consciously reviewed — do not let it pass invisibly.",
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot);
  const manifestPath = path.isAbsolute(args.manifestPath)
    ? args.manifestPath
    : path.join(repoRoot, args.manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`❌ ts-runtime method-guard gate FAILED: cannot read/parse manifest at ${manifestPath}: ${error.message}`);
    process.exit(1);
  }

  const { failures, report } = evaluateManifest(repoRoot, manifest);
  const status = failures.length === 0 ? "passed" : "failed";
  const output = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    manifestPath,
    status,
    report,
    failures,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const a = report.phaseA;
    const b = report.phaseB;
    console.log("── TS-runtime method-guard STRUCTURAL presence (Phase A) ──");
    for (const s of a.surfaces ?? []) {
      const methodLines = Object.entries(s.methods)
        .map(([name, m]) => `${name}=${m.guarded ? "guarded" : (m.located ? "UNGUARDED" : "NOT-FOUND")}`)
        .join(", ");
      const extras = [];
      if ((s.unregisteredMutators ?? []).length > 0) extras.push(`UNREGISTERED:[${s.unregisteredMutators.join(",")}]`);
      if ((s.allowlistedMutators ?? []).length > 0) extras.push(`allowlisted:[${s.allowlistedMutators.join(",")}]`);
      extras.push(`behavioralTest=${s.behavioralTestExists ? "present" : "MISSING"}`);
      console.log(`  ${s.id} (${s.serviceFile}): ${methodLines} | ${extras.join(" ")}`);
    }
    console.log(`  surfaces=${a.surfaceCount}, declared methods=${a.totalDeclaredMethods}, with-behavioral-test=${a.surfacesWithBehavioralTest}`);
    console.log(`  mutator verbs (prefix-matched): ${a.mutatorVerbs.join(",")}`);
    console.log("── Manifest anti-shrinkage (Phase B) ──");
    console.log(`  surfaces.length=${b.surfacesLength} (floor ${b.surfacesMin})`);
    console.log(`  routeFamilies.length=${b.routeFamiliesLength} (floor ${b.routeFamiliesMin})`);
    console.log(`  declared methods=${b.guardedMethodsTotal} (floor ${b.guardedMethodsMin})`);
    console.log(`  per-surface floors: ${JSON.stringify(b.perSurfaceMethodsMin)}`);
    console.log(`  behavioral tests present=${a.surfacesWithBehavioralTest} (floor ${b.behavioralTestsMin})`);
    console.log(`  byClassification (emitted, not floored): ${JSON.stringify(b.byClassification)}`);
  }

  if (failures.length > 0) {
    if (!args.json) {
      console.error(`\n❌ ts-runtime method-guard gate FAILED (${failures.length} finding(s)):`);
      for (const failure of failures) {
        console.error(`  - ${failure}`);
      }
    }
    process.exit(1);
  }
  // In --json mode the JSON object above is the sole stdout payload; suppress the
  // human success line so the output stays machine-parseable.
  if (!args.json) {
    console.log(
      "\n✅ ts-runtime method-guard STRUCTURAL presence verified + all public mutators registered/allowlisted "
      + "+ behavioral-test files present + no manifest shrinkage. (Structural presence only — fail-closed BEHAVIOR "
      + "is proven by the per-surface behavioral tests in the `test` job; brand-new-file off-route surfaces and "
      + "non-verb-prefixed mutator names are documented textual-gate limits.)",
    );
  }
  process.exit(0);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main();
}
