import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-uiux-native-linkage.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function writeSelections(designRoot: string, overrides: { mobile?: Record<string, string>; desktop?: Record<string, string> } = {}) {
  writeFile(designRoot, "saved/mobile-selection.json", JSON.stringify({
    surface: "mobile",
    operatorConfirmed: true,
    state: {
      truthLabel: "designProofOnly",
      homeLayout: "chatStatus",
      menuModel: "commandSheet",
      providerCardOpens: "workspaceHome",
      sessionControlSet: "fullNativeControl",
      approvalDepth: "summaryThenProof",
      entrypointPattern: "fullGridPostV1",
      passportPattern: "checklistSheet",
      ...overrides.mobile,
    },
    locked: [],
  }, null, 2));
  writeFile(designRoot, "saved/desktop-selection.json", JSON.stringify({
    surface: "desktop",
    operatorConfirmed: true,
    state: {
      truthLabel: "designProofOnly",
      layout: "threePane",
      providerParityView: "capabilityMatrixAndQueues",
      workflowBuilder: "canvasInspector",
      ...overrides.desktop,
    },
    locked: [],
  }, null, 2));
}

function writeCompleteRepo(root: string) {
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift", "FridayHomeScreen FridayChatScreen");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift", "friday.home.status-card markActivityDone");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift", "friday.chat.composer .accessibilityIdentifier(\"friday.chat.send\") approvalCard action_digest friday.chat.approval-card .accessibilityIdentifier(\"friday.chat.voice-input\") .accessibilityIdentifier(\"friday.chat.voice-output\")");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift", "Command Sheet friday.command-sheet.destination MobileProductDestinationID.allCases");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift", "Provider Workspace friday.provider-workspace.overview friday.provider-workspace.open-ledger");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift", "friday.session.sidecar-open friday.session.sidecar-close friday.session.send-button");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift", "Readiness plus local voice-loop truth friday.voice.readiness-card .accessibilityIdentifier(\"friday.voice.open-chat-loop\")");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift", "friday.context-passport.checklist friday.context-passport.send");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift", "viewModel.decideMemory");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift", `
    runtimeActionIds: ["mobile/home/refresh"]
    runtimeActionIds: ["mobile/providerAuth/check", "mobile/providerAuth/provider-workspace"]
    runtimeActionIds: ["mobile/session/sidecar/open", "mobile/session/sidecar/close", "mobile/workflow/run-control"]
    runtimeActionIds: ["mobile/approval/check", "mobile/approval/reject"]
    runtimeActionIds: ["mobile/voice/permission", "mobile/fridayChat/voice-input", "mobile/fridayChat/voice-output", "mobile/voice/open-chat-loop"]
    runtimeActionIds: ["mobile/passport/send", "mobile/memory/confirm", "mobile/memory/reject", "mobile/activity/mark-done"]
  `);

  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift", "ProofInspector Navigation");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/ProofInspector.swift", "ProofInspector");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift", "Navigation var isBuilt: Bool { contract.routeBuilt }");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift", "friday.desktop.provider-route-decision-card friday.desktop.provider-work-items-card friday.desktop.channels.admin friday.desktop.channels.surface-events friday.desktop.workflow.canvas friday.desktop.evidence.timeline-pages friday.desktop.evidence.transcript-browser friday.desktop.evidence.memory-review friday.desktop.evidence.memory-candidate");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift", "DesktopChatScreen");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift", `
    runtimeActionIds: ["desktop/channels/receipts", "desktop/channels/surface-events"]
    runtimeActionIds: ["desktop/workflow/retry", "desktop/workflow/cancel", "desktop/memory/act", "desktop/memory/check"]
  `);
}

function fixture(overrides: { mobile?: Record<string, string>; desktop?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "friday-uiux-native-linkage-"));
  const designRoot = join(root, "design");
  writeSelections(designRoot, overrides);
  writeCompleteRepo(root);
  return { root, designRoot };
}

describe("check-friday-uiux-native-linkage", () => {
  it("passes when selected UIUX decisions have native route, accessibility, and runtime action linkage", () => {
    const { root, designRoot } = fixture();
    try {
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as { status?: string; counts?: { linked?: number; gaps?: number } };
      expect(report.status).toBe("linked");
      expect(report.counts?.linked).toBe(10);
      expect(report.counts?.gaps).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports gaps without failing by default", () => {
    const { root, designRoot } = fixture();
    try {
      writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift", "friday.voice.readiness-card");
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as { status?: string; gaps?: Array<{ id?: string; missing?: string[] }> };
      expect(report.status).toBe("linkage_gaps_present");
      expect(report.gaps).toContainEqual(expect.objectContaining({
        id: "mobile-voice-loop",
        missing: expect.arrayContaining(["string:Readiness plus local voice-loop truth", "accessibility:friday.voice.open-chat-loop"]),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed in require-complete mode", () => {
    const { root, designRoot } = fixture({ mobile: { homeLayout: "wrong" } });
    try {
      const result = spawnSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { gaps?: Array<{ id?: string; missing?: string[] }> };
      expect(report.gaps).toContainEqual(expect.objectContaining({
        id: "mobile-home-status-chat",
        missing: expect.arrayContaining(["selection:homeLayout:wrong"]),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
