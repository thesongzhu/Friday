#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TARGETED_TESTS = [
  "test/unit/security/friday-audit-log.test.ts",
  "test/unit/hub/services/friday-hub-audit-log-writer.test.ts",
];

function parseArgs(argv) {
  const explicit = argv.find((entry) => !entry.startsWith("--"))?.trim();
  return {
    repoRoot: explicit ? path.resolve(explicit) : process.cwd(),
    skipTests: argv.includes("--skip-tests"),
  };
}

function fileCheck(repoRoot, relativePath, label) {
  return {
    kind: "file",
    label,
    target: relativePath,
    status: fs.existsSync(path.join(repoRoot, relativePath)) ? "passed" : "failed",
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
      label: "Targeted audit integrity tests",
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
    label: "Targeted audit integrity tests",
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
  const checks = [
    fileCheck(repoRoot, "src/security/friday-audit-log.ts", "Hardened audit log writer"),
    fileCheck(repoRoot, "src/hub/services/friday-hub-audit-log-writer.ts", "Hub audit log wrapper"),
    fileCheck(repoRoot, "test/unit/security/friday-audit-log.test.ts", "Audit log unit coverage"),
    fileCheck(
      repoRoot,
      "test/unit/hub/services/friday-hub-audit-log-writer.test.ts",
      "Hub audit log compatibility coverage",
    ),
    textFragmentCheck(
      repoRoot,
      "src/security/friday-audit-log.ts",
      [
        "const writeLocks = new Map",
        "JSON.stringify(entry) + \"\\n\"",
        "await fs.appendFile",
        "await fs.writeFile",
        "mode: FILE_MODE",
        "id: string;",
        "ts: string;",
        "action: string;",
        "resourceType: string;",
      ],
      "Audit log keeps serialized JSONL writes with canonical record fields",
    ),
    textFragmentCheck(
      repoRoot,
      "docs/TROUBLESHOOTING.md",
      ["audit.jsonl"],
      "Troubleshooting docs expose the audit log location",
    ),
    textFragmentCheck(
      repoRoot,
      "test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts",
      ["audit.jsonl"],
      "E2E parity coverage inspects real audit log output",
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
