#!/usr/bin/env node

/**
 * Install Smoke Test — MECHANISM 2
 *
 * Verifies that `npm pack` produces a working tarball:
 *   1. Pack the project
 *   2. Install the tarball in a fresh temp directory
 *   3. Verify `friday --help` prints usage
 *   4. Start the server with isolated state
 *   5. Poll GET /v1/health until success
 *   6. Bootstrap a local passphrase when needed and log in with it
 *   7. GET / — verifies the UI bundle is served from the install location
 *      (regression guard: the CLI must resolve dist/ui relative to the
 *      installed module, not relative to process.cwd())
 *   8. Send SIGINT, verify clean shutdown
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const PORT_MIN = 19_000;
const PORT_SPAN = 1_000;
const LOCAL_PASSPHRASE = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-install-smoke-passphrase-123";

let tmpDir;
let serverProc;
let packSourceBackupDir;
let packedTarball;
// CORE-A round-3 Lane C (finding #4): the packaged Rust agent-run WS server proof.
let rustServerProc;
let rustProofTmpDir;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
function isTrue(value) {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase());
}
// The SecureStore domain-separation tag for the WS X25519 client secret — byte-identical to
// `WS_X25519_SECRET_PURPOSE` in friday-rust-hub-agent-run-ws-client-x25519-secret.ts. The client
// secret is sha256(purpose || masterKey); the Rust enroll bin derives the matching pubkey from the
// SAME master key, so driving the sealed client with this secret is a REAL ECDH handshake.
const RUST_WS_X25519_SECRET_PURPOSE = "friday.rust.agent_run.ws.x25519_secret.v1"; // pragma: allowlist secret

function withPackIsolatedReleaseArtifacts(fn) {
  const releaseSourceDir = join(ROOT, "dist", "releases", "source");
  if (!existsSync(releaseSourceDir)) {
    return fn();
  }

  packSourceBackupDir = mkdtempSync(join(tmpdir(), "friday-pack-src-"));
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
  console.error(`\n❌ SMOKE TEST FAILED: ${msg}`);
  cleanup();
  process.exit(1);
}

export async function assertInstallSmokePortAvailable(port, host = "127.0.0.1") {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, host, resolve);
    });
  } finally {
    await new Promise((resolve) => {
      if (!probe.listening) {
        resolve();
        return;
      }
      probe.close(() => resolve());
    });
  }
}

export async function chooseInstallSmokePort() {
  const first = PORT_MIN + Math.floor(Math.random() * PORT_SPAN);
  for (let offset = 0; offset < PORT_SPAN; offset += 1) {
    const port = PORT_MIN + ((first - PORT_MIN + offset) % PORT_SPAN);
    try {
      await assertInstallSmokePortAvailable(port);
      return port;
    } catch {
      // Try the next candidate instead of letting an existing service satisfy smoke health.
    }
  }
  throw new Error("No available localhost port found for install smoke");
}

function assertServerProcessAlive(context, stdout, stderr) {
  if (serverProc && serverProc.exitCode !== null) {
    fail(
      `Server exited before ${context} (code ${serverProc?.exitCode}).\n` +
      `stdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

function isInstallSmokeEntrypoint() {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  const resolvedEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
  return resolvedEntrypoint === fileURLToPath(import.meta.url);
}

function cleanup() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill("SIGINT");
    } catch {}
  }
  if (rustServerProc && !rustServerProc.killed) {
    try {
      rustServerProc.kill("SIGKILL");
    } catch {}
  }
  if (rustProofTmpDir) {
    try {
      rmSync(rustProofTmpDir, { recursive: true, force: true });
    } catch {}
    rustProofTmpDir = undefined;
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  if (packSourceBackupDir) {
    try {
      rmSync(packSourceBackupDir, { recursive: true, force: true });
    } catch {}
  }
  if (packedTarball) {
    try {
      rmSync(packedTarball, { force: true });
    } catch {}
    packedTarball = undefined;
  }
}

process.on("uncaughtException", (err) => {
  fail(`Uncaught exception: ${err.message}`);
});

async function loginWithLocalPassphrase(baseUrl) {
  async function bootstrapLocalPassphrase() {
    const bootstrapRes = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    const bootstrapBody = await bootstrapRes.json();
    if (!bootstrapRes.ok || bootstrapBody.ok === false) {
      fail(`Local passphrase bootstrap failed: ${JSON.stringify(bootstrapBody)}`);
    }
  }

  async function postLogin() {
    const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    const loginBody = await loginRes.json();
    return { loginRes, loginBody };
  }

  const statusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const statusBody = await statusRes.json();
  if (!statusRes.ok || statusBody.ok === false) {
    fail(`Bootstrap status failed: ${JSON.stringify(statusBody)}`);
  }

  const statusData = statusBody.data ?? statusBody;
  if (statusData?.bootstrapRequired === true) {
    await bootstrapLocalPassphrase();
  }

  let { loginRes, loginBody } = await postLogin();
  if (!loginRes.ok && loginBody?.error?.code === "NO_PASSWORD_CONFIGURED") {
    await bootstrapLocalPassphrase();
    ({ loginRes, loginBody } = await postLogin());
  }
  if (!loginRes.ok || loginBody.ok !== true || typeof loginBody.data?.accessToken !== "string") {
    fail(`Local passphrase login failed: status=${loginRes.status} body=${JSON.stringify(loginBody)}`);
  }
  return loginBody.data.accessToken;
}

async function pollTcpOpen(port, host, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const opened = await new Promise((resolve) => {
      const socket = connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (opened) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

/**
 * CORE-A round-3 Lane C (finding #4): prove the PACKAGED Rust agent-run WS server actually
 * SERVES session create + append — the exact leg a clean install used to 503 on because the
 * server was never packaged/launched. This launches the release-built `hub_agent_run_server`,
 * enrolls THIS host's peer pubkey, and drives session create → append over the REAL compiled
 * sealed ECDH client with NO route flag, NO mock/test seam, and NO TS fallback (a 503 or a
 * failed handshake throws → the smoke fails). It makes NO paid provider call (session create +
 * append are pure Hub `&Db` mutations). The final SIGNED clean-install and a paid LIVE provider
 * turn stay EXTERNAL LEAVES (EXT-MAC-*, EXT-TEXT-PROVIDER-LIVE-EVIDENCE-001).
 *
 * Runs when release bins are prebuilt (rust-core/target/release) OR when
 * FRIDAY_INSTALL_SMOKE_BUILD_RUST=1 (then it cargo-builds them). Otherwise it SKIPS loudly so an
 * env without a Rust toolchain is not silently degraded; set FRIDAY_INSTALL_SMOKE_REQUIRE_RUST=1
 * to make an unavailable server a hard failure.
 */
