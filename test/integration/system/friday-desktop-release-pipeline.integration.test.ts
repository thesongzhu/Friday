import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

type ExecFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

async function writeFileWithParents(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function createFixtureRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-desktop-release-pipeline-"));
  await writeFileWithParents(root, "package.json", JSON.stringify({
    name: "friday-fixture",
    version: "1.0.0",
    scripts: {
      "check:companion:release-env": "bash scripts/ops/check-friday-companion-release-env.sh",
      "check:client-ship-gate": "node scripts/ops/check-friday-desktop-release-pipeline.mjs",
      "build:companion:native": "bash scripts/ops/build-friday-companion-app.sh",
      "build:hub-console:native": "bash scripts/ops/build-friday-hub-console-app.sh",
      "build:ios:sim": "bash apps/friday-ios/build-sim.sh",
      "build:android:emu": "bash apps/friday-android/build-emu.sh",
      "build:companion:dmg": "bash scripts/ops/build-friday-companion-dmg.sh",
      "build:companion:appcast": "bash scripts/ops/build-friday-sparkle-appcast.sh",
      "publish:homebrew:cask": "bash scripts/ops/publish-friday-homebrew-cask.sh",
      "release:manifest": "node scripts/ops/write-friday-release-manifest.mjs",
      "release:companion:local": "bash scripts/ops/release-friday-companion-app.sh",
      "release:companion:notarize": "FRIDAY_MACOS_RELEASE_MODE=notarize bash scripts/ops/release-friday-companion-app.sh",
      "verify:hub-console:native": "bash scripts/ops/verify-friday-hub-console-app.sh",
    },
  }, null, 2));

  for (const relativePath of [
    "apps/macos/FridayCompanion/Package.swift",
    "apps/macos/FridayHubConsole/Package.swift",
    "apps/macos/FridayHubConsole/Info.plist",
    "scripts/ops/release-friday-companion-app.sh",
    "scripts/ops/build-friday-hub-console-app.sh",
    "scripts/ops/verify-friday-hub-console-app.sh",
    "apps/friday-ios/build-sim.sh",
    "apps/friday-android/build-emu.sh",
    "scripts/ops/build-friday-companion-dmg.sh",
    "scripts/ops/build-friday-sparkle-appcast.sh",
    "scripts/ops/publish-friday-homebrew-cask.sh",
    "scripts/ops/write-friday-release-manifest.mjs",
    "packaging/homebrew/Casks/friday.rb.template",
    "docs/ops/friday-companion-release-macos.md",
  ]) {
    await writeFileWithParents(root, relativePath, "placeholder\n");
  }

  await writeFileWithParents(
    root,
    "scripts/ops/check-friday-companion-release-env.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"fixture env ok\"\n",
  );
  return root;
}

describe("desktop release pipeline check", () => {
  it("passes when the release pipeline files, scripts, and env checker are present", async () => {
    const repoRoot = await createFixtureRepo();
    const result = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const report = JSON.parse(result.stdout) as {
      status: string;
      summary: { failed: number };
    };

    expect(report.status).toBe("passed");
    expect(report.summary.failed).toBe(0);
  });

  it("fails when a required release input is missing", async () => {
    const repoRoot = await createFixtureRepo();
    await fs.rm(path.join(repoRoot, "packaging", "homebrew", "Casks", "friday.rb.template"));

    const error = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-desktop-release-pipeline.mjs"), repoRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    const report = JSON.parse(error!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ target: string; status: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "packaging/homebrew/Casks/friday.rb.template",
          status: "failed",
        }),
      ]),
    );
  });
});
