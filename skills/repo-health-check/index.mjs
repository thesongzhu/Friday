import path from "node:path";
import {
  detectPackageManager,
  discoverLogFiles,
  findRepoRoot,
  parseGitStatusLines,
  readPackageJson,
  readWorkspaceRoot,
  runCommand,
  summarizeGitChanges,
} from "../_shared/devops-skill-utils.mjs";

export async function execute(input = {}) {
  const requestedRoot = readWorkspaceRoot(input);
  const repoRoot = await findRepoRoot(requestedRoot);
  const packageJson = await readPackageJson(repoRoot);
  const packageScripts = Object.keys(packageJson?.scripts ?? {});
  const packageManager = packageJson ? detectPackageManager(repoRoot) : null;

  const gitStatus = await runCommand("git", ["status", "--short"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  const gitDiff = await runCommand("git", ["diff", "--stat", "--compact-summary"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  const changedEntries = gitStatus.ok ? parseGitStatusLines(gitStatus.stdout) : [];
  const gitSummary = summarizeGitChanges(changedEntries);
  const logFiles = await discoverLogFiles(repoRoot, { maxFiles: 3 });

  let nextStep = "Review the repo structure and define the first concrete task.";
  let suggestedSkillId = "workspace-change-risk-review";
  if (gitSummary.total > 0) {
    nextStep = "Run workspace-change-risk-review to understand the riskiest changes before building or shipping.";
  } else if (packageScripts.some((script) => ["lint", "test", "build", "typecheck"].includes(script))) {
    nextStep = "Run release-readiness-check to validate the existing checks and catch blockers early.";
    suggestedSkillId = "release-readiness-check";
  } else if (logFiles.length > 0) {
    nextStep = "Run log-error-triage against the detected log files to surface the noisiest failures.";
    suggestedSkillId = "log-error-triage";
  }

  const summary =
    gitSummary.total > 0
      ? `Repo health: ${gitSummary.total} pending change(s) detected in ${path.basename(repoRoot)}. Focus on change risk before running deeper validation.`
      : packageScripts.length > 0
        ? `Repo health: no pending git changes detected in ${path.basename(repoRoot)}. Existing project scripts are available for a readiness pass.`
        : `Repo health: ${path.basename(repoRoot)} is quiet right now. There are no pending git changes and no obvious scripted checks.`;

  return {
    summary,
    nextStep,
    details: {
      repoRoot,
      packageManager,
      packageScripts,
      git: {
        ok: gitStatus.ok,
        changedCount: gitSummary.changedCount,
        untrackedCount: gitSummary.untrackedCount,
        changedPaths: gitSummary.changedPaths.slice(0, 20),
        diffStat: gitDiff.stdout.trim() || null,
      },
      logFiles,
      suggestedSkillId,
    },
  };
}
