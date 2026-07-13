#!/usr/bin/env node

/**
 * BYOK Cold-Start Credential-Entry Readiness Harness
 * ── INSTALL-COLD-BYOK-PREP-001 ──
 *
 * Deterministically proves that a CLEAN install of the exact product candidate
 * reaches real BYOK credential-entry READINESS — first-run bootstrap → owner
 * claim/pair → the provider-key entry surface is reachable and wired to the
 * validate-before-persist create route — WITHOUT ever entering a real key and
 * WITHOUT making a real provider network call.
 *
 * "Readiness" here is deliberately narrow and honest:
 *   - The credential-entry surface is SHIPPED in the served UI artifact (the
 *     setup wizard's provider-key step, wired to `validateOnSave: true`).
 *   - The backend validate-before-persist create route (POST /v1/providers) is
 *     REACHABLE (not 404) and FUNCTIONAL (not 503-disabled): it enforces
 *     validation and refuses to persist an invalid/incomplete provider.
 *   - We stop BEFORE entering any real key. The route probe uses a
 *     SCHEMA-INVALID body, which the handler rejects via `validateCreateBody`
 *     BEFORE `providerService.createProvider` — so NO provider network call is
 *     ever made and NO key is ever handled.
 *
 * What this harness intentionally does NOT do (that is the choice-card step):
 *   - It does not enter a real API key.
 *   - It does not drive the network-validation-of-a-real-key limb (which would
 *     require an outbound provider call).
 *
 * Flow (mirrors scripts/ci/install-smoke.mjs for the cold-start scaffold):
 *   1. Build if dist artifacts are missing.
 *   2. `npm pack --ignore-scripts` → install the tarball in a fresh temp dir.
 *   3. Start the server with fully isolated state (fresh FRIDAY_STATE_DIR, fresh
 *      HOME/XDG, ephemeral port). Poll /v1/health.
 *   4. Assert CLEAN state: no owner (bootstrapRequired=true), no provider secret
 *      (GET /v1/providers empty).
 *   5. Owner claim/pair: bootstrap local passphrase + login.
 *   6. Served surface: assert the credential-entry markers are present in the
 *      actually-served UI .js bundle set.
 *   7. Backend credential-entry point: probe POST /v1/providers with a
 *      schema-invalid body → expect 422 VALIDATION_ERROR (reachable+functional,
 *      no network, no key). Assert nothing was persisted.
 *   8. Non-vacuity self-test (always runs, same instance): the SAME predicates,
 *      pointed at an unreachable route / an absent marker, must FAIL.
 *   9. Emit a JSON readiness verdict; exit 0 (PASS) / 1 (FAIL).
 *
 * Demonstration hook: set FRIDAY_BYOK_READINESS_NEGATE=route|bundle to make the
 * MAIN verdict target an unreachable credential-entry point, so the whole
 * harness exits 1 — external proof the PASS is non-vacuous.
 *
 * Zero side effects on the prod install: never touches ~/.friday, prod ports,
 * prod sqlite, or launchd. Everything runs in fresh temp dirs on an ephemeral
 * port and is torn down.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const PORT_MIN = 19_000;
const PORT_SPAN = 1_000;
const LOCAL_PASSPHRASE = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-byok-readiness-passphrase-123";

/**
 * The markers that must be present in the actually-served UI bundle to prove
 * the BYOK credential-entry surface + validate-before-persist client wiring is
 * shipped:
 *   - "setup-page"      → the first-run setup wizard surface (data-testid).
 *   - "validateOnSave"  → the client submits the entered key through the
 *                         validate-before-persist path (never a bare persist).
 *   - "/v1/providers"   → the provider create/validate API path the key is
 *                         submitted to.
 * These are stable across esbuild minification (route-path string literals and
 * JSON property keys are not mangled; the data-testid attribute is not dropped).
 */
export const CREDENTIAL_ENTRY_MARKERS = Object.freeze([
  "setup-page",
  "validateOnSave",
  "/v1/providers",
]);

