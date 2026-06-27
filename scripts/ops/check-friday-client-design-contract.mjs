#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function resolveRepoRoot() {
  const explicit = process.argv[2]?.trim() || process.env.FRIDAY_CLIENT_DESIGN_REPO_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function readText(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function hasCase(source, name) {
  return new RegExp(`\\bcase\\s+${name}\\b`).test(source);
}

function hasString(source, value) {
  return source.includes(value);
}

function checkSourceSet(repoRoot, checks) {
  return checks.map((check) => {
    const paths = check.paths ?? [check.path];
    const source = paths.map((target) => readText(repoRoot, target)).join("\n");
    const missing = [];
    for (const item of check.requiredCases ?? []) {
      if (!hasCase(source, item)) missing.push(`case ${item}`);
    }
    for (const item of check.requiredStrings ?? []) {
      if (!hasString(source, item)) missing.push(item);
    }
    return {
      label: check.label,
      target: paths.join(" + "),
      status: missing.length === 0 ? "passed" : "failed",
      missing,
    };
  });
}

const repoRoot = resolveRepoRoot();

// Locked, operator-confirmed design baseline from:
//   ~/Desktop/friday-design-handoff-20260602/saved/mobile-selection.json
//   ~/Desktop/friday-design-handoff-20260602/saved/desktop-selection.json
// This CI checker intentionally avoids depending on that machine-local path. It captures only
// durable contract keys whose absence would make the current client drift from the selected design:
// mobile command-sheet destinations, desktop three-pane nav destinations, and render-proof coverage.
const checks = checkSourceSet(repoRoot, [
  {
    label: "iOS command sheet covers selected mobile destinations",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
      "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift",
    ],
    requiredCases: [
      "home",
      "session",
      "contextPassport",
      "tokenLedger",
      "shareIntake",
      "voice",
      "pairing",
      "needsMe",
      "memory",
      "platform",
      "activity",
      "workflows",
      "settings",
    ],
    requiredStrings: [
      "Command Sheet",
      "Route coverage only",
      "Provider Workspace",
      "Device Pairing",
      "destination == .home ? \"Friday\" : destination.title",
      "friday.home.selected-design-intro",
      "friday.home.selected-hero-pet",
    ],
  },
  {
    label: "macOS nav rail covers selected desktop Hub Console destinations",
    paths: [
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift",
      "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift",
    ],
    requiredCases: [
      "operations",
      "chat",
      "providerAdmin",
      "parity",
      "pairingProvisioning",
      "workflow",
      "channels",
      "diagnostics",
      "recovery",
      "memory",
      "tokenLedger",
      "skills",
      "media",
      "settings",
      "evidence",
    ],
    requiredStrings: [
      "Operations Overview",
      "Friday Chat",
      "Provider Admin",
      "Provider Parity",
      "Workflow Builder",
      "Channels",
      "Diagnostics",
      "Recovery",
      "Memory",
      "Token Ledger",
      "Skills / Tools",
      "Media / Link",
      "Settings",
      "Evidence Search",
      "var isBuilt: Bool { contract.routeBuilt }",
    ],
  },
  {
    label: "macOS projection screen keeps NO-GO and refs-only desktop surfaces visible",
    path: "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
    requiredCases: [
      "diagnostics",
      "recovery",
      "memory",
      "tokenLedger",
      "skills",
      "media",
      "settings",
    ],
    requiredStrings: [
      "NO-GO visible",
      "never estimates spend",
      "Signing-key custody is never held by the app",
      "this screen does not execute tools",
      "Bounded Timeline Pages",
      "Transcript Browser",
      "Memory Review Evidence",
      "Pages are read-only timeline windows",
      "does not expose raw provider bodies",
      "cannot confirm, reject, or grant memory authority",
      ],
  },
  {
    label: "macOS pairing provisioning keeps zero-config path and operator ceremony truth visible",
    path: "apps/macos/FridayHubConsole/Sources/FridayHubConsole/PairingProvisioningScreen.swift",
    requiredStrings: [
      "Provisioning Path",
      "no app mint",
      "PairAck",
      "operator CLI ceremonies",
      "no-heredoc command",
      "Hub DB projection",
      "friday.desktop.pairing-provisioning-path",
    ],
  },
  {
    label: "macOS render proof covers selected desktop destinations",
    path: "apps/macos/FridayHubConsole/Sources/FridayHubConsole/StateRenderProof.swift",
    requiredStrings: [
      "diagnostics-loaded-mock",
      "recovery-loaded-mock",
      "memory-loaded-mock",
      "token-ledger-loaded-mock",
      "pairing-provisioning-honest-empty",
      "skills-loaded-mock",
      "media-loaded-mock",
      "settings-loaded-mock",
    ],
  },
]);

const failed = checks.filter((check) => check.status === "failed");
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  truthLabel: "operator_confirmed_design_contract_static_guard_not_runtime_pass",
  status: failed.length === 0 ? "passed" : "failed",
  checks,
  caveat: "This proves selected design destinations remain wired in client code; it does not claim END-BAR, GO-LIVE, adoption, or runtime live-proof.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
