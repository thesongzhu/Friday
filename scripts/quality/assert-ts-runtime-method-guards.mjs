#!/usr/bin/env node
/**
 * TS-Runtime-Retirement: method-guard coverage + manifest anti-shrinkage gate.
 *
 * Second-phase companion to scripts/quality/check-ts-runtime-retirement.mjs.
 *
 * WHY THIS EXISTS (the route-blind gap):
 *   The route validator discovers HTTP routes (discoverRoutes over
 *   src/api/http/routes/**) and classifies each one. Its blocker==0 guarantee is
 *   therefore ROUTE-scoped. It is structurally blind to service-method guards:
 *   when a surface is route-retired but its mutating service methods are still
 *   reachable OFF-route (agent tools, UIX/reflex callers, background jobs,
 *   standing-agenda), the route validator sees nothing. The retirement of those
 *   surfaces lives in METHOD-head fail-closed guards (TS-R1 / #628 / #597) that
 *   the route validator cannot see — so a future regression that strips one of
 *   those method guards would un-retire a live surface while the route validator
 *   stays blocker=0. PR #628's original commit ad45080e was exactly this near
 *   miss: it added guards to only a SUBSET of each surface's mutating methods
 *   (submitTurn, cancelSession, materializeGeneratedSession were left
 *   route-retired-but-unguarded), and nothing gated on it.
 *
 * WHAT THIS ASSERTS (additive; does NOT touch route classification):
 *   PHASE A — method-guard coverage. For each surface in
 *     manifest.methodRetiredSurfaces.surfaces, scan its serviceFile and assert
 *     EVERY declared mutatingMethod carries its method-head fail-closed guard:
 *       - the method's definition head can be located (else FAIL — stale config
 *         or matcher bug, never silently skip), AND
 *       - within that method's body window, the surface's guard token appears
 *         (the guardHelper call for helper-services, or a direct `flag` ref for
 *         inline-guarded ones).
 *     Backstops: (1) the serviceFile must contain the literal
 *       `<flag> !== true` throw at least once (so gutting a shared helper body is
 *       caught, not just removing a call); (2) for helper-services, the count of
 *       guardHelper call-sites must be >= the count of declared mutating methods.
 *
 *   PHASE B — manifest anti-shrinkage floor. Emit manifest.surfaces.length,
 *     manifest.routeFamilies.length, and the total declared guarded-method count,
 *     and assert none has dropped below its baseline floor in
 *     methodRetiredSurfaces.countFloor. byClassification is EMITTED for review
 *     but intentionally NOT floored (fail_closed legitimately shrinks on Rust
 *     takeover). A legitimate removal forces a conscious baseline-lower in the
 *     same PR, which the reviewer sees.
 *
 * Node: builtins only — no dependencies, no `npm ci` required (the CI job that
 * runs this has no install step).
 *
 * Usage: node scripts/quality/assert-ts-runtime-method-guards.mjs [--repo-root <dir>] [--manifest <path>] [--json]
 *   Exits 0 on full coverage + no shrinkage, non-zero otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = "docs/ops/ts-runtime-retirement-manifest.json";

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

/**
 * Locate every definition-head line for `methodName` in `lines`.
 * A definition head is the method name immediately followed by `(`, in one of
 * the forms actually used across the guarded services:
 *   - `async function startRun(` / `function cancelRun(` / `function updatePolicy(`
 *   - object-method shorthand: `async submitTurn(` / `async deployDraft(input) {`
 *   - assigned arrow: `const executeIntent = async (`
 * We exclude:
 *   - calls and longer identifiers (word-boundary on both sides of the name),
 *   - interface signature lines (no body — they have neither `async`, `function`,
 *     `=>`/`= async`, nor a trailing `{`; e.g. `executeIntent(input): Promise<X>;`).
 *     Interface object-param sigs like `deployDraft(input: {` ARE tolerated as
 *     candidate heads: they simply won't contain the guard token in their window,
 *     and the impl head (which does) satisfies the per-method requirement.
 */
function findDefinitionHeadLines(lines, methodName) {
  const heads = [];
  // name as a standalone identifier (not preceded/followed by identifier chars)
  // immediately followed by optional whitespace then `(`.
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
      // A bare `methodName(...)` call site inside other code — skip it.
      continue;
    }
    heads.push(index);
  }
  return heads;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The body window for the head at `headLine` runs until the next definition head
 * (of ANY declared mutating method in this file) or +`maxWindow` lines, whichever
 * is first. Using the next declared head as the bound prevents one method's
 * window from false-passing on a neighbouring method's guard.
 */
function windowEnd(headLine, allHeadLines, maxWindow, totalLines) {
  let bound = Math.min(headLine + maxWindow, totalLines);
  for (const other of allHeadLines) {
    if (other > headLine && other < bound) {
      bound = other;
    }
  }
  return bound;
}

