#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function resolveRepoRoot() {
  const explicit = process.argv[2]?.trim() || process.env.FRIDAY_REPO_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function includesAll(source, values) {
  return values.filter((value) => !source.includes(value));
}

function hasMethod(source, name) {
  return new RegExp(`\\bfunc\\s+${name}\\s*\\(`).test(source);
}

function methodMissing(source, names) {
  return names.filter((name) => !hasMethod(source, name));
}

function check(id, target, missing, notes = []) {
  return {
    id,
    target,
    status: missing.length === 0 ? "passed" : "failed",
    missing,
    notes,
  };
}

const root = resolveRepoRoot();
const files = {
  mobileCommand: read(root, "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift"),
  mobileApp: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift"),
  mobileHome: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift"),
  mobileProjection: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift"),
  mobileSession: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift"),
  mobileChat: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift"),
  mobileShare: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift"),
  mobileVoice: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift"),
  mobileToken: read(root, "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift"),
  mobileHomeVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/HomeViewModel.swift"),
  mobileSessionVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/SessionContinuationViewModel.swift"),
  mobileChatVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/FridayChatViewModel.swift"),
  mobileShareVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/ShareIntakeViewModel.swift"),
  mobileVoiceVM: read(root, "apps/friday-ios/Sources/FridayMobileShellCore/VoiceReadinessViewModel.swift"),
  mobileHomeTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/HomeViewModelTests.swift"),
  mobileSessionTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/SessionContinuationViewModelTests.swift"),
  mobileChatTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/FridayChatViewModelTests.swift"),
  mobileShareTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/ShareIntakeViewModelTests.swift"),
  mobileVoiceTests: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/VoiceReadinessViewModelTests.swift"),
  desktopNav: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift"),
  desktopShell: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift"),
  desktopOps: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/OperationsOverviewScreen.swift"),
  desktopProjection: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift"),
  desktopChat: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift"),
  desktopVM: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift"),
  desktopTests: read(root, "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/OperationsOverviewViewModelTests.swift"),
  packageJson: read(root, "package.json"),
};

const mobileUi = [
  files.mobileHome,
  files.mobileProjection,
  files.mobileSession,
  files.mobileChat,
  files.mobileShare,
  files.mobileVoice,
  files.mobileToken,
].join("\n");
const mobileVM = [
  files.mobileHomeVM,
  files.mobileSessionVM,
  files.mobileChatVM,
  files.mobileShareVM,
  files.mobileVoiceVM,
].join("\n");
const mobileTests = [
  files.mobileHomeTests,
  files.mobileSessionTests,
  files.mobileChatTests,
  files.mobileShareTests,
  files.mobileVoiceTests,
].join("\n");
const desktopUi = [
  files.desktopOps,
  files.desktopProjection,
  files.desktopChat,
].join("\n");
const desktopTests = files.desktopTests;

