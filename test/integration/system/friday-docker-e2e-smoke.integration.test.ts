import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

type ExecFailure = Error & {
  code?: number;
  stderr?: string;
};

describe("docker e2e smoke script", () => {
  it("exits with a blocker when docker is unavailable", async () => {
    const tempBin = await fs.mkdtemp(path.join(os.tmpdir(), "friday-no-docker-bin-"));
    const error = await execFileAsync(
      "/bin/bash",
      [path.join(process.cwd(), "scripts/ci/docker-e2e-smoke.sh")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: tempBin,
          FRIDAY_DOCKER_SMOKE_LAYER: "runtime",
        },
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe(78);
    expect(error?.stderr ?? "").toContain("[docker-e2e][blocker] docker is not installed or not on PATH");
  });
});
