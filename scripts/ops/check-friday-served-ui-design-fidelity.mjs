#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_DESIGN_ROOT = resolve(process.env.HOME ?? "", "Desktop/friday-design-handoff-20260602");
const REPO_DESIGN_WITNESS_ROOT = join(ROOT, "test/fixtures/friday-design-handoff-20260602");
const requireFromScript = createRequire(import.meta.url);

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? (process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[++i] ?? "true");
  args.set(key, value);
}

const explicitDesignRoot = args.get("design-root") ?? process.env.FRIDAY_DESIGN_ROOT ?? "";
const designRoot = resolve(explicitDesignRoot || (existsSync(join(DEFAULT_DESIGN_ROOT, "saved/desktop-selection.json"))
  ? DEFAULT_DESIGN_ROOT
  : REPO_DESIGN_WITNESS_ROOT));
const skipBuild = args.get("skip-build") === "true";
const distRoot = resolve(args.get("dist") ?? join(ROOT, "dist/ui"));
const iosSourceRoot = resolve(args.get("ios-source") ?? join(ROOT, "apps/friday-ios/Sources/FridayMobileShell"));
const outPath = args.get("out") ?? process.env.FRIDAY_SERVED_UI_DESIGN_FIDELITY_REPORT ?? "";
const explicitProofManifest = args.get("proof-manifest") ?? process.env.FRIDAY_SERVED_UI_PROOF_MANIFEST ?? "";
const proofArtifactsRoot = resolve(args.get("proof-artifacts-root")
  ?? process.env.FRIDAY_SERVED_UI_PROOF_ARTIFACT_ROOT
  ?? join(process.env.TMPDIR ?? "/tmp", "friday-served-ui-design-fidelity-proof"));
const reportId = `served-ui-design-fidelity-${randomUUID()}`;
const buildId = `${skipBuild ? "skip-build" : "build-ui"}:${Date.now()}`;
const REQUIRED_PROOF_ARTIFACTS = [
  "screenshotHashes",
  "computedStyleComparison",
  "componentInventory",
  "structureAssertions",
  "petInteraction",
  "actionInventory",
  "actionClosure",
];
const REQUIRED_REFERENCE_OUTPUTS = [
  "selectedJsonSha256",
  "selectedHtmlSha256",
  "screenshotSha256",
  "computedStyleReport",
  "componentInventoryReport",
  "petInteractionReport",
  "actionInventoryContractReport",
];
let renderedProof = null;

