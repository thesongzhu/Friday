#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRunId, ensureDir, writeJson, writeText } from "../../validation/real-world/lib/io.mjs";

function resolveCurrentBranch(repoRoot) {
  const envBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (envBranch && envBranch.trim().length > 0) {
    return envBranch.trim();
  }
  return git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }) ?? "main";
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    base: "main",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--repo-root":
        options.repoRoot = path.resolve(next);
        index += 1;
        break;
      case "--base":
        options.base = next;
        index += 1;
        break;
      case "--branch":
        options.branch = next;
        index += 1;
        break;
      case "--report-root":
        options.reportRoot = path.resolve(next);
        index += 1;
        break;
      default:
        break;
    }
  }
  options.branch ??= resolveCurrentBranch(options.repoRoot);
  return options;
}

function git(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "";
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

function resolveRef(repoRoot, ref) {
  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `origin/${ref}`,
    `refs/remotes/origin/${ref}`,
  ];
  for (const candidate of candidates) {
    const sha = git(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`], { allowFailure: true });
    if (sha) {
      return {
        input: ref,
        resolved: candidate,
        sha,
      };
    }
  }
  throw new Error(`Unable to resolve git ref "${ref}".`);
}

function parseWorktrees(text) {
  const lines = String(text ?? "").split("\n");
  const items = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (current) {
        items.push(current);
        current = null;
      }
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      if (current) {
        items.push(current);
      }
      current = { path: value };
      continue;
    }
    current ??= {};
    current[key] = value || true;
  }
  if (current) {
    items.push(current);
  }
  return items;
}

function renderMarkdown(result) {
  return [
    "# Branch Conformance",
    "",
    `- Checked at: ${result.checkedAt}`,
    `- Repo root: ${result.repoRoot}`,
    `- Base: ${result.base.input} (${result.base.sha})`,
    `- Branch: ${result.branch.input} (${result.branch.sha})`,
    `- Ahead: ${String(result.ahead)}`,
    `- Behind: ${String(result.behind)}`,
    `- Patch-equivalent commits: ${String(result.patchEquivalentCount)}`,
    `- Unique commits: ${String(result.uniqueCommitCount)}`,
    `- Recommendation: ${result.recommendation}`,
    `- Should merge: ${String(result.shouldMerge)}`,
    `- Should no-op: ${String(result.shouldNoop)}`,
    "",
    "## Worktree",
    "",
    result.worktree
      ? `- Path: ${result.worktree.path}\n- Clean: ${String(result.worktree.clean)}\n- Branch status: \`${result.worktree.branchStatus ?? "n/a"}\``
      : "- No local worktree attached to this branch.",
    "",
    "## Cherry",
    "",
    ...(result.cherryLines.length > 0
      ? result.cherryLines.map((line) => `- ${line}`)
      : ["- No cherry output."]),
    "",
  ].join("\n");
}

export function checkBranchConformance({ repoRoot = process.cwd(), base = "main", branch, reportRoot } = {}) {
  const effectiveBranch = branch ?? resolveCurrentBranch(repoRoot);
  const resolvedBase = resolveRef(repoRoot, base);
  const resolvedBranch = resolveRef(repoRoot, effectiveBranch);
  const countText = git(repoRoot, ["rev-list", "--left-right", "--count", `${resolvedBase.resolved}...${resolvedBranch.resolved}`]);
  const [behindText = "0", aheadText = "0"] = countText.split(/\s+/);
  const behind = Number.parseInt(behindText, 10) || 0;
  const ahead = Number.parseInt(aheadText, 10) || 0;
  const cherryLines = (git(repoRoot, ["cherry", resolvedBase.resolved, resolvedBranch.resolved], { allowFailure: true }) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const patchEquivalentCount = cherryLines.filter((line) => line.startsWith("- ")).length;
  const uniqueCommitCount = cherryLines.filter((line) => line.startsWith("+ ")).length;
  const worktrees = parseWorktrees(git(repoRoot, ["worktree", "list", "--porcelain"]));
  const worktree = worktrees.find((item) => item.branch === `refs/heads/${effectiveBranch}`);
  const branchStatus = worktree?.path
    ? git(repoRoot, ["-C", worktree.path, "status", "--short", "--branch"], { allowFailure: true })
    : null;
  const clean = worktree?.path
    ? (git(repoRoot, ["-C", worktree.path, "status", "--porcelain"], { allowFailure: true }) ?? "").trim().length === 0
    : null;
  const shouldNoop = ahead === 0 || (ahead > 0 && uniqueCommitCount === 0);
  const shouldMerge = ahead > 0 && uniqueCommitCount > 0;
  const recommendation = shouldNoop
    ? "already_merged_or_patch_equivalent"
    : shouldMerge
      ? "review_before_merge"
      : "inspect_branch_state";
  const result = {
    checkedAt: new Date().toISOString(),
    repoRoot,
    base: resolvedBase,
    branch: resolvedBranch,
    ahead,
    behind,
    patchEquivalentCount,
    uniqueCommitCount,
    cherryLines,
    worktree: worktree
      ? {
        path: worktree.path,
        clean,
        branchStatus,
      }
      : null,
    recommendation,
    shouldMerge,
    shouldNoop,
  };

  if (reportRoot) {
    ensureDir(reportRoot);
    writeJson(path.join(reportRoot, "branch-conformance.json"), result);
    writeText(path.join(reportRoot, "branch-conformance.md"), renderMarkdown(result));
  }

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reportRoot = options.reportRoot
    ?? path.join(options.repoRoot, "docs", "reports", "ops", "real-green-gate", createRunId(), "branch");
  const result = checkBranchConformance({ ...options, reportRoot });
  console.log(JSON.stringify({
    ...result,
    reportRoot,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
