import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Friday release manifest generator", () => {
  it("renders the release manifest and Homebrew cask from artifact metadata", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-release-manifest-"));

    await fs.mkdir(path.join(repoRoot, "dist", "releases", "macos"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "dist", "releases", "source"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "dist", "releases", "channels"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "packaging", "homebrew", "Casks"), { recursive: true });

    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ version: "9.9.9" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "packaging", "homebrew", "Casks", "friday.rb.template"),
      [
        'cask "friday" do',
        '  version "{{VERSION}}"',
        '  sha256 "{{SHA256}}"',
        '  url "{{URL}}"',
        '  app "FridayCompanion.app"',
        "end",
        "",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(repoRoot, "dist", "releases", "macos", "FridayCompanion-9.9.9-macos-arm64.dmg.artifact.json"),
      JSON.stringify({
        platform: "macos",
        kind: "dmg",
        arch: "arm64",
        displayName: "Friday Companion macOS DMG",
        fileName: "FridayCompanion-9.9.9-macos-arm64.dmg",
        relativePath: "dist/releases/macos/FridayCompanion-9.9.9-macos-arm64.dmg",
        availability: "available",
        sha256: "abc123",
        installSummary: "Install the DMG.",
        signingStatus: "signed",
        notarizationStatus: "completed",
        runtimeKind: "swift_app",
        downloadUrl: "https://example.test/releases/FridayCompanion-9.9.9-macos-arm64.dmg",
        notes: ["macOS shipping artifact"],
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "dist", "releases", "macos", "appcast.xml.artifact.json"),
      JSON.stringify({
        platform: "macos",
        kind: "sparkle_appcast",
        arch: "all",
        displayName: "Friday Sparkle appcast",
        fileName: "appcast.xml",
        relativePath: "dist/releases/macos/appcast.xml",
        availability: "available",
        sha256: "ghi789",
        installSummary: "Serve the appcast.",
        signingStatus: "sparkle_eddsa",
        notarizationStatus: "not_applicable",
        runtimeKind: "swift_app",
        downloadUrl: "https://example.test/appcast/appcast.xml",
        notes: ["Sparkle feed"],
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "dist", "releases", "source", "friday-9.9.9.tgz.artifact.json"),
      JSON.stringify({
        platform: "source",
        kind: "tgz",
        arch: "all",
        displayName: "Friday npm package",
        fileName: "friday-9.9.9.tgz",
        relativePath: "dist/releases/source/friday-9.9.9.tgz",
        availability: "available",
        sha256: "def456",
        installSummary: "npm install -g @thesongzhu/friday@9.9.9",
        signingStatus: "npm_registry",
        runtimeKind: "node_hub",
        downloadUrl: "https://example.test/releases/friday-9.9.9.tgz",
        notes: ["Developer fallback"],
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "dist", "releases", "channels", "sparkle.json"),
      JSON.stringify({
        channel: "sparkle",
        availability: "generated",
        appcastUrl: "https://example.test/appcast/appcast.xml",
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "dist", "releases", "channels", "homebrew.json"),
      JSON.stringify({
        channel: "homebrew",
        availability: "published",
        tapRepo: "mxclip/homebrew-friday",
        rawUrl: "https://raw.githubusercontent.com/mxclip/homebrew-friday/main/Casks/friday.rb",
      }, null, 2),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/write-friday-release-manifest.mjs")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_RELEASE_REPO_ROOT: repoRoot,
          FRIDAY_RELEASE_TAG: "v9.9.9",
          FRIDAY_RELEASE_DOWNLOAD_BASE_URL: "https://example.test/releases",
        },
      },
    );

    const manifestPath = stdout.trim();
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      version: string;
      platforms: Array<{ platform: string; availability: string; artifacts: Array<{ kind: string }> }>;
      channels: Record<string, { availability: string; installCommand?: string; tapRepo?: string; appcastUrl?: string }>;
      developerFallbacks: Array<{ fileName: string }>;
      currentMilestone: string;
    };
    const caskContents = await fs.readFile(
      path.join(repoRoot, "dist", "releases", "homebrew", "Casks", "friday.rb"),
      "utf8",
    );

    expect(manifest.version).toBe("9.9.9");
    expect(manifest.currentMilestone).toBe("macos_ios_android_windows_agent_os_rollout");
    expect(manifest.channels.sparkle.availability).toBe("generated");
    expect(manifest.channels.sparkle.appcastUrl).toBe("https://example.test/appcast/appcast.xml");
    expect(manifest.channels.homebrew.availability).toBe("published");
    expect(manifest.channels.homebrew.tapRepo).toBe("mxclip/homebrew-friday");
    expect(manifest.channels.npm.installCommand).toBe("npm install -g @thesongzhu/friday");
    expect(manifest.channels.testflight.availability).toBe("planned");
    expect(manifest.channels.playInternal.availability).toBe("planned");
    expect(manifest.platforms.find((entry) => entry.platform === "macos")?.availability).toBe("shipping");
    expect(manifest.platforms.find((entry) => entry.platform === "ios")?.availability).toBe("planned");
    expect(manifest.platforms.find((entry) => entry.platform === "android")?.availability).toBe("planned");
    expect(manifest.platforms.find((entry) => entry.platform === "windows")?.availability).toBe("scaffolded");
    expect(manifest.developerFallbacks.map((artifact) => artifact.fileName)).toContain("friday-9.9.9.tgz");
    expect(caskContents).toContain('version "9.9.9"');
    expect(caskContents).toContain("https://example.test/releases/FridayCompanion-9.9.9-macos-arm64.dmg");
  });
});
