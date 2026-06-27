import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-uiux-action-traceability.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function writeFixture(root: string) {
  const designRoot = join(root, "design");
  writeFile(designRoot, "ACTION-CONTRACT.md", `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | home | refresh | Retry now | transport_connection_state | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
| desktop | memory | check | Confirm | memory_review_no_silent_write_decide_candidate | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
`);
  writeFile(
    root,
    "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift",
    `enum MobileProductDestinationID {
    case home
    var contract: MobileProductDestinationContract {
      switch self {
      case .home:
      return contract(
        title: "Friday Home",
        systemImage: "house",
        tier: .liveReadProjection,
        runtimeActionIds: ["mobile/home/refresh"],
        blockers: [])
    }
    }
    private func contract(
      title: String,
      systemImage: String,
      tier: MobileProductLoopTier,
      runtimeActionIds: [String],
      blockers: [MobileProductBlocker]
    ) -> MobileProductDestinationContract { fatalError() }
    }
`,
  );
  writeFile(
    root,
    "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift",
    `enum DesktopProductDestinationID {
    case memory
    var contract: DesktopProductDestinationContract {
      switch self {
      case .memory:
      return contract(
        title: "Memory",
        systemImage: "brain.head.profile",
        tier: .governedActionGated,
        runtimeActionIds: ["desktop/memory/check"],
        blockers: [])
    }
    }
    private func contract(
      title: String,
      systemImage: String,
      tier: DesktopProductLoopTier,
      runtimeActionIds: [String],
      blockers: [DesktopProductBlocker]
    ) -> DesktopProductDestinationContract { fatalError() }
    }
`,
  );
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift", "Retry now refresh");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShellCore/HomeViewModel.swift", "func refresh() {}");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift", "Button(\"Confirm\") {}");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift", "func decideMemory() {}");
  for (const file of [
    "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/FridayChatViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/SessionContinuationViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/ShareIntakeViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/VoiceReadinessViewModel.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/OperationsOverviewScreen.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/PairingProvisioningScreen.swift",
  ]) {
    const target = join(root, file);
    if (!readFileSyncOrEmpty(target)) writeFile(root, file, "placeholder");
  }
  return designRoot;
}