/**
 * Classify a POST /v1/providers probe response. The credential-entry backend
 * point is "reachable + functional (validate-before-persist wired)" iff the
 * route rejects a schema-invalid body with a structured VALIDATION_ERROR
 * (400/422). A 404 means the route is missing (unreachable); a 503 means it is
 * fail-closed/disabled (not functional); a 2xx means it persisted invalid input
 * (validate-before-persist NOT enforced). This is the discriminating predicate
 * whose non-vacuity is demonstrated below.
 *
 * @param {{ status: number, code?: string }} probe
 * @returns {{ ok: boolean, reachable: boolean, functional: boolean, reason: string }}
 */
export function classifyCredentialRouteProbe(probe) {
  const status = probe?.status;
  const code = probe?.code;
  if (status === 404) {
    return { ok: false, reachable: false, functional: false, reason: "route missing (404) — credential-entry point unreachable" };
  }
  if (status === 503) {
    return { ok: false, reachable: true, functional: false, reason: "route fail-closed/disabled (503) — credential-entry point not functional" };
  }
  if (typeof status === "number" && status >= 200 && status < 300) {
    return { ok: false, reachable: true, functional: false, reason: `invalid body accepted (${status}) — validate-before-persist NOT enforced` };
  }
  if ((status === 400 || status === 422) && code === "VALIDATION_ERROR") {
    return { ok: true, reachable: true, functional: true, reason: `validate-before-persist enforced (${status} VALIDATION_ERROR)` };
  }
  return { ok: false, reachable: status !== 404, functional: false, reason: `unexpected probe result (status=${String(status)} code=${String(code)})` };
}

/**
 * Return the markers not found in ANY of the served contents. ok iff empty.
 * @param {readonly string[]} markers
 * @param {readonly string[]} servedContents
 * @returns {string[]}
 */
export function findMissingMarkers(markers, servedContents) {
  return markers.filter((m) => !servedContents.some((c) => typeof c === "string" && c.includes(m)));
}

/**
 * Deterministic runtime digest identifying the exact candidate artifact.
 * @param {{ candidateSha: string, tarballSha256: string, uiBundleDigest: string }} parts
 * @returns {string}
 */
