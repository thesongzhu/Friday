import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Friday macOS clean-machine evidence writer", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map(async (targetPath) => {
      await fs.rm(targetPath, { recursive: true, force: true });
    }));
  });

  it("writes a complete evidence record from the release record", async () => {
    const repoRoot = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-macos-evidence-"));
    cleanupPaths.push(tempDir);

    const releaseRecordPath = path.join(tempDir, "FridayCompanion.release.json");
    const evidencePath = path.join(tempDir, "macos-15-clean-machine.md");
    await fs.writeFile(releaseRecordPath, `${JSON.stringify({
      releaseMode: "local",
      appVersion: "9.9.9",
      appDir: "/Applications/FridayCompanion.app",
      archivePath: "/tmp/FridayCompanion.zip",
      dmgReleasePath: "/tmp/FridayCompanion.dmg",
      manifestJsonPath: "/tmp/Friday.release-manifest.json",
      homebrewCaskPath: "/tmp/friday.rb",
    }, null, 2)}\n`, "utf8");

    const scriptPath = path.join(repoRoot, "scripts/ops/write-friday-macos-clean-machine-evidence.sh");
    const result = await execFileAsync("bash", [scriptPath, repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FRIDAY_MACOS_SMOKE_RELEASE_RECORD_PATH: releaseRecordPath,
        FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH: evidencePath,
        FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET: "macos-15-vm-01",
        FRIDAY_MACOS_SMOKE_OPERATOR_CONSOLE_HEALTH: "healthy",
        FRIDAY_MACOS_SMOKE_LAUNCHD_STATUS: "healthy",
        FRIDAY_MACOS_SMOKE_PERMISSION_STATUS: "granted",
        FRIDAY_MACOS_SMOKE_PASSKEY_STATUS: "completed",
        FRIDAY_MACOS_SMOKE_REMOTE_STATUS: "completed",
        FRIDAY_MACOS_SMOKE_RECOVERY_STATUS: "completed",
        FRIDAY_MACOS_SMOKE_UNINSTALL_STATUS: "completed",
        FRIDAY_MACOS_SMOKE_STATUS: "complete",
        FRIDAY_MACOS_SMOKE_NOTES: "beta smoke executed on clean VM",
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.stdout.trim()).toBe(evidencePath);

    const contents = await fs.readFile(evidencePath, "utf8");
    expect(contents).toContain("Target: macos-15-vm-01");
    expect(contents).toContain("Release mode: local");
    expect(contents).toContain("App version: 9.9.9");
    expect(contents).toContain("Release artifact: /tmp/FridayCompanion.dmg");
    expect(contents).toContain("Operator Console health: healthy");
    expect(contents).toContain("Status: complete");
  });
});
