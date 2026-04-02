import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKSPACE_RUN_LOCK_DIR = path.join(ROOT, ".friday", "quality-gates");

export const ACTIVE_WORKSPACE_RUN_LOCK_PATH = path.join(WORKSPACE_RUN_LOCK_DIR, ".active-run.json");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireWorkspaceRunLock(lockPayload, options = {}) {
  const { onStaleLock } = options;
  ensureDir(WORKSPACE_RUN_LOCK_DIR);

  while (true) {
    try {
      fs.writeFileSync(
        ACTIVE_WORKSPACE_RUN_LOCK_PATH,
        `${JSON.stringify(lockPayload, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "EEXIST") {
        throw error;
      }

      let activeLock = null;
      try {
        activeLock = JSON.parse(fs.readFileSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, "utf8"));
      } catch {
        fs.rmSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, { force: true });
        continue;
      }

      if (isProcessAlive(activeLock?.pid)) {
        const details = [
          `pid=${String(activeLock.pid)}`,
          activeLock?.kind ? `kind=${String(activeLock.kind)}` : null,
          activeLock?.mode ? `mode=${String(activeLock.mode)}` : null,
          activeLock?.runId ? `runId=${String(activeLock.runId)}` : null,
        ].filter(Boolean).join(" ");
        throw new Error(`Another workspace quality run is already active (${details})`);
      }

      try {
        onStaleLock?.(activeLock);
      } catch {
        // stale-lock repair is best effort only
      }

      fs.rmSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, { force: true });
    }
  }
}

export function releaseWorkspaceRunLock({ runId, pid = process.pid } = {}) {
  try {
    const payload = JSON.parse(fs.readFileSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, "utf8"));
    if (payload?.pid === pid && (!runId || payload?.runId === runId)) {
      fs.rmSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, { force: true });
    }
  } catch {
    // ignore lock cleanup failure
  }
}
