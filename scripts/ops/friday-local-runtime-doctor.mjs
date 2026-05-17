import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ITERATIONS = 1;
const DEFAULT_TARGETS = [
  "http://127.0.0.1:3141",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
];
const LOCAL_PASSPHRASE = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-runtime-doctor-passphrase-123";

// Phase 14.5B module_28b: deny-list for the JSON report. Any field whose
// key matches one of these patterns is redacted before output so that the
// doctor never emits secrets even when the user runs `--report-json` and
// pipes the result to a file. Match is case-insensitive substring against
// the lowercased key.
const SECRET_KEY_PATTERNS = [
  /token.*secret/,
  /\baccess[_-]?token\b/,
  /\bbearer\b/,
  /local[_-]?passphrase/,
  /\bsessiontoken\b/,
  /\bauthorization\b/,
  /\bsecret\b/,
  /\bpassword\b/,
  /\bcookie\b/,
];

export function redactSecretsFromValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return Array.isArray(value) ? [] : {};
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsFromValue(entry, seen));
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const lc = key.toLowerCase();
    if (SECRET_KEY_PATTERNS.some((pattern) => pattern.test(lc))) {
      result[key] = "[REDACTED]";
      continue;
    }
    result[key] = redactSecretsFromValue(raw, seen);
  }
  return result;
}

export function parseArgs(argv) {
  const ports = [];
  const urls = [];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let reportJson = false;
  let applyLowRisk = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--port" || arg === "-p") && argv[i + 1]) {
      ports.push(String(argv[i + 1]));
      i += 1;
      continue;
    }
    if ((arg === "--url" || arg === "-u") && argv[i + 1]) {
      urls.push(String(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1]), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--total-timeout-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1]), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        totalTimeoutMs = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--max-iterations" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1]), 10);
      if (Number.isFinite(parsed)) {
        if (parsed < 1) {
          maxIterations = 1;
        } else if (parsed > 10) {
          maxIterations = 10;
        } else {
          maxIterations = parsed;
        }
      }
      i += 1;
      continue;
    }
    if (arg === "--report-json") {
      reportJson = true;
      continue;
    }
    if (arg === "--apply-low-risk") {
      applyLowRisk = true;
      continue;
    }
  }

  return { ports, urls, timeoutMs, totalTimeoutMs, maxIterations, reportJson, applyLowRisk };
}

function resolveStateDir() {
  if (process.env.FRIDAY_STATE_DIR && process.env.FRIDAY_STATE_DIR.trim().length > 0) {
    return process.env.FRIDAY_STATE_DIR.trim();
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || "", "Library", "Application Support", "Friday", "state");
  }
  if (process.platform === "linux") {
    return path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || "", ".local", "state"), "friday");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || "", ".friday"), "Friday", "state");
  }
  return path.join(process.env.HOME || "", ".friday", "state");
}

