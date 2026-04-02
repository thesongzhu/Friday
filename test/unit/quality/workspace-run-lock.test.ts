import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ACTIVE_WORKSPACE_RUN_LOCK_PATH,
  acquireWorkspaceRunLock,
  releaseWorkspaceRunLock,
} from "../../../scripts/quality/workspace-run-lock.mjs";

describe("workspace run lock", () => {
  afterEach(() => {
    rmSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, { force: true });
  });

  it("blocks when another live workspace quality run holds the lock", () => {
    mkdirSync(dirname(ACTIVE_WORKSPACE_RUN_LOCK_PATH), { recursive: true });
    writeFileSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, JSON.stringify({
      pid: process.pid,
      kind: "closeout-final",
      runId: "existing-run",
      startedAt: "2026-04-02T06:10:00.000Z",
    }));

    expect(() => {
      acquireWorkspaceRunLock({
        pid: process.pid + 1_000,
        kind: "closure",
        runId: "next-run",
        startedAt: "2026-04-02T06:11:00.000Z",
      });
    }).toThrow(/Another workspace quality run is already active/);
  });

  it("repairs a stale lock before acquiring a new one", () => {
    mkdirSync(dirname(ACTIVE_WORKSPACE_RUN_LOCK_PATH), { recursive: true });
    writeFileSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, JSON.stringify({
      pid: 999999,
      kind: "closure",
      runId: "stale-run",
      startedAt: "2026-04-02T06:10:00.000Z",
    }));

    let stalePayload = null;
    acquireWorkspaceRunLock({
      pid: process.pid,
      kind: "closeout-final",
      runId: "fresh-run",
      startedAt: "2026-04-02T06:12:00.000Z",
    }, {
      onStaleLock(payload) {
        stalePayload = payload;
      },
    });

    const lockPayload = JSON.parse(readFileSync(ACTIVE_WORKSPACE_RUN_LOCK_PATH, "utf8"));
    expect(stalePayload?.runId).toBe("stale-run");
    expect(lockPayload.runId).toBe("fresh-run");

    releaseWorkspaceRunLock({ runId: "fresh-run" });
  });
});
