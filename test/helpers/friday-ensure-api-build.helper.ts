import { existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST_STATE_ENTRY = join(REPO_ROOT, "dist", "state", "index.js");
const LOCK_PATH = join(
  tmpdir(),
  `friday-build-api-${createHash("sha1").update(REPO_ROOT).digest("hex")}.lock`,
);
const LOCK_WAIT_TIMEOUT_MS = 180_000;
const LOCK_POLL_INTERVAL_MS = 250;

function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export async function ensureFridayApiBuildForNodeWorkers(): Promise<void> {
  if (existsSync(DIST_STATE_ENTRY)) {
    return;
  }

  await mkdir(dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
  while (!lockHandle) {
    try {
      lockHandle = await open(LOCK_PATH, "wx");
    } catch (error) {
      if (
        !error
        || typeof error !== "object"
        || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }

      if (existsSync(DIST_STATE_ENTRY)) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for API build lock at ${LOCK_PATH}`,
        );
      }
      await delay(LOCK_POLL_INTERVAL_MS);
    }
  }

  try {
    if (existsSync(DIST_STATE_ENTRY)) {
      return;
    }

    const result = spawnSync(getNpmCommand(), ["run", "build:api"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || result.stdout?.trim() || "unknown build failure";
      throw new Error(`Failed to build API artifacts for node workers: ${stderr}`);
    }
    if (!existsSync(DIST_STATE_ENTRY)) {
      throw new Error(`API build completed without ${DIST_STATE_ENTRY}`);
    }
  } finally {
    await lockHandle.close();
    await rm(LOCK_PATH, { force: true });
  }
}
