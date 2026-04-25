import { describe, it, expect } from "vitest";

import { createFridayBriefGitCollector } from "../../../../src/brief/collectors/friday-brief-git-collector.js";
import { buildDefaultFridayBriefConfig } from "../../../../src/brief/friday-brief-config.types.js";
import type { FridayGitRunner } from "../../../../src/brief/collectors/friday-brief-git-collector.js";

const FS = "\u001f";
const END = "\u001ffriday-brief-end\u001f";

function formatCommit(params: {
  sha: string;
  iso: string;
  authorEmail: string;
  authorName: string;
  branch: string;
  subject: string;
  body?: string;
}): string {
  return [
    params.sha,
    params.iso,
    params.authorEmail,
    params.authorName,
    params.branch,
    params.subject,
    params.body ?? "",
  ].join(FS) + END;
}

function ctx(overrides: Partial<Parameters<ReturnType<typeof createFridayBriefGitCollector>["collect"]>[0]> = {}) {
  const baseConfig = buildDefaultFridayBriefConfig();
  return {
    fromIso: "2026-04-24T00:00:00.000Z",
    toIso: "2026-04-24T20:00:00.000Z",
    config: baseConfig,
    signal: new AbortController().signal,
    userId: "u-1",
    ...overrides,
  };
}

describe("createFridayBriefGitCollector", () => {
  it("reports skipped when the source is disabled", async () => {
    const collector = createFridayBriefGitCollector({
      gitRunner: async () => "",
    });
    const result = await collector.collect(ctx());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("source_disabled");
    expect(result.events).toHaveLength(0);
  });

  it("reports skipped when enabled but no repos configured", async () => {
    const collector = createFridayBriefGitCollector({ gitRunner: async () => "" });
    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.git_repos.enabled = true;

    const result = await collector.collect(ctx({ config: cfg }));

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("no_repos_configured");
  });

  it("parses git log output into events", async () => {
    const output =
      formatCommit({
        sha: "abc123",
        iso: "2026-04-24T10:00:00.000Z",
        authorEmail: "dev@example.com",
        authorName: "Dev",
        branch: "HEAD",
        subject: "Fix login",
        body: "Body line 1",
      }) +
      formatCommit({
        sha: "def456",
        iso: "2026-04-24T11:00:00.000Z",
        authorEmail: "dev@example.com",
        authorName: "Dev",
        branch: "HEAD",
        subject: "Add tests",
      });

    const runner: FridayGitRunner = async () => output;
    const collector = createFridayBriefGitCollector({ gitRunner: runner });
    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.git_repos.enabled = true;
    cfg.sources.git_repos.repos = [
      { label: "core", path: "/tmp/core", authors: [], branches: [] },
    ];

    const result = await collector.collect(ctx({ config: cfg }));

    expect(result.skipped).toBe(false);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.source).toBe("git_repos");
    expect(result.events[0]?.externalId).toBe("core:abc123");
    expect(result.events[0]?.summary).toBe("[core] Fix login");
    expect(result.events[0]?.detail).toBe("Body line 1");
    expect(result.events[0]?.actor).toBe("Dev");
    expect(result.events[1]?.externalId).toBe("core:def456");
  });

  it("passes the configured author filter through to git args", async () => {
    const capturedArgs: string[][] = [];
    const runner: FridayGitRunner = async (args) => {
      capturedArgs.push([...args]);
      return "";
    };
    const collector = createFridayBriefGitCollector({ gitRunner: runner });
    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.git_repos.enabled = true;
    cfg.sources.git_repos.repos = [
      {
        label: "core",
        path: "/tmp/core",
        authors: ["dev@example.com"],
        branches: ["main", "feature/x"],
      },
    ];

    await collector.collect(ctx({ config: cfg }));

    expect(capturedArgs).toHaveLength(2);
    const flat = capturedArgs.flat();
    expect(flat).toContain("--author=dev@example.com");
    expect(flat).toContain("main");
    expect(flat).toContain("feature/x");
  });

  it("captures a per-repo error as an event and keeps collecting others", async () => {
    const runner: FridayGitRunner = async (_args, cwd) => {
      if (cwd === "/tmp/broken") throw new Error("not a git repo");
      return formatCommit({
        sha: "abc123",
        iso: "2026-04-24T10:00:00.000Z",
        authorEmail: "d@e.com",
        authorName: "D",
        branch: "HEAD",
        subject: "ok",
      });
    };
    const collector = createFridayBriefGitCollector({ gitRunner: runner });
    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.git_repos.enabled = true;
    cfg.sources.git_repos.repos = [
      { label: "broken", path: "/tmp/broken", authors: [], branches: [] },
      { label: "good", path: "/tmp/good", authors: [], branches: [] },
    ];

    const result = await collector.collect(ctx({ config: cfg }));

    expect(result.skipped).toBe(false);
    const summaries = result.events.map((e) => e.summary);
    expect(summaries.some((s) => s.startsWith("[broken] git log failed:"))).toBe(true);
    expect(summaries.some((s) => s === "[good] ok")).toBe(true);
  });
});
