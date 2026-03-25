import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("wave 2 and wave 3 Friday starter skills", () => {
  it("creates a page benchmark baseline and detects later regressions", async () => {
    const { execute } = await import("../../../../skills/page-benchmark-report/index.mjs");
    const repoRoot = makeTempDir("friday-page-benchmark-");
    initRepo(repoRoot);

    let callCount = 0;
    const closeSession = vi.fn(async () => undefined);
    const browser = {
      inspectPage: vi.fn(async () => {
        callCount += 1;
        const slowRun = callCount > 3;
        return {
          sessionId: "benchmark-session-1",
          tabId: "tab-1",
          title: "Friday Assistant",
          finalUrl: "http://127.0.0.1:5173/assistant",
          requestedUrl: "http://127.0.0.1:5173/assistant",
          status: 200,
          snapshot: "Friday Assistant",
          screenshotPath: `/tmp/benchmark-${String(callCount)}.png`,
          consoleErrors: slowRun ? [{ type: "error", text: "boom" }] : [],
          consoleWarnings: [],
          pageErrors: [],
          requestFailures: [],
          timings: {
            domContentLoadedMs: slowRun ? 260 : 110,
            loadMs: slowRun ? 420 : 170,
          },
        };
      }),
      closeSession,
    };

    const first = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173/assistant",
      },
      { browser },
    );
    expect(first.details.comparisonState).toBe("baseline_created");
    expect(existsSync(first.details.baselinePath)).toBe(true);

    const second = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173/assistant",
      },
      { browser },
    );
    expect(second.details.comparisonState).toBe("regression");
    expect(second.details.findings.length).toBeGreaterThan(0);
    expect(closeSession).toHaveBeenCalledWith("benchmark-session-1");
  });

  it("runs release-canary-check and captures per-page browser evidence", async () => {
    const { execute } = await import("../../../../skills/release-canary-check/index.mjs");
    const repoRoot = makeTempDir("friday-release-canary-");
    initRepo(repoRoot);
    const closeSession = vi.fn(async () => undefined);

    const result = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173",
        expectedText: "Dashboard",
      },
      {
        browser: {
          inspectPage: vi.fn(async () => ({
            sessionId: "canary-session-1",
            tabId: "tab-1",
            title: "Friday",
            finalUrl: "http://127.0.0.1:5173",
            requestedUrl: "http://127.0.0.1:5173",
            status: 200,
            snapshot: "Assistant Home",
            screenshotPath: "/tmp/canary.png",
            consoleErrors: [{ type: "error", text: "ReferenceError: x is not defined" }],
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

    expect(result.summary).toContain("issue");
    expect(result.details.pages).toHaveLength(1);
    expect(result.details.pages[0]?.runPath).toContain(".friday/skills/release-canary-check");
    expect(result.details.findings.length).toBeGreaterThan(0);
    expect(closeSession).toHaveBeenCalledWith("canary-session-1");
  });

  it("stores release-canary evidence under the requested workspace when no git root exists", async () => {
    const { execute } = await import("../../../../skills/release-canary-check/index.mjs");
    const workspaceRoot = makeTempDir("friday-release-canary-non-git-");

    const result = await execute(
      {
        workspaceRoot,
        url: "http://127.0.0.1:5173",
      },
      {
        browser: {
          inspectPage: vi.fn(async () => ({
            sessionId: "canary-session-2",
            tabId: "tab-1",
            title: "Friday",
            finalUrl: "http://127.0.0.1:5173",
            requestedUrl: "http://127.0.0.1:5173",
            status: 200,
            snapshot: "Assistant Home",
            screenshotPath: "/tmp/canary.png",
            consoleErrors: [],
            consoleWarnings: [],
            pageErrors: [],
            requestFailures: [],
            timings: {
              domContentLoadedMs: 120,
              loadMs: 180,
            },
          })),
          closeSession: vi.fn(async () => undefined),
        },
      },
    );

    const runPath = String(result.details.pages[0]?.runPath ?? "");
    expect(runPath.startsWith(path.join(workspaceRoot, ".friday", "skills", "release-canary-check"))).toBe(true);
    expect(existsSync(runPath)).toBe(true);
  });

  it("summarizes recent commits in engineering-retro", async () => {
    const { execute } = await import("../../../../skills/engineering-retro/index.mjs");
    const repoRoot = makeTempDir("friday-engineering-retro-");
    initRepo(repoRoot);
    writeFileSync(path.join(repoRoot, "README.md"), "# Friday\n");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "Add initial README"], { cwd: repoRoot });

    const result = await execute({
      workspaceRoot: repoRoot,
      sinceDays: 7,
    });

    expect(result.summary).toContain("recent commit");
    expect(result.details.contributors.length).toBeGreaterThan(0);
    expect(existsSync(result.details.reportPath)).toBe(true);
  });

  it("runs product-scope-review with structured recommendations", async () => {
    const { execute } = await import("../../../../skills/product-scope-review/index.mjs");

    const result = await execute({
      goal: "Review whether this all-in-one launch platform should be narrowed to one operator workflow first.",
    });

    expect(result.summary).toContain("Product scope review");
    expect(result.details.scores).toHaveProperty("wedgeClarity");
    expect(Array.isArray(result.details.recommendations)).toBe(true);
    expect(result.details.suggestedSkillId).toBe("implementation-plan-review");
  });

  it("runs design-plan-review with state and accessibility guidance", async () => {
    const { execute } = await import("../../../../skills/design-plan-review/index.mjs");

    const result = await execute({
      goal: "Review this UI plan for a mobile and desktop route with clear hierarchy, but no explicit loading or error states.",
    });

    expect(result.summary).toContain("Design plan review");
    expect(result.details.scores).toHaveProperty("stateCoverage");
    expect(Array.isArray(result.details.recommendations)).toBe(true);
  });

  it("runs security-review and writes a local report", async () => {
    const { execute } = await import("../../../../skills/security-review/index.mjs");
    const repoRoot = makeTempDir("friday-security-review-");
    initRepo(repoRoot);
    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, "src", "security.ts"),
      [
        "const proxy = req.headers['x-forwarded-for'];",
        "const remote = req.socket.remoteAddress;",
        "const token = 'ghp_1234567890abcdef1234567890';",
        "exec('echo hi');",
      ].join("\n"),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = "";

    let result;
    try {
      result = await execute({
        workspaceRoot: repoRoot,
        goal: "Audit token handling and proxy trust.",
      });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(result.summary).toContain("Security review");
    expect(result.details.threatModel.length).toBeGreaterThan(0);
    expect(result.details.scans.proxyTrust.length).toBeGreaterThan(0);
    expect(existsSync(result.details.reportPath)).toBe(true);
  });

  it("previews and applies a bounded browser-qa-fix against a temp HTML entrypoint", async () => {
    const { execute } = await import("../../../../skills/browser-qa-fix/index.mjs");
    const repoRoot = makeTempDir("friday-browser-qa-fix-");
    initRepo(repoRoot);
    writeFileSync(path.join(repoRoot, "index.html"), "<html><head><title>Vite App</title></head><body>Hello</body></html>\n");
    const closeSession = vi.fn(async () => undefined);

    const preview = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173",
      },
      {
        browser: {
          inspectPage: vi.fn(async () => ({
            sessionId: "browser-fix-session-1",
            tabId: "tab-1",
            title: "Vite App",
            finalUrl: "http://127.0.0.1:5173",
            requestedUrl: "http://127.0.0.1:5173",
            status: 200,
            snapshot: "Hello",
            screenshotPath: "/tmp/browser-fix.png",
            consoleErrors: [],
            consoleWarnings: [],
            pageErrors: [],
            requestFailures: [],
            timings: {
              domContentLoadedMs: 90,
              loadMs: 120,
            },
          })),
          closeSession,
        },
      },
    );

    expect(preview.summary).toContain("prepared");
    expect(readFileSync(path.join(repoRoot, "index.html"), "utf8")).toContain("<title>Vite App</title>");

    const applied = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173",
        apply: true,
      },
      {
        browser: {
          inspectPage: vi.fn(async () => ({
            sessionId: "browser-fix-session-2",
            tabId: "tab-1",
            title: "Vite App",
            finalUrl: "http://127.0.0.1:5173",
            requestedUrl: "http://127.0.0.1:5173",
            status: 200,
            snapshot: "Hello",
            screenshotPath: "/tmp/browser-fix.png",
            consoleErrors: [],
            consoleWarnings: [],
            pageErrors: [],
            requestFailures: [],
            timings: {
              domContentLoadedMs: 90,
              loadMs: 120,
            },
          })),
          closeSession,
        },
      },
    );

    expect(applied.summary).toContain("updated");
    expect(readFileSync(path.join(repoRoot, "index.html"), "utf8")).toContain("<title>Friday | 127.0.0.1:5173</title>");
    expect(existsSync(applied.details.reportPath)).toBe(true);
  });

  it("returns a blocked page-benchmark-report when the browser runtime is unavailable", async () => {
    const { execute } = await import("../../../../skills/page-benchmark-report/index.mjs");
    const workspaceRoot = makeTempDir("friday-page-benchmark-blocked-");

    const result = await execute(
      {
        workspaceRoot,
        url: "http://127.0.0.1:5173/assistant",
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
    expect(result.details.baselinePath).toContain(".friday/skills/page-benchmark-report/baselines");
  });

  it("blocks browser-qa-fix when broader QA errors are present", async () => {
    const { execute } = await import("../../../../skills/browser-qa-fix/index.mjs");
    const repoRoot = makeTempDir("friday-browser-qa-fix-blocked-");
    initRepo(repoRoot);
    writeFileSync(path.join(repoRoot, "index.html"), "<html><head><title>Vite App</title></head><body>Hello</body></html>\n");

    const result = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173",
        apply: true,
      },
      {
        browser: {
          inspectPage: vi.fn(async () => ({
            sessionId: "browser-fix-session-3",
            tabId: "tab-1",
            title: "Vite App",
            finalUrl: "http://127.0.0.1:5173",
            requestedUrl: "http://127.0.0.1:5173",
            status: 200,
            snapshot: "Hello",
            screenshotPath: "/tmp/browser-fix.png",
            consoleErrors: [{ type: "error", text: "TypeError: blocked" }],
            consoleWarnings: [],
            pageErrors: [],
            requestFailures: [],
            timings: {
              domContentLoadedMs: 90,
              loadMs: 120,
            },
          })),
          closeSession: vi.fn(async () => undefined),
        },
      },
    );

    expect(result.summary).toContain("stopped before applying");
    expect(result.details.requiresApproval).toBe(true);
    expect(readFileSync(path.join(repoRoot, "index.html"), "utf8")).toContain("<title>Vite App</title>");
  });

  it("returns a blocked browser-qa-fix when the browser runtime is unavailable", async () => {
    const { execute } = await import("../../../../skills/browser-qa-fix/index.mjs");
    const repoRoot = makeTempDir("friday-browser-qa-fix-runtime-blocked-");
    initRepo(repoRoot);
    writeFileSync(path.join(repoRoot, "index.html"), "<html><head><title>Vite App</title></head><body>Hello</body></html>\n");

    const result = await execute(
      {
        workspaceRoot: repoRoot,
        url: "http://127.0.0.1:5173",
        apply: true,
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
    expect(readFileSync(path.join(repoRoot, "index.html"), "utf8")).toContain("<title>Vite App</title>");
  });

  it("reports channel contract and status for slack-channel-status", async () => {
    const { execute } = await import("../../../../skills/slack-channel-status/index.mjs");

    const result = await execute(
      {},
      {
        channels: {
          listChannels: async () => [
            {
              kind: "slack",
              running: true,
              status: "connected",
              diagnostics: { mode: "socket" },
              contract: {
                coreAuthority: {
                  messageRouting: true,
                  sessionMirroring: true,
                  audit: true,
                  evidence: true,
                },
                pluginResponsibilities: {
                  config: true,
                  auth: true,
                  pairing: false,
                  outboundDelivery: true,
                  threadResolution: true,
                  providerRetries: false,
                },
                supports: {
                  directMessages: true,
                  groupMessages: true,
                  threads: true,
                  typing: false,
                },
                curatedSkillIds: ["slack-channel-status"],
              },
              allowlist: {
                hasAllowedUsers: false,
                allowedUsersCount: 0,
                hasAllowedChats: false,
                allowedChatsCount: 0,
              },
            },
          ],
          getChannel: async () => ({
            kind: "slack",
            running: true,
            status: "connected",
            diagnostics: { mode: "socket" },
            contract: {
              coreAuthority: {
                messageRouting: true,
                sessionMirroring: true,
                audit: true,
                evidence: true,
              },
              pluginResponsibilities: {
                config: true,
                auth: true,
                pairing: false,
                outboundDelivery: true,
                threadResolution: true,
                providerRetries: false,
              },
              supports: {
                directMessages: true,
                groupMessages: true,
                threads: true,
                typing: false,
              },
              curatedSkillIds: ["slack-channel-status"],
            },
            allowlist: {
              hasAllowedUsers: false,
              allowedUsersCount: 0,
              hasAllowedChats: false,
              allowedChatsCount: 0,
            },
          }),
        },
      },
    );

    expect(result.summary).toContain("Slack channel is connected");
    expect(result.details.supportsThreads).toBe(true);
    expect(result.details.curatedSkillIds).toEqual(["slack-channel-status"]);
  });
});