function readFileSyncOrEmpty(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("check-friday-uiux-action-traceability", () => {
  it("discovers nested runtime evidence bundles and writes the requested report", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-uiux-action-traceability-"));
    try {
      const designRoot = writeFixture(root);
      const evidenceDir = join(root, "evidence");
      writeFile(evidenceDir, "mobile/action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "mobile",
            screen: "home",
            runtimeActionId: "mobile/home/refresh",
            capability_id: "transport_connection_state",
            status: "pass",
            evidence_ref: "proof://mobile/home-refresh",
          },
        ],
      }, null, 2));
      writeFile(evidenceDir, "desktop/action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "desktop",
            screen: "memory",
            action_id: "check",
            capability_id: "memory_review_no_silent_write_decide_candidate",
            status: "pass",
            evidence_ref: "proof://desktop/memory-confirm",
          },
        ],
      }, null, 2));
      const out = join(root, "reports", "uiux-action-traceability.json");
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        "--runtime-evidence-dir",
        evidenceDir,
        "--out",
        out,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { runtimeEvidenceInputs?: number; runtimeEvidenceActionRows?: number; productActionsMissingRuntimeEvidence?: number };
      };
      const persisted = JSON.parse(readFileSync(out, "utf8")) as typeof report;
      expect(report.status).toBe("product_runtime_actions_traceable");
      expect(report.counts?.runtimeEvidenceInputs).toBe(2);
      expect(report.counts?.runtimeEvidenceActionRows).toBe(2);
      expect(report.counts?.productActionsMissingRuntimeEvidence).toBe(0);
      expect(persisted.status).toBe("product_runtime_actions_traceable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates design-annex gaps from missing runtime evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-uiux-action-traceability-annex-"));
    try {
      const designRoot = join(root, "design");
      writeFile(designRoot, "ACTION-CONTRACT.md", `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | home | refresh | Retry now | transport_connection_state | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
`);
      writeFile(
        root,
        "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift",
        `enum MobileProductDestinationID {
        case shareIntake
        var contract: MobileProductDestinationContract {
          switch self {
          case .shareIntake:
          return contract(
            title: "Share Intake",
            systemImage: "square.and.arrow.down",
            tier: .governedActionGated,
            runtimeActionIds: ["mobile/share/send"],
            blockers: [])
        }
        }
        private func contract(
          title: String,
          systemImage: String,
          tier: MobileProductLoopTier,
          runtimeActionIds: [String],
          blockers: [MobileProductBlocker]
        ) -> MobileProductDestinationContract { fatalError() }
        }
`,
      );
      writeFile(
        root,
        "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift",
        `enum DesktopProductDestinationID {
        case empty
        var contract: DesktopProductDestinationContract {
          switch self {
          case .empty:
          return contract(
            title: "Empty",
            systemImage: "circle",
            tier: .navigationShell,
            runtimeActionIds: [],
            blockers: [])
        }
        }
        private func contract(
          title: String,
          systemImage: String,
          tier: DesktopProductLoopTier,
          runtimeActionIds: [String],
          blockers: [DesktopProductBlocker]
        ) -> DesktopProductDestinationContract { fatalError() }
        }
`,
      );
      const evidenceDir = join(root, "evidence");
      writeFile(evidenceDir, "mobile/action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "mobile",
            screen: "share",
            action_id: "send",
            capability_id: "share_intake_governed_send",
            status: "pass",
            evidence_ref: "proof://mobile/share-send",
          },
        ],
      }, null, 2));

      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        "--runtime-evidence-dir",
        evidenceDir,
        "--compact",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: {
          productActionsMissingDesign?: number;
          productActionsMissingDesignRuntimeCovered?: number;
          productActionsMissingDesignRuntimeMissing?: number;
          productActionsMissingRuntimeEvidence?: number;
        };
        gaps?: {
          productActionsMissingDesign?: Array<{
            runtimeActionId?: string;
            runtimeEvidenceMatched?: boolean;
            evidenceRefs?: string[];
            recommendedNext?: string;
          }>;
          productActionsMissingRuntimeEvidence?: Array<unknown>;
        };
      };

      expect(report.status).toBe("traceability_gaps_present");
      expect(report.counts?.productActionsMissingDesign).toBe(1);
      expect(report.counts?.productActionsMissingDesignRuntimeCovered).toBe(1);
      expect(report.counts?.productActionsMissingDesignRuntimeMissing).toBe(0);
      expect(report.counts?.productActionsMissingRuntimeEvidence).toBe(0);
      expect(report.gaps?.productActionsMissingRuntimeEvidence).toEqual([]);
      expect(report.gaps?.productActionsMissingDesign).toEqual([
        expect.objectContaining({
          runtimeActionId: "mobile/share/send",
          runtimeEvidenceMatched: true,
          evidenceRefs: ["proof://mobile/share-send"],
          recommendedNext: "add or reconcile a design contract annex row; runtime action evidence is already present",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports product contract blockers as END-BAR residuals, not traceability failures", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-uiux-action-traceability-residual-"));
    try {
      const designRoot = join(root, "design");
      writeFile(designRoot, "ACTION-CONTRACT.md", `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | home | refresh | Retry now | transport_connection_state | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
`);
      writeFile(
        root,
        "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift",
        `enum MobileProductDestinationID {
        case home
        var contract: MobileProductDestinationContract {
          switch self {
          case .home:
          return contract(
            title: "Friday Home",
            systemImage: "house",
            tier: .liveReadProjection,
            runtimeActionIds: ["mobile/home/refresh"],
            blockers: [.init(.needsRuntimeEvidence, label: "same-run user proof")])
        }
        }
        private func contract(
          title: String,
          systemImage: String,
          tier: MobileProductLoopTier,
          runtimeActionIds: [String],
          blockers: [MobileProductBlocker]
        ) -> MobileProductDestinationContract { fatalError() }
        }
`,
      );
      writeFile(
        root,
        "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift",
        `enum DesktopProductDestinationID {
        case empty
        var contract: DesktopProductDestinationContract {
          switch self {
          case .empty:
          return contract(
            title: "Empty",
            systemImage: "circle",
            tier: .navigationShell,
            runtimeActionIds: [],
            blockers: [])
        }
        }
        private func contract(
          title: String,
          systemImage: String,
          tier: DesktopProductLoopTier,
          runtimeActionIds: [String],
          blockers: [DesktopProductBlocker]
        ) -> DesktopProductDestinationContract { fatalError() }
        }
`,
      );
      const evidenceDir = join(root, "evidence");
      writeFile(evidenceDir, "mobile/action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "mobile",
            screen: "home",
            action_id: "refresh",
            capability_id: "transport_connection_state",
            status: "pass",
            evidence_ref: "proof://mobile/home-refresh",
          },
        ],
      }, null, 2));

      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        "--runtime-evidence-dir",
        evidenceDir,
        "--compact",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: {
          productActionsMissingRuntimeEvidence?: number;
          destinationsWithResidualEndBarBlockers?: number;
          destinationsStillBlocked?: number;
        };
        gaps?: {
          residualEndBarBlockers?: Array<{
            id?: string;
            blockers?: Array<{ kind?: string; label?: string }>;
            evidenceOverlay?: {
              status?: string;
              runtimeActionCount?: number;
              runtimeActionsCovered?: number;
              runtimeActionsMissing?: number;
              evidenceRefs?: string[];
            };
          }>;
          destinationsStillBlocked?: Array<unknown>;
        };
        residualEndBarEvidence?: {
          destinationsWithResidualBlockers?: number;
          destinationsWithAllRuntimeActionsCovered?: number;
          destinationsWithNoRuntimeActionEvidence?: number;
        };
      };

      expect(report.status).toBe("product_runtime_actions_traceable");
      expect(report.counts?.productActionsMissingRuntimeEvidence).toBe(0);
      expect(report.counts?.destinationsWithResidualEndBarBlockers).toBe(1);
      expect(report.counts?.destinationsStillBlocked).toBe(1);
      expect(report.gaps?.residualEndBarBlockers).toEqual([
        expect.objectContaining({
          id: "home",
          blockers: [expect.objectContaining({
            kind: "needsRuntimeEvidence",
            label: "same-run user proof",
          })],
          evidenceOverlay: expect.objectContaining({
            status: "runtime_action_evidence_attached_not_endbar",
            runtimeActionCount: 1,
            runtimeActionsCovered: 1,
            runtimeActionsMissing: 0,
            evidenceRefs: ["proof://mobile/home-refresh"],
          }),
        }),
      ]);
      expect(report.residualEndBarEvidence).toEqual(expect.objectContaining({
        destinationsWithResidualBlockers: 1,
        destinationsWithAllRuntimeActionsCovered: 1,
        destinationsWithNoRuntimeActionEvidence: 0,
      }));
      expect(report.gaps?.destinationsStillBlocked).toEqual(report.gaps?.residualEndBarBlockers);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
