// Shared utilities: logging, sleep, retries, evidence, markers.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const ROOT = "/tmp/friday-overnight-test";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKSPACE_ARTIFACT_DIR = `${REPO_ROOT}/.friday/overnight-gauntlet`;
export const WORKSPACE_FIXTURE_DIR = `${WORKSPACE_ARTIFACT_DIR}/fixtures`;
export const WORKSPACE_CAPTURE_DIR = `${WORKSPACE_ARTIFACT_DIR}/captures`;
export const STATE_DIR = `${ROOT}/state`;
export const LOG_DIR = `${ROOT}/logs`;
export const MARKER_DIR = `${ROOT}/markers`;
export const EVIDENCE_DIR = `${ROOT}/evidence`;
export const REPORT = `${ROOT}/STABILITY-FINDINGS-OVERNIGHT.md`;
export const PORT = 3144;
export const PORT_UI = 3145;
export const BASE = `http://127.0.0.1:${PORT}`;
export const LOCAL_PASSPHRASE = process.env.FRIDAY_OVERNIGHT_LOCAL_PASSPHRASE ?? "friday-overnight-local-passphrase";

export const ORCH_LOG = `${LOG_DIR}/orchestrator.log`;

for (const d of [
  ROOT,
  STATE_DIR,
  LOG_DIR,
  MARKER_DIR,
  EVIDENCE_DIR,
  `${ROOT}/captures`,
  `${ROOT}/fixtures`,
  WORKSPACE_ARTIFACT_DIR,
  WORKSPACE_FIXTURE_DIR,
  WORKSPACE_CAPTURE_DIR,
]) {
  mkdirSync(d, { recursive: true });
}

export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(stringify).join(" ")}`;
  process.stdout.write(line + "\n");
  appendFileSync(ORCH_LOG, line + "\n");
}
function stringify(x) { return typeof x === "string" ? x : JSON.stringify(x); }

export { sleep };

/** Persist a piece of evidence and return its hash. */
export function evidence(phase, name, content) {
  const buf = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2);
  const dir = `${EVIDENCE_DIR}/${phase}`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}`;
  writeFileSync(path, buf);
  const hash = createHash("sha256").update(buf).digest("hex");
  return { path, hash, bytes: Buffer.byteLength(buf) };
}

/** Begin / end a phase: writes a marker JSON. */
export function startPhase(phaseId) {
  const startedAt = new Date().toISOString();
  return {
    phaseId,
    startedAt,
    evidenceHashes: [],
    notes: [],
    addEvidence(name, content) {
      const e = evidence(phaseId, name, content);
      this.evidenceHashes.push(e.hash);
      return e;
    },
    note(s) { this.notes.push(s); log(`[phase ${phaseId}]`, s); },
    finish(status, summary, anomalies = []) {
      const finishedAt = new Date().toISOString();
      const marker = {
        phaseId, startedAt, finishedAt,
        status, summary, anomalies,
        evidenceHashes: this.evidenceHashes,
        notes: this.notes,
      };
      writeFileSync(`${MARKER_DIR}/${phaseId}.complete.json`, JSON.stringify(marker, null, 2));
      log(`[phase ${phaseId}] finished status=${status}`);
      return marker;
    },
  };
}

/** Concise fetch wrapper with timing + error capture. Returns {status, body, ms, raw, headers}. */
export async function api(path, opts = {}) {
  const start = Date.now();
  const url = `${BASE}${path}`;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.token && !headers.Authorization) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, ms: Date.now() - start, raw: text, headers: Object.fromEntries(res.headers) };
}

export async function login() {
  const status = await api("/v1/auth/bootstrap/status");
  if (status.body?.data?.bootstrapRequired || status.body?.bootstrapRequired) {
    const bootstrap = await api("/v1/auth/bootstrap/local-passphrase", {
      method: "POST",
      body: JSON.stringify({ passphrase: LOCAL_PASSPHRASE }),
    });
    if (!bootstrap.body?.ok && bootstrap.status >= 400) {
      throw new Error("bootstrap failed: " + JSON.stringify(bootstrap.body));
    }
  }
  const r = await api("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
  });
  if (!r.body?.ok) throw new Error("login failed: " + JSON.stringify(r.body));
  return { accessToken: r.body.data.accessToken, refreshToken: r.body.data.refreshToken };
}

export async function refreshTokens(tokens) {
  if (!tokens?.refreshToken) return login();
  const r = await api("/v1/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  if (!r.body?.ok) return login();
  return {
    accessToken: r.body.data.accessToken,
    refreshToken: r.body.data.refreshToken ?? tokens.refreshToken,
  };
}

export async function authedApi(ctx, path, opts = {}) {
  let r = await api(path, { ...opts, token: ctx.tokens?.accessToken });
  if (r.status !== 401 || opts.allowExpired === true) return r;
  ctx.tokens = await refreshTokens(ctx.tokens);
  return api(path, { ...opts, token: ctx.tokens?.accessToken });
}

export function isProviderPreconditionFailure(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /no enabled provider\/model route satisfies required capabilities/i.test(text)
    || /provider(?:\/model)? route/i.test(text)
    || /at least one configured source failed validation/i.test(text)
    || /incorrect api key/i.test(text)
    || /invalid api key/i.test(text)
    || /failed_verification/i.test(text)
    || /configure and verify a capable provider/i.test(text)
    || /temporary connection issue with (?:my )?ai service/i.test(text);
}

export function responseHasProviderPreconditionFailure(response) {
  return isProviderPreconditionFailure(response?.raw)
    || isProviderPreconditionFailure(response?.body);
}

/** Wait until /v1/health returns 200. */
export async function waitForHealth(maxMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/v1/health`);
      if (r.status === 200) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error("health timeout");
}

/** Concurrent runner with collected results. */
export async function parallel(fns, limit = Infinity) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= fns.length) return;
      try { results[i] = { ok: true, value: await fns[i]() }; }
      catch (e) { results[i] = { ok: false, error: String(e?.stack || e) }; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, fns.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Returns RSS in KB of given pid (macOS). */
export async function pidRssKb(pid) {
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync(`ps -p ${pid} -o rss=,vsz=,etime=,pcpu= 2>/dev/null`).toString().trim();
    if (!out) return null;
    const [rss, vsz, etime, pcpu] = out.split(/\s+/);
    return { rssKb: Number(rss), vszKb: Number(vsz), etime, pcpuPct: Number(pcpu) };
  } catch { return null; }
}

/** Stat sqlite + WAL */
export function dbSizes(stateDir = STATE_DIR) {
  const out = {};
  for (const name of ["friday.db", "friday.db-wal", "friday.db-shm"]) {
    const p = `${stateDir}/${name}`;
    out[name] = existsSync(p) ? statSync(p).size : 0;
  }
  return out;
}

/** Read last line(s) of a file safely. */
export function tailFile(path, n = 1) {
  if (!existsSync(path)) return "";
  const buf = readFileSync(path, "utf8");
  return buf.split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
}

/** Approximate token count (4 chars ~= 1 token) without tokenizer dep. */
export function approxTokens(s) { return Math.ceil((s || "").length / 4); }
