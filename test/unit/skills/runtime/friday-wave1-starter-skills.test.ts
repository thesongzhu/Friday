import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Friday Test"], { cwd: root });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("wave 1 Friday starter skills", () => {
  it("runs idea-clarifier and surfaces open questions", async () => {
    const { execute } = await import("../../../../skills/idea-clarifier/index.mjs");

    const result = await execute({
      goal: "Help me scope a new operator dashboard for launch reviews.",
    });

    expect(result.summary).toContain("Idea clarification");
    expect(result.details.inferredDeliverable).toBe("ui surface");
    expect(result.details.openQuestions.length).toBeGreaterThan(0);
    expect(result.details.suggestedSkillId).toBe("implementation-plan-review");
  });

  it("runs implementation-plan-review and reports missing execution coverage", async () => {
    const { execute } = await import("../../../../skills/implementation-plan-review/index.mjs");

    const result = await execute({
      goal: "Architecture: update the assistant route. Add tests and rollback notes for the new flow.",
    });

    expect(result.summary).toContain("Implementation plan review");
    expect(result.details.coverageScore).toBeGreaterThan(0);
    expect(Array.isArray(result.details.missingAreas)).toBe(true);
    expect(result.details.suggestedSkillId).toBe("workspace-diff-review");
  });

  it("runs browser-qa-report against readonly browser context", async () => {
    const { execute } = await import("../../../../skills/browser-qa-report/index.mjs");
    const closeSession = vi.fn(async () => undefined);

    const result = await execute(
      {
        goal: "QA http://127.0.0.1:5173/settings",
      },
      {
        browser: {
          inspectPage: vi.fn(async () => ({
            sessionId: "browser-session-1",
            tabId: "tab-1",
            title: "Friday Settings",
            finalUrl: "http://127.0.0.1:5173/settings",
            requestedUrl: "http://127.0.0.1:5173/settings",
            status: 200,
            snapshot: "Settings\nBrowser QA",
            screenshotPath: "/tmp/browser-qa.png",
            consoleErrors: [],
            consoleWarnings: [],
            pageErrors: [],
            requestFailures: [],
            timings: {
              domContentLoadedMs: 120,
              loadMs: 180,
            },
          })),
          closeSession,
        },
      },
    );

    expect(result.summary).toContain("no blocking issues");
    expect(result.details.screenshotPath).toBe("/tmp/browser-qa.png");
    expect(result.details.suggestedSkillId).toBe("release-doc-sync");
    expect(closeSession).toHaveBeenCalledWith("browser-session-1");
  });

  it("returns a blocked browser-qa-report when the browser runtime is unavailable", async () => {
    const { execute } = await import("../../../../skills/browser-qa-report/index.mjs");

    const result = await execute(
      {
        goal: "QA http://127.0.0.1:5173/settings",
      },
      {
        browser: {
          inspectPage: vi.fn(async () => {
            throw new Error("browserType.launch: Executable doesn't exist at /missing/chromium");
          }),
          closeSession: vi.fn(async () => undefined),
        },
      },
    );

    expect(result.summary).toContain("browser runtime is unavailable");
    expect(result.details.runtimeUnavailable).toBe(true);
    expect(result.details.requiresRuntimeSetup).toBe(true);
    expect(result.details.blockedReason).toContain("Executable doesn't exist");
  });

  it("runs workspace-diff-review on a live temp repo", async () => {
    const { execute } = await import("../../../../skills/workspace-diff-review/index.mjs");
    const repoRoot = makeTempDir("friday-diff-review-");
    initRepo(repoRoot);
    mkdirSync(path.join(repoRoot, "ui", "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({
      name: "temp-repo",
      scripts: {
        lint: "echo lint",
        test: "echo test",
      },
    }, null, 2));
    writeFileSync(path.join(repoRoot, "ui", "src", "app.tsx"), "export const App = () => null;\n");

    const result = await execute({ workspaceRoot: repoRoot });

    expect(result.summary).toContain("Workspace diff review");
    expect(result.details.changedFiles.length).toBeGreaterThan(0);
    expect(result.details.findings[0]).toHaveProperty("title");
    expect(result.details.recommendedChecks).toContain("lint");
  });

  it("previews and applies release-doc-sync with managed blocks", async () => {
    const { execute } = await import("../../../../skills/release-doc-sync/index.mjs");
    const repoRoot = makeTempDir("friday-release-doc-sync-");
    initRepo(repoRoot);
    mkdirSync(path.join(repoRoot, "docs", "reference"), { recursive: true });
    mkdirSync(path.join(repoRoot, "src", "agent"), { recursive: true });
    writeFileSync(path.join(repoRoot, "README.md"), "# Friday\n\n## Latest Updates (2026-03-01)\n\nExisting content.\n");
    writeFileSync(path.join(repoRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    writeFileSync(path.join(repoRoot, "docs", "reference", "ARCHITECTURE.md"), "# Friday Architecture\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "src", "agent", "new-flow.ts"), "export const enabled = true;\n");

    const preview = await execute({
      workspaceRoot: repoRoot,
      goal: "Document the new assistant starter flows and bounded browser QA path.",
    });

    expect(preview.summary).toContain("prepared");
    expect(preview.details.updatedFiles).toHaveLength(3);

    const applied = await execute({
      workspaceRoot: repoRoot,
      goal: "Document the new assistant starter flows and bounded browser QA path.",
      apply: true,
    });

    expect(applied.summary).toContain("updated");
    expect(readFileSync(path.join(repoRoot, "README.md"), "utf8")).toContain("friday-release-doc-sync:start");
    expect(readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8")).toContain("### Changed");
    expect(readFileSync(path.join(repoRoot, "docs", "reference", "ARCHITECTURE.md"), "utf8")).toContain("Recent Documentation Sync");
  });
});
