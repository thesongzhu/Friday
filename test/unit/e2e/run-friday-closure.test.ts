import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";

import {
  closeWritableStream,
  stopManagedChildProcess,
} from "../../../scripts/e2e/run-friday-closure.mjs";

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
});
