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

const root = repoRoot();
const files = {
  script: read(root, "scripts/ops/friday-product-auto-followup-proof.sh"),
  desktopLiveTest: read(root, "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/LiveMissionSpineWriteDispatchIntegrationTests.swift"),
  iosLiveTest: read(root, "apps/friday-ios/Tests/FridayMobileShellCoreTests/LiveMissionSpineWriteDispatchIntegrationTests.swift"),
  pkg: read(root, "package.json"),
};

const checks = [
  {
    id: "product-auto-followup-proof-entrypoint",
    target: "scripts/ops/friday-product-auto-followup-proof.sh",
    missing: missingStrings(files.script, [
      "FRIDAY_PRODUCT_AUTO_FOLLOWUP_LIVE=1",
      "refusing to bind prod Friday port",
      "agent-run WRITE server is not listening",
      "FRIDAY_CONSOLE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST=1",
      "FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST=1",
      "Test liveOperationsOverviewSubmitIntakeAutoDispatchesHybridClaudeFollowUp() passed",
      "Test liveMobileChatSendAutoDispatchesHybridClaudeFollowUp() passed",
      "Does not restart/kill prod hub",
      "does not claim END-BAR",
      "prove organic traffic",
    ]),
  },
  {
    id: "desktop-product-auto-followup-live-test",
    target: "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/LiveMissionSpineWriteDispatchIntegrationTests.swift",
    missing: missingStrings(files.desktopLiveTest, [
      "liveOperationsOverviewSubmitIntakeAutoDispatchesHybridClaudeFollowUp", // pragma: allowlist secret
      "FRIDAY_CONSOLE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST",
      "FRIDAY_CONSOLE_LIVE_PRODUCT_AUTO_FOLLOWUP_READ_PORT",
      "FRIDAY_CONSOLE_LIVE_HYBRID_FOLLOWUP_WRITE_PORT",
      "FRIDAY_PRODUCT_AUTO_FOLLOWUP_OK",
      "follow_up_work_item_id",
      "runOutcomeLearningCandidates",
    ]),
  },
  {
    id: "ios-product-auto-followup-live-test",
    target: "apps/friday-ios/Tests/FridayMobileShellCoreTests/LiveMissionSpineWriteDispatchIntegrationTests.swift",
    missing: missingStrings(files.iosLiveTest, [
      "liveMobileChatSendAutoDispatchesHybridClaudeFollowUp", // pragma: allowlist secret
      "FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST",
      "FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_READ_PORT",
      "FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_WRITE_PORT",
      "FRIDAY_MOBILE_PRODUCT_AUTO_FOLLOWUP_OK",
      "followUpWorkItemId",
      "runOutcomeLearningCandidates",
    ]),
  },
  {
    id: "package-scripts",
    target: "package.json",
    missing: missingStrings(files.pkg, [
      "\"proof:product:auto-followup\"",
      "\"check:product-auto-followup-contract\"",
    ]),
  },
];

const failed = checks.filter((check) => check.missing.length > 0);
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: root,
  truthLabel: "friday_product_auto_followup_static_guard_not_runtime_pass",
  status: failed.length === 0 ? "passed" : "failed",
  checks: checks.map((check) => ({
    id: check.id,
    target: check.target,
    status: check.missing.length === 0 ? "passed" : "failed",
    missing: check.missing,
  })),
  caveat: "Static guard only. The live proof requires FRIDAY_PRODUCT_AUTO_FOLLOWUP_LIVE=1 and then spends real provider turns. This does not claim END-BAR, GO-LIVE, adoption, or organic traffic.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
