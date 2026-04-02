import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";

import {
  closeWritableStream,
  createLedger,
  persistLedger,
  runStep,
  stopManagedChildProcess,
} from "../../../scripts/e2e/run-friday-closure.mjs";
import { FRIDAY_CLOSURE_STATUSES } from "../../../scripts/e2e/friday-closure-lib.mjs";

describe("run-friday-closure helpers", () => {
  it("closeWritableStream flushes and closes a write stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-stream-"));
    const filePath = join(dir, "stream.log");
    const stream = fs.createWriteStream(filePath, { flags: "w" });
    stream.write("hello");
    stream.write(" world");

    await closeWritableStream(stream, 2_000);

    expect(readFileSync(filePath, "utf8")).toBe("hello world");
    expect(stream.writableEnded || stream.closed || stream.destroyed).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("stopManagedChildProcess escalates to SIGKILL when a child ignores SIGTERM", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ], {
      stdio: "ignore",
    });

    await stopManagedChildProcess(child, { graceMs: 150, forceKillMs: 150 });

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("runStep persists an in-progress active step before completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-ledger-"));
    const paths = {
      runId: "test-run",
      root: dir,
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
      logs: join(dir, "logs"),
      exports: join(dir, "exports"),
      responses: join(dir, "responses"),
      transcripts: join(dir, "transcripts"),
    };
    for (const value of Object.values(paths)) {
      if (typeof value === "string") {
        fs.mkdirSync(value, { recursive: true });
      }
    }

    const ledger = createLedger(paths);
    persistLedger(ledger);

    let runningSnapshot = null;
    await runStep(ledger, {
      id: "local.backstop.release-verify",
      stage: "local.backstop",
      description: "Run npm run release:verify as a closure backstop",
    }, async () => {
      runningSnapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
      return { status: FRIDAY_CLOSURE_STATUSES.PASS };
    });

    expect(runningSnapshot?.activeStep?.id).toBe("local.backstop.release-verify");
    expect(runningSnapshot?.entries?.at(-1)?.status).toBe(FRIDAY_CLOSURE_STATUSES.RUNNING);

    const finalSnapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    expect(finalSnapshot.activeStep).toBeNull();
    expect(finalSnapshot.entries.at(-1)?.status).toBe(FRIDAY_CLOSURE_STATUSES.PASS);
    expect(finalSnapshot.entries.at(-1)?.completedAt).toBeTruthy();

    rmSync(dir, { recursive: true, force: true });
  });
});
