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

function missingStrings(source, values) {
  return values.filter((value) => !source.includes(value));
}

function requireCases(source, values) {
  return values.filter((value) => !new RegExp(`\\bcase\\s+\\.${value}\\b|\\bcase\\s+${value}\\b`).test(source));
}

const root = repoRoot();
const files = {
  app: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift"),
  commandSheet: read(root, "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift"),
  sessionScreen: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift"),
  contextScreen: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift"),
  tokenScreen: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift"),
  shareScreen: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift"),
  voiceScreen: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift"),
  sessionVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/SessionContinuationViewModel.swift"),
  shareVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/ShareIntakeViewModel.swift"),
  voiceVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/VoiceReadinessViewModel.swift"),
  sessionTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/SessionContinuationViewModelTests.swift"),
  shareTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/ShareIntakeViewModelTests.swift"),
  voiceTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/VoiceReadinessViewModelTests.swift"),
  liveWriteTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/LiveMissionSpineWriteDispatchIntegrationTests.swift"),
  pkg: read(root, "package.json"),
};

const checks = [
  {
    id: "ios-t2-destinations-visible",
    target: "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
    missing: [
      ...requireCases(files.commandSheet, [
        "session",
        "contextPassport",
        "tokenLedger",
        "shareIntake",
        "voice",
        "needsMe",
      ]),
      ...missingStrings(files.commandSheet, [
        "Session",
        "Context Passport",
        "Token Ledger",
        "Share Intake",
        "Voice",
        "Route coverage is not END-BAR",
      ]),
    ],
  },
  {
    id: "ios-t2-root-wiring",
    target: "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
    missing: missingStrings(files.app, [
      "FridaySessionDetailScreen(homeViewModel: homeVM, viewModel: sessionContinuationVM)",
      "FridayContextPassportScreen(viewModel: homeVM)",
      "FridayTokenLedgerScreen(viewModel: homeVM)",
      "FridayShareIntakeScreen(viewModel: shareIntakeVM)",
      "FridayVoiceScreen(viewModel: voiceVM)",
      "ShareIntakeViewModel(client: session.missionClient)",
      "VoiceReadinessViewModel(",
      "SystemVoiceReadinessAuthorizer()",
    ]),
  },
  {
    id: "ios-session-approval-refs-only",
    target: "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift + SessionContinuationViewModel.swift",
    missing: missingStrings(files.sessionScreen + files.sessionVM, [
      "Approval Required",
      "operator-signed relay only",
      "action_digest",
      "resumeWithApproval",
      "rejectApproval",
      "Pending approval refs are present",
      "it never holds signing key material",
    ]),
  },
  {
    id: "ios-context-passport-token-ledger-surfaces",
    target: "apps/friday-ios/Sources/FridayMobileShell/*ContextPassport* + *TokenLedger*",
    missing: missingStrings(files.contextScreen + files.tokenScreen, [
      "Context Passport",
      "trust grant",
      "context passport",
      "friday.context-passport.checklist",
      "Token Ledger",
      "refs-only provider usage readback",
      "Refresh Ledger",
      "No cost data is fabricated",
    ]),
  },
  {
    id: "ios-share-voice-surfaces",
    target: "apps/friday-ios/Sources/FridayMobileShell/*ShareIntake* + *Voice*",
    missing: missingStrings(files.shareScreen + files.shareVM + files.voiceScreen + files.voiceVM, [
      "Send to Friday",
      "submitMissionIntake",
      "ios://friday-mobile/share/",
      "Shared Item",
      "Voice",
      "Voice I/O Actions",
      "Voice Gates",
      "MobileVoiceReadiness",
      "NO-GO",
      "TTS provider output is not configured in this build",
      "Readiness only",
    ]),
  },
  {
    id: "ios-t2-behavior-tests",
    target: "apps/friday-ios/Tests/FridayMobileShellCoreTests",
    missing: missingStrings(files.sessionTests + files.shareTests + files.voiceTests, [
      "testResumeRelaysSignerBlobVerbatimAndSurfacesReceipt",
      "testRejectRelaysApprovalRefWithoutResumingMutation",
      "testSubmitCreatesMobileShareMissionIntake",
      "testNoClientFailsClosedWithoutFakeMission",
      "testVoiceLoopReadyRequiresCaptureAndTtsProvider",
      "testDeniedOrRestrictedPermissionsNeverClaimVoiceReady",
      "testActionRowsSeparatePermissionCaptureTtsAndRealtimeLoopTruth",
    ]),
  },
  {
    id: "ios-live-product-proof-entrypoints",
    target: "apps/friday-ios/Tests/FridayMobileShellCoreTests/LiveMissionSpineWriteDispatchIntegrationTests.swift",
    missing: missingStrings(files.liveWriteTests, [
      "FRIDAY_MOBILE_LIVE_WRITE_DISPATCH_TEST",
      "FRIDAY_MOBILE_LIVE_MISSION_BOUND_RUN_TEST",
      "FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST",
      "liveMobileChatSendAutoDispatchesHybridClaudeFollowUp",
      "works_not_adopted",
    ]),
  },
  {
    id: "package-script",
    target: "package.json",
    missing: missingStrings(files.pkg, [
      "\"check:ios-t2-surface-contract\"",
    ]),
  },
];

const failed = checks.filter((check) => check.missing.length > 0);
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: root,
  truthLabel: "friday_ios_t2_surface_static_guard_not_runtime_endbar",
  status: failed.length === 0 ? "passed" : "failed",
  checks: checks.map((check) => ({
    id: check.id,
    target: check.target,
    status: check.missing.length === 0 ? "passed" : "failed",
    missing: check.missing,
  })),
  caveat: "Static guard only. It proves the iOS T2 surfaces, view-model tests, and live proof entrypoints remain wired; it does not claim real-device adoption, complete voice I/O, operator signing completion, END-BAR, or GO-LIVE.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
