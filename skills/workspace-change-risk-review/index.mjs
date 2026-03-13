import path from "node:path";
import {
  findRepoRoot,
  parseGitStatusLines,
  readPackageJson,
  readWorkspaceRoot,
  runCommand,
} from "../_shared/devops-skill-utils.mjs";

const HIGH_RISK_PATTERNS = [
  /package(-lock)?\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /docker/i,
  /compose/i,
  /config/i,
  /schema/i,
  /migration/i,
  /^src\/agent\//,
  /^src\/providers\//,
  /^src\/browser\//,
];

const TEST_PATTERNS = [/test/i, /\.spec\./i, /\.test\./i, /^tests?\//i];

function classifyRisk(changedPaths) {
  const risks = [];
  const testTouched = changedPaths.some((filePath) => TEST_PATTERNS.some((pattern) => pattern.test(filePath)));
  const configTouched = changedPaths.filter((filePath) => HIGH_RISK_PATTERNS.some((pattern) => pattern.test(filePath)));
  const sourceTouched = changedPaths.filter((filePath) =>
    /\.(ts|tsx|js|mjs|jsx|py|sh)$/.test(filePath) && !TEST_PATTERNS.some((pattern) => pattern.test(filePath)),
  );

  if (configTouched.length > 0) {
    risks.push({
      severity: "high",
      title: "High-risk files changed",
      detail: `Sensitive files changed: ${configTouched.slice(0, 6).join(", ")}`,
    });
  }
  if (sourceTouched.length > 0 && !testTouched) {
    risks.push({
      severity: "medium",
      title: "Code changed without matching tests",
      detail: "Source files changed but no obvious test files were touched in the current workspace state.",
    });
  }
  if (changedPaths.length > 20) {
    risks.push({
      severity: "medium",
      title: "Large change surface",
      detail: `${changedPaths.length} files changed. The review surface is broad enough to justify a structured validation pass.`,
    });
  }
  if (risks.length === 0) {
    risks.push({
      severity: "low",
      title: "No obvious structural risk",
      detail: "The current change set looks narrow and does not touch the usual high-risk hotspots.",
    });
  }

  const riskLevel = risks.some((risk) => risk.severity === "high")
    ? "high"
    : risks.some((risk) => risk.severity === "medium")
      ? "medium"
      : "low";

  return { riskLevel, risks };
}

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const gitStatus = await runCommand("git", ["status", "--short"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  const gitDiff = await runCommand("git", ["diff", "--stat", "--compact-summary"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  const packageJson = await readPackageJson(repoRoot);
  const changedEntries = gitStatus.ok ? parseGitStatusLines(gitStatus.stdout) : [];
  const changedPaths = changedEntries.map((entry) => entry.path);
  const { riskLevel, risks } = classifyRisk(changedPaths);
  const recommendedChecks = Object.keys(packageJson?.scripts ?? {}).filter((name) =>
    ["lint", "typecheck", "test", "build"].includes(name),
  );

  return {
    riskLevel,
    summary:
      changedPaths.length === 0
        ? `No uncommitted changes detected in ${path.basename(repoRoot)}.`
        : `Change risk is ${riskLevel} across ${changedPaths.length} file(s) in ${path.basename(repoRoot)}.`,
    risks,
    recommendedChecks,
    details: {
      repoRoot,
      changedFiles: changedEntries,
      diffStat: gitDiff.stdout.trim() || null,
    },
  };
}
