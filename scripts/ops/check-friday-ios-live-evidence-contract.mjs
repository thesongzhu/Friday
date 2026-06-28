#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function repoRoot() {
  const explicit = process.argv[2]?.trim() || process.env.FRIDAY_REPO_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireStrings(source, values) {
  return values.filter((value) => !source.includes(value));
}

function requireCases(source, values) {
  return values.filter((value) => !new RegExp(`\\bcase\\s+${value}\\b`).test(source));
}

const root = repoRoot();
const files = {
  readme: read(root, "apps/friday-ios/README.md"),
  app: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift"),
  home: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift"),
  commandSheet: read(root, "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift"),
  mobileProductContract: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift"),
  buildSim: read(root, "apps/friday-ios/build-sim.sh"),
  liveT3Proof: read(root, "scripts/ops/friday-ios-sim-live-t3-proof.sh"),
  gatesTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/MobileRuntimeGatesTests.swift"),
};

const checks = [
  {
    id: "mobile-selected-design-baseline",
    target: "apps/friday-ios/README.md + FridayApp.swift + build-sim.sh",
    missing: [
      ...requireStrings(files.readme + files.app, [
        "friday-design-handoff-20260602/saved/mobile-selection.json",
        "palette = cyanCoral",
        "background = warmOffWhite",
        "form = glassNative",
        "menuModel =",
        "commandSheet",
        "petProminence = heroPet",
        "platformLayout = cardsQueues",
      ]),
      ...requireStrings(files.buildSim, [
        '"selected_mobile_design"',
        '"selection_kind": "mobile-final (operator-confirmed 2026-06-04)"',
        '"variant": "claudeCalm"',
        '"palette": "cyanCoral"',
        '"pet_style": "retroLcd"',
        '"home_layout": "chatStatus"',
        '"menu_model": "commandSheet"',
        '"capability_truth": "matrixTruth"',
      ]),
    ],
  },
  {
    id: "mobile-v1-command-sheet-destinations",
    target: "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
    missing: [
      ...requireCases(files.commandSheet, [
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
        "activity",
        "workflows",
        "onboarding",
        "settings",
      ]),
      ...requireStrings(files.commandSheet, [
        "Command Sheet",
        "Route coverage is not END-BAR",
      ]),
      ...requireStrings(files.mobileProductContract, [
        "Device Pairing",
      ]),
    ],
  },
  {
    id: "mobile-selected-home-keeps-pairing-explicit",
    target: "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift + FridayHomeScreen.swift",
    missing: [
      ...requireStrings(files.app, [
        "case .pairing:",
        "FridayHomeScreen(viewModel: homeVM, showPairingProvisioning: true)",
      ]),
      ...requireStrings(files.home, [
        "showPairingProvisioning: Bool = false",
        "if showPairingProvisioning",
        "Connect Friday to see approvals, memory candidates, and recovery items.",
        "Connect Friday to see active work and provider progress.",
      ]),
    ],
  },
  {
    id: "mobile-live-loopback-proof-metadata",
    target: "apps/friday-ios/build-sim.sh",
    missing: requireStrings(files.buildSim, [
      '"truth_label": "friday_ios_simulator_${MODE}_proof"',
      '"live_read_requested"',
      '"live_write_requested"',
      '"live_pairing_requested"',
      '"device_keypair_requested"',
      '"simulator_file_device_keypair_requested"',
      '"simulator_device_pubkey"',
      "does not claim END-BAR, GO-LIVE, adoption, trust minting, or operator signing",
      "design-proof-sample is labeled visual comparison only",
      '"design_proof_sample_requested"',
    ]),
  },
  {
    id: "mobile-live-gates-default-off",
    target: "apps/friday-ios/Tests/FridayMobileShellCoreTests/MobileRuntimeGatesTests.swift",
    missing: requireStrings(files.gatesTests, [
      "mobileRuntimeGatesDefaultOff",
      "!MobileRuntimeGates.liveReadRequested",
      "!MobileRuntimeGates.liveWriteRequested",
      "!MobileRuntimeGates.livePairingRequested",
      "!MobileRuntimeGates.useDeviceKeypair",
      "!MobileRuntimeGates.runControlRequested",
      "mobileRuntimeGatesDoNotAcceptTruthyLookalikes",
    ]),
  },
  {
    id: "mobile-live-t3-scratch-proof-entrypoint",
    target: "scripts/ops/friday-ios-sim-live-t3-proof.sh",
    missing: requireStrings(files.liveT3Proof, [
      "friday_ios_simulator_live_t3_projection_proof_scratch_read_server",
      "refusing to bind prod Friday port",
      "FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK=operator-approves-ios-sim-read-seam-enroll", // pragma: allowlist secret
      "hub_read_projection_server",
      "friday-t3-provisioning-status.mjs",
      "t3.t3_provisioned === true",
      "Does not restart/kill prod hub",
      "never grants write access",
      "never signs",
      "never claims END-BAR / GO-LIVE / adoption / organic",
    ]),
  },
];

const failed = checks.filter((check) => check.missing.length > 0);
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: root,
  truthLabel: "friday_ios_selected_design_and_live_evidence_static_guard_not_runtime_pass",
  status: failed.length === 0 ? "passed" : "failed",
  checks: checks.map((check) => ({
    id: check.id,
    target: check.target,
    status: check.missing.length === 0 ? "passed" : "failed",
    missing: check.missing,
  })),
  caveat: "This is a static guard for the selected iOS design contract and simulator evidence metadata. It does not prove real-device use, END-BAR, GO-LIVE, adoption, or operator signing.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