export function evaluateSurface(repoRoot, surface) {
  const failures = [];
  const details = { id: surface.id, serviceFile: surface.serviceFile, methods: {} };
  const absolute = path.join(repoRoot, surface.serviceFile);
  if (!fs.existsSync(absolute)) {
    failures.push(`surface ${surface.id}: serviceFile ${surface.serviceFile} not found`);
    return { failures, details };
  }
  const source = fs.readFileSync(absolute, "utf8");
  const lines = source.split("\n");

  const flag = surface.flag;
  if (typeof flag !== "string" || flag.length === 0) {
    failures.push(`surface ${surface.id}: config missing 'flag'`);
    return { failures, details };
  }

  // Backstop 1: the actual fail-closed throw must exist at least once, so gutting
  // a shared guard helper's body (while keeping its callers) is still caught.
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

  // Collect every declared method's definition heads up front so each window can
  // be bounded by the next declared head.
  const allHeads = [];
  const headsByMethod = {};
  for (const methodName of surface.mutatingMethods ?? []) {
    const heads = findDefinitionHeadLines(lines, methodName);
    headsByMethod[methodName] = heads;
    for (const head of heads) {
      allHeads.push(head);
    }
  }
  allHeads.sort((left, right) => left - right);

  for (const methodName of surface.mutatingMethods ?? []) {
    const heads = headsByMethod[methodName];
    if (heads.length === 0) {
      failures.push(
        `surface ${surface.id}: declared mutating method '${methodName}' has no locatable `
        + `definition head in ${surface.serviceFile} (stale config or matcher needs updating — `
        + "investigate, do NOT remove the method from config to make this pass)",
      );
      details.methods[methodName] = { located: false, guarded: false };
      continue;
    }
    // At least ONE definition head of this method must carry the guard token in
    // its window (the impl head; interface sigs won't).
    let guarded = false;
    let guardedAtLine = null;
    for (const head of heads) {
      const end = windowEnd(head, allHeads, 24, lines.length);
      const windowText = lines.slice(head, end).join("\n");
      if (guardTokenRegex.test(windowText)) {
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
        + `method-head guard (${tokenLabel}) is MISSING — a regression un-retired this surface `
        + `off-route while the route validator stays blocker=0 (${surface.serviceFile})`,
      );
    }
  }

  // Backstop 2: for helper-services, guard-call-site count must cover the
  // declared mutators (catches dropping a guard from one of several methods even
  // if some other path keeps the helper referenced).
  if (guardHelper) {
    const callSiteRegex = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(guardHelper)}\\s*\\(`, "gu");
    const callSites = (source.match(callSiteRegex) ?? []).length;
    // The helper's own declaration (`function assert...() {`) is one occurrence;
    // subtract it so we count true call-sites.
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

  return { failures, details };
}

export function evaluateManifest(repoRoot, manifest) {
  const failures = [];
  const config = manifest.methodRetiredSurfaces;
  if (!config || typeof config !== "object") {
    failures.push("manifest is missing methodRetiredSurfaces config (method-guard coverage cannot run)");
    return { failures, report: { phaseA: {}, phaseB: {} } };
  }

  // ── PHASE A: method-guard coverage ──
  const surfaceReports = [];
  let totalDeclaredMethods = 0;
  for (const surface of config.surfaces ?? []) {
    totalDeclaredMethods += (surface.mutatingMethods ?? []).length;
    const { failures: surfaceFailures, details } = evaluateSurface(repoRoot, surface);
    failures.push(...surfaceFailures);
    surfaceReports.push(details);
  }

  // ── PHASE B: manifest anti-shrinkage floor ──
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

  return {
    failures,
    report: {
      phaseA: {
        surfaceCount: (config.surfaces ?? []).length,
        totalDeclaredMethods,
        surfaces: surfaceReports,
      },
      phaseB: {
        surfacesLength,
        surfacesMin: floor.surfacesMin ?? null,
        routeFamiliesLength,
        routeFamiliesMin: floor.routeFamiliesMin ?? null,
        guardedMethodsTotal: totalDeclaredMethods,
        guardedMethodsMin: floor.guardedMethodsMin ?? null,
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
    console.log("── TS-runtime method-guard coverage (Phase A) ──");
    for (const s of a.surfaces ?? []) {
      const methodLines = Object.entries(s.methods)
        .map(([name, m]) => `${name}=${m.guarded ? "guarded" : (m.located ? "UNGUARDED" : "NOT-FOUND")}`)
        .join(", ");
      console.log(`  ${s.id} (${s.serviceFile}): ${methodLines}`);
    }
    console.log(`  surfaces=${a.surfaceCount}, declared guarded methods=${a.totalDeclaredMethods}`);
    console.log("── Manifest anti-shrinkage (Phase B) ──");
    console.log(`  surfaces.length=${b.surfacesLength} (floor ${b.surfacesMin})`);
    console.log(`  routeFamilies.length=${b.routeFamiliesLength} (floor ${b.routeFamiliesMin})`);
    console.log(`  declared guarded methods=${b.guardedMethodsTotal} (floor ${b.guardedMethodsMin})`);
    console.log(`  byClassification (emitted, not floored): ${JSON.stringify(b.byClassification)}`);
  }

  if (failures.length > 0) {
    console.error(`\n❌ ts-runtime method-guard gate FAILED (${failures.length} finding(s)):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log("\n✅ ts-runtime method-guard coverage complete + no manifest shrinkage.");
  process.exit(0);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main();
}
