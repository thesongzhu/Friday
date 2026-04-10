import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeIfDarwin = process.platform === "darwin" ? describe : describe.skip;

type ExecFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

async function runReleaseScript(
  scriptPath: string,
  envOverrides: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bash", [scriptPath, process.cwd()], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...envOverrides,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

describeIfDarwin("Friday native companion release workflow", () => {
  async function createRejectingHomebrewTap(prefix: string): Promise<string> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const workRepo = path.join(tempRoot, "tap-work");
    const remoteRepo = path.join(tempRoot, "tap-remote.git");

    await fs.mkdir(workRepo, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workRepo });
    await fs.writeFile(path.join(workRepo, "README.md"), "# friday tap\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workRepo });
    await execFileAsync("git", ["-c", "user.name=Friday Bot", "-c", "user.email=friday-bot@users.noreply.github.com", "commit", "-m", "init"], { cwd: workRepo });
    await execFileAsync("git", ["clone", "--bare", workRepo, remoteRepo]);
    await execFileAsync("git", ["remote", "add", "origin", remoteRepo], { cwd: workRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: workRepo });
    await fs.writeFile(
      path.join(remoteRepo, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'remote rejected cask update' >&2\nexit 1\n",
      "utf8",
    );
    await fs.chmod(path.join(remoteRepo, "hooks", "pre-receive"), 0o755);

    return remoteRepo;
  }

  it("runs the local release workflow and verifies the packaged app", async () => {
    const repoRoot = process.cwd();
    const releaseEnv = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/check-friday-companion-release-env.sh"),
      {
        FRIDAY_MACOS_RELEASE_MODE: "local",
      },
    );

    expect(releaseEnv.stderr).toContain("environment OK for local release mode");

    const releaseResult = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/release-friday-companion-app.sh"),
      {
        FRIDAY_MACOS_RELEASE_MODE: "local",
      },
    );
    const appDir = releaseResult.stdout.trim();
    const appBinary = path.join(appDir, "Contents", "MacOS", "FridayCompanion");
    const releaseRecordJson = path.join(repoRoot, "dist", "macos", "FridayCompanion.release.json");
    const releaseRecordMd = path.join(repoRoot, "dist", "macos", "FridayCompanion.release.md");

    await expect(fs.access(appBinary)).resolves.toBeUndefined();
    expect(releaseResult.stderr).toContain("running local verification");
    expect(releaseResult.stderr).toContain("writing release record");
    expect(releaseResult.stderr).toContain("building release artifacts");
    expect(releaseResult.stderr).toContain("writing release manifest");

    const releaseRecord = JSON.parse(await fs.readFile(releaseRecordJson, "utf8")) as {
      releaseMode: string;
      notarizationStatus: string;
      appDir: string;
      dmgReleasePath: string | null;
      zipReleasePath: string | null;
      sourceReleasePath: string | null;
      sparkleAppcastPath: string | null;
      manifestJsonPath: string | null;
      manifestMarkdownPath: string | null;
      homebrewCaskPath: string | null;
    };
    const releaseMarkdown = await fs.readFile(releaseRecordMd, "utf8");

    expect(releaseRecord.releaseMode).toBe("local");
    expect(releaseRecord.notarizationStatus).toBe("not_requested");
    expect(releaseRecord.appDir).toBe(appDir);
    expect(releaseRecord.dmgReleasePath).toBeTruthy();
    expect(releaseRecord.zipReleasePath).toBeTruthy();
    expect(releaseRecord.sourceReleasePath).toBeTruthy();
    expect(releaseRecord.sparkleAppcastPath).toBeNull();
    expect(releaseRecord.manifestJsonPath).toBeTruthy();
    expect(releaseRecord.manifestMarkdownPath).toBeTruthy();
    expect(releaseRecord.homebrewCaskPath).toBeTruthy();
    expect(releaseMarkdown).toContain("# Friday Companion Release Record");
    const manifestJsonPath = releaseRecord.manifestJsonPath!;
    const manifestMarkdownPath = releaseRecord.manifestMarkdownPath!;
    const caskPath = releaseRecord.homebrewCaskPath!;
    const manifest = JSON.parse(await fs.readFile(manifestJsonPath, "utf8")) as {
      channels: Record<string, { availability: string }>;
      platforms: Array<{ platform: string; artifacts: Array<{ kind: string }> }>;
    };

    await expect(fs.access(releaseRecord.dmgReleasePath!)).resolves.toBeUndefined();
    await expect(fs.access(releaseRecord.zipReleasePath!)).resolves.toBeUndefined();
    await expect(fs.access(manifestMarkdownPath)).resolves.toBeUndefined();
    await expect(fs.access(caskPath)).resolves.toBeUndefined();
    expect(manifest.channels.homebrew.availability).toBe("generated");
    expect(manifest.platforms.find((entry) => entry.platform === "macos")?.artifacts.some((artifact) => artifact.kind === "dmg")).toBe(true);

    const verifyResult = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/verify-friday-companion-app.sh"),
      {
        FRIDAY_SYSTEM_COMPANION_APP_DIR: appDir,
        FRIDAY_MACOS_VERIFY_MODE: "local",
      },
    );

    expect(verifyResult.stdout.trim()).toBe(appDir);
    expect(verifyResult.stderr).toContain("verifying executable signature");
  }, 180_000);

  it("generates a Sparkle appcast when update credentials are configured", async () => {
    const repoRoot = process.cwd();
    const keyDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-sparkle-keys-"));

    const generatedKeys = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/generate-friday-sparkle-keys.sh"),
      {
        FRIDAY_MACOS_SPARKLE_KEY_DIR: keyDir,
      },
    );
    const [privateKeyPath, publicKeyPath] = generatedKeys.stdout
      .trim()
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const publicKey = (await fs.readFile(publicKeyPath, "utf8")).trim();

    const releaseResult = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/release-friday-companion-app.sh"),
      {
        FRIDAY_MACOS_RELEASE_MODE: "local",
        FRIDAY_MACOS_SPARKLE_PRIVATE_KEY: privateKeyPath,
        FRIDAY_MACOS_SPARKLE_PUBLIC_KEY: publicKey,
        FRIDAY_MACOS_APPCAST_BASE_URL: "https://github.com/thesongzhu/Friday/releases/latest/download",
      },
    );

    expect(releaseResult.stderr).toContain("generating Sparkle appcast");

    const releaseRecord = JSON.parse(
      await fs.readFile(path.join(repoRoot, "dist", "macos", "FridayCompanion.release.json"), "utf8"),
    ) as {
      sparkleAppcastPath: string | null;
      manifestJsonPath: string | null;
    };
    const manifest = JSON.parse(
      await fs.readFile(releaseRecord.manifestJsonPath!, "utf8"),
    ) as {
      channels: { sparkle: { availability: string; appcastUrl: string | null } };
    };

    expect(releaseRecord.sparkleAppcastPath).toBeTruthy();
    await expect(fs.access(releaseRecord.sparkleAppcastPath!)).resolves.toBeUndefined();
    expect(manifest.channels.sparkle.availability).toBe("generated");
    expect(manifest.channels.sparkle.appcastUrl).toBe(
      "https://github.com/thesongzhu/Friday/releases/latest/download/appcast.xml",
    );
  }, 180_000);

  it("serializes concurrent local release invocations with a shared lock", async () => {
    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, "scripts/ops/release-friday-companion-app.sh");

    const [first, second] = await Promise.all([
      runReleaseScript(scriptPath, {
        FRIDAY_MACOS_RELEASE_MODE: "local",
      }),
      runReleaseScript(scriptPath, {
        FRIDAY_MACOS_RELEASE_MODE: "local",
      }),
    ]);

    expect(first.stdout.trim()).toContain("FridayCompanion.app");
    expect(second.stdout.trim()).toContain("FridayCompanion.app");
  }, 180_000);

  it("writes the default macOS beta smoke record under dist instead of the docs evidence path", async () => {
    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, "scripts/ops/run-friday-macos-beta-smoke.sh");
    const result = await runReleaseScript(scriptPath, {
      FRIDAY_MACOS_RELEASE_MODE: "local",
    });

    const evidencePath = result.stdout.trim();
    expect(evidencePath).toContain(path.join("dist", "macos", "FridayCompanion.clean-machine-smoke.md"));

    const contents = await fs.readFile(evidencePath, "utf8");
    expect(contents).toContain("Status: pending");
    expect(contents).toContain("Release mode: local");
  }, 180_000);

  it("excludes prior source release artifacts from subsequent npm/source builds", async () => {
    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, "scripts/ops/build-friday-source-distribution.sh");
    const packageVersion = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const sourceArtifactEntry = `package/dist/releases/source/friday-${packageVersion.version}.tgz`;
    const sourceMetadataEntry = `${sourceArtifactEntry}.artifact.json`;

    const firstBuild = await runReleaseScript(scriptPath, {});
    const firstArtifactPath = firstBuild.stdout.trim();
    const firstListing = await execFileAsync("tar", ["-tzf", firstArtifactPath], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(firstListing.stdout).not.toContain(sourceArtifactEntry);
    expect(firstListing.stdout).not.toContain(sourceMetadataEntry);

    const secondBuild = await runReleaseScript(scriptPath, {});
    const secondArtifactPath = secondBuild.stdout.trim();
    const secondListing = await execFileAsync("tar", ["-tzf", secondArtifactPath], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(secondArtifactPath).toBe(firstArtifactPath);
    expect(secondListing.stdout).not.toContain(sourceArtifactEntry);
    expect(secondListing.stdout).not.toContain(sourceMetadataEntry);
  }, 180_000);

  it("degrades to generated Homebrew metadata when tap publication fails", async () => {
    const repoRoot = process.cwd();
    const remoteRepo = await createRejectingHomebrewTap("friday-release-homebrew-fallback-");
    const releaseResult = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/release-friday-companion-app.sh"),
      {
        FRIDAY_MACOS_RELEASE_MODE: "local",
        FRIDAY_HOMEBREW_TAP_REPO: remoteRepo,
        FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN: "local-test-token",
      },
    );

    expect(releaseResult.stderr).toContain("publishing Homebrew cask");
    expect(releaseResult.stderr).toContain("failed to push cask update");
    expect(releaseResult.stderr).toContain("Homebrew cask publication failed; continuing with generated cask only");

    const releaseRecord = JSON.parse(
      await fs.readFile(path.join(repoRoot, "dist", "macos", "FridayCompanion.release.json"), "utf8"),
    ) as {
      manifestJsonPath: string | null;
    };
    const manifest = JSON.parse(
      await fs.readFile(releaseRecord.manifestJsonPath!, "utf8"),
    ) as {
      channels: { homebrew: { availability: string; tapRepo: string | null } };
    };

    expect(manifest.channels.homebrew.availability).toBe("generated");
    expect(manifest.channels.homebrew.tapRepo).toBeNull();
  }, 180_000);

  it("rejects notarized release mode when Apple credentials are missing", async () => {
    const repoRoot = process.cwd();

    const error = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/check-friday-companion-release-env.sh"),
      {
        FRIDAY_MACOS_RELEASE_MODE: "notarize",
        FRIDAY_MACOS_CODESIGN_IDENTITY: "",
        FRIDAY_MACOS_NOTARY_PROFILE: "",
        FRIDAY_MACOS_TEAM_ID: "",
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe(78);
    expect(error?.stderr ?? "").toContain("FRIDAY_MACOS_CODESIGN_IDENTITY is required");
  });

  it("rejects notarized release mode when configured Apple credentials are unavailable", async () => {
    const repoRoot = process.cwd();

    const error = await runReleaseScript(
      path.join(repoRoot, "scripts/ops/check-friday-companion-release-env.sh"),
      {
        FRIDAY_MACOS_RELEASE_MODE: "notarize",
        FRIDAY_MACOS_CODESIGN_IDENTITY: "Developer ID Application: Missing Identity (TEAMID1234)",
        FRIDAY_MACOS_NOTARY_PROFILE: "missing-profile",
        FRIDAY_MACOS_TEAM_ID: "TEAMID1234",
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe(78);
    expect(error?.stderr ?? "").toMatch(
      /no valid codesigning identities are available|requested codesigning identity was not found|notary profile is unavailable or inaccessible/,
    );
  });
});
