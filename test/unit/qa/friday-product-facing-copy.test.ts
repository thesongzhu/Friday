import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../../..");

const productSurfaceFiles = [
  "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift",
  "apps/friday-ios/Sources/FridayMobileShell/HeroPet.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/CompanionPetView.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
  "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopSessionDetailScreen.swift",
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
});
