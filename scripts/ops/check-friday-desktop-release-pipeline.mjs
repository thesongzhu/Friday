#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

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

function isTrue(value) {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function resolveRepoPath(repoRoot, value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function latestMtimeMs(targetPath) {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = 0;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const childPath = path.join(targetPath, entry.name);
    latest = Math.max(latest, latestMtimeMs(childPath));
  }
  return latest || stat.mtimeMs;
}

function readArtifactFreshnessSpecs(repoRoot) {
  const specPath = process.env.FRIDAY_CLIENT_SHIP_ARTIFACTS_JSON?.trim();
  if (!specPath) {
    return [];
  }

  const absolutePath = resolveRepoPath(repoRoot, specPath);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("artifact freshness spec must be a JSON array");
  }
  return parsed;
}

function artifactFreshnessCheck(repoRoot, spec) {
  const name = typeof spec?.name === "string" && spec.name.trim()
    ? spec.name.trim()
    : String(spec?.artifact ?? "unnamed artifact");
  const artifact = typeof spec?.artifact === "string" ? spec.artifact.trim() : "";
  const sources = Array.isArray(spec?.sources)
    ? spec.sources.filter((source) => typeof source === "string" && source.trim()).map((source) => source.trim())
    : [];

  if (!artifact || sources.length === 0) {
    return {
      kind: "artifact-freshness",
      label: `Fresh client artifact "${name}"`,
      target: artifact || name,
      status: "failed",
      stderr: "artifact freshness specs require an artifact path and at least one source path",
    };
  }

  const artifactPath = resolveRepoPath(repoRoot, artifact);
  if (!fs.existsSync(artifactPath)) {
    return {
      kind: "artifact-freshness",
      label: `Fresh client artifact "${name}"`,
      target: artifact,
      status: "failed",
      stderr: "artifact is missing",
    };
  }

  const missingSource = sources.find((source) => !fs.existsSync(resolveRepoPath(repoRoot, source)));
  if (missingSource) {
    return {
      kind: "artifact-freshness",
      label: `Fresh client artifact "${name}"`,
      target: artifact,
      status: "failed",
      stderr: `source path is missing: ${missingSource}`,
    };
  }

  const artifactMtime = latestMtimeMs(artifactPath);
  const newestSource = sources
    .map((source) => ({ source, mtimeMs: latestMtimeMs(resolveRepoPath(repoRoot, source)) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

  if (newestSource && newestSource.mtimeMs > artifactMtime) {
    return {
      kind: "artifact-freshness",
      label: `Fresh client artifact "${name}"`,
      target: artifact,
      status: "failed",
      stderr: `source newer than artifact: ${newestSource.source}`,
    };
  }

  return {
    kind: "artifact-freshness",
    label: `Fresh client artifact "${name}"`,
    target: artifact,
    status: "passed",
  };
}

function artifactFreshnessChecks(repoRoot) {
  const requireFreshArtifacts = isTrue(process.env.FRIDAY_CLIENT_SHIP_REQUIRE_FRESH_ARTIFACTS);
  const specPath = process.env.FRIDAY_CLIENT_SHIP_ARTIFACTS_JSON?.trim();

  if (!specPath) {
    return [{
      kind: "artifact-freshness",
      label: "Fresh client artifact manifest",
      target: "FRIDAY_CLIENT_SHIP_ARTIFACTS_JSON",
      status: requireFreshArtifacts ? "failed" : "skipped",
      stderr: requireFreshArtifacts
        ? "FRIDAY_CLIENT_SHIP_REQUIRE_FRESH_ARTIFACTS is set but no artifact freshness manifest was provided"
        : "",
    }];
  }

  try {
    const specs = readArtifactFreshnessSpecs(repoRoot);
    if (specs.length === 0) {
      return [{
        kind: "artifact-freshness",
        label: "Fresh client artifact manifest",
        target: specPath,
        status: requireFreshArtifacts ? "failed" : "skipped",
        stderr: requireFreshArtifacts ? "artifact freshness manifest is empty" : "",
      }];
    }
    return specs.map((spec) => artifactFreshnessCheck(repoRoot, spec));
  } catch (error) {
    return [{
      kind: "artifact-freshness",
      label: "Fresh client artifact manifest",
      target: specPath,
      status: "failed",
      stderr: error instanceof Error ? error.message : String(error),
    }];
  }
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

function runDesignContractCheck(repoRoot) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "check-friday-client-design-contract.mjs");
  if (!fs.existsSync(scriptPath)) {
    return {
      kind: "command",
      label: "Client design contract check",
      target: "scripts/ops/check-friday-client-design-contract.mjs",
      status: "failed",
      exitCode: 1,
      stderr: "client design contract script is missing",
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  return {
    kind: "command",
    label: "Client design contract check",
    target: "scripts/ops/check-friday-client-design-contract.mjs",
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function runNativeActionClosureCheck(repoRoot) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "check-friday-native-action-closure.mjs");
  if (!fs.existsSync(scriptPath)) {
    return {
      kind: "command",
      label: "Native action closure check",
      target: "scripts/ops/check-friday-native-action-closure.mjs",
      status: "failed",
      exitCode: 1,
      stderr: "native action closure script is missing",
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  return {
    kind: "command",
    label: "Native action closure check",
    target: "scripts/ops/check-friday-native-action-closure.mjs",
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function runIosDesignDestinationCaptureContractCheck(repoRoot) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "check-friday-ios-design-destination-capture-contract.mjs");
  if (!fs.existsSync(scriptPath)) {
    return {
      kind: "command",
      label: "iOS selected design destination capture contract check",
      target: "scripts/ops/check-friday-ios-design-destination-capture-contract.mjs",
      status: "failed",
      exitCode: 1,
      stderr: "iOS selected design destination capture contract script is missing",
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  return {
    kind: "command",
    label: "iOS selected design destination capture contract check",
    target: "scripts/ops/check-friday-ios-design-destination-capture-contract.mjs",
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function runDesktopGuiSmokeContractCheck(repoRoot) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "check-friday-desktop-gui-smoke-contract.mjs");
  if (!fs.existsSync(scriptPath)) {
    return {
      kind: "command",
      label: "Desktop GUI smoke contract check",
      target: "scripts/ops/check-friday-desktop-gui-smoke-contract.mjs",
      status: "failed",
      exitCode: 1,
      stderr: "desktop GUI smoke contract script is missing",
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  return {
    kind: "command",
    label: "Desktop GUI smoke contract check",
    target: "scripts/ops/check-friday-desktop-gui-smoke-contract.mjs",
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * CORE-A round-3 Lane C (finding #4): static contract that the release artifacts PACKAGE the Rust
 * agent-run WS server (both bins + the launchd plist template) and that the installer LAUNCHES +
 * ENROLLS it. Before this, the DMG / source-dist / installer had ZERO hub_agent_run refs, so a clean
 * install shipped no Rust server and every agent-run / session create+append hit a fail-closed 503.
 */
function rustAgentRunPackagingContractChecks(repoRoot) {
  const readText = (rel) => {
    const abs = path.join(repoRoot, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  };
  const check = (label, target, ok, detail) => ({
    kind: "rust-agent-run-packaging-contract",
    label,
    target,
    status: ok ? "passed" : "failed",
    ...(ok ? {} : { stderr: detail ?? "contract assertion failed" }),
  });
  const containsAll = (text, tokens) => text != null && tokens.every((t) => text.includes(t));

  const stagingHelperRel = "scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh";
  const plistRel = "scripts/ops/launchd/com.friday.rust-agent-run-ws-server.plist";
  const dmgRel = "scripts/ops/build-friday-companion-dmg.sh";
  const srcDistRel = "scripts/ops/build-friday-source-distribution.sh";
  const installerRel = "scripts/ops/install-friday-launchagent.sh";

  const stagingHelper = readText(stagingHelperRel);
  const plist = readText(plistRel);
  const dmg = readText(dmgRel);
  const srcDist = readText(srcDistRel);
  const installer = readText(installerRel);

  return [
    check(
      "Rust agent-run plist template pins the server args",
      plistRel,
      containsAll(plist, ["__RUST_SERVER_BIN__", "--workspace", "--db", "--port", "--owner", "--store-dir"]),
      "the launchd plist template must pin --workspace/--db/--port/--owner/--store-dir",
    ),
    check(
      "Staging helper builds both bins + stages the plist + writes a manifest",
      stagingHelperRel,
      containsAll(stagingHelper, [
        "cargo build --release --bin",
        "hub_agent_run_server",
        "hub_agent_run_enroll",
        "PLIST_TEMPLATE",
        "payload-manifest.json",
      ]),
      "the staging helper must cargo-build both bins, stage the plist template, and write payload-manifest.json",
    ),
    check(
      "DMG build stages the Rust agent-run payload",
      dmgRel,
      containsAll(dmg, ["stage-rust-agent-run-ws-server-payload.sh"]),
      "build-friday-companion-dmg.sh must invoke the Rust agent-run staging helper",
    ),
    check(
      "Source distribution stages the Rust agent-run payload",
      srcDistRel,
      containsAll(srcDist, ["stage-rust-agent-run-ws-server-payload.sh"]),
      "build-friday-source-distribution.sh must invoke the Rust agent-run staging helper",
    ),
    check(
      "Installer launches + enrolls the Rust agent-run WS server",
      installerRel,
      containsAll(installer, [
        "com.friday.rust-agent-run-ws-server",
        "hub_agent_run_enroll",
        "launchctl bootstrap",
        "plutil -lint",
        "master.key",
      ]),
      "install-friday-launchagent.sh must fill+lint the plist, enroll the peer, and launchctl bootstrap the WS server label",
    ),
  ];
}

const repoRoot = resolveRepoRoot();
const pkg = readPackageJson(repoRoot);

const checks = [
  ...[
    ["apps/macos/FridayCompanion/Package.swift", "macOS companion Swift package"],
    ["apps/macos/FridayHubConsole/Package.swift", "macOS Hub Console Swift package"],
    ["apps/macos/FridayHubConsole/Info.plist", "Hub Console app bundle Info.plist"],
    ["apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift", "Hub Console app entrypoint"],
    ["scripts/ops/release-friday-companion-app.sh", "Companion release script"],
    ["scripts/ops/build-friday-hub-console-app.sh", "Hub Console app bundle build script"],
    ["scripts/ops/verify-friday-hub-console-app.sh", "Hub Console app bundle verify script"],
    ["scripts/ops/check-friday-client-design-contract.mjs", "Client design contract check"],
    ["scripts/ops/check-friday-native-action-closure.mjs", "Native action closure check"],
    ["scripts/ops/check-friday-ios-t2-surface-contract.mjs", "iOS T2 surface contract check"],
    ["scripts/ops/check-friday-ios-action-accessibility-map.mjs", "iOS action accessibility map check"],
    ["scripts/ops/check-friday-ios-design-destination-capture-contract.mjs", "iOS selected design destination capture contract check"],
    ["scripts/ops/friday-ios-design-destination-capture.sh", "iOS selected design destination capture proof script"],
    ["scripts/ops/friday-action-runtime-evidence-bundle.sh", "Native action-runtime evidence bundle proof script"],
    ["scripts/ops/check-friday-desktop-gui-smoke-contract.mjs", "Desktop GUI smoke contract check"],
    ["scripts/ops/friday-desktop-gui-smoke-proof.sh", "Desktop GUI smoke proof script"],
    ["scripts/ops/friday-macos-live-write-read-capture.sh", "macOS live write-read capture proof script"],
    ["scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh", "UI/device live write-read bundle proof script"],
    ["scripts/ops/check-friday-product-auto-followup-contract.mjs", "Product auto-followup contract check"],
    ["scripts/ops/friday-product-auto-followup-proof.sh", "Product auto-followup live proof script"],
    ["scripts/ops/check-friday-desktop-approval-relay-contract.mjs", "Desktop approval relay contract check"],
    ["scripts/ops/friday-desktop-approval-relay-proof.sh", "Desktop approval relay live proof script"],
    ["scripts/ops/friday-mobile-approval-approve-proof.sh", "Mobile approval approve live proof script"],
    ["apps/friday-ios/Package.swift", "iOS Swift package"],
    ["apps/friday-ios/Info.plist", "iOS app Info.plist"],
    ["apps/friday-ios/build-sim.sh", "iOS simulator build script"],
    ["apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift", "iOS app entrypoint"],
    ["apps/friday-android/settings.gradle.kts", "Android Gradle settings"],
    ["apps/friday-android/app/build.gradle.kts", "Android app Gradle module"],
    ["apps/friday-android/app/src/main/AndroidManifest.xml", "Android app manifest"],
    ["apps/friday-android/build-emu.sh", "Android emulator build script"],
    ["scripts/ops/check-friday-companion-release-env.sh", "Companion release env check"],
    ["scripts/ops/build-friday-companion-dmg.sh", "DMG build script"],
    ["scripts/ops/build-friday-source-distribution.sh", "Source distribution build script"],
    ["scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh", "Rust agent-run WS server packaging staging helper"],
    ["scripts/ops/launchd/com.friday.rust-agent-run-ws-server.plist", "Rust agent-run WS server launchd plist template"],
    ["scripts/ops/launchd/build-and-install-rust-agent-run-ws-server.sh", "Rust agent-run WS server cutover tool"],
    ["scripts/ops/build-friday-sparkle-appcast.sh", "Sparkle appcast build script"],
    ["scripts/ops/publish-friday-homebrew-cask.sh", "Homebrew publication script"],
    ["scripts/ops/write-friday-release-manifest.mjs", "Release manifest generator"],
    ["packaging/homebrew/Casks/friday.rb.template", "Homebrew cask template"],
    ["docs/ops/friday-companion-release-macos.md", "macOS release runbook"],
  ].map(([relativePath, label]) => fileCheck(repoRoot, relativePath, label)),
  ...[
    "check:companion:release-env",
    "check:client-ship-gate",
    "check:cross-platform-client-ship-gate",
    "check:client-design-contract",
    "check:native-action-closure",
    "check:ios-t2-surface-contract",
    "check:ios-action-accessibility-map",
    "check:ios-design-destination-capture-contract",
    "proof:ios:design-destinations",
    "proof:action-runtime:evidence-bundle",
    "check:desktop-gui-smoke-contract",
    "proof:desktop:gui-smoke",
    "proof:desktop:live-write-read",
    "proof:ui-device:live-write-read-bundle",
    "check:product-auto-followup-contract",
    "proof:product:auto-followup",
    "check:desktop-approval-relay-contract",
    "proof:desktop:approval-relay",
    "proof:mobile:approval-approve",
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
  runDesignContractCheck(repoRoot),
  runNativeActionClosureCheck(repoRoot),
  runIosDesignDestinationCaptureContractCheck(repoRoot),
  runDesktopGuiSmokeContractCheck(repoRoot),
  ...rustAgentRunPackagingContractChecks(repoRoot),
  ...artifactFreshnessChecks(repoRoot),
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
