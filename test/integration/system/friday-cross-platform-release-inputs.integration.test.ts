import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeIfDarwin = process.platform === "darwin" ? describe : describe.skip;

type ExecFailure = Error & {
  code?: number;
  stderr?: string;
};

async function runCheck(
  envOverrides: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "bash",
    [
      path.join(process.cwd(), "scripts/ops/check-friday-cross-platform-release-inputs.sh"),
      process.cwd(),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...envOverrides,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function writeShim(dirPath: string, name: string, body: string): Promise<void> {
  const filePath = path.join(dirPath, name);
  await fs.writeFile(filePath, body, { mode: 0o755 });
}

describeIfDarwin("cross-platform release input check", () => {
  it("fails when required external inputs and evidence are missing", async () => {
    const error = await runCheck({
      FRIDAY_MACOS_CODESIGN_IDENTITY: "",
      FRIDAY_MACOS_NOTARY_PROFILE: "",
      FRIDAY_MACOS_SPARKLE_PRIVATE_KEY: "",
      FRIDAY_MACOS_SPARKLE_PUBLIC_KEY: "",
      FRIDAY_MACOS_APPCAST_BASE_URL: "",
      FRIDAY_HOMEBREW_TAP_REPO: "",
      FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN: "",
      FRIDAY_IOS_APPLE_TEAM_ID: "",
      FRIDAY_IOS_BUNDLE_ID: "",
      FRIDAY_IOS_APP_STORE_CONNECT_KEY_ID: "",
      FRIDAY_IOS_APP_STORE_CONNECT_ISSUER_ID: "",
      FRIDAY_IOS_APP_STORE_CONNECT_PRIVATE_KEY_PATH: "",
      FRIDAY_ANDROID_APPLICATION_ID: "",
      FRIDAY_ANDROID_KEYSTORE_PATH: "",
      FRIDAY_ANDROID_KEYSTORE_PASSWORD: "",
      FRIDAY_ANDROID_KEY_ALIAS: "",
      FRIDAY_ANDROID_KEY_PASSWORD: "",
      FRIDAY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON: "",
      FRIDAY_WINDOWS_CODESIGN_PFX_PATH: "",
      FRIDAY_WINDOWS_CODESIGN_PFX_PASSWORD: "",
      FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET: "",
      FRIDAY_CROSS_PLATFORM_IOS_SMOKE_TARGET: "",
      FRIDAY_CROSS_PLATFORM_ANDROID_SMOKE_TARGET: "",
      FRIDAY_CROSS_PLATFORM_WINDOWS_SMOKE_TARGET: "",
    }).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe(78);
    expect(error?.stderr ?? "").toContain("Apple Developer ID signing identity configured");
    expect(error?.stderr ?? "").toContain("Sparkle private key configured");
    expect(error?.stderr ?? "").toContain("iOS App Store Connect key ID configured");
    expect(error?.stderr ?? "").toContain("Android keystore path");
    expect(error?.stderr ?? "").toContain("Windows native companion toolchain (dotnet)");
    expect(error?.stderr ?? "").toContain("macOS clean-machine evidence archived");
    expect(error?.stderr ?? "").toContain("iOS smoke evidence archived");
    expect(error?.stderr ?? "").toContain("Android smoke evidence archived");
  });

  it("passes when the release inputs, toolchains, and evidence are all present", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-cross-platform-inputs-"));
    const tempBin = path.join(tempRoot, "bin");
    const evidenceRoot = path.join(tempRoot, "evidence");
    const iosPrivateKeyPath = path.join(tempRoot, "AuthKey.p8");
    const androidKeystorePath = path.join(tempRoot, "android.keystore");
    const androidServiceAccountPath = path.join(tempRoot, "play-service-account.json");
    const windowsPfxPath = path.join(tempRoot, "windows-signing.pfx");

    await fs.mkdir(tempBin, { recursive: true });
    await fs.mkdir(evidenceRoot, { recursive: true });
    await fs.writeFile(iosPrivateKeyPath, "test-ios-key");
    await fs.writeFile(androidKeystorePath, "test-android-keystore");
    await fs.writeFile(androidServiceAccountPath, "{}");
    await fs.writeFile(windowsPfxPath, "test-pfx");

    for (const commandName of ["dotnet", "xcodebuild", "swift", "node"]) {
      await writeShim(tempBin, commandName, "#!/usr/bin/env bash\nexit 0\n");
    }
    await writeShim(
      tempBin,
      "security",
      "#!/usr/bin/env bash\nprintf '  1) ABCDEF1234567890 \"Developer ID Application: Friday Test (TEAMID1234)\"\\n'\n",
    );
    await writeShim(tempBin, "xcrun", "#!/usr/bin/env bash\nexit 0\n");

    const evidenceFiles = [
      "macos-15-clean-machine.md",
      "ios-latest-device-smoke.md",
      "android-latest-device-smoke.md",
      "windows-11-clean-machine.md",
    ];
    for (const fileName of evidenceFiles) {
      await fs.writeFile(path.join(evidenceRoot, fileName), "# Evidence\n\nStatus: complete\n");
    }

    const result = await runCheck({
      PATH: `${tempBin}:${process.env.PATH ?? ""}`,
      FRIDAY_CROSS_PLATFORM_EVIDENCE_ROOT: evidenceRoot,
      FRIDAY_MACOS_CODESIGN_IDENTITY: "Developer ID Application: Friday Test (TEAMID1234)",
      FRIDAY_MACOS_NOTARY_PROFILE: "friday-test-notary",
      FRIDAY_MACOS_SPARKLE_PRIVATE_KEY: "sparkle-private-key", // pragma: allowlist secret
      FRIDAY_MACOS_SPARKLE_PUBLIC_KEY: "sparkle-public-key",
      FRIDAY_MACOS_APPCAST_BASE_URL: "https://example.test/appcast",
      FRIDAY_HOMEBREW_TAP_REPO: "thesongzhu/homebrew-friday",
      FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN: "homebrew-token", // pragma: allowlist secret
      FRIDAY_IOS_APPLE_TEAM_ID: "UHDY2275L5",
      FRIDAY_IOS_BUNDLE_ID: "com.friday.remote",
      FRIDAY_IOS_APP_STORE_CONNECT_KEY_ID: "43GC2MUBSB",
      FRIDAY_IOS_APP_STORE_CONNECT_ISSUER_ID: "1ff5bcbd-46d2-48a5-a3c5-59d226ffb607",
      FRIDAY_IOS_APP_STORE_CONNECT_PRIVATE_KEY_PATH: iosPrivateKeyPath,
      FRIDAY_ANDROID_APPLICATION_ID: "com.friday.remote",
      FRIDAY_ANDROID_KEYSTORE_PATH: androidKeystorePath,
      FRIDAY_ANDROID_KEYSTORE_PASSWORD: "android-store-pass", // pragma: allowlist secret
      FRIDAY_ANDROID_KEY_ALIAS: "friday-upload",
      FRIDAY_ANDROID_KEY_PASSWORD: "android-key-pass", // pragma: allowlist secret
      FRIDAY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON: androidServiceAccountPath,
      FRIDAY_WINDOWS_CODESIGN_PFX_PATH: windowsPfxPath,
      FRIDAY_WINDOWS_CODESIGN_PFX_PASSWORD: "secret", // pragma: allowlist secret
      FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET: "macos-vm-01",
      FRIDAY_CROSS_PLATFORM_IOS_SMOKE_TARGET: "iphone-remote-01",
      FRIDAY_CROSS_PLATFORM_ANDROID_SMOKE_TARGET: "android-remote-01",
      FRIDAY_CROSS_PLATFORM_WINDOWS_SMOKE_TARGET: "windows-vm-01",
    });

    expect(result.stderr).toContain("all cross-platform release inputs are present");
  });
});
