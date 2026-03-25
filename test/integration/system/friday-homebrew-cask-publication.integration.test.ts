import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
type ExecFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

describe("Friday Homebrew cask publication", () => {
  it("publishes the generated cask to a local tap repository and writes channel metadata", async () => {
    const repoRoot = process.cwd();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-homebrew-publish-"));
    const workRepo = path.join(tempRoot, "tap-work");
    const remoteRepo = path.join(tempRoot, "tap-remote.git");
    const caskDir = path.join(tempRoot, "dist", "releases", "homebrew", "Casks");
    const channelsDir = path.join(tempRoot, "dist", "releases", "channels");

    await fs.mkdir(workRepo, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workRepo });
    await fs.writeFile(path.join(workRepo, "README.md"), "# friday tap\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workRepo });
    await execFileAsync("git", ["-c", "user.name=Codex", "-c", "user.email=codex@openai.com", "commit", "-m", "init"], { cwd: workRepo });
    await execFileAsync("git", ["clone", "--bare", workRepo, remoteRepo]);
    await execFileAsync("git", ["remote", "add", "origin", remoteRepo], { cwd: workRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: workRepo });

    await fs.mkdir(caskDir, { recursive: true });
    await fs.writeFile(
      path.join(caskDir, "friday.rb"),
      [
        'cask "friday" do',
        '  version "1.2.3"',
        '  sha256 "abc123"',
        '  url "https://example.test/friday.dmg"',
        '  app "FridayCompanion.app"',
        "end",
        "",
      ].join("\n"),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      "bash",
      [path.join(repoRoot, "scripts/ops/publish-friday-homebrew-cask.sh"), repoRoot],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_HOMEBREW_TAP_REPO: remoteRepo,
          FRIDAY_SYSTEM_COMPANION_HOMEBREW_CASK_PATH: path.join(caskDir, "friday.rb"),
          FRIDAY_RELEASE_CHANNELS_DIR: channelsDir,
        },
      },
    );

    expect(stdout.trim()).toContain(path.join("Casks", "friday.rb"));

    const publishedCask = await execFileAsync(
      "git",
      ["--git-dir", remoteRepo, "show", "main:Casks/friday.rb"],
      { encoding: "utf8" },
    );
    expect(publishedCask.stdout).toContain('cask "friday" do');
    expect(publishedCask.stdout).toContain('version "1.2.3"');

    const channelMetadata = JSON.parse(
      await fs.readFile(path.join(channelsDir, "homebrew.json"), "utf8"),
    ) as { channel: string; availability: string; tapRepo: string };
    expect(channelMetadata.channel).toBe("homebrew");
    expect(channelMetadata.availability).toBe("published");
    expect(channelMetadata.tapRepo).toBe(remoteRepo);
  });

  it("surfaces push failures with actionable stderr", async () => {
    const repoRoot = process.cwd();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-homebrew-publish-fail-"));
    const workRepo = path.join(tempRoot, "tap-work");
    const remoteRepo = path.join(tempRoot, "tap-remote.git");
    const caskDir = path.join(tempRoot, "dist", "releases", "homebrew", "Casks");
    const channelsDir = path.join(tempRoot, "dist", "releases", "channels");

    await fs.mkdir(workRepo, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workRepo });
    await fs.writeFile(path.join(workRepo, "README.md"), "# friday tap\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workRepo });
    await execFileAsync("git", ["-c", "user.name=Codex", "-c", "user.email=codex@openai.com", "commit", "-m", "init"], { cwd: workRepo });
    await execFileAsync("git", ["clone", "--bare", workRepo, remoteRepo]);
    await execFileAsync("git", ["remote", "add", "origin", remoteRepo], { cwd: workRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: workRepo });
    await fs.writeFile(
      path.join(remoteRepo, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'remote rejected cask update' >&2\nexit 1\n",
      "utf8",
    );
    await fs.chmod(path.join(remoteRepo, "hooks", "pre-receive"), 0o755);

    await fs.mkdir(caskDir, { recursive: true });
    await fs.writeFile(
      path.join(caskDir, "friday.rb"),
      [
        'cask "friday" do',
        '  version "1.2.4"',
        '  sha256 "def456"',
        '  url "https://example.test/friday.dmg"',
        '  app "FridayCompanion.app"',
        "end",
        "",
      ].join("\n"),
      "utf8",
    );

    const error = await execFileAsync(
      "bash",
      [path.join(repoRoot, "scripts/ops/publish-friday-homebrew-cask.sh"), repoRoot],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_HOMEBREW_TAP_REPO: remoteRepo,
          FRIDAY_SYSTEM_COMPANION_HOMEBREW_CASK_PATH: path.join(caskDir, "friday.rb"),
          FRIDAY_RELEASE_CHANNELS_DIR: channelsDir,
        },
      },
    ).then(
      () => null,
      (failure) => failure as ExecFailure,
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe(128);
    expect(error?.stderr ?? "").toContain("failed to push cask update");
    expect(error?.stderr ?? "").toContain("remote rejected cask update");
  });
});
