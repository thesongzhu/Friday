#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TARGETED_TESTS = [
  "test/unit/security/friday-secret-ref.test.ts",
  "test/unit/channels/friday-channel-registry-health.test.ts",
  "test/unit/api/http/routes/friday-channel-routes.test.ts",
  "test/unit/providers/api/friday-provider-routes.test.ts",
];

function parseArgs(argv) {
  const explicit = argv.find((entry) => !entry.startsWith("--"))?.trim();
  return {
    repoRoot: explicit ? path.resolve(explicit) : process.cwd(),
    skipTests: argv.includes("--skip-tests"),
  };
}

function readPackageJson(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function fileCheck(repoRoot, relativePath, label) {
  return {
    kind: "file",
    label,
    target: relativePath,
    status: fs.existsSync(path.join(repoRoot, relativePath)) ? "passed" : "failed",
  };
}

function scriptCheck(pkg, name) {
  return {
    kind: "package-script",
    label: `package.json script "${name}"`,
    target: name,
    status: typeof pkg.scripts?.[name] === "string" && pkg.scripts[name].trim().length > 0
      ? "passed"
      : "failed",
  };
}

function textFragmentCheck(repoRoot, relativePath, fragments, label) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      kind: "source-fragment",
      label,
      target: relativePath,
      status: "failed",
      missingFragments: fragments,
    };
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  const missingFragments = fragments.filter((fragment) => !content.includes(fragment));
  return {
    kind: "source-fragment",
    label,
    target: relativePath,
    status: missingFragments.length === 0 ? "passed" : "failed",
    missingFragments,
  };
}

function runTargetedTests(repoRoot, skipTests) {
  if (skipTests) {
    return {
      kind: "command",
      label: "Targeted security doctor tests",
      target: TARGETED_TESTS.join(", "),
      status: "skipped",
      command: "npm test -- --run ...",
    };
  }

  const result = spawnSync("npm", ["test", "--", "--run", ...TARGETED_TESTS], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  return {
    kind: "command",
    label: "Targeted security doctor tests",
    target: TARGETED_TESTS.join(", "),
    status: result.status === 0 ? "passed" : "failed",
    command: `npm test -- --run ${TARGETED_TESTS.join(" ")}`,
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function main() {
  const { repoRoot, skipTests } = parseArgs(process.argv.slice(2));
  const pkg = readPackageJson(repoRoot);

  const checks = [
    fileCheck(repoRoot, "src/security/friday-secret-ref.ts", "Secret ref resolver source"),
    fileCheck(repoRoot, "src/security/friday-audit-log.ts", "Audit log source"),
    fileCheck(repoRoot, "scripts/ops/friday-local-runtime-doctor.mjs", "Runtime doctor script"),
    fileCheck(repoRoot, "src/api/http/routes/friday-provider-routes.ts", "Provider routes"),
    fileCheck(repoRoot, "src/api/http/routes/friday-channel-routes.ts", "Channel routes"),
    scriptCheck(pkg, "ops:doctor:runtime"),
    scriptCheck(pkg, "check:provider-reliability"),
    scriptCheck(pkg, "check:desktop-release-pipeline"),
    textFragmentCheck(
      repoRoot,
      "src/security/friday-secret-ref.ts",
      ["secret://", "env:", "file:", "command:"],
      "SecretRef supports stored/env/file/command schemes",
    ),
    textFragmentCheck(
      repoRoot,
      "src/agent/runtime/friday-agent-runtime.ts",
      ["agent.run.awaiting_tool_approval", "agent.run.capability_grant_used", "grantId"],
      "Capability grant evidence is wired into the agent runtime",
    ),
    textFragmentCheck(
      repoRoot,
      "src/api/http/routes/friday-provider-routes.ts",
      ['operationId: "providers.doctor"'],
      "Provider doctor route is published",
    ),
    textFragmentCheck(
      repoRoot,
      "src/api/http/routes/friday-channel-routes.ts",
      ['operationId: "channels.list"', 'operationId: "channels.get"'],
      "Channel supervisor routes are published",
    ),
    textFragmentCheck(
      repoRoot,
      "docs/current-source-of-truth.md",
      ["/v1/channels*", "`preflight`"],
      "Source of truth documents channel and preflight surfaces",
    ),
    runTargetedTests(repoRoot, skipTests),
  ];

  const failed = checks.filter((check) => check.status === "failed");
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    status: failed.length === 0 ? "passed" : "failed",
    summary: {
      passed: checks.filter((check) => check.status === "passed").length,
      skipped: checks.filter((check) => check.status === "skipped").length,
      failed: failed.length,
    },
    checks,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
