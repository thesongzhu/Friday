import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const STATIC_FILE = path.join(ROOT, "friday-static.html");
const PROD_FILE = path.join(ROOT, "friday-static.prod.html");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const REPORT_FILE = path.join(ROOT, "polish-report.html");
const OUTPUT_DIR = path.join(ROOT, "screenshots", "polish");
const OUTPUT_REL = "screenshots/polish";

const DEFAULT_VIEWPORT = { width: 1440, height: 1100 };
const ROUTES_EN_SCAN = [
  "/home",
  "/chat",
  "/assistant",
  "/observability",
  "/packs",
  "/skills",
  "/skills/generator",
  "/workflows",
  "/workflows/builder",
  "/plugins",
  "/mcp",
  "/channels",
  "/automations",
  "/sessions",
  "/usage",
  "/memory",
  "/fleet",
  "/settings",
  "/command-center",
  "/onboarding",
  "/setup"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripRangePrefix(version) {
  return String(version || "").replace(/^[~^]/, "");
}

function round(value, digits = 1) {
  const factor = Math.pow(10, digits);
  return Math.round(Number(value || 0) * factor) / factor;
}

function pxToMm(px) {
  return round((Number(px || 0) * 25.4) / 96, 1);
}

function estimatePdfPageCount(buffer) {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

function routeFilePath(urlPathname) {
  const safePath = path.normalize(decodeURIComponent(urlPathname)).replace(/^(\.\.[/\\])+/, "");
  const absolute = path.join(ROOT, safePath);
  if (absolute.startsWith(ROOT) && absolute !== ROOT) {
    return absolute;
  }
  return null;
}

function createRewriteServer(indexFile) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const requested = routeFilePath(url.pathname);
    if (requested) {
      try {
        const stat = await fs.stat(requested);
        if (stat.isFile()) {
          const ext = path.extname(requested).toLowerCase();
          const body = await fs.readFile(requested);
          res.writeHead(200, {
            "content-type": MIME_TYPES[ext] || "application/octet-stream"
          });
          res.end(body);
          return;
        }
      } catch {
        // Fall through to SPA rewrite.
      }
    }

    const body = await fs.readFile(indexFile);
    res.writeHead(200, { "content-type": MIME_TYPES[".html"] });
    res.end(body);
  });
}

async function startServer(indexFile) {
  const server = createRewriteServer(indexFile);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function ensureDir(dirname) {
  await fs.mkdir(dirname, { recursive: true });
}

async function writeJson(relativePath, data) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  const body = JSON.stringify(data, null, 2);
  await fs.writeFile(absolutePath, `${body}\n`);
  return {
    path: relativePath,
    sha256: sha256(body),
    kind: "json"
  };
}

async function writeText(relativePath, body) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, body);
  return {
    path: relativePath,
    sha256: sha256(body),
    kind: "text"
  };
}

async function captureScreenshot(page, relativePath, options = {}) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  await page.screenshot({
    path: absolutePath,
    fullPage: options.fullPage !== false
  });
  const body = await fs.readFile(absolutePath);
  return {
    path: relativePath,
    sha256: sha256(body),
    kind: "png"
  };
}

async function captureLocatorScreenshot(locator, relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  await locator.screenshot({ path: absolutePath });
  const body = await fs.readFile(absolutePath);
  return {
    path: relativePath,
    sha256: sha256(body),
    kind: "png"
  };
}

async function capturePdf(page, relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  await page.pdf({
    path: absolutePath,
    printBackground: true,
    preferCSSPageSize: true
  });
  const body = await fs.readFile(absolutePath);
  return {
    path: relativePath,
    sha256: sha256(body),
    kind: "pdf",
    bytes: body.length,
    pageCount: estimatePdfPageCount(body)
  };
}

async function createContext(browser, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || DEFAULT_VIEWPORT,
    reducedMotion: options.reducedMotion || "no-preference"
  });

  const locale = options.locale || null;
  const tweaks = options.tweaks || null;
  if (locale || tweaks) {
    await context.addInitScript(
      ({ nextLocale, nextTweaks }) => {
        if (nextLocale) {
          window.localStorage.setItem("friday-locale", nextLocale);
        }
        if (nextTweaks) {
          const current = JSON.parse(window.localStorage.getItem("friday-tweaks") || "{}");
          window.localStorage.setItem(
            "friday-tweaks",
            JSON.stringify(Object.assign({}, current, nextTweaks))
          );
        }
      },
      { nextLocale: locale, nextTweaks: tweaks }
    );
  }

  if (Array.isArray(options.initScripts)) {
    for (const item of options.initScripts) {
      await context.addInitScript(item.script, item.arg);
    }
  }

  return context;
}

async function openPage(browser, baseUrl, route, options = {}) {
  const context = await createContext(browser, options);
  const consoleMessages = [];
  const pageErrors = [];
  const page = await context.newPage();

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text()
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });

  await page.goto(`${baseUrl}${route}`, { waitUntil: "load" });
  if (options.waitMs !== 0) {
    await page.waitForTimeout(options.waitMs || 180);
  }

  return {
    page,
    context,
    consoleMessages,
    pageErrors,
    async close() {
      await context.close();
    }
  };
}

async function buildRuleEvidence({ code, title, verify }, context) {
  try {
    const output = await verify(context);
    const artifactJson = await writeJson(`${OUTPUT_REL}/${code.toLowerCase()}-evidence.json`, {
      code,
      title,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      observed: output.observed,
      artifacts: output.artifacts
    });
    return {
      code,
      title,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      observed: output.observed,
      artifacts: [artifactJson].concat(output.artifacts),
      evidence: artifactJson.path
    };
  } catch (error) {
    const observed = {
      errorName: error.name,
      errorMessage: error.message
    };
    const artifactJson = await writeJson(`${OUTPUT_REL}/${code.toLowerCase()}-evidence.json`, {
      code,
      title,
      status: "FAIL",
      summary: error.message,
      observed,
      artifacts: []
    });
    return {
      code,
      title,
      status: "FAIL",
      summary: error.message,
      observed,
      artifacts: [artifactJson],
      evidence: artifactJson.path
    };
  }
}

