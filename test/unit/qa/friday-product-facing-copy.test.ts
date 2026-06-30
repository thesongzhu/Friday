import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../../..");

const productSurfaceFiles = [
  "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/ProviderReadinessPanel.swift",
  "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
  "apps/friday-ios/Sources/FridayMobileShell/HeroPet.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/CompanionPetView.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopSessionDetailScreen.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/OperationsOverviewScreen.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/TruthChips.swift",
];

const visibleSwiftConstructors = /\b(Text|StatusChip|Label|Button|cardHeader|workspaceHeader|unavailableFactCard)\s*\(/;
const forbiddenVisibleCopy = [
  "Friday is offline",
  "Hub offline",
  "Hub projection unavailable",
  "unavailable until",
  "remains unavailable",
  "Provider results remain unavailable",
  "No provider status, session state, or capability readiness is fabricated",
  "no cached or fabricated",
  "no fabricated status",
  "not loaded",
  "read off",
  "write off",
  "WebKit unavailable",
  "NO-GO visible",
  "honest-unavailable",
  "Voice readiness unavailable",
  "Session detail unavailable",
  "Token ledger unavailable",
  "Context Passport unavailable",
  "END-BAR",
  "selected-design",
  "readiness evidence",
  "real app proof",
  "same-run app evidence",
  "not configured in this build",
  "proof only",
  "not proof only",
  "Proof Refs",
  "No proof refs",
  "Proof Viewer",
  "iOS Entrypoints",
  "Native Entrypoints",
  "Reading token ledger truth",
  "continuation truth",
];

const servedProductSurfaceFiles = [
  "ui/src/routes/cloud-workers-page.tsx",
  "ui/src/routes/setup-page.tsx",
  "ui/src/routes/settings-page.tsx",
  "ui/src/lib/routes/agent-os-nav.ts",
];

const forbiddenServedProductCopy = [
  "blocked_by_env",
  "fixture proof",
  "fixture-only proof",
  "fixture 证明",
  "Teardown receipt (fixture)",
  "17A",
  "17B",
  "unavailable until",
  "remains unavailable",
  "stays unavailable",
  "is unavailable",
  "data unavailable",
];

describe("Friday product-facing unavailable copy", () => {
  it("keeps engineering unavailable/offline language out of visible product UI", () => {
    const failures: string[] = [];
    for (const relativePath of productSurfaceFiles) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      source.split("\n").forEach((line, index) => {
        if (!visibleSwiftConstructors.test(line)) return;
        for (const forbidden of forbiddenVisibleCopy) {
          if (line.includes(forbidden)) {
            failures.push(`${relativePath}:${index + 1}: ${forbidden}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });

  it("keeps internal proof/environment labels out of served product copy", () => {
    const failures: string[] = [];
    for (const relativePath of servedProductSurfaceFiles) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      source.split("\n").forEach((line, index) => {
        for (const forbidden of forbiddenServedProductCopy) {
          if (line.includes(forbidden)) {
            failures.push(`${relativePath}:${index + 1}: ${forbidden}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });

  it("keeps raw receipt field names out of visible iOS product labels", () => {
    const rawLabelPatterns = [
      /FridayProofLine\(label:\s*"mission_id"/,
      /FridayProofLine\(label:\s*"work_item_id"/,
      /FridayProofLine\(label:\s*"conversation_id"/,
      /FridayProofLine\(label:\s*"selectedRoute"/,
      /FridayProofLine\(label:\s*"provider_receipt"/,
      /FridayProofLine\(label:\s*"channel_receipt"/,
      /FridayProofLine\(label:\s*"proofRef"/,
      /FridayProofLine\(label:\s*"evidenceRef"/,
      /FridayProofLine\(label:\s*"runId"/,
      /FridayProofLine\(label:\s*"workItemId"/,
      /FridayProofLine\(label:\s*"activity_id"/,
      /Text\("feed:/,
      /"Refs-only receipt/,
      /"created_or_ready"/,
    ];
    const failures: string[] = [];
    for (const relativePath of productSurfaceFiles) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      source.split("\n").forEach((line, index) => {
        for (const pattern of rawLabelPatterns) {
          if (pattern.test(line)) {
            failures.push(`${relativePath}:${index + 1}: ${pattern}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });

  it("keeps raw projection fields out of the iOS Home queue cards", () => {
    const source = readFileSync(
      join(repoRoot, "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift"),
      "utf8",
    );
    const rawQueuePatterns = [
      /title:\s*item\.title/,
      /subtitle:\s*"state:\s*\\\([^)]*item\.state/,
      /chip:\s*item\.state/,
      /title:\s*event\.summary/,
      /subtitle:\s*"\\\([^)]*event\.sectionTitle[^"]*event\.truthLabel/,
      /chip:\s*event\.status/,
      /title:\s*"\\\([^)]*route\.capitalized\)\s*route"/,
      /subtitle:\s*projection\.routeAlternatives\.joined/,
      /No bounded mission timeline page is projected yet\./,
      /bounded mission timeline pages/,
      /current projection/,
      /work-item refs/,
      /refs only — open the Mission Workbench for detail/,
    ];

    const failures = rawQueuePatterns
      .filter((pattern) => pattern.test(source))
      .map((pattern) => String(pattern));

    expect(failures).toEqual([]);
  });

  it("keeps raw projection wording out of iOS secondary product screens", () => {
    const secondaryFiles = [
      "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift",
    ];
    const rawSecondaryPatterns = [
      /No work-item refs in this projection\./,
      /No projected operator-attention refs\./,
      /No capability refs in this projection\./,
      /No transcript events in this projection\./,
      /No workflow work-item refs\./,
      /No receipt refs in this projection\./,
      /No provider-linked WorkItem refs in the current projection\./,
      /Proof Receipts/,
      /Receipt Refs/,
      /No proof receipt refs/,
      /Native Entrypoints/,
      /iOS Entrypoints/,
      /Proof Viewer/,
      /FridayProofLine\(label:\s*"conversation"/,
      /FridayProofLine\(label:\s*"selected route"/,
      /FridayProofLine\(label:\s*"trusted_device"/,
      /FridayProofLine\(label:\s*"device_fingerprint"/,
      /FridayProofLine\(label:\s*"device_id"/,
      /FridayProofLine\(label:\s*"ack_device_id"/,
      /FridayProofLine\(label:\s*"ack_pairing_id"/,
      /FridayProofLine\(label:\s*"ack_hub_id"/,
      /FridayProofLine\(label:\s*"device_fingerprint"/,
      /FridayProofLine\(label:\s*"latest_device"/,
      /FridayProofLine\(label:\s*"device_identity_count"/,
      /FridayProofLine\(label:\s*"trusted_device_count"/,
      /FridayProofLine\(label:\s*"active_trusted_device_count"/,
      /FridayProofLine\(label:\s*"trust_grant_count"/,
      /FridayProofLine\(label:\s*"context_passport_count"/,
      /FridayProofLine\(label:\s*"truth"/,
      /FridayProofLine\(label:\s*"generated"/,
      /PairAck/,
      /not minted/,
      /not in projection/,
      /cardHeader\("Truth"/,
      /Text\("Reading provisioning truth"/,
      /No trusted device ref is present in this projection/,
      /Text\("provider readiness, queues, sessions, and native-control truth"/,
      /Hub read arm/,
      /Reading Provider Workspace projection/,
      /FridayProofLine\(label:\s*"work_item_proof"/,
      /needs run ref/,
      /run readback ready/,
      /Text\("Evidence Refs"/,
      /FridayProofLine\(label:\s*"proof"/,
      /alternates:\s*\\\(/,
      /Text\(item\.title\)/,
      /Text\("\\\(item\.owner\)[^"]*\\\(item\.state\)/,
      /Text\(item\.blockingReason\)/,
      /Text\(event\.summary\)/,
      /Text\(event\.sectionTitle\)/,
      /statusChip\(event\.status\)/,
    ];
    const failures: string[] = [];
    for (const relativePath of secondaryFiles) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      source.split("\n").forEach((line, index) => {
        for (const pattern of rawSecondaryPatterns) {
          if (pattern.test(line)) {
            failures.push(`${relativePath}:${index + 1}: ${pattern}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });

  it("keeps raw session and token-ledger labels out of iOS product screens", () => {
    const focusedFiles = [
      "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift",
    ];
    const rawFocusedPatterns = [
      /FridayProofLine\(label:\s*"run_id"/,
      /FridayProofLine\(label:\s*"agent_session_id"/,
      /FridayProofLine\(label:\s*"approval_id"/,
      /FridayProofLine\(label:\s*"action_digest"/,
      /FridayProofLine\(label:\s*"answer_body_run_id"/,
      /FridayProofLine\(label:\s*"more_refs"/,
      /Answers are refs-only/,
      /Answer body is not available from the owner-gated readback yet/,
      /Readiness plus local voice-loop truth/,
      /Truth label/,
      /share refs/,
      /FridayProofLine\(label:\s*"feed"/,
      /Text\("provider usage readback"/,
      /Text\("continuation truth"/,
      /Text\("Reading token ledger truth"/,
      /cardHeader\("No Run Ref"/,
      /cardHeader\("Proof Refs"/,
      /No proof refs were returned by the session read arms\./,
      /No run-outcome learning candidates in this projection\./,
      /control\.truthLabel == "read arm"/,
    ];
    const failures: string[] = [];
    for (const relativePath of focusedFiles) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      source.split("\n").forEach((line, index) => {
        for (const pattern of rawFocusedPatterns) {
          if (pattern.test(line)) {
            failures.push(`${relativePath}:${index + 1}: ${pattern}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });
});