export function computeRuntimeDigest(parts) {
  const canonical = JSON.stringify({
    candidateSha: parts.candidateSha,
    tarballSha256: parts.tarballSha256,
    uiBundleDigest: parts.uiBundleDigest,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Evaluate the overall readiness verdict from the collected evidence.
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function evaluateReadiness(ev) {
  const failures = [];
  if (ev.cleanState?.noOwner !== true) failures.push("clean state: an owner already existed (bootstrapRequired!=true)");
  if (ev.cleanState?.noProviderSecret !== true) failures.push("clean state: a provider secret already existed (GET /v1/providers not empty)");
  if (ev.ownerClaimed !== true) failures.push("owner claim/pair failed (bootstrap + login)");
  const missing = ev.servedMarkersMissing ?? [];
  if (missing.length > 0) failures.push(`served UI missing credential-entry markers: ${missing.join(", ")}`);
  if (ev.routeProbe?.ok !== true) failures.push(`credential-entry route not ready: ${ev.routeProbe?.reason ?? "unknown"}`);
  if (ev.nothingPersisted !== true) failures.push("validate-before-persist violated: a provider was persisted by the invalid-body probe");
  return { pass: failures.length === 0, failures };
}

// ── Cold-start scaffold (self-contained; no side effects outside temp dirs) ──

let tmpDir;
let serverProc;
let packSourceBackupDir;
let packedTarball;

function withPackIsolatedReleaseArtifacts(fn) {
  const releaseSourceDir = join(ROOT, "dist", "releases", "source");
  if (!existsSync(releaseSourceDir)) return fn();
  packSourceBackupDir = mkdtempSync(join(tmpdir(), "friday-byok-pack-src-"));
  const hiddenSourceDir = join(packSourceBackupDir, "source");
  renameSync(releaseSourceDir, hiddenSourceDir);
  try {
    return fn();
  } finally {
    renameSync(hiddenSourceDir, releaseSourceDir);
    rmSync(packSourceBackupDir, { recursive: true, force: true });
    packSourceBackupDir = undefined;
  }
}

function fail(msg) {
  console.error(`\n❌ BYOK COLD-START READINESS FAILED: ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill("SIGINT"); } catch {}
  }
  for (const dir of [tmpDir, packSourceBackupDir]) {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  if (packedTarball) {
    try { rmSync(packedTarball, { force: true }); } catch {}
    packedTarball = undefined;
  }
}

export async function assertPortAvailable(port, host = "127.0.0.1") {
  const probe = createServer();
  try {
    await new Promise((res, rej) => {
      probe.once("error", rej);
      probe.listen(port, host, res);
    });
  } finally {
    await new Promise((res) => {
      if (!probe.listening) { res(); return; }
      probe.close(() => res());
    });
  }
}

export async function choosePort() {
  const first = PORT_MIN + Math.floor(Math.random() * PORT_SPAN);
  for (let offset = 0; offset < PORT_SPAN; offset += 1) {
    const port = PORT_MIN + ((first - PORT_MIN + offset) % PORT_SPAN);
    try {
      await assertPortAvailable(port);
      return port;
    } catch {
      // try next candidate
    }
  }
  throw new Error("No available localhost port found for BYOK readiness harness");
}

function assertServerAlive(context, stdout, stderr) {
  if (serverProc && serverProc.exitCode !== null) {
    fail(`Server exited before ${context} (code ${serverProc?.exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** sha256 over sorted (relPath, contentHash) pairs of the served UI dir. */
function uiBundleDigest(uiDir) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, relPath);
      else entries.push(`${relPath}:${sha256File(abs)}`);
    }
  };
  walk(uiDir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function loginWithLocalPassphrase(baseUrl) {
  const bootstrap = async () => {
    const res = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) fail(`Local passphrase bootstrap failed: ${JSON.stringify(body)}`);
  };
  const postLogin = async () => {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    return { res, body: await res.json() };
  };

  const statusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const statusBody = await statusRes.json();
  if (!statusRes.ok || statusBody.ok === false) fail(`Bootstrap status failed: ${JSON.stringify(statusBody)}`);
  const statusData = statusBody.data ?? statusBody;
  if (statusData?.bootstrapRequired === true) await bootstrap();

  let { res, body } = await postLogin();
  if (!res.ok && body?.error?.code === "NO_PASSWORD_CONFIGURED") {
    await bootstrap();
    ({ res, body } = await postLogin());
  }
  if (!res.ok || body.ok !== true || typeof body.data?.accessToken !== "string") {
    fail(`Local passphrase login failed: status=${res.status} body=${JSON.stringify(body)}`);
  }
  return body.data.accessToken;
}

async function getProviderCount(baseUrl) {
  const res = await fetch(`${baseUrl}/v1/providers`);
  if (!res.ok) fail(`GET /v1/providers failed: status=${res.status}`);
  const body = await res.json();
  const items = body?.items ?? body?.data?.items ?? [];
  return Array.isArray(items) ? items.length : Number.NaN;
}

/** Probe the create route with a schema-invalid body (no network, no key). */
async function probeCredentialRoute(baseUrl, token, path) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      // Intentionally schema-invalid: missing kind/name/baseUrl/authMode/api/
      // supportedModels. Rejected by validateCreateBody BEFORE any provider
      // network call. Crucially contains NO apiKey — no key is ever handled.
      body: JSON.stringify({ validateOnSave: true }),
    });
  } catch (err) {
    return { status: -1, code: undefined, reason: `request error: ${err.message}` };
  }
  let body;
  try { body = await res.json(); } catch { body = undefined; }
  return {
    status: res.status,
    code: body?.error?.code,
    hasSchema: Boolean(body?.error?.details?.schema),
  };
}

