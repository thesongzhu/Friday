import { readFileSync } from "node:fs";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findRepoRoot,
  parseGitStatusLines,
  readPackageJson,
  readWorkspaceRoot,
  runCommand,
} from "../_shared/devops-skill-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const diffReviewChecklist = readFileSync(join(__dirname, "references/diff-review-checklist.md"), "utf-8");

const HOTSPOT_PATTERNS = [
  { severity: "high", title: "Agent runtime boundary touched", pattern: /^src\/agent\// },
  { severity: "high", title: "Browser runtime touched", pattern: /^src\/browser\// },
  { severity: "high", title: "System control plane touched", pattern: /^src\/system\// },
  { severity: "medium", title: "Skill surface changed", pattern: /^skills\// },
  { severity: "medium", title: "UI surface changed", pattern: /(^ui\/|\.tsx?$)/ },
  { severity: "medium", title: "Config or lockfile changed", pattern: /(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|docker|compose|config)/i },
];

const TEST_PATTERNS = [/test/i, /\.spec\./i, /\.test\./i, /^tests?\//i];

function buildFindings(changedPaths) {
  const findings = [];
  for (const hotspot of HOTSPOT_PATTERNS) {
    const hits = changedPaths.filter((filePath) => hotspot.pattern.test(filePath));
    if (hits.length > 0) {
      findings.push({
        severity: hotspot.severity,
        title: hotspot.title,
        detail: hits.slice(0, 6).join(", "),
      });
    }
  }
  const sourceTouched = changedPaths.some((filePath) =>
    /\.(ts|tsx|js|mjs|jsx|py|sh)$/.test(filePath) && !TEST_PATTERNS.some((pattern) => pattern.test(filePath)),
  );
  const testsTouched = changedPaths.some((filePath) => TEST_PATTERNS.some((pattern) => pattern.test(filePath)));
  if (sourceTouched && !testsTouched) {
    findings.push({
      severity: "medium",
      title: "Source changes without obvious matching tests",
      detail: "Code changed in the workspace, but the current diff does not include obvious unit, integration, or e2e coverage updates.",
    });
  }
  if (changedPaths.length > 25) {
    findings.push({
      severity: "medium",
      title: "Broad review surface",
      detail: `${String(changedPaths.length)} files changed, so this diff likely needs a structured review and release gate pass.`,
    });
  }
  if (findings.length === 0) {
    findings.push({
      severity: "low",
      title: "Narrow diff surface",
      detail: "The current diff looks narrow and does not touch the usual high-risk hotspots.",
    });
  }
  return findings;
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
  const changedEntries = gitStatus.ok ? parseGitStatusLines(gitStatus.stdout) : [];
  const changedPaths = changedEntries.map((entry) => entry.path);
  const findings = buildFindings(changedPaths);
  const highestSeverity = findings.some((finding) => finding.severity === "high")
    ? "high"
    : findings.some((finding) => finding.severity === "medium")
      ? "medium"
      : "low";
  const packageJson = await readPackageJson(repoRoot);
  const recommendedChecks = Object.keys(packageJson?.scripts ?? {}).filter((name) =>
    ["lint", "typecheck", "test", "build"].includes(name),
  );

  return {
    summary: changedPaths.length === 0
      ? `Workspace diff review: no uncommitted changes detected in ${path.basename(repoRoot)}.`
      : `Workspace diff review: ${String(changedPaths.length)} file(s) changed with ${highestSeverity} structural review pressure.`,
    nextStep: changedPaths.length === 0
      ? "There is no active diff to review yet."
      : findings[0]?.severity === "high"
        ? `Inspect this hotspot first: ${findings[0].title}.`
        : "Run release-readiness-check or sync docs before landing the diff.",
    checklist: diffReviewChecklist,
    details: {
      repoRoot,
      highestSeverity,
      changedFiles: changedEntries,
      diffStat: gitDiff.stdout.trim() || null,
      findings,
      recommendedChecks,
      suggestedSkillId: changedPaths.length > 0 ? "release-doc-sync" : "release-readiness-check",
    },
  };
}
