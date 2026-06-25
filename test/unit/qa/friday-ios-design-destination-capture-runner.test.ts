import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = "scripts/ops/friday-ios-design-destination-capture.sh";
const fakeUdid = "11111111-2222-3333-4444-555555555555";

async function writeExecutable(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

describe("friday-ios-design-destination-capture runner", () => {
  it("captures multiple offline destinations with skip-initial-build under set -u", async () => {
    const root = process.cwd();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-ios-capture-runner-"));
    const binDir = path.join(tempRoot, "bin");
    const outDir = path.join(tempRoot, "capture");

    await writeExecutable(path.join(binDir, "xcrun"), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  echo "== Devices =="
  echo "-- iOS Test --"
  echo "    iPhone Test (${fakeUdid}) (Booted)"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  echo "launched $*"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "screenshot" ]; then
  printf 'fake-png-%s\\n' "$5" > "$5"
  exit 0
fi
echo "unexpected xcrun $*" >&2
exit 64
`);

    const { stdout } = await execFileAsync(
      "bash",
      [
        path.join(root, script),
        "--out-dir",
        outDir,
        "--mode",
        "offline-truth",
        "--destinations",
        "home,session",
        "--skip-initial-build",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FRIDAY_IOS_DESIGN_CAPTURE_SETTLE_SECONDS: "0",
        },
      },
    );

    expect(stdout).toContain("PASS - selected iOS design destinations captured.");
    const manifest = JSON.parse(
      await fs.readFile(path.join(outDir, "ios-design-destination-capture-manifest.json"), "utf8"),
    ) as {
      status: string;
      mode: string;
      captures: Array<{ destination: string; status: string; screenshot: string }>;
    };

    expect(manifest.status).toBe("ready");
    expect(manifest.mode).toBe("offline-truth");
    expect(manifest.captures.map((capture) => capture.destination)).toEqual(["home", "session"]);
    await expect(fs.stat(path.join(outDir, "screenshots", "home.png"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outDir, "screenshots", "session.png"))).resolves.toBeTruthy();
  });
});
