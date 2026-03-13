import path from "node:path";
import {
  detectPackageManager,
  findRepoRoot,
  readPackageJson,
  readWorkspaceRoot,
  runPackageScript,
  truncate,
} from "../_shared/devops-skill-utils.mjs";

const CHECK_ORDER = ["lint", "typecheck", "test", "build"];

export async function execute(input = {}) {
  const repoRoot = await findRepoRoot(readWorkspaceRoot(input));
  const packageJson = await readPackageJson(repoRoot);
  const scripts = packageJson?.scripts ?? {};
  const selectedChecks = CHECK_ORDER.filter((scriptName) => typeof scripts[scriptName] === "string");

  if (selectedChecks.length === 0) {
    return {
      readiness: "blocked",
      summary: `No lint/test/build-style scripts were detected in ${path.basename(repoRoot)}.`,
      checks: [],
      blockers: [
        "The repo does not expose standard package-manager scripts for lint, typecheck, test, or build.",
      ],
      details: {
        repoRoot,
        packageManager: packageJson ? detectPackageManager(repoRoot) : null,
        availableScripts: Object.keys(scripts),
      },
    };
  }

  const checks = [];
  for (const scriptName of selectedChecks) {
    const result = await runPackageScript(repoRoot, scriptName);
    checks.push({
      name: scriptName,
      command: `${result.manager} run ${scriptName}`,
      status: result.ok ? "passed" : result.timedOut ? "timed_out" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutTail: truncate(result.stdout.trim(), 400),
      stderrTail: truncate(result.stderr.trim(), 400),
    });
  }

  const blockers = checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.name} ${check.status}${check.exitCode >= 0 ? ` (exit ${String(check.exitCode)})` : ""}`);

  return {
    readiness: blockers.length === 0 ? "ready" : "blocked",
    summary:
      blockers.length === 0
        ? `Release readiness passed for ${path.basename(repoRoot)}. ${checks.length} check(s) completed successfully.`
        : `Release readiness is blocked in ${path.basename(repoRoot)}. ${blockers.length} check(s) failed or timed out.`,
    checks,
    blockers,
    details: {
      repoRoot,
      packageManager: detectPackageManager(repoRoot),
      availableScripts: Object.keys(scripts),
    },
  };
}
