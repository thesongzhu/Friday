#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message, exitCode = 1) {
  throw Object.assign(new Error(message), { exitCode });
}

function resolveRepoRoot() {
  const explicit = process.env.FRIDAY_RELEASE_PREFLIGHT_REPO_ROOT?.trim() || process.argv[2];
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function resolveTag() {
  const tag = (process.env.FRIDAY_RELEASE_TAG ?? "").trim();
  if (!tag) {
    fail("FRIDAY_RELEASE_TAG is required");
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+([+-].*)?$/.test(tag)) {
    fail(`Invalid FRIDAY_RELEASE_TAG "${tag}"`);
  }
  return tag;
}

function readPackageVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
    fail(`package.json at ${pkgPath} is missing version`);
  }
  return pkg.version.trim();
}

function requireFile(filePath, label, failures) {
  if (fs.existsSync(filePath)) {
    return;
  }
  failures.push(`${label} (${filePath})`);
}

function runCrossPlatformInputs(repoRoot) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "check-friday-cross-platform-release-inputs.sh");
  const result = spawnSync("bash", [scriptPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FRIDAY_CROSS_PLATFORM_CHECK_MODE: "ci-public",
    },
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const repoRoot = resolveRepoRoot();
const reportPath = path.join(
  process.env.FRIDAY_RELEASE_PREFLIGHT_ARTIFACT_DIR?.trim() || path.join(repoRoot, "artifacts", "release-preflight"),
  "report.json",
);

const failures = [];
const tag = resolveTag();
const packageVersion = readPackageVersion(repoRoot);
const tagVersion = tag.replace(/^v/, "");

if (tagVersion !== packageVersion) {
  failures.push(`tag ${tag} does not match package.json version ${packageVersion}`);
}

for (const [relativePath, label] of [
  ["packaging/homebrew/Casks/friday.rb.template", "Homebrew cask template exists"],
  ["scripts/ops/release-friday-companion-app.sh", "macOS companion release script exists"],
  ["scripts/ops/build-friday-source-distribution.sh", "source distribution build script exists"],
  ["scripts/ops/write-friday-release-manifest.mjs", "release manifest generator exists"],
]) {
  requireFile(path.join(repoRoot, relativePath), label, failures);
}

// R1 release-closure: `FRIDAY_RELEASE_MODE=source-only` skips the iOS/Android/
// Windows/macOS cross-platform input check because a source/npm-only release
// (e.g. 1.0.1) does not promise any of those distribution surfaces. The
// default mode (unset or "source-and-macos") keeps the existing behavior.
const releaseMode = (process.env.FRIDAY_RELEASE_MODE ?? "").trim() || "source-and-macos";
const skipCrossPlatform = releaseMode === "source-only";

let crossPlatformCheck;
if (skipCrossPlatform) {
  crossPlatformCheck = {
    status: "skipped_source_only",
    exitCode: null,
    stdout: "",
    stderr: "",
  };
} else {
  const crossPlatform = runCrossPlatformInputs(repoRoot);
  if (crossPlatform.status !== 0) {
    // Cross-platform inputs are advisory — missing iOS/Android/Windows
    // credentials should not block npm + source releases.
    console.warn(`[preflight] cross-platform release inputs check returned code ${String(crossPlatform.status)} (advisory, not blocking)`);
  }
  crossPlatformCheck = {
    status: crossPlatform.status === 0 ? "passed" : "failed",
    exitCode: crossPlatform.status,
    stdout: crossPlatform.stdout.trim(),
    stderr: crossPlatform.stderr.trim(),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  tag,
  packageVersion,
  releaseMode,
  status: failures.length === 0 ? "passed" : "failed",
  failures,
  checks: {
    crossPlatformReleaseInputs: crossPlatformCheck,
  },
};

writeReport(reportPath, report);

if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  // crossPlatformCheck.exitCode is null when the check was skipped; treat
  // that as a non-78 exit so the workflow does not see "neutral".
  process.exit(crossPlatformCheck.exitCode === 78 ? 78 : 1);
}

console.log(JSON.stringify(report, null, 2));
