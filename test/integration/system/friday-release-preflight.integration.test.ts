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

describe("Friday release preflight", () => {
  it("fails when FRIDAY_RELEASE_TAG is missing", async () => {
    const error = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/run-friday-release-preflight.mjs"), process.cwd()],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_RELEASE_TAG: "",
        },
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    expect(error?.stderr ?? "").toContain("FRIDAY_RELEASE_TAG is required");
  });

  it("passes when tag matches package.json and ci-public release inputs are present", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-release-preflight-"));
    const evidenceRoot = path.join(tempRoot, "evidence");
    const artifactDir = path.join(tempRoot, "artifacts");

    await fs.mkdir(evidenceRoot, { recursive: true });

    for (const fileName of [
      "macos-15-clean-machine.md",
      "ios-latest-device-smoke.md",
      "android-latest-device-smoke.md",
      "windows-11-clean-machine.md",
    ]) {
      await fs.writeFile(path.join(evidenceRoot, fileName), "# Evidence\n\nStatus: complete\n", "utf8");
    }

    const result = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/run-friday-release-preflight.mjs"), process.cwd()],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_RELEASE_TAG: `v${pkg.version}`,
          FRIDAY_CROSS_PLATFORM_EVIDENCE_ROOT: evidenceRoot,
          FRIDAY_RELEASE_PREFLIGHT_ARTIFACT_DIR: artifactDir,
          FRIDAY_MACOS_CODESIGN_IDENTITY: "Developer ID Application: Friday Test (TEAMID1234)",
          FRIDAY_MACOS_NOTARY_PROFILE: "friday-test-notary",
          FRIDAY_MACOS_SPARKLE_PRIVATE_KEY: "sparkle-private-key",
          FRIDAY_MACOS_SPARKLE_PUBLIC_KEY: "sparkle-public-key",
          FRIDAY_MACOS_APPCAST_BASE_URL: "https://example.test/appcast",
          FRIDAY_HOMEBREW_TAP_REPO: "thesongzhu/homebrew-friday",
          FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN: "homebrew-token",
          FRIDAY_IOS_APPLE_TEAM_ID: "UHDY2275L5",
          FRIDAY_IOS_BUNDLE_ID: "com.friday.remote",
          FRIDAY_IOS_APP_STORE_CONNECT_KEY_ID: "43GC2MUBSB",
          FRIDAY_IOS_APP_STORE_CONNECT_ISSUER_ID: "1ff5bcbd-46d2-48a5-a3c5-59d226ffb607",
          FRIDAY_IOS_APP_STORE_CONNECT_PRIVATE_KEY_PATH: "/tmp/AuthKey.p8",
          FRIDAY_ANDROID_APPLICATION_ID: "com.friday.remote",
          FRIDAY_ANDROID_KEYSTORE_PATH: "/tmp/android.keystore",
          FRIDAY_ANDROID_KEYSTORE_PASSWORD: "android-store-pass",
          FRIDAY_ANDROID_KEY_ALIAS: "friday-upload",
          FRIDAY_ANDROID_KEY_PASSWORD: "android-key-pass",
          FRIDAY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON: "/tmp/play-service-account.json",
          FRIDAY_WINDOWS_CODESIGN_PFX_PATH: "/tmp/windows-signing.pfx",
          FRIDAY_WINDOWS_CODESIGN_PFX_PASSWORD: "windows-pass",
          FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET: "macos-vm-01",
          FRIDAY_CROSS_PLATFORM_IOS_SMOKE_TARGET: "iphone-remote-01",
          FRIDAY_CROSS_PLATFORM_ANDROID_SMOKE_TARGET: "android-remote-01",
          FRIDAY_CROSS_PLATFORM_WINDOWS_SMOKE_TARGET: "windows-vm-01",
        },
      },
    );

    const report = JSON.parse(
      await fs.readFile(path.join(artifactDir, "report.json"), "utf8"),
    ) as { status: string; tag: string; packageVersion: string };

    expect(JSON.parse(result.stdout).status).toBe("passed");
    expect(report).toMatchObject({
      status: "passed",
      tag: `v${pkg.version}`,
      packageVersion: pkg.version,
    });
  });
});
