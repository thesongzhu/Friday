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

import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const LOCAL_PASSPHRASE = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-install-smoke-passphrase-123";

let tmpDir;
let serverProc;
let packSourceBackupDir;

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

function cleanup() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill("SIGINT");
    } catch {}
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

async function run() {
  console.log("── Install Smoke Test ──\n");

  // ── Step 1: npm pack ──
  console.log("1. Packing tarball…");
  const packOutput = withPackIsolatedReleaseArtifacts(() =>
    execSync("npm pack --ignore-scripts", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(),
  );
  const tarball = join(ROOT, packOutput.split("\n").pop().trim());
  console.log(`   → ${tarball}`);

  // ── Step 2: Install in temp directory ──
  tmpDir = mkdtempSync(join(tmpdir(), "friday-smoke-"));
  console.log(`2. Installing in ${tmpDir}…`);

  execSync("npm init -y", {
    cwd: tmpDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  execSync(`npm install "${tarball}"`, {
    cwd: tmpDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // ── Step 3: Verify friday --help ──
  console.log("3. Verifying friday --help…");
  const fridayBin = join(tmpDir, "node_modules", ".bin", "friday");
  let helpOutput;
  try {
    helpOutput = execSync(`"${fridayBin}" --help`, {
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
  const port = 19000 + Math.floor(Math.random() * 1000);

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

    // Check if process exited unexpectedly
    if (serverProc.exitCode !== null) {
      fail(
        `Server exited prematurely (code ${serverProc.exitCode}).\n` +
        `stdout: ${serverStdout}\nstderr: ${serverStderr}`,
      );
    }
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
  try {
    const token = await loginWithLocalPassphrase(`http://127.0.0.1:${port}`);
    console.log(`   → Login succeeded with token length ${token.length}`);
  } catch (err) {
    fail(`Login request failed: ${err.message}`);
  }

  // ── Step 7: GET / — UI bundle served from install location ──
  console.log("7. Verifying GET / serves the bundled UI…");
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

  console.log("\n✅ Install smoke test passed\n");
}

run().catch((err) => fail(err.message));