async function runRustAgentRunSessionProof() {
  console.log("9. Proving the packaged Rust agent-run WS server serves session create + append…");
  const rustCoreDir = join(ROOT, "rust-core");
  const releaseDir = join(rustCoreDir, "target", "release");
  const serverBin = join(releaseDir, "hub_agent_run_server");
  const enrollBin = join(releaseDir, "hub_agent_run_enroll");

  const skip = (reason) => {
    if (isTrue(process.env.FRIDAY_INSTALL_SMOKE_REQUIRE_RUST)) {
      fail(`Rust agent-run proof required but ${reason}`);
    }
    console.log(
      `   → SKIP: ${reason}. Set FRIDAY_INSTALL_SMOKE_BUILD_RUST=1 to build the bins here, ` +
      `or FRIDAY_INSTALL_SMOKE_REQUIRE_RUST=1 to make this a hard failure.`,
    );
  };

  let haveBins = existsSync(serverBin) && existsSync(enrollBin);
  if (!haveBins) {
    if (!existsSync(rustCoreDir)) {
      return skip("rust-core/ is absent in this checkout");
    }
    if (!isTrue(process.env.FRIDAY_INSTALL_SMOKE_BUILD_RUST)) {
      return skip("prebuilt Rust bins are absent");
    }
    console.log("   building hub_agent_run_server + hub_agent_run_enroll (cargo --release)…");
    try {
      execFileSync(
        "cargo",
        ["build", "--release", "--bin", "hub_agent_run_server", "--bin", "hub_agent_run_enroll"],
        { cwd: rustCoreDir, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      fail(`cargo build of the Rust agent-run bins failed: ${err.message}`);
    }
    haveBins = existsSync(serverBin) && existsSync(enrollBin);
    if (!haveBins) {
      fail("cargo build did not produce the expected Rust agent-run bins");
    }
  }

  rustProofTmpDir = mkdtempSync(join(tmpdir(), "friday-rust-proof-"));
  const storeDir = join(rustProofTmpDir, "store");
  const wsRoot = join(rustProofTmpDir, "ws");
  const dbPath = join(rustProofTmpDir, "hub.sqlite");
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(wsRoot, { recursive: true });

  const masterKeyHex = randomBytes(32).toString("hex");
  const owner = "owner:install-smoke";
  const port = await chooseInstallSmokePort();

  // The Rust bins read the SAME master key the client secret derives from; a dummy DeepSeek key
  // satisfies HubRuntime::live's construction (session create/append make NO provider call, so it
  // is never used). EXPLICITLY strip any route/test flags so the proof is flagless by construction.
  const rustEnv = {
    ...process.env,
    FRIDAY_MASTER_KEY: masterKeyHex,
    FRIDAY_DEEPSEEK_API_KEY: "sk-install-smoke-not-real", // pragma: allowlist secret
  };
  delete rustEnv.FRIDAY_ROUTE_AGENT_RUN_VIA_RUST;
  delete rustEnv.FRIDAY_ROUTE_SESSIONS_VIA_RUST;
  delete rustEnv.FRIDAY_HUB_AGENT_RUN_WS_X25519_SECRET_PRESENT;

  // Enroll THIS host's client pubkey into the store the server pins (derived from the master key).
  try {
    execFileSync(enrollBin, ["--store-dir", storeDir], { env: rustEnv, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    fail(`hub_agent_run_enroll failed: ${err.message}`);
  }
  console.log("   → peer pubkey enrolled into the server's SecureStore ✓");

  // Launch the packaged server on the chosen loopback port.
  rustServerProc = spawn(
    serverBin,
    ["--workspace", wsRoot, "--db", dbPath, "--port", String(port), "--owner", owner, "--store-dir", storeDir],
    { env: rustEnv, stdio: ["pipe", "pipe", "pipe"] },
  );
  let rustStderr = "";
  rustServerProc.stdout.on("data", () => {});
  rustServerProc.stderr.on("data", (d) => { rustStderr += d.toString(); });
  rustServerProc.on("error", (err) => fail(`Rust server process error: ${err.message}`));

  const ready = await pollTcpOpen(port, "127.0.0.1", Date.now() + 15_000);
  if (!ready || rustServerProc.exitCode !== null) {
    fail(
      `Packaged Rust agent-run WS server did not listen on 127.0.0.1:${port} ` +
      `(exit ${rustServerProc?.exitCode}).\nstderr: ${rustStderr}`,
    );
  }
  console.log(`   → packaged hub_agent_run_server listening on 127.0.0.1:${port} ✓`);

  // Derive the client X25519 secret exactly as resolveRustAgentRunWsClientX25519Secret does; drive
  // the REAL compiled sealed client (no injected resolver, no fixture) — a genuine ECDH handshake.
  const clientSecret = new Uint8Array(
    createHash("sha256")
      .update(RUST_WS_X25519_SECRET_PURPOSE)
      .update(Buffer.from(masterKeyHex, "hex"))
      .digest(),
  );
  const clientModuleUrl = pathToFileURL(
    join(ROOT, "dist", "api", "mission-spine", "friday-rust-hub-agent-run-ws-sealed-client.js"),
  ).href;
  let mod;
  try {
    mod = await import(clientModuleUrl);
  } catch (err) {
    fail(`Could not import the compiled sealed client (build dist first): ${err.message}`);
  }
  if (typeof mod.createFridayRustHubAgentRunSealedClient !== "function") {
    fail("Compiled sealed client is missing createFridayRustHubAgentRunSealedClient (stale dist?)");
  }
  const client = mod.createFridayRustHubAgentRunSealedClient({
    host: "127.0.0.1",
    port,
    clientSecret,
    timeoutMs: 10_000,
  });
  if (typeof client.createSession !== "function" || typeof client.appendSessionMessage !== "function") {
    fail("Compiled sealed client is missing createSession/appendSessionMessage — rebuild dist (npm run build).");
  }

  const sessionId = "channel:smoke|account:default|chat:install-smoke-1";
  let created;
  try {
    created = await client.createSession({ sessionId, userId: owner, channel: "smoke", chatId: "install-smoke-1" });
  } catch (err) {
    fail(`Session CREATE was not served by Rust (a 503 / TS fallback is a failure): ${err?.code ?? ""} ${err?.message ?? err}`);
  }
  if (created?.truthLabel !== "rust_wired" || created?.sessionId !== sessionId) {
    fail(`Session CREATE returned an unexpected receipt: ${JSON.stringify(created)}`);
  }

  let appended;
  try {
    appended = await client.appendSessionMessage({ sessionId, role: "user", content: "install-smoke session append proof" });
  } catch (err) {
    fail(`Session APPEND was not served by Rust (a 503 / TS fallback is a failure): ${err?.code ?? ""} ${err?.message ?? err}`);
  }
  if (
    appended?.truthLabel !== "rust_wired" ||
    typeof appended?.messageId !== "string" || appended.messageId.length === 0 ||
    typeof appended?.seq !== "number"
  ) {
    fail(`Session APPEND returned an unexpected receipt: ${JSON.stringify(appended)}`);
  }

  console.log(`   → CREATE receipt (Rust-served): ${JSON.stringify(created)}`);
  console.log(`   → APPEND receipt (Rust-served): ${JSON.stringify(appended)}`);
  console.log("   → session create + append served by the packaged Rust server (no flags, no mock, no TS fallback) ✓");

  // Teardown the Rust server + temp state.
  try { rustServerProc.kill("SIGINT"); } catch {}
  const rustShutdownDeadline = Date.now() + 5_000;
  while (rustServerProc.exitCode === null && Date.now() < rustShutdownDeadline) {
    await sleep(100);
  }
  if (rustServerProc.exitCode === null) {
    try { rustServerProc.kill("SIGKILL"); } catch {}
  }
  rustServerProc = null;
  rmSync(rustProofTmpDir, { recursive: true, force: true });
  rustProofTmpDir = null;
}

async function run() {
  console.log("── Install Smoke Test ──\n");

  // ── Step 1: npm pack ──
  console.log("1. Packing tarball…");
  const packOutput = withPackIsolatedReleaseArtifacts(() =>
    execFileSync("npm", ["pack", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(),
  );
  const tarball = join(ROOT, packOutput.split("\n").pop().trim());
  packedTarball = tarball;
  console.log(`   → ${tarball}`);

  // ── Step 2: Install in temp directory ──
  tmpDir = mkdtempSync(join(tmpdir(), "friday-smoke-"));
  console.log(`2. Installing in ${tmpDir}…`);

  execFileSync("npm", ["init", "-y"], {
    cwd: tmpDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  execFileSync("npm", ["install", tarball], {
    cwd: tmpDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // ── Step 3: Verify friday --help ──
  console.log("3. Verifying friday --help…");
  const fridayBin = join(tmpDir, "node_modules", ".bin", "friday");
  let helpOutput;
  try {
    helpOutput = execFileSync(fridayBin, ["--help"], {
      cwd: tmpDir,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // friday --help may exit with non-zero, that's fine if it printed usage
    helpOutput = (err.stdout || "") + (err.stderr || "");
  }

  if (!helpOutput.includes("friday") && !helpOutput.includes("Friday")) {
    fail("friday --help did not produce recognizable output");
  }
  console.log("   → CLI responds ✓");

  // ── Step 4: Start server with isolated state ──
  const stateDir = join(tmpDir, "state");
  const smokeHomeDir = join(tmpDir, ".smoke-home");
  const smokeEnvFile = join(tmpDir, ".smoke.env");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(smokeHomeDir, { recursive: true });
  const port = await chooseInstallSmokePort();

  console.log(`4. Starting server on port ${port}…`);
  const env = {
    ...process.env,
    FRIDAY_STATE_DIR: stateDir,
    FRIDAY_ENV_FILE: smokeEnvFile,
    FRIDAY_TOKEN_SECRET: "smoke-test-secret-not-real-32-characters", // pragma: allowlist secret
    HOME: smokeHomeDir,
    USERPROFILE: smokeHomeDir,
    XDG_STATE_HOME: join(smokeHomeDir, ".local", "state"),
    XDG_CONFIG_HOME: join(smokeHomeDir, ".config"),
    NODE_ENV: "test",
  };
  delete env.FRIDAY_CHANNELS_JSON;
  delete env.FRIDAY_CHANNEL_SECRET_POLICY;
  delete env.FRIDAY_MCP_SERVERS;
  delete env.FRIDAY_DESKTOP_ENABLED;
  delete env.FRIDAY_BROWSER_USE_HOST_CHROME;
  delete env.FRIDAY_BROWSER_HEADLESS;
  delete env.DISCORD_BOT_TOKEN;

  serverProc = spawn(
    process.execPath,
    [fridayBin, "start", "--port", String(port)],
    {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let serverStdout = "";
  let serverStderr = "";
  serverProc.stdout.on("data", (d) => { serverStdout += d.toString(); });
  serverProc.stderr.on("data", (d) => { serverStderr += d.toString(); });

  serverProc.on("error", (err) => {
    fail(`Server process error: ${err.message}`);
  });

  // ── Step 5: Poll /v1/health ──
  console.log("5. Polling /v1/health…");
  const deadline = Date.now() + TIMEOUT_MS;
  let healthy = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (res.ok) {
        const body = await res.json();
        const status =
          typeof body?.status === "string"
            ? body.status
            : (body?.ok === true ? body?.data?.status : undefined);
        if (status === "ok") {
          healthy = true;
          console.log(`   → Health check passed: ${JSON.stringify(body)}`);
          break;
        }
      }
    } catch {
      // Server not ready yet
    }

    assertServerProcessAlive("health readiness", serverStdout, serverStderr);
    await sleep(POLL_INTERVAL_MS);
  }

  if (!healthy) {
    fail(
      `Health endpoint did not respond within ${TIMEOUT_MS}ms.\n` +
      `stdout: ${serverStdout}\nstderr: ${serverStderr}`,
    );
  }

  // ── Step 6: bootstrap + POST /v1/auth/login ──
  console.log("6. Verifying POST /v1/auth/login…");
  assertServerProcessAlive("login verification", serverStdout, serverStderr);
  try {
    const token = await loginWithLocalPassphrase(`http://127.0.0.1:${port}`);
    console.log(`   → Login succeeded with token length ${token.length}`);
  } catch (err) {
    fail(`Login request failed: ${err.message}`);
  }

  // ── Step 7: GET / — UI bundle served from install location ──
  console.log("7. Verifying GET / serves the bundled UI…");
  assertServerProcessAlive("UI bundle verification", serverStdout, serverStderr);
  try {
    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    if (rootRes.status !== 200) {
      fail(`GET / returned status ${rootRes.status} (expected 200)`);
    }
    const rootBody = await rootRes.text();
    const looksLikeHtml =
      /<!doctype html/i.test(rootBody) || /<html[\s>]/i.test(rootBody);
    if (!looksLikeHtml) {
      fail(
        `GET / did not return HTML. First 200 chars: ${rootBody.slice(0, 200)}`,
      );
    }
    console.log("   → UI bundle served ✓");
  } catch (err) {
    fail(`GET / failed: ${err.message}`);
  }

  // ── Step 8: Clean shutdown via SIGINT ──
  console.log("8. Sending SIGINT for clean shutdown…");
  serverProc.kill("SIGINT");

  const shutdownDeadline = Date.now() + 10_000;
  while (serverProc.exitCode === null && Date.now() < shutdownDeadline) {
    await sleep(200);
  }

  if (serverProc.exitCode === null) {
    serverProc.kill("SIGKILL");
    fail("Server did not exit within 10s after SIGINT");
  }

  console.log(`   → Server exited with code ${serverProc.exitCode}`);
  serverProc = null;

  // ── Cleanup ──
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;

  // Clean up tarball
  try { rmSync(tarball); } catch {}
  packedTarball = undefined;

  // ── Step 9: packaged Rust agent-run WS server serves session create + append ──
  await runRustAgentRunSessionProof();

  console.log("\n✅ Install smoke test passed\n");
}

if (isInstallSmokeEntrypoint()) {
  run().catch((err) => fail(err.message));
}
