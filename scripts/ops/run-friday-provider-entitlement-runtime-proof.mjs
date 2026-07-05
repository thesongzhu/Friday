#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";

const HOST = "127.0.0.1";
const LOCAL_PASSPHRASE =
  process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-provider-entitlement-proof-passphrase";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/run-friday-provider-entitlement-runtime-proof.mjs \\
    [--provider=all|deepseek|openai|anthropic] [--out-dir=/abs/dir] [--allow-missing] [--preflight-only]

Truth: creates runtime proof artifacts for the END-BAR provider entitlement
matrix. It uses an isolated scratch Friday hub, creates API-key provider
profiles, runs Friday provider validation/doctor paths, and writes one proof
JSON per provider. It never prints secrets, never automates free ChatGPT web,
never writes prod DB rows, and never claims release/adoption.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const providerArg = arg("provider") || "all";
const allowMissing = args.includes("--allow-missing");
const preflightOnly = args.includes("--preflight-only");
const outDir = path.resolve(
  arg("out-dir")
    || process.env.FRIDAY_PROVIDER_ENTITLEMENT_RUNTIME_PROOF_DIR
    || path.join(os.tmpdir(), `friday-provider-entitlement-runtime-proof-${Date.now()}`),
);

const providerSpecs = {
  deepseek: {
    readinessId: "deepseek_api",
    kind: "deepseek",
    name: "END-BAR DeepSeek Runtime Proof",
    baseUrl: process.env.FRIDAY_PROVIDER_ENTITLEMENT_DEEPSEEK_BASE_URL
      ?? process.env.E2E_DEEPSEEK_BASE_URL
      ?? "https://api.deepseek.com",
    authMode: "bearer-token",
    api: "openai-completions",
    keyEnv: firstPresentEnv([
      process.env.FRIDAY_PROVIDER_ENTITLEMENT_DEEPSEEK_KEY_ENV,
      "FRIDAY_DEEPSEEK_API_KEY",
      "DEEPSEEK_API_KEY",
    ]),
    model: process.env.FRIDAY_PROVIDER_ENTITLEMENT_DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    supportedModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  openai: {
    readinessId: "openai_api",
    kind: "openai",
    name: "END-BAR OpenAI Runtime Proof",
    baseUrl: process.env.FRIDAY_PROVIDER_ENTITLEMENT_OPENAI_BASE_URL
      ?? process.env.E2E_OPENAI_BASE_URL
      ?? "https://api.openai.com",
    authMode: "api-key",
    api: "openai-responses",
    keyEnv: firstPresentEnv([
      process.env.FRIDAY_PROVIDER_ENTITLEMENT_OPENAI_KEY_ENV,
      "OPENAI_API_KEY",
      "FRIDAY_OPENAI_API_KEY",
    ]),
    model: process.env.FRIDAY_PROVIDER_ENTITLEMENT_OPENAI_MODEL ?? "gpt-4o-mini",
    supportedModels: ["gpt-4o-mini", "gpt-4o"],
  },
  anthropic: {
    readinessId: "anthropic_api",
    kind: "anthropic",
    name: "END-BAR Anthropic Runtime Proof",
    baseUrl: process.env.FRIDAY_PROVIDER_ENTITLEMENT_ANTHROPIC_BASE_URL
      ?? process.env.E2E_ANTHROPIC_BASE_URL
      ?? "https://api.anthropic.com",
    authMode: "api-key",
    api: "anthropic-messages",
    keyEnv: firstPresentEnv([
      process.env.FRIDAY_PROVIDER_ENTITLEMENT_ANTHROPIC_KEY_ENV,
      "FRIDAY_ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY",
    ]),
    model: process.env.FRIDAY_PROVIDER_ENTITLEMENT_ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    supportedModels: ["claude-sonnet-4-6", "claude-opus-4-8"],
  },
};

function firstPresentEnv(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    const name = candidate.trim();
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) return name;
  }
  return null;
}

