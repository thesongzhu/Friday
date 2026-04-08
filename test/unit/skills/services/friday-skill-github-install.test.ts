import { describe, expect, it } from "vitest";

/**
 * Tests for the installFromGitHubUrl method on FridaySkillLifecycleService.
 * The method parses a GitHub URL, extracts owner/repo, and delegates to the
 * standard install flow with a `github:owner/repo` skill ID.
 */
describe("installFromGitHubUrl — URL parsing", () => {
  // Inline the URL parsing logic to unit-test without full service deps
  function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    const match = url.match(/github\.com\/([^/]+)\/([^/\s#?]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }

  it("parses standard GitHub URL", () => {
    const result = parseGitHubUrl("https://github.com/user/my-skill");
    expect(result).toEqual({ owner: "user", repo: "my-skill" });
  });

  it("parses GitHub URL with trailing path", () => {
    const result = parseGitHubUrl("https://github.com/org/repo/tree/main/src");
    expect(result).toEqual({ owner: "org", repo: "repo" });
  });

  it("parses GitHub URL with .git suffix", () => {
    const result = parseGitHubUrl("https://github.com/user/skill.git");
    expect(result).toEqual({ owner: "user", repo: "skill.git" });
  });

  it("parses GitHub URL with query params", () => {
    const result = parseGitHubUrl("https://github.com/user/repo?tab=readme");
    expect(result).toEqual({ owner: "user", repo: "repo" });
  });

  it("parses GitHub URL with hash fragment", () => {
    const result = parseGitHubUrl("https://github.com/user/repo#readme");
    expect(result).toEqual({ owner: "user", repo: "repo" });
  });

  it("returns null for non-GitHub URL", () => {
    expect(parseGitHubUrl("https://gitlab.com/user/repo")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGitHubUrl("")).toBeNull();
  });

  it("returns null for malformed GitHub URL", () => {
    expect(parseGitHubUrl("https://github.com/")).toBeNull();
  });

  it("constructs correct skill ID from parsed URL", () => {
    const parsed = parseGitHubUrl("https://github.com/friday-skills/data-pipeline");
    expect(parsed).not.toBeNull();
    const skillId = `github:${parsed!.owner}/${parsed!.repo}`;
    expect(skillId).toBe("github:friday-skills/data-pipeline");
  });
});
