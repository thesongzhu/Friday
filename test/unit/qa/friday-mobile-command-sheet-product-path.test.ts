import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const commandSheet = "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift";
const appShell = "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift";

function source() {
  return readFileSync(commandSheet, "utf8");
}

function arrayBody(name: string) {
  const text = source();
  const match = text.match(new RegExp(`private let ${name}: \\[\\(String, \\[MobileDestination\\]\\)\\] = \\[([\\s\\S]*?)\\n  \\]`));
  if (!match) throw new Error(`missing ${name}`);
  return match[1];
}

describe("Friday mobile command sheet product path", () => {
  it("keeps setup and proof tools out of the default user command path", () => {
    const product = arrayBody("productSections");

    for (const diagnostic of [".pairing", ".onboarding", ".settings", ".petEditor", ".proofViewer", ".entrypoints"]) {
      expect(product).not.toContain(diagnostic);
    }
    expect(product).toContain(".home");
    expect(product).toContain(".newSession");
    expect(product).toContain(".voice");
    expect(product).toContain(".shareIntake");
    expect(product).toContain(".missions");
    expect(product).toContain(".providerAuth");
    expect(product).toContain(".contextPassport");
  });

  it("keeps advanced diagnostics reachable through an explicit disclosure", () => {
    const diagnostics = arrayBody("diagnosticsSections");
    const text = source();

    for (const diagnostic of [".pairing", ".onboarding", ".settings", ".petEditor", ".proofViewer", ".entrypoints"]) {
      expect(diagnostics).toContain(diagnostic);
    }
    expect(text).toContain("friday.command-sheet.advanced-setup-disclosure");
    expect(text).toContain("Connection, device, and developer tools live here");
    expect(text).not.toContain("Pairing, readiness, proof, and entrypoint tools live here");
  });

  it("keeps the selected top-left command sheet affordance as a grid launcher", () => {
    const text = readFileSync(appShell, "utf8");

    expect(text).toContain('Image(systemName: "square.grid.2x2")');
    expect(text).toContain("friday.mobile.toolbar.command-sheet");
    expect(text).not.toContain('Image(systemName: "line.3.horizontal")');
  });

  it("classifies command sheet lanes so future routes cannot silently leak diagnostics into product", () => {
    const text = source();

    expect(text).toContain("var commandSheetLane: MobileProductCommandSurfaceLane");
    expect(text).toContain("?.commandSurfaceLane ?? .diagnostics");
  });

  it("keeps internal proof/readiness copy out of the user launcher body", () => {
    const text = source();
    const product = arrayBody("productSections");
    const body = text.match(/var body:[\s\S]*?\n  private func sectionView/)?.[0] ?? "";
    const userLauncher = `${product}\n${body}`;

    expect(userLauncher).not.toMatch(/\b(readiness|proof|END-BAR|entrypoint)\b/i);
  });
});