function selectedProviders() {
  if (providerArg === "all") return Object.keys(providerSpecs);
  if (Object.hasOwn(providerSpecs, providerArg)) return [providerArg];
  throw new Error(`Unknown --provider=${providerArg}; expected all, deepseek, openai, or anthropic`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not resolve free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text in the error path without adding a second parser.
    }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiFetch(baseUrl, token, method, routePath, body, opts = {}) {
  return await fetchJson(`${baseUrl}${routePath}`, {
    method,
    headers: authHeaders(token),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: opts.timeoutMs,
  });
}

async function loginLocal(baseUrl) {
  const bootstrapStatus = await fetchJson(`${baseUrl}/v1/auth/bootstrap/status`);
  const bootstrapRequired =
    bootstrapStatus.json?.data?.bootstrapRequired
    ?? bootstrapStatus.json?.bootstrapRequired
    ?? false;
  if (bootstrapRequired) {
    const bootstrap = await fetchJson(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    if (!bootstrap.ok || bootstrap.json?.ok !== true) {
      throw new Error(`Local bootstrap failed: ${bootstrap.text}`);
    }
  }

  const login = await fetchJson(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
  });
  if (!login.ok || login.json?.ok !== true || typeof login.json?.data?.accessToken !== "string") {
    throw new Error(`Local login failed: ${login.text}`);
  }
  return login.json.data.accessToken;
}

async function createIsolatedHub(stateDir) {
  ensureScratchMasterKeyForRuntimeProof();
  const [{ createFridayHub }, { createFridayHttpServer }] = await Promise.all([
    import("#hub"),
    import("#api"),
  ]);
  const hub = await createFridayHub({
    stateDir,
    skillDirs: [],
    port: 0,
    logRequests: false,
    allowTestOnlyProviderProbeExecution: true,
    allowTestOnlyProviderRoutingControlsExecution: true,
  });
  await hub.start();
  const port = await findFreePort();
  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    middleware: hub.apiRuntime.middleware,
    webchatWsService: hub.webchatWsService,
    port,
    host: HOST,
    logRequests: false,
  });
  await httpServer.listen();
  const baseUrl = `http://${HOST}:${String(port)}`;
  const accessToken = await loginLocal(baseUrl);
  return { hub, httpServer, baseUrl, accessToken };
}

function ensureScratchMasterKeyForRuntimeProof() {
  if (process.env.FRIDAY_MASTER_KEY || process.env.FRIDAY_MASTER_KEY_SOURCE) {
    return;
  }
  process.env.FRIDAY_MASTER_KEY = randomBytes(32).toString("hex");
}

async function stopIsolatedHub(runtime) {
  if (!runtime) return;
  const stops = [];
  if (runtime.httpServer?.close) stops.push(runtime.httpServer.close());
  if (runtime.hub?.stop) stops.push(runtime.hub.stop());
  await Promise.allSettled(stops);
}

function missingProof(spec) {
  return {
    proof: "provider_entitlement_runtime_api_proof",
    status: "blocked",
    provider_kind: spec.kind,
    provider_id: spec.readinessId,
    real_external_api: false,
    blockers: [
      {
        code: "provider_api_key_env_missing",
        detail: `${spec.kind}: expected one of the configured ${spec.kind} API key env vars`,
      },
    ],
    caveat: "No secret value was read or printed; missing credentials keep END-BAR provider entitlement blocked.",
  };
}

function passedProof(spec, providerId, validation, doctor) {
  return {
    proof: "provider_entitlement_runtime_api_proof",
    status: "passed",
    provider_kind: spec.kind,
    provider_id: spec.readinessId,
    friday_provider_id: providerId,
    real_external_api: true,
    base_url_host: safeHost(spec.baseUrl),
    model: spec.model,
    api: spec.api,
    auth_mode: spec.authMode,
    key_env_ref: `$${spec.keyEnv}`,
    validation: {
      http_status: validation.status,
      status: validation.json?.data?.validation?.status ?? validation.json?.status ?? null,
      error_code: validation.json?.data?.validation?.errorCode ?? validation.json?.error?.code ?? null,
    },
    capability_doctor: {
      http_status: doctor.status,
      text_verified: doctorTextVerified(doctor.json, providerId, spec.model),
    },
    caveat: "Scratch-hub runtime proof only. It does not write prod DB rows, claim release, automate free ChatGPT web, or prove user adoption.",
  };
}

