#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);

const CANONICAL_MECHANISMS = [
  "intake_mission",
  "by_strength_routing",
  "execution_agent_run",
  "verification_proof",
  "memory_confirm_recall",
  "approval_gate",
  "trust_grant_dial",
  "context_passport",
  "audit_hash_chain",
  "token_metering",
  "skills",
  "provider_workspace",
  "channels",
  "voice",
  "pairing_device_trust",
  "needs_me_activity",
  "crash_recovery",
  "smart_queue",
  "smart_watch",
];

const LIFECYCLE_STATES = [
  "empty",
  "loading",
  "error+retry",
  "offline-stale-no-network",
  "permission-denied-fail-closed-503",
  "success",
];

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

function usage() {
  console.error(`usage:
  node scripts/ops/build-friday-suite13-census.mjs \\
    [--repo-root=/abs/repo] [--out=/abs/suite13-census.json] [--require-nonempty]

Truth: builds a Suite-13 census input from static repo sources. It does not run
the product, classify coverage green, write organic provenance, or satisfy
END-BAR.`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(arg("repo-root") || process.cwd());
const outPath = arg("out");
const requireNonempty = args.includes("--require-nonempty");
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function walk(root, predicate = () => true) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = statSync(current);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
        stack.push(join(current, entry));
      }
      continue;
    }
    if (stats.isFile() && predicate(current)) out.push(current);
  }
  return out.sort();
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function normalizeUiRoute(path) {
  if (!path || path === "/") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeEndpoint(raw) {
  return raw.replace(/\$\{[^}]+\}/g, ":param").replace(/`/g, "");
}

function extractQuotedV1Calls(text) {
  const calls = [];
  const pattern = /["`]((?:\/v1\/)[^"`'${}\s)]+(?:\$\{[^}]+\}[^"`'\s)]*)*)["`]/g;
  for (const match of text.matchAll(pattern)) {
    calls.push(normalizeEndpoint(match[1]));
  }
  return calls;
}

function extractUiRoutes() {
  const router = readText(join(repoRoot, "ui/src/router.tsx"));
  const routes = [];
  for (const match of router.matchAll(/\bpath:\s*["']([^"']+)["']/g)) {
    routes.push(normalizeUiRoute(match[1]));
  }
  if (router.includes("index: true")) routes.push("/");
  return unique(routes);
}

function extractUiApiCalls() {
  const roots = [join(repoRoot, "ui/src")];
  const files = roots.flatMap((root) => walk(root, (file) => /\.(ts|tsx)$/.test(file)));
  return unique(files.flatMap((file) => extractQuotedV1Calls(readText(file))));
}

function extractSwiftScreens() {
  const root = join(repoRoot, "apps/friday-ios");
  return unique(walk(root, (file) => file.endsWith(".swift")).map((file) => basename(file)));
}

function extractHttpRoutes() {
  const roots = [join(repoRoot, "src/api/http/routes"), join(repoRoot, "src/api/http")];
  const files = unique(roots.flatMap((root) => walk(root, (file) => file.endsWith(".ts"))));
  const routes = [];
  for (const file of files) {
    const text = readText(file);
    const routePattern = /method:\s*["']([A-Z]+)["'][\s\S]{0,220}?path:\s*["']([^"']+)["']/g;
    for (const match of text.matchAll(routePattern)) {
      routes.push(`${match[1]} ${match[2]}`);
    }
  }
  return unique(routes);
}

function extractOperatorClientEndpoints() {
  const root = join(repoRoot, "packages/friday-operator-client/src");
  const files = walk(root, (file) => /\.(ts|tsx)$/.test(file));
  const endpoints = [];
  for (const file of files) {
    const text = readText(file);
    for (const match of text.matchAll(/transport\.(get|post|put|patch|del|delete)<[^>]*>?\(\s*["`]([^"`']+)["`]/g)) {
      endpoints.push(`${methodName(match[1])} ${normalizeEndpoint(match[2])}`);
    }
    for (const match of text.matchAll(/transport\.(get|post|put|patch|del|delete)\(\s*["`]([^"`']+)["`]/g)) {
      endpoints.push(`${methodName(match[1])} ${normalizeEndpoint(match[2])}`);
    }
  }
  return unique(endpoints);
}

function methodName(name) {
  return name === "del" ? "DELETE" : name.toUpperCase();
}

function extractSealedWsMessages() {
  const protocol = readText(join(repoRoot, "rust-core/crates/friday-protocol/src/lib.rs"));
  const enumBody = extractRustEnumBody(protocol, "Message");
  if (!enumBody) return [];
  const variants = [];
  for (const line of enumBody.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Z][A-Za-z0-9_]+)\b/);
    if (match) variants.push(match[1]);
  }
  return unique(variants);
}

function extractRustEnumBody(source, enumName) {
  const startMatch = new RegExp(`pub\\s+enum\\s+${enumName}\\s*\\{`).exec(source);
  if (!startMatch) return "";
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index);
    }
  }
  return "";
}

