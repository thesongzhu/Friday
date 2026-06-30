import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-served-ui-design-fidelity.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function writeSelections(root: string) {
  const designRoot = join(root, "design");
  writeFile(designRoot, "saved/desktop-selection.json", JSON.stringify({
    operatorConfirmed: true,
    state: {
      palette: "cyanCoral",
      layout: "threePane",
      proofInspector: "rightDocked",
      desktopPet: "subtleStatus",
    },
  }));
  writeFile(designRoot, "saved/mobile-selection.json", JSON.stringify({
    operatorConfirmed: true,
    state: {
      palette: "cyanCoral",
      form: "glassNative",
      homeLayout: "chatStatus",
      menuModel: "commandSheet",
      petProminence: "heroPet",
      screen: "home",
    },
  }));
  writeFile(designRoot, "html/mobile-gallery.html", `
    <style>
      :root {
        --accent: #0f7d8c;
        --coral: #d8634d;
        --app-bg: #f7f6f2;
        --ok: #277a5d;
        --warn: #a86a1d;
        --danger: #c2493f;
      }
    </style>
  `);
  return designRoot;
}

function writeGoodIos(root: string) {
  const iosRoot = join(root, "ios");
  writeFile(iosRoot, "DesignTokens.swift", `
    enum MobileTheme {
      static let cyan = Color(red: 0.07, green: 0.55, blue: 0.62)
      static let coral = Color(red: 0.93, green: 0.42, blue: 0.38)
      static let backgroundWarmOffWhite = Color.white
    }
    struct GlassPanel<Content: View>: View {}
    struct FridayButton: View {}
    struct FridayChip: View {}
    struct FridayFilter: View {}
    struct FridaySegmentedControl: View {}
    struct FridayProofLine: View {}
    struct HomeView: View {
      var body: some View { HeroPet().accessibilityIdentifier("friday.home.selected-hero-pet") }
    }
    struct HeroPet: View {}
  `);
  writeFile(iosRoot, "CommandSheet.swift", `
    struct CommandSheet: View {
      private let sections: [String] = ["home", "platform", "chat"]
      private let diagnosticsSections: [String] = ["pairing", "settings"]
      var body: some View { FridaySegmentedControl(options: ["Auto", "Codex"], selection: .constant("Auto")) }
    }
  `);
  return iosRoot;
}

function writeBadIos(root: string) {
  const iosRoot = join(root, "ios");
  writeFile(iosRoot, "DesignTokens.swift", `
    enum MobileTheme { static let cyan = Color.blue }
    struct StatusChip: View {}
    struct DebugReadArms: View {
      var body: some View { Button("Read Arms") {}.buttonStyle(.borderedProminent) }
    }
  `);
  writeFile(iosRoot, "CommandSheet.swift", `
    struct CommandSheet: View {
      private let sections: [Destination] = [.home, .proofViewer, .entrypoints]
      private let diagnosticsSections: [Destination] = [.pairing, .proofViewer, .entrypoints]
      var body: some View { readinessFooter.pickerStyle(.segmented) }
    }
  `);
  return iosRoot;
}

function writeGoodDist(root: string) {
  const distRoot = join(root, "dist");
  writeFile(distRoot, "assets/app.css", `
    :root { --accent: #0f7d8c; --coral: #d8634d; --app-bg: #f7f6f2; }
    body { background: #f7f6f2; color: #242424; }
  `);
  const html = `
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="/assets/app.css"></head>
      <body>
        <main data-testid="app-shell-rail">Friday Hub</main>
        <aside data-testid="app-shell-right-rail" data-dock="right">
          <section data-testid="desktop-proof-inspector">Right-docked ProofInspector</section>
          <div data-testid="desktop-subtle-status-pet">subtle status</div>
          <button data-friday-ui="button-primary" style="background: rgb(15, 125, 140); color: white">Approve</button>
          <span data-friday-ui="chip">needs</span>
          <span data-friday-ui="filter">all</span>
        </aside>
      </body>
    </html>
  `;
  writeFile(distRoot, "index.html", html);
  writeFile(distRoot, "home/index.html", html);
  writeFile(distRoot, "chat/index.html", html);
  return distRoot;
}

function writeBadDist(root: string) {
  const distRoot = join(root, "dist");
  writeFile(distRoot, "assets/app.css", `
    :root { --amber-500: #c77d2e; --jade-500: #4f7a5c; }
    body { background: radial-gradient(circle, #fff8ef, #ffffff); color: #2f2115; }
    .agent-orb { background: rgba(122, 106, 88, 0.18); }
    .canvas { background-image: linear-gradient(to right, rgba(51, 41, 34, 0.05), transparent); }
  `);
  writeFile(distRoot, "index.html", `
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="/assets/app.css"></head>
      <body>
        <main data-testid="app-shell-rail">Console v2.0</main>
        <img alt="Friday status pet" />
        <section>Proof inspector - bottom timeline</section>
      </body>
    </html>
  `);
  writeFile(distRoot, "chat/index.html", `
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="/assets/app.css"></head>
      <body>
        <main data-testid="app-shell-rail">Chat without proof rail</main>
      </body>
    </html>
  `);
  return distRoot;
}

function run(root: string, designRoot: string, distRoot: string, iosRoot: string) {
  return spawnSync("node", [
    script,
    `--design-root=${designRoot}`,
    "--skip-build=true",
    `--dist=${distRoot}`,
    `--ios-source=${iosRoot}`,
  ], { cwd: process.cwd(), encoding: "utf8" });
}

describe("check-friday-served-ui-design-fidelity", () => {
  it("passes a minimal selected desktop+iOS fixture that applies locked tokens, right dock, subtle pet, and design-system controls", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-good-"));
    try {
      const result = run(root, writeSelections(root), writeGoodDist(root), writeGoodIos(root));
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as { status?: string; failureCount?: number };
      expect(report.status).toBe("pass");
      expect(report.failureCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails red-first for the old amber/jade desktop, bottom proof dock, hero pet, missing design-system controls, and stock iOS user path", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-bad-"));
    try {
      const result = run(root, writeSelections(root), writeBadDist(root), writeBadIos(root));
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "built css still carries old amber/jade token",
        "built css still carries decorative radial-gradient background",
        "built css still carries legacy decorative orb class",
        "built css still carries old warm-brown detail stroke",
        "built css still carries old espresso grid stroke",
        "iOS user path still contains stock borderedProminent button",
        "iOS user path still contains stock segmented picker",
        "iOS user path still contains generic StatusChip primitive",
        "iOS user path still contains raw Read Arms debug card in user source",
        "iOS Command Sheet still exposes proof/debug destinations in the user launcher",
        "iOS Command Sheet still exposes proof-harness destinations in the user launcher diagnostics drawer",
        "iOS Command Sheet still exposes internal proof/readiness language in the user launcher",
        "served desktop shell does not render a right rail",
        "served desktop shell does not expose right-docked ProofInspector",
        "served desktop still exposes bottom ProofInspector timeline",
        "served desktop home still exposes hero/static pet instead of subtle status pet",
        "served desktop subtle-status pet is missing",
        "served desktop does not expose design-system primary button marker",
        "served desktop does not expose design-system chip marker",
        "served desktop does not expose design-system filter marker",
        "served desktop rendered controls do not apply cyan/coral accent",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
