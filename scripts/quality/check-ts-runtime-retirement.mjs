#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_CLASSIFICATIONS = new Set([
  "ui_shell",
  "test_oracle",
  "release_tooling",
  "compat_shim",
  "rust_delegated",
  "operator_external_adapter",
  "fail_closed",
  "ts_runtime_blocker",
]);

const ROUTE_REGEX = /operationId:\s*"([^"]+)"[\s\S]{0,700}?method:\s*"([A-Z]+)"[\s\S]{0,700}?path:\s*"([^"]+)"/gu;

export function parseArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    manifestPath: "docs/ops/ts-runtime-retirement-manifest.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--manifest") {
      args.manifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (entry === "--repo-root") {
      args.repoRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (!entry.startsWith("--")) {
      args.repoRoot = entry;
    }
  }

  return args;
}

export function discoverRoutes(repoRoot, routeSourceDir) {
  const absoluteRouteDir = path.join(repoRoot, routeSourceDir);
  const routeFiles = walkRouteFiles(absoluteRouteDir);
  const seen = new Set();
  const routes = [];

  for (const filePath of routeFiles) {
    const sourceFile = path.relative(repoRoot, filePath);
    const content = fs.readFileSync(filePath, "utf8");
    for (const match of content.matchAll(ROUTE_REGEX)) {
      const route = {
        operationId: match[1],
        method: match[2],
        path: match[3],
        sourceFile,
      };
      const key = routeKey(route);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      routes.push(route);
    }
  }

  return routes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
}

export function collectTsRuntimeRetirementFailures(manifest, routes) {
  const failures = [];
  validateManifestBasics(manifest, failures);

  const includeMethods = new Set(manifest.discovery?.includeMethods ?? []);
  const discoveredRoutes = routes.filter((route) => includeMethods.size === 0 || includeMethods.has(route.method));
  const exactSurfaces = manifest.surfaces ?? [];
  const routeFamilies = manifest.routeFamilies ?? [];

  for (const surface of exactSurfaces) {
    if (!surface.route) {
      failures.push(`surface ${surface.id ?? "<unknown>"} is missing route`);
      continue;
    }
    const exists = discoveredRoutes.some((route) => routeMatchesExact(route, surface.route));
    if (!exists) {
      failures.push(`surface ${surface.id ?? surface.route.operationId} does not match a discovered route`);
    }
  }

  const classified = [];
  for (const route of discoveredRoutes) {
    const match = findClassificationMatchForRoute(route, exactSurfaces, routeFamilies);
    if (!match) {
      failures.push(`${routeLabel(route)} is unclassified`);
      continue;
    }
    const { classification, matchKind } = match;
    classified.push({ route, classification, matchKind });
    validateClassification(route, classification, manifest, failures);
  }

  const summary = summarizeClassifiedRoutes(classified);
  validateExactCoverageFloor(manifest, summary, failures);

  return {
    failures,
    classified,
    summary,
  };
}

export function findClassificationForRoute(route, exactSurfaces, routeFamilies) {
  return findClassificationMatchForRoute(route, exactSurfaces, routeFamilies)?.classification;
}

export function findClassificationMatchForRoute(route, exactSurfaces, routeFamilies) {
  const exact = exactSurfaces.find((surface) => surface.route && routeMatchesExact(route, surface.route));
  if (exact) {
    return { classification: exact, matchKind: "exact" };
  }
  const family = routeFamilies.find((entry) => routeMatchesRule(route, entry.match ?? {}));
  return family ? { classification: family, matchKind: "family" } : null;
}

function validateManifestBasics(manifest, failures) {
  if (manifest.schemaVersion !== 1) {
    failures.push("manifest schemaVersion must be 1");
  }
  for (const value of manifest.classificationValues ?? []) {
    if (!ALLOWED_CLASSIFICATIONS.has(value)) {
      failures.push(`manifest contains unknown classification value ${value}`);
    }
  }
  for (const required of ALLOWED_CLASSIFICATIONS) {
    if (!(manifest.classificationValues ?? []).includes(required)) {
      failures.push(`manifest classificationValues is missing ${required}`);
    }
  }
}

function validateExactCoverageFloor(manifest, summary, failures) {
  const exactRouteSurfacesMin = manifest.discovery?.exactRouteSurfacesMin;
  if (exactRouteSurfacesMin === undefined) {
    return;
  }
  if (!Number.isInteger(exactRouteSurfacesMin) || exactRouteSurfacesMin < 0) {
    failures.push("discovery.exactRouteSurfacesMin must be a non-negative integer when set");
    return;
  }
  if (summary.exactClassified < exactRouteSurfacesMin) {
    failures.push(
      `exact route surface coverage ${summary.exactClassified} is below `
      + `discovery.exactRouteSurfacesMin ${exactRouteSurfacesMin}`,
    );
  }
}

function validateClassification(route, classification, manifest, failures) {
  const label = `${routeLabel(route)} via ${classification.id ?? "<unnamed>"}`;
  if (!ALLOWED_CLASSIFICATIONS.has(classification.classification)) {
    failures.push(`${label} has invalid classification ${classification.classification}`);
    return;
  }

  validateCompletionSemantics(label, classification, manifest, failures);

  if (classification.classification === "ts_runtime_blocker") {
    for (const field of ["owner", "blocker", "next_action"]) {
      if (!hasNonEmptyString(classification[field])) {
        failures.push(`${label} is a ts_runtime_blocker without ${field}`);
      }
    }
  }

  if (classification.classification === "rust_delegated") {
    for (const field of ["rust_entrypoint", "proof"]) {
      if (!hasNonEmptyString(classification[field])) {
        failures.push(`${label} is rust_delegated without ${field}`);
      }
    }
  }

  if (classification.classification === "fail_closed") {
    if (classification.executes_product_logic !== false) {
      failures.push(`${label} is fail_closed but does not declare executes_product_logic=false`);
    }
  }

  if (classification.classification === "operator_external_adapter") {
    validateLeakControls(label, classification, manifest.requiredLeakControls ?? [], failures);
  }
}

function validateCompletionSemantics(label, classification, manifest, failures) {
  const merged = {
    ...(manifest.defaultCompletionSemantics ?? {}),
    ...(classification.completion_semantics ?? {}),
  };
  for (const forbidden of manifest.forbiddenCompletionSources ?? []) {
    if (merged[forbidden] !== false) {
      failures.push(`${label} can treat ${forbidden} as completion`);
    }
  }
}

function validateLeakControls(label, classification, requiredLeakControls, failures) {
  const leakControls = classification.leak_controls;
  if (!leakControls || leakControls.raw_private_data_allowed !== false) {
    failures.push(`${label} is operator_external_adapter without raw_private_data_allowed=false`);
    return;
  }
  const forbidden = new Set(leakControls.forbidden ?? []);
  for (const required of requiredLeakControls) {
    if (!forbidden.has(required)) {
      failures.push(`${label} leak controls are missing ${required}`);
    }
  }
}

function summarizeClassifiedRoutes(classified) {
  const byClassification = {};
  const byMatchKind = {};
  const blockerIds = new Set();
  for (const { classification, matchKind } of classified) {
    byClassification[classification.classification] =
      (byClassification[classification.classification] ?? 0) + 1;
    byMatchKind[matchKind] = (byMatchKind[matchKind] ?? 0) + 1;
    if (classification.classification === "ts_runtime_blocker") {
      blockerIds.add(classification.id);
    }
  }
  return {
    total: classified.length,
    byClassification,
    byMatchKind,
    exactClassified: byMatchKind.exact ?? 0,
    familyClassified: byMatchKind.family ?? 0,
    blockerFamilies: [...blockerIds].sort(),
  };
}

function routeMatchesExact(route, expected) {
  return route.method === expected.method
    && route.path === expected.path
    && route.operationId === expected.operationId;
}

function routeMatchesRule(route, rule) {
  return matchStringOrArray(route.sourceFile, rule.sourceFile)
    && matchStringOrArray(route.method, rule.method)
    && matchStringOrArray(route.path, rule.path)
    && matchPrefix(route.path, rule.pathPrefix)
    && matchPrefix(route.operationId, rule.operationIdPrefix);
}

function matchStringOrArray(value, expected) {
  if (expected === undefined) {
    return true;
  }
  if (Array.isArray(expected)) {
    return expected.includes(value);
  }
  return value === expected;
}

function matchPrefix(value, prefix) {
  if (prefix === undefined) {
    return true;
  }
  if (Array.isArray(prefix)) {
    return prefix.some((entry) => value.startsWith(entry));
  }
  return value.startsWith(prefix);
}

function walkRouteFiles(routeDir) {
  if (!fs.existsSync(routeDir)) {
    return [];
  }
  const pending = [routeDir];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.name.endsWith(".ts")) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function routeKey(route) {
  return `${route.sourceFile} ${route.method} ${route.path} ${route.operationId}`;
}

function routeLabel(route) {
  return `${route.method} ${route.path} (${route.operationId}, ${route.sourceFile})`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot);
  const manifestPath = path.isAbsolute(args.manifestPath)
    ? args.manifestPath
    : path.join(repoRoot, args.manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const routes = discoverRoutes(repoRoot, manifest.discovery?.routeSourceDir ?? "src/api/http/routes");
  const result = collectTsRuntimeRetirementFailures(manifest, routes);
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    manifestPath,
    status: result.failures.length === 0 ? "passed" : "failed",
    routeCount: routes.length,
    summary: result.summary,
    failures: result.failures,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(result.failures.length === 0 ? 0 : 1);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main();
}
