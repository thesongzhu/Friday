#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function resolveRepoRoot() {
  const explicit = process.argv[2]?.trim() || process.env.FRIDAY_DESKTOP_RELEASE_REPO_ROOT?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function readPackageJson(repoRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
}

function fileCheck(repoRoot, relativePath, label) {
  const absolutePath = path.join(repoRoot, relativePath);
  return {
    kind: "file",
    label,
    target: relativePath,
    status: fs.existsSync(absolutePath) ? "passed" : "failed",
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

function runEnvCheck(repoRoot) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "check-friday-companion-release-env.sh");
  if (!fs.existsSync(scriptPath)) {
    return {
      kind: "command",
      label: "Companion release environment check",
      target: "scripts/ops/check-friday-companion-release-env.sh",
      status: "failed",
      exitCode: 1,
      stderr: "release env check script is missing",
    };
  }

  const result = spawnSync("bash", [scriptPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FRIDAY_MACOS_RELEASE_MODE: "local",
    },
  });

  return {
    kind: "command",
    label: "Companion release environment check",
    target: "scripts/ops/check-friday-companion-release-env.sh",
    status: result.status === 0
      ? "passed"
      : result.status === 78
        ? "skipped"
        : "failed",
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

const repoRoot = resolveRepoRoot();
const pkg = readPackageJson(repoRoot);

const checks = [
  ...[
    ["apps/macos/FridayCompanion/Package.swift", "macOS companion Swift package"],
    ["apps/macos/FridayHubConsole/Package.swift", "macOS Hub Console Swift package"],
    ["apps/macos/FridayHubConsole/Info.plist", "Hub Console app bundle Info.plist"],
    ["scripts/ops/release-friday-companion-app.sh", "Companion release script"],
    ["scripts/ops/build-friday-hub-console-app.sh", "Hub Console app bundle build script"],
    ["scripts/ops/verify-friday-hub-console-app.sh", "Hub Console app bundle verify script"],
    ["apps/friday-ios/build-sim.sh", "iOS simulator build script"],
    ["apps/friday-android/build-emu.sh", "Android emulator build script"],
    ["scripts/ops/check-friday-companion-release-env.sh", "Companion release env check"],
    ["scripts/ops/build-friday-companion-dmg.sh", "DMG build script"],
    ["scripts/ops/build-friday-sparkle-appcast.sh", "Sparkle appcast build script"],
    ["scripts/ops/publish-friday-homebrew-cask.sh", "Homebrew publication script"],
    ["scripts/ops/write-friday-release-manifest.mjs", "Release manifest generator"],
    ["packaging/homebrew/Casks/friday.rb.template", "Homebrew cask template"],
    ["docs/ops/friday-companion-release-macos.md", "macOS release runbook"],
  ].map(([relativePath, label]) => fileCheck(repoRoot, relativePath, label)),
  ...[
    "check:companion:release-env",
    "check:client-ship-gate",
    "build:companion:native",
    "build:hub-console:native",
    "build:ios:sim",
    "build:android:emu",
    "build:companion:dmg",
    "build:companion:appcast",
    "publish:homebrew:cask",
    "release:manifest",
    "release:companion:local",
    "release:companion:notarize",
    "verify:hub-console:native",
  ].map((name) => scriptCheck(pkg, name)),
  runEnvCheck(repoRoot),
];

const failedChecks = checks.filter((check) => check.status === "failed");
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  status: failedChecks.length > 0 ? "failed" : "passed",
  summary: {
    passed: checks.filter((check) => check.status === "passed").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
    failed: failedChecks.length,
  },
  checks,
};

console.log(JSON.stringify(report, null, 2));
process.exit(failedChecks.length > 0 ? 1 : 0);