function reportStatusBadge(status) {
  return status === "PASS" ? "status-pass" : "status-fail";
}

async function writeReport({ generatedAt, playwrightVersion, results }) {
  const passCount = results.filter((item) => item.status === "PASS").length;
  const failCount = results.length - passCount;
  const rows = results.map((item) => {
    const artifactLinks = item.artifacts
      .map((artifact) => `<a href="${escapeHtml(artifact.path)}">${escapeHtml(path.basename(artifact.path))}</a> <code>${escapeHtml(artifact.sha256.slice(0, 12))}</code>`)
      .join(" · ");
    return `
      <tr>
        <td><strong>${escapeHtml(item.code)}</strong></td>
        <td><span class="${reportStatusBadge(item.status)}">${escapeHtml(item.status)}</span></td>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.summary)}</td>
        <td>${artifactLinks}</td>
      </tr>
      <tr class="details-row">
        <td colspan="5"><details><summary>Observed</summary><pre>${escapeHtml(JSON.stringify(item.observed, null, 2))}</pre></details></td>
      </tr>`;
  }).join("");

  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Friday Polish Report</title>
  <style>
    :root {
      --bg: #f7efe4;
      --panel: #ffffff;
      --ink: #2d2118;
      --ink-2: rgba(45, 33, 24, 0.72);
      --border: rgba(45, 33, 24, 0.12);
      --accent: #9a5d25;
      --pass: #2f7a49;
      --fail: #a53028;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 40px 24px 64px;
      font: 14px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #fbf4ea 0%, #f1e4d4 100%);
    }
    main {
      max-width: 1280px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--ink-2);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.82);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
    }
    thead th {
      text-align: left;
      padding: 14px 16px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-2);
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.94);
    }
    tbody td {
      vertical-align: top;
      padding: 14px 16px;
      border-top: 1px solid var(--border);
    }
    .details-row td {
      padding-top: 0;
      background: rgba(248, 243, 236, 0.64);
    }
    .status-pass,
    .status-fail {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .status-pass {
      color: var(--pass);
      background: rgba(47, 122, 73, 0.12);
    }
    .status-fail {
      color: var(--fail);
      background: rgba(165, 48, 40, 0.12);
    }
    details summary {
      cursor: pointer;
      user-select: none;
    }
    pre {
      margin: 10px 0 0;
      padding: 12px;
      border-radius: 12px;
      background: #17120f;
      color: #f7efe4;
      overflow: auto;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    code {
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Friday Polish Report</h1>
      <div class="meta">
        <span class="chip">Generated ${escapeHtml(generatedAt)}</span>
        <span class="chip">Playwright ${escapeHtml(playwrightVersion)}</span>
        <span class="chip">PASS ${passCount}</span>
        <span class="chip">FAIL ${failCount}</span>
      </div>
    </header>
    <table>
      <thead>
        <tr>
          <th>Rule</th>
          <th>Status</th>
          <th>Checklist</th>
          <th>Summary</th>
          <th>Artifacts</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;

  await writeText(path.relative(ROOT, REPORT_FILE), body);
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(PACKAGE_JSON, "utf8"));
  const playwrightVersion = stripRangePrefix(packageJson.dependencies.playwright || "1.58.2");
  const sourceHtml = await fs.readFile(STATIC_FILE, "utf8");

  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await ensureDir(OUTPUT_DIR);

  const sourceServer = await startServer(STATIC_FILE);
  const browser = await chromium.launch({ headless: true });
  const generatedAt = new Date().toISOString();

  const rules = [
    {
      code: "A-01",
      title: "Rail responsive breakpoints keep 64/240/240 widths while topbar stays visible",
      verify: async () => {
        const artifacts = [];
        const observed = [];
        for (const viewport of [
          { width: 1280, height: 960 },
          { width: 1440, height: 1100 },
          { width: 1920, height: 1200 }
        ]) {
          const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home", {
            viewport,
            waitMs: 180
          });
          const data = await pageHandle.page.evaluate(() => {
            const rail = document.querySelector(".shell-rail");
            const topbar = document.querySelector(".shell-topbar");
            return {
              railWidth: Math.round(rail.getBoundingClientRect().width),
              topbarVisible: Boolean(topbar) && getComputedStyle(topbar).display !== "none"
            };
          });
          const screenshot = await captureScreenshot(
            pageHandle.page,
            `${OUTPUT_REL}/a01-rail-${viewport.width}.png`,
            { fullPage: false }
          );
          observed.push({ viewport, ...data });
          artifacts.push(screenshot);
          await pageHandle.close();
        }
        const widths = observed.map((item) => item.railWidth).join("/");
        const pass = widths === "64/240/240" && observed.every((item) => item.topbarVisible);
        return {
          pass,
          summary: `rail widths ${widths}; topbar visible ${observed.every((item) => item.topbarVisible)}`,
          observed: {
            widths: observed
          },
          artifacts
        };
      }
    },
    {
      code: "A-02",
      title: "Home hydrates from loading to normal in under 1 second without manual dev intervention",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home", {
          waitMs: 0,
          initScripts: [
            {
              script: () => {
                window.__qaA02 = { start: performance.now(), trace: [] };
                const poll = window.setInterval(() => {
                  if (!window.__fridayMock) {
                    return;
                  }
                  const publicState = window.__fridayMock.getState().pageStates["/home"];
                  const stateName = publicState && publicState.stateName ? publicState.stateName : publicState;
                  window.__qaA02.trace.push({
                    atMs: Math.round((performance.now() - window.__qaA02.start) * 10) / 10,
                    stateName,
                    skeletonCount: document.querySelectorAll(".skeleton-row").length,
                    runCardCount: document.querySelectorAll(".run-card").length
                  });
                  if (stateName === "normal" && window.__qaA02.trace.some((item) => item.stateName === "loading")) {
                    window.clearInterval(poll);
                  }
                }, 20);
              }
            }
          ]
        });
        await pageHandle.page.waitForFunction(
          () => {
            if (!window.__fridayMock) {
              return false;
            }
            const publicState = window.__fridayMock.getState().pageStates["/home"];
            const stateName = publicState && publicState.stateName ? publicState.stateName : publicState;
            return stateName === "normal" && document.querySelectorAll(".run-card").length > 0;
          },
          undefined,
          { timeout: 1600 }
        );
        const loadingPage = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=loading", {
          waitMs: 180
        });
        const loadingShot = await captureScreenshot(loadingPage.page, `${OUTPUT_REL}/a02-home-loading.png`);
        await loadingPage.close();
        const normalShot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/a02-home-normal.png`);
        const trace = await pageHandle.page.evaluate(() => window.__qaA02.trace);
        const loadingSample = trace.find((item) => item.stateName === "loading");
        const normalSample = trace.find((item) => item.stateName === "normal");
        const pass = Boolean(
          loadingSample
          && normalSample
          && loadingSample.skeletonCount > 0
          && normalSample.runCardCount > 0
          && normalSample.atMs < 1000
        );
        await pageHandle.close();
        return {
          pass,
          summary: loadingSample && normalSample
            ? `loading at ${loadingSample.atMs}ms; normal at ${normalSample.atMs}ms`
            : "missing loading or normal trace sample",
          observed: {
            loadingSample,
            normalSample,
            traceLength: trace.length
          },
          artifacts: [loadingShot, normalShot]
        };
      }
    },
    {
      code: "A-03",
      title: "Topbar right cluster is status pill, Cmd+K trigger, and settings menu with locale plus tweaks",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home");
        await pageHandle.page.click('[data-action="toggle-topbar-menu"]');
        await pageHandle.page.waitForTimeout(120);
        const observed = await pageHandle.page.evaluate(() => ({
          statusText: document.querySelector(".topbar-chip.is-status span:last-child")?.textContent?.trim() || null,
          commandText: document.querySelector(".topbar-button.is-command-trigger")?.textContent?.trim() || null,
          menuItems: Array.from(document.querySelectorAll(".topbar-settings-item")).map((node) => node.textContent.trim())
        }));
        const screenshot = await captureLocatorScreenshot(
          pageHandle.page.locator(".shell-topbar"),
          `${OUTPUT_REL}/a03-topbar-menu.png`
        );
        const pass = observed.statusText === "Friday 运行中"
          && /Cmd\+K/.test(observed.commandText || "")
          && observed.menuItems.length === 2;
        await pageHandle.close();
        return {
          pass,
          summary: `status "${observed.statusText}", command "${observed.commandText}", menu items ${observed.menuItems.length}`,
          observed,
          artifacts: [screenshot]
        };
      }
    },
    {
      code: "A-04",
      title: "Assistant deep link breadcrumb keeps root and tail labels readable",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/assistant?panel=approvals-pending");
        const observed = await pageHandle.page.evaluate(() =>
          Array.from(document.querySelectorAll(".topbar-breadcrumbs [data-breadcrumb-role]")).map((node) => ({
            role: node.getAttribute("data-breadcrumb-role"),
            text: node.textContent.trim()
          }))
        );
        const screenshot = await captureLocatorScreenshot(
          pageHandle.page.locator(".topbar-breadcrumbs"),
          `${OUTPUT_REL}/a04-breadcrumb.png`
        );
        const texts = observed.map((item) => item.text).join(" / ");
        const pass = texts === "Friday / 助手收件箱 / 待审批";
        await pageHandle.close();
        return {
          pass,
          summary: texts,
          observed,
          artifacts: [screenshot]
        };
      }
    },
    {
      code: "B-01",
      title: "Command Center keeps a 3-column shell even when the center lane is sparse",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/command-center");
        const observed = await pageHandle.page.evaluate(() => {
          const grid = document.querySelector("[data-command-center-grid]");
          return {
            gridColumns: getComputedStyle(grid).gridTemplateColumns,
            asideCount: grid.querySelectorAll("aside").length,
            sectionCount: grid.querySelectorAll("section").length
          };
        });
        const screenshot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/b01-command-center.png`);
        const pass = /^280px .* 320px$/.test(observed.gridColumns) && observed.asideCount === 2 && observed.sectionCount >= 1;
        await pageHandle.close();
        return {
          pass,
          summary: `grid ${observed.gridColumns}`,
          observed,
          artifacts: [screenshot]
        };
      }
    },
    {
      code: "B-02",
      title: "Home and Assistant loading skeletons share the same shimmer gradient and 1.6s loop",
      verify: async () => {
        const artifacts = [];
        const observed = [];
        for (const route of [
          "/home?dev=1&__state=loading",
          "/assistant?dev=1&__state=loading"
        ]) {
          const pageHandle = await openPage(browser, sourceServer.baseUrl, route);
          const data = await pageHandle.page.evaluate(() => {
            const node = document.querySelector(".skeleton-row");
            const style = getComputedStyle(node);
            return {
              route: location.pathname + location.search,
              skeletonCount: document.querySelectorAll(".skeleton-row").length,
              backgroundImage: style.backgroundImage,
              animationDuration: style.animationDuration
            };
          });
          const screenshot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/b02-${route.includes("/home") ? "home" : "assistant"}-loading.png`);
          observed.push(data);
          artifacts.push(screenshot);
          await pageHandle.close();
        }
        const [home, assistant] = observed;
        const pass = Boolean(
          home
          && assistant
          && home.skeletonCount > 0
          && assistant.skeletonCount > 0
          && home.backgroundImage === assistant.backgroundImage
          && home.animationDuration === assistant.animationDuration
          && home.animationDuration === "1.6s"
        );
        return {
          pass,
          summary: `gradient match ${home.backgroundImage === assistant.backgroundImage}; duration ${home.animationDuration}`,
          observed,
          artifacts
        };
      }
    },
    {
      code: "B-03",
      title: "Each empty surface exposes a visible CTA and clicking it performs a route or overlay action",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=empty");
        const routes = [
          "/home?dev=1&__state=empty",
          "/channels?dev=1&__state=empty",
          "/automations?dev=1&__state=empty",
          "/sessions?dev=1&__state=empty",
          "/command-center?dev=1&__state=idle"
        ];
        const observed = [];
        const artifacts = [];
        for (const route of routes) {
          await pageHandle.page.goto(`${sourceServer.baseUrl}${route}`, { waitUntil: "load" });
          await pageHandle.page.waitForTimeout(150);
          const beforeShot = await captureScreenshot(
            pageHandle.page,
            `${OUTPUT_REL}/b03-${route.split("?")[0].replaceAll("/", "-").replace(/^-/, "") || "home"}-empty.png`
          );
          const before = await pageHandle.page.evaluate(() => {
            const cta = document.querySelector("button[data-empty-cta], a[data-empty-cta]");
            return {
              path: location.pathname + location.search,
              hasCta: Boolean(cta),
              text: cta?.textContent?.trim() || null,
              href: cta?.getAttribute("href") || null,
              action: cta?.getAttribute("data-action") || null
            };
          });
          if (before.hasCta) {
            await pageHandle.page.locator("button[data-empty-cta], a[data-empty-cta]").first().click();
            await pageHandle.page.waitForTimeout(160);
          }
          const after = await pageHandle.page.evaluate(() => ({
            path: location.pathname + location.search,
            quickSheetOpen: Boolean(document.querySelector(".quick-sheet")),
            overlayOpen: Boolean(document.querySelector(".overlay-panel, .drawer-panel"))
          }));
          observed.push({
            route,
            hasCta: before.hasCta,
            text: before.text,
            href: before.href,
            action: before.action,
            beforePath: before.path,
            afterPath: after.path,
            quickSheetOpen: after.quickSheetOpen,
            overlayOpen: after.overlayOpen
          });
          artifacts.push(beforeShot);
        }
        const pass = observed.every((item) =>
          item.hasCta
          && (
            item.afterPath !== item.beforePath
            || item.quickSheetOpen
            || item.overlayOpen
            || Boolean(item.href)
            || Boolean(item.action)
          )
        );
        await pageHandle.close();
        return {
          pass,
          summary: `${observed.filter((item) => item.hasCta).length}/${observed.length} empty states expose a working CTA`,
          observed,
          artifacts
        };
      }
    },
    {
      code: "B-04",
      title: "Error surfaces expose copyable errorId plus three readable why lines",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=snapshot-error");
        const routes = [
          "/home?dev=1&__state=snapshot-error",
          "/observability?focus=traces&dev=1&__state=error",
          "/packs?dev=1&__state=error"
        ];
        const observed = [];
        const artifacts = [];
        for (const route of routes) {
          await pageHandle.page.goto(`${sourceServer.baseUrl}${route}`, { waitUntil: "load" });
          await pageHandle.page.waitForTimeout(150);
          const data = await pageHandle.page.evaluate(() => {
            const shell = document.querySelector(".inline-error-shell, .home-error-bar, .shell-inline-error");
            const details = shell?.querySelector("details");
            if (details) {
              details.open = true;
            }
            const lines = Array.from(shell?.querySelectorAll("details p") || []).map((node) => node.textContent.trim());
            return {
              hasErrorShell: Boolean(shell),
              copyButton: Boolean(shell?.querySelector('[data-action="copy-error-id"]')),
              lineCount: lines.length,
              lineLengths: lines.map((line) => line.length),
              lines
            };
          });
          const shot = await captureScreenshot(
            pageHandle.page,
            `${OUTPUT_REL}/b04-${route.split("?")[0].replaceAll("/", "-").replace(/^-/, "") || "home"}-error.png`
          );
          observed.push({ route, ...data });
          artifacts.push(shot);
        }
        const pass = observed.every((item) =>
          item.hasErrorShell
          && item.copyButton
          && item.lineCount >= 3
          && item.lineLengths.every((length) => length >= 12)
        );
        await pageHandle.close();
        return {
          pass,
          summary: `${observed.filter((item) => item.lineCount >= 3).length}/3 error states expose 3 readable reason lines`,
          observed,
          artifacts
        };
      }
    },
    {
      code: "B-05",
      title: "Approval strip appends a new fade-in slot without reordering the original three items",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        const beforeShot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/b05-approvals-before.png`);
        const observed = await pageHandle.page.evaluate(async () => {
          const before = Array.from(document.querySelectorAll(".approval-row")).map((node) => node.getAttribute("data-approval-id"));
          window.__fridayMock.dispatch({
            type: "approval.pending",
            approval: {
              id: "approval-test-new",
              title: { zh: "新增审批需要预算确认", en: "New approval needs budget confirmation" },
              summary: { zh: "测试", en: "Test" },
              severity: "medium",
              createdAt: new Date(window.__fridayMock.getState().clockMs).toISOString()
            }
          });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const after = Array.from(document.querySelectorAll(".approval-row")).map((node) => node.getAttribute("data-approval-id"));
          const newRow = document.querySelector('.approval-row[data-approval-id="approval-test-new"]');
          const style = newRow ? getComputedStyle(newRow) : null;
          return {
            before,
            after,
            newIndex: after.indexOf("approval-test-new"),
            firstThreeStable: before.every((id, index) => after[index] === id),
            animationName: style?.animationName || null,
            animationDuration: style?.animationDuration || null
          };
        });
        const afterShot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/b05-approvals-after.png`);
        const pass = observed.firstThreeStable
          && observed.newIndex === observed.before.length
          && observed.animationName === "run-fade"
          && observed.animationDuration === "0.5s";
        await pageHandle.close();
        return {
          pass,
          summary: `new approval index ${observed.newIndex}; first three stable ${observed.firstThreeStable}`,
          observed,
          artifacts: [beforeShot, afterShot]
        };
      }
    },
    {
      code: "C-01",
      title: "Compact density tightens topbar height, radius, card padding, and eyebrow size",
      verify: async () => {
        const cozyPage = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        const cozy = await cozyPage.page.evaluate(() => ({
          topbarHeight: getComputedStyle(document.documentElement).getPropertyValue("--shell-topbar-height").trim(),
          radius: getComputedStyle(document.documentElement).getPropertyValue("--radius-xl").trim(),
          cardPadding: getComputedStyle(document.querySelector(".shell-card")).padding,
          eyebrowFont: getComputedStyle(document.querySelector(".shell-card-eyebrow")).fontSize
        }));
        const cozyShot = await captureScreenshot(cozyPage.page, `${OUTPUT_REL}/c01-cozy.png`);
        await cozyPage.close();

        const compactPage = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal", {
          tweaks: { density: "compact" }
        });
        const compact = await compactPage.page.evaluate(() => ({
          topbarHeight: getComputedStyle(document.documentElement).getPropertyValue("--shell-topbar-height").trim(),
          radius: getComputedStyle(document.documentElement).getPropertyValue("--radius-xl").trim(),
          cardPadding: getComputedStyle(document.querySelector(".shell-card")).padding,
          eyebrowFont: getComputedStyle(document.querySelector(".shell-card-eyebrow")).fontSize
        }));
        const compactShot = await captureScreenshot(compactPage.page, `${OUTPUT_REL}/c01-compact.png`);
        await compactPage.close();

        const pass = cozy.topbarHeight === "56px"
          && compact.topbarHeight === "48px"
          && cozy.radius === "28px"
          && compact.radius === "20px"
          && cozy.cardPadding === "26px"
          && compact.cardPadding === "18px"
          && cozy.eyebrowFont === "11px"
          && compact.eyebrowFont === "10px";
        return {
          pass,
          summary: `topbar ${cozy.topbarHeight} -> ${compact.topbarHeight}; radius ${cozy.radius} -> ${compact.radius}; padding ${cozy.cardPadding} -> ${compact.cardPadding}; eyebrow ${cozy.eyebrowFont} -> ${compact.eyebrowFont}`,
          observed: { cozy, compact },
          artifacts: [cozyShot, compactShot]
        };
      }
    },
    {
      code: "C-02",
      title: "Run metrics use tabular numerals",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        const observed = await pageHandle.page.evaluate(() =>
          Array.from(document.querySelectorAll(".friday-metric, .friday-timer, .friday-count")).map((node) => ({
            text: node.textContent.trim(),
            fontVariantNumeric: getComputedStyle(node).fontVariantNumeric
          }))
        );
        const screenshot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/c02-tabular-numerals.png`);
        const pass = observed.length > 0 && observed.every((item) => item.fontVariantNumeric.includes("tabular-nums"));
        await pageHandle.close();
        return {
          pass,
          summary: `${observed.length} metric nodes report tabular-nums`,
          observed,
          artifacts: [screenshot]
        };
      }
    },
    {
      code: "C-03",
      title: "CJK copy uses pretty wrapping and avoids one-character last lines in repeated re-renders",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        const sourceHasRule = sourceHtml.includes("hanging-punctuation: allow-end last;") && sourceHtml.includes("text-wrap: pretty;");
        const observed = await pageHandle.page.evaluate(async () => {
          function roundValue(value, digits) {
            const factor = Math.pow(10, digits || 1);
            return Math.round(Number(value || 0) * factor) / factor;
          }
          const reference = document.querySelector("p");
          const sourceText = "Friday 正在聚合仓位、销售速度和延迟到货风险，并把补货建议压成下一步动作，避免中文末行只剩一个字。";
          function measureFixture() {
            const refStyle = getComputedStyle(reference);
            const probe = document.createElement("p");
            probe.textContent = sourceText;
            probe.style.position = "fixed";
            probe.style.left = "-9999px";
            probe.style.top = "0";
            probe.style.width = "180px";
            probe.style.font = refStyle.font;
            probe.style.lineHeight = refStyle.lineHeight;
            probe.style.letterSpacing = refStyle.letterSpacing;
            probe.style.textWrap = refStyle.textWrap;
            probe.style.hangingPunctuation = refStyle.hangingPunctuation;
            document.body.appendChild(probe);
            const range = document.createRange();
            range.selectNodeContents(probe);
            const rects = Array.from(range.getClientRects());
            const lastRect = rects[rects.length - 1];
            const charProbe = document.createElement("span");
            charProbe.textContent = "的";
            charProbe.style.position = "fixed";
            charProbe.style.left = "-9999px";
            charProbe.style.font = refStyle.font;
            document.body.appendChild(charProbe);
            const charWidth = charProbe.getBoundingClientRect().width || 1;
            charProbe.remove();
            const sample = {
              rectCount: rects.length,
              lastLineWidth: roundValue(lastRect ? lastRect.width : 0, 2),
              charWidth: roundValue(charWidth, 2),
              estimatedLastLineChars: roundValue(lastRect ? lastRect.width / charWidth : 0, 2),
              textWrap: getComputedStyle(probe).textWrap,
              hangingPunctuation: getComputedStyle(probe).hangingPunctuation || ""
            };
            probe.remove();
            return sample;
          }
          const samples = [];
          for (let index = 0; index < 3; index += 1) {
            samples.push(measureFixture());
            window.__fridayMock.advanceClock(1000);
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          return { samples };
        });
        await pageHandle.close();
        const pass = sourceHasRule && observed.samples.every((sample) =>
          sample.textWrap === "pretty" && sample.estimatedLastLineChars > 1.5
        );
        return {
          pass,
          summary: `source rule ${sourceHasRule}; last-line estimates ${observed.samples.map((item) => item.estimatedLastLineChars).join(", ")}`,
          observed: {
            sourceHasRule,
            samples: observed.samples
          },
          artifacts: []
        };
      }
    },
    {
      code: "D-01",
      title: "Document title updates per route and always ends with Friday",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home");
        const titles = [];
        for (const route of ["/home", "/chat", "/assistant", "/observability", "/settings"]) {
          await pageHandle.page.goto(`${sourceServer.baseUrl}${route}`, { waitUntil: "load" });
          await pageHandle.page.waitForTimeout(140);
          titles.push({
            route,
            title: await pageHandle.page.title()
          });
        }
        await pageHandle.close();
        const pass = titles.every((item) => item.title.endsWith("Friday"))
          && new Set(titles.map((item) => item.title)).size === titles.length;
        return {
          pass,
          summary: titles.map((item) => `${item.route}:${item.title}`).join(" | "),
          observed: { titles },
          artifacts: []
        };
      }
    },
    {
      code: "D-02",
      title: "Browser back restores scroll position after a client-side route change",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        const observed = await pageHandle.page.evaluate(async () => {
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise((resolve) => window.setTimeout(resolve, 80));
          const before = Math.round(window.scrollY);
          const link = document.querySelector('[data-nav="/chat"]');
          link.click();
          return { before };
        });
        await pageHandle.page.waitForTimeout(220);
        const routeAfter = await pageHandle.page.evaluate(() => location.pathname + location.search);
        await pageHandle.page.goBack({ waitUntil: "load" });
        await pageHandle.page.waitForTimeout(220);
        const after = await pageHandle.page.evaluate(() => Math.round(window.scrollY));
        await pageHandle.close();
        const diff = Math.abs(observed.before - after);
        return {
          pass: routeAfter === "/chat" && diff <= 2,
          summary: `scroll ${observed.before} -> ${after} (diff ${diff})`,
          observed: {
            before: observed.before,
            after,
            diff,
            routeAfter
          },
          artifacts: []
        };
      }
    },
    {
      code: "D-03",
      title: "Assistant deep link keeps packId across reload and lands on the cross-border handoff",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/assistant?packId=cross-border");
        const before = await pageHandle.page.evaluate(() => ({
          search: location.search,
          handoffVisible: Boolean(document.querySelector('[data-testid="pack-assistant-handoff-industry-cross-border-ecommerce"], [data-testid="cross-border-assistant-handoff"]'))
        }));
        await pageHandle.page.reload({ waitUntil: "load" });
        await pageHandle.page.waitForTimeout(180);
        const after = await pageHandle.page.evaluate(() => ({
          search: location.search,
          handoffVisible: Boolean(document.querySelector('[data-testid="pack-assistant-handoff-industry-cross-border-ecommerce"], [data-testid="cross-border-assistant-handoff"]'))
        }));
        const screenshot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/d03-assistant-packid.png`);
        await pageHandle.close();
        const pass = before.search === "?packId=cross-border"
          && after.search === "?packId=cross-border"
          && before.handoffVisible
          && after.handoffVisible;
        return {
          pass,
          summary: `search ${before.search} -> ${after.search}; handoff ${after.handoffVisible}`,
          observed: { before, after },
          artifacts: [screenshot]
        };
      }
    },
    {
      code: "E-01",
      title: "Focus ring appears only for keyboard focus-visible, not for mouse clicks",
      verify: async () => {
        const mousePage = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        await mousePage.page.click('[data-action="toggle-topbar-menu"]');
        await mousePage.page.waitForTimeout(60);
        const mouse = await mousePage.page.evaluate(() => {
          const button = document.querySelector('[data-action="toggle-topbar-menu"]');
          const style = getComputedStyle(button);
          return {
            outline: style.outline,
            boxShadow: style.boxShadow
          };
        });
        const mouseShot = await captureLocatorScreenshot(
          mousePage.page.locator(".shell-topbar"),
          `${OUTPUT_REL}/e01-mouse-focus.png`
        );
        await mousePage.close();

        const keyboardPage = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        await keyboardPage.page.keyboard.press("Tab");
        await keyboardPage.page.keyboard.press("Tab");
        await keyboardPage.page.waitForTimeout(60);
        const keyboard = await keyboardPage.page.evaluate(() => {
          const button = document.activeElement;
          const style = getComputedStyle(button);
          return {
            isSettingsButton: button.matches('[data-action="toggle-topbar-menu"]'),
            outline: style.outline,
            boxShadow: style.boxShadow
          };
        });
        const keyboardShot = await captureLocatorScreenshot(
          keyboardPage.page.locator(".shell-topbar"),
          `${OUTPUT_REL}/e01-keyboard-focus.png`
        );
        await keyboardPage.close();

        const pass = mouse.outline.includes("none")
          && keyboard.isSettingsButton
          && keyboard.outline.includes("solid 2px");
        return {
          pass,
          summary: `mouse outline "${mouse.outline}", keyboard outline "${keyboard.outline}"`,
          observed: { mouse, keyboard },
          artifacts: [mouseShot, keyboardShot]
        };
      }
    },
    {
      code: "E-02",
      title: "Cmd+K opens a real command palette with page, action, and skill results, then Enter routes to /packs",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home");
        await pageHandle.page.keyboard.press("Meta+K");
        await pageHandle.page.waitForTimeout(140);
        await pageHandle.page.keyboard.type("pack");
        await pageHandle.page.waitForTimeout(140);
        const before = await pageHandle.page.evaluate(() => ({
          activeTag: document.activeElement?.tagName || null,
          resultCount: document.querySelectorAll("[data-command-item-index]").length,
          kinds: Array.from(document.querySelectorAll("[data-command-item-index]")).slice(0, 5).map((node) => node.getAttribute("data-command-kind")),
          labels: Array.from(document.querySelectorAll("[data-command-item-index] strong")).slice(0, 5).map((node) => node.textContent.trim())
        }));
        const shot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/e02-command-palette.png`);
        await pageHandle.page.keyboard.press("Enter");
        await pageHandle.page.waitForTimeout(180);
        const after = await pageHandle.page.evaluate(() => ({
          path: location.pathname + location.search
        }));
        await pageHandle.close();
        const pass = before.activeTag === "INPUT"
          && before.resultCount >= 3
          && before.kinds.includes("page")
          && before.kinds.includes("action")
          && before.kinds.includes("skill")
          && after.path === "/packs";
        return {
          pass,
          summary: `${before.resultCount} results; kinds ${before.kinds.join(", ")}; Enter -> ${after.path}`,
          observed: { before, after },
          artifacts: [shot]
        };
      }
    },
    {
      code: "E-03",
      title: "First 20 tab stops on Home move downward naturally without bouncing between regions",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal");
        const trail = [];
        for (let index = 0; index < 20; index += 1) {
          await pageHandle.page.keyboard.press("Tab");
          await pageHandle.page.waitForTimeout(24);
          trail.push(await pageHandle.page.evaluate(() => {
            const node = document.activeElement;
            const rect = node.getBoundingClientRect();
            return {
              tag: node.tagName,
              text: (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
              x: Math.round(rect.x),
              y: Math.round(rect.y)
            };
          }));
        }
        await pageHandle.close();
        const monotonic = trail.every((item, index) => index === 0 || item.y >= trail[index - 1].y);
        return {
          pass: monotonic,
          summary: `tab trail monotonic ${monotonic}`,
          observed: { trail, monotonic },
          artifacts: []
        };
      }
    },
    {
      code: "F-01",
      title: "English locale leaves no Chinese text nodes across all shipped routes",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home", {
          locale: "en"
        });
        const observed = [];
        for (const route of ROUTES_EN_SCAN) {
          await pageHandle.page.goto(`${sourceServer.baseUrl}${route}`, { waitUntil: "load" });
          await pageHandle.page.waitForTimeout(160);
          const data = await pageHandle.page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const chinese = [];
            while (walker.nextNode()) {
              const text = (walker.currentNode.nodeValue || "").replace(/\s+/g, " ").trim();
              if (!text) {
                continue;
              }
              if (/[\u3400-\u9fff]/.test(text) && !/Friday/.test(text)) {
                chinese.push(text);
              }
            }
            return {
              count: chinese.length,
              sample: chinese.slice(0, 12)
            };
          });
          observed.push({ route, ...data });
        }
        await pageHandle.close();
        const pass = observed.every((item) => item.count === 0);
        return {
          pass,
          summary: `${observed.filter((item) => item.count === 0).length}/${observed.length} routes contain no Chinese text in en locale`,
          observed,
          artifacts: []
        };
      }
    },
    {
      code: "F-02",
      title: "Brand word Friday stays untranslated while surrounding copy localizes",
      verify: async () => {
        const runtimePage = await openPage(browser, sourceServer.baseUrl, "/home");
        const zhText = await runtimePage.page.evaluate(() =>
          document.querySelector(".topbar-chip.is-status span:last-child")?.textContent?.trim() || null
        );
        await runtimePage.page.evaluate(() => localStorage.setItem("friday-locale", "en"));
        await runtimePage.page.reload({ waitUntil: "load" });
        await runtimePage.page.waitForTimeout(160);
        const enText = await runtimePage.page.evaluate(() =>
          document.querySelector(".topbar-chip.is-status span:last-child")?.textContent?.trim() || null
        );
        await runtimePage.close();
        const fridayAsStandaloneKeyCount = (sourceHtml.match(/localizedText\(\s*"Friday"\s*,\s*"Friday"\s*\)/g) || []).length;
        const runningTemplatePresent = sourceHtml.includes('localize(uiState.locale, "Friday 运行中", "Friday running")');
        const pass = zhText === "Friday 运行中"
          && enText === "Friday running"
          && fridayAsStandaloneKeyCount === 0
          && runningTemplatePresent;
        return {
          pass,
          summary: `runtime "${zhText}" -> "${enText}"; standalone Friday keys ${fridayAsStandaloneKeyCount}`,
          observed: {
            zhText,
            enText,
            fridayAsStandaloneKeyCount,
            runningTemplatePresent
          },
          artifacts: []
        };
      }
    },
    {
      code: "F-03",
      title: "Compact density hides the third run meta line",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/home?dev=1&__state=normal", {
          tweaks: { density: "compact" }
        });
        const observed = await pageHandle.page.evaluate(() => {
          const runMeta = document.querySelector(".run-card .run-meta");
          const third = runMeta.children[2];
          return {
            childCount: runMeta.children.length,
            thirdDisplay: getComputedStyle(third).display
          };
        });
        const screenshot = await captureScreenshot(pageHandle.page, `${OUTPUT_REL}/f03-compact-run-card.png`);
        await pageHandle.close();
        return {
          pass: observed.childCount >= 3 && observed.thirdDisplay === "none",
          summary: `third meta display ${observed.thirdDisplay}`,
          observed,
          artifacts: [screenshot]
        };
      }
    },
    {
      code: "G-01",
      title: "Print mode exports Home, Assistant, and Observability to readable PDFs capped at two pages each",
      verify: async () => {
        const artifacts = [];
        const observed = [];
        const routes = [
          { route: "/home?dev=1&__state=normal", slug: "home" },
          { route: "/assistant?dev=1&__state=pending", slug: "assistant" },
          { route: "/observability?focus=alerts", slug: "observability" }
        ];
        for (const item of routes) {
          const pageHandle = await openPage(browser, sourceServer.baseUrl, item.route);
          const pageHeightPx = await pageHandle.page.evaluate(() =>
            Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
          );
          const printHeaderVisible = await pageHandle.page.evaluate(() =>
            Boolean(document.querySelector("[data-print-header='true']"))
          );
          await pageHandle.page.emulateMedia({ media: "print" });
          const pdf = await capturePdf(pageHandle.page, `${OUTPUT_REL}/g01-${item.slug}.pdf`);
          artifacts.push(pdf);
          observed.push({
            route: item.route,
            pageHeightPx,
            pageHeightMm: pxToMm(pageHeightPx),
            pageCount: pdf.pageCount,
            bytes: pdf.bytes,
            printHeaderVisible
          });
          await pageHandle.close();
        }
        const pass = observed.every((item) => item.pageCount <= 2);
        return {
          pass,
          summary: observed.map((item) => `${item.route}:${item.pageCount}p`).join(" | "),
          observed,
          artifacts
        };
      }
    },
    {
      code: "G-02",
      title: "Usage, Audit, and Alerts each export a non-empty Blob with a stable sha256",
      verify: async () => {
        const pageHandle = await openPage(browser, sourceServer.baseUrl, "/usage", {
          initScripts: [
            {
              script: () => {
                const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
                URL.createObjectURL = function createObjectUrlProxy(blob) {
                  window.__qaLastBlob = blob;
                  return nativeCreateObjectUrl(blob);
                };
              }
            }
          ]
        });
        const routes = [
          { route: "/usage", selector: '[data-action="usage-export"]' },
          { route: "/observability?focus=audit", selector: '[data-action="observability-export"][data-payload="audit"]' },
          { route: "/observability?focus=alerts", selector: '[data-action="observability-export"][data-payload="alerts"]' }
        ];
        const observed = [];
        for (const item of routes) {
          await pageHandle.page.goto(`${sourceServer.baseUrl}${item.route}`, { waitUntil: "load" });
          await pageHandle.page.waitForTimeout(180);
          await pageHandle.page.click(item.selector);
          await pageHandle.page.waitForTimeout(160);
          const blob = await pageHandle.page.evaluate(async () => {
            const exportBlob = window.__qaLastBlob;
            if (!exportBlob) {
              return null;
            }
            const buffer = await exportBlob.arrayBuffer();
            const digest = await crypto.subtle.digest("SHA-256", buffer);
            return {
              size: exportBlob.size,
              type: exportBlob.type,
              sha256: Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
            };
          });
          observed.push({
            route: item.route,
            ...blob
          });
        }
        await pageHandle.close();
        const pass = observed.every((item) => item && item.size > 0 && item.sha256);
        return {
          pass,
          summary: observed.map((item) => `${item.route}:${item.sha256?.slice(0, 12) || "missing"}`).join(" | "),
          observed,
          artifacts: []
        };
      }
    },
    {
      code: "H-01",
      title: "Prod build strips QA globals and keeps only version plus health hooks",
      verify: async () => {
        await execFileAsync("node", [path.join(ROOT, "scripts/qa/build-friday-static-prod.mjs")], {
          cwd: ROOT
        });
        const prodHtml = await fs.readFile(PROD_FILE, "utf8");
        const prodServer = await startServer(PROD_FILE);
        const pageHandle = await openPage(browser, prodServer.baseUrl, "/home");
        const runtime = await pageHandle.page.evaluate(() => ({
          mockType: typeof window.__fridayMock,
          qaType: typeof window.__fridayQa,
          versionType: typeof window.__fridayVersion,
          healthType: typeof window.__fridayHealth,
          title: document.title
        }));
        await pageHandle.close();
        await prodServer.close();
        const observed = {
          runtime,
          sourceHasMock: prodHtml.includes("window.__fridayMock"),
          sourceHasQa: prodHtml.includes("window.__fridayQa"),
          sourceHasVersion: prodHtml.includes("window.__fridayVersion"),
          sourceHasHealth: prodHtml.includes("window.__fridayHealth")
        };
        const pass = runtime.mockType === "undefined"
          && runtime.qaType === "undefined"
          && runtime.versionType === "string"
          && runtime.healthType === "function"
          && !observed.sourceHasMock
          && !observed.sourceHasQa
          && observed.sourceHasVersion
          && observed.sourceHasHealth;
        return {
          pass,
          summary: `prod mock ${runtime.mockType}; qa ${runtime.qaType}; version ${runtime.versionType}; health ${runtime.healthType}`,
          observed,
          artifacts: []
        };
      }
    }
  ];

  const results = [];
  for (const rule of rules) {
    results.push(await buildRuleEvidence(rule, { browser, baseUrl: sourceServer.baseUrl }));
  }

  const summaryArtifact = await writeJson(`${OUTPUT_REL}/polish-summary.json`, {
    generatedAt,
    playwrightVersion,
    passCount: results.filter((item) => item.status === "PASS").length,
    failCount: results.filter((item) => item.status === "FAIL").length,
    results
  });

  await writeReport({
    generatedAt,
    playwrightVersion,
    results
  });

  await browser.close();
  await sourceServer.close();

  process.stdout.write(JSON.stringify({
    generatedAt,
    playwrightVersion,
    passCount: results.filter((item) => item.status === "PASS").length,
    failCount: results.filter((item) => item.status === "FAIL").length,
    summary: summaryArtifact.path,
    report: path.relative(ROOT, REPORT_FILE)
  }, null, 2) + "\n");
}

await main();