function failedProof(spec, stage, error) {
  return {
    proof: "provider_entitlement_runtime_api_proof",
    status: "blocked",
    provider_kind: spec.kind,
    provider_id: spec.readinessId,
    real_external_api: false,
    blockers: [
      {
        code: "provider_runtime_proof_failed",
        detail: `${spec.kind}:${stage}:${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    caveat: "Runtime proof failed honestly; this artifact must not be used as END-BAR pass evidence.",
  };
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function doctorTextVerified(json, providerId, model) {
  const results = json?.data?.capabilityResults ?? json?.capabilityResults ?? [];
  if (!Array.isArray(results)) return false;
  return results.some((entry) =>
    entry
    && entry.providerId === providerId
    && entry.capability === "text"
    && (!entry.model || entry.model === model)
    && (entry.status === "verified" || entry.verified === true)
  );
}

async function runProviderProof(runtime, spec) {
  const create = await apiFetch(runtime.baseUrl, runtime.accessToken, "POST", "/v1/providers", {
    kind: spec.kind,
    name: spec.name,
    baseUrl: spec.baseUrl,
    authMode: spec.authMode,
    api: spec.api,
    apiKey: `$${spec.keyEnv}`,
    supportedModels: spec.supportedModels,
    defaultModel: spec.model,
    enabled: true,
    validateOnSave: false,
  });
  if (!create.ok || create.json?.ok !== true || typeof create.json?.data?.provider?.id !== "string") {
    throw new Error(`provider create failed: ${create.text}`);
  }
  const providerId = create.json.data.provider.id;
  const validation = await apiFetch(
    runtime.baseUrl,
    runtime.accessToken,
    "POST",
    `/v1/providers/${encodeURIComponent(providerId)}/validate`,
    undefined,
    { timeoutMs: 180_000 },
  );
  if (!validation.ok || validation.json?.ok !== true) {
    throw new Error(`provider validate failed: ${validation.text}`);
  }
  const validationStatus = validation.json?.data?.validation?.status ?? validation.json?.status;
  if (validationStatus !== "ok" && validationStatus !== "valid" && validationStatus !== "verified") {
    throw new Error(`provider validation status not ok: ${JSON.stringify(validation.json?.data?.validation ?? validation.json)}`);
  }

  const doctor = await apiFetch(
    runtime.baseUrl,
    runtime.accessToken,
    "POST",
    "/v1/capabilities/doctor",
    { providerIds: [providerId] },
    { timeoutMs: 180_000 },
  );
  if (!doctor.ok || doctor.json?.ok !== true) {
    throw new Error(`capability doctor failed: ${doctor.text}`);
  }
  if (!doctorTextVerified(doctor.json, providerId, spec.model)) {
    throw new Error(`capability doctor did not verify text for ${spec.kind}:${spec.model}`);
  }
  return passedProof(spec, providerId, validation, doctor);
}

async function main() {
  ensureDir(outDir);
  const providerNames = selectedProviders();
  const stateDir = path.join(outDir, "scratch-state");
  const reports = [];
  let runtime = null;

  try {
    for (const name of providerNames) {
      const spec = providerSpecs[name];
      const proofPath = path.join(outDir, `${name}-runtime-proof.json`);
      if (!spec.keyEnv || preflightOnly) {
        const proof = spec.keyEnv && preflightOnly
          ? { ...missingProof(spec), status: "preflight_ready", real_external_api: false, blockers: [] }
          : missingProof(spec);
        writeJson(proofPath, proof);
        reports.push({ provider: name, proofPath, status: proof.status });
        continue;
      }

      try {
        runtime ??= await createIsolatedHub(stateDir);
        const proof = await runProviderProof(runtime, spec);
        writeJson(proofPath, proof);
        reports.push({ provider: name, proofPath, status: proof.status });
      } catch (error) {
        const proof = failedProof(spec, "runtime", error);
        writeJson(proofPath, proof);
        reports.push({ provider: name, proofPath, status: proof.status });
      }
    }
  } finally {
    await stopIsolatedHub(runtime);
  }

  const summary = {
    truth: "provider_entitlement_runtime_proof_run_summary",
    status: reports.every((report) => report.status === "passed" || report.status === "preflight_ready")
      ? "passed"
      : allowMissing
        ? "partial"
        : "blocked",
    outDir,
    reports,
    caveat: "Use check-friday-provider-entitlement-readiness.mjs with the per-provider proof paths to evaluate END-BAR provider entitlement readiness.",
  };
  const summaryPath = path.join(outDir, "summary.json");
  writeJson(summaryPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === "blocked") process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