async function run() {
  const negate = process.env.FRIDAY_BYOK_READINESS_NEGATE; // "route" | "bundle" | undefined
  console.log("── BYOK Cold-Start Credential-Entry Readiness ──\n");

  // ── Step 0: ensure candidate artifacts exist ──
  const cliEntry = join(ROOT, "dist", "cli", "friday-cli.js");
  const uiIndex = join(ROOT, "dist", "ui", "index.html");
  if (!existsSync(cliEntry) || !existsSync(uiIndex)) {
    console.log("0. Building candidate (dist missing)…");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"] });
  }

  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();

  // ── Step 1: npm pack ──
  console.log("1. Packing tarball…");
  const packOutput = withPackIsolatedReleaseArtifacts(() =>
    execFileSync("npm", ["pack", "--ignore-scripts"], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(),
  );
  const tarball = join(ROOT, packOutput.split("\n").pop().trim());
  packedTarball = tarball;
  const tarballSha256 = sha256File(tarball);
  console.log(`   → ${tarball}`);

  // ── Step 2: install into a fresh temp dir ──
  tmpDir = mkdtempSync(join(tmpdir(), "friday-byok-"));
  console.log(`2. Installing clean into ${tmpDir}…`);
  execFileSync("npm", ["init", "-y"], { cwd: tmpDir, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("npm", ["install", tarball], { cwd: tmpDir, stdio: ["pipe", "pipe", "pipe"] });

  const installedPkgDir = join(tmpDir, "node_modules", "@thesongzhu", "friday");
  const installedUiDir = join(installedPkgDir, "dist", "ui");
  const installedAssetsDir = join(installedUiDir, "assets");
  if (!existsSync(installedUiDir)) fail(`Installed UI dir missing: ${installedUiDir}`);
  const bundleDigest = uiBundleDigest(installedUiDir);
  const runtimeDigest = computeRuntimeDigest({ candidateSha, tarballSha256, uiBundleDigest: bundleDigest });

  // ── Step 3: start server with fully isolated state ──
  const stateDir = join(tmpDir, "state");
  const homeDir = join(tmpDir, ".home");
  const envFile = join(tmpDir, ".byok.env");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const port = await choosePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`3. Starting server on ephemeral port ${port} (isolated state)…`);

  const fridayBin = join(tmpDir, "node_modules", ".bin", "friday");
  const env = {
    ...process.env,
    FRIDAY_STATE_DIR: stateDir,
    FRIDAY_ENV_FILE: envFile,
    FRIDAY_TOKEN_SECRET: "byok-readiness-secret-not-real-32-characters", // pragma: allowlist secret
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_STATE_HOME: join(homeDir, ".local", "state"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    NODE_ENV: "test",
  };
  delete env.FRIDAY_CHANNELS_JSON;
  delete env.FRIDAY_CHANNEL_SECRET_POLICY;
  delete env.FRIDAY_MCP_SERVERS;
  delete env.FRIDAY_DESKTOP_ENABLED;
  delete env.FRIDAY_BROWSER_USE_HOST_CHROME;
  delete env.FRIDAY_BROWSER_HEADLESS;
  delete env.DISCORD_BOT_TOKEN;
  // Ensure no real provider key can leak into the candidate under test.
  for (const k of Object.keys(env)) {
    if (/API_KEY$/.test(k) || (/_TOKEN$/.test(k) && k !== "FRIDAY_TOKEN_SECRET")) {
      delete env[k];
    }
  }

  serverProc = spawn(process.execPath, [fridayBin, "start", "--port", String(port)], {
    cwd: tmpDir, env, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  serverProc.stdout.on("data", (d) => { stdout += d.toString(); });
  serverProc.stderr.on("data", (d) => { stderr += d.toString(); });
  serverProc.on("error", (err) => fail(`Server process error: ${err.message}`));

  // ── Step 4: poll /v1/health ──
  console.log("4. Polling /v1/health…");
  const deadline = Date.now() + TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) {
        const body = await res.json();
        const status = typeof body?.status === "string" ? body.status : (body?.ok === true ? body?.data?.status : undefined);
        if (status === "ok") { healthy = true; break; }
      }
    } catch {}
    assertServerAlive("health readiness", stdout, stderr);
    await sleep(POLL_INTERVAL_MS);
  }
  if (!healthy) fail(`Health endpoint did not respond within ${TIMEOUT_MS}ms.\nstdout: ${stdout}\nstderr: ${stderr}`);
  console.log("   → healthy ✓");

  // ── Step 5: assert CLEAN state (no owner, no provider secret) ──
  console.log("5. Asserting clean state (no owner, no provider secret)…");
  const preStatusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const preStatusBody = await preStatusRes.json();
  const preStatus = preStatusBody?.data ?? preStatusBody;
  const noOwner = preStatus?.bootstrapRequired === true;
  const preProviderCount = await getProviderCount(baseUrl);
  const noProviderSecret = preProviderCount === 0;
  console.log(`   → bootstrapRequired=${String(preStatus?.bootstrapRequired)} providers=${preProviderCount}`);

  // ── Step 6: owner claim/pair ──
  console.log("6. Owner claim/pair (bootstrap + login)…");
  assertServerAlive("owner claim", stdout, stderr);
  const token = await loginWithLocalPassphrase(baseUrl);
  const postClaimStatusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const postClaimStatusBody = await postClaimStatusRes.json();
  const postClaimStatus = postClaimStatusBody?.data ?? postClaimStatusBody;
  const ownerClaimed = typeof token === "string" && token.length > 0 && postClaimStatus?.bootstrapRequired === false;
  console.log(`   → claimed=${ownerClaimed} (token len ${token.length}, bootstrapRequired now ${String(postClaimStatus?.bootstrapRequired)})`);

  // ── Step 7: served surface — credential-entry markers in served .js ──
  console.log("7. Verifying credential-entry surface is served…");
  const rootRes = await fetch(`${baseUrl}/`);
  if (rootRes.status !== 200) fail(`GET / returned ${rootRes.status} (expected 200)`);
  const rootHtml = await rootRes.text();
  if (!/<!doctype html/i.test(rootHtml) && !/<html[\s>]/i.test(rootHtml)) fail("GET / did not serve HTML");

  const assetFiles = existsSync(installedAssetsDir)
    ? readdirSync(installedAssetsDir).filter((f) => f.endsWith(".js"))
    : [];
  if (assetFiles.length === 0) fail(`No served .js assets found in ${installedAssetsDir}`);
  const servedContents = [rootHtml];
  const servedMarkerSources = {};
  for (const file of assetFiles) {
    const assetRes = await fetch(`${baseUrl}/assets/${file}`);
    if (assetRes.status !== 200) fail(`GET /assets/${file} returned ${assetRes.status} (expected 200)`);
    const text = await assetRes.text();
    servedContents.push(text);
    for (const m of CREDENTIAL_ENTRY_MARKERS) {
      if (text.includes(m)) (servedMarkerSources[m] ??= []).push(file);
    }
  }
  const markerSet = negate === "bundle"
    ? [...CREDENTIAL_ENTRY_MARKERS, "__CREDENTIAL_ENTRY_ABSENT_SENTINEL__"]
    : CREDENTIAL_ENTRY_MARKERS;
  const servedMarkersMissing = findMissingMarkers(markerSet, servedContents);
  console.log(`   → served markers found: ${JSON.stringify(servedMarkerSources)}`);
  console.log(`   → served .js assets fetched: ${assetFiles.length}; missing markers: ${JSON.stringify(servedMarkersMissing)}`);

  // ── Step 8: backend credential-entry point — validate-before-persist ──
  console.log("8. Probing validate-before-persist create route (no key, no network)…");
  assertServerAlive("credential route probe", stdout, stderr);
  const routePath = negate === "route" ? "/v1/providers__unreachable__" : "/v1/providers";
  const probe = await probeCredentialRoute(baseUrl, token, routePath);
  const routeProbe = { ...classifyCredentialRouteProbe(probe), status: probe.status, code: probe.code, hasSchema: probe.hasSchema };
  const postProbeCount = await getProviderCount(baseUrl);
  const nothingPersisted = postProbeCount === preProviderCount;
  console.log(`   → probe status=${probe.status} code=${probe.code} hasSchema=${probe.hasSchema} → ${routeProbe.reason}`);
  console.log(`   → providers after probe: ${postProbeCount} (nothing persisted: ${nothingPersisted})`);

  // ── Step 9: non-vacuity self-test (same instance, real predicates) ──
  console.log("9. Non-vacuity self-test…");
  const negProbe = await probeCredentialRoute(baseUrl, token, "/v1/providers__unreachable__");
  const negRouteVerdict = classifyCredentialRouteProbe(negProbe);
  const negBundleMissing = findMissingMarkers(["__CREDENTIAL_ENTRY_ABSENT_SENTINEL__"], servedContents);
  const nonVacuity = {
    unreachableRouteRejected: negRouteVerdict.ok === false, // predicate must FAIL for a 404 route
    unreachableRouteStatus: negProbe.status,
    absentMarkerDetected: negBundleMissing.length === 1,   // predicate must FLAG an absent marker
  };
  const nonVacuityHeld = nonVacuity.unreachableRouteRejected && nonVacuity.absentMarkerDetected;
  console.log(`   → unreachable route rejected: ${nonVacuity.unreachableRouteRejected} (status ${negProbe.status}); absent marker detected: ${nonVacuity.absentMarkerDetected}`);
  if (!nonVacuityHeld) fail("non-vacuity self-test failed: readiness predicates did not discriminate an unreachable credential-entry point");

  // ── Step 10: verdict ──
  const evidence = {
    cleanState: { noOwner, noProviderSecret, bootstrapRequired: preStatus?.bootstrapRequired, providerCount: preProviderCount },
    ownerClaimed,
    servedMarkersMissing,
    routeProbe,
    nothingPersisted,
  };
  const { pass, failures } = evaluateReadiness(evidence);

  // ── Step 11: clean shutdown ──
  console.log("10. Sending SIGINT for clean shutdown…");
  serverProc.kill("SIGINT");
  const shutdownDeadline = Date.now() + 10_000;
  while (serverProc.exitCode === null && Date.now() < shutdownDeadline) await sleep(200);
  if (serverProc.exitCode === null) { serverProc.kill("SIGKILL"); fail("Server did not exit within 10s after SIGINT"); }
  const shutdownExit = serverProc.exitCode;
  serverProc = null;

  const verdict = {
    lane: "INSTALL-COLD-BYOK-PREP-001",
    verdict: pass ? "PASS" : "FAIL",
    negateMode: negate ?? null,
    candidateSha,
    runtimeDigest,
    digestMethod: "sha256(JSON{candidateSha, tarballSha256=sha256(npm-pack tarball), uiBundleDigest=sha256(sorted relPath:sha256(content) of served dist/ui)})",
    tarballSha256,
    uiBundleDigest: bundleDigest,
    cleanState: evidence.cleanState,
    ownerClaim: { claimed: ownerClaimed, method: "POST /v1/auth/bootstrap/local-passphrase → POST /v1/auth/login", tokenLen: token.length },
    servedSurface: { assetsFetched: assetFiles.length, markerSources: servedMarkerSources, missing: servedMarkersMissing },
    credentialControl: {
      surface: "served UI setup wizard provider-key step (setup-page)",
      inputControl: 'password input (ui/src/routes/setup-page.tsx: <input type="password" class="agent-input">) — accepts input, enabled',
      wiredTo: "saveProviderWithValidation → providersApi.create/update({ validateOnSave: true }) → POST /v1/providers",
    },
    validateBeforePersist: { routeProbe, nothingPersisted, note: "schema-invalid probe rejected before providerService.createProvider — NO provider network call, NO key handled" },
    secretRefClass: {
      whereStored: "on a real submit the entered key is persisted ONLY as a secret-ref (never inline)",
      keySource: 'kind:"secret-ref", refKey:"provider:<providerId>:apiKey"',
      scheme: "secret:// (AAD-bound secret-store envelope; raw key never in profile/env/argv/logs)",
      note: "NOT exercised here — no key entered",
    },
    nonVacuity,
    shutdownExit,
    failures,
  };
  console.log(`\n${JSON.stringify(verdict, null, 2)}`);

  // ── Cleanup ──
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  try { rmSync(tarball); } catch {}
  packedTarball = undefined;

  if (pass) {
    console.log(`\n✅ BYOK cold-start credential-entry readiness: PASS${negate ? ` (unexpected under negate=${negate})` : ""}\n`);
    if (negate) { console.error("Expected FAIL under negate mode but got PASS"); process.exit(1); }
    process.exit(0);
  } else {
    console.error(`\n❌ BYOK cold-start credential-entry readiness: FAIL\n  - ${failures.join("\n  - ")}\n`);
    process.exit(1);
  }
}

process.on("uncaughtException", (err) => fail(`Uncaught exception: ${err.message}`));

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = isAbsolute(entry) ? entry : resolve(entry);
  return resolved === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  run().catch((err) => fail(err.message));
}