async function loadPlaywrightChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch (error) {
    const fallbackPackageJson = process.env.FRIDAY_PLAYWRIGHT_PACKAGE_JSON
      ?? resolve(process.env.HOME ?? "", "Projects/Friday/package.json");
    try {
      return createRequire(fallbackPackageJson)("playwright").chromium;
    } catch {
      try {
        return requireFromScript("playwright").chromium;
      } catch {
        throw error;
      }
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, details = {}) {
  return { ok: false, message, details };
}

function pass(message, details = {}) {
  return { ok: true, message, details };
}

function currentHead() {
  const result = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function extractCssVariable(css, name) {
  const match = css.match(new RegExp(`${name.replaceAll("-", "\\-")}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim();
}

function collectFiles(dir, predicate, acc = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectFiles(path, predicate, acc);
    } else if (predicate(path)) {
      acc.push(path);
    }
  }
  return acc;
}

function assertSelections() {
  const desktopSelection = readJson(join(designRoot, "saved/desktop-selection.json"));
  const mobileSelection = readJson(join(designRoot, "saved/mobile-selection.json"));
  const checks = [];

  if (!desktopSelection.operatorConfirmed) {
    checks.push(fail("desktop selection is not operator-confirmed"));
  }
  if (!mobileSelection.operatorConfirmed) {
    checks.push(fail("mobile selection is not operator-confirmed"));
  }
  if (desktopSelection.state?.palette !== "cyanCoral") {
    checks.push(fail("desktop selection palette is not cyanCoral", { actual: desktopSelection.state?.palette }));
  }
  if (desktopSelection.state?.layout !== "threePane") {
    checks.push(fail("desktop selection layout is not threePane", { actual: desktopSelection.state?.layout }));
  }
  if (desktopSelection.state?.proofInspector !== "rightDocked") {
    checks.push(fail("desktop selection proofInspector is not rightDocked", { actual: desktopSelection.state?.proofInspector }));
  }
  if (desktopSelection.state?.desktopPet !== "subtleStatus") {
    checks.push(fail("desktop selection desktopPet is not subtleStatus", { actual: desktopSelection.state?.desktopPet }));
  }
  if (mobileSelection.state?.palette !== "cyanCoral") {
    checks.push(fail("mobile selection palette is not cyanCoral", { actual: mobileSelection.state?.palette }));
  }
  if (mobileSelection.state?.form !== "glassNative") {
    checks.push(fail("mobile selection form is not glassNative", { actual: mobileSelection.state?.form }));
  }
  if (mobileSelection.state?.homeLayout !== "chatStatus") {
    checks.push(fail("mobile selection homeLayout is not chatStatus", { actual: mobileSelection.state?.homeLayout }));
  }
  if (mobileSelection.state?.menuModel !== "commandSheet") {
    checks.push(fail("mobile selection menuModel is not commandSheet", { actual: mobileSelection.state?.menuModel }));
  }
  if (mobileSelection.state?.petProminence !== "heroPet") {
    checks.push(fail("mobile selection petProminence is not heroPet", { actual: mobileSelection.state?.petProminence }));
  }
  if (mobileSelection.state?.screen !== "home") {
    checks.push(fail("mobile selection first screen is not home", { actual: mobileSelection.state?.screen }));
  }

  return checks.length > 0 ? checks : [pass("operator-confirmed selections loaded")];
}

function readLockedTokens() {
  const galleryCss = readText(join(designRoot, "html/mobile-gallery.html"));
  const accent = extractCssVariable(galleryCss, "--accent");
  const coral = extractCssVariable(galleryCss, "--coral");
  const appBg = extractCssVariable(galleryCss, "--app-bg");
  const ok = extractCssVariable(galleryCss, "--ok");
  const warn = extractCssVariable(galleryCss, "--warn");
  const danger = extractCssVariable(galleryCss, "--danger");
  if (!accent || !coral || !appBg) {
    throw new Error("Could not extract locked design tokens from mobile-gallery.html");
  }
  return { accent, coral, appBg, ok, warn, danger };
}

async function assertReferenceOracle() {
  const checks = [];
  const htmlFiles = [
    "mobile-gallery.html",
    "desktop-gallery.html",
    "pet-anim-v9-reference.html",
  ];
  const selectionFiles = [
    "desktop-selection.json",
    "mobile-selection.json",
  ];

  for (const file of htmlFiles) {
    if (!existsSync(join(designRoot, "html", file))) {
      checks.push(fail(`Gate A selected reference HTML is missing: ${file}`));
    }
  }
  for (const file of selectionFiles) {
    if (!existsSync(join(designRoot, "saved", file))) {
      checks.push(fail(`Gate A selected JSON is missing: ${file}`));
    }
  }
  if (checks.length > 0) {
    report.referenceOracle = {
      status: "missing",
      requiredOutputs: REQUIRED_REFERENCE_OUTPUTS,
    };
    return checks;
  }

  const chromium = await loadPlaywrightChromium();
  const browser = await chromium.launch({ headless: true });
  const selectedJsonSha256 = {};
  const selectedHtmlSha256 = {};
  const screenshotSha256 = {};
  const computedStyleReport = {};
  const componentInventoryReport = {};
  const petInteractionReport = {};
  const actionInventoryContractReport = {};

  try {
    for (const file of selectionFiles) {
      selectedJsonSha256[file] = sha256(readText(join(designRoot, "saved", file)));
    }

    for (const file of htmlFiles) {
      const htmlPath = join(designRoot, "html", file);
      selectedHtmlSha256[file] = sha256(readText(htmlPath));
      const page = await browser.newPage({ viewport: { width: file.includes("mobile") ? 390 : 1440, height: 900 } });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
      const screenshot = await page.screenshot({ fullPage: true });
      screenshotSha256[file] = sha256(screenshot);
      const snapshot = await page.evaluate(() => {
        const probe = document.querySelector("[data-friday-ui], button, [role='button'], canvas, main") ?? document.body;
        const style = getComputedStyle(probe);
        const actions = [...document.querySelectorAll("button, [role='button'], a[href], [data-pet-action]")]
          .map((node, index) => ({
            index,
            tagName: node.tagName.toLowerCase(),
            label: (node.textContent ?? node.getAttribute("aria-label") ?? node.getAttribute("data-pet-action") ?? "").trim().slice(0, 120),
            marker: node.getAttribute("data-friday-ui") ?? node.getAttribute("data-pet-action") ?? null,
            disabled: node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true",
          }));
        const before = typeof window.__pet?.frame === "number" ? window.__pet.frame : null;
        let interactionResult = null;
        if (typeof window.__pet?.interact === "function") {
          interactionResult = window.__pet.interact();
        }
        const after = typeof window.__pet?.frame === "number" ? window.__pet.frame : null;
        const canvas = document.querySelector("canvas");
        let canvasNonBlank = false;
        if (canvas instanceof HTMLCanvasElement) {
          const context = canvas.getContext("2d");
          if (context) {
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let index = 0; index < pixels.length; index += 4) {
              if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0 || pixels[index + 3] !== 0) {
                canvasNonBlank = true;
                break;
              }
            }
          }
        }
        return {
          computedStyle: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            fontFamily: style.fontFamily,
          },
          components: {
            fridayUiMarkers: [...document.querySelectorAll("[data-friday-ui]")].map((node) => node.getAttribute("data-friday-ui")),
            buttons: document.querySelectorAll("button, [role='button']").length,
            canvases: document.querySelectorAll("canvas").length,
            selectedSurfaces: [...document.querySelectorAll("[data-reference-surface]")].map((node) => node.getAttribute("data-reference-surface")),
          },
          actions,
          pet: {
            hasPetHook: Boolean(window.__pet),
            hasInteract: typeof window.__pet?.interact === "function",
            canvasNonBlank,
            before,
            after,
            changed: before !== null && after !== null && before !== after,
            interactionResult,
          },
        };
      });
      await page.close();
      computedStyleReport[file] = snapshot.computedStyle;
      componentInventoryReport[file] = snapshot.components;
      actionInventoryContractReport[file] = snapshot.actions;
      petInteractionReport[file] = snapshot.pet;
      if (file === "pet-anim-v9-reference.html") {
        if (!snapshot.pet.canvasNonBlank) {
          checks.push(fail("Gate C2 pet reference canvas is blank"));
        }
        if (!snapshot.pet.hasPetHook || !snapshot.pet.hasInteract) {
          checks.push(fail("Gate C2 pet reference interaction hook is missing"));
        }
        if (!snapshot.pet.changed) {
          checks.push(fail("Gate C2 pet reference frame did not change after interaction"));
        }
      }
    }
  } finally {
    await browser.close();
  }

  report.referenceOracle = {
    status: "parsed",
    requiredOutputs: REQUIRED_REFERENCE_OUTPUTS,
    selectedJsonSha256,
    selectedHtmlSha256,
    screenshotSha256,
    computedStyleReport,
    componentInventoryReport,
    petInteractionReport,
    actionInventoryContractReport,
  };
  return checks.length > 0 ? checks : [pass("Gate A selected reference oracle captured", {
    htmlFiles,
    selectionFiles,
    requiredOutputs: REQUIRED_REFERENCE_OUTPUTS,
  })];
}

function runBuild() {
  if (skipBuild) return pass("build skipped by explicit flag");
  const fallbackBin = resolve(process.env.HOME ?? "", "Projects/Friday/node_modules/.bin");
  const pathValue = [join(ROOT, "node_modules/.bin"), fallbackBin, process.env.PATH ?? ""].join(":");
  const result = spawnSync("npm", ["run", "build:ui"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, PATH: pathValue },
  });
  if (result.status !== 0) {
    return fail("npm run build:ui failed", {
      status: result.status,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000),
    });
  }
  return pass("served ui build completed");
}

function assertBuiltCss(tokens) {
  const cssFiles = collectFiles(distRoot, (path) => path.endsWith(".css"));
  const css = cssFiles.map((path) => readText(path)).join("\n");
  const lowerCss = css.toLowerCase();
  const checks = [];
  const required = [
    ["accent", tokens.accent],
    ["coral", tokens.coral],
    ["appBg", tokens.appBg],
  ];

  for (const [name, value] of required) {
    if (!lowerCss.includes(value.toLowerCase())) {
      checks.push(fail(`built css does not apply locked ${name}`, { expected: value }));
    }
  }

  const banned = ["#c77d2e", "#a86620", "#4f7a5c", "--amber-", "--jade-"];
  for (const value of banned) {
    if (lowerCss.includes(value.toLowerCase())) {
      checks.push(fail("built css still carries old amber/jade token", { banned: value }));
    }
  }
  const bannedDetailPatterns = [
    ["decorative radial-gradient background", /radial-gradient/i],
    ["legacy decorative orb class", /agent-orb/i],
    ["old warm-brown detail stroke", /rgba\(\s*122,\s*106,\s*88/i],
    ["old espresso grid stroke", /rgba\(\s*51,\s*41,\s*34/i],
  ];
  for (const [name, pattern] of bannedDetailPatterns) {
    if (pattern.test(css)) {
      checks.push(fail(`built css still carries ${name}`));
    }
  }

  return checks.length > 0
    ? checks
    : [pass("built css applies cyan/coral tokens and excludes stale decorative palette remnants", { cssFiles: cssFiles.length })];
}

function swiftFiles() {
  return collectFiles(iosSourceRoot, (path) => path.endsWith(".swift")).sort();
}

function swiftCorpus(files) {
  return files.map((path) => `\n// ${relative(ROOT, path)}\n${readText(path)}`).join("\n");
}

function listSwiftMatches(files, pattern) {
  const matches = [];
  for (const file of files) {
    const text = readText(file);
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) {
        matches.push({
          file: relative(ROOT, file),
          line: index + 1,
          text: lines[index].trim().slice(0, 180),
        });
      }
    }
  }
  return matches;
}

function assertIosDesignFidelity(tokens) {
  const checks = [];
  const files = swiftFiles();
  const corpus = swiftCorpus(files);

  if (!corpus.includes("static let cyan = Color(red: 0.07, green: 0.55, blue: 0.62)")) {
    checks.push(fail("iOS source does not carry the locked cyan token from the selected mobile design"));
  }
  if (!corpus.includes("static let coral = Color(red: 0.93, green: 0.42, blue: 0.38)")) {
    checks.push(fail("iOS source does not carry the locked coral token from the selected mobile design"));
  }
  if (!corpus.includes("backgroundWarmOffWhite")) {
    checks.push(fail("iOS source does not expose warm off-white selected background token"));
  }
  if (!corpus.includes("GlassPanel<Content: View>")) {
    checks.push(fail("iOS source does not expose a glass-native panel primitive"));
  }
  if (!corpus.includes("HeroPet()") || !corpus.includes("friday.home.selected-hero-pet")) {
    checks.push(fail("iOS Home does not expose the selected Hero Pet first-screen structure"));
  }
  if (!corpus.includes("CommandSheet")) {
    checks.push(fail("iOS source does not expose the selected command-sheet launcher"));
  }

  const requiredDesignSystemComponents = [
    "FridayButton",
    "FridayChip",
    "FridayFilter",
    "FridaySegmentedControl",
    "FridayProofLine",
  ];
  for (const name of requiredDesignSystemComponents) {
    if (!new RegExp(`\\b(struct|enum)\\s+${name}\\b`).test(corpus)) {
      checks.push(fail(`iOS design-system component is missing: ${name}`));
    }
  }

  const bannedPatterns = [
    {
      name: "stock borderedProminent button",
      pattern: /\.buttonStyle\(\.borderedProminent\)/,
    },
    {
      name: "stock bordered button",
      pattern: /\.buttonStyle\(\.bordered\)/,
    },
    {
      name: "stock segmented picker",
      pattern: /\.pickerStyle\(\.segmented\)/,
    },
    {
      name: "generic StatusChip primitive",
      pattern: /\bstruct\s+StatusChip\b/,
    },
    {
      name: "flat RefPill primitive",
      pattern: /\bstruct\s+RefPill\b/,
    },
    {
      name: "raw Read Arms debug card in user source",
      pattern: /"Read Arms"/,
    },
  ];
  for (const { name, pattern } of bannedPatterns) {
    const matches = listSwiftMatches(files, pattern);
    if (matches.length > 0) {
      checks.push(fail(`iOS user path still contains ${name}`, { matches: matches.slice(0, 12), totalMatches: matches.length }));
    }
  }

  const commandSheet = readText(join(iosSourceRoot, "CommandSheet.swift"));
  const commandProductSections =
    commandSheet.match(/private let productSections:[\s\S]*?\n  \]/)?.[0]
    ?? commandSheet.match(/private let sections:[\s\S]*?var body:/)?.[0]
    ?? "";
  const commandDiagnosticsSections =
    commandSheet.match(/private let diagnosticsSections:[\s\S]*?(?:\n\s*var body|\n\s*private func|$)/)?.[0] ?? "";
  const commandBody = commandSheet.match(/var body:[\s\S]*?\n  private func sectionView/)?.[0] ?? "";
  const userLauncherText = `${commandProductSections}\n${commandBody}`;
  if (/\.(pairing|onboarding|settings|petEditor|proofViewer|entrypoints)\b/.test(commandProductSections)) {
    checks.push(fail("iOS Command Sheet still exposes proof/debug destinations in the user launcher"));
  }
  if (/\.(proofViewer|entrypoints)\b/.test(commandDiagnosticsSections)) {
    checks.push(fail("iOS Command Sheet still exposes proof-harness destinations in the user launcher diagnostics drawer"));
  }
  if (/\breadinessFooter\b/.test(commandSheet) || /\b(readiness|proof|END-BAR|entrypoint)\b/i.test(userLauncherText)) {
    checks.push(fail("iOS Command Sheet still exposes internal proof/readiness language in the user launcher"));
  }

  return checks.length > 0
    ? checks
    : [pass("iOS source applies selected mobile design system and keeps debug/readiness surfaces out of the user path", {
      swiftFiles: files.length,
      lockedTokens: { accent: tokens.accent, coral: tokens.coral, appBg: tokens.appBg },
    })];
}

function contentType(path) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function apiDataFor(pathname) {
  if (pathname === "/v1/auth/me") {
    return { user: { id: "design-gate-user", displayName: "Design Gate", role: "operator" }, scopes: ["local"] };
  }
  if (pathname === "/v1/auth/bootstrap/status") {
    return { bootstrapRequired: false };
  }
  if (pathname === "/v1/setup/status") {
    return {
      needsSetup: false,
      setupCompletedAt: "2026-06-29T00:00:00.000Z",
      completedSteps: [],
      skippedSteps: [],
    };
  }
  if (pathname === "/v1/health" || pathname === "/v1/health/capabilities") {
    return { status: "healthy", capabilities: { system: { healthStatus: "healthy" } } };
  }
  if (pathname === "/v1/uix/user-profile") {
    return { profileType: "developer", onboardedAt: "2026-06-29T00:00:00.000Z" };
  }
  if (pathname === "/v1/uix/preferences") {
    return { items: [] };
  }
  if (pathname === "/v1/uix/home-snapshot") {
    return { snapshot: { generatedAt: "2026-06-29T00:00:00.000Z", runs: [], pendingApprovals: [], scheduledAutomations: [] } };
  }
  if (pathname.startsWith("/v1/diagnosis/learning/overview")) {
    return {
      coverage: {
        patterns: 0,
        lessons: 0,
        autoFixActions: 0,
        autoFixOutcomeBuckets: { recordedActions: 0, verifiedRepairs: 0, diagnosticOnly: 0, rollbackFailed: 0 },
      },
      recentRejectedFixes: [],
    };
  }
  if (pathname === "/v1/providers") {
    return { items: [] };
  }
  if (pathname === "/v1/providers/health") {
    return { items: [] };
  }
  if (pathname === "/v1/providers/routing") {
    return { defaultProviderId: "codex", defaultModel: "gpt-5.5", fallbackProviderIds: [] };
  }
  if (pathname.startsWith("/v1/providers/routing/explain")) {
    return {
      selected: {
        providerId: "codex",
        providerKind: "openai",
        model: "gpt-5.5",
        backendKind: "local",
        pinned: false,
      },
    };
  }
  if (pathname === "/v1/agent/automations") {
    return { items: [] };
  }
  return {};
}

function startStaticServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/v1/")) {
      const body = JSON.stringify({ ok: true, data: apiDataFor(url.pathname), requestId: "served-ui-design-gate" });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }

    let filePath = resolve(distRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!filePath.startsWith(distRoot)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      if (statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
      }
    } catch {
      filePath = join(distRoot, "index.html");
    }
    try {
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(readFileSync(filePath));
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("static server did not bind to a tcp port"));
        return;
      }
      resolveServer({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function assertRenderedStructure(tokens) {
  const { server, url } = await startStaticServer();
  let browser;
  try {
    const chromium = await loadPlaywrightChromium();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(() => {
      window.localStorage.setItem("friday.auth.user", JSON.stringify({ id: "design-gate-user", displayName: "Design Gate", role: "operator" }));
      window.sessionStorage.setItem("friday.auth.sessionAccessToken", "design-gate-token");
      window.sessionStorage.setItem("friday.auth.sessionAccessTokenExpiresAt", String(Date.now() + 60_000));
      window.localStorage.setItem("friday.shell.right-rail-collapsed", "0");
      window.localStorage.setItem("friday.shell.rail-collapsed", "0");
    });

    async function inspectRoute(pathname) {
      await page.goto(`${url}${pathname}`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="app-shell-rail"]', { timeout: 10_000 });
      return page.evaluate(async (expected) => {
      const rightRail = document.querySelector('[data-testid="app-shell-right-rail"]');
      const bottomDockText = [...document.querySelectorAll("section, aside, div")]
        .some((node) => /Proof inspector\s*[·-]\s*bottom timeline/i.test(node.textContent ?? ""));
      const heroPet = [...document.querySelectorAll("img")]
        .some((img) => /Friday status pet/i.test(img.getAttribute("alt") ?? ""));
      const subtlePet = document.querySelector('[data-testid="desktop-subtle-status-pet"]');
      const inspector = document.querySelector('[data-testid="desktop-proof-inspector"]');
      const primaryAction = document.querySelector('[data-friday-ui="button-primary"]');
      const chip = document.querySelector('[data-friday-ui="chip"]');
      const filter = document.querySelector('[data-friday-ui="filter"]');
      const styleProbe = primaryAction ?? rightRail;
      const computed = styleProbe ? getComputedStyle(styleProbe) : null;
      const background = computed?.backgroundColor ?? "";
      const color = computed?.color ?? "";
      const hasAccentApplied = [background, color].some((value) => {
        const normalized = value.replaceAll(" ", "");
        return normalized.includes("15,125,140") || normalized.includes("216,99,77");
      });

      const captureActionState = () => ({
        url: window.location.href,
        bodyHtml: document.body?.innerHTML ?? "",
        localStorage: JSON.stringify(Object.entries(window.localStorage).sort()),
        sessionStorage: JSON.stringify(Object.entries(window.sessionStorage).sort()),
        eventLog: JSON.stringify(window.__fridayActionEvents ?? window.__fridayGateActionEvents ?? []),
      });
      const visibleActionNodes = [...document.querySelectorAll("button, [role='button'], a[href]")]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0
            && rect.height > 0
            && style.visibility !== "hidden"
            && style.display !== "none"
            && node.getAttribute("aria-hidden") !== "true";
        });
      const actions = [];
      for (const [index, node] of visibleActionNodes.entries()) {
        const disabled = node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true";
        const contract = node.getAttribute("data-friday-action-contract") ?? null;
        const safeRefusal = node.getAttribute("data-friday-action-safe-refusal") ?? null;
        const ineligibility = node.getAttribute("data-friday-action-ineligibility") ?? null;
        const before = captureActionState();
        let clickError = null;
        const isNavigationLink = node instanceof HTMLAnchorElement && Boolean(node.getAttribute("href"));
        if (!disabled && !safeRefusal && contract && !isNavigationLink) {
          try {
            node.click();
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch (error) {
            clickError = error instanceof Error ? error.message : String(error);
          }
        }
        const after = captureActionState();
        const stateChanged = before.url !== after.url
          || before.bodyHtml !== after.bodyHtml
          || before.localStorage !== after.localStorage
          || before.sessionStorage !== after.sessionStorage
          || before.eventLog !== after.eventLog;
        const closedLoop = disabled
          ? Boolean(ineligibility)
          : Boolean(safeRefusal) || (Boolean(contract) && stateChanged);
        actions.push({
          index,
          tagName: node.tagName.toLowerCase(),
          label: (node.textContent ?? node.getAttribute("aria-label") ?? "").trim().slice(0, 120),
          marker: node.getAttribute("data-friday-ui") ?? null,
          testId: node.getAttribute("data-testid") ?? null,
          disabled,
          contract,
          safeRefusal,
          ineligibility,
          stateChanged,
          clickError,
          closedLoop,
          evidence: disabled
            ? (ineligibility ? "machine-readable-ineligibility" : "disabled-without-ineligibility")
            : safeRefusal
              ? "safe-refusal"
              : contract && stateChanged
                ? "real-state-change"
                : "missing-closed-loop",
        });
      }
      const visibleText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      return {
        rightRailPresent: Boolean(rightRail),
        inspectorPresent: Boolean(inspector),
        bottomDockText,
        heroPet,
        subtlePetPresent: Boolean(subtlePet),
        primaryActionPresent: Boolean(primaryAction),
        chipPresent: Boolean(chip),
        filterPresent: Boolean(filter),
        background,
        color,
        hasAccentApplied,
        actions,
        visibleText,
        expected,
      };
      }, tokens);
    }

    const checks = [];
    const routeResults = [];
    for (const pathname of ["/home", "/chat"]) {
      const result = await inspectRoute(pathname);
      const screenshot = await page.screenshot({ fullPage: true });
      routeResults.push({ pathname, screenshotSha256: sha256(screenshot), ...result });
      if (!result.rightRailPresent) checks.push(fail("served desktop shell does not render a right rail", { pathname }));
      if (!result.inspectorPresent) checks.push(fail("served desktop shell does not expose right-docked ProofInspector", { pathname }));
      if (result.bottomDockText) checks.push(fail("served desktop still exposes bottom ProofInspector timeline", { pathname }));
      if (result.heroPet) checks.push(fail("served desktop home still exposes hero/static pet instead of subtle status pet", { pathname }));
      if (!result.subtlePetPresent) checks.push(fail("served desktop subtle-status pet is missing", { pathname }));
      if (!result.primaryActionPresent) checks.push(fail("served desktop does not expose design-system primary button marker", { pathname }));
      if (!result.chipPresent) checks.push(fail("served desktop does not expose design-system chip marker", { pathname }));
      if (!result.filterPresent) checks.push(fail("served desktop does not expose design-system filter marker", { pathname }));
      if (!result.hasAccentApplied) checks.push(fail("served desktop rendered controls do not apply cyan/coral accent", { pathname }));
      const visibleText = result.visibleText.toLowerCase();
      if (/checking local setup|not set up yet|default offline|default unavailable/.test(visibleText)) {
        checks.push(fail("Gate D normal path still renders setup fallback copy", { pathname }));
      }
      if (/\b(mock|sample|design-proof|proof-harness)\b/.test(visibleText)) {
        checks.push(fail("Gate D normal path still renders demo/mock/design-proof copy", { pathname }));
      }
      if (/\b(readiness|entrypoints)\b/.test(visibleText)) {
        checks.push(fail("Gate D normal path still renders internal readiness/entrypoints copy", { pathname }));
      }
      for (const action of result.actions) {
        if (!action.closedLoop) {
          checks.push(fail("Gate E action has no closed-loop contract evidence", { pathname, action }));
        }
      }
    }

    renderedProof = {
      url,
      routeResults,
      tokens,
    };
    return checks.length > 0 ? checks : [pass("served desktop rendered structure matches selected design", { routes: routeResults })];
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function primaryScreenshotSha256() {
  return renderedProof?.routeResults?.[0]?.screenshotSha256 ?? null;
}

function proofArtifactBase(artifactType) {
  return {
    artifactType,
    reportId,
    head: report.head,
    buildId,
    generatedAtUtc: report.generated_at_utc,
    surfaceScope: report.surface_scope,
    designRoot,
    distRoot,
    iosSourceRoot,
    screenshotSha256: primaryScreenshotSha256(),
  };
}

function writeGeneratedProofManifest() {
  if (!renderedProof) return null;

  const dir = join(proofArtifactsRoot, reportId);
  const paths = {
    screenshotHashes: join(dir, "screenshot-hashes.json"),
    computedStyleComparison: join(dir, "computed-style-comparison.json"),
    componentInventory: join(dir, "component-inventory.json"),
    structureAssertions: join(dir, "structure-assertions.json"),
    petInteraction: join(dir, "pet-interaction.json"),
    actionInventory: join(dir, "action-inventory.json"),
    actionClosure: join(dir, "action-closure.json"),
  };
  const routes = renderedProof.routeResults;

  writeJson(paths.screenshotHashes, {
    ...proofArtifactBase("screenshotHashes"),
    screenshots: routes.map((route) => ({
      id: `served-desktop${route.pathname.replaceAll("/", "-") || "-root"}`,
      pathname: route.pathname,
      url: `${renderedProof.url}${route.pathname}`,
      sha256: route.screenshotSha256,
      appSurface: "served-desktop-dist-ui",
      buildId,
      reportId,
    })),
  });
  writeJson(paths.computedStyleComparison, {
    ...proofArtifactBase("computedStyleComparison"),
    comparisons: routes.map((route) => ({
      pathname: route.pathname,
      expectedTokens: renderedProof.tokens,
      actual: {
        background: route.background,
        color: route.color,
      },
      ok: route.hasAccentApplied,
    })),
  });
  writeJson(paths.componentInventory, {
    ...proofArtifactBase("componentInventory"),
    routes: routes.map((route) => ({
      pathname: route.pathname,
      components: {
        primaryActionPresent: route.primaryActionPresent,
        chipPresent: route.chipPresent,
        filterPresent: route.filterPresent,
        subtlePetPresent: route.subtlePetPresent,
      },
    })),
  });
  writeJson(paths.structureAssertions, {
    ...proofArtifactBase("structureAssertions"),
    routes: routes.map((route) => ({
      pathname: route.pathname,
      assertions: {
        rightRailPresent: route.rightRailPresent,
        inspectorPresent: route.inspectorPresent,
        bottomDockAbsent: !route.bottomDockText,
        heroPetAbsent: !route.heroPet,
      },
    })),
  });
  writeJson(paths.petInteraction, {
    ...proofArtifactBase("petInteraction"),
    status: "not_claimed_by_served_desktop_broad_fidelity_gate",
    routes: routes.map((route) => ({
      pathname: route.pathname,
      subtleStatusPetPresent: route.subtlePetPresent,
    })),
    note: "Gate F verifies this linked pet report is present, current, parsed, and bound; Gate C2 remains the v9 interaction oracle.",
  });
  writeJson(paths.actionInventory, {
    ...proofArtifactBase("actionInventory"),
    routes: routes.map((route) => ({
      pathname: route.pathname,
      actions: route.actions,
    })),
  });
  writeJson(paths.actionClosure, {
    ...proofArtifactBase("actionClosure"),
    status: routes.every((route) => route.actions.every((action) => action.closedLoop)) ? "closed-loop-verified" : "failed",
    inventoriedActions: routes.reduce((count, route) => count + route.actions.length, 0),
    closedLoopActions: routes.flatMap((route) => route.actions
      .filter((action) => action.closedLoop)
      .map((action) => ({ pathname: route.pathname, ...action }))),
    unresolvedActions: routes.flatMap((route) => route.actions
      .filter((action) => !action.closedLoop)
      .map((action) => ({ pathname: route.pathname, ...action }))),
    note: "Gate E requires every visible served-desktop action to have a contract with a real state change, safe refusal, or disabled machine-readable ineligibility evidence.",
  });

  const manifestPath = join(dir, "proof-manifest.json");
  writeJson(manifestPath, {
    schema: "friday.served-ui-design-fidelity.proof-manifest.v1",
    reportId,
    head: report.head,
    buildId,
    generatedAtUtc: report.generated_at_utc,
    appSurface: "served-desktop-dist-ui",
    screenshotSha256: primaryScreenshotSha256(),
    requiredArtifacts: REQUIRED_PROOF_ARTIFACTS,
    artifacts: paths,
  });
  return manifestPath;
}

function assertGateFProofManifest(manifestPath) {
  const checks = [];
  if (!manifestPath) {
    return {
      summary: { status: "missing", requiredArtifacts: REQUIRED_PROOF_ARTIFACTS },
      checks: [fail("Gate F proof manifest is missing")],
    };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return {
      summary: { status: "unreadable", path: manifestPath, requiredArtifacts: REQUIRED_PROOF_ARTIFACTS },
      checks: [fail("Gate F proof manifest is unreadable", {
        path: manifestPath,
        error: error instanceof Error ? error.message : String(error),
      })],
    };
  }

  if (manifest.head !== report.head) {
    checks.push(fail("Gate F proof manifest head is stale-before-HEAD", {
      expected: report.head,
      actual: manifest.head,
    }));
  }
  if (manifest.reportId !== reportId || manifest.buildId !== buildId) {
    checks.push(fail("Gate F proof manifest is disconnected from this checker run identifiers", {
      expected: { reportId, buildId },
      actual: { reportId: manifest.reportId, buildId: manifest.buildId },
    }));
  }
  if (manifest.screenshotSha256 !== primaryScreenshotSha256()) {
    checks.push(fail("Gate F proof manifest is disconnected from the live screenshot hash", {
      expected: primaryScreenshotSha256(),
      actual: manifest.screenshotSha256,
    }));
  }
  if (!manifest.reportId || !manifest.buildId || !manifest.screenshotSha256) {
    checks.push(fail("Gate F proof manifest is disconnected from report/build/screenshot identifiers"));
  }

  const parsedArtifacts = {};
  for (const key of REQUIRED_PROOF_ARTIFACTS) {
    const artifactPath = manifest.artifacts?.[key];
    if (!artifactPath || !existsSync(artifactPath)) {
      checks.push(fail(`Gate F proof artifact is missing: ${key}`, { path: artifactPath ?? null }));
      continue;
    }

    let artifact;
    try {
      artifact = readJson(artifactPath);
    } catch (error) {
      checks.push(fail(`Gate F proof artifact is not parseable JSON: ${key}`, {
        path: artifactPath,
        error: error instanceof Error ? error.message : String(error),
      }));
      continue;
    }

    parsedArtifacts[key] = artifactPath;
    if (artifact.artifactType !== key) {
      checks.push(fail(`Gate F proof artifact type mismatch: ${key}`, {
        path: artifactPath,
        actual: artifact.artifactType,
      }));
    }
    if (artifact.head !== report.head) {
      checks.push(fail(`Gate F proof artifact is stale-before-HEAD: ${key}`, {
        expected: report.head,
        actual: artifact.head,
      }));
    }
    if (artifact.reportId !== manifest.reportId || artifact.buildId !== manifest.buildId) {
      checks.push(fail(`Gate F proof artifact is disconnected from manifest identifiers: ${key}`, {
        path: artifactPath,
      }));
    }
    if (artifact.screenshotSha256 !== manifest.screenshotSha256) {
      checks.push(fail(`Gate F proof artifact is disconnected from screenshot hash: ${key}`, {
        path: artifactPath,
      }));
    }
    if (!hasRequiredArtifactBody(key, artifact, manifest)) {
      checks.push(fail(`Gate F proof artifact is missing required body: ${key}`, {
        path: artifactPath,
      }));
    }
  }

  return {
    summary: {
      status: checks.length === 0 ? "parsed" : "failed",
      path: manifestPath,
      requiredArtifacts: REQUIRED_PROOF_ARTIFACTS,
      parsedArtifacts,
    },
    checks: checks.length > 0 ? checks : [pass("Gate F proof manifest parsed all linked artifact reports", {
      path: manifestPath,
      requiredArtifacts: REQUIRED_PROOF_ARTIFACTS,
    })],
  };
}

function hasRequiredArtifactBody(key, artifact, manifest) {
  switch (key) {
    case "screenshotHashes":
      return Array.isArray(artifact.screenshots)
        && artifact.screenshots.some((screenshot) => screenshot?.sha256 === manifest.screenshotSha256);
    case "computedStyleComparison":
      return Array.isArray(artifact.comparisons)
        && artifact.comparisons.some((comparison) => comparison?.ok === true && comparison?.actual);
    case "componentInventory":
      return Array.isArray(artifact.routes)
        && artifact.routes.some((route) => route?.components?.primaryActionPresent === true);
    case "structureAssertions":
      return Array.isArray(artifact.routes)
        && artifact.routes.some((route) => route?.assertions?.rightRailPresent === true);
    case "petInteraction":
      return Array.isArray(artifact.routes)
        && artifact.routes.some((route) => route?.subtleStatusPetPresent === true)
        && typeof artifact.status === "string";
    case "actionInventory":
      return Array.isArray(artifact.routes)
        && artifact.routes.every((route) => Array.isArray(route?.actions));
    case "actionClosure":
      return typeof artifact.status === "string"
        && typeof artifact.inventoriedActions === "number"
        && Array.isArray(artifact.closedLoopActions)
        && Array.isArray(artifact.unresolvedActions)
        && artifact.unresolvedActions.length === 0
        && artifact.closedLoopActions.length === artifact.inventoriedActions;
    default:
      return false;
  }
}

const report = {
  status: "unknown",
  truth_label: "served_desktop_and_ios_design_fidelity_reads_real_selection_and_live_sources",
  generated_at_utc: new Date().toISOString(),
  head: currentHead(),
  designRoot,
  designRootSource: designRoot === REPO_DESIGN_WITNESS_ROOT ? "repo-witness-fallback" : "operator-desktop-handoff",
  distRoot,
  iosSourceRoot,
  reportId,
  buildId,
  surface_scope: ["served-desktop-dist-ui", "ios-source-selected-design"],
  checks: [],
};

try {
  report.checks.push(...assertSelections());
  const tokens = readLockedTokens();
  report.lockedTokens = tokens;
  report.checks.push(...await assertReferenceOracle());
  report.checks.push(...assertIosDesignFidelity(tokens));
  const buildCheck = runBuild();
  report.checks.push(buildCheck);
  if (buildCheck.ok) {
    report.checks.push(...assertBuiltCss(tokens));
    report.checks.push(...await assertRenderedStructure(tokens));
    const proofManifestPath = explicitProofManifest ? resolve(explicitProofManifest) : writeGeneratedProofManifest();
    const proofResult = assertGateFProofManifest(proofManifestPath);
    report.proofManifest = proofResult.summary;
    report.checks.push(...proofResult.checks);
  }
} catch (error) {
  report.checks.push(fail(error instanceof Error ? error.message : String(error)));
}

const failures = report.checks.filter((check) => !check.ok);
report.status = failures.length === 0 ? "pass" : "fail";
report.failureCount = failures.length;
if (outPath) {
  const resolvedOut = resolve(outPath);
  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
