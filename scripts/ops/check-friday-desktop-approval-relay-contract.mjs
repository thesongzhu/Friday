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
  proof: read(root, "scripts/ops/friday-desktop-approval-relay-proof.sh"),
  app: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift"),
  viewModel: read(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift"),
  tests: read(root, "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/OperationsOverviewViewModelTests.swift"),
  pkg: read(root, "package.json"),
};

const checks = [
  {
    id: "desktop-approval-relay-proof-entrypoint",
    target: "scripts/ops/friday-desktop-approval-relay-proof.sh",
    missing: missingStrings(files.proof, [
      "FRIDAY_DESKTOP_APPROVAL_RELAY_LIVE=1",
      "friday-s6-transport-a-driver.mjs",
      "dispatch-mutating",
      "pending-request.json",
      "signed-approval.json",
      "FRIDAY_DESKTOP_APPROVAL_SIGNED_APPROVAL",
      "desktop_approval_approve_action_runtime_evidence_operator_signed_not_endbar",
      "proof://desktop/approval-approve/",
      "does not read signing keys",
      "did not sign, resume, release, GO, or prove adoption",
    ]),
  },
  {
    id: "desktop-app-wires-external-signer-and-write-relay",
    target: "apps/macos/FridayHubConsole/Sources/FridayHubConsole/FridayHubConsoleApp.swift",
    missing: missingStrings(files.app, [
      "approvalSigner: Self.approvalSigner",
      "approvalResumeClient: Self.writeClient",
      "OperatorApprovalCLISigner()",
      "startup never reads or signs with the private key",
    ]),
  },
  {
    id: "desktop-viewmodel-relays-opaque-signed-blob",
    target: "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift",
    missing: missingStrings(files.viewModel, [
      "approveNeedsMeItem",
      "approvalSigner.signApproval",
      "OperatorApprovalSigningRequest",
      "approvalResumeClient.resumeWithApproval",
      "opaque signed blob",
      "No key material or action body enters",
    ]),
  },
  {
    id: "desktop-approval-relay-behavior-tests",
    target: "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/OperationsOverviewViewModelTests.swift",
    missing: missingStrings(files.tests, [
      "approveNeedsMeItemSignsRefsAndRelaysOpaqueBlob",
      "approveNeedsMeItemWithoutSignerFailsClosedWithoutResume",
      "operatorApprovalCLISignerWritesRefsOnlyRequestAndRelaysOpaqueStdout",
      "operatorApprovalCLISignerRejectsMalformedDigestBeforeInvokingSigner",
      "rejectNeedsMeApprovalUsesRunControlWithoutSigner",
      "cancelNeedsMeRunUsesRunControlReason",
    ]),
  },
  {
    id: "package-scripts",
    target: "package.json",
    missing: missingStrings(files.pkg, [
      "\"proof:desktop:approval-relay\"",
      "\"check:desktop-approval-relay-contract\"",
    ]),
  },
];

const failed = checks.filter((check) => check.missing.length > 0);
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: root,
  truthLabel: "friday_desktop_approval_relay_static_guard_not_runtime_signature",
  status: failed.length === 0 ? "passed" : "failed",
  checks: checks.map((check) => ({
    id: check.id,
    target: check.target,
    status: check.missing.length === 0 ? "passed" : "failed",
    missing: check.missing,
  })),
  caveat: "Static guard only. The live proof requires FRIDAY_DESKTOP_APPROVAL_RELAY_LIVE=1 and an operator-signed artifact for resume. It does not claim END-BAR, GO-LIVE, adoption, or key custody.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