function buildSurfaceControls(sources) {
  return [
    ...sources.A.uiRoutes.map((control) => ({ surface: "desktop-web", control })),
    ...sources.A.uiApiCalls.map((control) => ({ surface: "ui-api-call", control })),
    ...sources.A.swiftScreens.map((control) => ({ surface: "native-ios", control })),
    ...sources.B.httpRoutes.map((control) => ({ surface: "http-v1", control })),
    ...sources.B.sealedWsMessages.map((control) => ({ surface: "sealed-ws", control })),
    ...sources.B.operatorClientEndpoints.map((control) => ({ surface: "operator-client", control })),
    { surface: "native-android", control: "android-mock-column" },
  ];
}

function buildCells(sources) {
  const controls = buildSurfaceControls(sources);
  const cells = [];
  for (const { surface, control } of controls) {
    for (const mechanism of CANONICAL_MECHANISMS) {
      for (const lifecycleState of LIFECYCLE_STATES) {
        cells.push({
          cellId: `${surface}|${mechanism}|${control}|${lifecycleState}`,
          surface,
          mechanism,
          control,
          lifecycleState,
        });
      }
    }
  }
  return cells;
}

function buildOrphans(sources) {
  const uiCalls = new Set(sources.A.uiApiCalls);
  const operatorCalls = new Set(sources.B.operatorClientEndpoints.map((row) => row.replace(/^[A-Z]+ /, "")));
  return sources.B.httpRoutes.flatMap((route) => {
    const endpoint = route.replace(/^[A-Z]+ /, "");
    if (uiCalls.has(endpoint) || operatorCalls.has(endpoint)) return [];
    return [{
      kind: "orphan-backend",
      id: route,
      reason: "operator-gated",
      owningIssue: "S13-1-COVERAGE-ORACLE",
    }];
  });
}

const sources = {
  A: {
    uiRoutes: extractUiRoutes(),
    uiApiCalls: extractUiApiCalls(),
    swiftScreens: extractSwiftScreens(),
  },
  B: {
    httpRoutes: extractHttpRoutes(),
    sealedWsMessages: extractSealedWsMessages(),
    operatorClientEndpoints: extractOperatorClientEndpoints(),
  },
  C: {
    mechanisms: CANONICAL_MECHANISMS,
  },
};

if (requireNonempty) {
  if (sources.A.uiRoutes.length === 0) block("ui_routes_missing", "ui/src/router.tsx");
  if (sources.A.uiApiCalls.length === 0) block("ui_api_calls_missing", "ui/src");
  if (sources.B.httpRoutes.length === 0) block("http_routes_missing", "src/api/http/routes");
  if (sources.B.sealedWsMessages.length === 0) block("sealed_ws_messages_missing", "rust-core/crates/friday-protocol/src/lib.rs");
}

const status = blockers.length === 0 ? "passed" : "blocked";
const census = {
  truth: "suite13_census",
  status,
  generated_at_utc: new Date().toISOString(),
  repoRoot,
  sources,
  cells: status === "passed" ? buildCells(sources) : [],
  orphans: status === "passed" ? buildOrphans(sources) : [],
  blockers,
  caveat: "Static census input only. This does not mark any cell exercised-green and does not claim END-BAR, organic usage, live execution, or operator attestation.",
};

if (outPath) {
  const out = isAbsolute(outPath) ? outPath : resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(census, null, 2)}\n`);
}

console.log(JSON.stringify(census, null, 2));
process.exit(status === "passed" || !requireNonempty ? 0 : 2);
