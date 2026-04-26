// Boot / kill Friday for the test, capture pid + log.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { LOG_DIR, STATE_DIR, PORT, waitForHealth, log, REPO_ROOT } from "./util.mjs";

export async function bootFriday(opts = {}) {
  if (!existsSync(`${REPO_ROOT}/dist/cli/friday-cli.js`)) {
    throw new Error("dist not built — run npm run build in worktree first");
  }
  const stateDir = opts.stateDir ?? STATE_DIR;
  const port = opts.port ?? PORT;
  const logName = opts.logName ?? `friday-server-${port}.log`;
  const logPath = `${LOG_DIR}/${logName}`;
  const env = {
    ...process.env,
    FRIDAY_STATE_DIR: stateDir,
    FRIDAY_PORT: String(port),
    FRIDAY_HOST: "127.0.0.1",
    NODE_OPTIONS: "--enable-source-maps",
  };
  const out = await import("node:fs").then(fs => fs.openSync(logPath, "a"));
  const child = spawn("node", [`${REPO_ROOT}/dist/cli/friday-cli.js`, "start"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", out, out],
    detached: false,
  });
  log(`[friday-process] booted port=${port} pid=${child.pid} log=${logPath}`);
  await waitForHealthOnPort(port, 60_000);
  return { pid: child.pid, port, logPath, child };
}

async function waitForHealthOnPort(port, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (r.status === 200) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error(`health timeout on port ${port}`);
}

export async function killFriday(pid, sig = "SIGTERM") {
  if (!pid) return;
  try { process.kill(pid, sig); } catch {}
  for (let i = 0; i < 60; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(500);
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}
