import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-native-action-closure.mjs";

const requiredFixtureFiles = [
  "package.json",
  "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShellCore/HomeViewModel.swift",
  "apps/friday-ios/Sources/FridayMobileShellCore/SessionContinuationViewModel.swift",
  "apps/friday-ios/Sources/FridayMobileShellCore/FridayChatViewModel.swift",
  "apps/friday-ios/Sources/FridayMobileShellCore/ShareIntakeViewModel.swift",
  "apps/friday-ios/Sources/FridayMobileShellCore/VoiceReadinessViewModel.swift",
  "apps/friday-ios/Tests/FridayMobileShellCoreTests/HomeViewModelTests.swift",
  "apps/friday-ios/Tests/FridayMobileShellCoreTests/SessionContinuationViewModelTests.swift",
  "apps/friday-ios/Tests/FridayMobileShellCoreTests/FridayChatViewModelTests.swift",
  "apps/friday-ios/Tests/FridayMobileShellCoreTests/ShareIntakeViewModelTests.swift",
  "apps/friday-ios/Tests/FridayMobileShellCoreTests/VoiceReadinessViewModelTests.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/OperationsOverviewScreen.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift",
  "apps/macos/FridayHubConsole/Tests/FridayHubConsoleCoreTests/OperationsOverviewViewModelTests.swift",
];

function run(repoRoot = process.cwd()) {
  return spawnSync("node", [script, repoRoot], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function copyFixture() {
  const root = mkdtempSync(join(tmpdir(), "friday-native-action-closure-"));
  for (const relativePath of requiredFixtureFiles) {
    const source = join(process.cwd(), relativePath);
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return root;
}

function replaceInFixture(root: string, relativePath: string, from: string, to: string) {
  const target = join(root, relativePath);
  const source = readFileSync(target, "utf8");
  expect(source).toContain(from);
  writeFileSync(target, source.replace(from, to));
}

describe("friday-native-action-closure", () => {
  it("passes on the current native mobile and desktop closure surface", () => {
    expect(existsSync(script)).toBe(true);
    const result = run();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      status?: string;
      truthLabel?: string;
      summary?: { failed?: number };
      caveat?: string;
    };
    expect(report.status).toBe("passed");
    expect(report.truthLabel).toBe("native_action_closure_static_behavior_guard_not_endbar_not_runtime_adoption");
    expect(report.summary?.failed).toBe(0);
    expect(report.caveat).toContain("not a substitute for simulator/desktop screenshots");
  });

  it("fails closed when an enabled mobile action loses its ViewModel driver", () => {
    const root = copyFixture();
    try {
      replaceInFixture(
        root,
        "apps/friday-ios/Sources/FridayMobileShellCore/HomeViewModel.swift",
        "public func retryWorkItem(",
        "public func retryWorkItemMissing(",
      );
      const result = run(root);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        status?: string;
        checks?: Array<{ id?: string; missing?: string[] }>;
      };
      expect(report.status).toBe("failed");
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "mobile-enabled-actions-have-viewmodel-drivers",
            missing: expect.arrayContaining(["retryWorkItem"]),
          }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when mobile route coverage is no longer separated from product closure", () => {
    const root = copyFixture();
    try {
      replaceInFixture(
        root,
        "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
        "var closureTier: MobileDestinationClosureTier",
        "var routeTier: MobileDestinationClosureTier",
      );
      const result = run(root);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        status?: string;
        checks?: Array<{ id?: string; missing?: string[] }>;
      };
      expect(report.status).toBe("failed");
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "mobile-command-sheet-separates-route-coverage-from-product-closure",
            missing: expect.arrayContaining(["var closureTier: MobileDestinationClosureTier"]),
          }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the package script is not exposed", () => {
    const root = copyFixture();
    try {
      replaceInFixture(
        root,
        "package.json",
        "\"check:native-action-closure\": \"node scripts/ops/check-friday-native-action-closure.mjs\",",
        "",
      );
      const result = run(root);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        checks?: Array<{ id?: string; missing?: string[] }>;
      };
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "package-exposes-native-action-closure-gate",
            missing: expect.arrayContaining(["\"check:native-action-closure\""]),
          }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
