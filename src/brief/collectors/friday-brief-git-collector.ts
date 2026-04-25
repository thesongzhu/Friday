import { spawn } from "node:child_process";

import {
  buildSkippedCollectionResult,
  type FridayBriefCollector,
  type FridayBriefCollectorContext,
  runCollectorSafely,
} from "./friday-brief-collector.types.js";
import type { FridayBriefEvent } from "../friday-brief.types.js";
import type { FridayBriefGitRepoConfig } from "../friday-brief-config.types.js";

/** Runner abstraction — tests inject a fake implementation. */
export type FridayGitRunner = (
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

function defaultGitRunner(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    const abortHandler = (): void => {
      proc.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", (err) => {
      signal.removeEventListener("abort", abortHandler);
      reject(err);
    });
    proc.on("close", (code) => {
      signal.removeEventListener("abort", abortHandler);
      if (code !== 0) {
        reject(new Error(`git_exit_${String(code)}:${stderr.slice(0, 240)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const SEPARATOR = "\u001ffriday-brief-end\u001f";
const FIELD_SEPARATOR = "\u001f";

function parseGitLogOutput(output: string): Array<{
  sha: string;
  iso: string;
  authorEmail: string;
  authorName: string;
  branch: string;
  subject: string;
  body: string;
}> {
  const entries = output
    .split(SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return entries.map((entry) => {
    const [sha, iso, authorEmail, authorName, branch, subject, ...bodyParts] =
      entry.split(FIELD_SEPARATOR);
    return {
      sha: sha ?? "",
      iso: iso ?? "",
      authorEmail: authorEmail ?? "",
      authorName: authorName ?? "",
      branch: branch ?? "",
      subject: subject ?? "",
      body: bodyParts.join(FIELD_SEPARATOR).trim(),
    };
  });
}

async function collectOneRepo(
  run: FridayGitRunner,
  repo: FridayBriefGitRepoConfig,
  ctx: FridayBriefCollectorContext,
): Promise<FridayBriefEvent[]> {
  const branches = repo.branches.length > 0 ? repo.branches : ["HEAD"];
  const events: FridayBriefEvent[] = [];
  for (const branch of branches) {
    const pretty = [
      "%H",
      "%aI",
      "%ae",
      "%an",
      branch,
      "%s",
      "%b",
    ].join(FIELD_SEPARATOR) + SEPARATOR;
    const args = [
      "log",
      `--since=${ctx.fromIso}`,
      `--until=${ctx.toIso}`,
      `--pretty=format:${pretty}`,
      "--no-color",
      branch,
    ];
    if (repo.authors.length > 0) {
      for (const author of repo.authors) {
        args.splice(1, 0, `--author=${author}`);
      }
    }
    const output = await run(args, repo.path, ctx.signal);
    const commits = parseGitLogOutput(output);
    for (const commit of commits) {
      if (!commit.sha) continue;
      events.push({
        source: "git_repos",
        occurredAt: commit.iso,
        externalId: `${repo.label}:${commit.sha}`,
        summary: `[${repo.label}] ${commit.subject}`,
        detail: commit.body || undefined,
        actor: commit.authorName || commit.authorEmail,
        tags: [repo.label, commit.branch || branch],
      });
    }
  }
  return events;
}

export interface FridayBriefGitCollectorDeps {
  gitRunner?: FridayGitRunner;
}

export function createFridayBriefGitCollector(
  deps: FridayBriefGitCollectorDeps = {},
): FridayBriefCollector {
  const run = deps.gitRunner ?? defaultGitRunner;
  return {
    source: "git_repos",
    isEnabled(config) {
      return config.sources.git_repos.enabled && config.sources.git_repos.repos.length > 0;
    },
    async collect(ctx: FridayBriefCollectorContext) {
      const cfg = ctx.config.sources.git_repos;
      if (!cfg.enabled) return buildSkippedCollectionResult("git_repos", "source_disabled");
      if (cfg.repos.length === 0) return buildSkippedCollectionResult("git_repos", "no_repos_configured");

      return runCollectorSafely("git_repos", async () => {
        const all: FridayBriefEvent[] = [];
        for (const repo of cfg.repos) {
          try {
            const events = await collectOneRepo(run, repo, ctx);
            all.push(...events);
          } catch (err) {
            const error = err as Error;
            all.push({
              source: "git_repos",
              occurredAt: ctx.toIso,
              externalId: `error:${repo.label}`,
              summary: `[${repo.label}] git log failed: ${error.message}`,
              tags: [repo.label, "error"],
            });
          }
        }
        return { events: all };
      });
    },
  };
}