const checks = [
  check(
    "mobile-command-sheet-does-not-hide-product-destinations",
    "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
    includesAll(files.mobileCommand, [
      "case session",
      "case contextPassport",
      "case tokenLedger",
      "case shareIntake",
      "case voice",
      "case needsMe",
      "case memory",
      "case platform",
      "case activity",
      "case workflows",
      "case settings",
      "var isBuilt: Bool { true }",
    ]),
    [
      "This is destination coverage, not END-BAR. Action closure is checked by the rows below.",
    ],
  ),
  check(
    "mobile-command-sheet-separates-route-coverage-from-product-closure",
    "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
    includesAll(files.mobileCommand, [
      "enum MobileDestinationClosureTier",
      "var closureTier: MobileDestinationClosureTier",
      "Route coverage only. This must not be used as a closed-loop product-completion signal.",
      "isClosedLoopProductReady",
      "case .liveWriteRead: return true",
      "case .home:",
      "case .session:",
      "case .providerAuth:",
      "case .shareIntake, .needsMe:",
      "case .voice, .pairing:",
      "case .workflows, .onboarding:",
      "case .providerWorkspace:",
      "dest.closureTier.label",
      "dest.productReadinessSummary",
      "closed-loop product behavior is still pending",
      "not a completed product loop",
      "Provider Workspace",
    ]),
    [
      "This keeps selected-design route coverage visible while preventing projection/readiness shells from being counted as product-complete.",
    ],
  ),
  check(
    "mobile-enabled-actions-have-viewmodel-drivers",
    "apps/friday-ios/Sources/FridayMobileShellCore",
    [
      ...methodMissing(files.mobileHomeVM, [
        "refresh",
        "loadDetail",
        "decideMemory",
        "decideRunOutcomeLearning",
        "markActivityDone",
        "retryWorkItem",
        "cancelWorkItem",
        "preflightPairingQR",
        "pairScannedQR",
      ]),
      ...methodMissing(files.mobileSessionVM, [
        "refresh",
        "send",
        "stop",
        "resume",
        "reject",
      ]),
      ...methodMissing(files.mobileChatVM, [
        "send",
        "approve",
        "reject",
      ]),
      ...methodMissing(files.mobileShareVM, ["submit"]),
      ...methodMissing(files.mobileVoiceVM, ["refresh"]),
    ],
  ),
  check(
    "mobile-enabled-actions-are-bound-to-ui-controls",
    "apps/friday-ios/Sources/FridayMobileShell",
    includesAll(mobileUi, [
      "viewModel.loadDetail(",
      "viewModel.retryWorkItem",
      "viewModel.cancelWorkItem",
      "viewModel.decideMemory",
      "viewModel.decideRunOutcomeLearning",
      "viewModel.markActivityDone",
      "viewModel.preflightPairingQR",
      "viewModel.pairScannedQR",
      "viewModel.send(",
      "viewModel.stop()",
      "viewModel.resume()",
      "viewModel.reject()",
      "viewModel.submit()",
      "viewModel.refresh()",
      ".disabled(",
      "accessibilityIdentifier",
    ]),
  ),
  check(
    "mobile-actions-fail-closed-and-surface-truth",
    "apps/friday-ios/Sources/FridayMobileShell + FridayMobileShellCore",
    includesAll(`${mobileUi}\n${mobileVM}`, [
      "Write seam not configured",
      "honest-unavailable",
      "requires the governed write client",
      "requires the session-bound write seam",
      "requires a pending approval ref",
      "Add shared text or a URL before submitting.",
      "Share Intake is unavailable",
      "Readiness plus local voice-loop truth",
      "No cost data is fabricated",
    ]),
  ),
  check(
    "mobile-action-behavior-tests-cover-enabled-writes",
    "apps/friday-ios/Tests/FridayMobileShellCoreTests",
    includesAll(mobileTests, [
      "testRetryWorkItemSendsLifecycleWriteAndRefreshes",
      "testCancelWorkItemSendsLifecycleWriteAndRefreshes",
      "testDecideMemoryConfirmRendersConfirmedAndRefreshes",
      "testDecideRunOutcomeLearningConfirmRendersConfirmedAndRefreshes",
      "testMarkActivityDoneRendersConfirmedAndRefreshes",
      "testResumeRelaysSignerBlobVerbatimAndSurfacesReceipt",
      "testRejectRelaysApprovalRefWithoutResumingMutation",
      "testStopUsesGovernedCancelRunAndSurfacesReceipt",
      "testSendDispatchesReadOnlySessionTurnAndRefreshesToReturnedRun",
      "testSubmitCreatesMobileShareMissionIntake",
      "testNoClientFailsClosedWithoutFakeMission",
      "testVoiceLoopReadyRequiresCaptureAndTtsProvider",
    ]),
  ),
  check(
    "desktop-nav-does-not-hide-workbench-destinations",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift",
    includesAll(files.desktopNav, [
      "case operations",
      "case chat",
      "case providerAdmin",
      "case parity",
      "case pairingProvisioning",
      "case workflow",
      "case channels",
      "case diagnostics",
      "case recovery",
      "case memory",
      "case tokenLedger",
      "case skills",
      "case media",
      "case settings",
      "case evidence",
      "var isBuilt: Bool { true }",
    ]),
  ),
  check(
    "desktop-enabled-actions-have-viewmodel-drivers",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift",
    methodMissing(files.desktopVM, [
      "refresh",
      "loadDetail",
      "submitIntake",
      "approveNeedsMeItem",
      "rejectNeedsMeApproval",
      "cancelNeedsMeRun",
      "markNeedsMeItemDone",
      "retryWorkItem",
      "cancelWorkItem",
      "decideMemory",
      "decideRunOutcomeLearning",
    ]),
  ),
  check(
    "desktop-enabled-actions-are-bound-to-ui-controls",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole",
    includesAll(desktopUi, [
      "viewModel.refresh()",
      "viewModel.loadDetail(",
      "viewModel.submitIntake",
      "viewModel.approveNeedsMeItem",
      "viewModel.rejectNeedsMeApproval",
      "viewModel.cancelNeedsMeRun",
      "viewModel.markNeedsMeItemDone",
      "viewModel.retryWorkItem",
      "viewModel.cancelWorkItem",
      "viewModel.decideMemory",
      "viewModel.decideRunOutcomeLearning",
      ".disabled(",
      "accessibilityIdentifier",
    ]),
  ),
  check(
    "desktop-actions-fail-closed-and-surface-truth",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift",
    includesAll(files.desktopVM, [
      "Write seam not configured",
      "Operator signer relay not configured",
      "Run-control write seam not configured",
      "cannot sign",
      "This WorkItem is not retryable",
      "This WorkItem is not cancellable",
      "blocked",
    ]),
  ),
  check(
    "desktop-action-behavior-tests-cover-enabled-writes",
    "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/OperationsOverviewViewModelTests.swift",
    includesAll(desktopTests, [
      "submitIntakeReadyRendersConfirmedAndWiresOwnerAdmin001",
      "submitIntakeReadyDispatchesMissionBoundModelTurnWhenRunClientConfigured",
      "approveNeedsMeItemSignsRefsAndRelaysOpaqueBlob",
      "rejectNeedsMeApprovalUsesRunControlWithoutSigner",
      "cancelNeedsMeRunUsesRunControlReason",
      "markNeedsMeItemDoneUsesRefIdAndRefreshesReview",
      "retryWorkItemSendsLifecycleWriteAndRefreshes",
      "cancelWorkItemSendsLifecycleWriteAndRefreshes",
      "decideMemoryConfirmRendersConfirmedRecallable",
      "decideRunOutcomeLearningConfirmRendersConfirmedAndWiresCandidate",
    ]),
  ),
  check(
    "package-exposes-native-action-closure-gate",
    "package.json",
    includesAll(files.packageJson, [
      "\"check:native-action-closure\"",
    ]),
  ),
];

const failed = checks.filter((row) => row.status === "failed");
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: root,
  truthLabel: "native_action_closure_static_behavior_guard_not_endbar_not_runtime_adoption",
  status: failed.length === 0 ? "passed" : "failed",
  summary: {
    passed: checks.filter((row) => row.status === "passed").length,
    failed: failed.length,
  },
  checks,
  caveat: "This gate prevents enabled native controls from being counted as complete without UI bindings, ViewModel drivers, fail-closed truth states, and behavior tests. It is still not a substitute for simulator/desktop screenshots, real live loop evidence, real-device adoption, or END-BAR.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
