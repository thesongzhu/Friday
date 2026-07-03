import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function currentNpmVersionFromReleaseTruth(): string {
  const releaseTruth = readRepoFile("docs/public-v1-local-candidate.md");
  const match = releaseTruth.match(/current public npm\/source release is `([^`]+)`/);
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

function packageVersion(): string {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { version: string };
  return packageJson.version;
}

describe("public distribution status copy", () => {
  it("keeps the English README honest about source vs npm package truth", () => {
    const readme = readRepoFile("README.md");
    const npmVersion = currentNpmVersionFromReleaseTruth();
    const sourceVersion = packageVersion();

    expect(readme).toContain(`source tree is ${sourceVersion}`);
    expect(readme).toContain(`npm package currently lags at ${npmVersion}`);
    expect(readme).toContain("an earlier package line");
  });

  it("keeps the Chinese README honest about source vs npm package truth", () => {
    const readme = readRepoFile("README.zh-CN.md");
    const npmVersion = currentNpmVersionFromReleaseTruth();
    const sourceVersion = packageVersion();

    expect(readme).toContain(`源码树是 ${sourceVersion}`);
    expect(readme).toContain(`npm 包目前仍停在 ${npmVersion}`);
    expect(readme).toContain("较早的包线");
  });
});
