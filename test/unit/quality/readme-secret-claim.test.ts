import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("README secret redaction claim precision", () => {
  it("does not overclaim that every secret is scrubbed before any model sees it", () => {
    const readme = readRepoFile("README.md");
    const zhReadme = readRepoFile("README.zh-CN.md");

    expect(readme).not.toContain("scrubbed of secrets before any model ever sees it");
    expect(readme).toContain("scrubbed of known secret patterns before any model sees it");

    expect(zhReadme).not.toContain("先把秘密擦干净了，才让模型看到");
    expect(zhReadme).toContain("先擦掉已知秘密模式，才让模型看到");
  });
});
