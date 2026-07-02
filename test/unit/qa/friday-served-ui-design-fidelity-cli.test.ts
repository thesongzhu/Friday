import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeSelections(root: string, options: { referenceHtml?: boolean; petInteractive?: boolean } = {}) {
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
  if (options.referenceHtml !== false) {
    writeFile(designRoot, "html/desktop-gallery.html", `
      <main data-reference-surface="desktop" data-selected-layout="threePane">
        <button data-friday-ui="button-primary">Approve</button>
        <span data-friday-ui="chip">Needs me</span>
        <span data-friday-ui="filter">All</span>
      </main>
    `);
    writeFile(designRoot, "html/pet-anim-v9-reference.html", options.petInteractive === false ? `
      <canvas id="pet-canvas" width="96" height="96"></canvas>
      <button data-pet-action="wag">Wag</button>
    ` : `
      <canvas id="pet-canvas" width="96" height="96"></canvas>
      <button data-pet-action="wag">Wag</button>
      <script>
        window.__pet = { frame: 0, interact() { this.frame += 1; return this.frame; } };
        const canvas = document.getElementById("pet-canvas");
        const context = canvas.getContext("2d");
        context.fillStyle = "#0f7d8c";
        context.fillRect(8, 8, 48, 48);
      </script>
    `);
  }
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

function writeFallbackTextDist(root: string) {
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
        <section>Checking local setup</section>
        <section>sample design-proof readiness entrypoints mock</section>
      </body>
    </html>
  `;
  writeFile(distRoot, "index.html", html);
  writeFile(distRoot, "home/index.html", html);
  writeFile(distRoot, "chat/index.html", html);
  return distRoot;
}

function run(root: string, designRoot: string, distRoot: string, iosRoot: string, extraArgs: string[] = []) {
  return spawnSync("node", [
    script,
    `--design-root=${designRoot}`,
    "--skip-build=true",
    `--dist=${distRoot}`,
    `--ios-source=${iosRoot}`,
    ...extraArgs,
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
      expect((report as { referenceOracle?: { status?: string; requiredOutputs?: string[] } }).referenceOracle?.status).toBe("parsed");
      expect((report as { referenceOracle?: { requiredOutputs?: string[] } }).referenceOracle?.requiredOutputs).toEqual([
        "selectedJsonSha256",
        "selectedHtmlSha256",
        "screenshotSha256",
        "computedStyleReport",
        "componentInventoryReport",
        "petInteractionReport",
        "actionInventoryContractReport",
      ]);
      const petReport = (report as {
        referenceOracle?: {
          petInteractionReport?: Record<string, { changed?: boolean; canvasNonBlank?: boolean }>;
        };
      }).referenceOracle?.petInteractionReport?.["pet-anim-v9-reference.html"];
      expect(petReport?.changed).toBe(true);
      expect(petReport?.canvasNonBlank).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails Gate A when selected desktop and pet reference HTML cannot be rendered into oracle artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-gate-a-missing-"));
    try {
      const result = run(root, writeSelections(root, { referenceHtml: false }), writeGoodDist(root), writeGoodIos(root));
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "Gate A selected reference HTML is missing: desktop-gallery.html",
        "Gate A selected reference HTML is missing: pet-anim-v9-reference.html",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails Gate C2 when the selected pet v9 reference is static or blank", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-gate-c2-static-pet-"));
    try {
      const result = run(root, writeSelections(root, { petInteractive: false }), writeGoodDist(root), writeGoodIos(root));
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "Gate C2 pet reference canvas is blank",
        "Gate C2 pet reference interaction hook is missing",
        "Gate C2 pet reference frame did not change after interaction",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails Gate D when the healthy served desktop normal path still renders fallback, demo, or internal readiness copy", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-gate-d-fallback-copy-"));
    try {
      const result = run(root, writeSelections(root), writeFallbackTextDist(root), writeGoodIos(root));
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "Gate D normal path still renders setup fallback copy",
        "Gate D normal path still renders demo/mock/design-proof copy",
        "Gate D normal path still renders internal readiness/entrypoints copy",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails Gate E when a visible action has no closed-loop contract evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-gate-e-open-action-"));
    try {
      const result = run(root, writeSelections(root), writeGoodDist(root), writeGoodIos(root));
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "Gate E action has no closed-loop contract evidence",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes and parses the Gate F proof manifest with all required linked artifact reports", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-proof-"));
    try {
      const artifactsRoot = join(root, "proof-artifacts");
      const result = run(root, writeSelections(root), writeGoodDist(root), writeGoodIos(root), [
        `--proof-artifacts-root=${artifactsRoot}`,
      ]);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as {
        proofManifest?: {
          status?: string;
          path?: string;
          requiredArtifacts?: string[];
        };
      };
      expect(report.proofManifest?.status).toBe("parsed");
      expect(report.proofManifest?.requiredArtifacts).toEqual([
        "screenshotHashes",
        "computedStyleComparison",
        "componentInventory",
        "structureAssertions",
        "petInteraction",
        "actionInventory",
        "actionClosure",
      ]);
      expect(report.proofManifest?.path).toBeTruthy();
      expect(existsSync(report.proofManifest?.path ?? "")).toBe(true);
      const manifest = JSON.parse(readFileSync(report.proofManifest?.path ?? "", "utf8")) as {
        artifacts?: Record<string, string>;
      };
      for (const key of report.proofManifest?.requiredArtifacts ?? []) {
        const linkedPath = manifest.artifacts?.[key];
        expect(linkedPath).toBeTruthy();
        expect(existsSync(linkedPath ?? "")).toBe(true);
        expect(() => JSON.parse(readFileSync(linkedPath ?? "", "utf8"))).not.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails an explicitly supplied Gate F proof manifest that is stale and disconnected from required artifact reports", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-stale-proof-"));
    try {
      const staleManifest = writeFile(root, "proof/manifest.json", JSON.stringify({
        reportId: "stale-proof",
        head: "old-head",
        buildId: "stale-build",
        artifacts: {
          screenshotHashes: join(root, "proof/missing-screenshot-hashes.json"),
          computedStyleComparison: join(root, "proof/missing-computed-style.json"),
          componentInventory: join(root, "proof/missing-component-inventory.json"),
          structureAssertions: join(root, "proof/missing-structure.json"),
          petInteraction: join(root, "proof/missing-pet.json"),
          actionInventory: join(root, "proof/missing-action-inventory.json"),
          actionClosure: join(root, "proof/missing-action-closure.json"),
        },
      }));
      const result = run(root, writeSelections(root), writeGoodDist(root), writeGoodIos(root), [
        `--proof-manifest=${staleManifest}`,
      ]);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "Gate F proof manifest head is stale-before-HEAD",
        "Gate F proof artifact is missing: screenshotHashes",
        "Gate F proof artifact is missing: actionClosure",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a current-HEAD Gate F proof manifest whose artifact identifiers are self-consistent but disconnected from the live run", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-served-ui-forged-proof-"));
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).stdout.trim();
      const forgedReportId = "forged-report";
      const forgedBuildId = "forged-build";
      const forgedScreenshotHash = "not-the-live-screenshot";
      const manifestPath = join(root, "proof/manifest.json");
      const artifactKeys = [
        "screenshotHashes",
        "computedStyleComparison",
        "componentInventory",
        "structureAssertions",
        "petInteraction",
        "actionInventory",
        "actionClosure",
      ];
      const artifacts = Object.fromEntries(artifactKeys.map((key) => [key, join(root, `proof/${key}.json`)]));
      for (const key of artifactKeys) {
        writeFile(root, `proof/${key}.json`, JSON.stringify({
          artifactType: key,
          reportId: forgedReportId,
          head,
          buildId: forgedBuildId,
          screenshotSha256: forgedScreenshotHash,
        }));
      }
      writeFile(root, "proof/manifest.json", JSON.stringify({
        reportId: forgedReportId,
        head,
        buildId: forgedBuildId,
        screenshotSha256: forgedScreenshotHash,
        requiredArtifacts: artifactKeys,
        artifacts,
      }));

      const result = run(root, writeSelections(root), writeGoodDist(root), writeGoodIos(root), [
        `--proof-manifest=${manifestPath}`,
      ]);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { checks?: Array<{ ok?: boolean; message?: string }> };
      const failures = report.checks?.filter((check) => check.ok === false).map((check) => check.message) ?? [];
      expect(failures).toEqual(expect.arrayContaining([
        "Gate F proof manifest is disconnected from this checker run identifiers",
        "Gate F proof manifest is disconnected from the live screenshot hash",
        "Gate F proof artifact is missing required body: screenshotHashes",
        "Gate F proof artifact is missing required body: actionClosure",
      ]));
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
