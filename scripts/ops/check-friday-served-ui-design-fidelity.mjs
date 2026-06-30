#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_DESIGN_ROOT = resolve(process.env.HOME ?? "", "Desktop/friday-design-handoff-20260602");
const requireFromScript = createRequire(import.meta.url);

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? (process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[++i] ?? "true");
  args.set(key, value);
}

const designRoot = resolve(args.get("design-root") ?? process.env.FRIDAY_DESIGN_ROOT ?? DEFAULT_DESIGN_ROOT);
const skipBuild = args.get("skip-build") === "true";
const distRoot = resolve(args.get("dist") ?? join(ROOT, "dist/ui"));
const iosSourceRoot = resolve(args.get("ios-source") ?? join(ROOT, "apps/friday-ios/Sources/FridayMobileShell"));
const outPath = args.get("out") ?? process.env.FRIDAY_SERVED_UI_DESIGN_FIDELITY_REPORT ?? "";

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

  return checks.length > 0
    ? checks
    : [pass("built css applies cyan/coral tokens and excludes amber/jade tokens", { cssFiles: cssFiles.length })];
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
  const commandSheetSections = commandSheet.match(/private let sections:[\s\S]*?var body:/)?.[0] ?? "";
  if (/\.(proofViewer|entrypoints)\b/.test(commandSheetSections)) {
    checks.push(fail("iOS Command Sheet still exposes proof/debug destinations in the user launcher"));
  }
  if (/readinessFooter/.test(commandSheet)) {
    checks.push(fail("iOS Command Sheet still exposes readiness footer in the user launcher"));
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

    await page.goto(`${url}/home`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="app-shell-rail"]', { timeout: 10_000 });

    const result = await page.evaluate((expected) => {
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
      return {
        rightRailPresent: Boolean(rightRail),
        inspectorPresent: Boolean(inspector),
        bottomDockText,
        heroPet,
        subtlePetPresent: Boolean(subtlePet),
        primaryActionPresent: Boolean(primaryAction),
        chipPresent: Boolean(chip),
        filterPresent: Boolean(filter),
        hasAccentApplied,
        expected,
      };
    }, tokens);

    const checks = [];
    if (!result.rightRailPresent) checks.push(fail("served desktop shell does not render a right rail"));
    if (!result.inspectorPresent) checks.push(fail("served desktop shell does not expose right-docked ProofInspector"));
    if (result.bottomDockText) checks.push(fail("served desktop still exposes bottom ProofInspector timeline"));
    if (result.heroPet) checks.push(fail("served desktop home still exposes hero/static pet instead of subtle status pet"));
    if (!result.subtlePetPresent) checks.push(fail("served desktop subtle-status pet is missing"));
    if (!result.primaryActionPresent) checks.push(fail("served desktop does not expose design-system primary button marker"));
    if (!result.chipPresent) checks.push(fail("served desktop does not expose design-system chip marker"));
    if (!result.filterPresent) checks.push(fail("served desktop does not expose design-system filter marker"));
    if (!result.hasAccentApplied) checks.push(fail("served desktop rendered controls do not apply cyan/coral accent"));

    return checks.length > 0 ? checks : [pass("served desktop rendered structure matches selected design", result)];
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

const report = {
  status: "unknown",
  truth_label: "served_desktop_and_ios_design_fidelity_reads_real_selection_and_live_sources",
  generated_at_utc: new Date().toISOString(),
  head: currentHead(),
  designRoot,
  distRoot,
  iosSourceRoot,
  surface_scope: ["served-desktop-dist-ui", "ios-source-selected-design"],
  checks: [],
};

try {
  report.checks.push(...assertSelections());
  const tokens = readLockedTokens();
  report.lockedTokens = tokens;
  report.checks.push(...assertIosDesignFidelity(tokens));
  const buildCheck = runBuild();
  report.checks.push(buildCheck);
  if (buildCheck.ok) {
    report.checks.push(...assertBuiltCss(tokens));
    report.checks.push(...await assertRenderedStructure(tokens));
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