function readSetupBinding() {
  const dbPath = path.join(resolveStateDir(), "friday.db");
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const hasTable = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'friday_setup_state'`,
      )
      .get();
    if (!hasTable?.name) {
      return null;
    }
    const row = db
      .prepare(
        `SELECT network_host, network_port
         FROM friday_setup_state
         WHERE id = 'singleton'`,
      )
      .get();
    if (!row?.network_port) {
      return null;
    }

    const host = typeof row.network_host === "string" && row.network_host.trim().length > 0
      ? row.network_host.trim()
      : "127.0.0.1";
    const port = Number.parseInt(String(row.network_port), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return null;
    }

    return {
      host,
      port,
      baseUrl: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${String(port)}`,
      dbPath,
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

function normalizeBaseUrl(input) {
  if (/^https?:\/\//u.test(input)) {
    return input.replace(/\/+$/u, "");
  }
  return `http://127.0.0.1:${input}`;
}

function buildTargets(args) {
  const targets = new Set();

  for (const url of args.urls) {
    targets.add(normalizeBaseUrl(url));
  }
  for (const port of args.ports) {
    targets.add(normalizeBaseUrl(port));
  }

  const envPort = Number.parseInt(process.env.FRIDAY_PORT || "", 10);
  const envHost = (process.env.FRIDAY_HOST || "").trim();
  if (Number.isFinite(envPort) && envPort > 0) {
    targets.add(`http://${envHost === "0.0.0.0" || envHost.length === 0 ? "127.0.0.1" : envHost}:${String(envPort)}`);
  }

  const setupBinding = readSetupBinding();
  if (setupBinding?.baseUrl) {
    targets.add(setupBinding.baseUrl);
  }

  for (const target of DEFAULT_TARGETS) {
    targets.add(target);
  }

  return {
    setupBinding,
    targets: [...targets],
  };
}

async function request(baseUrl, pathname, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/html;q=0.9, */*;q=0.1",
        ...(init.headers || {}),
      },
    });
    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let json = null;
    try {
      json = body.trim().length > 0 ? JSON.parse(body) : null;
    } catch {
      json = null;
    }

    const kind = json
      ? "json"
      : (contentType.includes("text/html") || body.trim().startsWith("<")) ? "html" : body.trim().length === 0 ? "empty" : "text";

    return {
      ok: true,
      status: response.status,
      contentType,
      kind,
      json,
      textPreview: body.replace(/\s+/gu, " ").trim().slice(0, 180),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isFridayEnvelope(result) {
  return result?.ok === true && result.kind === "json" && result.json && typeof result.json.ok === "boolean";
}

function isFridayHealth(result) {
  return isFridayEnvelope(result) && result.json.ok === true && result.json.data?.status === "ok";
}

export function classifyTarget(report) {
  const root = report.root;
  const health = report.health;
  const bootstrap = report.bootstrap;
  const login = report.login;
  const setupWithToken = report.setupWithToken;

  if (!root.ok && !health.ok) {
    return {
      classification: "unreachable",
      facts: ["Neither `/` nor `/v1/health` responded on this target."],
      recommendations: ["Verify the process is running and that you are checking the correct port."],
    };
  }

  if (root.ok && root.kind === "json" && root.json?.ok === false && root.json?.error?.code === "NOT_FOUND" && isFridayHealth(health)) {
    return {
      classification: "api_only_or_missing_ui",
      facts: [
        "`/` returned a Friday JSON 404 instead of HTML.",
        "`/v1/health` succeeded, so the API is running on this port.",
      ],
      recommendations: [
        "This is an API-only port or the UI static bundle is not mounted.",
        "Run `npm run build` and restart with `FRIDAY_UI_DIST_DIR=/path/to/friday/dist/ui`.",
        "Open the rebuilt app on the same API port after restart.",
      ],
    };
  }

  if (root.ok && root.kind === "html" && isFridayHealth(health) && isFridayEnvelope(setupWithToken) && setupWithToken.json.ok === true) {
    return {
      classification: "integrated_ui_and_api",
      facts: [
        "`/` returned HTML for the UI shell.",
        "`/v1/health` succeeded on the same origin.",
        "`/v1/setup/status` succeeded after local login.",
      ],
      recommendations: [
        `Use ${report.baseUrl}/ as the canonical local entrypoint for this instance.`,
      ],
    };
  }

  if (root.ok && root.kind === "html" && isFridayHealth(health) && bootstrap.ok && login.ok && login.status !== 200) {
    return {
      classification: "integrated_but_auth_requires_credentials",
      facts: [
        "`/` returned HTML for the UI shell.",
        "`/v1/health` and `/v1/auth/bootstrap/status` responded on the same origin.",
        "Local bypass login did not succeed on this target.",
      ],
      recommendations: [
        "This origin can reach the Friday API, but no-sign-in local mode is not available here.",
        "Use the normal login flow, or restart with `NODE_ENV=development` and without `FRIDAY_TOKEN_SECRET` if local bypass is intended.",
      ],
    };
  }

  if (root.ok && root.kind === "html" && (!health.ok || !isFridayHealth(health) || health.status === 404)) {
    return {
      classification: "ui_without_api_mount",
      facts: [
        "`/` returned HTML, so a frontend shell is present on this origin.",
        "`/v1/health` did not return a Friday health envelope on the same origin.",
      ],
      recommendations: [
        "This is a UI shell or wrapper port without a working `/v1` attachment.",
        "Open the canonical Friday API/UI port directly, usually `http://127.0.0.1:3141/`.",
        "If this origin is intentional, add a reverse proxy for `/v1/*` to the Friday API.",
      ],
    };
  }

  if (isFridayHealth(health) && report.setupNoAuth.ok && report.setupNoAuth.status === 401 && isFridayEnvelope(setupWithToken) && setupWithToken.json.ok === true) {
    return {
      classification: "api_auth_boundary_healthy",
      facts: [
        "`/v1/setup/status` correctly rejects unauthenticated access with 401.",
        "The same route succeeds after local login.",
      ],
      recommendations: [
        "Auth and setup route behavior look healthy on this target.",
      ],
    };
  }

  return {
    classification: "indeterminate",
    facts: [
      "The target responded, but it did not match a single known local runtime pattern cleanly.",
    ],
    recommendations: [
      "Compare the per-endpoint results below and prefer the port where `/` is HTML and `/v1/health` is a Friday JSON envelope.",
    ],
  };
}

function formatResultLine(label, result) {
  if (!result.ok) {
    return `- ${label}: unreachable (${result.error})`;
  }
  const suffix = result.kind === "json" && result.json?.ok === false && result.json?.error?.code
    ? ` code=${result.json.error.code}`
    : "";
  return `- ${label}: ${result.status} ${result.kind || "unknown"}${suffix}`;
}

export async function inspectTarget(baseUrl, timeoutMs) {
  const root = await request(baseUrl, "/", {}, timeoutMs);
  const health = await request(baseUrl, "/v1/health", {}, timeoutMs);
  const bootstrap = await request(baseUrl, "/v1/auth/bootstrap/status", {}, timeoutMs);
  const setupNoAuth = await request(baseUrl, "/v1/setup/status", {}, timeoutMs);
  if (bootstrap.ok && bootstrap.kind === "json" && bootstrap.json?.ok === true && bootstrap.json.data?.bootstrapRequired === true) {
    await request(
      baseUrl,
      "/v1/auth/bootstrap/local-passphrase",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
      },
      timeoutMs,
    );
  }
  const login = await request(
    baseUrl,
    "/v1/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    },
    timeoutMs,
  );

  const accessToken = login.ok && login.kind === "json" && login.json?.ok === true
    ? login.json.data?.accessToken
    : undefined;
  const setupWithToken = accessToken
    ? await request(
      baseUrl,
      "/v1/setup/status",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      timeoutMs,
    )
    : { ok: false, error: "skipped (no access token)" };

  const classification = classifyTarget({
    baseUrl,
    root,
    health,
    bootstrap,
    setupNoAuth,
    login,
    setupWithToken,
  });

  return {
    baseUrl,
    root,
    health,
    bootstrap,
    setupNoAuth,
    login,
    setupWithToken,
    ...classification,
  };
}

function printHeader(setupBinding) {
  console.log("Friday Local Runtime Doctor");
  console.log("");
  console.log("Confirmed facts:");
  console.log("- Standard local Friday runs UI and `/v1/*` API on the same port.");
  console.log("- Frontend development uses port 5173 and should proxy `/v1` to the Friday API on 3141.");
  console.log("- Docker normally publishes the same Friday port outward, defaulting to 3141.");
  if (setupBinding?.baseUrl) {
    console.log(`- Setup state currently points to ${setupBinding.baseUrl} (from ${setupBinding.dbPath}).`);
  }
  console.log("");
}

function printTargetReport(report) {
  console.log(`Target: ${report.baseUrl}`);
  console.log(`Classification: ${report.classification}`);
  console.log("Endpoint checks:");
  console.log(formatResultLine("GET /", report.root));
  console.log(formatResultLine("GET /v1/health", report.health));
  console.log(formatResultLine("GET /v1/auth/bootstrap/status", report.bootstrap));
  console.log(formatResultLine("GET /v1/setup/status (no auth)", report.setupNoAuth));
  console.log(formatResultLine("POST /v1/auth/login {local:true}", report.login));
  console.log(formatResultLine("GET /v1/setup/status (with auth)", report.setupWithToken));
  console.log("Confirmed facts:");
  for (const fact of report.facts) {
    console.log(`- ${fact}`);
  }
  console.log("Recommendations:");
  for (const recommendation of report.recommendations) {
    console.log(`- ${recommendation}`);
  }
  console.log("");
}

function describeLowRiskRecoveryCandidate(report) {
  if (report.classification === "api_only_or_missing_ui") {
    return {
      kind: "set_env_and_restart",
      setEnv: { FRIDAY_UI_DIST_DIR: "<repository>/dist/ui" },
      restart: { command: "npm run build && npm start", baseUrl: report.baseUrl },
    };
  }
  if (report.classification === "ui_without_api_mount") {
    return {
      kind: "open_canonical_port",
      openUrl: "http://127.0.0.1:3141/",
    };
  }
  if (report.classification === "integrated_but_auth_requires_credentials") {
    return {
      kind: "use_normal_login",
      hint: "Use Assistant login or set FRIDAY_LOCAL_PASSPHRASE to enable local-mode bypass for development only.",
    };
  }
  if (report.classification === "integrated_ui_and_api") {
    return { kind: "none" };
  }
  return { kind: "manual_review_required" };
}

function selectPreferredReport(reports) {
  return (
    reports.find((report) => report.classification === "integrated_ui_and_api")
    ?? reports.find((report) => report.classification === "api_auth_boundary_healthy")
    ?? reports.find((report) => report.classification === "integrated_but_auth_requires_credentials")
    ?? reports.find((report) => report.classification === "api_only_or_missing_ui")
    ?? reports.find((report) => report.classification === "ui_without_api_mount")
    ?? null
  );
}

export function buildJsonReport({ reports, args, setupBinding, status, wallClockMs }) {
  const preferred = selectPreferredReport(reports);
  // Phase 14.5B module_28b: --apply-low-risk reports candidates only. It
  // MUST NOT call /v1/auto-fix/* or mutate the filesystem/config. The
  // returned `wouldApply` describes what an operator could choose to do
  // outside this script.
  const wouldApply = args.applyLowRisk && preferred
    ? describeLowRiskRecoveryCandidate(preferred)
    : { kind: "none" };

  const payload = {
    schemaVersion: "1.0",
    status,
    wallClockMs,
    maxIterations: args.maxIterations,
    totalTimeoutMs: args.totalTimeoutMs,
    perCallTimeoutMs: args.timeoutMs,
    autoFixHttpCallsMade: false,
    setupBinding: setupBinding
      ? { host: setupBinding.host, port: setupBinding.port, baseUrl: setupBinding.baseUrl }
      : null,
    targets: reports.map((report) => ({
      baseUrl: report.baseUrl,
      classification: report.classification,
      facts: report.facts,
      recommendations: report.recommendations,
      endpointStatuses: {
        root: report.root.ok ? { status: report.root.status, kind: report.root.kind } : { error: report.root.error },
        health: report.health.ok ? { status: report.health.status, kind: report.health.kind } : { error: report.health.error },
        bootstrap: report.bootstrap.ok ? { status: report.bootstrap.status, kind: report.bootstrap.kind } : { error: report.bootstrap.error },
        setupNoAuth: report.setupNoAuth.ok ? { status: report.setupNoAuth.status, kind: report.setupNoAuth.kind } : { error: report.setupNoAuth.error },
        loginAttempted: report.login.ok,
        setupWithTokenAttempted: report.setupWithToken && report.setupWithToken.ok === true,
      },
    })),
    preferredEntrypoint: preferred?.baseUrl ?? null,
    wouldApply,
  };
  return redactSecretsFromValue(payload);
}

export async function runDoctor({ args, now = () => Date.now() }) {
  const { setupBinding, targets } = buildTargets(args);
  const reports = [];
  const start = now();
  let status = "ok";

  for (let iteration = 0; iteration < args.maxIterations; iteration += 1) {
    for (const target of targets) {
      const elapsed = now() - start;
      if (elapsed >= args.totalTimeoutMs) {
        status = "timeout_exceeded";
        return { reports, setupBinding, status, wallClockMs: elapsed };
      }
      reports.push(await inspectTarget(target, args.timeoutMs));
    }
    // Targets are deterministic and reachable state is captured per call.
    // Re-scanning beyond the first iteration is useful only if the operator
    // explicitly asked for it via --max-iterations.
    if (args.maxIterations <= 1) break;
  }

  return { reports, setupBinding, status, wallClockMs: now() - start };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runDoctor({ args });
  const { reports, setupBinding, status, wallClockMs } = result;

  if (args.reportJson) {
    const payload = buildJsonReport({ reports, args, setupBinding, status, wallClockMs });
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    if (status === "timeout_exceeded") {
      process.exitCode = 1;
      return;
    }
    if (payload.preferredEntrypoint) {
      process.exitCode = 0;
      return;
    }
    process.exitCode = 1;
    return;
  }

  printHeader(setupBinding);
  console.log("Scanning targets:");
  for (const target of reports.map((report) => report.baseUrl)) {
    console.log(`- ${target}`);
  }
  console.log("");

  for (const report of reports) {
    printTargetReport(report);
  }

  if (status === "timeout_exceeded") {
    console.log(`Wall-clock timeout exceeded after ${String(wallClockMs)}ms (limit ${String(args.totalTimeoutMs)}ms).`);
    process.exitCode = 1;
    return;
  }

  const integrated = reports.find((report) => report.classification === "integrated_ui_and_api");
  if (integrated) {
    console.log(`Preferred local entrypoint: ${integrated.baseUrl}/`);
    if (args.applyLowRisk) {
      const candidate = describeLowRiskRecoveryCandidate(integrated);
      console.log(`Low-risk recovery candidate: ${candidate.kind} (auto-fix HTTP routes NOT called by this script)`);
    }
    process.exitCode = 0;
    return;
  }

  const apiOnly = reports.find((report) => report.classification === "api_only_or_missing_ui");
  if (apiOnly) {
    console.log(`Most likely repair target: ${apiOnly.baseUrl}`);
    if (args.applyLowRisk) {
      const candidate = describeLowRiskRecoveryCandidate(apiOnly);
      console.log(`Low-risk recovery candidate: ${JSON.stringify(candidate)} (no auto-fix HTTP call; no filesystem write)`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("No fully healthy integrated local entrypoint was detected.");
  process.exitCode = 1;
}

// Phase 14.5B module_28b: the script remains a CLI by default, but its
// helper functions are exported so tests can exercise the JSON shape, the
// no-secret redaction, the timeout cap, and the no-HTTP-call-out behavior
// under --apply-low-risk without spawning a subprocess.
const isDirectEntry = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
    const here = path.resolve(new URL(import.meta.url).pathname);
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  void main();
}
