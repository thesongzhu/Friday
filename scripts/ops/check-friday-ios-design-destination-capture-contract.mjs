#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function resolveRepoRoot() {
  const explicit = process.argv[2]?.trim() || process.env.FRIDAY_IOS_DESIGN_CAPTURE_REPO_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function readText(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const repoRoot = resolveRepoRoot();
const scriptPath = "scripts/ops/friday-ios-design-destination-capture.sh";
const pkgPath = "package.json";
const requiredDestinations = [
  "home",
  "missions",
  "session",
  "contextPassport",
  "tokenLedger",
  "shareIntake",
  "voice",
  "pairing",
  "needsMe",
  "memory",
  "platform",
  "providerAuth",
  "activity",
  "workflows",
  "onboarding",
  "settings",
  "petEditor",
  "proofViewer",
  "entrypoints",
];

const checks = [];

function pushCheck(label, target, passed, missing = []) {
  checks.push({
    label,
    target,
    status: passed ? "passed" : "failed",
    missing,
  });
}

const scriptExists = fs.existsSync(path.join(repoRoot, scriptPath));
pushCheck("iOS selected destination capture runner exists", scriptPath, scriptExists);

if (scriptExists) {
  const source = readText(repoRoot, scriptPath);
  const missingDestinations = requiredDestinations.filter((destination) => !source.includes(destination));
  pushCheck(
    "iOS capture runner enumerates selected mobile destinations",
    scriptPath,
    missingDestinations.length === 0,
    missingDestinations,
  );
  const requiredTruthStrings = [
    "ios_selected_design_destination_capture_not_live_closure",
    "friday-design-handoff-20260602/saved/mobile-selection.json",
    "repo_head",
    "mode=\"live-loopback\"",
    "`offline-truth` is a negative-control lane only",
    "not END-BAR",
    "not GO-LIVE",
    "enabled actions still require separate Hub/DB/ledger/proof closure",
  ];
  const missingTruthStrings = requiredTruthStrings.filter((item) => !source.includes(item));
  pushCheck(
    "iOS capture runner preserves truth labels and no-overclaim caveats",
    scriptPath,
    missingTruthStrings.length === 0,
    missingTruthStrings,
  );
}

const pkg = JSON.parse(readText(repoRoot, pkgPath));
const scriptValue = pkg.scripts?.["proof:ios:design-destinations"];
const hasPackageScript = typeof scriptValue === "string" && scriptValue.includes("friday-ios-design-destination-capture.sh");
pushCheck(
  "package.json exposes iOS selected destination capture proof",
  "proof:ios:design-destinations",
  hasPackageScript,
  hasPackageScript ? [] : ["proof:ios:design-destinations"],
);

const failed = checks.filter((check) => check.status === "failed");
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  truthLabel: "ios_design_destination_capture_contract_static_guard_not_runtime_pass",
  status: failed.length === 0 ? "passed" : "failed",
  requiredDestinations,
  checks,
  caveat: "This proves the selected-design capture runner and package hook remain present and that offline-truth is not the selected visual proof lane; it does not claim screenshots were captured, END-BAR, GO-LIVE, adoption, or live action closure.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
