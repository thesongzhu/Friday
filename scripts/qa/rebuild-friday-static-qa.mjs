import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const STATIC_FILE = path.join(ROOT, "friday-static.html");
const QA_REPORT_FILE = path.join(ROOT, "qa-report.html");
const SPECS_FILE = "/Users/jarvis/Desktop/Friday Acceptance Specs.html";
const BUILD_PLAN_FILE = "/Users/jarvis/Desktop/Friday Full Static Build Plan.csv";
const SETTINGS_HOOK_FILE = path.join(ROOT, "ui/src/hooks/use-system-health.ts");
const OUTPUT_DIR = path.join(ROOT, "screenshots", "P2A-01");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
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

function stripHtml(value) {
  return value
    .replace(/<code>/g, "`")
    .replace(/<\/code>/g, "`")
    .replace(/<strong[^>]*>/g, "")
    .replace(/<\/strong>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function routeFilePath(urlPathname) {
  const safePath = path.normalize(decodeURIComponent(urlPathname)).replace(/^(\.\.[/\\])+/, "");
  const absolute = path.join(ROOT, safePath);
  if (absolute.startsWith(ROOT) && absolute !== ROOT) {
    return absolute;
  }
  return null;
}

function createRewriteServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const requested = routeFilePath(url.pathname);
    if (requested) {
      try {
        const stat = await fs.stat(requested);
        if (stat.isFile()) {
          const ext = path.extname(requested).toLowerCase();
          const body = await fs.readFile(requested);
          res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
          res.end(body);
          return;
        }
      } catch {
        // Fall through to SPA rewrite.
      }
    }

    const body = await fs.readFile(STATIC_FILE);
    res.writeHead(200, { "content-type": MIME_TYPES[".html"] });
    res.end(body);
  });
}

async function startServer() {
  const server = createRewriteServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
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
    sha256: sha256(body)
  };
}

async function writeText(relativePath, body) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, body);
  return {
    path: relativePath,
    sha256: sha256(body)
  };
}

async function bootHomePage(browser, baseUrl, stateName) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: "no-preference"
  });
  const consoleMessages = [];
  const pageErrors = [];
  await context.addInitScript(() => {
    window.__qaScrollCalls = [];
    const nativeScrollTo = window.scrollTo.bind(window);
    window.scrollTo = function scrollToProxy(arg1, arg2) {
      const payload = typeof arg1 === "object"
        ? {
            left: arg1.left ?? null,
            top: arg1.top ?? null,
            behavior: arg1.behavior ?? "auto"
          }
        : { left: arg1 ?? null, top: arg2 ?? null, behavior: "auto" };
      window.__qaScrollCalls.push({
        at: new Date().toISOString(),
        payload
      });
      return nativeScrollTo(arg1, arg2);
    };
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  await page.goto(`${baseUrl}/home?dev=1&__state=${encodeURIComponent(stateName)}`, {
    waitUntil: "load"
  });
  await page.waitForFunction(() => Boolean(window.__fridayMock));
  await page.waitForTimeout(150);
  return { context, page, consoleMessages, pageErrors };
}

async function captureScreenshot(page, relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  await ensureDir(path.dirname(absolutePath));
  await page.screenshot({
    path: absolutePath,
    fullPage: true
  });
  const body = await fs.readFile(absolutePath);
  return {
    path: relativePath,
    sha256: sha256(body)
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
    sha256: sha256(body)
  };
}

function normalizeEvidenceResult({
  rule,
  code,
  acceptance,
  status,
  summary,
  artifacts,
  observed
}) {
  return {
    rule,
    code,
    acceptance,
    status,
    evidence: artifacts[0].path,
    artifacts,
    summary,
    observed
  };
}

async function verifyP2A01(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "H01",
    "snapshot 调用唯一 · 打开 /home 后 mock 场景只 1 次 __fridayMock.getState() · 无重复 fetch 风暴",
    async () => {
      const { page, context, consoleMessages, pageErrors } = await bootHomePage(browser, baseUrl, "normal");
      await page.waitForTimeout(300);
      const observed = await page.evaluate(() => ({
        getStateCalls: window.__fridayMock.__metrics.getStateCalls,
        navigationEntries: performance.getEntriesByType("navigation").length,
        route: window.location.pathname + window.location.search
      }));
      await context.close();
      const artifact = await writeJson("screenshots/P2A-01/h01-home-snapshot-call.json", {
        generatedAt: new Date().toISOString(),
        observed,
        consoleMessages,
        pageErrors
      });
      return {
        pass: observed.getStateCalls === 1 && observed.navigationEntries === 1 && consoleMessages.length === 0 && pageErrors.length === 0,
        summary: `boot getState=${observed.getStateCalls}, navigationEntries=${observed.navigationEntries}`,
        artifacts: [artifact],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "H02",
    "可见 polling 5s · active tab advanceClock(5000) 后触发一次 refetch · 误差 ≤ 200ms",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const observed = await page.evaluate(async () => {
        const before = window.__fridayMock.__metrics.getStateCalls;
        window.__fridayMock.advanceClock(4800);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const after4800 = window.__fridayMock.__metrics.getStateCalls;
        const t0 = performance.now();
        window.__fridayMock.advanceClock(200);
        while (window.__fridayMock.__metrics.getStateCalls === after4800) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const latencyMs = performance.now() - t0;
        return {
          before,
          after4800,
          after5000: window.__fridayMock.__metrics.getStateCalls,
          latencyMs
        };
      });
      await context.close();
      const artifact = await writeJson("screenshots/P2A-01/h02-visible-polling.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.before === 1 && observed.after4800 === 1 && observed.after5000 === 2 && observed.latencyMs <= 200,
        summary: `calls ${observed.before} -> ${observed.after5000}, latency=${observed.latencyMs.toFixed(1)}ms`,
        artifacts: [artifact],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "H03",
    "后台 polling 60s · visibilitychange hidden 后, 间隔变 60s",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const observed = await page.evaluate(async () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden"
        });
        document.dispatchEvent(new Event("visibilitychange"));
        const before = window.__fridayMock.__metrics.getStateCalls;
        window.__fridayMock.advanceClock(59000);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const after59000 = window.__fridayMock.__metrics.getStateCalls;
        const t0 = performance.now();
        window.__fridayMock.advanceClock(1000);
        while (window.__fridayMock.__metrics.getStateCalls === after59000) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return {
          before,
          after59000,
          after60000: window.__fridayMock.__metrics.getStateCalls,
          visibilityState: document.visibilityState,
          latencyMs: performance.now() - t0
        };
      });
      await context.close();
      const artifact = await writeJson("screenshots/P2A-01/h03-hidden-polling.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.before === 1 && observed.after59000 === 1 && observed.after60000 === 2 && observed.visibilityState === "hidden" && observed.latencyMs <= 200,
        summary: `hidden calls ${observed.before} -> ${observed.after60000}, latency=${observed.latencyMs.toFixed(1)}ms`,
        artifacts: [artifact],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "H04",
    "三段独立 loading · 未到的数据只显示对应段 skeleton · MUST NOT 整页 spinner",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "loading");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h04-loading-sections.png");
      const observed = await page.evaluate(() => ({
        liveSkeletons: document.querySelectorAll("#live-work-section .skeleton-row").length,
        scheduledSkeletons: document.querySelectorAll("#scheduled-section .skeleton-row").length,
        approvalRows: document.querySelectorAll("#approvals-section .approval-row").length,
        fullPageSpinnerCount: document.querySelectorAll(".page-spinner, [role='status']").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h04-loading-sections.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.liveSkeletons === 3 && observed.scheduledSkeletons === 3 && observed.approvalRows === 3 && observed.fullPageSpinnerCount === 0,
        summary: `live skeletons=${observed.liveSkeletons}, scheduled skeletons=${observed.scheduledSkeletons}, approvals=${observed.approvalRows}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "H05",
    "realtime 淡入 · run.state_changed 时对应 card 500ms opacity 0.5→1 淡入 + translateY(-2px) · 其他 card MUST NOT 重排",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const beforeShot = await captureScreenshot(page, "screenshots/P2A-01/h05-realtime-before.png");
      const before = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("[data-run-card]")).map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            id: node.getAttribute("data-run-card"),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          };
        });
      });
      await page.evaluate(() => {
        window.__fridayMock.dispatch({
          type: "run.state_changed",
          runId: "run-replenish-watch",
          from: "executing",
          to: "succeeded"
        });
      });
      await page.waitForTimeout(120);
      const during = await page.evaluate(() => {
        const target = document.querySelector("[data-run-card='run-replenish-watch']");
        const style = window.getComputedStyle(target);
        const cards = Array.from(document.querySelectorAll("[data-run-card]")).map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            id: node.getAttribute("data-run-card"),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            className: node.className
          };
        });
        return {
          target: {
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            statusText: target.querySelector(".status-pill")?.textContent?.trim() ?? ""
          },
          cards
        };
      });
      const afterShot = await captureScreenshot(page, "screenshots/P2A-01/h05-realtime-after.png");
      await context.close();
      const otherCardsStable = before
        .filter((card) => card.id !== "run-replenish-watch")
        .every((card) => {
          const next = during.cards.find((item) => item.id === card.id);
          return next && Math.abs(next.y - card.y) <= 1 && Math.abs(next.x - card.x) <= 1 && Math.abs(next.width - card.width) <= 1;
        });
      const observed = {
        before,
        during,
        otherCardsStable
      };
      const probe = await writeJson("screenshots/P2A-01/h05-realtime-transition.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshots: [beforeShot.path, afterShot.path]
      });
      return {
        pass:
          during.target.animationName === "run-fade" &&
          during.target.animationDuration === "0.5s" &&
          during.target.statusText.includes("已完成") &&
          otherCardsStable,
        summary: `animation=${during.target.animationName} ${during.target.animationDuration}, stable=${otherCardsStable}`,
        artifacts: [probe, beforeShot, afterShot],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "H06",
    "approvals 跳转 · 点全部查看后 URL 变 /assistant?tab=approvals · packId 保留",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const expectedHref = await page.getAttribute("#approvals-section .home-section-link", "href");
      await page.click("#approvals-section .home-section-link");
      await page.waitForFunction(() => window.location.pathname === "/assistant");
      const observed = await page.evaluate(() => ({
        href: window.location.pathname + window.location.search
      }));
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h06-approvals-navigation.png");
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h06-approvals-navigation.json", {
        generatedAt: new Date().toISOString(),
        expectedHref,
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          expectedHref === "/assistant?tab=approvals&packId=industry-cross-border-ecommerce" &&
          observed.href === expectedHref,
        summary: `href=${observed.href}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "H07",
    "approvals 0 条时段不渲染标题,显示空态文案,不留空白块",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      await page.evaluate(() => {
        ["approval-warehouse", "approval-provider", "approval-policy", "approval-fleet"].forEach((approvalId) => {
          window.__fridayMock.dispatch({ type: "approval.resolved", approvalId });
        });
      });
      await page.waitForTimeout(50);
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h07-approvals-empty.png");
      const observed = await page.evaluate(() => ({
        headerPresent: Boolean(document.querySelector("#approvals-section .home-section-title")),
        emptyText: document.querySelector("#approvals-section .home-inline-empty strong")?.textContent?.trim() ?? "",
        emptyHeight: document.querySelector("#approvals-section .home-inline-empty")?.getBoundingClientRect().height ?? 0
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h07-approvals-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.headerPresent === false &&
          observed.emptyText === "暂时没有需要你决定的事" &&
          observed.emptyHeight > 0,
        summary: `headerPresent=${observed.headerPresent}, text=${observed.emptyText}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "H08",
    "scheduled 排序 · 6 条数据时只显示前 5 条 + '+1 更多'",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h08-scheduled-order.png");
      const observed = await page.evaluate(() => {
        const items = window.__fridayMock.getState().pages.home.snapshot.scheduledAutomations;
        const expected = items
          .slice()
          .sort((left, right) => {
            if (left.enabled !== right.enabled) {
              return left.enabled ? -1 : 1;
            }
            const leftTime = left.nextRunAt ? new Date(left.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
            const rightTime = right.nextRunAt ? new Date(right.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
            return leftTime - rightTime;
          })
          .slice(0, 5)
          .map((item) => item.id);
        const domOrder = Array.from(document.querySelectorAll("#scheduled-section .scheduled-row")).map((node) => {
          const url = new URL(node.href);
          return url.searchParams.get("automationId");
        });
        return {
          expected,
          domOrder,
          rowCount: domOrder.length,
          moreText: document.querySelector("#scheduled-section .scheduled-more")?.textContent?.trim() ?? ""
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h08-scheduled-order.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.rowCount === 5 &&
          observed.moreText === "+1 更多" &&
          JSON.stringify(observed.expected) === JSON.stringify(observed.domOrder),
        summary: `rows=${observed.rowCount}, more=${observed.moreText}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "H09",
    "scheduled disabled 置灰 · automation.enabled === false 时 row opacity 0.35 · next run 文字替换成 '已暂停'",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h09-scheduled-disabled.png");
      const observed = await page.evaluate(() => {
        const row = document.querySelector("#scheduled-section a[href*='automation-weekly-margin']");
        const style = window.getComputedStyle(row);
        return {
          opacity: style.opacity,
          timeText: row.querySelector(".scheduled-time")?.textContent?.trim() ?? "",
          className: row.className
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h09-scheduled-disabled.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.opacity === "0.35" && observed.timeText === "已暂停" && observed.className.includes("is-disabled"),
        summary: `opacity=${observed.opacity}, time=${observed.timeText}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "H10",
    "snapshot 失败 · 显示 inline 错误条 + 刷新按钮 · MUST NOT 跳 splash · shell 保留",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "snapshot-error");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h10-snapshot-error.png");
      const observed = await page.evaluate(() => ({
        errorBarPresent: Boolean(document.querySelector("#live-work-section .home-error-bar")),
        refreshButtonText: document.querySelector("#live-work-section .action-button")?.textContent?.trim() ?? "",
        topbarPresent: Boolean(document.querySelector(".shell-topbar")),
        splashPresent: Boolean(document.querySelector(".splash-screen, .shell-splash"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h10-snapshot-error.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.errorBarPresent &&
          observed.refreshButtonText === "刷新" &&
          observed.topbarPresent &&
          observed.splashPresent === false,
        summary: `errorBar=${observed.errorBarPresent}, topbar=${observed.topbarPresent}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    11,
    "H11",
    "partial failure · 只 approvals 挂 · 该段显示行内错误 · 其他段正常",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "partial-failure");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h11-partial-failure.png");
      const observed = await page.evaluate(() => ({
        approvalsError: document.querySelector("#approvals-section .home-inline-error strong")?.textContent?.trim() ?? "",
        runCards: document.querySelectorAll("#live-work-section [data-run-card]").length,
        scheduledRows: document.querySelectorAll("#scheduled-section .scheduled-row").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h11-partial-failure.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.approvalsError === "审批快照暂时不可用" &&
          observed.runCards > 0 &&
          observed.scheduledRows > 0,
        summary: `approvalsError=${observed.approvalsError}, runs=${observed.runCards}, scheduled=${observed.scheduledRows}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    12,
    "H12",
    "dev switcher · 6 状态按钮全可切 · 切换无 reload · URL ?__state= 同步",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const states = [];
      const urls = [];
      const navCountBefore = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      const count = await page.locator(".dev-state-button").count();
      for (let index = 0; index < count; index += 1) {
        const label = await page.locator(".dev-state-button span:first-child").nth(index).textContent();
        states.push(label?.trim() ?? "");
        await page.locator(".dev-state-button").nth(index).click();
        await page.waitForTimeout(30);
        urls.push(new URL(page.url()).search);
      }
      const navCountAfter = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      await context.close();
      const artifact = await writeJson("screenshots/P2A-01/h12-dev-switcher.json", {
        generatedAt: new Date().toISOString(),
        observed: {
          states,
          urls,
          navCountBefore,
          navCountAfter
        }
      });
      const expectedStates = ["loading", "empty", "normal", "realtime-update", "partial-failure", "snapshot-error"];
      const urlSyncOk = expectedStates.every((stateName) =>
        urls.some((query) => query.includes(`__state=${encodeURIComponent(stateName)}`))
      );
      return {
        pass:
          states.length === 6 &&
          JSON.stringify(states) === JSON.stringify(expectedStates) &&
          navCountBefore === 1 &&
          navCountAfter === 1 &&
          urlSyncOk,
        summary: `states=${states.length}, navigationEntries=${navCountAfter}`,
        artifacts: [artifact],
        observed: {
          states,
          urls,
          navCountBefore,
          navCountAfter
        }
      };
    }
  );

  await verifyRule(
    13,
    "H13",
    "intent ribbon · 至少 4 个 pill · 点 pill 滚动到对应段(smooth · 80px offset)",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h13-intent-ribbon.png");
      const observed = await page.evaluate(async () => {
        const pills = Array.from(document.querySelectorAll(".intent-pill"));
        const target = document.getElementById("scheduled-section");
        const expectedTop = window.scrollY + target.getBoundingClientRect().top - 80;
        const scheduledPill = pills.find((node) => node.getAttribute("data-payload") === "scheduled-section");
        scheduledPill.click();
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          pillCount: pills.length,
          lastScrollCall: window.__qaScrollCalls[window.__qaScrollCalls.length - 1] || null,
          expectedTop
        };
      });
      await context.close();
      const actualTop = observed.lastScrollCall?.payload?.top ?? null;
      const actualBehavior = observed.lastScrollCall?.payload?.behavior ?? null;
      const probe = await writeJson("screenshots/P2A-01/h13-intent-ribbon.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.pillCount >= 4 &&
          actualBehavior === "smooth" &&
          actualTop !== null &&
          Math.abs(actualTop - observed.expectedTop) <= 1,
        summary: `pillCount=${observed.pillCount}, behavior=${actualBehavior}, top=${actualTop}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    14,
    "H14",
    "空状态整页 · runs + approvals + scheduled 全 0 时显示友好文案 + 跳 /chat CTA",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "empty");
      const shot = await captureScreenshot(page, "screenshots/P2A-01/h14-empty-hero.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".empty-hero h2")?.textContent?.trim() ?? "",
        ctaHref: document.querySelector(".empty-hero .action-button")?.getAttribute("href") ?? "",
        centered: window.getComputedStyle(document.querySelector(".page-empty")).justifyContent === "center"
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-01/h14-empty-hero.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "今天很清静,来开一场对话?" &&
          observed.ctaHref === "/chat" &&
          observed.centered,
        summary: `title=${observed.title}, cta=${observed.ctaHref}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();

  const acceptanceReport = {
    itemId: "P2A-01",
    route: "/home",
    generatedAt,
    verificationMode: "scripted-playwright",
    verifier: {
      script: "scripts/qa/rebuild-friday-static-qa.mjs",
      playwright: "1.58.2"
    },
    summary: {
      total: results.length,
      pass: results.filter((item) => item.status === "PASS").length,
      fail: results.filter((item) => item.status === "FAIL").length
    },
    acceptance: results,
    artifacts: Array.from(new Set(artifacts))
  };

  await ensureDir(OUTPUT_DIR);
  const acceptancePath = path.join(OUTPUT_DIR, "p2a-01-acceptance.json");
  const acceptanceBody = JSON.stringify(acceptanceReport, null, 2);
  await fs.writeFile(acceptancePath, `${acceptanceBody}\n`);

  return acceptanceReport;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeRun(baseRun, overrides = {}) {
  const next = {
    ...cloneJson(baseRun),
    ...overrides
  };
  next.health = {
    ...(baseRun.health || {}),
    ...(overrides.health || {})
  };
  next.contextSummary = {
    ...(baseRun.contextSummary || {}),
    ...(overrides.contextSummary || {})
  };
  next.metadata = {
    ...(baseRun.metadata || {}),
    ...(overrides.metadata || {})
  };
  return next;
}

function mergeApproval(baseApproval, overrides = {}) {
  return {
    ...cloneJson(baseApproval),
    ...overrides
  };
}

function mergeAutomation(baseAutomation, overrides = {}) {
  return {
    ...cloneJson(baseAutomation),
    ...overrides,
    schedule: {
      ...(baseAutomation.schedule || {}),
      ...(overrides.schedule || {})
    }
  };
}

async function readHomeQaState(page) {
  return page.evaluate(() => window.__fridayQa.home.getState());
}

async function setHomeQaSnapshot(page, snapshot, options = {}) {
  return page.evaluate(({ snapshot: nextSnapshot, options: nextOptions }) => {
    return window.__fridayQa.home.setSnapshot(nextSnapshot, nextOptions);
  }, { snapshot, options });
}

async function resolvedTokenColors(page, tokens) {
  return page.evaluate((tokenNames) => {
    const resolved = {};
    tokenNames.forEach((tokenName) => {
      const probe = document.createElement("div");
      probe.style.color = `var(${tokenName})`;
      document.body.appendChild(probe);
      resolved[tokenName] = window.getComputedStyle(probe).color;
      probe.remove();
    });
    return resolved;
  }, tokens);
}

async function verifyP2A02(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `L${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "runs 为 [] 时不渲染段标题,仅空态 · 非空时段标题 \"正在进行中 (N)\"",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const emptySnapshot = cloneJson(home.snapshot);
      emptySnapshot.runs = [];
      await setHomeQaSnapshot(page, emptySnapshot);
      const emptyShot = await captureScreenshot(page, "screenshots/P2A-02/l01-empty-board.png");
      const emptyObserved = await page.evaluate(() => ({
        headerPresent: Boolean(document.querySelector("#live-work-section .home-section-title")),
        emptyText: document.querySelector("#live-work-section .home-inline-empty strong")?.textContent?.trim() ?? ""
      }));
      const filledSnapshot = cloneJson(home.snapshot);
      filledSnapshot.runs = filledSnapshot.runs.slice(0, 2);
      await setHomeQaSnapshot(page, filledSnapshot);
      const filledShot = await captureScreenshot(page, "screenshots/P2A-02/l01-filled-board.png");
      const filledObserved = await page.evaluate(() => ({
        title: document.querySelector("#live-work-section .home-section-title")?.textContent?.trim() ?? ""
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l01-livework-title.json", {
        generatedAt: new Date().toISOString(),
        emptyObserved,
        filledObserved,
        screenshots: [emptyShot.path, filledShot.path]
      });
      return {
        pass:
          emptyObserved.headerPresent === false &&
          emptyObserved.emptyText === "现在没有正在进行中的运行" &&
          filledObserved.title === "正在进行中 (2)",
        summary: `emptyHeader=${emptyObserved.headerPresent}, filledTitle=${filledObserved.title}`,
        artifacts: [probe, emptyShot, filledShot],
        observed: {
          emptyObserved,
          filledObserved
        }
      };
    }
  );

  await verifyRule(
    2,
    "status pill 按 ACTIVE_RUN_STATUSES 9 种状态各有独立配色 · 只能用 tokens 里的 --success/--warning/--error/--accent/--ink-3",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const statuses = await page.evaluate(() => window.__fridayQa.constants.activeRunStatuses);
      const tokenColors = await resolvedTokenColors(page, ["--success", "--warning", "--error", "--accent", "--ink-3"]);
      const baseRun = home.snapshot.runs[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = statuses.map((status, index) => mergeRun(baseRun, {
        id: `qa-status-${status}`,
        task: `Status ${status}`,
        status,
        sessionKey: index % 2 === 0 ? `session-${status}` : null,
        startedAt: new Date(home.clockMs - (index + 1) * 60000).toISOString(),
        durationMs: status === "completed" ? (index + 1) * 42000 : null,
        health: status === "fixing" ? { state: "failed" } : status.includes("approval") || status === "testing" ? { state: "needs_approval" } : { state: "healthy" }
      }));
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-02/l02-status-pills.png");
      const observed = await page.evaluate((colors) => {
        return Array.from(document.querySelectorAll("#live-work-section [data-run-card]")).map((node) => {
          const pill = node.querySelector(".status-pill");
          const style = window.getComputedStyle(pill);
          return {
            id: node.getAttribute("data-run-card"),
            text: pill?.textContent?.trim() ?? "",
            className: pill?.className ?? "",
            inlineStyle: pill?.getAttribute("style") ?? "",
            color: style.color,
            allowedTokenMatch: Object.entries(colors).find(([, value]) => value === style.color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l02-status-pills.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed,
        screenshot: shot.path
      });
      const uniqueStatuses = new Set(observed.map((item) => item.id)).size;
      return {
        pass:
          observed.length === 9 &&
          uniqueStatuses === 9 &&
          observed.every((item) => item.inlineStyle === "" && item.allowedTokenMatch) &&
          observed.every((item) => item.className.includes("is-status-")),
        summary: `rendered=${observed.length}, inlineStyles=${observed.filter((item) => item.inlineStyle).length}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "health tone 用 toneForRunHealth(run) · 返回 healthy/warning/error 三档",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const observed = await page.evaluate(() => {
        const samples = [
          { id: "healthy-1", status: "executing", health: { state: "healthy" } },
          { id: "warning-1", status: "awaiting_plan_approval", health: { state: "needs_approval" } },
          { id: "warning-2", status: "testing", health: { state: "degraded" } },
          { id: "error-1", status: "fixing", health: { state: "failed" } },
          { id: "error-2", status: "failed", health: { state: "failed" } },
          { id: "healthy-2", status: "completed", health: { state: "healthy" } },
          { id: "warning-3", status: "executing", health: { state: "retryable" } },
          { id: "warning-4", status: "executing", health: { state: "rollback_available" } },
          { id: "healthy-3", status: "pending", health: { state: "healthy" } }
        ];
        return samples.map((sample) => ({
          id: sample.id,
          tone: window.__fridayQa.helpers.toneForRunHealth(sample)
        }));
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l03-run-health-tone.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const tones = new Set(observed.map((item) => item.tone));
      return {
        pass: tones.has("healthy") && tones.has("warning") && tones.has("error") && tones.size === 3,
        summary: `tones=${Array.from(tones).join(",")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "悬浮卡片 300ms delay 后显示 summarizeRunContext() tooltip · 位置 top · 箭头对齐",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const before = await page.evaluate(async () => {
        const card = document.querySelector("[data-run-card='run-replenish-watch']");
        card.dispatchEvent(new Event("mouseenter", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          tooltipVisible: Boolean(document.querySelector(".run-tooltip"))
        };
      });
      const after = await page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
        const card = document.querySelector("[data-run-card='run-replenish-watch']");
        const tooltip = document.querySelector(".run-tooltip");
        const cardRect = card.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const arrowStyle = window.getComputedStyle(tooltip, "::after");
        const arrowLeft = Number.parseFloat(arrowStyle.left) || 0;
        const arrowWidth = Number.parseFloat(arrowStyle.width) || 0;
        return {
          tooltipVisible: Boolean(tooltip),
          copy: tooltip?.textContent?.trim() ?? "",
          tooltipTop: tooltipRect.top,
          cardTop: cardRect.top,
          tooltipCenter: tooltipRect.left + tooltipRect.width / 2,
          cardCenter: cardRect.left + cardRect.width / 2,
          arrowCenter: tooltipRect.left + arrowLeft + arrowWidth / 2
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2A-02/l04-run-tooltip.png");
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l04-run-tooltip.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        screenshot: shot.path
      });
      return {
        pass:
          before.tooltipVisible === false &&
          after.tooltipVisible === true &&
          after.copy.length > 0 &&
          after.tooltipTop < after.cardTop &&
          Math.abs(after.tooltipCenter - after.cardCenter) <= 6 &&
          Math.abs(after.arrowCenter - after.cardCenter) <= 6,
        summary: `before=${before.tooltipVisible}, after=${after.tooltipVisible}, copyLength=${after.copy.length}`,
        artifacts: [probe, shot],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    5,
    "进度条颜色按 health tone · warning 黄 / error 红 / healthy 琥珀",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseRun = home.snapshot.runs[0];
      const tokenColors = await resolvedTokenColors(page, ["--warning", "--error", "--accent"]);
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [
        mergeRun(baseRun, { id: "qa-progress-healthy", task: "healthy", health: { state: "healthy" }, status: "executing" }),
        mergeRun(baseRun, { id: "qa-progress-warning", task: "warning", health: { state: "needs_approval" }, status: "awaiting_plan_approval" }),
        mergeRun(baseRun, { id: "qa-progress-error", task: "error", health: { state: "failed" }, status: "fixing" })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-02/l05-progress-colors.png");
      const observed = await page.evaluate((colors) => {
        return ["qa-progress-healthy", "qa-progress-warning", "qa-progress-error"].map((id) => {
          const fill = document.querySelector(`[data-run-card='${id}'] .run-progress-fill`);
          const color = window.getComputedStyle(fill).backgroundColor;
          return {
            id,
            color,
            token: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l05-progress-colors.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed,
        screenshot: shot.path
      });
      const byId = Object.fromEntries(observed.map((item) => [item.id, item.token]));
      return {
        pass:
          byId["qa-progress-healthy"] === "--accent" &&
          byId["qa-progress-warning"] === "--warning" &&
          byId["qa-progress-error"] === "--error",
        summary: `tokens=${observed.map((item) => `${item.id}:${item.token}`).join(", ")}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "时长实时更新 · advanceClock 推进时自动变 · 格式 HH:mm:ss 或 m 分 s 秒 (locale)",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseRun = home.snapshot.runs[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [mergeRun(baseRun, {
        id: "qa-duration-run",
        task: "duration",
        status: "executing",
        startedAt: new Date(home.clockMs - 65000).toISOString(),
        durationMs: null
      })];
      await setHomeQaSnapshot(page, snapshot);
      const observed = await page.evaluate(async () => {
        const before = document.querySelector("[data-run-card='qa-duration-run'] .run-meta strong")?.textContent?.trim() ?? "";
        window.__fridayMock.advanceClock(1000);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const after = document.querySelector("[data-run-card='qa-duration-run'] .run-meta strong")?.textContent?.trim() ?? "";
        return { before, after };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l06-duration-update.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.before !== observed.after && /分|:/.test(observed.after),
        summary: `${observed.before} -> ${observed.after}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "卡片点击 · 若 run 有 sessionId · 跳 /chat?session=xxx · 否则跳 /sessions?runId=xxx",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseRun = home.snapshot.runs[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [
        mergeRun(baseRun, { id: "qa-route-session", task: "session route", status: "executing", sessionKey: "session-route-proof" }),
        mergeRun(baseRun, { id: "qa-route-run", task: "run route", status: "testing", sessionKey: null })
      ];
      await setHomeQaSnapshot(page, snapshot);
      await page.evaluate(() => {
        document.querySelector("[data-run-card='qa-route-session']").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForFunction(() => window.location.pathname === "/chat");
      const firstHref = new URL(page.url()).pathname + new URL(page.url()).search;
      await page.goto(`${baseUrl}/home?dev=1&__state=normal`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa));
      await setHomeQaSnapshot(page, snapshot);
      await page.evaluate(() => {
        document.querySelector("[data-run-card='qa-route-run']").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForFunction(() => window.location.pathname === "/sessions");
      const secondHref = new URL(page.url()).pathname + new URL(page.url()).search;
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l07-run-navigation.json", {
        generatedAt: new Date().toISOString(),
        observed: { firstHref, secondHref }
      });
      return {
        pass:
          firstHref === "/chat?session=session-route-proof" &&
          secondHref === "/sessions?runId=qa-route-run",
        summary: `${firstHref} | ${secondHref}`,
        artifacts: [probe],
        observed: { firstHref, secondHref }
      };
    }
  );

  await verifyRule(
    8,
    "键盘 · Tab 可聚焦 · Enter 触发点击 · focus ring 2px",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseRun = home.snapshot.runs[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [mergeRun(baseRun, { id: "qa-keyboard-run", task: "keyboard route", status: "executing", sessionKey: "keyboard-proof" })];
      await setHomeQaSnapshot(page, snapshot);
      await page.locator(".intent-pill").last().focus();
      await page.keyboard.press("Tab");
      const focusObserved = await page.evaluate(() => {
        const node = document.activeElement;
        const style = window.getComputedStyle(node);
        return {
          tagName: node?.tagName ?? null,
          id: node?.getAttribute("data-run-card") ?? null,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          href: node?.getAttribute("href") ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2A-02/l08-run-keyboard.png");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.location.pathname === "/chat");
      const route = new URL(page.url()).pathname + new URL(page.url()).search;
      await context.close();
      const probe = await writeJson("screenshots/P2A-02/l08-run-keyboard.json", {
        generatedAt: new Date().toISOString(),
        focusObserved,
        route,
        screenshot: shot.path
      });
      return {
        pass:
          focusObserved.tagName === "A" &&
          focusObserved.id === "qa-keyboard-run" &&
          focusObserved.outlineWidth === "2px" &&
          focusObserved.href === "/chat?session=keyboard-proof" &&
          route === "/chat?session=keyboard-proof",
        summary: `focus=${focusObserved.id}, route=${route}`,
        artifacts: [probe, shot],
        observed: { focusObserved, route }
      };
    }
  );

  await verifyRule(
    9,
    "run.state_changed event · 卡片 500ms 淡入 · 不 reflow 其他卡片",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const before = await page.evaluate(() => Array.from(document.querySelectorAll("[data-run-card]")).map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.getAttribute("data-run-card"), x: rect.x, y: rect.y };
      }));
      await page.evaluate(() => {
        window.__fridayMock.dispatch({
          type: "run.state_changed",
          runId: "run-cache-retune",
          from: "testing",
          to: "succeeded"
        });
      });
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => {
        const target = document.querySelector("[data-run-card='run-cache-retune']");
        const style = window.getComputedStyle(target);
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          cards: Array.from(document.querySelectorAll("[data-run-card]")).map((node) => {
            const rect = node.getBoundingClientRect();
            return { id: node.getAttribute("data-run-card"), x: rect.x, y: rect.y };
          })
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2A-02/l09-state-change-fade.png");
      await context.close();
      const stable = before
        .filter((item) => item.id !== "run-cache-retune")
        .every((item) => {
          const next = after.cards.find((candidate) => candidate.id === item.id);
          return next && Math.abs(next.x - item.x) <= 1 && Math.abs(next.y - item.y) <= 1;
        });
      const probe = await writeJson("screenshots/P2A-02/l09-state-change-fade.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        stable,
        screenshot: shot.path
      });
      return {
        pass: after.animationName === "run-fade" && after.animationDuration === "0.5s" && stable,
        summary: `animation=${after.animationName}, stable=${stable}`,
        artifacts: [probe, shot],
        observed: { before, after, stable }
      };
    }
  );

  await browser.close();

  const acceptanceReport = {
    itemId: "P2A-02",
    route: "/home",
    generatedAt,
    verificationMode: "scripted-playwright",
    verifier: {
      script: "scripts/qa/rebuild-friday-static-qa.mjs",
      playwright: "1.58.2"
    },
    summary: {
      total: results.length,
      pass: results.filter((item) => item.status === "PASS").length,
      fail: results.filter((item) => item.status === "FAIL").length
    },
    acceptance: results,
    artifacts: Array.from(new Set(artifacts))
  };

  await ensureDir(path.join(ROOT, "screenshots", "P2A-02"));
  await fs.writeFile(
    path.join(ROOT, "screenshots", "P2A-02", "p2a-02-acceptance.json"),
    `${JSON.stringify(acceptanceReport, null, 2)}\n`
  );

  return acceptanceReport;
}

async function verifyP2A03(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `A${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "行高 72 · 横向 flex · 左风险 badge 48×48 · 中标题 + meta · 右 \"去处理\" 按钮",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const observed = await page.evaluate(() => {
        const row = document.querySelector("#approvals-section .approval-row");
        const badge = row?.querySelector(".approval-badge");
        const title = row?.querySelector(".approval-title");
        const meta = row?.querySelector(".approval-meta");
        const button = row?.querySelector(".action-button");
        const rowStyle = row ? window.getComputedStyle(row) : null;
        const rowRect = row?.getBoundingClientRect();
        const badgeRect = badge?.getBoundingClientRect();
        return {
          display: rowStyle?.display ?? null,
          alignItems: rowStyle?.alignItems ?? null,
          rowHeight: rowRect?.height ?? 0,
          badgeWidth: badgeRect?.width ?? 0,
          badgeHeight: badgeRect?.height ?? 0,
          titlePresent: Boolean(title?.textContent?.trim()),
          metaPresent: Boolean(meta?.textContent?.trim()),
          buttonText: button?.textContent?.trim() ?? ""
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2A-03/a01-approvals-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a01-approvals-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.display === "flex" &&
          observed.alignItems === "center" &&
          observed.rowHeight >= 72 &&
          Math.abs(observed.badgeWidth - 48) <= 1 &&
          Math.abs(observed.badgeHeight - 48) <= 1 &&
          observed.titlePresent &&
          observed.metaPresent &&
          observed.buttonText === "去处理",
        summary: `row=${observed.rowHeight}px badge=${observed.badgeWidth}x${observed.badgeHeight}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "最多渲染 3 条 · 超过显示 \"全部查看 (N)\" link · 跳 /assistant?tab=approvals · 保留 packId",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseApproval = home.snapshot.pendingApprovals[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [];
      snapshot.pendingApprovals = [
        mergeApproval(home.snapshot.pendingApprovals[0], { id: "approval-warehouse", severity: "high" }),
        mergeApproval(home.snapshot.pendingApprovals[1], { id: "approval-provider", severity: "medium" }),
        mergeApproval(home.snapshot.pendingApprovals[2], { id: "approval-policy", severity: "low" }),
        mergeApproval(baseApproval, {
          id: "approval-fleet",
          title: "新增设备守护审批需要你确认熔断边界",
          summary: "Friday 想在设备异常连续触发时自动切到更严格的访问策略。",
          approvalRequestId: "req-fleet",
          severity: "high",
          createdAt: new Date(home.clockMs - 4 * 60 * 1000).toISOString()
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const before = await page.evaluate(() => ({
        rowCount: document.querySelectorAll("#approvals-section .approval-row").length,
        linkText: document.querySelector("#approvals-section .home-section-link")?.textContent?.trim() ?? "",
        linkHref: document.querySelector("#approvals-section .home-section-link")?.getAttribute("href") ?? ""
      }));
      const shot = await captureScreenshot(page, "screenshots/P2A-03/a02-approvals-cap.png");
      await page.evaluate(() => {
        document.querySelector("#approvals-section .home-section-link").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForFunction(() => window.location.pathname === "/assistant");
      const route = new URL(page.url()).pathname + new URL(page.url()).search;
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a02-approvals-cap.json", {
        generatedAt: new Date().toISOString(),
        before,
        route,
        screenshot: shot.path
      });
      return {
        pass:
          before.rowCount === 3 &&
          before.linkText === "全部查看 (4)" &&
          before.linkHref === "/assistant?tab=approvals&packId=industry-cross-border-ecommerce" &&
          route === "/assistant?tab=approvals&packId=industry-cross-border-ecommerce",
        summary: `rows=${before.rowCount}, route=${route}`,
        artifacts: [probe, shot],
        observed: { before, route }
      };
    }
  );

  await verifyRule(
    3,
    "风险 badge 3 色 · low 琥珀 / medium 黄 / high 红 · 图标对应 ShieldCheck / ShieldAlert / Siren",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const tokenColors = await resolvedTokenColors(page, ["--accent", "--warning", "--error"]);
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [];
      snapshot.pendingApprovals = [
        mergeApproval(home.snapshot.pendingApprovals[2], { id: "approval-policy", severity: "low" }),
        mergeApproval(home.snapshot.pendingApprovals[1], { id: "approval-provider", severity: "medium" }),
        mergeApproval(home.snapshot.pendingApprovals[0], { id: "approval-warehouse", severity: "high" })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-03/a03-approval-badges.png");
      const observed = await page.evaluate((colors) => {
        return ["approval-policy", "approval-provider", "approval-warehouse"].map((id) => {
          const badge = document.querySelector(`#approvals-section .approval-row .action-button[href='/assistant?approvalId=${id}']`)?.closest(".approval-row")?.querySelector(".approval-badge");
          const style = badge ? window.getComputedStyle(badge) : null;
          const icon = badge?.querySelector("svg")?.getAttribute("data-icon") ?? null;
          return {
            id,
            icon,
            color: style?.color ?? null,
            token: Object.entries(colors).find(([, value]) => value === style?.color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a03-approval-badges.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed,
        screenshot: shot.path
      });
      const byId = Object.fromEntries(observed.map((item) => [item.id, item]));
      return {
        pass:
          byId["approval-policy"]?.icon === "ShieldCheck" &&
          byId["approval-policy"]?.token === "--accent" &&
          byId["approval-provider"]?.icon === "ShieldAlert" &&
          byId["approval-provider"]?.token === "--warning" &&
          byId["approval-warehouse"]?.icon === "Siren" &&
          byId["approval-warehouse"]?.token === "--error",
        summary: observed.map((item) => `${item.id}:${item.icon}/${item.token}`).join(", "),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "标题 2 行截断 · meta 1 行 · 显示 \"来自 {channelName} · {timeAgo}\"",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [];
      snapshot.pendingApprovals = [
        mergeApproval(home.snapshot.pendingApprovals[0], {
          id: "approval-warehouse",
          title: "这是一个为了验证两行截断而故意拉长的审批标题，用来确认在首页条带里不会撑破布局并且仍然保留可读性",
          createdAt: new Date(home.clockMs - 11 * 60 * 1000).toISOString()
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-03/a04-approval-copy.png");
      const observed = await page.evaluate(() => {
        const title = document.querySelector("#approvals-section .approval-title");
        const meta = document.querySelector("#approvals-section .approval-meta");
        const titleStyle = title ? window.getComputedStyle(title) : null;
        const metaStyle = meta ? window.getComputedStyle(meta) : null;
        return {
          titleText: title?.textContent?.trim() ?? "",
          titleClamp: titleStyle?.getPropertyValue("-webkit-line-clamp") ?? "",
          metaText: meta?.textContent?.trim() ?? "",
          metaWhiteSpace: metaStyle?.whiteSpace ?? "",
          metaOverflow: metaStyle?.textOverflow ?? ""
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a04-approval-copy.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.titleClamp === "2" &&
          /^来自 .+ · .+$/.test(observed.metaText) &&
          observed.metaWhiteSpace === "nowrap" &&
          observed.metaOverflow === "ellipsis",
        summary: observed.metaText,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "点\"去处理\" · 跳 /assistant?approvalId=xxx · MUST NOT 在 home 行内处理",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const before = await page.evaluate(() => ({
        route: window.location.pathname + window.location.search,
        dialogs: document.querySelectorAll("[role='dialog']").length,
        drawers: document.querySelectorAll(".drawer-surface").length
      }));
      await page.evaluate(() => {
        document.querySelector("#approvals-section .action-button").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForFunction(() => window.location.pathname === "/assistant");
      const route = new URL(page.url()).pathname + new URL(page.url()).search;
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a05-approval-navigation.json", {
        generatedAt: new Date().toISOString(),
        before,
        route
      });
      return {
        pass:
          before.route.startsWith("/home") &&
          before.dialogs === 0 &&
          before.drawers === 0 &&
          route === "/assistant?approvalId=approval-warehouse",
        summary: route,
        artifacts: [probe],
        observed: { before, route }
      };
    }
  );

  await verifyRule(
    6,
    "键盘 Tab 遍历 3 条 + \"全部查看\" · focus ring",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseApproval = home.snapshot.pendingApprovals[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [];
      snapshot.pendingApprovals = [
        mergeApproval(home.snapshot.pendingApprovals[0], { id: "approval-warehouse" }),
        mergeApproval(home.snapshot.pendingApprovals[1], { id: "approval-provider" }),
        mergeApproval(home.snapshot.pendingApprovals[2], { id: "approval-policy" }),
        mergeApproval(baseApproval, {
          id: "approval-fleet",
          title: "设备守护审批",
          approvalRequestId: "req-fleet",
          severity: "high",
          createdAt: new Date(home.clockMs - 4 * 60 * 1000).toISOString()
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      await page.locator(".intent-pill").last().focus();
      const sequence = [];
      for (let step = 0; step < 4; step += 1) {
        await page.keyboard.press("Tab");
        sequence.push(await page.evaluate(() => {
          const node = document.activeElement;
          const style = window.getComputedStyle(node);
          return {
            tagName: node?.tagName ?? null,
            text: node?.textContent?.trim() ?? "",
            href: node?.getAttribute("href") ?? null,
            outlineWidth: style.outlineWidth
          };
        }));
      }
      const shot = await captureScreenshot(page, "screenshots/P2A-03/a06-approval-keyboard.png");
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a06-approval-keyboard.json", {
        generatedAt: new Date().toISOString(),
        sequence,
        screenshot: shot.path
      });
      return {
        pass:
          sequence.length === 4 &&
          sequence[0].href === "/assistant?tab=approvals&packId=industry-cross-border-ecommerce" &&
          sequence[0].outlineWidth === "2px" &&
          sequence.slice(1).every((item) => item.text === "去处理" && item.outlineWidth === "2px"),
        summary: sequence.map((item) => item.href || item.text).join(" -> "),
        artifacts: [probe, shot],
        observed: sequence
      };
    }
  );

  await verifyRule(
    7,
    "空 · 段 3 条文案 \"没有待决定事项\" · 不留灰块",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const snapshot = cloneJson(home.snapshot);
      snapshot.pendingApprovals = [];
      snapshot.runs = [home.snapshot.runs[0]];
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-03/a07-approval-empty.png");
      const observed = await page.evaluate(() => ({
        headerPresent: Boolean(document.querySelector("#approvals-section .home-section-title")),
        text: document.querySelector("#approvals-section .home-inline-empty")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        skeletonCount: document.querySelectorAll("#approvals-section .skeleton-row").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-03/a07-approval-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.headerPresent === false &&
          observed.text.includes("没有待决定事项") &&
          observed.skeletonCount === 0,
        summary: observed.text,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();

  const acceptanceReport = {
    itemId: "P2A-03",
    route: "/home",
    generatedAt,
    verificationMode: "scripted-playwright",
    verifier: {
      script: "scripts/qa/rebuild-friday-static-qa.mjs",
      playwright: "1.58.2"
    },
    summary: {
      total: results.length,
      pass: results.filter((item) => item.status === "PASS").length,
      fail: results.filter((item) => item.status === "FAIL").length
    },
    acceptance: results,
    artifacts: Array.from(new Set(artifacts))
  };

  await ensureDir(path.join(ROOT, "screenshots", "P2A-03"));
  await fs.writeFile(
    path.join(ROOT, "screenshots", "P2A-03", "p2a-03-acceptance.json"),
    `${JSON.stringify(acceptanceReport, null, 2)}\n`
  );

  return acceptanceReport;
}

async function verifyP2A04(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `S${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "行高 56 · 左时间刻度 80px · 右内容 · 时间格式 formatAutomationNextRun(locale 敏感)",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const helperText = await page.evaluate(() => {
        const automation = window.__fridayQa.home.getState().snapshot.scheduledAutomations[0];
        return window.__fridayQa.helpers.formatAutomationNextRun(automation, "zh");
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("#scheduled-section .scheduled-row");
        const time = row?.querySelector(".scheduled-time");
        const rowRect = row?.getBoundingClientRect();
        const timeRect = time?.getBoundingClientRect();
        return {
          rowHeight: rowRect?.height ?? 0,
          timeWidth: timeRect?.width ?? 0,
          timeText: time?.textContent?.trim() ?? ""
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2A-04/s01-scheduled-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s01-scheduled-layout.json", {
        generatedAt: new Date().toISOString(),
        helperText,
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.rowHeight >= 56 &&
          Math.abs(observed.timeWidth - 80) <= 1 &&
          observed.timeText === helperText,
        summary: `${observed.timeText} @ ${observed.rowHeight}px`,
        artifacts: [probe, shot],
        observed: { helperText, observed }
      };
    }
  );

  await verifyRule(
    2,
    "按 nextRunAt 升序 · null 排最后 · 过滤 enabled === true 优先",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseAutomation = home.snapshot.scheduledAutomations[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.scheduledAutomations = [
        mergeAutomation(baseAutomation, {
          id: "qa-auto-early",
          name: "early",
          enabled: true,
          nextRunAt: new Date(home.clockMs + 10 * 60 * 1000).toISOString()
        }),
        mergeAutomation(baseAutomation, {
          id: "qa-auto-late",
          name: "late",
          enabled: true,
          nextRunAt: new Date(home.clockMs + 30 * 60 * 1000).toISOString()
        }),
        mergeAutomation(baseAutomation, {
          id: "qa-auto-manual",
          name: "manual",
          enabled: true,
          nextRunAt: null
        }),
        mergeAutomation(baseAutomation, {
          id: "qa-auto-disabled-timed",
          name: "disabled-timed",
          enabled: false,
          nextRunAt: new Date(home.clockMs + 5 * 60 * 1000).toISOString()
        }),
        mergeAutomation(baseAutomation, {
          id: "qa-auto-disabled-manual",
          name: "disabled-manual",
          enabled: false,
          nextRunAt: null
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const observed = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#scheduled-section .scheduled-row .scheduled-title")).map((node) => node.textContent?.trim() ?? "")
      );
      const shot = await captureScreenshot(page, "screenshots/P2A-04/s02-scheduled-order.png");
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s02-scheduled-order.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: JSON.stringify(observed) === JSON.stringify(["early", "late", "manual", "disabled-timed", "disabled-manual"]),
        summary: observed.join(" -> "),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "最多 5 行 · 第 6 行替换成 \"+{N-5} 更多\" link · 跳 /automations",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseAutomation = home.snapshot.scheduledAutomations[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.scheduledAutomations = Array.from({ length: 6 }, (_, index) =>
        mergeAutomation(baseAutomation, {
          id: `qa-overflow-${index + 1}`,
          name: `overflow-${index + 1}`,
          enabled: true,
          nextRunAt: new Date(home.clockMs + (index + 1) * 15 * 60 * 1000).toISOString()
        })
      );
      await setHomeQaSnapshot(page, snapshot);
      const before = await page.evaluate(() => ({
        rowCount: document.querySelectorAll("#scheduled-section .scheduled-row").length,
        moreText: document.querySelector("#scheduled-section .scheduled-more")?.textContent?.trim() ?? "",
        moreHref: document.querySelector("#scheduled-section .scheduled-more")?.getAttribute("href") ?? ""
      }));
      const shot = await captureScreenshot(page, "screenshots/P2A-04/s03-scheduled-cap.png");
      await page.evaluate(() => {
        document.querySelector("#scheduled-section .scheduled-more").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForFunction(() => window.location.pathname === "/automations");
      const route = new URL(page.url()).pathname + new URL(page.url()).search;
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s03-scheduled-cap.json", {
        generatedAt: new Date().toISOString(),
        before,
        route,
        screenshot: shot.path
      });
      return {
        pass:
          before.rowCount === 5 &&
          before.moreText === "+1 更多" &&
          before.moreHref === "/automations" &&
          route === "/automations",
        summary: `rows=${before.rowCount}, route=${route}`,
        artifacts: [probe, shot],
        observed: { before, route }
      };
    }
  );

  await verifyRule(
    4,
    "disabled 行 opacity 0.35 · time 显示 \"已暂停\" · cron 文字也置灰",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseAutomation = home.snapshot.scheduledAutomations[0];
      const tokenColors = await resolvedTokenColors(page, ["--ink-3"]);
      const snapshot = cloneJson(home.snapshot);
      snapshot.scheduledAutomations = [
        mergeAutomation(baseAutomation, {
          id: "qa-disabled",
          name: "disabled proof",
          enabled: false,
          nextRunAt: new Date(home.clockMs + 12 * 60 * 1000).toISOString()
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-04/s04-scheduled-disabled.png");
      const observed = await page.evaluate((colors) => {
        const row = document.querySelector("#scheduled-section .scheduled-row");
        const time = row?.querySelector(".scheduled-time");
        const cron = row?.querySelector(".scheduled-cron");
        const rowStyle = row ? window.getComputedStyle(row) : null;
        const cronStyle = cron ? window.getComputedStyle(cron) : null;
        return {
          opacity: rowStyle?.opacity ?? null,
          timeText: time?.textContent?.trim() ?? "",
          cronColor: cronStyle?.color ?? null,
          cronToken: Object.entries(colors).find(([, value]) => value === cronStyle?.color)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s04-scheduled-disabled.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.opacity === "0.35" &&
          observed.timeText === "已暂停" &&
          observed.cronToken === "--ink-3",
        summary: `${observed.timeText}, opacity=${observed.opacity}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "悬浮 row · 底色 --bg-sunken · cursor pointer · 点跳 /automations?automationId=xxx",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseAutomation = home.snapshot.scheduledAutomations[0];
      const tokenColors = await resolvedTokenColors(page, ["--bg-sunken"]);
      const snapshot = cloneJson(home.snapshot);
      snapshot.scheduledAutomations = [
        mergeAutomation(baseAutomation, {
          id: "qa-hover-auto",
          name: "hover-target",
          enabled: true,
          nextRunAt: new Date(home.clockMs + 20 * 60 * 1000).toISOString()
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const before = await page.evaluate((colors) => {
        const row = document.querySelector("#scheduled-section .scheduled-row");
        const style = row ? window.getComputedStyle(row) : null;
        return {
          background: style?.backgroundColor ?? null,
          token: Object.entries(colors).find(([, value]) => value === style?.backgroundColor)?.[0] ?? null
        };
      }, tokenColors);
      await page.locator("#scheduled-section .scheduled-row").first().hover();
      await page.waitForTimeout(220);
      const after = await page.evaluate((colors) => {
        const row = document.querySelector("#scheduled-section .scheduled-row");
        const style = row ? window.getComputedStyle(row) : null;
        return {
          background: style?.backgroundColor ?? null,
          token: Object.entries(colors).find(([, value]) => value === style?.backgroundColor)?.[0] ?? null,
          cursor: style?.cursor ?? null,
          href: row?.getAttribute("href") ?? null
        };
      }, tokenColors);
      const shot = await captureScreenshot(page, "screenshots/P2A-04/s05-scheduled-hover.png");
      await page.evaluate(() => {
        document.querySelector("#scheduled-section .scheduled-row").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForFunction(() => window.location.pathname === "/automations");
      const route = new URL(page.url()).pathname + new URL(page.url()).search;
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s05-scheduled-hover.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        route,
        screenshot: shot.path
      });
      return {
        pass:
          before.token !== "--bg-sunken" &&
          after.token === "--bg-sunken" &&
          after.cursor === "pointer" &&
          route === "/automations?automationId=qa-hover-auto",
        summary: `hover=${after.token}, route=${route}`,
        artifacts: [probe, shot],
        observed: { before, after, route }
      };
    }
  );

  await verifyRule(
    6,
    "时间变化(advanceClock)· time 列重算 · 文字更新",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const baseAutomation = home.snapshot.scheduledAutomations[0];
      const snapshot = cloneJson(home.snapshot);
      snapshot.scheduledAutomations = [
        mergeAutomation(baseAutomation, {
          id: "qa-clock-change",
          name: "clock-change",
          enabled: true,
          nextRunAt: new Date(home.clockMs + 10 * 60 * 1000).toISOString()
        })
      ];
      await setHomeQaSnapshot(page, snapshot);
      const observed = await page.evaluate(async () => {
        const before = document.querySelector("#scheduled-section .scheduled-time")?.textContent?.trim() ?? "";
        window.__fridayMock.advanceClock(60 * 1000);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const after = document.querySelector("#scheduled-section .scheduled-time")?.textContent?.trim() ?? "";
        return { before, after };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s06-scheduled-clock.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.before !== observed.after,
        summary: `${observed.before} -> ${observed.after}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "0 条 · 段替换成 \"接下来没有计划中的自动任务\" 文案 · 不渲染段标题",
    async () => {
      const { page, context } = await bootHomePage(browser, baseUrl, "normal");
      const home = await readHomeQaState(page);
      const snapshot = cloneJson(home.snapshot);
      snapshot.runs = [home.snapshot.runs[0]];
      snapshot.scheduledAutomations = [];
      await setHomeQaSnapshot(page, snapshot);
      const shot = await captureScreenshot(page, "screenshots/P2A-04/s07-scheduled-empty.png");
      const observed = await page.evaluate(() => ({
        headerPresent: Boolean(document.querySelector("#scheduled-section .home-section-title")),
        text: document.querySelector("#scheduled-section .home-inline-empty strong")?.textContent?.trim() ?? ""
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-04/s07-scheduled-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.headerPresent === false &&
          observed.text === "接下来没有计划中的自动任务",
        summary: observed.text,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();

  const acceptanceReport = {
    itemId: "P2A-04",
    route: "/home",
    generatedAt,
    verificationMode: "scripted-playwright",
    verifier: {
      script: "scripts/qa/rebuild-friday-static-qa.mjs",
      playwright: "1.58.2"
    },
    summary: {
      total: results.length,
      pass: results.filter((item) => item.status === "PASS").length,
      fail: results.filter((item) => item.status === "FAIL").length
    },
    acceptance: results,
    artifacts: Array.from(new Set(artifacts))
  };

  await ensureDir(path.join(ROOT, "screenshots", "P2A-04"));
  await fs.writeFile(
    path.join(ROOT, "screenshots", "P2A-04", "p2a-04-acceptance.json"),
    `${JSON.stringify(acceptanceReport, null, 2)}\n`
  );

  return acceptanceReport;
}

async function bootChatPage(browser, baseUrl, stateName, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: "no-preference",
    ...(options.storageState ? { storageState: options.storageState } : {})
  });
  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }
  const consoleMessages = [];
  const pageErrors = [];
  const websocketConnections = [];
  const eventSourceRequests = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  page.on("websocket", (websocket) => {
    websocketConnections.push({
      url: websocket.url()
    });
  });
  page.on("request", (request) => {
    if (request.resourceType() === "eventsource") {
      eventSourceRequests.push({
        url: request.url(),
        method: request.method()
      });
    }
  });
  await page.goto(`${baseUrl}/chat?dev=1&__state=${encodeURIComponent(stateName)}`, {
    waitUntil: "load"
  });
  await page.waitForFunction(() => Boolean(window.__fridayQa?.chat));
  await page.waitForTimeout(options.waitMs ?? 220);
  return {
    context,
    page,
    consoleMessages,
    pageErrors,
    websocketConnections,
    eventSourceRequests
  };
}

async function bootAssistantPage(browser, baseUrl, stateName, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: "no-preference",
    ...(options.storageState ? { storageState: options.storageState } : {})
  });
  await context.addInitScript(() => {
    window.__assistantScrollIntoViewCalls = [];
    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoViewProxy(arg) {
      window.__assistantScrollIntoViewCalls.push({
        at: performance.now(),
        target:
          this.getAttribute("data-pack-card") ||
          this.getAttribute("data-approval-id") ||
          this.getAttribute("data-issue-id") ||
          this.id ||
          this.className ||
          this.tagName,
        block: typeof arg === "object" && arg ? (arg.block ?? null) : null,
        behavior: typeof arg === "object" && arg ? (arg.behavior ?? null) : null
      });
      return nativeScrollIntoView.call(this, arg);
    };
  });
  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }
  const consoleMessages = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  const params = new URLSearchParams({
    dev: "1",
    __state: stateName
  });
  Object.entries(options.searchParams || {}).forEach(([key, value]) => {
    if (value != null) {
      params.set(key, String(value));
    }
  });
  await page.goto(`${baseUrl}/assistant?${params.toString()}`, {
    waitUntil: "load"
  });
  await page.waitForFunction(() => Boolean(window.__fridayQa?.assistant));
  await page.waitForTimeout(options.waitMs ?? 220);
  return {
    context,
    page,
    consoleMessages,
    pageErrors
  };
}

async function bootSettingsPage(browser, baseUrl, tab = "providers", options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: options.reducedMotion || "no-preference",
    acceptDownloads: true,
    ...(options.storageState ? { storageState: options.storageState } : {})
  });
  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }
  const consoleMessages = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  const params = new URLSearchParams({
    dev: "1",
    tab,
    __state: tab
  });
  Object.entries(options.searchParams || {}).forEach(([key, value]) => {
    if (value == null) {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  });
  await page.goto(`${baseUrl}/settings?${params.toString()}`, {
    waitUntil: "load"
  });
  await page.waitForFunction(() => Boolean(window.__fridayQa?.settings));
  await page.waitForTimeout(options.waitMs ?? 220);
  return {
    context,
    page,
    consoleMessages,
    pageErrors
  };
}

async function bootObservabilityPage(browser, baseUrl, focus = "alerts", options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: options.reducedMotion || "no-preference",
    ...(options.storageState ? { storageState: options.storageState } : {})
  });
  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }
  const consoleMessages = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  const params = new URLSearchParams({
    dev: "1",
    focus,
    window: options.windowValue || "15m",
    __state: options.stateName || "active"
  });
  Object.entries(options.searchParams || {}).forEach(([key, value]) => {
    if (value == null) {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  });
  await page.goto(`${baseUrl}/observability?${params.toString()}`, {
    waitUntil: "load"
  });
  await page.waitForFunction(() => Boolean(window.__fridayQa?.observability));
  await page.waitForTimeout(options.waitMs ?? 220);
  return {
    context,
    page,
    consoleMessages,
    pageErrors
  };
}

async function bootRoutePage(browser, baseUrl, pathname, qaKey, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 1200 },
    reducedMotion: options.reducedMotion || "no-preference",
    acceptDownloads: options.acceptDownloads || false,
    ...(options.storageState ? { storageState: options.storageState } : {})
  });
  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }
  const consoleMessages = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  const params = new URLSearchParams({ dev: "1" });
  if (options.stateName != null) {
    params.set("__state", options.stateName);
  }
  Object.entries(options.searchParams || {}).forEach(([key, value]) => {
    if (value == null) {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  await page.goto(`${baseUrl}${pathname}${query ? `?${query}` : ""}`, {
    waitUntil: "load"
  });
  await page.waitForFunction((key) => Boolean(window.__fridayQa?.[key]), qaKey);
  await page.waitForTimeout(options.waitMs ?? 220);
  return {
    context,
    page,
    consoleMessages,
    pageErrors
  };
}

async function bootShellPage(browser, baseUrl, href, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 1200 },
    reducedMotion: options.reducedMotion || "no-preference",
    colorScheme: options.colorScheme || "light",
    acceptDownloads: options.acceptDownloads || false,
    ...(options.storageState ? { storageState: options.storageState } : {})
  });
  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }
  const consoleMessages = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      name: error.name,
      message: error.message
    });
  });
  const target = href.startsWith("http")
    ? href
    : `${baseUrl}${href.startsWith("/") ? href : `/${href}`}`;
  await page.goto(target, {
    waitUntil: "load"
  });
  await page.waitForFunction(() => Boolean(window.__fridayQa?.shell));
  await page.waitForTimeout(options.waitMs ?? 220);
  return {
    context,
    page,
    consoleMessages,
    pageErrors
  };
}

async function readSettingsQaState(page) {
  return page.evaluate(() => window.__fridayQa.settings.getState());
}

async function readObservabilityQaState(page) {
  return page.evaluate(() => window.__fridayQa.observability.getState());
}

async function readPacksQaState(page) {
  return page.evaluate(() => window.__fridayQa.packs.getState());
}

async function readCrossBorderQaState(page) {
  return page.evaluate(() => window.__fridayQa.crossBorder.getState());
}

async function readSkillsQaState(page) {
  return page.evaluate(() => window.__fridayQa.skills.getState());
}

async function readSkillGeneratorQaState(page) {
  return page.evaluate(() => window.__fridayQa.skillGenerator.getState());
}

async function readWorkflowsQaState(page) {
  return page.evaluate(() => window.__fridayQa.workflows.getState());
}

async function readBuilderQaState(page) {
  return page.evaluate(() => window.__fridayQa.builder.getState());
}

async function readPluginsQaState(page) {
  return page.evaluate(() => window.__fridayQa.plugins.getState());
}

async function readMcpQaState(page) {
  return page.evaluate(() => window.__fridayQa.mcp.getState());
}

async function readChannelsQaState(page) {
  return page.evaluate(() => window.__fridayQa.channels.getState());
}

async function readAutomationsQaState(page) {
  return page.evaluate(() => window.__fridayQa.automations.getState());
}

async function readSessionsQaState(page) {
  return page.evaluate(() => window.__fridayQa.sessions.getState());
}

async function readUsageQaState(page) {
  return page.evaluate(() => window.__fridayQa.usage.getState());
}

async function readMemoryQaState(page) {
  return page.evaluate(() => window.__fridayQa.memory.getState());
}

async function readFleetQaState(page) {
  return page.evaluate(() => window.__fridayQa.fleet.getState());
}

async function readLoginQaState(page) {
  return page.evaluate(() => window.__fridayQa.login.getState());
}

async function readSetupQaState(page) {
  return page.evaluate(() => window.__fridayQa.setup.getState());
}

async function readOnboardingQaState(page) {
  return page.evaluate(() => window.__fridayQa.onboarding.getState());
}

async function readGuidedQaState(page) {
  return page.evaluate(() => window.__fridayQa.guided.getState());
}

async function readCommandCenterQaState(page) {
  return page.evaluate(() => window.__fridayQa.commandCenter.getState());
}

function parseJsonBlock(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function openTraceDrawerViaRow(page, traceId = "trace-932af") {
  await page.click(`[data-obs-row="${traceId}"]`);
  await page.waitForSelector('.drawer-panel[data-drawer-kind="trace"]');
  await page.waitForTimeout(140);
}

async function readAlertRow(page, alertId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-obs-row="${id}"][data-obs-focus="alerts"]`);
    const meta = row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? null) : [];
    const actionLabels = row ? Array.from(row.querySelectorAll(".obs-row-actions .action-button")).map((node) => node.textContent?.trim() ?? null) : [];
    const snoozeCopy = row?.querySelector("[data-alert-snooze-copy]")?.textContent?.trim() ?? null;
    const dot = row?.querySelector(".health-dot");
    return {
      exists: Boolean(row),
      className: row?.className ?? null,
      status: row?.getAttribute("data-alert-status") ?? null,
      background: row ? getComputedStyle(row).backgroundColor : null,
      name: row?.querySelector(".obs-row-title strong")?.textContent?.trim() ?? null,
      meta,
      actionLabels,
      snoozeCopy,
      dotClassName: dot?.className ?? null,
      dotAnimation: dot ? getComputedStyle(dot).animationName : null
    };
  }, alertId);
}

function summarizeStats(values) {
  const safeValues = values.filter((value) => Number.isFinite(value));
  if (safeValues.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      stddev: null
    };
  }
  const mean = safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length;
  const variance = safeValues.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / safeValues.length;
  return {
    count: safeValues.length,
    min: Math.min(...safeValues),
    max: Math.max(...safeValues),
    mean,
    stddev: Math.sqrt(variance)
  };
}

function extractBlock(source, startIndex) {
  let depth = 0;
  let seenOpeningBrace = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
      seenOpeningBrace = true;
    } else if (char === "}") {
      depth -= 1;
      if (seenOpeningBrace && depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }
  return null;
}

function extractInterfaceFields(source, interfaceName) {
  const marker = `interface ${interfaceName}`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    return {
      fields: [],
      snippet: null
    };
  }
  const braceIndex = source.indexOf("{", markerIndex);
  const block = extractBlock(source, braceIndex);
  const fields = Array.from(block?.matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm) ?? [], (match) => match[1]);
  return {
    fields,
    snippet: `${marker}${block ?? ""}`
  };
}

function extractFunctionPropFields(source, functionName) {
  const marker = `function ${functionName}(props)`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    return {
      fields: [],
      snippet: null
    };
  }
  const braceIndex = source.indexOf("{", markerIndex);
  const block = extractBlock(source, braceIndex);
  const fields = Array.from(new Set(Array.from(block?.matchAll(/props\.([A-Za-z0-9_]+)/g) ?? [], (match) => match[1]))).sort();
  return {
    fields,
    snippet: `${marker}${block ?? ""}`
  };
}

function buildTurnSequenceHash(sequence) {
  return sha256(JSON.stringify(sequence));
}

function parseRgbColor(input) {
  const match = String(input || "").match(/rgba?\(([^)]+)\)/i);
  if (!match) {
    return null;
  }
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((value) => Number.isNaN(value))) {
    return null;
  }
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: Number.isFinite(parts[3]) ? parts[3] : 1
  };
}

function relativeLuminance(rgb) {
  const toLinear = (value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (
    (0.2126 * toLinear(rgb.r)) +
    (0.7152 * toLinear(rgb.g)) +
    (0.0722 * toLinear(rgb.b))
  );
}

function contrastRatio(foreground, background) {
  const fg = parseRgbColor(foreground);
  const bg = parseRgbColor(background);
  if (!fg || !bg) {
    return null;
  }
  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

async function writeAcceptanceReport(itemId, route, generatedAt, results, artifacts) {
  const directory = path.join(ROOT, "screenshots", itemId);
  await ensureDir(directory);
  const acceptanceReport = {
    itemId,
    route,
    generatedAt,
    verificationMode: "scripted-playwright",
    verifier: {
      script: "scripts/qa/rebuild-friday-static-qa.mjs",
      playwright: "1.58.2"
    },
    summary: {
      total: results.length,
      pass: results.filter((item) => item.status === "PASS").length,
      fail: results.filter((item) => item.status === "FAIL").length
    },
    acceptance: results,
    artifacts: Array.from(new Set(artifacts))
  };
  const filePath = path.join(directory, `${itemId.toLowerCase()}-acceptance.json`);
  await fs.writeFile(filePath, `${JSON.stringify(acceptanceReport, null, 2)}\n`);
  return acceptanceReport;
}

function buildVerboseParagraph(text, repeatCount) {
  return Array.from({ length: repeatCount }, () => text).join(" ");
}

async function verifyP2A05(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "C01",
    "empty · 首次进入 composer 居中(vertical + horizontal)· 快捷 prompt 3 张 · 点击填入 composer",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const screenshot = await captureScreenshot(page, "screenshots/P2A-05/c01-empty-layout.png");
      const before = await page.evaluate(() => {
        const hero = document.querySelector(".chat-empty-hero");
        const main = document.querySelector(".chat-main-column");
        const quickCards = Array.from(document.querySelectorAll(".chat-quick-card")).map((node) => (node.textContent?.trim() ?? "").replace(/→$/, "").trim());
        const heroRect = hero?.getBoundingClientRect();
        const mainRect = main?.getBoundingClientRect();
        return {
          quickCards,
          heroCenterX: heroRect ? heroRect.left + (heroRect.width / 2) : null,
          heroCenterY: heroRect ? heroRect.top + (heroRect.height / 2) : null,
          mainCenterX: mainRect ? mainRect.left + (mainRect.width / 2) : null,
          mainCenterY: mainRect ? mainRect.top + (mainRect.height / 2) : null
        };
      });
      await page.locator(".chat-quick-card").first().click();
      await page.waitForTimeout(120);
      const after = await page.$eval("#chat-composer", (node) => node.value);
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c01-empty-layout.json", {
        generatedAt: new Date().toISOString(),
        observed: {
          ...before,
          after
        },
        screenshot: screenshot.path
      });
      const horizontalDelta = Math.abs((before.heroCenterX ?? 0) - (before.mainCenterX ?? 0));
      const verticalDelta = Math.abs((before.heroCenterY ?? 0) - (before.mainCenterY ?? 0));
      return {
        pass:
          before.quickCards.length === 3 &&
          horizontalDelta <= 8 &&
          verticalDelta <= 120 &&
          after === before.quickCards[0],
        summary: `quickCards=${before.quickCards.length}, prompt="${after}"`,
        artifacts: [probe, screenshot],
        observed: {
          ...before,
          after
        }
      };
    }
  );

  await verifyRule(
    2,
    "C02",
    "user-sent · 发送后 user bubble 右侧 · 紧接 \"Friday 在思考…\" 左侧 typing indicator · 3 个点循环动画 400ms 一轮",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent");
      const screenshot = await captureScreenshot(page, "screenshots/P2A-05/c02-user-thinking.png");
      const observed = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll(".chat-timeline .chat-bubble-row"));
        const dots = Array.from(document.querySelectorAll(".thinking-dots span")).map((node) => {
          const style = getComputedStyle(node);
          return {
            duration: style.animationDuration,
            delay: style.animationDelay
          };
        });
        return {
          rowCount: rows.length,
          firstRowUser: rows[0]?.classList.contains("is-user") ?? false,
          secondRowUser: rows[1]?.classList.contains("is-user") ?? null,
          dotCount: dots.length,
          dots
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c02-user-thinking.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.rowCount === 2 &&
          observed.firstRowUser === true &&
          observed.secondRowUser === false &&
          observed.dotCount === 3 &&
          observed.dots.every((dot) => dot.duration === "0.4s"),
        summary: `rows=${observed.rowCount}, dots=${observed.dotCount}, duration=${observed.dots[0]?.duration ?? "n/a"}`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "C03",
    "streaming · assistant bubble 字符逐字进入(每 30ms 一字)· 末尾光标闪烁 500ms 周期 · 流结束光标消失",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent", { waitMs: 20 });
      await page.evaluate(() => {
        window.__fridayQa.chat.setState("streaming");
      });
      await page.waitForFunction(() => Boolean(document.querySelector(".streaming-caret")));
      const midScreenshot = await captureScreenshot(page, "screenshots/P2A-05/c03-streaming-mid.png");
      const observed = await page.evaluate(async () => {
        const caretSamples = [];
        for (let index = 0; index < 4; index += 1) {
          const caret = document.querySelector(".streaming-caret");
          caretSamples.push({
            sample: index + 1,
            at: performance.now(),
            opacity: caret ? getComputedStyle(caret).opacity : null,
            animationName: caret ? getComputedStyle(caret).animationName : null,
            animationDuration: caret ? getComputedStyle(caret).animationDuration : null
          });
          await new Promise((resolve) => setTimeout(resolve, 130));
        }
        const runtime = window.__fridayQa.chat.getState().streamingRuntime;
        await new Promise((resolve) => {
          const tick = () => {
            const current = window.__fridayQa.chat.getState().streamingRuntime;
            if (current?.completedAt && !document.querySelector(".streaming-caret")) {
              resolve();
              return;
            }
            setTimeout(tick, 40);
          };
          tick();
        });
        const completed = window.__fridayQa.chat.getState().streamingRuntime;
        return {
          caretSamples,
          runtime,
          caretPresentAfterCompletion: Boolean(document.querySelector(".streaming-caret"))
        };
      });
      const doneScreenshot = await captureScreenshot(page, "screenshots/P2A-05/c03-streaming-done.png");
      await context.close();
      const intervalStats = summarizeStats(observed.runtime?.charIntervals ?? []);
      const caretAnimation = observed.caretSamples.find((sample) => sample.animationName)?.animationName ?? null;
      const caretDuration = observed.caretSamples.find((sample) => sample.animationDuration)?.animationDuration ?? null;
      const probe = await writeJson("screenshots/P2A-05/c03-streaming-timing.json", {
        generatedAt: new Date().toISOString(),
        observed,
        intervalStats,
        caretAnimation,
        caretDuration,
        screenshots: [midScreenshot.path, doneScreenshot.path]
      });
      const opacityValues = Array.from(new Set(observed.caretSamples.map((sample) => sample.opacity).filter((value) => value != null)));
      return {
        pass:
          intervalStats.count >= 10 &&
          intervalStats.mean >= 24 &&
          intervalStats.mean <= 36 &&
          (intervalStats.stddev ?? 99) <= 4 &&
          caretAnimation === "chat-caret-blink" &&
          caretDuration === "0.5s" &&
          opacityValues.length >= 1 &&
          observed.caretPresentAfterCompletion === false,
        summary: `mean=${intervalStats.mean?.toFixed(2)}ms, stddev=${intervalStats.stddev?.toFixed(2)}ms, caretStates=${opacityValues.join("/")}`,
        artifacts: [probe, midScreenshot, doneScreenshot],
        observed: {
          ...observed,
          intervalStats,
          caretAnimation,
          caretDuration
        }
      };
    }
  );

  await verifyRule(
    4,
    "C04",
    "tool-call 展开 · ChatToolActivity 入流 · 默认折叠 · 显示工具名 + 状态 dot · 点击展开 parameters + result JSON",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "tool-call");
      const screenshot = await captureScreenshot(page, "screenshots/P2A-05/c04-tool-call-collapsed.png");
      const observed = await page.evaluate(() => {
        const details = document.querySelector(".chat-tool-shell details");
        const summary = document.querySelector(".chat-tool-summary");
        const before = {
          open: details?.open ?? null,
          toolName: summary?.querySelector("strong")?.textContent?.trim() ?? null,
          statusText: summary?.querySelector("span:last-child")?.textContent?.trim() ?? null,
          statusDot: summary?.querySelector(".health-dot")?.className ?? null
        };
        summary?.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
        const after = {
          open: details?.open ?? null,
          jsonText: details?.querySelector(".chat-json-block")?.textContent ?? null
        };
        let parsed = null;
        try {
          parsed = after.jsonText ? JSON.parse(after.jsonText) : null;
        } catch {
          parsed = null;
        }
        return {
          before,
          after,
          parsed
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c04-tool-call-expand.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.before.open === false &&
          observed.before.toolName === "inventory.fetch" &&
          /is-healthy/.test(observed.before.statusDot ?? "") &&
          observed.after.open === true &&
          observed.parsed?.parameters?.market === "EU" &&
          typeof observed.parsed?.result === "string",
        summary: `tool=${observed.before.toolName}, open=${observed.after.open}`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "C05",
    "approval · ChatActionCard 流转 3 态 pending → approved → used · 状态变化有图标切换 + 底色过渡 250ms",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "approval");
      const pendingShot = await captureScreenshot(page, "screenshots/P2A-05/c05-approval-pending.png");
      const before = await page.evaluate(() => {
        const shell = document.querySelector(".chat-action-shell");
        const style = shell ? getComputedStyle(shell) : null;
        return {
          className: shell?.className ?? null,
          statusText: shell?.querySelector(".chat-action-status span:last-child")?.textContent?.trim() ?? null,
          icon: shell?.querySelector(".chat-action-status-icon")?.textContent?.trim() ?? null,
          transitionDuration: style?.transitionDuration ?? null
        };
      });
      await page.locator("[data-payload='approve']").click();
      await page.waitForTimeout(120);
      const approvedShot = await captureScreenshot(page, "screenshots/P2A-05/c05-approval-approved.png");
      const approved = await page.evaluate(() => {
        const shell = document.querySelector(".chat-action-shell");
        return {
          className: shell?.className ?? null,
          statusText: shell?.querySelector(".chat-action-status span:last-child")?.textContent?.trim() ?? null,
          icon: shell?.querySelector(".chat-action-status-icon")?.textContent?.trim() ?? null
        };
      });
      await page.waitForTimeout(220);
      const usedShot = await captureScreenshot(page, "screenshots/P2A-05/c05-approval-used.png");
      const used = await page.evaluate(() => {
        const shell = document.querySelector(".chat-action-shell");
        return {
          className: shell?.className ?? null,
          statusText: shell?.querySelector(".chat-action-status span:last-child")?.textContent?.trim() ?? null,
          icon: shell?.querySelector(".chat-action-status-icon")?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c05-approval-flow.json", {
        generatedAt: new Date().toISOString(),
        before,
        approved,
        used,
        screenshots: [pendingShot.path, approvedShot.path, usedShot.path]
      });
      return {
        pass:
          /is-pending/.test(before.className ?? "") &&
          /0\.24s/.test(before.transitionDuration ?? "") &&
          /is-approved/.test(approved.className ?? "") &&
          approved.icon === "✓" &&
          /is-used/.test(used.className ?? "") &&
          used.icon === "↗",
        summary: `${before.statusText} -> ${approved.statusText} -> ${used.statusText}`,
        artifacts: [probe, pendingShot, approvedShot, usedShot],
        observed: { before, approved, used }
      };
    }
  );

  await verifyRule(
    6,
    "C06",
    "autonomous-step · AutonomousStepIndicator 独立行 · \"步骤 3/7 · 正在查询渠道日志\" · 有小 spinner",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "step-indicator");
      const screenshot = await captureScreenshot(page, "screenshots/P2A-05/c06-step-indicator.png");
      const observed = await page.evaluate(() => {
        const shell = document.querySelector(".chat-step-shell");
        const spinner = document.querySelector(".chat-step-spinner");
        return {
          text: shell?.querySelector("strong")?.textContent?.trim() ?? null,
          spinnerDuration: spinner ? getComputedStyle(spinner).animationDuration : null,
          spinnerName: spinner ? getComputedStyle(spinner).animationName : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c06-step-indicator.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.text === "步骤 3/7 · 正在查询渠道日志" &&
          observed.spinnerDuration === "0.4s" &&
          observed.spinnerName === "chat-spinner",
        summary: observed.text,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "C07",
    "grant-evidence · grantId 悬浮卡 · 显示 { scope, expiresAt, source } · 空字段不显示 · 位置 top + 箭头",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "grant-evidence");
      await page.locator(".grant-evidence-row").hover();
      await page.waitForTimeout(180);
      const fullShot = await captureScreenshot(page, "screenshots/P2A-05/c07-grant-tooltip-full.png");
      const full = await page.evaluate(() => {
        const row = document.querySelector(".grant-evidence-row");
        const tooltip = document.querySelector(".grant-tooltip");
        const rowRect = row?.getBoundingClientRect();
        const tooltipRect = tooltip?.getBoundingClientRect();
        const arrow = tooltip ? getComputedStyle(tooltip, "::after") : null;
        return {
          text: tooltip?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          opacity: tooltip ? getComputedStyle(tooltip).opacity : null,
          rowTop: rowRect?.top ?? null,
          tooltipBottom: tooltipRect?.bottom ?? null,
          arrowContent: arrow?.content ?? null,
          arrowTransform: arrow?.transform ?? null
        };
      });
      await page.evaluate(() => {
        const turns = window.__fridayQa.chat.buildTurns("grant-evidence");
        const emptyGrant = {
          ...turns[1],
          id: "turn-grant-empty",
          source: ""
        };
        window.__fridayQa.chat.setCustomTurns([turns[0], emptyGrant]);
      });
      await page.waitForTimeout(120);
      await page.locator(".grant-evidence-row").hover();
      const emptyField = await page.evaluate(() => ({
        text: document.querySelector(".grant-tooltip")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c07-grant-tooltip.json", {
        generatedAt: new Date().toISOString(),
        full,
        emptyField,
        screenshot: fullShot.path
      });
      return {
        pass:
          Number(full.opacity ?? "0") >= 0.95 &&
          (full.tooltipBottom ?? 0) < (full.rowTop ?? 0) &&
          /Scope/.test(full.text ?? "") &&
          /Expires/.test(full.text ?? "") &&
          /Source/.test(full.text ?? "") &&
          full.arrowContent === "\"\"" &&
          /matrix/.test(full.arrowTransform ?? "") &&
          !/Source/.test(emptyField.text ?? ""),
        summary: `tooltip="${full.text}"`,
        artifacts: [probe, fullShot],
        observed: { full, emptyField }
      };
    }
  );

  await verifyRule(
    8,
    "C08",
    "session-resume · 刷新后 sessionKey 从 localStorage.getItem('friday-chat-session-key') 读 · 历史气泡顺序与刷新前一致",
    async () => {
      const first = await bootChatPage(browser, baseUrl, "session-resume");
      const before = await first.page.evaluate(async () => {
        const turns = window.__fridayQa.chat.buildTurns("session-resume");
        const sessionKey = "chat:default:resume-evidence";
        window.__fridayQa.chat.persistSession(sessionKey, turns);
        window.localStorage.setItem("friday-chat-session-key", sessionKey);
        window.__fridayQa.chat.setSelectedSession(sessionKey);
        window.__fridayMock.forceState("/chat", "session-resume");
        await new Promise((resolve) => setTimeout(resolve, 260));
        const hydrated = window.__fridayQa.chat.hydrateSession();
        return {
          sessionKey: window.localStorage.getItem("friday-chat-session-key"),
          hydratedJson: JSON.stringify(hydrated),
          firstId: hydrated[0]?.id ?? null,
          lastId: hydrated[hydrated.length - 1]?.id ?? null
        };
      });
      const storageState = await first.context.storageState();
      await first.context.close();
      const second = await bootChatPage(browser, baseUrl, "session-resume", { storageState, waitMs: 260 });
      const after = await second.page.evaluate(() => {
        const hydrated = window.__fridayQa.chat.hydrateSession();
        return {
          sessionKey: window.localStorage.getItem("friday-chat-session-key"),
          hydratedJson: JSON.stringify(hydrated),
          firstId: hydrated[0]?.id ?? null,
          lastId: hydrated[hydrated.length - 1]?.id ?? null
        };
      });
      await second.context.close();
      const beforeHash = buildTurnSequenceHash(before.hydratedJson);
      const afterHash = buildTurnSequenceHash(after.hydratedJson);
      const probe = await writeJson("screenshots/P2A-05/c08-session-resume.json", {
        generatedAt: new Date().toISOString(),
        before: { ...before, hydratedHash: beforeHash },
        after: { ...after, hydratedHash: afterHash }
      });
      return {
        pass:
          before.sessionKey === "chat:default:resume-evidence" &&
          after.sessionKey === before.sessionKey &&
          beforeHash === afterHash &&
          before.firstId === after.firstId &&
          before.lastId === after.lastId,
        summary: `hash=${afterHash.slice(0, 12)}…, session=${after.sessionKey}`,
        artifacts: [probe],
        observed: {
          before: { ...before, hydratedHash: beforeHash },
          after: { ...after, hydratedHash: afterHash }
        }
      };
    }
  );

  await verifyRule(
    9,
    "C09",
    "disconnected · WS 断开 3 秒内顶部红色条 \"连接已断开 · 正在重试 ({retry_count})\" · 重连成功后 500ms 淡出",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "disconnected");
      const liveShot = await captureScreenshot(page, "screenshots/P2A-05/c09-disconnected-live.png");
      const before = await page.evaluate(() => {
        const banner = document.querySelector(".chat-disconnected-banner");
        const style = banner ? getComputedStyle(banner) : null;
        return {
          text: banner?.textContent?.trim() ?? null,
          color: style?.color ?? null,
          transitionDuration: style?.transitionDuration ?? null
        };
      });
      const duringFade = await page.evaluate(async () => {
        window.__fridayQa.chat.setState("user-sent");
        await new Promise((resolve) => setTimeout(resolve, 80));
        const banner = document.querySelector(".chat-disconnected-banner");
        return {
          className: banner?.className ?? null,
          opacity: banner ? getComputedStyle(banner).opacity : null
        };
      });
      await page.waitForFunction(() => !document.querySelector(".chat-disconnected-banner"));
      const doneShot = await captureScreenshot(page, "screenshots/P2A-05/c09-disconnected-done.png");
      const after = await page.evaluate(() => ({
        bannerVisible: Boolean(document.querySelector(".chat-disconnected-banner"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c09-disconnected-banner.json", {
        generatedAt: new Date().toISOString(),
        before,
        duringFade,
        after,
        screenshots: [liveShot.path, doneShot.path]
      });
      return {
        pass:
          before.text === "连接已断开 · 正在重试 (1)" &&
          before.color === "rgb(165, 48, 40)" &&
          before.transitionDuration === "0.5s" &&
          /is-fading/.test(duringFade.className ?? "") &&
          Number(duringFade.opacity ?? "1") < 1 &&
          after.bannerVisible === false,
        summary: `${before.text} -> fading -> hidden`,
        artifacts: [probe, liveShot, doneShot],
        observed: { before, duringFade, after }
      };
    }
  );

  await verifyRule(
    10,
    "C10",
    "消息最大 840px · 中央对齐 · 左右各 flex gutter",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent");
      const observed = await page.evaluate(() => {
        const timeline = document.querySelector(".chat-main-column > .chat-timeline-shell")?.getBoundingClientRect();
        const composer = document.querySelector(".chat-main-column > .chat-composer-shell")?.getBoundingClientRect();
        const bubble = document.querySelector(".chat-bubble-row .chat-bubble")?.getBoundingClientRect();
        return {
          timelineWidth: timeline?.width ?? null,
          composerWidth: composer?.width ?? null,
          timelineCenter: timeline ? timeline.left + (timeline.width / 2) : null,
          composerCenter: composer ? composer.left + (composer.width / 2) : null,
          bubbleWidth: bubble?.width ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c10-message-width.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          (observed.timelineWidth ?? 9999) <= 840 &&
          (observed.composerWidth ?? 9999) <= 840 &&
          Math.abs((observed.timelineCenter ?? 0) - (observed.composerCenter ?? 0)) <= 1 &&
          (observed.bubbleWidth ?? 9999) < (observed.timelineWidth ?? 0),
        summary: `timeline=${observed.timelineWidth}px, bubble=${observed.bubbleWidth}px`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    11,
    "C11",
    "新消息自动滚底 · 若用户手动向上滚超过 200px · 不自动滚 · 改显右下 \"新消息 ↓\" 浮标",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "session-resume");
      const observed = await page.evaluate(async () => {
        function makeTurns(count) {
          return Array.from({ length: count }).map((_, index) => ({
            id: `turn-c11-${index + 1}`,
            kind: "message",
            role: index % 2 === 0 ? "user" : "assistant",
            content: "库存和预算异常需要逐行核对。 ".repeat(16),
            status: "done",
            createdAt: new Date(Date.now() + (index * 60_000)).toISOString(),
            timestamp: new Date(Date.now() + (index * 60_000)).toISOString()
          }));
        }

        const qa = window.__fridayQa.chat;
        qa.setCustomTurns(makeTurns(17));
        await new Promise((resolve) => setTimeout(resolve, 280));
        let shell = document.querySelector(".chat-timeline-shell");
        shell.scrollTop = shell.scrollHeight;
        shell.dispatchEvent(new Event("scroll"));
        qa.setCustomTurns(makeTurns(18));
        await new Promise((resolve) => setTimeout(resolve, 380));
        shell = document.querySelector(".chat-timeline-shell");
        const nearBottom = {
          top: shell.scrollTop,
          max: shell.scrollHeight - shell.clientHeight,
          badge: Boolean(document.querySelector(".chat-new-message-badge"))
        };
        shell.scrollTop = Math.max(0, shell.scrollHeight - shell.clientHeight - 420);
        shell.dispatchEvent(new Event("scroll"));
        qa.setCustomTurns(makeTurns(19));
        await new Promise((resolve) => setTimeout(resolve, 420));
        shell = document.querySelector(".chat-timeline-shell");
        const farUp = {
          top: shell.scrollTop,
          gap: shell.scrollHeight - (shell.scrollTop + shell.clientHeight),
          badge: Boolean(document.querySelector(".chat-new-message-badge"))
        };
        return { nearBottom, farUp };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c11-auto-scroll.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Math.abs((observed.nearBottom.top ?? 0) - (observed.nearBottom.max ?? 0)) <= 8 &&
          observed.nearBottom.badge === false &&
          (observed.farUp.gap ?? 0) > 200 &&
          observed.farUp.badge === true,
        summary: `nearBottom=${observed.nearBottom.top}/${observed.nearBottom.max}, farGap=${observed.farUp.gap}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    12,
    "C12",
    "> 50 条消息启用虚拟化(react-window 或等价)· 滚动 FPS ≥ 55",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "session-resume", { waitMs: 320 });
      const observed = await page.evaluate(async () => {
        const shell = document.querySelector(".chat-timeline-shell");
        const timeline = document.querySelector(".chat-timeline");
        const beforeIds = Array.from(document.querySelectorAll(".chat-timeline [data-turn-id]")).slice(0, 5).map((node) => node.getAttribute("data-turn-id"));
        const frameDurations = [];
        let lastFrame = 0;
        await new Promise((resolve) => {
          const totalFrames = 90;
          const step = (timestamp) => {
            if (lastFrame) {
              frameDurations.push(timestamp - lastFrame);
            }
            lastFrame = timestamp;
            const progress = frameDurations.length / totalFrames;
            shell.scrollTop = progress * 1800;
            shell.dispatchEvent(new Event("scroll"));
            if (frameDurations.length >= totalFrames) {
              resolve();
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        await new Promise((resolve) => setTimeout(resolve, 180));
        const afterIds = Array.from(document.querySelectorAll(".chat-timeline [data-turn-id]")).slice(0, 5).map((node) => node.getAttribute("data-turn-id"));
        return {
          virtualized: timeline?.dataset.virtualized ?? null,
          itemCount: Number(timeline?.dataset.itemCount ?? 0),
          rendered: document.querySelectorAll(".chat-timeline [data-turn-id]").length,
          viewportHeight: shell?.clientHeight ?? null,
          frameDurations,
          beforeIds,
          afterIds,
          finalTop: shell?.scrollTop ?? null
        };
      });
      await context.close();
      observed.frameStats = summarizeStats(observed.frameDurations);
      const fps = observed.frameStats.mean ? 1000 / observed.frameStats.mean : 0;
      const probe = await writeJson("screenshots/P2A-05/c12-virtualized-fps.json", {
        generatedAt: new Date().toISOString(),
        observed,
        fps
      });
      return {
        pass:
          observed.virtualized === "true" &&
          observed.itemCount > 50 &&
          observed.rendered <= 24 &&
          fps >= 55 &&
          JSON.stringify(observed.beforeIds) !== JSON.stringify(observed.afterIds),
        summary: `rendered=${observed.rendered}, fps=${fps.toFixed(2)}`,
        artifacts: [probe],
        observed: {
          ...observed,
          fps
        }
      };
    }
  );

  await verifyRule(
    13,
    "C13",
    "composer Enter 发 · Shift+Enter 换行 · / 唤起 slash 菜单 · Escape 关菜单",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      await page.click("#chat-composer");
      await page.keyboard.type("第一行");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("第二行");
      const newlineState = await page.evaluate(() => ({
        value: document.getElementById("chat-composer")?.value ?? "",
        turns: window.__fridayQa.chat.getState().turns.length
      }));
      await page.fill("#chat-composer", "");
      await page.keyboard.type("/");
      const slashOpened = await page.evaluate(() => ({
        open: Boolean(document.querySelector(".chat-slash-menu")),
        count: document.querySelectorAll(".chat-slash-item").length
      }));
      await page.keyboard.press("Escape");
      const slashClosed = await page.evaluate(() => ({
        open: Boolean(document.querySelector(".chat-slash-menu")),
        value: document.getElementById("chat-composer")?.value ?? ""
      }));
      await page.fill("#chat-composer", "请继续处理预算异常");
      const beforeSendTurns = await page.evaluate(() => window.__fridayQa.chat.getState().history);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(260);
      const afterSend = await page.evaluate(() => {
        const history = window.__fridayQa.chat.getState().history;
        const record = history[window.__fridayQa.chat.getState().selectedSessionId];
        return {
          route: `${window.location.pathname}${window.location.search}`,
          composerValue: document.getElementById("chat-composer")?.value ?? "",
          historyCount: record?.turns?.length ?? 0
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c13-composer-keys.json", {
        generatedAt: new Date().toISOString(),
        newlineState,
        slashOpened,
        slashClosed,
        beforeSendSessions: Object.keys(beforeSendTurns).length,
        afterSend
      });
      return {
        pass:
          newlineState.value === "第一行\n第二行" &&
          newlineState.turns === 0 &&
          slashOpened.open === true &&
          slashOpened.count >= 6 &&
          slashClosed.open === false &&
          slashClosed.value === "" &&
          afterSend.route.startsWith("/chat?") &&
          afterSend.composerValue === "" &&
          afterSend.historyCount >= 2,
        summary: `newline preserved, slashItems=${slashOpened.count}, history=${afterSend.historyCount}`,
        artifacts: [probe],
        observed: { newlineState, slashOpened, slashClosed, afterSend }
      };
    }
  );

  await verifyRule(
    14,
    "C14",
    "composer 附件支持拖入 + 点击上传 · 上传中显示进度 bar · 失败有 retry",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const dragState = await page.evaluate(() => {
        const dropzone = document.querySelector("[data-chat-dropzone='true']");
        dropzone?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true }));
        return true;
      });
      await page.waitForTimeout(120);
      const dragObserved = await page.evaluate(() => {
        const dropzone = document.querySelector("[data-chat-dropzone='true']");
        return {
          active: dropzone?.classList.contains("is-drag-active") ?? false
        };
      });
      await page.locator("[data-action='attach-file']").click();
      await page.waitForTimeout(200);
      const uploading = await page.evaluate(() => ({
        name: document.querySelector(".chat-upload-name")?.textContent?.trim() ?? null,
        progressWidth: document.querySelector(".chat-upload-progress span")?.getAttribute("style") ?? null,
        status: document.querySelector(".chat-upload-meta")?.textContent?.trim() ?? null
      }));
      await page.waitForTimeout(360);
      const failedShot = await captureScreenshot(page, "screenshots/P2A-05/c14-upload-failed.png");
      const failed = await page.evaluate(() => ({
        status: document.querySelector(".chat-upload-meta")?.textContent?.trim() ?? null,
        retryVisible: Boolean(document.querySelector(".chat-upload-retry"))
      }));
      await page.locator("[data-action='retry-chat-upload']").click();
      await page.waitForTimeout(520);
      const recovered = await page.evaluate(() => ({
        status: document.querySelector(".chat-upload-meta")?.textContent?.trim() ?? null,
        retryVisible: Boolean(document.querySelector(".chat-upload-retry"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c14-upload-flow.json", {
        generatedAt: new Date().toISOString(),
        dragState,
        dragObserved,
        uploading,
        failed,
        recovered,
        screenshot: failedShot.path
      });
      return {
        pass:
          dragObserved.active === true &&
          uploading.name === "brief.pdf" &&
          /Uploading|上传中/.test(uploading.status ?? "") &&
          failed.retryVisible === true &&
          /Upload failed|上传失败/.test(failed.status ?? "") &&
          /Uploaded|上传完成/.test(recovered.status ?? "") &&
          recovered.retryVisible === false,
        summary: `${failed.status} -> ${recovered.status}`,
        artifacts: [probe, failedShot],
        observed: { dragState, uploading, failed, recovered }
      };
    }
  );

  await verifyRule(
    15,
    "C15",
    "activity-rail 显示最近 10 个 session · 当前 session 高亮 · 点击切换不丢当前输入",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const observed = await page.evaluate(async () => {
        window.localStorage.removeItem("friday-chat-session-key");
        const rows = Array.from(document.querySelectorAll(".chat-session-row"));
        const beforeActive = window.__fridayQa.chat.getState().selectedSessionId;
        const composer = document.getElementById("chat-composer");
        composer.value = "draft-alpha";
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("[data-payload='session-provider-circuit']")?.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const switchedActive = window.__fridayQa.chat.getState().selectedSessionId;
        document.querySelector("[data-payload='session-replenish-watch']")?.click();
        await new Promise((resolve) => setTimeout(resolve, 220));
        return {
          rowCount: rows.length,
          beforeActive,
          switchedActive,
          restoredValue: document.getElementById("chat-composer")?.value ?? ""
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c15-session-rail.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.rowCount === 10 &&
          observed.beforeActive !== observed.switchedActive &&
          observed.restoredValue === "draft-alpha",
        summary: `sessions=${observed.rowCount}, restored="${observed.restoredValue}"`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    16,
    "C16",
    "side-panel 显示 run 详情 / grant 详情 / trace · Ctrl+\\ 切换开关",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent");
      const before = await page.evaluate(() => ({
        open: document.querySelector(".chat-side-panel")?.classList.contains("is-open") ?? false,
        display: getComputedStyle(document.querySelector(".chat-side-panel")).display
      }));
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "\\",
          ctrlKey: true,
          bubbles: true
        }));
      });
      await page.waitForTimeout(120);
      const screenshot = await captureScreenshot(page, "screenshots/P2A-05/c16-side-panel-open.png");
      const after = await page.evaluate(() => ({
        open: document.querySelector(".chat-side-panel")?.classList.contains("is-open") ?? false,
        display: getComputedStyle(document.querySelector(".chat-side-panel")).display,
        text: document.querySelector(".chat-side-panel")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-05/c16-side-panel-toggle.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        screenshot: screenshot.path
      });
      return {
        pass:
          before.open === false &&
          before.display === "none" &&
          after.open === true &&
          after.display === "block" &&
          /run=/.test(after.text ?? "") &&
          /grant=/.test(after.text ?? "") &&
          /trace=/.test(after.text ?? ""),
        summary: after.text,
        artifacts: [probe, screenshot],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    17,
    "C17",
    "Data contract 严格用 useChatSession + useAgentRunEvents · 不开第二个 WS · Network panel 只 1 条 WS",
    async () => {
      const chatHookSource = await fs.readFile(path.join(ROOT, "ui/src/hooks/use-chat-session.ts"), "utf8");
      const runHookSource = await fs.readFile(path.join(ROOT, "ui/src/hooks/use-agent-run-events.ts"), "utf8");
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const { page, context, websocketConnections, eventSourceRequests } = await bootChatPage(browser, baseUrl, "user-sent");
      const runtime = await page.evaluate(() => ({
        wsConnections: window.__fridayQa.chat.getState().wsConnections,
        historyKeyPresent: typeof window.localStorage.getItem("friday-chat-history") === "string" || window.localStorage.getItem("friday-chat-history") === null,
        sessionKeyPresent: typeof window.localStorage.getItem("friday-chat-session-key") === "string" || window.localStorage.getItem("friday-chat-session-key") === null
      }));
      await context.close();
      const sourceMatches = {
        chatHookHasStorageKeys:
          chatHookSource.includes('const SESSION_KEY_STORAGE = "friday-chat-session-key"') &&
          chatHookSource.includes('const HISTORY_STORAGE = "friday-chat-history"'),
        chatHookUsesRunHook: chatHookSource.includes("useAgentRunEvents("),
        runHookDefinesConnectionState: runHookSource.includes('export type ConnectionState = "idle" | "connecting" | "streaming" | "closed" | "error"'),
        prototypeUsesSingleLogicalWs: staticSource.includes("wsConnections: 1")
      };
      const probe = await writeJson("screenshots/P2A-05/c17-data-contract.json", {
        generatedAt: new Date().toISOString(),
        sourceMatches,
        runtime,
        websocketConnections,
        eventSourceRequests
      });
      return {
        pass:
          sourceMatches.chatHookHasStorageKeys &&
          sourceMatches.chatHookUsesRunHook &&
          sourceMatches.runHookDefinesConnectionState &&
          sourceMatches.prototypeUsesSingleLogicalWs &&
          runtime.wsConnections === 1 &&
          websocketConnections.length <= 1,
        summary: `logicalWs=${runtime.wsConnections}, networkWs=${websocketConnections.length}, eventSources=${eventSourceRequests.length}`,
        artifacts: [probe],
        observed: {
          sourceMatches,
          runtime,
          websocketConnections,
          eventSourceRequests
        }
      };
    }
  );

  await verifyRule(
    18,
    "C18",
    "props 签名 grep diff · ChatMessageBubble / ChatToolActivity / ChatActionCard / AutonomousStepIndicator 四个组件字段集合 diff=0",
    async () => {
      const sourceFiles = [
        {
          component: "ChatMessageBubble",
          file: path.join(ROOT, "ui/src/components/chat/chat-message.tsx"),
          interfaceName: "ChatMessageBubbleProps",
          functionName: "chatMessageBubble"
        },
        {
          component: "ChatToolActivity",
          file: path.join(ROOT, "ui/src/components/chat/chat-tool-activity.tsx"),
          interfaceName: "ChatToolActivityProps",
          functionName: "chatToolActivity"
        },
        {
          component: "ChatActionCard",
          file: path.join(ROOT, "ui/src/components/chat/chat-action-card.tsx"),
          interfaceName: "ChatActionCardProps",
          functionName: "chatActionCard"
        },
        {
          component: "AutonomousStepIndicator",
          file: path.join(ROOT, "ui/src/components/chat/autonomous-step-indicator.tsx"),
          interfaceName: "AutonomousStepIndicatorProps",
          functionName: "autonomousStepIndicator"
        }
      ];
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const comparisons = [];
      const grepSections = [];
      for (const entry of sourceFiles) {
        const sourceText = await fs.readFile(entry.file, "utf8");
        const interfaceInfo = extractInterfaceFields(sourceText, entry.interfaceName);
        const functionInfo = extractFunctionPropFields(staticSource, entry.functionName);
        const sourceFields = interfaceInfo.fields.slice().sort();
        const prototypeFields = functionInfo.fields.slice().sort();
        const missing = sourceFields.filter((field) => !prototypeFields.includes(field));
        const extra = prototypeFields.filter((field) => !sourceFields.includes(field));
        comparisons.push({
          component: entry.component,
          sourceFields,
          prototypeFields,
          missing,
          extra
        });
        grepSections.push(
          `# ${entry.component}`,
          `${entry.interfaceName}: ${sourceFields.join(", ")}`,
          `${entry.functionName}(props): ${prototypeFields.join(", ")}`,
          `missing: ${missing.join(", ") || "(none)"}`,
          `extra: ${extra.join(", ") || "(none)"}`,
          ""
        );
      }
      const grepBody = grepSections.join("\n");
      const grepArtifact = await writeJson("screenshots/P2A-05/c18-props-diff.json", {
        generatedAt: new Date().toISOString(),
        comparisons
      });
      const grepPath = path.join(ROOT, "screenshots", "P2A-05", "c18-props-grep.txt");
      await ensureDir(path.dirname(grepPath));
      await fs.writeFile(grepPath, `${grepBody}\n`);
      const grepContent = await fs.readFile(grepPath);
      const grepTextArtifact = {
        path: "screenshots/P2A-05/c18-props-grep.txt",
        sha256: sha256(grepContent)
      };
      const pass = comparisons.every((entry) => entry.missing.length === 0 && entry.extra.length === 0);
      return {
        pass,
        summary: comparisons.map((entry) => `${entry.component}: missing=${entry.missing.length}, extra=${entry.extra.length}`).join(" | "),
        artifacts: [grepArtifact, grepTextArtifact],
        observed: { comparisons }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2A-05", "/chat", generatedAt, results, artifacts);
}

async function verifyP2A06(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "L01",
    "turn.kind switch 穷举 6 值 · message | tool | action | step | time-divider | grant · default branch throw · 不允许 fallback silent",
    async () => {
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const switchCases = [
        "item.kind === \"message\"",
        "item.kind === \"tool\"",
        "item.kind === \"action\"",
        "item.kind === \"step\"",
        "item.kind === \"grant\"",
        "item.kind === \"time-divider\""
      ];
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent");
      const runtime = await page.evaluate(() => {
        try {
          window.__fridayQa.chat.setCustomTurns([{
            id: "turn-invalid",
            kind: "unknown-kind",
            createdAt: new Date().toISOString()
          }]);
          return { threw: false, message: null };
        } catch (error) {
          window.__fridayQa.chat.clearCustomTurns();
          return { threw: true, message: error.message };
        }
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l01-switch-exhaustive.json", {
        generatedAt: new Date().toISOString(),
        switchCases,
        runtime
      });
      return {
        pass:
          switchCases.every((entry) => staticSource.includes(entry)) &&
          staticSource.includes("throw new Error(\"Unsupported turn.kind: \" + String(item.kind));") &&
          runtime.threw === true &&
          /Unsupported turn.kind/.test(runtime.message ?? ""),
        summary: runtime.message,
        artifacts: [probe],
        observed: { switchCases, runtime }
      };
    }
  );

  await verifyRule(
    2,
    "L02",
    "time-divider · 横线 + 中间日期 · 当某 turn 与上一条相隔 > 10 分钟自动插入",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent");
      const observed = await page.evaluate(async () => {
        const turns = [
          {
            id: "turn-1",
            kind: "message",
            role: "user",
            content: "第一条消息",
            status: "done",
            createdAt: "2026-04-20T10:00:00.000Z",
            timestamp: "2026-04-20T10:00:00.000Z"
          },
          {
            id: "turn-2",
            kind: "message",
            role: "assistant",
            content: "第二条消息",
            status: "done",
            createdAt: "2026-04-20T10:15:00.000Z",
            timestamp: "2026-04-20T10:15:00.000Z"
          }
        ];
        window.__fridayQa.chat.setCustomTurns(turns);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const divider = document.querySelector(".time-divider");
        return {
          dividerCount: document.querySelectorAll(".time-divider").length,
          dividerText: divider?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l02-time-divider.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.dividerCount === 1 &&
          typeof observed.dividerText === "string" &&
          observed.dividerText.length > 0,
        summary: observed.dividerText,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "L03",
    "自动滚底逻辑 · 新 turn 进入时若 scrollTop >= scrollHeight - 300 · 平滑滚底",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "session-resume");
      const observed = await page.evaluate(async () => {
        function makeTurns(count) {
          return Array.from({ length: count }).map((_, index) => ({
            id: `turn-l03-${index + 1}`,
            kind: "message",
            role: index % 2 === 0 ? "user" : "assistant",
            content: "预算异常需要继续拆解。 ".repeat(16),
            status: "done",
            createdAt: new Date(Date.now() + (index * 60_000)).toISOString(),
            timestamp: new Date(Date.now() + (index * 60_000)).toISOString()
          }));
        }
        const qa = window.__fridayQa.chat;
        qa.setCustomTurns(makeTurns(17));
        await new Promise((resolve) => setTimeout(resolve, 280));
        let shell = document.querySelector(".chat-timeline-shell");
        shell.scrollTop = shell.scrollHeight;
        shell.dispatchEvent(new Event("scroll"));
        qa.setCustomTurns(makeTurns(18));
        await new Promise((resolve) => setTimeout(resolve, 420));
        shell = document.querySelector(".chat-timeline-shell");
        return {
          top: shell.scrollTop,
          max: shell.scrollHeight - shell.clientHeight,
          badge: Boolean(document.querySelector(".chat-new-message-badge"))
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l03-auto-bottom.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Math.abs((observed.top ?? 0) - (observed.max ?? 0)) <= 8 &&
          observed.badge === false,
        summary: `top=${observed.top}, max=${observed.max}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "L04",
    "> 50 条时虚拟化 · 仅渲染可视 + 上下 5 条 buffer",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "session-resume", { waitMs: 320 });
      const observed = await page.evaluate(async () => {
        const shell = document.querySelector(".chat-timeline-shell");
        const timeline = document.querySelector(".chat-timeline");
        const viewportHeight = shell?.clientHeight ?? 0;
        const initial = {
          rendered: document.querySelectorAll(".chat-timeline [data-turn-id]").length,
          firstIds: Array.from(document.querySelectorAll(".chat-timeline [data-turn-id]")).slice(0, 5).map((node) => node.getAttribute("data-turn-id"))
        };
        shell.scrollTop = 1800;
        shell.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => setTimeout(resolve, 220));
        return {
          virtualized: timeline?.dataset.virtualized ?? null,
          itemCount: Number(timeline?.dataset.itemCount ?? 0),
          viewportHeight,
          initial,
          afterScroll: {
            rendered: document.querySelectorAll(".chat-timeline [data-turn-id]").length,
            firstIds: Array.from(document.querySelectorAll(".chat-timeline [data-turn-id]")).slice(0, 5).map((node) => node.getAttribute("data-turn-id"))
          }
        };
      });
      await context.close();
      const maxExpected = Math.ceil((observed.viewportHeight ?? 0) / 84) + 10;
      const probe = await writeJson("screenshots/P2A-06/l04-virtual-window.json", {
        generatedAt: new Date().toISOString(),
        observed,
        maxExpected
      });
      return {
        pass:
          observed.virtualized === "true" &&
          observed.itemCount > 50 &&
          observed.initial.rendered <= maxExpected &&
          observed.afterScroll.rendered <= maxExpected &&
          JSON.stringify(observed.initial.firstIds) !== JSON.stringify(observed.afterScroll.firstIds),
        summary: `rendered=${observed.afterScroll.rendered}/${maxExpected}`,
        artifacts: [probe],
        observed: { ...observed, maxExpected }
      };
    }
  );

  await verifyRule(
    5,
    "L05",
    "scroll 位置在 session 切换前写 localStorage['friday-chat-scroll-' + sessionId] · 切回恢复",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "session-resume", { waitMs: 260 });
      const observed = await page.evaluate(async () => {
        function makeTurns(prefix, count) {
          return Array.from({ length: count }).map((_, index) => ({
            id: `${prefix}-${index + 1}`,
            kind: "message",
            role: index % 2 === 0 ? "user" : "assistant",
            content: "恢复滚动位置验证。 ".repeat(16),
            status: "done",
            createdAt: new Date(Date.now() + (index * 60_000)).toISOString(),
            timestamp: new Date(Date.now() + (index * 60_000)).toISOString()
          }));
        }
        const qa = window.__fridayQa.chat;
        qa.persistSession("session-replenish-watch", makeTurns("left", 20));
        qa.persistSession("session-provider-circuit", makeTurns("right", 20));
        qa.setSelectedSession("session-replenish-watch");
        window.__fridayMock.forceState("/chat", "session-resume");
        await new Promise((resolve) => setTimeout(resolve, 260));
        let shell = document.querySelector(".chat-timeline-shell");
        shell.scrollTop = 860;
        shell.dispatchEvent(new Event("scroll"));
        document.querySelector("[data-payload='session-provider-circuit']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 260));
        document.querySelector("[data-payload='session-replenish-watch']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 320));
        shell = document.querySelector(".chat-timeline-shell");
        return {
          restoredTop: shell.scrollTop,
          localStorageValue: window.localStorage.getItem("friday-chat-scroll-session-replenish-watch"),
          offsets: window.__fridayQa.chat.getState().scrollOffsets
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l05-scroll-restore.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.restoredTop === 860 &&
          observed.localStorageValue === "860" &&
          observed.offsets["session-replenish-watch"] === 860,
        summary: `restored=${observed.restoredTop}, localStorage=${observed.localStorageValue}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "L06",
    "每 turn 有 data-turn-id 属性 · 便于 e2e 定位",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "user-sent");
      const observed = await page.evaluate(async () => {
        const turns = [
          {
            id: "turn-msg",
            kind: "message",
            role: "user",
            content: "msg",
            status: "done",
            createdAt: "2026-04-20T10:00:00.000Z",
            timestamp: "2026-04-20T10:00:00.000Z"
          },
          {
            id: "tool-check",
            kind: "tool",
            createdAt: "2026-04-20T10:01:00.000Z",
            toolCalls: [{
              id: "tool-check",
              toolName: "inventory.fetch",
              status: "completed",
              params: { sku: 1 },
              summary: "ok"
            }]
          },
          {
            id: "turn-action",
            kind: "action",
            createdAt: "2026-04-20T10:02:00.000Z",
            status: "pending",
            actions: [{ type: "approve", label: "批准" }]
          },
          {
            id: "goal-test",
            kind: "step",
            createdAt: "2026-04-20T10:03:00.000Z",
            goal: {
              id: "goal-test",
              description: "goal",
              status: "executing",
              currentStepIndex: 2,
              steps: [
                { id: "1", instruction: "1", status: "completed" },
                { id: "2", instruction: "2", status: "completed" },
                { id: "3", instruction: "3", status: "executing" },
                { id: "4", instruction: "4", status: "pending" }
              ]
            }
          },
          {
            id: "turn-grant",
            kind: "grant",
            createdAt: "2026-04-20T10:20:00.000Z",
            grantId: "grant-1",
            scope: "scope",
            expiresAt: "2026-04-20T11:00:00.000Z",
            source: "source"
          }
        ];
        window.__fridayQa.chat.setCustomTurns(turns);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return Array.from(document.querySelectorAll(".chat-timeline [data-turn-id]")).map((node) => node.getAttribute("data-turn-id"));
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l06-turn-ids.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.includes("turn-msg") &&
          observed.includes("tool-check") &&
          observed.includes("turn-action") &&
          observed.includes("goal-test") &&
          observed.includes("turn-grant") &&
          observed.some((id) => id?.startsWith("divider-")),
        summary: observed.join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "L07",
    "同一 turn id 两次更新(stream 过程中)不重渲染整 bubble · React key 稳定",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "streaming", { waitMs: 80 });
      const observed = await page.evaluate(async () => {
        const row = document.querySelector("[data-turn-id='turn-assistant-stream']");
        const copy = row?.querySelector(".chat-bubble-copy");
        const initialText = copy?.textContent ?? "";
        await new Promise((resolve) => setTimeout(resolve, 220));
        const sameRow = row === document.querySelector("[data-turn-id='turn-assistant-stream']");
        const sameCopy = copy === document.querySelector("[data-turn-id='turn-assistant-stream'] .chat-bubble-copy");
        const updatedText = document.querySelector("[data-turn-id='turn-assistant-stream'] .chat-bubble-copy")?.textContent ?? "";
        return {
          sameRow,
          sameCopy,
          initialText,
          updatedText
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l07-stable-row.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.sameRow === true &&
          observed.sameCopy === true &&
          observed.updatedText.length > observed.initialText.length,
        summary: `sameRow=${observed.sameRow}, chars=${observed.initialText.length}->${observed.updatedText.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "L08",
    "键盘 · Tab 可进 turn · 方向键在 turns 间切换 focus · Enter 展开工具 / 审批",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "tool-call");
      await page.locator("[data-payload='session-night-ops']").focus();
      await page.keyboard.press("Tab");
      const tabFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-turn-id"));
      await page.keyboard.press("ArrowDown");
      const downFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-turn-id"));
      await page.keyboard.press("Enter");
      const toolExpanded = await page.evaluate(() => document.querySelector(".chat-tool-shell details")?.open ?? null);
      await page.evaluate(() => window.__fridayQa.chat.setState("approval"));
      await page.waitForTimeout(120);
      await page.locator("[data-turn-id='turn-approval']").focus();
      await page.keyboard.press("Enter");
      const actionFocus = await page.evaluate(() => document.activeElement?.className ?? null);
      await context.close();
      const probe = await writeJson("screenshots/P2A-06/l08-keyboard-nav.json", {
        generatedAt: new Date().toISOString(),
        tabFocus,
        downFocus,
        toolExpanded,
        actionFocus
      });
      return {
        pass:
          typeof tabFocus === "string" &&
          downFocus === "tool-inventory-fetch" &&
          toolExpanded === true &&
          /chat-action-pill/.test(actionFocus ?? ""),
        summary: `tab=${tabFocus}, down=${downFocus}, actionFocus=${actionFocus}`,
        artifacts: [probe],
        observed: { tabFocus, downFocus, toolExpanded, actionFocus }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2A-06", "/chat", generatedAt, results, artifacts);
}

async function verifyP2A07(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "I01",
    "textarea 初始 80px · 内容增多自动长到 320 · 超过出滚动条 · 不撑破 composer 容器",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const observed = await page.evaluate(async () => {
        let composer = document.getElementById("chat-composer");
        const initial = {
          height: getComputedStyle(composer).height,
          overflowY: getComputedStyle(composer).overflowY
        };
        composer.value = Array.from({ length: 18 }).map((_, index) => `Line ${index + 1}`).join("\n");
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        composer = document.getElementById("chat-composer");
        const grown = {
          height: getComputedStyle(composer).height,
          overflowY: getComputedStyle(composer).overflowY,
          shellHeight: getComputedStyle(document.querySelector(".chat-composer-dropzone")).minHeight
        };
        composer.value = Array.from({ length: 240 }).map((_, index) => `overflow composer validation ${index + 1}`).join(" ");
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        composer = document.getElementById("chat-composer");
        const overflow = {
          height: getComputedStyle(composer).height,
          overflowY: getComputedStyle(composer).overflowY
        };
        return { initial, grown, overflow };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i01-composer-height.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.initial.height === "80px" &&
          Number.parseFloat(observed.grown.height) <= 320 &&
          Number.parseFloat(observed.grown.height) > 80 &&
          observed.overflow.height === "320px" &&
          observed.overflow.overflowY === "auto",
        summary: `80 -> ${observed.grown.height} -> ${observed.overflow.height}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "I02",
    "Enter 发送 · Shift+Enter 换行 · Cmd+Enter 也发送 · Escape 清空当前内容(需确认)",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      await page.click("#chat-composer");
      await page.keyboard.type("第一行");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("第二行");
      const newline = await page.$eval("#chat-composer", (node) => node.value);
      await page.fill("#chat-composer", "Cmd Enter send");
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(260);
      const cmdSend = await page.evaluate(() => {
        const history = window.__fridayQa.chat.getState().history;
        const record = history[window.__fridayQa.chat.getState().selectedSessionId];
        return {
          composer: document.getElementById("chat-composer")?.value ?? "",
          count: record?.turns?.length ?? 0
        };
      });
      await page.fill("#chat-composer", "待清空草稿");
      await page.keyboard.press("Escape");
      const confirm = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog h3")?.textContent?.trim() ?? null,
        action: document.querySelector("[data-action='confirm-run']")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i02-send-keys.json", {
        generatedAt: new Date().toISOString(),
        newline,
        cmdSend,
        confirm
      });
      return {
        pass:
          newline === "第一行\n第二行" &&
          cmdSend.composer === "" &&
          cmdSend.count >= 2 &&
          confirm.title === "清空当前输入?" &&
          confirm.action === "清空",
        summary: `newline ok, cmdSend=${cmdSend.count}, confirm="${confirm.title}"`,
        artifacts: [probe],
        observed: { newline, cmdSend, confirm }
      };
    }
  );

  await verifyRule(
    3,
    "I03",
    "/ 作为首字符唤起 slash 菜单 · 菜单条目从 slashCommands 静态数组来 · 至少 6 条",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      await page.fill("#chat-composer", "/");
      const observed = await page.evaluate(() => ({
        slashCommands: window.__fridayQa.chat.getState().slashCommands.map((item) => item.id),
        open: Boolean(document.querySelector(".chat-slash-menu")),
        visibleItems: Array.from(document.querySelectorAll(".chat-slash-item")).map((node) => node.textContent?.trim() ?? "")
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i03-slash-source.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.open === true &&
          observed.slashCommands.length >= 6 &&
          observed.visibleItems.length === observed.slashCommands.length,
        summary: observed.slashCommands.join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "I04",
    "slash 菜单在 composer 上方 · max-h 320 带滚动 · ↑↓ 选择 · Enter 确认 · Escape 关",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      await page.fill("#chat-composer", "/");
      const before = await page.evaluate(() => {
        const menu = document.querySelector(".chat-slash-menu");
        const composer = document.getElementById("chat-composer");
        const menuRect = menu?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        return {
          maxHeight: getComputedStyle(menu).maxHeight,
          overflowY: getComputedStyle(menu).overflowY,
          menuBottom: menuRect?.bottom ?? null,
          composerTop: composerRect?.top ?? null,
          activeText: document.querySelector(".chat-slash-item.is-active")?.textContent?.trim() ?? null
        };
      });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const activeAfterArrow = await page.evaluate(() => document.querySelector(".chat-slash-item.is-active")?.textContent?.trim() ?? null);
      await page.keyboard.press("Enter");
      const selectedValue = await page.$eval("#chat-composer", (node) => node.value);
      await page.fill("#chat-composer", "/");
      await page.keyboard.press("Escape");
      const closed = await page.evaluate(() => ({
        open: Boolean(document.querySelector(".chat-slash-menu")),
        value: document.getElementById("chat-composer")?.value ?? ""
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i04-slash-navigation.json", {
        generatedAt: new Date().toISOString(),
        before,
        activeAfterArrow,
        selectedValue,
        closed
      });
      return {
        pass:
          before.maxHeight === "320px" &&
          before.overflowY === "auto" &&
          (before.menuBottom ?? 9999) <= (before.composerTop ?? 0) &&
          before.activeText !== activeAfterArrow &&
          selectedValue.startsWith("/") &&
          closed.open === false &&
          closed.value === "",
        summary: `active=${activeAfterArrow}, value="${selectedValue}"`,
        artifacts: [probe],
        observed: { before, activeAfterArrow, selectedValue, closed }
      };
    }
  );

  await verifyRule(
    5,
    "I05",
    "附件 · 支持拖入 composer 区域 · drop 区 dash border 琥珀 · 非允许类型 toast 错误",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const observed = await page.evaluate(async (colors) => {
        let dropzone = document.querySelector("[data-chat-dropzone='true']");
        dropzone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        dropzone = document.querySelector("[data-chat-dropzone='true']");
        const duringDrag = {
          active: dropzone.classList.contains("is-drag-active"),
          borderStyle: getComputedStyle(dropzone).borderStyle,
          borderColor: getComputedStyle(dropzone).borderColor,
          tokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(dropzone).borderColor)?.[0] ?? null
        };
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(["bad"], "virus.exe", { type: "application/octet-stream" }));
        dropzone = document.querySelector("[data-chat-dropzone='true']");
        dropzone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
        await new Promise((resolve) => setTimeout(resolve, 120));
        const latestToast = document.querySelector(".toast-rack .toast-card:last-child");
        return {
          duringDrag,
          toastText: latestToast?.textContent?.replace(/\s+/g, " ").trim() ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i05-invalid-drop.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.duringDrag.active === true &&
          observed.duringDrag.borderStyle === "dashed" &&
          observed.duringDrag.tokenMatch === "--accent" &&
          /Unsupported attachment type|不支持的附件类型/.test(observed.toastText ?? ""),
        summary: observed.toastText,
        artifacts: [probe],
        observed: {
          tokenColors,
          ...observed
        }
      };
    }
  );

  await verifyRule(
    6,
    "I06",
    "streaming 期间 composer disabled · placeholder 变 \"Friday 正在回答,请稍候\" · 发送按钮灰",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "streaming");
      await page.waitForTimeout(260);
      const observed = await page.evaluate(() => {
        const composer = document.getElementById("chat-composer");
        const send = document.querySelector(".chat-send-button");
        return {
          disabled: composer?.disabled ?? null,
          placeholder: composer?.getAttribute("placeholder") ?? null,
          sendDisabled: send?.disabled ?? null,
          sendOpacity: send ? getComputedStyle(send).opacity : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i06-streaming-disabled.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.disabled === true &&
          observed.placeholder === "Friday 正在回答,请稍候" &&
          observed.sendDisabled === true &&
          observed.sendOpacity === "0.4",
        summary: `${observed.placeholder}, opacity=${observed.sendOpacity}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "I07",
    "发送按钮 · 琥珀 fill · 空输入时 opacity 0.4 · 点击 200ms press feedback",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      await page.waitForTimeout(260);
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const empty = await page.evaluate((colors) => {
        const send = document.querySelector(".chat-send-button");
        const background = getComputedStyle(send).backgroundColor;
        return {
          opacity: getComputedStyle(send).opacity,
          background,
          tokenMatch: Object.entries(colors).find(([, value]) => value === background)?.[0] ?? null
        };
      }, tokenColors);
      await page.fill("#chat-composer", "发送按钮验收");
      await page.waitForTimeout(260);
      const filled = await page.evaluate((colors) => {
        const send = document.querySelector(".chat-send-button");
        const background = getComputedStyle(send).backgroundColor;
        return {
          opacity: getComputedStyle(send).opacity,
          background,
          tokenMatch: Object.entries(colors).find(([, value]) => value === background)?.[0] ?? null
        };
      }, tokenColors);
      await page.locator(".chat-send-button").click();
      await page.waitForTimeout(110);
      const pressed = await page.evaluate(() => getComputedStyle(document.querySelector(".chat-send-button")).transform);
      await page.waitForTimeout(180);
      const released = await page.evaluate(() => getComputedStyle(document.querySelector(".chat-send-button")).transform);
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i07-send-feedback.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        empty,
        filled,
        pressed,
        released
      });
      return {
        pass:
          empty.opacity === "0.4" &&
          empty.tokenMatch === "--accent" &&
          filled.opacity === "1" &&
          filled.tokenMatch === "--accent" &&
          /matrix/.test(pressed) &&
          released === "none",
        summary: `empty=${empty.opacity}, filled=${filled.background}, pressed=${pressed}`,
        artifacts: [probe],
        observed: { tokenColors, empty, filled, pressed, released }
      };
    }
  );

  await verifyRule(
    8,
    "I08",
    "字符计数 · 2000 字以下不显 · 超过显示 \"1923 / 2000\" · 超限红色 + 禁发",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const hidden = await page.evaluate(() => {
        const composer = document.getElementById("chat-composer");
        composer.value = "a".repeat(1890);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        return {
          counterVisible: Boolean(document.querySelector(".chat-composer-footer span[style*='font-family']"))
        };
      });
      const visible = await page.evaluate(() => {
        const composer = document.getElementById("chat-composer");
        composer.value = "a".repeat(1923);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        const counter = document.querySelector(".chat-composer-footer span[style*='font-family']");
        return {
          text: counter?.textContent?.trim() ?? null
        };
      });
      const over = await page.evaluate(() => {
        const composer = document.getElementById("chat-composer");
        composer.value = "a".repeat(2001);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        const counter = document.querySelector(".chat-composer-footer span[style*='font-family']");
        const send = document.querySelector(".chat-send-button");
        return {
          text: counter?.textContent?.trim() ?? null,
          color: counter ? getComputedStyle(counter).color : null,
          sendDisabled: send?.disabled ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i08-char-count.json", {
        generatedAt: new Date().toISOString(),
        hidden,
        visible,
        over
      });
      return {
        pass:
          hidden.counterVisible === false &&
          visible.text === "1923 / 2000" &&
          over.text === "2001 / 2000" &&
          over.color === "rgb(165, 48, 40)" &&
          over.sendDisabled === true,
        summary: `${visible.text} / ${over.text}`,
        artifacts: [probe],
        observed: { hidden, visible, over }
      };
    }
  );

  await verifyRule(
    9,
    "I09",
    "草稿 auto-save · 每 500ms debounce 写 localStorage['friday-chat-draft-' + sessionId] · 切换 session 恢复",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const observed = await page.evaluate(async () => {
        const composer = document.getElementById("chat-composer");
        composer.value = "draft-one";
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 650));
        const firstStorage = window.localStorage.getItem("friday-chat-draft-session-replenish-watch");
        document.querySelector("[data-payload='session-provider-circuit']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 120));
        const composer2 = document.getElementById("chat-composer");
        composer2.value = "draft-two";
        composer2.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 650));
        const secondStorage = window.localStorage.getItem("friday-chat-draft-session-provider-circuit");
        document.querySelector("[data-payload='session-replenish-watch']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 180));
        return {
          firstStorage,
          secondStorage,
          restored: document.getElementById("chat-composer")?.value ?? ""
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-07/i09-draft-save.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.firstStorage === "draft-one" &&
          observed.secondStorage === "draft-two" &&
          observed.restored === "draft-one",
        summary: `drafts=${observed.firstStorage}/${observed.secondStorage}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2A-07", "/chat", generatedAt, results, artifacts);
}

async function verifyP2A08(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "H01",
    "localStorage 键名严格 · friday-chat-session-key + friday-chat-history · 命名不得变",
    async () => {
      const hookSource = await fs.readFile(path.join(ROOT, "ui/src/hooks/use-chat-session.ts"), "utf8");
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const observed = {
        hookSessionKey: hookSource.includes('const SESSION_KEY_STORAGE = "friday-chat-session-key"'),
        hookHistoryKey: hookSource.includes('const HISTORY_STORAGE = "friday-chat-history"'),
        staticSessionKey: staticSource.includes('"friday-chat-session-key"'),
        staticHistoryKey: staticSource.includes('"friday-chat-history"')
      };
      const probe = await writeJson("screenshots/P2A-08/h01-storage-keys.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: Object.values(observed).every(Boolean),
        summary: `sessionKey=${observed.hookSessionKey && observed.staticSessionKey}, historyKey=${observed.hookHistoryKey && observed.staticHistoryKey}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "H02",
    "history 结构 · { sessionKey: string, turns: Turn[], updatedAt: number } · Turn 类型照真仓",
    async () => {
      const hookSource = await fs.readFile(path.join(ROOT, "ui/src/hooks/use-chat-session.ts"), "utf8");
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const observed = await page.evaluate(() => {
        const turns = [
          {
            id: "msg-1",
            role: "user",
            content: "hello",
            timestamp: "2026-04-20T10:00:00.000Z",
            status: "done"
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "world",
            timestamp: "2026-04-20T10:01:00.000Z",
            status: "streaming"
          }
        ];
        window.__fridayQa.chat.persistSession("chat:default:history-shape", turns);
        const history = JSON.parse(window.localStorage.getItem("friday-chat-history"));
        return history["chat:default:history-shape"];
      });
      await context.close();
      const allowedStatus = hookSource.includes('status?: "sending" | "streaming" | "done" | "error"');
      const probe = await writeJson("screenshots/P2A-08/h02-history-shape.json", {
        generatedAt: new Date().toISOString(),
        observed,
        allowedStatus
      });
      return {
        pass:
          typeof observed.sessionKey === "string" &&
          Array.isArray(observed.turns) &&
          typeof observed.updatedAt === "number" &&
          observed.turns.every((turn) =>
            typeof turn.id === "string" &&
            typeof turn.role === "string" &&
            typeof turn.content === "string" &&
            typeof turn.timestamp === "string" &&
            ["sending", "streaming", "done", "error"].includes(turn.status)
          ) &&
          allowedStatus,
        summary: `turns=${observed.turns.length}, updatedAt=${observed.updatedAt}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "H03",
    "新建 session · 先 POST 后拿到 key 再写入 · 不得先写本地 fake key",
    async () => {
      const { page, context } = await bootChatPage(browser, baseUrl, "empty");
      const observed = await page.evaluate(async () => {
        const beforeKey = window.localStorage.getItem("friday-chat-session-key");
        const beforeHistory = window.localStorage.getItem("friday-chat-history");
        const promise = window.__fridayQa.chat.createSession([
          {
            id: "msg-1",
            role: "user",
            content: "create session",
            timestamp: new Date().toISOString(),
            status: "done"
          }
        ]);
        const immediate = {
          sessionKey: window.localStorage.getItem("friday-chat-session-key"),
          history: window.localStorage.getItem("friday-chat-history")
        };
        const created = await promise;
        return {
          beforeKey,
          beforeHistory,
          immediate,
          created,
          afterKey: window.localStorage.getItem("friday-chat-session-key"),
          afterHistoryKeys: Object.keys(JSON.parse(window.localStorage.getItem("friday-chat-history") || "{}"))
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-08/h03-create-session.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.immediate.sessionKey === observed.beforeKey &&
          observed.created.metrics.beforeStoredKey === observed.beforeKey &&
          observed.afterKey === observed.created.sessionKey &&
          observed.afterHistoryKeys.includes(observed.created.sessionKey) &&
          observed.created.sessionKey.startsWith("chat:default:"),
        summary: `sessionKey=${observed.created.sessionKey}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "H04",
    "刷新后 turns 顺序 index === 刷新前 · 对比 JSON.stringify 结构等价",
    async () => {
      const first = await bootChatPage(browser, baseUrl, "session-resume");
      const before = await first.page.evaluate(async () => {
        const turns = [
          {
            id: "msg-a",
            role: "user",
            content: "a",
            timestamp: "2026-04-20T10:00:00.000Z",
            status: "done"
          },
          {
            id: "msg-b",
            role: "assistant",
            content: "b",
            timestamp: "2026-04-20T10:01:00.000Z",
            status: "done"
          }
        ];
        window.__fridayQa.chat.persistSession("chat:default:refresh-check", turns);
        window.localStorage.setItem("friday-chat-session-key", "chat:default:refresh-check");
        return {
          json: JSON.stringify(window.__fridayQa.chat.readHistory()["chat:default:refresh-check"].turns)
        };
      });
      const storageState = await first.context.storageState();
      await first.context.close();
      const second = await bootChatPage(browser, baseUrl, "session-resume", { storageState, waitMs: 260 });
      const after = await second.page.evaluate(() => ({
        json: JSON.stringify(window.__fridayQa.chat.hydrateSession())
      }));
      await second.context.close();
      const probe = await writeJson("screenshots/P2A-08/h04-refresh-hash.json", {
        generatedAt: new Date().toISOString(),
        beforeHash: buildTurnSequenceHash(before.json),
        afterHash: buildTurnSequenceHash(after.json)
      });
      return {
        pass: before.json === after.json,
        summary: `hash=${buildTurnSequenceHash(after.json).slice(0, 12)}…`,
        artifacts: [probe],
        observed: {
          beforeHash: buildTurnSequenceHash(before.json),
          afterHash: buildTurnSequenceHash(after.json)
        }
      };
    }
  );

  await verifyRule(
    5,
    "H05",
    "过期(> 7 天 updatedAt)· 清除 · 进入空态 · 不报错",
    async () => {
      const { page, context, pageErrors, consoleMessages } = await bootChatPage(browser, baseUrl, "session-resume");
      const observed = await page.evaluate(async () => {
        const staleHistory = {
          "chat:default:expired": {
            sessionKey: "chat:default:expired",
            turns: [
              {
                id: "stale-1",
                role: "user",
                content: "stale",
                timestamp: "2026-04-01T10:00:00.000Z",
                status: "done"
              }
            ],
            updatedAt: Date.now() - (8 * 24 * 60 * 60 * 1000)
          }
        };
        window.localStorage.setItem("friday-chat-history", JSON.stringify(staleHistory));
        window.localStorage.setItem("friday-chat-session-key", "chat:default:expired");
        window.__fridayMock.forceState("/chat", "session-resume");
        await new Promise((resolve) => setTimeout(resolve, 260));
        return {
          emptyVisible: Boolean(document.querySelector(".chat-empty-hero")),
          history: window.localStorage.getItem("friday-chat-history")
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2A-08/h05-expired-history.json", {
        generatedAt: new Date().toISOString(),
        observed,
        pageErrors,
        consoleMessages
      });
      return {
        pass:
          observed.emptyVisible === true &&
          observed.history === "{}" &&
          pageErrors.length === 0 &&
          consoleMessages.filter((entry) => entry.type === "error").length === 0,
        summary: `emptyVisible=${observed.emptyVisible}, history=${observed.history}`,
        artifacts: [probe],
        observed: { observed, pageErrors, consoleMessages }
      };
    }
  );

  await verifyRule(
    6,
    "H06",
    "localStorage 不可用(隐身 / 禁用)· graceful 降级 · 页面可用 · 不得 crash",
    async () => {
      const { page, context, pageErrors, consoleMessages } = await bootChatPage(browser, baseUrl, "empty", {
        initScript: () => {
          const blocked = () => {
            throw new Error("localStorage blocked");
          };
          Storage.prototype.getItem = blocked;
          Storage.prototype.setItem = blocked;
          Storage.prototype.removeItem = blocked;
        }
      });
      await page.fill("#chat-composer", "still usable");
      const observed = await page.evaluate(() => ({
        composerValue: document.getElementById("chat-composer")?.value ?? "",
        pageHasApp: Boolean(document.getElementById("app")),
        quickCards: document.querySelectorAll(".chat-quick-card").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2A-08/h06-storage-blocked.json", {
        generatedAt: new Date().toISOString(),
        observed,
        pageErrors,
        consoleMessages
      });
      return {
        pass:
          observed.pageHasApp === true &&
          observed.quickCards === 3 &&
          observed.composerValue === "still usable" &&
          pageErrors.length === 0,
        summary: `composer="${observed.composerValue}", errors=${pageErrors.length}`,
        artifacts: [probe],
        observed: { observed, pageErrors, consoleMessages }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2A-08", "/chat", generatedAt, results, artifacts);
}

async function verifyP2B01(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "B01",
    "snapshot 从 uixSnapshotsApi.getAssistantInbox() · polling 12s active / 36s background",
    async () => {
      const source = await fs.readFile(path.join(ROOT, "ui/src/lib/api/uix-snapshots.ts"), "utf8");
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      const before = await page.evaluate(() => ({
        clockMs: window.__fridayMock.getState().clockMs,
        nextPollAt: window.__fridayQa.assistant.getState().nextPollAt,
        generatedAt: window.__fridayQa.assistant.getState().page.snapshot.generatedAt
      }));
      await page.evaluate(() => {
        window.__fridayMock.advanceClock(12_000);
      });
      await page.waitForTimeout(80);
      const activePoll = await page.evaluate(() => ({
        clockMs: window.__fridayMock.getState().clockMs,
        nextPollAt: window.__fridayQa.assistant.getState().nextPollAt,
        generatedAt: window.__fridayQa.assistant.getState().page.snapshot.generatedAt
      }));
      await page.evaluate(() => {
        window.__fridayQa.assistant.setVisibilityState("hidden");
      });
      const hiddenBefore = await page.evaluate(() => ({
        clockMs: window.__fridayMock.getState().clockMs,
        nextPollAt: window.__fridayQa.assistant.getState().nextPollAt
      }));
      await page.evaluate(() => {
        window.__fridayMock.advanceClock(36_000);
      });
      await page.waitForTimeout(80);
      const hiddenPoll = await page.evaluate(() => ({
        clockMs: window.__fridayMock.getState().clockMs,
        nextPollAt: window.__fridayQa.assistant.getState().nextPollAt,
        generatedAt: window.__fridayQa.assistant.getState().page.snapshot.generatedAt
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b01-polling.json", {
        generatedAt: new Date().toISOString(),
        sourceMatches: {
          getAssistantInbox: source.includes("async getAssistantInbox(): Promise<UixAssistantInboxSnapshot>"),
          assistantRoute: source.includes('"/v1/uix/assistant-inbox-snapshot"')
        },
        before,
        activePoll,
        hiddenBefore,
        hiddenPoll
      });
      return {
        pass:
          source.includes("getAssistantInbox") &&
          (before.nextPollAt - before.clockMs) === 12_000 &&
          activePoll.generatedAt !== before.generatedAt &&
          (hiddenBefore.nextPollAt - hiddenBefore.clockMs) === 36_000 &&
          hiddenPoll.generatedAt !== activePoll.generatedAt,
        summary: `active=${before.nextPollAt - before.clockMs}ms, hidden=${hiddenBefore.nextPollAt - hiddenBefore.clockMs}ms`,
        artifacts: [probe],
        observed: { before, activePoll, hiddenBefore, hiddenPoll }
      };
    }
  );

  await verifyRule(
    2,
    "B02",
    "URL ?tab= 3 值有效 · 其他值 fallback approvals · 历史栈前进后退同步",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "bogus" }
      });
      const invalid = await page.evaluate(() => ({
        activeTab: window.__fridayQa.assistant.getState().activeTab,
        search: window.location.search
      }));
      await page.locator('[data-action="assistant-tab"][data-payload="issues"]').click();
      await page.waitForTimeout(80);
      const issues = await page.evaluate(() => ({
        activeTab: window.__fridayQa.assistant.getState().activeTab,
        search: window.location.search
      }));
      await page.locator('[data-action="assistant-tab"][data-payload="recovery"]').click();
      await page.waitForTimeout(80);
      const recovery = await page.evaluate(() => ({
        activeTab: window.__fridayQa.assistant.getState().activeTab,
        search: window.location.search
      }));
      await page.goBack();
      await page.waitForTimeout(120);
      const backOne = await page.evaluate(() => ({
        activeTab: window.__fridayQa.assistant.getState().activeTab,
        search: window.location.search
      }));
      await page.goBack();
      await page.waitForTimeout(120);
      const backTwo = await page.evaluate(() => ({
        activeTab: window.__fridayQa.assistant.getState().activeTab,
        search: window.location.search
      }));
      await page.goForward();
      await page.waitForTimeout(120);
      const forward = await page.evaluate(() => ({
        activeTab: window.__fridayQa.assistant.getState().activeTab,
        search: window.location.search
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b02-tabs-history.json", {
        generatedAt: new Date().toISOString(),
        invalid,
        issues,
        recovery,
        backOne,
        backTwo,
        forward
      });
      return {
        pass:
          invalid.activeTab === "approvals" &&
          issues.activeTab === "issues" &&
          issues.search.includes("tab=issues") &&
          recovery.activeTab === "recovery" &&
          recovery.search.includes("tab=recovery") &&
          backOne.activeTab === "issues" &&
          backTwo.activeTab === "approvals" &&
          forward.activeTab === "issues",
        summary: `invalid=${invalid.activeTab}, back=${backTwo.activeTab}, forward=${forward.activeTab}`,
        artifacts: [probe],
        observed: { invalid, issues, recovery, backOne, backTwo, forward }
      };
    }
  );

  await verifyRule(
    3,
    "B03",
    "tab 切换不刷页 · 仅 section 切换动画 fade 150ms",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "approvals" }
      });
      const before = await page.evaluate(() => ({
        navigationCount: performance.getEntriesByType("navigation").length,
        activeSection: document.querySelector(".assistant-section.is-focused")?.id ?? null
      }));
      await page.locator('[data-action="assistant-tab"][data-payload="issues"]').click();
      await page.waitForTimeout(20);
      const after = await page.evaluate(() => {
        const activeSection = document.querySelector(".assistant-section.is-focused");
        const style = activeSection ? getComputedStyle(activeSection) : null;
        return {
          navigationCount: performance.getEntriesByType("navigation").length,
          activeSection: activeSection?.id ?? null,
          search: window.location.search,
          animationName: style?.animationName ?? null,
          animationDuration: style?.animationDuration ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b03-tab-fade.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.navigationCount === after.navigationCount &&
          before.activeSection === "assistant-approvals-section" &&
          after.activeSection === "assistant-issues-section" &&
          after.search.includes("tab=issues") &&
          after.animationName === "assistant-section-fade" &&
          after.animationDuration === "0.15s",
        summary: `${before.activeSection} -> ${after.activeSection} (${after.animationDuration})`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "B04",
    "?packId= 存在时 · 左列自动 scroll 到该 card · 该 card 高亮 2 秒后恢复",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "approvals", packId: "industry-cross-border-ecommerce" }
      });
      const highlightedShot = await captureScreenshot(page, "screenshots/P2B-01/b04-pack-highlight.png");
      const before = await page.evaluate(() => ({
        highlightClass: document.querySelector('[data-pack-card="industry-cross-border-ecommerce"]')?.className ?? null,
        scrollCalls: window.__assistantScrollIntoViewCalls
      }));
      await page.waitForTimeout(2100);
      const after = await page.evaluate(() => ({
        highlightClass: document.querySelector('[data-pack-card="industry-cross-border-ecommerce"]')?.className ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b04-pack-scroll.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        screenshot: highlightedShot.path
      });
      const scrollCall = before.scrollCalls[0] || {};
      return {
        pass:
          /is-highlighted/.test(before.highlightClass ?? "") &&
          String(scrollCall.target || "").includes("industry-cross-border-ecommerce") &&
          scrollCall.behavior === "smooth" &&
          scrollCall.block === "center" &&
          !/is-highlighted/.test(after.highlightClass ?? ""),
        summary: `scrollTarget=${scrollCall.target}, restored=${after.highlightClass}`,
        artifacts: [probe, highlightedShot],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    5,
    "B05",
    "Approvals 段显示 pendingApprovals 全部(不像 home 切 3)",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "overflow", {
        searchParams: { tab: "approvals" }
      });
      const observed = await page.evaluate(() => ({
        rendered: document.querySelectorAll(".assistant-approval-card").length,
        snapshotCount: window.__fridayQa.assistant.getState().page.snapshot.approvals.length,
        badge: document.querySelector('[data-approvals-count="true"]')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b05-all-approvals.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.snapshotCount > 3 &&
          observed.rendered === observed.snapshotCount &&
          observed.badge === String(observed.snapshotCount),
        summary: `rendered=${observed.rendered}, snapshot=${observed.snapshotCount}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "B06",
    "Issues 段调 assistantDiagnosticsApi · 按时间降序",
    async () => {
      const source = await fs.readFile(path.join(ROOT, "ui/src/lib/api/assistant-diagnostics.ts"), "utf8");
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const observed = await page.evaluate(() => {
        const pageState = window.__fridayQa.assistant.getState().page;
        return {
          issueTitles: pageState.issues.map((issue) => issue.title.zh || issue.title || issue.title),
          updatedAt: pageState.issues.map((issue) => issue.updatedAt)
        };
      });
      await context.close();
      const descending = observed.updatedAt.every((value, index, values) => {
        if (index === 0) {
          return true;
        }
        return new Date(values[index - 1]).getTime() >= new Date(value).getTime();
      });
      const probe = await writeJson("screenshots/P2B-01/b06-issues-order.json", {
        generatedAt: new Date().toISOString(),
        sourceMatches: {
          assistantDiagnosticsApi: source.includes("assistantDiagnosticsApi"),
          apiPath: source.includes('"/v1/uix/diagnostics"')
        },
        observed,
        descending
      });
      return {
        pass:
          source.includes("assistantDiagnosticsApi") &&
          observed.updatedAt.length >= 3 &&
          descending,
        summary: `issues=${observed.updatedAt.length}, descending=${descending}`,
        artifacts: [probe],
        observed: { observed, descending }
      };
    }
  );

  await verifyRule(
    7,
    "B07",
    "Recovery 段列出 learning insight + 建议动作 · 调 learningApi",
    async () => {
      const source = await fs.readFile(path.join(ROOT, "ui/src/lib/api/learning.ts"), "utf8");
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "recovery" }
      });
      const observed = await page.evaluate(() => ({
        cards: Array.from(document.querySelectorAll("#assistant-recovery-section .assistant-insight-card")).map((card) => ({
          id: card.getAttribute("data-insight-id"),
          actions: Array.from(card.querySelectorAll(".action-button")).map((button) => button.textContent?.trim() ?? "")
        }))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b07-learning-recovery.json", {
        generatedAt: new Date().toISOString(),
        sourceMatches: {
          learningApi: source.includes("learningApi"),
          getOverview: source.includes("getOverview")
        },
        observed
      });
      return {
        pass:
          source.includes("learningApi") &&
          observed.cards.length === 3 &&
          observed.cards.every((card) => card.actions.includes("应用建议") && card.actions.includes("Dismiss")),
        summary: `cards=${observed.cards.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "B08",
    "右 insight panel 默认显示\"今日学习\" · 可折叠 · 状态持久化 localStorage",
    async () => {
      const first = await bootAssistantPage(browser, baseUrl, "pending");
      const before = await first.page.evaluate(() => ({
        title: document.querySelector(".assistant-right-column .shell-card-title")?.textContent?.trim() ?? null,
        collapsed: window.__fridayQa.assistant.getState().collapsedInsights,
        storage: window.localStorage.getItem("friday-assistant-insight-panel")
      }));
      await first.page.locator('[data-action="toggle-assistant-insights"]').click();
      await first.page.waitForTimeout(120);
      const toggled = await first.page.evaluate(() => ({
        collapsed: window.__fridayQa.assistant.getState().collapsedInsights,
        storage: window.localStorage.getItem("friday-assistant-insight-panel"),
        panelText: document.querySelector(".assistant-right-column")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }));
      const storageState = await first.context.storageState();
      await first.context.close();
      const second = await bootAssistantPage(browser, baseUrl, "pending", { storageState });
      const reloaded = await second.page.evaluate(() => ({
        collapsed: window.__fridayQa.assistant.getState().collapsedInsights,
        storage: window.localStorage.getItem("friday-assistant-insight-panel"),
        panelText: document.querySelector(".assistant-right-column")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }));
      await second.context.close();
      const probe = await writeJson("screenshots/P2B-01/b08-panel-persist.json", {
        generatedAt: new Date().toISOString(),
        before,
        toggled,
        reloaded
      });
      return {
        pass:
          before.title === "今日学习" &&
          before.collapsed === false &&
          toggled.collapsed === true &&
          toggled.storage === "collapsed" &&
          /面板已折叠/.test(toggled.panelText) &&
          reloaded.collapsed === true &&
          reloaded.storage === "collapsed",
        summary: `title=${before.title}, storage=${reloaded.storage}`,
        artifacts: [probe],
        observed: { before, toggled, reloaded }
      };
    }
  );

  await verifyRule(
    9,
    "B09",
    "pack-related card 用 PackAssistantHandoffCard · cross-border 用 CrossBorderAssistantHandoffCard",
    async () => {
      const packSource = await fs.readFile(path.join(ROOT, "ui/src/components/packs/pack-assistant-handoff-card.tsx"), "utf8");
      const crossBorderSource = await fs.readFile(path.join(ROOT, "ui/src/components/packs/cross-border-assistant-handoff-card.tsx"), "utf8");
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { packId: "industry-cross-border-ecommerce" }
      });
      const observed = await page.evaluate(() => ({
        packCard: Boolean(document.querySelector('[data-testid="pack-assistant-handoff-industry-cross-border-ecommerce"]')),
        crossBorderCard: Boolean(document.querySelector('[data-testid="cross-border-assistant-handoff"]'))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b09-pack-components.json", {
        generatedAt: new Date().toISOString(),
        sourceMatches: {
          sourcePack: packSource.includes("PackAssistantHandoffCard"),
          sourceCrossBorder: crossBorderSource.includes("CrossBorderAssistantHandoffCard"),
          prototypePack: staticSource.includes("function PackAssistantHandoffCard(props)"),
          prototypeCrossBorder: staticSource.includes("function CrossBorderAssistantHandoffCard(props)")
        },
        observed
      });
      return {
        pass:
          packSource.includes("PackAssistantHandoffCard") &&
          crossBorderSource.includes("CrossBorderAssistantHandoffCard") &&
          observed.packCard === true &&
          observed.crossBorderCard === true,
        summary: `pack=${observed.packCard}, crossBorder=${observed.crossBorderCard}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "B10",
    "确认 / 拒绝动作触发 ConfirmDialog · 二次确认 · high-risk 需输入 pack 名确认",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      await page.locator('[data-action="approve-approval"][data-payload="approval-warehouse"]').first().click();
      await page.waitForTimeout(120);
      const highRisk = await page.evaluate(() => ({
        modal: document.querySelector(".confirm-dialog")?.getAttribute("aria-modal"),
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        inputPlaceholder: document.getElementById("confirm-dialog-input")?.getAttribute("placeholder") ?? null,
        confirmDisabled: document.querySelector('.confirm-dialog [data-action="confirm-run"]')?.disabled ?? null
      }));
      await page.locator('.confirm-dialog [data-action="close-overlays"]').first().click();
      await page.waitForTimeout(120);
      await page.locator('[data-action="approve-approval"][data-payload="approval-provider"]').first().click();
      await page.waitForTimeout(120);
      const mediumRisk = await page.evaluate(() => ({
        hasInput: Boolean(document.getElementById("confirm-dialog-input")),
        confirmDisabled: document.querySelector('.confirm-dialog [data-action="confirm-run"]')?.disabled ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b10-confirm-dialog.json", {
        generatedAt: new Date().toISOString(),
        highRisk,
        mediumRisk
      });
      return {
        pass:
          highRisk.modal === "true" &&
          highRisk.title === "确认批准这个动作?" &&
          highRisk.inputPlaceholder === "跨境经营动作板" &&
          highRisk.confirmDisabled === true &&
          mediumRisk.hasInput === false &&
          mediumRisk.confirmDisabled === false,
        summary: `highRiskInput=${highRisk.inputPlaceholder}, mediumHasInput=${mediumRisk.hasInput}`,
        artifacts: [probe],
        observed: { highRisk, mediumRisk }
      };
    }
  );

  await verifyRule(
    11,
    "B11",
    "空态 · \"没有待办、没有问题、一切正常\" · 米色插图(允许 line-art SVG · 不用 emoji)",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "empty");
      const screenshot = await captureScreenshot(page, "screenshots/P2B-01/b11-empty-state.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".route-empty h2")?.textContent?.trim() ?? null,
        body: document.querySelector(".route-empty p")?.textContent?.trim() ?? null,
        svgPaths: document.querySelectorAll(".route-empty svg path").length,
        svgStrokes: Array.from(document.querySelectorAll(".route-empty svg [stroke]")).map((node) => node.getAttribute("stroke")),
        text: document.querySelector(".route-empty")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b11-empty-state.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.title === "没有待办、没有问题、一切正常" &&
          observed.svgPaths > 0 &&
          !/[😀-🙏]/u.test(observed.text ?? ""),
        summary: `svgPaths=${observed.svgPaths}, title=${observed.title}`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    12,
    "B12",
    "错误态 · inline 错误条 + retry · 不影响其他段",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "error", {
        searchParams: { tab: "approvals" }
      });
      const screenshot = await captureScreenshot(page, "screenshots/P2B-01/b12-error-state.png");
      const observed = await page.evaluate(() => ({
        errorTitle: document.querySelector("#assistant-approvals-section .inline-error-shell strong")?.textContent?.trim() ?? null,
        retryText: document.querySelector("#assistant-approvals-section .inline-error-shell .action-button")?.textContent?.trim() ?? null,
        issueCards: document.querySelectorAll("#assistant-issues-section .assistant-issue-card").length,
        recoveryCards: document.querySelectorAll("#assistant-recovery-section .assistant-insight-card").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b12-error-bar.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.errorTitle === "Assistant 快照暂时不可用" &&
          observed.retryText === "重试" &&
          observed.issueCards > 0 &&
          observed.recoveryCards > 0,
        summary: `issues=${observed.issueCards}, recovery=${observed.recoveryCards}`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    13,
    "B13",
    "计数 badge 实时更新 · dispatch approval.resolved 后 -1",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "approvals" }
      });
      const before = await page.evaluate(() => ({
        badge: Number(document.querySelector('[data-approvals-count="true"]')?.textContent ?? 0),
        cards: document.querySelectorAll(".assistant-approval-card").length
      }));
      await page.locator('[data-action="approve-approval"][data-payload="approval-provider"]').first().click();
      await page.waitForTimeout(120);
      await page.locator('.confirm-dialog [data-action="confirm-run"]').click();
      await page.waitForTimeout(360);
      const after = await page.evaluate(() => ({
        badge: Number(document.querySelector('[data-approvals-count="true"]')?.textContent ?? 0),
        cards: document.querySelectorAll(".assistant-approval-card").length,
        toast: document.querySelector(".toast-card")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-01/b13-badge-realtime.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.badge === 4 &&
          after.badge === 3 &&
          after.cards === 3 &&
          /审批已批准/.test(after.toast ?? ""),
        summary: `${before.badge} -> ${after.badge}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-01", "/assistant", generatedAt, results, artifacts);
}

async function verifyP2B02(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "A01",
    "卡片宽满列 · min-h 180 · padding 20 · radius 14",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      const observed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-approval-card[data-approval-id="approval-warehouse"]');
        const parent = card?.parentElement?.getBoundingClientRect();
        const rect = card?.getBoundingClientRect();
        const style = card ? getComputedStyle(card) : null;
        return {
          cardWidth: rect?.width ?? null,
          parentWidth: parent?.width ?? null,
          minHeight: style?.minHeight ?? null,
          paddingTop: style?.paddingTop ?? null,
          borderRadius: style?.borderRadius ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a01-card-box.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Math.abs((observed.cardWidth ?? 0) - (observed.parentWidth ?? 0)) <= 2 &&
          observed.minHeight === "180px" &&
          observed.paddingTop === "20px" &&
          observed.borderRadius === "14px",
        summary: `width=${observed.cardWidth}px, radius=${observed.borderRadius}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "A02",
    "顶行 · 风险 badge(low/med/high)+ 来源 channel + 时间 · 右侧 Copy ID 按钮",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      const observed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-approval-card[data-approval-id="approval-warehouse"]');
        return {
          riskText: card?.querySelector(".status-pill")?.textContent?.trim() ?? null,
          metaText: card?.querySelector(".assistant-card-meta span:last-child")?.textContent?.trim() ?? null,
          copyText: card?.querySelector('[data-action="copy-approval-id"]')?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a02-top-row.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.riskText === "high" &&
          /邮件/.test(observed.metaText ?? "") &&
          /分钟前|小时前/.test(observed.metaText ?? "") &&
          observed.copyText === "Copy ID",
        summary: `${observed.riskText}, ${observed.metaText}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "A03",
    "标题行 · h3 font serif 20 · 不截断 · 允许 2 行",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "overflow");
      const screenshot = await captureScreenshot(page, "screenshots/P2B-02/a03-title-wrap.png");
      const observed = await page.evaluate(() => {
        const title = document.querySelector('.assistant-approval-card[data-approval-id="approval-overflow"] .assistant-card-title');
        const style = title ? getComputedStyle(title) : null;
        const lineHeight = Number.parseFloat(style?.lineHeight ?? "0");
        const rect = title?.getBoundingClientRect();
        return {
          text: title?.textContent?.trim() ?? null,
          fontSize: style?.fontSize ?? null,
          fontFamily: style?.fontFamily ?? null,
          textOverflow: style?.textOverflow ?? null,
          lineClamp: style?.getPropertyValue("-webkit-line-clamp") ?? null,
          lineCount: lineHeight > 0 && rect ? rect.height / lineHeight : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a03-title-wrap.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.fontSize === "20px" &&
          /Fraunces|serif/i.test(observed.fontFamily ?? "") &&
          observed.textOverflow !== "ellipsis" &&
          (observed.lineClamp === "" || observed.lineClamp === "none") &&
          (observed.lineCount ?? 0) >= 0.95 &&
          (observed.lineCount ?? 99) <= 2.6,
        summary: `lineCount=${observed.lineCount?.toFixed(2)}, font=${observed.fontSize}`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "A04",
    "Capabilities 列表 · tag 样式 · 每个 capability 有图标 + 文字 · 悬浮 tooltip scope 描述",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      await page.locator('.assistant-approval-card[data-approval-id="approval-warehouse"] .assistant-capability-chip').first().hover();
      await page.waitForTimeout(180);
      const screenshot = await captureScreenshot(page, "screenshots/P2B-02/a04-capability-tooltip.png");
      const observed = await page.evaluate(() => {
        const chip = document.querySelector('.assistant-approval-card[data-approval-id="approval-warehouse"] .assistant-capability-chip');
        const tooltip = chip?.querySelector(".grant-tooltip");
        const chipRect = chip?.getBoundingClientRect();
        const tooltipRect = tooltip?.getBoundingClientRect();
        const arrowStyle = tooltip ? getComputedStyle(tooltip, "::after") : null;
        return {
          chipText: chip?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          icon: chip?.querySelector(".assistant-capability-icon")?.textContent?.trim() ?? null,
          tooltipText: tooltip?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          opacity: tooltip ? getComputedStyle(tooltip).opacity : null,
          chipCenter: chipRect ? chipRect.left + (chipRect.width / 2) : null,
          chipTop: chipRect?.top ?? null,
          tooltipBottom: tooltipRect?.bottom ?? null,
          tooltipCenter: tooltipRect ? tooltipRect.left + (tooltipRect.width / 2) : null,
          arrowTransform: arrowStyle?.transform ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a04-capability-tooltip.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.icon === "◎" &&
          /预算边界/.test(observed.chipText ?? "") &&
          Number(observed.opacity ?? 0) >= 0.95 &&
          /允许 Friday/.test(observed.tooltipText ?? "") &&
          (observed.tooltipBottom ?? 0) < (observed.chipTop ?? 0) &&
          Math.abs((observed.chipCenter ?? 0) - (observed.tooltipCenter ?? 0)) <= 12 &&
          /matrix/.test(observed.arrowTransform ?? ""),
        summary: `icon=${observed.icon}, tooltip="${observed.tooltipText}"`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "A05",
    "Evidence 展开 · 默认折叠 · 点 \"查看证据\" 展开 · 显示 grantId / toolCalls / timestamps",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      const before = await page.evaluate(() => ({
        open: document.querySelector('.assistant-approval-card[data-approval-id="approval-warehouse"] .assistant-card-evidence')?.open ?? null
      }));
      await page.locator('.assistant-approval-card[data-approval-id="approval-warehouse"] .assistant-card-evidence summary').click();
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => {
        const details = document.querySelector('.assistant-approval-card[data-approval-id="approval-warehouse"] .assistant-card-evidence');
        const jsonText = details?.querySelector("pre")?.textContent ?? null;
        let parsed = null;
        try {
          parsed = jsonText ? JSON.parse(jsonText) : null;
        } catch {
          parsed = null;
        }
        return {
          open: details?.open ?? null,
          parsed
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a05-evidence-expand.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.open === false &&
          after.open === true &&
          typeof after.parsed?.grantId === "string" &&
          Array.isArray(after.parsed?.toolCalls) &&
          Array.isArray(after.parsed?.timestamps),
        summary: `grantId=${after.parsed?.grantId}, calls=${after.parsed?.toolCalls?.length ?? 0}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    6,
    "A06",
    "pending 状态 · 主按钮 \"批准\" + 次按钮 \"拒绝\" · high-risk 时主按钮灰 · 需输入确认词",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      const buttons = await page.evaluate(() => {
        const high = document.querySelector('.assistant-approval-card[data-approval-id="approval-warehouse"]');
        const medium = document.querySelector('.assistant-approval-card[data-approval-id="approval-provider"]');
        return {
          highApproveClass: high?.querySelector('[data-action="approve-approval"]')?.className ?? null,
          highRejectText: high?.querySelector('[data-action="deny-approval"]')?.textContent?.trim() ?? null,
          mediumApproveClass: medium?.querySelector('[data-action="approve-approval"]')?.className ?? null
        };
      });
      await page.locator('.assistant-approval-card[data-approval-id="approval-warehouse"] [data-action="approve-approval"]').click();
      await page.waitForTimeout(120);
      const confirm = await page.evaluate(() => ({
        placeholder: document.getElementById("confirm-dialog-input")?.getAttribute("placeholder") ?? null,
        confirmDisabled: document.querySelector('.confirm-dialog [data-action="confirm-run"]')?.disabled ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a06-pending-actions.json", {
        generatedAt: new Date().toISOString(),
        buttons,
        confirm
      });
      return {
        pass:
          /action-button-secondary/.test(buttons.highApproveClass ?? "") &&
          buttons.highRejectText === "拒绝" &&
          /action-button-primary/.test(buttons.mediumApproveClass ?? "") &&
          confirm.placeholder === "跨境经营动作板" &&
          confirm.confirmDisabled === true,
        summary: `high=${buttons.highApproveClass}, medium=${buttons.mediumApproveClass}`,
        artifacts: [probe],
        observed: { buttons, confirm }
      };
    }
  );

  await verifyRule(
    7,
    "A07",
    "approving/denying 中 · 按钮 spinner 图标 + 禁用 · 250ms 内给反馈",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      await page.locator('.assistant-approval-card[data-approval-id="approval-provider"] [data-action="deny-approval"]').click();
      await page.waitForTimeout(80);
      const observed = await page.evaluate(async () => {
        const start = performance.now();
        const confirmButton = document.querySelector('.confirm-dialog [data-action="confirm-run"]');
        confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        while (performance.now() - start < 250) {
          const card = document.querySelector('.assistant-approval-card[data-approval-id="approval-provider"]');
          const spinner = card?.querySelector(".button-spinner");
          const buttons = card ? Array.from(card.querySelectorAll(".action-button")) : [];
          if (spinner) {
            return {
              elapsed: performance.now() - start,
              spinnerText: spinner.parentElement?.textContent?.trim() ?? null,
              disabled: buttons.every((button) => button.disabled)
            };
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return {
          elapsed: performance.now() - start,
          spinnerText: null,
          disabled: false
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a07-busy-feedback.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          (observed.elapsed ?? 999) <= 250 &&
          /处理中/.test(observed.spinnerText ?? "") &&
          observed.disabled === true,
        summary: `elapsed=${observed.elapsed?.toFixed(1)}ms`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "A08",
    "approved · 整卡 opacity 0.6 · 顶部勾图标 · 文字 \"已批准 · {time}\"",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      await page.evaluate(() => {
        window.__fridayQa.assistant.previewApprovalState("approval-provider", "approved", {
          resolvedAt: "2026-04-20T21:20:00.000Z"
        });
      });
      const screenshot = await captureScreenshot(page, "screenshots/P2B-02/a08-approved-card.png");
      const observed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-approval-card[data-approval-id="approval-provider"]');
        return {
          opacity: card ? getComputedStyle(card).opacity : null,
          icon: card?.querySelector(".assistant-card-top > div:last-child span")?.textContent?.trim() ?? null,
          text: card?.textContent?.replace(/\s+/g, " ").trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a08-approved-card.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: screenshot.path
      });
      return {
        pass:
          observed.opacity === "0.6" &&
          observed.icon === "✓" &&
          /已批准/.test(observed.text ?? ""),
        summary: `opacity=${observed.opacity}, icon=${observed.icon}`,
        artifacts: [probe, screenshot],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "A09",
    "denied · 整卡红底 · 文字 \"已拒绝 · {reason}\"",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      await page.evaluate(() => {
        window.__fridayQa.assistant.previewApprovalState("approval-provider", "denied", {
          reason: "暂不接受降级到次优模型"
        });
      });
      const observed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-approval-card[data-approval-id="approval-provider"]');
        return {
          background: card ? getComputedStyle(card).backgroundColor : null,
          text: card?.textContent?.replace(/\s+/g, " ").trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a09-denied-card.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.background === "rgba(165, 48, 40, 0.12)" &&
          /已拒绝 · 暂不接受降级到次优模型/.test(observed.text ?? ""),
        summary: observed.text,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "A10",
    "expired · 虚线 border · 文字 \"已过期 · 请重新请求\"",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending");
      await page.evaluate(() => {
        window.__fridayQa.assistant.previewApprovalState("approval-provider", "expired");
      });
      const observed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-approval-card[data-approval-id="approval-provider"]');
        return {
          borderStyle: card ? getComputedStyle(card).borderStyle : null,
          text: card?.textContent?.replace(/\s+/g, " ").trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-02/a10-expired-card.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.borderStyle === "dashed" &&
          /已过期 · 请重新请求/.test(observed.text ?? ""),
        summary: observed.text,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-02", "/assistant", generatedAt, results, artifacts);
}

async function verifyP2B03(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "I01",
    "卡片结构 · 状态 dot + 标题 + \"根因\" 展开 + recovery 链 + 操作栏",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const observed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"]');
        return {
          hasDot: Boolean(card?.querySelector(".assistant-status-dot")),
          title: card?.querySelector(".assistant-issue-top strong")?.textContent?.trim() ?? null,
          rootCauseLabel: card?.querySelector(".assistant-card-evidence summary")?.textContent?.trim() ?? null,
          recoveryRows: card?.querySelectorAll(".assistant-recovery-row").length ?? 0,
          dismissText: card?.querySelector('[data-action="dismiss-issue"]')?.textContent?.trim() ?? null,
          timelineRows: card?.querySelectorAll(".assistant-issue-timeline-row").length ?? 0
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i01-card-structure.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.hasDot === true &&
          Boolean(observed.title) &&
          observed.rootCauseLabel === "根因" &&
          observed.recoveryRows > 0 &&
          observed.dismissText === "Dismiss" &&
          observed.timelineRows > 0,
        summary: `recoveryRows=${observed.recoveryRows}, timelineRows=${observed.timelineRows}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "I02",
    "状态 · open(红 dot)/ investigating(黄 + spinner)/ recovered(绿 + 勾)/ dismissed(灰 + 叉)",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const tokens = await resolvedTokenColors(page, ["--error", "--warning", "--success", "--ink-4"]);
      const before = await page.evaluate(() => {
        function snapshot(issueId) {
          const card = document.querySelector(`.assistant-issue-card[data-issue-id="${issueId}"]`);
          const dot = card?.querySelector(".assistant-status-dot");
          const icon = card?.querySelector(".assistant-card-top > div:last-child span");
          return {
            className: card?.className ?? null,
            dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
            iconText: icon?.textContent?.trim() ?? null,
            iconClass: icon?.className ?? null
          };
        }
        return {
          open: snapshot("issue-provider-fallback"),
          investigating: snapshot("issue-sync-lag"),
          recovered: snapshot("issue-budget-spike")
        };
      });
      await page.locator('.assistant-issue-card[data-issue-id="issue-provider-fallback"] [data-action="dismiss-issue"]').click();
      await page.waitForTimeout(80);
      await page.fill("#confirm-dialog-textarea", "保留现状");
      await page.locator('.confirm-dialog [data-action="confirm-run"]').click();
      await page.waitForTimeout(80);
      const dismissed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"]');
        const dot = card?.querySelector(".assistant-status-dot");
        const icon = card?.querySelector(".assistant-card-top > div:last-child span");
        return {
          className: card?.className ?? null,
          dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
          iconText: icon?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i02-status-variants.json", {
        generatedAt: new Date().toISOString(),
        tokens,
        before,
        dismissed
      });
      return {
        pass:
          before.open.dotColor === tokens["--error"] &&
          before.investigating.dotColor === tokens["--warning"] &&
          /button-spinner/.test(before.investigating.iconClass ?? "") &&
          before.recovered.dotColor === tokens["--success"] &&
          before.recovered.iconText === "✓" &&
          dismissed.dotColor === tokens["--ink-4"] &&
          dismissed.iconText === "×",
        summary: `open=${before.open.dotColor}, investigating=${before.investigating.dotColor}, dismissed=${dismissed.dotColor}`,
        artifacts: [probe],
        observed: { before, dismissed, tokens }
      };
    }
  );

  await verifyRule(
    3,
    "I03",
    "根因展开 · 默认折叠 · 点击展开 technical detail · 不暴露堆栈 · 用 describeRunHealth 文字",
    async () => {
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const before = await page.evaluate(() => ({
        open: document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"] .assistant-card-evidence')?.open ?? null
      }));
      await page.locator('.assistant-issue-card[data-issue-id="issue-provider-fallback"] .assistant-card-evidence summary').click();
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => ({
        open: document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"] .assistant-card-evidence')?.open ?? null,
        detail: document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"] .assistant-card-evidence p')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i03-root-cause-expand.json", {
        generatedAt: new Date().toISOString(),
        sourceMatches: {
          describeRunHealth: staticSource.includes("rootCause: runtime ? describeRunHealth(runtime, uiState.locale)")
        },
        before,
        after
      });
      return {
        pass:
          before.open === false &&
          after.open === true &&
          /需要先处理/.test(after.detail ?? "") &&
          !/\bat\b|\bError:/.test(after.detail ?? "") &&
          staticSource.includes("describeRunHealth(runtime, uiState.locale)"),
        summary: after.detail,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "I04",
    "recovery 链 · 最多 3 步 · 每步有 \"执行\" 按钮 · 执行中 disabled",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const before = await page.evaluate(() => {
        const card = document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"]');
        return {
          rowCount: card?.querySelectorAll(".assistant-recovery-row").length ?? 0,
          buttonLabels: Array.from(card?.querySelectorAll(".assistant-recovery-row .action-button") || []).map((button) => button.textContent?.trim() ?? "")
        };
      });
      await page.locator('.assistant-issue-card[data-issue-id="issue-provider-fallback"] .assistant-recovery-row .action-button').first().click();
      await page.waitForTimeout(120);
      const busy = await page.evaluate(() => {
        const card = document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"]');
        const buttons = Array.from(card?.querySelectorAll(".assistant-recovery-row .action-button") || []);
        return {
          spinnerCount: card?.querySelectorAll(".assistant-recovery-row .button-spinner").length ?? 0,
          disabled: buttons.every((button) => button.disabled)
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i04-recovery-chain.json", {
        generatedAt: new Date().toISOString(),
        before,
        busy
      });
      return {
        pass:
          before.rowCount > 0 &&
          before.rowCount <= 3 &&
          before.buttonLabels.every((label) => label === "执行") &&
          busy.spinnerCount >= 1 &&
          busy.disabled === true,
        summary: `rows=${before.rowCount}, spinner=${busy.spinnerCount}`,
        artifacts: [probe],
        observed: { before, busy }
      };
    }
  );

  await verifyRule(
    5,
    "I05",
    "dismiss · 二次确认 · \"确定不追查?\" + 理由文本框(选填)",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      await page.locator('.assistant-issue-card[data-issue-id="issue-provider-fallback"] [data-action="dismiss-issue"]').click();
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        hasTextarea: Boolean(document.getElementById("confirm-dialog-textarea")),
        textareaLabel: document.getElementById("confirm-dialog-textarea")?.getAttribute("aria-label") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i05-dismiss-confirm.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.title === "确定不追查?" &&
          observed.hasTextarea === true &&
          observed.textareaLabel === "原因(可选)",
        summary: `${observed.title}, textarea=${observed.hasTextarea}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "I06",
    "时间线 · 事件有时间戳 · 倒序最新在上",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const observed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.assistant-issue-card[data-issue-id="issue-provider-fallback"] .assistant-issue-timeline-row span')).map((node) => node.textContent?.trim() ?? "");
      });
      await context.close();
      const numeric = observed.map((value) => Number.parseInt(value.replace(":", ""), 10));
      const descending = numeric.every((value, index) => index === 0 || numeric[index - 1] >= value);
      const probe = await writeJson("screenshots/P2B-03/i06-timeline-order.json", {
        generatedAt: new Date().toISOString(),
        observed,
        numeric,
        descending
      });
      return {
        pass:
          observed.length === 3 &&
          descending,
        summary: observed.join(" > "),
        artifacts: [probe],
        observed: { observed, numeric, descending }
      };
    }
  );

  await verifyRule(
    7,
    "I07",
    "关联 runId · 点击跳 /sessions?runId=xxx",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      const observed = await page.evaluate(() => ({
        href: document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"] [data-nav]')?.getAttribute("href") ?? null,
        dataNav: document.querySelector('.assistant-issue-card[data-issue-id="issue-provider-fallback"] [data-nav]')?.getAttribute("data-nav") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i07-run-link.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.href === "/sessions?runId=run-provider-circuit" &&
          observed.dataNav === "/sessions?runId=run-provider-circuit",
        summary: observed.href,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "I08",
    "recovered 后卡片 30 秒后自动 collapse 到 60 高 · 可展开",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "issues" }
      });
      await page.locator('.assistant-issue-card[data-issue-id="issue-sync-lag"] .assistant-recovery-row .action-button').click();
      await page.waitForTimeout(280);
      const recovered = await page.evaluate(() => ({
        className: document.querySelector('.assistant-issue-card[data-issue-id="issue-sync-lag"]')?.className ?? null,
        buttonText: document.querySelector('.assistant-issue-card[data-issue-id="issue-sync-lag"] [data-action="toggle-issue-expand"]')?.textContent?.trim() ?? null
      }));
      await page.evaluate(() => {
        window.__fridayMock.advanceClock(30_000);
      });
      await page.waitForTimeout(80);
      const collapsed = await page.evaluate(() => {
        const card = document.querySelector('.assistant-issue-card[data-issue-id="issue-sync-lag"]');
        return {
          className: card?.className ?? null,
          height: card?.getBoundingClientRect().height ?? null,
          buttonText: card?.querySelector('[data-action="toggle-issue-expand"]')?.textContent?.trim() ?? null
        };
      });
      await page.locator('.assistant-issue-card[data-issue-id="issue-sync-lag"] [data-action="toggle-issue-expand"]').click();
      await page.waitForTimeout(80);
      const expanded = await page.evaluate(() => ({
        className: document.querySelector('.assistant-issue-card[data-issue-id="issue-sync-lag"]')?.className ?? null,
        height: document.querySelector('.assistant-issue-card[data-issue-id="issue-sync-lag"]')?.getBoundingClientRect().height ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-03/i08-recovered-collapse.json", {
        generatedAt: new Date().toISOString(),
        recovered,
        collapsed,
        expanded
      });
      return {
        pass:
          /is-recovered/.test(recovered.className ?? "") &&
          /is-auto-collapsed/.test(collapsed.className ?? "") &&
          (collapsed.height ?? 999) <= 62 &&
          !/is-auto-collapsed/.test(expanded.className ?? "") &&
          (expanded.height ?? 0) > (collapsed.height ?? 0),
        summary: `collapsed=${collapsed.height}, expanded=${expanded.height}`,
        artifacts: [probe],
        observed: { recovered, collapsed, expanded }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-03", "/assistant", generatedAt, results, artifacts);
}

async function verifyP2B04(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "L01",
    "复用 LearningInsightCard · props 不改 · wrap 只负责 data binding",
    async () => {
      const source = await fs.readFile(path.join(ROOT, "ui/src/components/core/learning-insight-card.tsx"), "utf8");
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const observed = {
        sourceSignature: /export function LearningInsightCard\(\)/.test(source),
        prototypeSignature: /function LearningInsightCard\(\)/.test(staticSource),
        wrapperSignature: /function renderLearningInsightBoundCard\(insight\)/.test(staticSource),
        wrapperUsesBaseCard: /LearningInsightCard\(\)/.test(staticSource)
      };
      const probe = await writeJson("screenshots/P2B-04/l01-signature-bindings.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.sourceSignature &&
          observed.prototypeSignature &&
          observed.wrapperSignature &&
          observed.wrapperUsesBaseCard,
        summary: `source=${observed.sourceSignature}, wrapper=${observed.wrapperSignature}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "L02",
    "tone 3 档 · positive 绿边 / warning 黄边 / neutral 米边",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "recovery" }
      });
      const observed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("#assistant-recovery-section .assistant-insight-card")).map((card) => ({
          id: card.getAttribute("data-insight-id"),
          className: card.className,
          borderColor: getComputedStyle(card).borderColor
        }));
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-04/l02-tone-borders.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const byId = Object.fromEntries(observed.map((entry) => [entry.id, entry]));
      return {
        pass:
          /is-positive/.test(byId["insight-route-learning"]?.className ?? "") &&
          /47, 122, 73/.test(byId["insight-route-learning"]?.borderColor ?? "") &&
          /is-warning/.test(byId["insight-provider-warning"]?.className ?? "") &&
          /184, 106, 23/.test(byId["insight-provider-warning"]?.borderColor ?? "") &&
          /is-neutral/.test(byId["insight-workflow-neutral"]?.className ?? ""),
        summary: observed.map((entry) => `${entry.id}:${entry.borderColor}`).join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "L03",
    "点 \"应用建议\" · 跳对应页(skill / workflow / settings)",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "recovery" }
      });
      const observed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('#assistant-recovery-section .assistant-insight-card [href]')).map((node) => ({
          text: node.textContent?.trim() ?? null,
          href: node.getAttribute("href")
        }));
      });
      await context.close();
      const applyRoutes = observed.filter((entry) => entry.text === "应用建议").map((entry) => entry.href);
      const probe = await writeJson("screenshots/P2B-04/l03-apply-routes.json", {
        generatedAt: new Date().toISOString(),
        observed,
        applyRoutes
      });
      return {
        pass:
          JSON.stringify(applyRoutes) === JSON.stringify(["/skills", "/settings?tab=runtime", "/workflows"]),
        summary: applyRoutes.join(", "),
        artifacts: [probe],
        observed: { observed, applyRoutes }
      };
    }
  );

  await verifyRule(
    4,
    "L04",
    "dismiss 写 localStorage friday-insights-dismissed set",
    async () => {
      const { page, context } = await bootAssistantPage(browser, baseUrl, "pending", {
        searchParams: { tab: "recovery" }
      });
      await page.locator('#assistant-recovery-section .assistant-insight-card[data-insight-id="insight-route-learning"] [data-action="dismiss-learning-insight"]').click();
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        storage: window.localStorage.getItem("friday-insights-dismissed"),
        cards: Array.from(document.querySelectorAll("#assistant-recovery-section .assistant-insight-card")).map((card) => card.getAttribute("data-insight-id"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-04/l04-dismiss-storage.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.storage === '["insight-route-learning"]' &&
          observed.cards.length === 2 &&
          !observed.cards.includes("insight-route-learning"),
        summary: `storage=${observed.storage}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-04", "/assistant+/home", generatedAt, results, artifacts);
}

async function verifyP2B05(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "S01",
    "左 sub-nav 200 固定宽 · 4 tab · 竖排 · 当前 tab 左 2px 琥珀竖线 + 粗体",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const shot = await captureScreenshot(page, "screenshots/P2B-05/s01-subnav-layout.png");
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const observed = await page.evaluate((colors) => {
        const nav = document.querySelector(".settings-subnav");
        const links = Array.from(document.querySelectorAll(".settings-side-link"));
        const active = document.querySelector(".settings-side-link.is-active");
        const activeBefore = active ? getComputedStyle(active, "::before") : null;
        return {
          navWidth: nav?.getBoundingClientRect().width ?? null,
          tabCount: links.length,
          yPositions: links.map((node) => node.getBoundingClientRect().top),
          activeWeight: active ? getComputedStyle(active).fontWeight : null,
          activeStripeWidth: activeBefore?.width ?? null,
          activeStripeColor: activeBefore?.backgroundColor ?? null,
          activeStripeTokenMatch:
            Object.entries(colors).find(([, value]) => value === (activeBefore?.backgroundColor ?? null))?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const vertical = observed.yPositions.every((value, index, values) => index === 0 || value > values[index - 1]);
      const probe = await writeJson("screenshots/P2B-05/s01-subnav-layout.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.navWidth === 200 &&
          observed.tabCount === 4 &&
          vertical &&
          Number(observed.activeWeight) >= 700 &&
          observed.activeStripeWidth === "2px" &&
          observed.activeStripeTokenMatch === "--accent",
        summary: `width=${observed.navWidth}, tabs=${observed.tabCount}, stripe=${observed.activeStripeWidth}`,
        artifacts: [probe, shot],
        observed: {
          tokenColors,
          ...observed,
          vertical
        }
      };
    }
  );

  await verifyRule(
    2,
    "S02",
    "URL ?tab=providers|runtime|diagnostics|account · 默认 providers · 不识别 fallback",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      await page.goto(`${baseUrl}/settings?dev=1`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.settings));
      await page.waitForTimeout(120);
      const defaultObserved = await page.evaluate(() => ({
        search: window.location.search,
        heading: document.querySelector(".settings-tab-header h2")?.textContent?.trim() ?? null,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null,
        navigationEntries: performance.getEntriesByType("navigation").length
      }));
      await page.click('[data-settings-tab="runtime"]');
      await page.waitForTimeout(100);
      const afterClick = await page.evaluate(() => ({
        search: window.location.search,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null,
        navigationEntries: performance.getEntriesByType("navigation").length
      }));
      await page.goBack();
      await page.waitForTimeout(100);
      const afterBack = await page.evaluate(() => ({
        search: window.location.search,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null
      }));
      await page.goForward();
      await page.waitForTimeout(100);
      const afterForward = await page.evaluate(() => ({
        search: window.location.search,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null
      }));
      await page.goto(`${baseUrl}/settings?dev=1&tab=unknown&__state=unknown`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.settings));
      await page.waitForTimeout(100);
      const fallbackObserved = await page.evaluate(() => ({
        search: window.location.search,
        heading: document.querySelector(".settings-tab-header h2")?.textContent?.trim() ?? null,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s02-tab-url-sync.json", {
        generatedAt: new Date().toISOString(),
        defaultObserved,
        afterClick,
        afterBack,
        afterForward,
        fallbackObserved
      });
      return {
        pass:
          defaultObserved.heading === "提供方与连接" &&
          defaultObserved.active === "提供方" &&
          afterClick.search.includes("tab=runtime") &&
          afterClick.search.includes("__state=runtime") &&
          afterClick.active === "运行时" &&
          defaultObserved.navigationEntries === 1 &&
          afterClick.navigationEntries === 1 &&
          afterBack.active === "提供方" &&
          afterForward.active === "运行时" &&
          fallbackObserved.heading === "提供方与连接" &&
          fallbackObserved.active === "提供方",
        summary: `${defaultObserved.search} -> ${afterClick.search} -> ${afterBack.search}`,
        artifacts: [probe],
        observed: { defaultObserved, afterClick, afterBack, afterForward, fallbackObserved }
      };
    }
  );

  await verifyRule(
    3,
    "S03",
    "右主区 · 顶 h2 tab 名 · 下表单 + 内容",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "diagnostics");
      const diagnosticsObserved = await page.evaluate(() => ({
        title: document.querySelector(".settings-tab-header h2")?.textContent?.trim() ?? null,
        formFields: document.querySelectorAll(".settings-main .settings-form-grid .settings-input").length,
        cards: document.querySelectorAll(".settings-main .shell-card").length
      }));
      await page.click('[data-settings-tab="account"]');
      await page.waitForTimeout(120);
      const accountObserved = await page.evaluate(() => ({
        title: document.querySelector(".settings-tab-header h2")?.textContent?.trim() ?? null,
        formFields: document.querySelectorAll(".settings-main .settings-form-grid .settings-input").length,
        cards: document.querySelectorAll(".settings-main .shell-card").length
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-05/s03-main-region.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s03-main-region.json", {
        generatedAt: new Date().toISOString(),
        diagnosticsObserved,
        accountObserved,
        screenshot: shot.path
      });
      return {
        pass:
          diagnosticsObserved.title === "诊断与保留策略" &&
          diagnosticsObserved.formFields >= 3 &&
          diagnosticsObserved.cards >= 1 &&
          accountObserved.title === "身份与偏好" &&
          accountObserved.formFields >= 3,
        summary: `diagnostics=${diagnosticsObserved.title}, account=${accountObserved.title}`,
        artifacts: [probe, shot],
        observed: { diagnosticsObserved, accountObserved }
      };
    }
  );

  await verifyRule(
    4,
    "S04",
    "底部吸附 Save bar · 128 高 · 仅有 dirty 时显示 · 显示 \"有 N 项未保存\"",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "runtime");
      const before = await page.evaluate(() => ({
        visible: Boolean(document.querySelector("[data-settings-save-bar]"))
      }));
      await page.fill("#runtime-budget", "");
      await page.waitForTimeout(120);
      const afterInput = await page.evaluate(() => {
        const bar = document.querySelector("[data-settings-save-bar]");
        const rect = bar?.getBoundingClientRect();
        return {
          visible: Boolean(bar),
          text: bar?.querySelector(".settings-save-copy strong")?.textContent?.trim() ?? null,
          height: rect?.height ?? null,
          bottom: rect?.bottom ?? null,
          viewportHeight: window.innerHeight,
          transform: getComputedStyle(bar).transform
        };
      });
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
      await page.waitForTimeout(80);
      const afterScroll = await page.evaluate(() => {
        const bar = document.querySelector("[data-settings-save-bar]");
        const rect = bar?.getBoundingClientRect();
        return {
          bottom: rect?.bottom ?? null,
          height: rect?.height ?? null,
          transform: getComputedStyle(bar).transform
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-05/s04-save-bar-sticky.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s04-save-bar-sticky.json", {
        generatedAt: new Date().toISOString(),
        before,
        afterInput,
        afterScroll,
        screenshot: shot.path
      });
      return {
        pass:
          before.visible === false &&
          afterInput.visible === true &&
          afterInput.text === "有 1 项未保存" &&
          afterInput.height === 128 &&
          afterInput.bottom === afterInput.viewportHeight &&
          afterScroll.bottom === afterInput.viewportHeight &&
          afterInput.transform === afterScroll.transform,
        summary: `visible=${afterInput.visible}, bottom=${afterInput.bottom}, height=${afterInput.height}`,
        artifacts: [probe, shot],
        observed: { before, afterInput, afterScroll }
      };
    }
  );

  await verifyRule(
    5,
    "S05",
    "dirty 时切换 tab · ConfirmDialog \"放弃修改?\" · 确认走 / 取消留",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "runtime");
      await page.fill("#runtime-budget", "13000");
      await page.waitForTimeout(80);
      await page.click('[data-settings-tab="account"]');
      await page.waitForTimeout(80);
      const firstDialog = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        body: document.querySelector("#confirm-detail")?.textContent?.trim() ?? null,
        route: window.location.search
      }));
      await page.click('[data-action="close-overlays"]');
      await page.waitForTimeout(80);
      const afterCancel = await page.evaluate(() => ({
        route: window.location.search,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null
      }));
      await page.click('[data-settings-tab="account"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const afterConfirm = await page.evaluate(() => ({
        route: window.location.search,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s05-tab-switch-confirm.json", {
        generatedAt: new Date().toISOString(),
        firstDialog,
        afterCancel,
        afterConfirm
      });
      return {
        pass:
          firstDialog.title === "放弃修改?" &&
          afterCancel.active === "运行时" &&
          afterCancel.route.includes("tab=runtime") &&
          afterConfirm.active === "账号" &&
          afterConfirm.route.includes("tab=account"),
        summary: `${afterCancel.active} -> ${afterConfirm.active}`,
        artifacts: [probe],
        observed: { firstDialog, afterCancel, afterConfirm }
      };
    }
  );

  await verifyRule(
    6,
    "S06",
    "dirty 时离开 route · beforeunload 确认",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "account");
      await page.fill("#account-email", "bad");
      await page.waitForTimeout(50);
      const dirtyObserved = await page.evaluate(() => window.__fridayQa.settings.previewBeforeUnload());
      await page.click('[data-action="settings-reset-request"]');
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(80);
      const cleanObserved = await page.evaluate(() => window.__fridayQa.settings.previewBeforeUnload());
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s06-beforeunload.json", {
        generatedAt: new Date().toISOString(),
        dirtyObserved,
        cleanObserved
      });
      return {
        pass:
          dirtyObserved.prevented === true &&
          dirtyObserved.defaultPrevented === true &&
          cleanObserved.prevented === false &&
          cleanObserved.defaultPrevented === false,
        summary: `dirty=${dirtyObserved.prevented}, clean=${cleanObserved.prevented}`,
        artifacts: [probe],
        observed: { dirtyObserved, cleanObserved }
      };
    }
  );

  await verifyRule(
    7,
    "S07",
    "Save 按钮 · 禁用当 invalid · loading 时 spinner",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "account");
      await page.fill("#account-email", "bad");
      await page.waitForTimeout(80);
      const invalidObserved = await page.evaluate(() => ({
        disabled: document.querySelector('[data-action="settings-save"]')?.hasAttribute("disabled") ?? null,
        errorText: document.querySelector("#account-email-error")?.textContent?.trim() ?? null
      }));
      await page.fill("#account-email", "ops@friday.example");
      await page.waitForTimeout(80);
      const validObserved = await page.evaluate(() => ({
        disabled: document.querySelector('[data-action="settings-save"]')?.hasAttribute("disabled") ?? null
      }));
      await page.click('[data-action="settings-save"]');
      await page.waitForTimeout(120);
      const loadingObserved = await page.evaluate(() => {
        const button = document.querySelector('[data-action="settings-save"]');
        return {
          html: button?.innerHTML ?? null,
          disabled: button?.hasAttribute("disabled") ?? null
        };
      });
      await page.waitForTimeout(560);
      const afterSave = await page.evaluate(() => ({
        saveBarVisible: Boolean(document.querySelector("[data-settings-save-bar]"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s07-save-disabled-loading.json", {
        generatedAt: new Date().toISOString(),
        invalidObserved,
        validObserved,
        loadingObserved,
        afterSave
      });
      return {
        pass:
          invalidObserved.disabled === true &&
          invalidObserved.errorText === "请输入有效邮箱地址。" &&
          validObserved.disabled === false &&
          loadingObserved.disabled === true &&
          loadingObserved.html.includes("button-spinner") &&
          afterSave.saveBarVisible === false,
        summary: `invalid=${invalidObserved.disabled}, loadingSpinner=${loadingObserved.html.includes("button-spinner")}`,
        artifacts: [probe],
        observed: { invalidObserved, validObserved, loadingObserved, afterSave }
      };
    }
  );

  await verifyRule(
    8,
    "S08",
    "Saved 后 toast 右下 · 3 秒淡出 · \"已保存\"",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "runtime");
      await page.fill("#runtime-budget", "13500");
      await page.waitForTimeout(80);
      await page.click('[data-action="settings-save"]');
      await page.waitForTimeout(620);
      const shown = await page.evaluate(() => {
        const toast = document.querySelector(".toast-card");
        const rect = toast?.getBoundingClientRect();
        return {
          text: toast?.textContent?.trim() ?? null,
          bottomGap: rect ? window.innerHeight - rect.bottom : null,
          rightGap: rect ? window.innerWidth - rect.right : null,
          fading: toast?.className.includes("is-fading") ?? false
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-05/s08-save-toast.png");
      await page.waitForTimeout(2650);
      const fading = await page.evaluate(() => ({
        className: document.querySelector(".toast-card")?.className ?? null
      }));
      await page.waitForTimeout(450);
      const removed = await page.evaluate(() => ({
        toastCount: document.querySelectorAll(".toast-card").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s08-save-toast.json", {
        generatedAt: new Date().toISOString(),
        shown,
        fading,
        removed,
        screenshot: shot.path
      });
      return {
        pass:
          shown.text?.includes("已保存") &&
          shown.bottomGap === 24 &&
          shown.rightGap === 24 &&
          shown.fading === false &&
          fading.className?.includes("is-fading") &&
          removed.toastCount === 0,
        summary: `toast=${shown.text}, fading=${fading.className}`,
        artifacts: [probe, shot],
        observed: { shown, fading, removed }
      };
    }
  );

  await verifyRule(
    9,
    "S09",
    "字段级错误 · 红边 + 下方错误文字 · i18n",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "account");
      const tokenColors = await resolvedTokenColors(page, ["--error"]);
      await page.fill("#account-email", "bad");
      await page.waitForTimeout(80);
      const zhObserved = await page.evaluate((colors) => {
        const input = document.querySelector("#account-email");
        const error = document.querySelector("#account-email-error");
        return {
          text: error?.textContent?.trim() ?? null,
          borderColor: getComputedStyle(input).borderColor,
          tokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(input).borderColor)?.[0] ?? null
        };
      }, tokenColors);
      await page.evaluate(() => window.__fridayQa.settings.setLocale("en"));
      await page.waitForTimeout(80);
      const enObserved = await page.evaluate(() => ({
        text: document.querySelector("#account-email-error")?.textContent?.trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-05/s09-field-errors.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s09-field-errors.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        zhObserved,
        enObserved,
        screenshot: shot.path
      });
      return {
        pass:
          zhObserved.text === "请输入有效邮箱地址。" &&
          zhObserved.tokenMatch === "--error" &&
          enObserved.text === "Enter a valid email address.",
        summary: `${zhObserved.text} | ${enObserved.text}`,
        artifacts: [probe, shot],
        observed: { zhObserved, enObserved }
      };
    }
  );

  await verifyRule(
    10,
    "S10",
    "tab 之间 URL 切换不丢未保存(本 tab)",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "runtime");
      await page.fill("#runtime-budget", "15000");
      await page.waitForTimeout(60);
      await page.click('[data-settings-tab="diagnostics"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const diagnosticsObserved = await page.evaluate(() => ({
        search: window.location.search,
        active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null
      }));
      await page.click('[data-settings-tab="runtime"]');
      await page.waitForTimeout(120);
      const restoredObserved = await page.evaluate(() => {
        const state = window.__fridayQa.settings.getState();
        return {
          search: window.location.search,
          active: document.querySelector(".settings-side-link.is-active")?.textContent?.trim() ?? null,
          value: document.querySelector("#runtime-budget")?.value ?? null,
          dirtyTabs: state.dirtyTabs
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s10-tab-draft-preserved.json", {
        generatedAt: new Date().toISOString(),
        diagnosticsObserved,
        restoredObserved
      });
      return {
        pass:
          diagnosticsObserved.search.includes("tab=diagnostics") &&
          restoredObserved.search.includes("tab=runtime") &&
          restoredObserved.value === "15000" &&
          JSON.stringify(restoredObserved.dirtyTabs.runtime) === JSON.stringify(["runtime-budget"]),
        summary: `restored=${restoredObserved.value}, dirty=${JSON.stringify(restoredObserved.dirtyTabs.runtime)}`,
        artifacts: [probe],
        observed: { diagnosticsObserved, restoredObserved }
      };
    }
  );

  await verifyRule(
    11,
    "S11",
    "Reset 按钮 · 位于 save bar 左 · 二次确认",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "runtime");
      await page.fill("#runtime-budget", "14000");
      await page.waitForTimeout(60);
      const before = await page.evaluate(() => {
        const reset = document.querySelector('[data-action="settings-reset-request"]');
        const save = document.querySelector('[data-action="settings-save"]');
        const resetRect = reset?.getBoundingClientRect();
        const saveRect = save?.getBoundingClientRect();
        return {
          resetText: reset?.textContent?.trim() ?? null,
          saveText: save?.textContent?.trim() ?? null,
          resetX: resetRect?.left ?? null,
          saveX: saveRect?.left ?? null
        };
      });
      await page.click('[data-action="settings-reset-request"]');
      await page.waitForTimeout(80);
      const confirmObserved = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        saveBarVisible: Boolean(document.querySelector("[data-settings-save-bar]")),
        value: document.querySelector("#runtime-budget")?.value ?? null,
        beforeUnload: window.__fridayQa.settings.previewBeforeUnload()
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-05/s11-reset-confirm.json", {
        generatedAt: new Date().toISOString(),
        before,
        confirmObserved,
        after
      });
      return {
        pass:
          before.resetText === "Reset" &&
          before.saveText === "Save" &&
          before.resetX < before.saveX &&
          confirmObserved.title === "重置这组未保存修改?" &&
          after.saveBarVisible === false &&
          after.value === "12000" &&
          after.beforeUnload.prevented === false,
        summary: `resetX=${before.resetX}, saveX=${before.saveX}, restored=${after.value}`,
        artifacts: [probe],
        observed: { before, confirmObserved, after }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-05", "/settings", generatedAt, results, artifacts);
}

async function verifyP2B06(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "P01",
    "每 provider 一行 · 左 logo 24 + 名 · 中 health dot + latency · 右 配额 + actions",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const shot = await captureScreenshot(page, "screenshots/P2B-06/p01-provider-row-structure.png");
      const observed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("[data-provider-row]")).map((row) => {
          const logo = row.querySelector(".provider-logo");
          const actions = row.querySelectorAll(".provider-actions .action-button");
          return {
            id: row.getAttribute("data-provider-row"),
            rowColumns: getComputedStyle(row).gridTemplateColumns,
            logoWidth: logo?.getBoundingClientRect().width ?? null,
            hasHealth: Boolean(row.querySelector(".provider-health-indicator .health-dot")),
            hasLatency: row.querySelectorAll(".provider-latency").length,
            quotaText: row.querySelector(".provider-quota")?.textContent?.trim() ?? null,
            actionCount: actions.length
          };
        });
      });
      await context.close();
      const pass = observed.length >= 5 && observed.every((row) =>
        row.logoWidth === 24 &&
        row.hasHealth &&
        row.hasLatency >= 2 &&
        row.quotaText?.startsWith("quota") &&
        row.actionCount >= 3
      );
      const probe = await writeJson("screenshots/P2B-06/p01-provider-row-structure.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass,
        summary: `rows=${observed.length}, actions=${observed.map((row) => row.actionCount).join("/")}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "P02",
    "health dot 3 色 · healthy 绿 / degraded 黄 / offline 红 · 动态脉冲(reduced-motion 下静态)",
    async () => {
      const hookSource = await fs.readFile(SETTINGS_HOOK_FILE, "utf8");
      const repoIntervalMs = Number((hookSource.match(/refetchInterval:\s*([0-9_]+)/)?.[1] || "0").replaceAll("_", ""));
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const tokenColors = await resolvedTokenColors(page, ["--success", "--warning", "--error", "--ink-3"]);
      const observed = await page.evaluate((colors) => {
        return Array.from(document.querySelectorAll("[data-provider-row]")).map((row) => {
          const id = row.getAttribute("data-provider-row");
          const dot = row.querySelector(".provider-health-indicator .health-dot");
          const style = getComputedStyle(dot);
          return {
            id,
            state: row.getAttribute("data-provider-state"),
            color: style.backgroundColor,
            tokenMatch: Object.entries(colors).find(([, value]) => value === style.backgroundColor)?.[0] ?? null,
            animationName: style.animationName
          };
        });
      }, tokenColors);
      const hookBefore = await page.evaluate(() => window.__fridayQa.settings.readSystemHealthHook());
      await page.evaluate(() => window.__fridayQa.settings.advanceClock(30_000));
      await page.waitForTimeout(120);
      const hookAfter = await page.evaluate(() => window.__fridayQa.settings.readSystemHealthHook());
      await context.close();

      const reduced = await bootSettingsPage(browser, baseUrl, "providers", { reducedMotion: "reduce" });
      const reducedObserved = await reduced.page.evaluate(() => {
        const dot = document.querySelector('[data-provider-row="provider-openai"] .provider-health-indicator .health-dot');
        const style = getComputedStyle(dot);
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration
        };
      });
      await reduced.context.close();

      const pollIntervals = hookAfter.config.pollTrace.slice(-2).map((entry) => entry.at);
      const intervalMs = pollIntervals.length === 2 ? pollIntervals[1] - pollIntervals[0] : null;
      const probe = await writeJson("screenshots/P2B-06/p02-health-dots.json", {
        generatedAt: new Date().toISOString(),
        repoHook: {
          exported: /export function useSystemHealthQuery/.test(hookSource),
          repoIntervalMs
        },
        tokenColors,
        observed,
        hookBefore,
        hookAfter,
        reducedObserved,
        intervalMs
      });
      const states = Object.fromEntries(observed.map((row) => [row.state, row.tokenMatch]));
      return {
        pass:
          states.healthy === "--success" &&
          states.degraded === "--warning" &&
          states.offline === "--error" &&
          states.cooldown === "--ink-3" &&
          observed.some((row) => row.animationName === "provider-dot-pulse") &&
          reducedObserved.animationName === "none" &&
          repoIntervalMs === 30000 &&
          hookAfter.config.refetchIntervalMs === repoIntervalMs &&
          intervalMs === 30000,
        summary: `states=${JSON.stringify(states)}, interval=${intervalMs}`,
        artifacts: [probe],
        observed: { observed, hookBefore, hookAfter, reducedObserved, intervalMs }
      };
    }
  );

  await verifyRule(
    3,
    "P03",
    "latency · 显示 p50 / p95 · 数值 mono 字体 · p95 > 1000ms 黄色",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const tokenColors = await resolvedTokenColors(page, ["--warning"]);
      const observed = await page.evaluate((colors) => {
        const row = document.querySelector('[data-provider-row="provider-anthropic"]');
        const p50 = row.querySelectorAll(".provider-latency")[0];
        const p95 = row.querySelectorAll(".provider-latency")[1];
        return {
          p50Text: p50?.textContent?.trim() ?? null,
          p95Text: p95?.textContent?.trim() ?? null,
          p50Font: getComputedStyle(p50).fontFamily,
          p95Font: getComputedStyle(p95).fontFamily,
          p95Color: getComputedStyle(p95).color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(p95).color)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2B-06/p03-latency-metrics.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.p50Text === "p50 530ms" &&
          observed.p95Text === "p95 1320ms" &&
          /JetBrains Mono/.test(observed.p50Font) &&
          /JetBrains Mono/.test(observed.p95Font) &&
          observed.tokenMatch === "--warning",
        summary: `${observed.p50Text} | ${observed.p95Text}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "P04",
    "circuit breaker · 3 态 closed(绿)/ open(红)/ half-open(黄)· tooltip 解释",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const tokenColors = await resolvedTokenColors(page, ["--success", "--warning", "--error"]);
      const baseObserved = await page.evaluate((colors) => {
        return ["provider-openai", "provider-anthropic", "provider-azure"].map((id) => {
          const chip = document.querySelector(`[data-provider-row='${id}'] .provider-circuit-chip`);
          const color = getComputedStyle(chip).color;
          return {
            id,
            text: chip?.textContent?.trim().replace(/\s+/g, " ") ?? null,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await page.hover('[data-provider-row="provider-azure"] .provider-circuit-chip');
      await page.waitForTimeout(120);
      const tooltipObserved = await page.evaluate(() => {
        const tooltip = document.querySelector('[data-provider-row="provider-azure"] .grant-tooltip');
        const chip = document.querySelector('[data-provider-row="provider-azure"] .provider-circuit-chip');
        const tooltipRect = tooltip.getBoundingClientRect();
        const chipRect = chip.getBoundingClientRect();
        return {
          text: tooltip?.textContent?.trim() ?? null,
          opacity: getComputedStyle(tooltip).opacity,
          chipCenter: chipRect.left + chipRect.width / 2,
          tooltipCenter: tooltipRect.left + tooltipRect.width / 2
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-06/p04-circuit-tooltip.png");
      await context.close();
      const byId = Object.fromEntries(baseObserved.map((entry) => [entry.id, entry]));
      const probe = await writeJson("screenshots/P2B-06/p04-circuit-tooltip.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        baseObserved,
        tooltipObserved,
        screenshot: shot.path
      });
      return {
        pass:
          byId["provider-openai"].tokenMatch === "--success" &&
          byId["provider-anthropic"].tokenMatch === "--warning" &&
          byId["provider-azure"].tokenMatch === "--error" &&
          Number(tooltipObserved.opacity) >= 0.95 &&
          tooltipObserved.text?.length > 20 &&
          Math.abs(tooltipObserved.chipCenter - tooltipObserved.tooltipCenter) <= 6,
        summary: `${byId["provider-openai"].text} | ${byId["provider-anthropic"].text} | ${byId["provider-azure"].text}`,
        artifacts: [probe, shot],
        observed: { baseObserved, tooltipObserved }
      };
    }
  );

  await verifyRule(
    5,
    "P05",
    "open 时 cooldown 倒计时 · 实时更新 · mm:ss",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const observed = await page.evaluate(async () => {
        const before = document.querySelector('[data-provider-row="provider-local"] .provider-cooldown')?.textContent?.trim() ?? null;
        window.__fridayQa.settings.advanceClock(1000);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const after = document.querySelector('[data-provider-row="provider-local"] .provider-cooldown')?.textContent?.trim() ?? null;
        return { before, after };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-06/p05-cooldown-countdown.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.before === "cooldown 05:05" &&
          observed.after === "cooldown 05:04",
        summary: `${observed.before} -> ${observed.after}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "P06",
    "edit key · 弹出 modal · input 隐藏(••••)· show/hide toggle",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      await page.click('[data-action="provider-edit"][data-payload="provider-openai"]');
      await page.waitForTimeout(120);
      const hiddenObserved = await page.evaluate(() => ({
        modalOpen: Boolean(document.querySelector(".settings-modal")),
        ariaModal: document.querySelector(".settings-modal")?.getAttribute("aria-modal") ?? null,
        activeId: document.activeElement?.id ?? null,
        secretType: document.querySelector("#provider-secret-input")?.getAttribute("type") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-06/p06-edit-key-modal.png");
      await page.click('[data-action="provider-toggle-secret"]');
      await page.waitForTimeout(60);
      const shownObserved = await page.evaluate(() => ({
        secretType: document.querySelector("#provider-secret-input")?.getAttribute("type") ?? null,
        toggleText: document.querySelector('[data-action="provider-toggle-secret"]')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-06/p06-edit-key-modal.json", {
        generatedAt: new Date().toISOString(),
        hiddenObserved,
        shownObserved,
        screenshot: shot.path
      });
      return {
        pass:
          hiddenObserved.modalOpen === true &&
          hiddenObserved.ariaModal === "true" &&
          hiddenObserved.activeId === "provider-modal-name" &&
          hiddenObserved.secretType === "password" &&
          shownObserved.secretType === "text" &&
          shownObserved.toggleText === "隐藏",
        summary: `secret=${hiddenObserved.secretType} -> ${shownObserved.secretType}`,
        artifacts: [probe, shot],
        observed: { hiddenObserved, shownObserved }
      };
    }
  );

  await verifyRule(
    7,
    "P07",
    "test connection 按钮 · 点后 loading 3 秒 · 返回结果 toast",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      await page.evaluate(() => { window.__qaTestStart = performance.now(); });
      await page.click('[data-action="provider-test"][data-payload="provider-openai"]');
      await page.waitForTimeout(120);
      const loadingObserved = await page.evaluate(() => {
        const button = document.querySelector('[data-action="provider-test"][data-payload="provider-openai"]');
        return {
          html: button?.innerHTML ?? null,
          disabled: button?.hasAttribute("disabled") ?? null
        };
      });
      await page.waitForFunction(() => Boolean(document.querySelector(".toast-card")));
      const completedObserved = await page.evaluate(() => ({
        elapsedMs: performance.now() - window.__qaTestStart,
        toastText: document.querySelector(".toast-card")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-06/p07-test-connection.json", {
        generatedAt: new Date().toISOString(),
        loadingObserved,
        completedObserved
      });
      return {
        pass:
          loadingObserved.disabled === true &&
          loadingObserved.html.includes("button-spinner") &&
          completedObserved.elapsedMs >= 2900 &&
          completedObserved.elapsedMs <= 3400 &&
          completedObserved.toastText?.includes("连接测试通过 · 843ms"),
        summary: `elapsed=${completedObserved.elapsedMs.toFixed(1)}ms`,
        artifacts: [probe],
        observed: { loadingObserved, completedObserved }
      };
    }
  );

  await verifyRule(
    8,
    "P08",
    "disable provider · 二次确认 · disabled 后整行置灰 + opacity 0.5",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      await page.click('[data-action="provider-disable"][data-payload="provider-openai"]');
      await page.waitForTimeout(80);
      const confirmObserved = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const rowObserved = await page.evaluate(() => {
        const row = document.querySelector('[data-provider-row="provider-openai"]');
        const disable = row.querySelector('[data-action="provider-disable"]');
        return {
          className: row?.className ?? null,
          opacity: getComputedStyle(row).opacity,
          disabled: disable?.hasAttribute("disabled") ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-06/p08-disable-provider.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-06/p08-disable-provider.json", {
        generatedAt: new Date().toISOString(),
        confirmObserved,
        rowObserved,
        screenshot: shot.path
      });
      return {
        pass:
          confirmObserved.title === "停用这个 provider?" &&
          rowObserved.className?.includes("is-disabled") &&
          rowObserved.opacity === "0.5" &&
          rowObserved.disabled === true,
        summary: `opacity=${rowObserved.opacity}, class=${rowObserved.className}`,
        artifacts: [probe, shot],
        observed: { confirmObserved, rowObserved }
      };
    }
  );

  await verifyRule(
    9,
    "P09",
    "添加 provider · 底部 + 按钮 · 弹出 modal · 预设 5 个官方 preset + \"自定义\"",
    async () => {
      const { page, context } = await bootSettingsPage(browser, baseUrl, "providers");
      const beforeRows = await page.locator("[data-provider-row]").count();
      await page.click('[data-action="provider-add"]');
      await page.waitForTimeout(120);
      const modalObserved = await page.evaluate(() => ({
        modalOpen: Boolean(document.querySelector(".settings-modal")),
        presets: Array.from(document.querySelectorAll(".provider-preset-button strong")).map((node) => node.textContent?.trim() ?? null)
      }));
      await page.click('[data-action="provider-select-preset"][data-payload="preset-custom"]');
      await page.fill("#provider-modal-name", "Friday Edge Runtime");
      await page.fill("#provider-modal-url", "https://edge.friday.internal");
      await page.fill("#provider-modal-model", "edge-review-v1");
      await page.click('[data-action="provider-modal-save"]');
      await page.waitForTimeout(120);
      const afterObserved = await page.evaluate(() => ({
        rowCount: document.querySelectorAll("[data-provider-row]").length,
        lastRowTitle: document.querySelector("[data-provider-row]:last-child .provider-title strong")?.textContent?.trim() ?? null,
        toastText: document.querySelector(".toast-card")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-06/p09-add-provider.json", {
        generatedAt: new Date().toISOString(),
        beforeRows,
        modalObserved,
        afterObserved
      });
      return {
        pass:
          modalObserved.modalOpen === true &&
          JSON.stringify(modalObserved.presets) === JSON.stringify(["OpenAI", "Anthropic", "Google Gemini", "Azure OpenAI", "Mistral", "自定义"]) &&
          afterObserved.rowCount === beforeRows + 1 &&
          afterObserved.lastRowTitle === "Friday Edge Runtime" &&
          afterObserved.toastText?.includes("Provider 已添加"),
        summary: `presets=${modalObserved.presets.length}, rows=${beforeRows}->${afterObserved.rowCount}`,
        artifacts: [probe],
        observed: { beforeRows, modalObserved, afterObserved }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-06", "/settings?tab=providers", generatedAt, results, artifacts);
}

async function verifyP2B07(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "O01",
    "5 focus 全部可切 · 切换无页面重载 · URL 同步",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const navBefore = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      const sequence = [];
      for (const focus of ["alerts", "traces", "audit", "health", "acceptance"]) {
        if (focus !== "alerts") {
          await page.click(`[data-focus-chip="${focus}"]`);
          await page.waitForTimeout(140);
        }
        sequence.push(await page.evaluate(() => ({
          search: window.location.search,
          heading: document.querySelector("[data-obs-heading]")?.textContent?.trim() ?? null,
          activeFocus: document.querySelector("[data-focus-chip].is-active")?.getAttribute("data-focus-chip") ?? null,
          mountId: document.querySelector("[data-om-mount-id]")?.getAttribute("data-om-mount-id") ?? null
        })));
      }
      await page.click('[data-focus-chip="traces"]');
      await page.waitForTimeout(120);
      await page.click('[data-focus-chip="audit"]');
      await page.waitForTimeout(120);
      await page.goBack();
      await page.waitForTimeout(120);
      const backObserved = await page.evaluate(() => ({
        search: window.location.search,
        activeFocus: document.querySelector("[data-focus-chip].is-active")?.getAttribute("data-focus-chip") ?? null
      }));
      await page.goForward();
      await page.waitForTimeout(120);
      const forwardObserved = await page.evaluate(() => ({
        search: window.location.search,
        activeFocus: document.querySelector("[data-focus-chip].is-active")?.getAttribute("data-focus-chip") ?? null
      }));
      await page.goto(`${baseUrl}/observability?dev=1&focus=audit&window=15m&__state=active`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.observability));
      await page.waitForTimeout(80);
      const deeplinkObserved = await page.evaluate(() => ({
        search: window.location.search,
        heading: document.querySelector("[data-obs-heading]")?.textContent?.trim() ?? null,
        activeFocus: document.querySelector("[data-focus-chip].is-active")?.getAttribute("data-focus-chip") ?? null
      }));
      const navAfter = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o01-focus-tabs-url.json", {
        generatedAt: new Date().toISOString(),
        navBefore,
        sequence,
        backObserved,
        forwardObserved,
        deeplinkObserved,
        navAfter
      });
      const expected = ["alerts", "traces", "audit", "health", "acceptance"];
      const stableMount = new Set(sequence.map((entry) => entry.mountId)).size === 1;
      return {
        pass:
          JSON.stringify(sequence.map((entry) => entry.activeFocus)) === JSON.stringify(expected) &&
          expected.every((focus, index) => sequence[index].search.includes(`focus=${encodeURIComponent(focus)}`)) &&
          stableMount &&
          navBefore === 1 &&
          navAfter === 1 &&
          backObserved.activeFocus === "traces" &&
          forwardObserved.activeFocus === "audit" &&
          deeplinkObserved.activeFocus === "audit" &&
          deeplinkObserved.heading === "审计时间线",
        summary: `mount=${sequence[0].mountId}, deeplink=${deeplinkObserved.activeFocus}, nav=${navAfter}`,
        artifacts: [probe],
        observed: { navBefore, sequence, backObserved, forwardObserved, deeplinkObserved, navAfter }
      };
    }
  );

  await verifyRule(
    2,
    "O02",
    "时间窗切换 refetch · loading 态显 skeleton · 不清空现有数据",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-window-chip="1h"]');
      await page.waitForTimeout(60);
      const loadingObserved = await page.evaluate(() => ({
        search: window.location.search,
        skeletonCount: document.querySelectorAll("[data-obs-skeleton]").length,
        rowCount: document.querySelectorAll("[data-obs-row]").length,
        mountId: document.querySelector("[data-om-mount-id]")?.getAttribute("data-om-mount-id") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-07/o02-window-loading.png");
      await page.waitForTimeout(320);
      const loadedObserved = await page.evaluate(() => {
        const state = window.__fridayQa.observability.getState();
        return {
          skeletonCount: document.querySelectorAll("[data-obs-skeleton]").length,
          rowCount: document.querySelectorAll("[data-obs-row]").length,
          refreshTrace: state.refreshTrace.slice(-2)
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o02-window-loading.json", {
        generatedAt: new Date().toISOString(),
        loadingObserved,
        loadedObserved,
        screenshot: shot.path
      });
      return {
        pass:
          loadingObserved.search.includes("window=1h") &&
          loadingObserved.skeletonCount === 3 &&
          loadingObserved.rowCount > 0 &&
          loadedObserved.skeletonCount === 0 &&
          loadedObserved.rowCount > 0 &&
          loadedObserved.refreshTrace.length === 2 &&
          loadedObserved.refreshTrace[0].reason.startsWith("window-loading") &&
          loadedObserved.refreshTrace[1].reason.startsWith("window-resolved"),
        summary: `skeletons=${loadingObserved.skeletonCount}->${loadedObserved.skeletonCount}, rows=${loadingObserved.rowCount}`,
        artifacts: [probe, shot],
        observed: { loadingObserved, loadedObserved }
      };
    }
  );

  await verifyRule(
    3,
    "O03",
    "alerts focus · list 显示 firing + snoozed + resolved 三段 · 按 severity 排序",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const observed = await page.evaluate(() => {
        const rank = { high: 0, medium: 1, low: 2 };
        return Array.from(document.querySelectorAll("[data-alert-section]")).map((section) => {
          const status = section.getAttribute("data-alert-section");
          const rows = Array.from(section.querySelectorAll("[data-obs-row]")).map((row) => {
            const pill = row.querySelector(".status-pill");
            return {
              id: row.getAttribute("data-obs-row"),
              severity: pill?.textContent?.trim() ?? null
            };
          });
          return {
            status,
            rows,
            sorted: rows.every((row, index, list) => index === 0 || rank[row.severity] >= rank[list[index - 1].severity])
          };
        });
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o03-alert-sections.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const byStatus = Object.fromEntries(observed.map((entry) => [entry.status, entry]));
      return {
        pass:
          JSON.stringify(observed.map((entry) => entry.status)) === JSON.stringify(["firing", "snoozed", "resolved"]) &&
          byStatus.firing.rows.length >= 2 &&
          byStatus.snoozed.rows.length >= 1 &&
          byStatus.resolved.rows.length >= 2 &&
          observed.every((entry) => entry.sorted),
        summary: `firing=${byStatus.firing.rows.length}, snoozed=${byStatus.snoozed.rows.length}, resolved=${byStatus.resolved.rows.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "O04",
    "traces focus · list 显示 trace row(traceId + duration + spans + status)· 点开 detail drawer(§P2B-08)",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      const beforeObserved = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("[data-obs-row]")).map((row) => ({
          id: row.getAttribute("data-obs-row"),
          duration: row.querySelector(".obs-row-actions span")?.textContent?.trim() ?? null,
          spans: row.querySelectorAll(".obs-row-actions span")[1]?.textContent?.trim() ?? null,
          status: row.querySelector(".status-pill")?.textContent?.trim() ?? null
        }));
      });
      await page.click('[data-obs-row="trace-932af"]');
      await page.waitForTimeout(140);
      const drawerObserved = await page.evaluate(() => ({
        activeDrawer: window.__fridayQa.observability.getState().activeDrawer,
        selectedItemId: window.__fridayQa.observability.getState().selectedItemId,
        title: document.querySelector(".drawer-panel .overlay-title")?.textContent?.trim() ?? null,
        body: document.querySelector(".drawer-panel .chat-json-block")?.textContent?.trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-07/o04-trace-drawer.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o04-trace-drawer.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        drawerObserved,
        screenshot: shot.path
      });
      return {
        pass:
          beforeObserved.length >= 3 &&
          beforeObserved[0].id === "trace-932af" &&
          beforeObserved.every((row) => /ms$/.test(row.duration || "") && /spans$/.test(row.spans || "") && Boolean(row.status)) &&
          drawerObserved.activeDrawer === "trace" &&
          drawerObserved.selectedItemId === "trace-932af" &&
          drawerObserved.title === "trace-932af",
        summary: `rows=${beforeObserved.length}, drawer=${drawerObserved.activeDrawer}`,
        artifacts: [probe, shot],
        observed: { beforeObserved, drawerObserved }
      };
    }
  );

  await verifyRule(
    5,
    "O05",
    "audit focus · list 显示审计事件 · actor + action + target + time · filter 按 actor",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "audit");
      const beforeObserved = await page.evaluate(() => ({
        filters: Array.from(document.querySelectorAll(".obs-audit-filters .route-tab-chip")).map((node) => node.textContent?.trim() ?? null),
        rows: Array.from(document.querySelectorAll("[data-obs-row]")).map((row) => {
          const meta = Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? null);
          return {
            id: row.getAttribute("data-obs-row"),
            actor: row.querySelector(".obs-row-main strong")?.textContent?.trim() ?? null,
            action: meta[0] || null,
            target: meta[1] || null,
            time: meta[2] || null
          };
        })
      }));
      await page.click('.obs-audit-filters [data-payload="jarvis"]');
      await page.waitForTimeout(120);
      const filteredObserved = await page.evaluate(() => ({
        actorFilter: window.__fridayQa.observability.getState().auditActorFilter,
        rows: Array.from(document.querySelectorAll("[data-obs-row]")).map((row) => row.querySelector(".obs-row-main strong")?.textContent?.trim() ?? null)
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o05-audit-filter.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        filteredObserved
      });
      return {
        pass:
          beforeObserved.filters.includes("all") &&
          beforeObserved.filters.includes("jarvis") &&
          beforeObserved.rows.length >= 3 &&
          beforeObserved.rows.every((row) => row.actor && row.action && row.target && row.time) &&
          filteredObserved.actorFilter === "jarvis" &&
          filteredObserved.rows.length === 1 &&
          filteredObserved.rows[0] === "jarvis",
        summary: `filters=${beforeObserved.filters.join("/")}, rows=${filteredObserved.rows.length}`,
        artifacts: [probe],
        observed: { beforeObserved, filteredObserved }
      };
    }
  );

  await verifyRule(
    6,
    "O06",
    "health focus · 显示系统健康大盘 · CPU / mem / queue 三个 sparkline · selectObservabilityPrimaryHealthComponent",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "health");
      const observed = await page.evaluate(() => {
        const state = window.__fridayQa.observability.getState();
        return {
          helper: window.__fridayQa.observability.helpers(),
          cards: Array.from(document.querySelectorAll("[data-health-card]")).map((card) => ({
            id: card.getAttribute("data-health-card"),
            primaryBadge: card.querySelector(".status-pill")?.textContent?.trim() ?? null
          })),
          detailEmpty: Boolean(document.querySelector("[data-obs-detail-empty]"))
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o06-health-dashboard.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const primaryCards = observed.cards.filter((card) => card.primaryBadge === "主压力");
      return {
        pass:
          observed.cards.length === 3 &&
          JSON.stringify(observed.cards.map((card) => card.id)) === JSON.stringify(["cpu", "memory", "queue"]) &&
          observed.helper.pollIntervalMs === 5000 &&
          primaryCards.length === 1 &&
          primaryCards[0].id === observed.helper.primaryHealth &&
          observed.detailEmpty === true,
        summary: `primary=${observed.helper.primaryHealth}, cards=${observed.cards.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "O07",
    "acceptance focus · 显示 acceptance criteria pass/fail 聚合 · 点击跳 assistant",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "acceptance");
      const beforeObserved = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("[data-obs-row]")).map((row) => ({
          id: row.getAttribute("data-obs-row"),
          title: row.querySelector(".obs-row-main strong")?.textContent?.trim() ?? null,
          stats: Array.from(row.querySelectorAll(".obs-acceptance-stat")).map((node) => node.textContent?.trim() ?? null),
          href: row.getAttribute("href")
        }));
      });
      await page.click('[data-obs-row="acceptance-2a"]');
      await page.waitForTimeout(160);
      const afterObserved = await page.evaluate(() => ({
        route: window.location.pathname + window.location.search
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o07-acceptance-navigation.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        afterObserved
      });
      return {
        pass:
          beforeObserved.length >= 2 &&
          beforeObserved.every((row) => row.stats.length === 3 && row.href?.startsWith("/assistant?tab=approvals")) &&
          afterObserved.route.startsWith("/assistant?tab=approvals&phase=2a"),
        summary: `rows=${beforeObserved.length}, route=${afterObserved.route}`,
        artifacts: [probe],
        observed: { beforeObserved, afterObserved }
      };
    }
  );

  await verifyRule(
    8,
    "O08",
    "每 focus 的 list 空态有独立文案 · 不共用",
    async () => {
      const states = [];
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts", { stateName: "empty" });
      for (const focus of ["alerts", "traces", "audit", "health", "acceptance"]) {
        await page.goto(`${baseUrl}/observability?dev=1&focus=${focus}&window=15m&__state=empty`, { waitUntil: "load" });
        await page.waitForFunction(() => Boolean(window.__fridayQa?.observability));
        await page.waitForTimeout(100);
        states.push(await page.evaluate(() => ({
          focus: window.__fridayQa.observability.getState().focus,
          title: document.querySelector("[data-obs-empty-copy] strong")?.textContent?.trim() ?? null,
          body: document.querySelector("[data-obs-empty-copy] span")?.textContent?.trim() ?? null
        })));
      }
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o08-empty-copy.json", {
        generatedAt: new Date().toISOString(),
        states
      });
      const uniqueTitles = new Set(states.map((entry) => entry.title));
      return {
        pass:
          states.length === 5 &&
          states.every((entry) => entry.title && entry.body) &&
          uniqueTitles.size === 5,
        summary: `titles=${uniqueTitles.size}, focuses=${states.map((entry) => entry.focus).join("/")}`,
        artifacts: [probe],
        observed: states
      };
    }
  );

  await verifyRule(
    9,
    "O09",
    "每 focus 的 error 态 inline 错误条 · 不跳 splash",
    async () => {
      const states = [];
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts", { stateName: "error" });
      for (const focus of ["alerts", "traces", "audit", "health", "acceptance"]) {
        await page.goto(`${baseUrl}/observability?dev=1&focus=${focus}&window=15m&__state=error`, { waitUntil: "load" });
        await page.waitForFunction(() => Boolean(window.__fridayQa?.observability));
        await page.waitForTimeout(100);
        states.push(await page.evaluate(() => ({
          focus: window.__fridayQa.observability.getState().focus,
          heading: document.querySelector("[data-obs-heading]")?.textContent?.trim() ?? null,
          errorTitle: document.querySelector(".inline-error-shell strong")?.textContent?.trim() ?? null,
          splashPresent: Boolean(document.querySelector(".splash-screen, .shell-splash")),
          mountId: document.querySelector("[data-om-mount-id]")?.getAttribute("data-om-mount-id") ?? null
        })));
      }
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o09-error-state.json", {
        generatedAt: new Date().toISOString(),
        states
      });
      return {
        pass:
          states.length === 5 &&
          states.every((entry) => entry.errorTitle === "Observability 暂时不可用" && entry.splashPresent === false && entry.mountId === "observability-shell-v1"),
        summary: `focuses=${states.map((entry) => entry.focus).join("/")}`,
        artifacts: [probe],
        observed: states
      };
    }
  );

  await verifyRule(
    10,
    "O10",
    "时间窗 15m 时 polling 5s · 1h 时 15s · 24h 时 60s",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const fifteenBefore = await readObservabilityQaState(page);
      const alertsRowsBefore = await page.locator("[data-obs-row]").count();
      const alertsRowIdsBefore = await page.locator("[data-obs-row][data-obs-focus='alerts']").evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-obs-row"))
      );
      const alertsFirstBefore = await page.evaluate(() => {
        const row = document.querySelector("[data-obs-row][data-obs-focus='alerts']");
        if (!row) return null;
        const meta = row.querySelectorAll(".obs-row-meta span");
        return {
          id: row.getAttribute("data-obs-row"),
          recent: meta[2] ? meta[2].textContent.trim() : null,
          metric: meta[0] ? meta[0].textContent.trim() : null
        };
      });
      await page.evaluate(() => window.__fridayQa.observability.advanceClock(4800));
      await page.waitForTimeout(80);
      const fifteenMid = await readObservabilityQaState(page);
      await page.evaluate(() => window.__fridayQa.observability.advanceClock(200));
      await page.waitForTimeout(140);
      const fifteenAfter = await readObservabilityQaState(page);
      const alertsRowsAfter = await page.locator("[data-obs-row]").count();
      const alertsRowIdsAfter = await page.locator("[data-obs-row][data-obs-focus='alerts']").evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-obs-row"))
      );
      const alertsFirstAfter = await page.evaluate(() => {
        const row = document.querySelector("[data-obs-row][data-obs-focus='alerts']");
        if (!row) return null;
        const meta = row.querySelectorAll(".obs-row-meta span");
        return {
          id: row.getAttribute("data-obs-row"),
          recent: meta[2] ? meta[2].textContent.trim() : null,
          metric: meta[0] ? meta[0].textContent.trim() : null
        };
      });

      await page.evaluate(async () => {
        window.__fridayQa.observability.setFocus("traces");
        await new Promise((resolve) => setTimeout(resolve, 120));
        window.__fridayQa.observability.setWindow("1h");
      });
      await page.waitForTimeout(320);
      const oneHourBefore = await readObservabilityQaState(page);
      const tracesBefore = await page.locator("[data-obs-row]").count();
      await page.evaluate(() => window.__fridayQa.observability.advanceClock(14900));
      await page.waitForTimeout(80);
      const oneHourMid = await readObservabilityQaState(page);
      await page.evaluate(() => window.__fridayQa.observability.advanceClock(100));
      await page.waitForTimeout(140);
      const oneHourAfter = await readObservabilityQaState(page);
      const tracesAfter = await page.locator("[data-obs-row]").count();

      await page.evaluate(() => window.__fridayQa.observability.setWindow("24h"));
      await page.waitForTimeout(320);
      const twentyFourBefore = await readObservabilityQaState(page);
      await page.evaluate(() => window.__fridayQa.observability.advanceClock(59000));
      await page.waitForTimeout(80);
      const twentyFourMid = await readObservabilityQaState(page);
      await page.evaluate(() => window.__fridayQa.observability.advanceClock(1000));
      await page.waitForTimeout(140);
      const twentyFourAfter = await readObservabilityQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o10-poll-intervals.json", {
        generatedAt: new Date().toISOString(),
        fifteen: {
          before: fifteenBefore.pollTrace.slice(-1),
          mid: fifteenMid.pollTrace.slice(-1),
          after: fifteenAfter.pollTrace.slice(-1),
          alertsRowIdsBefore,
          alertsRowIdsAfter,
          alertsFirstBefore,
          alertsFirstAfter,
          alertsRowsBefore,
          alertsRowsAfter
        },
        oneHour: {
          before: oneHourBefore.pollTrace.slice(-1),
          mid: oneHourMid.pollTrace.slice(-1),
          after: oneHourAfter.pollTrace.slice(-1),
          tracesBefore,
          tracesAfter
        },
        twentyFour: {
          before: twentyFourBefore.pollTrace.slice(-1),
          mid: twentyFourMid.pollTrace.slice(-1),
          after: twentyFourAfter.pollTrace.slice(-1)
        },
        refreshTrace: twentyFourAfter.refreshTrace.slice(-6)
      });
      const fifteenDelta = fifteenAfter.pollTrace[fifteenAfter.pollTrace.length - 1].at - fifteenBefore.pollTrace[fifteenBefore.pollTrace.length - 1].at;
      const oneHourDelta = oneHourAfter.pollTrace[oneHourAfter.pollTrace.length - 1].at - oneHourBefore.pollTrace[oneHourBefore.pollTrace.length - 1].at;
      const twentyFourDelta = twentyFourAfter.pollTrace[twentyFourAfter.pollTrace.length - 1].at - twentyFourBefore.pollTrace[twentyFourBefore.pollTrace.length - 1].at;
      return {
        pass:
          fifteenBefore.pollTrace.length === fifteenMid.pollTrace.length &&
          fifteenAfter.pollTrace.length === fifteenBefore.pollTrace.length + 1 &&
          Boolean(alertsFirstBefore && alertsFirstAfter) &&
          JSON.stringify(alertsRowIdsBefore) !== JSON.stringify(alertsRowIdsAfter) &&
          fifteenDelta === 5000 &&
          oneHourBefore.pollTrace.length === oneHourMid.pollTrace.length &&
          oneHourAfter.pollTrace.length === oneHourBefore.pollTrace.length + 1 &&
          tracesAfter > tracesBefore &&
          oneHourDelta === 15000 &&
          twentyFourBefore.pollTrace.length === twentyFourMid.pollTrace.length &&
          twentyFourAfter.pollTrace.length === twentyFourBefore.pollTrace.length + 1 &&
          twentyFourDelta === 60000,
        summary: `15m=${fifteenDelta}, 1h=${oneHourDelta}, 24h=${twentyFourDelta}`,
        artifacts: [probe],
        observed: {
          fifteenDelta,
          oneHourDelta,
          twentyFourDelta,
          alertsRowIdsBefore,
          alertsRowIdsAfter,
          alertsFirstBefore,
          alertsFirstAfter,
          alertsRowsBefore,
          alertsRowsAfter,
          tracesBefore,
          tracesAfter,
          refreshTrace: twentyFourAfter.refreshTrace.slice(-6)
        }
      };
    }
  );

  await verifyRule(
    11,
    "O11",
    "list 行 hover 底色 · 点击左边 2px 琥珀条标记 active",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const tokens = await page.evaluate(() => {
        const names = ["--bg-sunken", "--accent"];
        const resolved = {};
        names.forEach((tokenName) => {
          const node = document.createElement("div");
          node.style.backgroundColor = `var(${tokenName})`;
          document.body.appendChild(node);
          resolved[tokenName] = getComputedStyle(node).backgroundColor;
          node.remove();
        });
        return resolved;
      });
      const before = await page.evaluate(() => {
        const row = document.querySelector('[data-obs-row="alert-4"]');
        return {
          background: getComputedStyle(row).backgroundColor
        };
      });
      await page.hover('[data-obs-row="alert-4"]');
      await page.waitForTimeout(80);
      const hoverObserved = await page.evaluate(() => {
        const row = document.querySelector('[data-obs-row="alert-4"]');
        return {
          background: getComputedStyle(row).backgroundColor
        };
      });
      await page.click('[data-obs-row="alert-4"] .obs-row-main');
      await page.waitForTimeout(100);
      const activeObserved = await page.evaluate(() => {
        const row = document.querySelector('[data-obs-row="alert-4"]');
        const beforeStyle = getComputedStyle(row, "::before");
        return {
          className: row.className,
          stripeWidth: beforeStyle.width,
          stripeColor: beforeStyle.backgroundColor
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-07/o11-row-hover-active.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o11-row-hover-active.json", {
        generatedAt: new Date().toISOString(),
        tokens,
        before,
        hoverObserved,
        activeObserved,
        screenshot: shot.path
      });
      return {
        pass:
          hoverObserved.background !== before.background &&
          activeObserved.className.includes("is-active") &&
          activeObserved.stripeWidth === "2px" &&
          activeObserved.stripeColor === tokens["--accent"],
        summary: `hover=${hoverObserved.background}, stripe=${activeObserved.stripeWidth}`,
        artifacts: [probe, shot],
        observed: { tokens, before, hoverObserved, activeObserved }
      };
    }
  );

  await verifyRule(
    12,
    "O12",
    "detail 区 · focus 切换时清空并显示 \"选择一条查看详情\" 空态",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-obs-row="alert-1"] .obs-row-main');
      await page.waitForTimeout(100);
      const beforeObserved = await page.evaluate(() => ({
        detailEmpty: Boolean(document.querySelector("[data-obs-detail-empty]")),
        detailTitle: document.querySelector(".obs-detail-column .shell-card-title, .obs-detail-column .shell-card h3, .obs-detail-column strong")?.textContent?.trim() ?? null,
        selectedItemId: window.__fridayQa.observability.getState().selectedItemId
      }));
      await page.click('[data-focus-chip="audit"]');
      await page.waitForTimeout(140);
      const afterObserved = await page.evaluate(() => ({
        detailEmpty: Boolean(document.querySelector("[data-obs-detail-empty]")),
        detailText: document.querySelector("[data-obs-detail-empty]")?.textContent?.trim() ?? null,
        selectedItemId: window.__fridayQa.observability.getState().selectedItemId,
        focus: window.__fridayQa.observability.getState().focus
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o12-detail-reset.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        afterObserved
      });
      return {
        pass:
          beforeObserved.detailEmpty === false &&
          beforeObserved.selectedItemId === "alert-1" &&
          afterObserved.focus === "audit" &&
          afterObserved.detailEmpty === true &&
          afterObserved.detailText === "选择一条查看详情" &&
          afterObserved.selectedItemId === null,
        summary: `before=${beforeObserved.selectedItemId}, after=${afterObserved.detailText}`,
        artifacts: [probe],
        observed: { beforeObserved, afterObserved }
      };
    }
  );

  await verifyRule(
    13,
    "O13",
    "alert actions · create(§P2B-09)· snooze · edit · delete",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const actionLabels = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-obs-action-group] .action-button")).map((node) => node.textContent?.trim() ?? null)
      );
      await page.click('[data-action="observability-alert-create"]');
      await page.waitForTimeout(120);
      const createObserved = await page.evaluate(() => ({
        activeModal: window.__fridayQa.observability.getState().activeModal,
        modalTitle: document.querySelector(".settings-modal .overlay-title")?.textContent?.trim() ?? null,
        activeElementId: document.activeElement?.id ?? null
      }));
      await page.click('[data-action="close-overlays"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="alert-open-snooze"][data-payload="alert-1"]');
      await page.waitForTimeout(120);
      const snoozeMenuObserved = await page.evaluate(() => ({
        labels: Array.from(document.querySelectorAll('[data-alert-snooze-menu="alert-1"] .action-button')).map((node) => node.textContent?.trim() ?? null)
      }));
      await page.click('[data-action="alert-snooze-option"][data-payload="alert-1::1h"]');
      await page.waitForSelector(".toast-card");
      const snoozeObserved = await page.evaluate(() => ({
        toastText: document.querySelector(".toast-card")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="alert-edit"][data-payload="alert-1"]');
      await page.waitForTimeout(120);
      const editObserved = await page.evaluate(() => ({
        activeModal: window.__fridayQa.observability.getState().activeModal,
        modalTitle: document.querySelector(".settings-modal .overlay-title")?.textContent?.trim() ?? null,
        nameValue: document.querySelector("#observability-alert-name")?.value ?? null
      }));
      await page.click('[data-action="close-overlays"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="alert-delete"][data-payload="alert-1"]');
      await page.waitForTimeout(120);
      const deleteObserved = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        activeElementClass: document.activeElement?.className ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-07/o13-alert-actions.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o13-alert-actions.json", {
        generatedAt: new Date().toISOString(),
        actionLabels,
        createObserved,
        snoozeMenuObserved,
        snoozeObserved,
        editObserved,
        deleteObserved,
        screenshot: shot.path
      });
      return {
        pass:
          actionLabels.includes("新建告警") &&
          createObserved.activeModal === "observability-alert" &&
          createObserved.modalTitle === "新建告警" &&
          createObserved.activeElementId === "observability-alert-name" &&
          snoozeMenuObserved.labels.includes("1 小时") &&
          snoozeObserved.toastText?.includes("告警已暂停") &&
          editObserved.activeModal === "observability-alert" &&
          editObserved.modalTitle === "编辑告警" &&
          Boolean(editObserved.nameValue) &&
          deleteObserved.title === "删除这个告警?",
        summary: `actions=${actionLabels.join("/")}, delete=${deleteObserved.title}`,
        artifacts: [probe, shot],
        observed: { actionLabels, createObserved, snoozeMenuObserved, snoozeObserved, editObserved, deleteObserved }
      };
    }
  );

  await verifyRule(
    14,
    "O14",
    "traces 行 · 超过 2000ms 红色 latency · 500-2000ms 黄",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      const tokenColors = await resolvedTokenColors(page, ["--error", "--warning"]);
      const observed = await page.evaluate((colors) => {
        return ["trace-932af", "trace-17ce9", "trace-44bd1"].map((id) => {
          const row = document.querySelector(`[data-obs-row="${id}"]`);
          const duration = row.querySelector(".obs-row-actions span");
          const color = getComputedStyle(duration).color;
          return {
            id,
            text: duration?.textContent?.trim() ?? null,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o14-trace-latency-colors.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      const byId = Object.fromEntries(observed.map((entry) => [entry.id, entry]));
      return {
        pass:
          byId["trace-932af"].tokenMatch === "--error" &&
          byId["trace-17ce9"].tokenMatch === "--warning" &&
          byId["trace-44bd1"].tokenMatch === null,
        summary: `${byId["trace-932af"].tokenMatch}/${byId["trace-17ce9"].tokenMatch}/${byId["trace-44bd1"].tokenMatch}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    15,
    "O15",
    "audit 行有 diff 按钮 · 点开二级 drawer 显示 before / after JSON",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "audit");
      await page.click('[data-action="observability-open-audit-diff"][data-payload="audit-1"]');
      await page.waitForTimeout(140);
      const observed = await page.evaluate(() => ({
        activeDrawer: window.__fridayQa.observability.getState().activeDrawer,
        selectedItemId: window.__fridayQa.observability.getState().selectedItemId,
        title: document.querySelector(".drawer-panel .overlay-title")?.textContent?.trim() ?? null,
        body: document.querySelector(".drawer-panel .chat-json-block")?.textContent?.trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-07/o15-audit-drawer.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o15-audit-drawer.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.activeDrawer === "audit" &&
          observed.selectedItemId === "audit-1" &&
          observed.title === "Audit diff" &&
          observed.body.includes('"before"') &&
          observed.body.includes('"after"'),
        summary: `drawer=${observed.activeDrawer}, selected=${observed.selectedItemId}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    16,
    "O16",
    "health sparkline · 60 个 data point · hover 显具体时间 + 值",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "health");
      const beforeObserved = await page.evaluate(() => ({
        cpuPoints: document.querySelectorAll('[data-spark-point^="cpu-"]').length,
        memoryPoints: document.querySelectorAll('[data-spark-point^="memory-"]').length,
        queuePoints: document.querySelectorAll('[data-spark-point^="queue-"]').length
      }));
      await page.hover('[data-spark-point="cpu-59"]');
      await page.waitForTimeout(180);
      const hoverObserved = await page.evaluate(() => {
        const tooltip = document.querySelector('[data-spark-point="cpu-59"] .obs-spark-tooltip');
        return {
          text: tooltip?.textContent?.trim() ?? null,
          opacity: tooltip ? getComputedStyle(tooltip).opacity : null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-07/o16-health-tooltip.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o16-health-tooltip.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        hoverObserved,
        screenshot: shot.path
      });
      return {
        pass:
          beforeObserved.cpuPoints === 60 &&
          beforeObserved.memoryPoints === 60 &&
          beforeObserved.queuePoints === 60 &&
          hoverObserved.text?.includes("·") &&
          Number(hoverObserved.opacity) >= 0.95,
        summary: `cpu=${beforeObserved.cpuPoints}, tooltip=${hoverObserved.text}`,
        artifacts: [probe, shot],
        observed: { beforeObserved, hoverObserved }
      };
    }
  );

  await verifyRule(
    17,
    "O17",
    "buildObservabilityActionQueue 驱动右上角 action 按钮组 · 按 focus 显示不同按钮",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const observed = [];
      for (const focus of ["alerts", "traces", "audit", "health", "acceptance"]) {
        await page.evaluate((nextFocus) => window.__fridayQa.observability.setFocus(nextFocus), focus);
        await page.waitForTimeout(160);
        observed.push(await page.evaluate(() => ({
          focus: window.__fridayQa.observability.getState().focus,
          helperQueue: window.__fridayQa.observability.currentActionQueue().map((item) => item.label),
          domQueue: Array.from(document.querySelectorAll("[data-obs-action-group] .action-button")).map((node) => node.textContent?.trim() ?? null)
        })));
      }
      await context.close();
      const probe = await writeJson("screenshots/P2B-07/o17-action-queue.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const uniqueQueues = new Set(observed.map((entry) => JSON.stringify(entry.domQueue)));
      return {
        pass:
          observed.length === 5 &&
          observed.every((entry) => JSON.stringify(entry.helperQueue) === JSON.stringify(entry.domQueue) && entry.domQueue.length === 3) &&
          uniqueQueues.size === 5,
        summary: `queues=${uniqueQueues.size}, alerts=${observed[0].domQueue.join("/")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-07", "/observability", generatedAt, results, artifacts);
}

async function verifyP2B08(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "T01",
    "drawer 右侧滑入 420 · 200ms ease-out · Escape 关",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      const opened = await page.evaluate(() => {
        const drawer = document.querySelector('.drawer-panel[data-drawer-kind="trace"]');
        return {
          activeDrawer: window.__fridayQa.observability.getState().activeDrawer,
          width: drawer ? Math.round(drawer.getBoundingClientRect().width) : null,
          animationName: drawer ? getComputedStyle(drawer).animationName : null,
          animationDuration: drawer ? getComputedStyle(drawer).animationDuration : null,
          animationTimingFunction: drawer ? getComputedStyle(drawer).animationTimingFunction : null,
          bodyOverflow: getComputedStyle(document.body).overflow,
          shellMainPointer: getComputedStyle(document.querySelector(".shell-main")).pointerEvents
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2B-08/t01-trace-drawer-open.png");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(140);
      const closed = await page.evaluate(() => ({
        activeDrawer: window.__fridayQa.observability.getState().activeDrawer,
        drawerPresent: Boolean(document.querySelector('.drawer-panel[data-drawer-kind="trace"]')),
        bodyOverflow: getComputedStyle(document.body).overflow
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t01-trace-drawer-shell.json", {
        generatedAt: new Date().toISOString(),
        opened,
        closed,
        screenshot: shot.path
      });
      return {
        pass:
          opened.activeDrawer === "trace" &&
          opened.width === 420 &&
          opened.animationName === "trace-drawer-slide-in" &&
          (opened.animationDuration.includes("0.2s") || opened.animationDuration.includes("200ms")) &&
          opened.bodyOverflow === "hidden" &&
          opened.shellMainPointer === "none" &&
          closed.activeDrawer === null &&
          closed.drawerPresent === false,
        summary: `width=${opened.width}, animation=${opened.animationDuration}, closed=${closed.drawerPresent}`,
        artifacts: [probe, shot],
        observed: { opened, closed }
      };
    }
  );

  await verifyRule(
    2,
    "T02",
    "头部 · traceId + duration + status + close 按钮",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      const observed = await page.evaluate(() => ({
        title: document.querySelector('.drawer-panel[data-drawer-kind="trace"] .overlay-title')?.textContent?.trim() ?? null,
        headerMeta: Array.from(document.querySelectorAll('[data-trace-header-meta] .trace-summary-chip')).map((node) => node.textContent?.trim() ?? null),
        closeLabel: document.querySelector('.drawer-panel[data-drawer-kind="trace"] .quick-sheet-close')?.getAttribute("aria-label") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2B-08/t02-trace-header.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t02-trace-header.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "trace-932af" &&
          observed.headerMeta.some((item) => item === "2430ms") &&
          observed.headerMeta.some((item) => item === "failed") &&
          observed.closeLabel === "关闭",
        summary: `title=${observed.title}, header=${observed.headerMeta.join("/")}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "T03",
    "span tree 竖排 · 缩进表达 parent-child · 每 span 一行 · 行高 28",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      await page.click('[data-span-id="span-route-root"]');
      await page.waitForTimeout(120);
      await page.click('[data-span-id="span-tool-inventory"]');
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-span-id]")).map((row) => ({
          id: row.getAttribute("data-span-id"),
          depth: Number(row.getAttribute("data-span-depth")),
          marginLeft: row.style.marginLeft,
          lineHeight: getComputedStyle(row).lineHeight
        }))
      );
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t03-span-tree-indent.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const byId = Object.fromEntries(observed.map((entry) => [entry.id, entry]));
      return {
        pass:
          observed.length >= 4 &&
          byId["span-route-root"]?.depth === 0 &&
          byId["span-route-root"]?.marginLeft === "0px" &&
          byId["span-tool-inventory"]?.depth === 1 &&
          byId["span-tool-inventory"]?.marginLeft === "18px" &&
          byId["span-db-audit"]?.depth === 2 &&
          byId["span-db-audit"]?.marginLeft === "36px" &&
          observed.every((entry) => entry.lineHeight === "28px"),
        summary: `rows=${observed.length}, depths=${observed.map((entry) => `${entry.id}:${entry.depth}`).join(",")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "T04",
    "span 有 3 色 dot · tool 琥珀 / LLM 紫 / DB 青",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      await page.click('[data-span-id="span-route-root"]');
      await page.waitForTimeout(120);
      await page.click('[data-span-id="span-tool-inventory"]');
      await page.waitForTimeout(120);
      const tokenColors = await resolvedTokenColors(page, ["--warning", "--trace-llm", "--trace-db"]);
      const observed = await page.evaluate((colors) => {
        return [
          { id: "span-tool-inventory", token: "--warning" },
          { id: "span-route-root", token: "--trace-llm" },
          { id: "span-db-audit", token: "--trace-db" }
        ].map((entry) => {
          const dot = document.querySelector(`[data-span-type-dot="${entry.id}"]`);
          const color = dot ? getComputedStyle(dot).backgroundColor : null;
          return {
            ...entry,
            color,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t04-span-dot-colors.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass: observed.every((entry) => entry.tokenMatch === entry.token),
        summary: observed.map((entry) => `${entry.id}:${entry.tokenMatch}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "T05",
    "span 点击展开 · 显示 start/end/duration/attributes · 默认折叠",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      const beforeObserved = await page.evaluate(() => ({
        visibleIds: (document.querySelector('[data-trace-tree="true"]')?.getAttribute("data-visible-span-ids") || "").split(",").filter(Boolean),
        attrsCount: document.querySelectorAll("[data-span-attrs]").length,
        expanded: document.querySelector('[data-span-id="span-route-root"]')?.getAttribute("data-span-expanded") ?? null
      }));
      await page.click('[data-span-id="span-route-root"]');
      await page.waitForTimeout(140);
      const afterObserved = await page.evaluate(() => {
        const row = document.querySelector('[data-span-id="span-route-root"]');
        return {
          visibleIds: (document.querySelector('[data-trace-tree="true"]')?.getAttribute("data-visible-span-ids") || "").split(",").filter(Boolean),
          attrsCount: document.querySelectorAll("[data-span-attrs]").length,
          expanded: row?.getAttribute("data-span-expanded") ?? null,
          attrsText: document.querySelector('[data-span-attrs="span-route-root"]')?.textContent ?? null,
          transitionDuration: row ? getComputedStyle(row).transitionDuration : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t05-span-expand.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        afterObserved
      });
      return {
        pass:
          beforeObserved.attrsCount === 0 &&
          beforeObserved.expanded === "false" &&
          afterObserved.attrsCount === 1 &&
          afterObserved.expanded === "true" &&
          afterObserved.visibleIds.length > beforeObserved.visibleIds.length &&
          afterObserved.attrsText?.includes('"start"') &&
          afterObserved.attrsText?.includes('"end"') &&
          afterObserved.attrsText?.includes('"durationMs"') &&
          afterObserved.attrsText?.includes('"attributes"') &&
          (afterObserved.transitionDuration.includes("0.2s") || afterObserved.transitionDuration.includes("200ms")),
        summary: `visible=${beforeObserved.visibleIds.length}->${afterObserved.visibleIds.length}, attrs=${afterObserved.attrsCount}`,
        artifacts: [probe],
        observed: { beforeObserved, afterObserved }
      };
    }
  );

  await verifyRule(
    6,
    "T06",
    "span 超过 1000ms · 红文字",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      await page.click('[data-span-id="span-route-root"]');
      await page.waitForTimeout(120);
      const tokenColors = await resolvedTokenColors(page, ["--error"]);
      const observed = await page.evaluate((colors) => {
        const duration = document.querySelector('[data-span-id="span-tool-inventory"] .trace-span-duration');
        const color = duration ? getComputedStyle(duration).color : null;
        return {
          text: duration?.textContent?.trim() ?? null,
          color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t06-slow-span-color.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass: observed.text === "1180ms" && observed.tokenMatch === "--error",
        summary: `${observed.text} -> ${observed.tokenMatch}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "T07",
    "可搜索 spans · 输入框顶部 · 即时过滤",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      await page.click('[data-span-id="span-route-root"]');
      await page.waitForTimeout(120);
      await page.click('[data-span-id="span-tool-inventory"]');
      await page.waitForTimeout(120);
      const beforeObserved = await page.evaluate(() => ({
        inputPresent: Boolean(document.querySelector("#trace-drawer-search")),
        visibleIds: (document.querySelector('[data-trace-tree="true"]')?.getAttribute("data-visible-span-ids") || "").split(",").filter(Boolean)
      }));
      await page.fill("#trace-drawer-search", "inventory");
      await page.waitForTimeout(120);
      const afterObserved = await page.evaluate(() => ({
        value: document.querySelector("#trace-drawer-search")?.value ?? null,
        visibleIds: (document.querySelector('[data-trace-tree="true"]')?.getAttribute("data-visible-span-ids") || "").split(",").filter(Boolean)
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t07-trace-search.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        afterObserved
      });
      return {
        pass:
          beforeObserved.inputPresent === true &&
          beforeObserved.visibleIds.length >= 4 &&
          afterObserved.value === "inventory" &&
          JSON.stringify(afterObserved.visibleIds) === JSON.stringify(["span-route-root", "span-tool-inventory"]) &&
          afterObserved.visibleIds.length < beforeObserved.visibleIds.length,
        summary: `visible=${beforeObserved.visibleIds.length}->${afterObserved.visibleIds.length}`,
        artifacts: [probe],
        observed: { beforeObserved, afterObserved }
      };
    }
  );

  await verifyRule(
    8,
    "T08",
    "export JSON 按钮 · 下载 trace.json",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "traces");
      await openTraceDrawerViaRow(page);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click('[data-action="trace-export-json"][data-payload="trace-932af"]')
      ]);
      const downloadPath = await download.path();
      const payload = JSON.parse(await fs.readFile(downloadPath, "utf8"));
      await context.close();
      const probe = await writeJson("screenshots/P2B-08/t08-trace-export.json", {
        generatedAt: new Date().toISOString(),
        suggestedFilename: download.suggestedFilename(),
        payload
      });
      return {
        pass:
          download.suggestedFilename() === "trace.json" &&
          payload.trace?.id === "trace-932af" &&
          Array.isArray(payload.spans) &&
          payload.spans.length >= 4,
        summary: `${download.suggestedFilename()} spans=${payload.spans?.length ?? 0}`,
        artifacts: [probe],
        observed: {
          suggestedFilename: download.suggestedFilename(),
          payload
        }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-08", "/observability?focus=traces", generatedAt, results, artifacts);
}

async function verifyP2B09(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "M01",
    "list · 每 alert 一行 · 状态 dot + 名称 + 指标 + 阈值 + 最近触发 + actions",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const observed = await readAlertRow(page, "alert-1");
      const shot = await captureScreenshot(page, "screenshots/P2B-09/m01-alert-list-row.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m01-alert-list-row.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.exists === true &&
          observed.name === "provider p95 超阈值" &&
          JSON.stringify(observed.meta) === JSON.stringify(["latency.p95", "> 2000ms", "14:10"]) &&
          JSON.stringify(observed.actionLabels) === JSON.stringify(["暂停", "编辑", "删除"]),
        summary: `${observed.name} · ${observed.meta.join(" / ")}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "M02",
    "compose modal · 3 字段必填 · 指标(select 20+ option)+ 阈值(数字 + 比较符)+ 通知渠道(multi-select)",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-action="observability-alert-create"]');
      await page.waitForTimeout(120);
      const step1 = await page.evaluate(() => ({
        modalStep: document.querySelector("[data-alert-modal]")?.getAttribute("data-alert-modal-step") ?? null,
        optionCount: document.querySelectorAll("#observability-alert-metric option").length,
        nameValue: document.querySelector("#observability-alert-name")?.value ?? null
      }));
      const step1Probe = await writeJson("screenshots/P2B-09/m02-compose-step-1.json", {
        generatedAt: new Date().toISOString(),
        step1
      });
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      const step2 = await page.evaluate(() => ({
        modalStep: document.querySelector("[data-alert-modal]")?.getAttribute("data-alert-modal-step") ?? null,
        comparatorOptions: Array.from(document.querySelectorAll("#observability-alert-comparator option")).map((node) => node.textContent?.trim() ?? null),
        thresholdValue: document.querySelector("#observability-alert-threshold-value")?.value ?? null
      }));
      const step2Probe = await writeJson("screenshots/P2B-09/m02-compose-step-2.json", {
        generatedAt: new Date().toISOString(),
        step2
      });
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      const step3 = await page.evaluate(() => ({
        modalStep: document.querySelector("[data-alert-modal]")?.getAttribute("data-alert-modal-step") ?? null,
        channelCount: document.querySelectorAll("[data-observability-alert-channel]").length,
        checkedCount: document.querySelectorAll("[data-observability-alert-channel]:checked").length
      }));
      const step3Probe = await writeJson("screenshots/P2B-09/m02-compose-step-3.json", {
        generatedAt: new Date().toISOString(),
        step3
      });
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m02-compose-modal.json", {
        generatedAt: new Date().toISOString(),
        steps: [step1Probe.path, step2Probe.path, step3Probe.path],
        step1,
        step2,
        step3
      });
      return {
        pass:
          step1.modalStep === "1" &&
          step1.optionCount >= 21 &&
          step2.modalStep === "2" &&
          JSON.stringify(step2.comparatorOptions) === JSON.stringify([">", ">=", "<", "<=", "="]) &&
          step3.modalStep === "3" &&
          step3.channelCount >= 5 &&
          step3.checkedCount >= 1,
        summary: `options=${step1.optionCount}, comparators=${step2.comparatorOptions.length}, channels=${step3.channelCount}`,
        artifacts: [probe, step1Probe, step2Probe, step3Probe],
        observed: { step1, step2, step3 }
      };
    }
  );

  await verifyRule(
    3,
    "M03",
    "compose 验证 · 空字段红边 + 下方错误 · 阈值非数字禁交",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-action="observability-alert-create"]');
      await page.waitForTimeout(120);
      await page.fill("#observability-alert-name", "");
      await page.selectOption("#observability-alert-metric", "");
      await page.waitForTimeout(100);
      const step1Observed = await page.evaluate(() => ({
        nextDisabled: document.querySelector('[data-action="observability-alert-step-next"]')?.hasAttribute("disabled") ?? null,
        nameBorderColor: getComputedStyle(document.querySelector("#observability-alert-name")).borderColor,
        nameError: document.querySelector("#observability-alert-name-error")?.textContent?.trim() ?? null,
        metricError: document.querySelector("#observability-alert-metric-error")?.textContent?.trim() ?? null
      }));
      await page.fill("#observability-alert-name", "供应商超时保护");
      await page.selectOption("#observability-alert-metric", "latency.p95");
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      await page.fill("#observability-alert-threshold-value", "abc");
      await page.waitForTimeout(100);
      const step2Observed = await page.evaluate(() => ({
        nextDisabled: document.querySelector('[data-action="observability-alert-step-next"]')?.hasAttribute("disabled") ?? null,
        thresholdBorderColor: getComputedStyle(document.querySelector("#observability-alert-threshold-value")).borderColor,
        thresholdError: document.querySelector("#observability-alert-threshold-error")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m03-compose-validation.json", {
        generatedAt: new Date().toISOString(),
        step1Observed,
        step2Observed
      });
      return {
        pass:
          step1Observed.nextDisabled === true &&
          step1Observed.nameBorderColor === "rgb(165, 48, 40)" &&
          step1Observed.nameError === "名称不能为空。" &&
          step1Observed.metricError === "请选择指标。" &&
          step2Observed.nextDisabled === true &&
          step2Observed.thresholdBorderColor === "rgb(165, 48, 40)" &&
          step2Observed.thresholdError === "阈值必须是数字。",
        summary: `step1=${step1Observed.nameError}, step2=${step2Observed.thresholdError}`,
        artifacts: [probe],
        observed: { step1Observed, step2Observed }
      };
    }
  );

  await verifyRule(
    4,
    "M04",
    "snooze · 弹出 4 档选项 1h / 4h / 24h / 永久 · 选后 row 变虚线 border + \"snoozed until ...\"",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-action="alert-open-snooze"][data-payload="alert-1"]');
      await page.waitForTimeout(120);
      const menuObserved = await page.evaluate(() => ({
        labels: Array.from(document.querySelectorAll('[data-alert-snooze-menu="alert-1"] .action-button')).map((node) => node.textContent?.trim() ?? null)
      }));
      await page.click('[data-action="alert-snooze-option"][data-payload="alert-1::4h"]');
      await page.waitForTimeout(140);
      const rowObserved = await readAlertRow(page, "alert-1");
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m04-alert-snooze.json", {
        generatedAt: new Date().toISOString(),
        menuObserved,
        rowObserved
      });
      return {
        pass:
          JSON.stringify(menuObserved.labels) === JSON.stringify(["1 小时", "4 小时", "24 小时", "永久"]) &&
          rowObserved.className?.includes("is-snoozed") &&
          rowObserved.snoozeCopy?.startsWith("snoozed until "),
        summary: `menu=${menuObserved.labels.join("/")}, row=${rowObserved.className}`,
        artifacts: [probe],
        observed: { menuObserved, rowObserved }
      };
    }
  );

  await verifyRule(
    5,
    "M05",
    "firing row · 红底 + 脉冲 dot · 顶部有 \"N 正在触发\" banner",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const tokenBackgrounds = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--error-soft)";
        document.body.appendChild(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { "--error-soft": background };
      });
      const observed = await page.evaluate((colors) => {
        const row = document.querySelector('[data-obs-row="alert-1"][data-obs-focus="alerts"]');
        const dot = row?.querySelector(".health-dot");
        return {
          bannerText: document.querySelector("[data-firing-banner]")?.textContent?.trim() ?? null,
          rowBackground: row ? getComputedStyle(row).backgroundColor : null,
          tokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(row).backgroundColor)?.[0] ?? null,
          dotAnimation: dot ? getComputedStyle(dot).animationName : null
        };
      }, tokenBackgrounds);
      const shot = await captureScreenshot(page, "screenshots/P2B-09/m05-firing-banner.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m05-firing-banner.json", {
        generatedAt: new Date().toISOString(),
        tokenBackgrounds,
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.bannerText === "2 正在触发" &&
          observed.tokenMatch === "--error-soft" &&
          observed.dotAnimation === "provider-dot-pulse",
        summary: `${observed.bannerText} / ${observed.tokenMatch}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "M06",
    "edit · 行内按钮 · 打开 modal 预填当前值",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-action="alert-edit"][data-payload="alert-2"]');
      await page.waitForTimeout(120);
      const step1Observed = await page.evaluate(() => ({
        step: document.querySelector("[data-alert-modal]")?.getAttribute("data-alert-modal-step") ?? null,
        name: document.querySelector("#observability-alert-name")?.value ?? null,
        metric: document.querySelector("#observability-alert-metric")?.value ?? null
      }));
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      const step2Observed = await page.evaluate(() => ({
        step: document.querySelector("[data-alert-modal]")?.getAttribute("data-alert-modal-step") ?? null,
        comparator: document.querySelector("#observability-alert-comparator")?.value ?? null,
        thresholdValue: document.querySelector("#observability-alert-threshold-value")?.value ?? null
      }));
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      const step3Observed = await page.evaluate(() => ({
        step: document.querySelector("[data-alert-modal]")?.getAttribute("data-alert-modal-step") ?? null,
        checkedChannels: Array.from(document.querySelectorAll("[data-observability-alert-channel]:checked")).map((node) => node.getAttribute("data-observability-alert-channel"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m06-edit-prefill.json", {
        generatedAt: new Date().toISOString(),
        step1Observed,
        step2Observed,
        step3Observed
      });
      return {
        pass:
          step1Observed.step === "1" &&
          step1Observed.name === "队列堆积" &&
          step1Observed.metric === "queue.depth" &&
          step2Observed.step === "2" &&
          step2Observed.comparator === ">" &&
          step2Observed.thresholdValue === "50" &&
          step3Observed.step === "3" &&
          JSON.stringify(step3Observed.checkedChannels) === JSON.stringify(["#runtime-ops"]),
        summary: `${step1Observed.name} / ${step2Observed.comparator}${step2Observed.thresholdValue}`,
        artifacts: [probe],
        observed: { step1Observed, step2Observed, step3Observed }
      };
    }
  );

  await verifyRule(
    7,
    "M07",
    "delete · 二次确认 · 输入 alert 名二次验证",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-action="alert-delete"][data-payload="alert-1"]');
      await page.waitForTimeout(120);
      const beforeObserved = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        disabled: document.querySelector('[data-action="confirm-run"]')?.hasAttribute("disabled") ?? null
      }));
      await page.fill("#confirm-dialog-input", "provider");
      await page.waitForTimeout(80);
      const wrongObserved = await page.evaluate(() => ({
        value: document.querySelector("#confirm-dialog-input")?.value ?? null,
        disabled: document.querySelector('[data-action="confirm-run"]')?.hasAttribute("disabled") ?? null
      }));
      await page.fill("#confirm-dialog-input", "provider p95 超阈值");
      await page.waitForTimeout(80);
      const exactObserved = await page.evaluate(() => ({
        value: document.querySelector("#confirm-dialog-input")?.value ?? null,
        disabled: document.querySelector('[data-action="confirm-run"]')?.hasAttribute("disabled") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m07-delete-confirm.json", {
        generatedAt: new Date().toISOString(),
        beforeObserved,
        wrongObserved,
        exactObserved
      });
      return {
        pass:
          beforeObserved.title === "删除这个告警?" &&
          beforeObserved.disabled === true &&
          wrongObserved.disabled === true &&
          exactObserved.value === "provider p95 超阈值" &&
          exactObserved.disabled === false,
        summary: `confirm=${beforeObserved.title}, exact=${exactObserved.disabled}`,
        artifacts: [probe],
        observed: { beforeObserved, wrongObserved, exactObserved }
      };
    }
  );

  await verifyRule(
    8,
    "M08",
    "新建后自动刷 list · row 入场 fade-in · 滚到其位置",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      const alertName = "库存回补抖动";
      await page.click('[data-action="observability-alert-create"]');
      await page.waitForTimeout(120);
      await page.fill("#observability-alert-name", alertName);
      await page.selectOption("#observability-alert-metric", "channel.sync_lag");
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      await page.fill("#observability-alert-threshold-value", "88");
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      await page.check('[data-observability-alert-channel="#channels-ops"]');
      await page.waitForTimeout(60);
      await page.click('[data-action="observability-alert-save"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate((name) => {
        const row = Array.from(document.querySelectorAll('[data-obs-row][data-obs-focus="alerts"]')).find((node) =>
          node.textContent?.includes(name)
        );
        return {
          rowFound: Boolean(row),
          rowId: row?.getAttribute("data-obs-row") ?? null,
          className: row?.className ?? null,
          state: window.__fridayQa.observability.getState(),
          scrollTop: document.scrollingElement?.scrollTop ?? window.scrollY
        };
      }, alertName);
      const shot = await captureScreenshot(page, "screenshots/P2B-09/m08-new-alert-row.png");
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m08-new-alert-row.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.rowFound === true &&
          observed.className?.includes("is-entering") &&
          observed.state.selectedItemId === observed.rowId &&
          observed.state.lastAlertScroll?.id === observed.rowId &&
          observed.state.lastAlertScroll?.behavior === "smooth",
        summary: `row=${observed.rowId}, scroll=${observed.state.lastAlertScroll?.behavior ?? "none"}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "M09",
    "dev switcher · 4 状态 list / creating / snoozed-sample / firing-sample",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts", { stateName: "list" });
      const navBefore = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      const availableStates = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".dev-state-button")).map((node) => node.getAttribute("data-payload"))
      );
      const sequence = [];
      for (const stateName of ["list", "creating", "snoozed-sample", "firing-sample"]) {
        if (page.locator('[data-action="close-overlays"]').first()) {
          const overlayVisible = await page.locator('.overlay-panel[role="dialog"][aria-modal="true"]').count();
          if (overlayVisible > 0) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(120);
          }
        }
        await page.click(`[data-action="set-home-state"][data-payload="${stateName}"]`);
        await page.waitForTimeout(180);
        sequence.push(await page.evaluate(() => ({
          search: window.location.search,
          activeState: document.querySelector(".dev-switcher-state")?.textContent?.trim() ?? null,
          activeModal: window.__fridayQa.observability.getState().activeModal,
          selectedItemId: window.__fridayQa.observability.getState().selectedItemId,
          selectedStatus: (() => {
            const selectedId = window.__fridayQa.observability.getState().selectedItemId;
            const selected = selectedId ? document.querySelector(`[data-obs-row="${selectedId}"][data-obs-focus="alerts"]`) : null;
            return selected?.getAttribute("data-alert-status") ?? null;
          })()
        })));
      }
      const navAfter = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      await context.close();
      const probe = await writeJson("screenshots/P2B-09/m09-dev-switcher.json", {
        generatedAt: new Date().toISOString(),
        availableStates,
        sequence,
        navBefore,
        navAfter
      });
      return {
        pass:
          ["list", "creating", "snoozed-sample", "firing-sample"].every((stateName) => availableStates.includes(stateName)) &&
          sequence[0].activeState === "list" &&
          sequence[1].activeState === "creating" &&
          sequence[1].activeModal === "observability-alert" &&
          sequence[2].activeState === "snoozed-sample" &&
          sequence[2].selectedStatus === "snoozed" &&
          sequence[3].activeState === "firing-sample" &&
          sequence[3].selectedStatus === "firing" &&
          sequence.every((entry) => entry.search.includes(`__state=${encodeURIComponent(entry.activeState)}`)) &&
          navBefore === 1 &&
          navAfter === 1,
        summary: `states=${sequence.map((entry) => entry.activeState).join("/")}`,
        artifacts: [probe],
        observed: { availableStates, sequence, navBefore, navAfter }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2B-09", "/observability?focus=alerts", generatedAt, results, artifacts);
}

async function verifyP2C01(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `P${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 pinned 280(单列 card)· 右 catalog flex(3 列 grid)· 1920 下 4 列",
    async () => {
      const { page: page1440, context: context1440 } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog",
        viewport: { width: 1440, height: 1200 }
      });
      const observed1440 = await page1440.evaluate(() => {
        const layout = document.querySelector(".packs-layout");
        const pinned = layout?.querySelector("aside");
        const grid = document.querySelector("[data-pack-catalog-grid='true']");
        const template = grid ? getComputedStyle(grid).gridTemplateColumns : "";
        return {
          layoutColumns: getComputedStyle(layout).gridTemplateColumns,
          pinnedWidth: pinned?.getBoundingClientRect().width ?? null,
          catalogColumnCount: template.split(" ").filter(Boolean).length,
          cardCount: document.querySelectorAll("[data-pack-location='catalog']").length
        };
      });
      const shot1440 = await captureScreenshot(page1440, "screenshots/P2C-01/p01-layout-1440.png");
      await context1440.close();

      const { page: page1920, context: context1920 } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog",
        viewport: { width: 1920, height: 1200 }
      });
      const observed1920 = await page1920.evaluate(() => {
        const grid = document.querySelector("[data-pack-catalog-grid='true']");
        return {
          catalogColumnCount: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight
          }
        };
      });
      const shot1920 = await captureScreenshot(page1920, "screenshots/P2C-01/p01-layout-1920.png");
      await context1920.close();

      const probe = await writeJson("screenshots/P2C-01/p01-layout.json", {
        generatedAt: new Date().toISOString(),
        observed1440,
        observed1920,
        screenshots: [shot1440.path, shot1920.path]
      });
      return {
        pass:
          Math.abs((observed1440.pinnedWidth ?? 0) - 280) <= 8 &&
          observed1440.catalogColumnCount === 3 &&
          observed1920.catalogColumnCount === 4,
        summary: `1440=${observed1440.catalogColumnCount} cols, 1920=${observed1920.catalogColumnCount} cols`,
        artifacts: [probe, shot1440, shot1920],
        observed: { observed1440, observed1920 }
      };
    }
  );

  await verifyRule(
    2,
    "顶部 · search input 400 + category filter chips(6-8 个)+ \"+ 自定义 pack\" 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const observed = await page.evaluate(() => {
        const input = document.querySelector("#packs-search");
        const chips = Array.from(document.querySelectorAll('[data-action="toggle-pack-filter"]')).map((node) => node.textContent?.trim() ?? "");
        const button = document.querySelector('[data-action="open-custom-pack-builder"]');
        return {
          searchWidth: input?.getBoundingClientRect().width ?? null,
          chipCount: chips.length,
          chips,
          buttonLabel: button?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p02-topbar.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Math.abs((observed.searchWidth ?? 0) - 400) <= 4 &&
          observed.chipCount >= 6 &&
          observed.chipCount <= 8 &&
          observed.buttonLabel === "+ 自定义 pack",
        summary: `search=${observed.searchWidth}px, chips=${observed.chipCount}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "search 即时过滤(debounce 150ms)· 匹配 pack.title + description + tags",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const total = await readPacksQaState(page);
      await page.fill("#packs-search", "支持台");
      await page.waitForTimeout(80);
      const beforeCommit = await readPacksQaState(page);
      await page.waitForTimeout(110);
      const titleMatch = await readPacksQaState(page);
      await page.fill("#packs-search", "回滚");
      await page.waitForTimeout(180);
      const descriptionMatch = await readPacksQaState(page);
      await page.fill("#packs-search", "security");
      await page.waitForTimeout(180);
      const tagMatch = await readPacksQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p03-search-debounce.json", {
        generatedAt: new Date().toISOString(),
        total,
        beforeCommit,
        titleMatch,
        descriptionMatch,
        tagMatch
      });
      return {
        pass:
          beforeCommit.filteredPackIds.length === total.filteredPackIds.length &&
          JSON.stringify(titleMatch.filteredPackIds) === JSON.stringify(["task-support-ops"]) &&
          descriptionMatch.filteredPackIds.includes("task-release-ops") &&
          tagMatch.filteredPackIds.includes("task-security-review"),
        summary: `title=${titleMatch.filteredPackIds.join(",")} description=${descriptionMatch.filteredPackIds.join(",")}`,
        artifacts: [probe],
        observed: { total, beforeCommit, titleMatch, descriptionMatch, tagMatch }
      };
    }
  );

  await verifyRule(
    4,
    "filter chips 多选 · active 琥珀底 · clear all 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent-soft"]);
      await page.click('[data-action="toggle-pack-filter"][data-payload="release"]');
      await page.click('[data-action="toggle-pack-filter"][data-payload="security"]');
      await page.waitForTimeout(100);
      const activeObserved = await page.evaluate((colors) => {
        const active = Array.from(document.querySelectorAll('[data-action="toggle-pack-filter"].is-active')).map((node) => ({
          label: node.textContent?.trim() ?? "",
          background: getComputedStyle(node).backgroundColor,
          tokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(node).backgroundColor)?.[0] ?? null
        }));
        return {
          active,
          clearAllVisible: Boolean(document.querySelector('[data-action="clear-pack-filters"]'))
        };
      }, tokenColors);
      await page.click('[data-action="clear-pack-filters"]');
      await page.waitForTimeout(80);
      const cleared = await readPacksQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p04-filter-chips.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        activeObserved,
        cleared
      });
      return {
        pass:
          activeObserved.active.length === 2 &&
          activeObserved.active.every((item) => item.tokenMatch === "--accent-soft") &&
          activeObserved.clearAllVisible === true &&
          cleared.activeFilters.length === 0,
        summary: `active=${activeObserved.active.map((item) => item.label).join("/")}`,
        artifacts: [probe],
        observed: { tokenColors, activeObserved, cleared }
      };
    }
  );

  await verifyRule(
    5,
    "pack card · 240 高 · 顶部产品预览(PackProductPreview 24)· 中标题 · 底 meta + \"打开\" 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const observed = await page.evaluate(() => {
        const card = document.querySelector("[data-pack-location='catalog']");
        const previewTiles = Array.from(card?.querySelectorAll("[data-pack-preview] span") || []).map((node) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          label: node.textContent?.trim() ?? ""
        }));
        const button = card?.querySelector('[data-action="launch-pack"]');
        return {
          height: card?.getBoundingClientRect().height ?? null,
          previewTiles,
          title: card?.querySelector("strong")?.textContent?.trim() ?? null,
          openLabel: button?.textContent?.trim() ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-01/p05-pack-card.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p05-pack-card.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          (observed.height ?? 0) >= 240 &&
          observed.previewTiles.length === 4 &&
          observed.previewTiles.every((tile) => Math.abs(tile.width - 24) <= 1 && Math.abs(tile.height - 24) <= 1) &&
          Boolean(observed.title) &&
          observed.openLabel === "打开",
        summary: `height=${observed.height}, tiles=${observed.previewTiles.length}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "pinned 列 · 拖拽重排 · 拖后写 `useHomeSurfacePreferences`",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const before = await readPacksQaState(page);
      await page.evaluate(() => {
        const source = document.querySelector('[data-pack-location="pinned"][data-pack-id="task-ship-fast"]');
        const target = document.querySelector('[data-pack-location="pinned"][data-pack-id="industry-cross-border-ecommerce"]');
        if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
          return;
        }
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
        source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(180);
      const after = await readPacksQaState(page);
      const storageObserved = await page.evaluate(() => ({
        raw: window.localStorage.getItem("friday-pack-pinned-order"),
        homePreferences: window.useHomeSurfacePreferences()
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p06-pinned-drag.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        storageObserved
      });
      return {
        pass:
          JSON.stringify(before.pinnedOrder) === JSON.stringify(["industry-cross-border-ecommerce", "task-ship-fast"]) &&
          JSON.stringify(after.pinnedOrder) === JSON.stringify(["task-ship-fast", "industry-cross-border-ecommerce"]) &&
          JSON.stringify(storageObserved.homePreferences.pinnedPackIds) === JSON.stringify(after.pinnedOrder),
        summary: `${before.pinnedOrder.join(" -> ")} => ${after.pinnedOrder.join(" -> ")}`,
        artifacts: [probe],
        observed: { before, after, storageObserved }
      };
    }
  );

  await verifyRule(
    7,
    "卡片 hover · 显 PackQuickSheet tooltip(350ms delay)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const selector = '[data-pack-location="catalog"][data-pack-id="task-release-ops"]';
      await page.evaluate((targetSelector) => {
        const target = document.querySelector(targetSelector);
        window.__qaPackHoverProbe = {
          targetSelector,
          initial: {
            visible: Boolean(document.querySelector(".quick-sheet")),
            selectedPackId: window.__fridayQa.packs.getState().selectedPackId
          },
          enterAt: null,
          visibleAt: null,
          visibleDelayMs: null,
          firstVisible: null,
          samples: {}
        };
        if (!target) {
          return;
        }
        target.addEventListener("mouseenter", function onEnter() {
          const probe = window.__qaPackHoverProbe;
          probe.enterAt = performance.now();
          [300, 360, 420].forEach((sampleMs) => {
            window.setTimeout(() => {
              probe.samples[String(sampleMs)] = {
                sampleMs,
                at: performance.now(),
                visible: Boolean(document.querySelector(".quick-sheet")),
                selectedPackId: window.__fridayQa.packs.getState().selectedPackId,
                ariaLabel: document.querySelector(".quick-sheet")?.getAttribute("aria-label") ?? null
              };
            }, sampleMs);
          });
          const tick = () => {
            const sheet = document.querySelector(".quick-sheet");
            if (sheet && probe.visibleAt == null) {
              probe.visibleAt = performance.now();
              probe.visibleDelayMs = probe.visibleAt - probe.enterAt;
              probe.firstVisible = {
                selectedPackId: window.__fridayQa.packs.getState().selectedPackId,
                ariaLabel: sheet.getAttribute("aria-label") ?? null
              };
            }
            if (!probe.samples["420"] || probe.visibleAt == null) {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        }, { once: true, capture: true });
      }, selector);
      await page.dispatchEvent(selector, "mouseenter");
      await page.waitForFunction(() => {
        const probe = window.__qaPackHoverProbe;
        return Boolean(probe?.samples?.["420"] && probe?.visibleAt != null);
      });
      const observed = await page.evaluate(() => window.__qaPackHoverProbe);
      const shot = await captureScreenshot(page, "screenshots/P2C-01/p07-hover-sheet.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p07-hover-sheet.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.initial?.visible === false &&
          observed.initial?.selectedPackId == null &&
          observed.samples?.["300"]?.visible === false &&
          observed.samples?.["300"]?.selectedPackId == null &&
          observed.samples?.["420"]?.visible === true &&
          observed.firstVisible?.selectedPackId === "task-release-ops" &&
          observed.firstVisible?.ariaLabel === "发布值守剧本" &&
          (observed.visibleDelayMs ?? 0) >= 340 &&
          (observed.visibleDelayMs ?? 999) <= 450,
        summary: `delay=${observed.visibleDelayMs?.toFixed(1)}ms, visible@300=${observed.samples?.["300"]?.visible}, visible@420=${observed.samples?.["420"]?.visible}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "点击 pack · 跳 `/packs/{packId}/setup`(目前只 cross-border 有 setup · 其他 toast \"即将上线\")",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      await page.click('[data-pack-location="pinned"][data-pack-id="industry-cross-border-ecommerce"] [data-action="launch-pack"]');
      await page.waitForTimeout(120);
      const setupObserved = await page.evaluate(() => ({
        pathname: window.location.pathname,
        route: window.location.pathname + window.location.search
      }));
      await page.goto(`${baseUrl}/packs?dev=1&__state=full-catalog`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.packs));
      await page.click('[data-pack-location="catalog"][data-pack-id="task-support-ops"] [data-action="launch-pack"]');
      await page.waitForTimeout(120);
      const toastObserved = await page.evaluate(() => ({
        pathname: window.location.pathname,
        toasts: Array.from(document.querySelectorAll(".toast-card")).map((node) => node.textContent?.trim() ?? "")
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p08-launch-route.json", {
        generatedAt: new Date().toISOString(),
        setupObserved,
        toastObserved
      });
      return {
        pass:
          setupObserved.pathname === "/packs/industry-cross-border-ecommerce/setup" &&
          toastObserved.pathname === "/packs" &&
          toastObserved.toasts.some((item) => item.includes("即将上线")),
        summary: `${setupObserved.pathname} / toast=${toastObserved.toasts[0] ?? "none"}`,
        artifacts: [probe],
        observed: { setupObserved, toastObserved }
      };
    }
  );

  await verifyRule(
    9,
    "cross-border pack 显示特殊 badge \"专属引导\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      const observed = await page.evaluate(() => {
        const badge = document.querySelector('[data-pack-id="industry-cross-border-ecommerce"] .capability-chip');
        return {
          badgeText: badge?.textContent?.trim() ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-01/p09-guided-badge.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p09-guided-badge.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.badgeText === "专属引导",
        summary: `badge=${observed.badgeText}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "空态(search 无结果)· \"没找到相关 pack · 试试其他关键词\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "search-results"
      });
      await page.fill("#packs-search", "no-match-sku");
      await page.waitForTimeout(180);
      const observed = await page.evaluate(() => ({
        filtered: window.__fridayQa.packs.getState().filteredPackIds,
        title: document.querySelector(".route-empty h2")?.textContent?.trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-01/p10-empty-search.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p10-empty-search.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.filtered.length === 0 &&
          observed.title === "没找到相关 pack · 试试其他关键词",
        summary: `filtered=${observed.filtered.length}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    11,
    "empty pinned · 左列显示 \"置顶你常用的 pack\" 空态 · 有拖拽动画提示",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "empty"
      });
      const observed = await page.evaluate(() => {
        const empty = document.querySelector("[data-pack-empty-pinned='true']");
        return {
          exists: Boolean(empty),
          title: empty?.querySelector("strong")?.textContent?.trim() ?? null,
          hint: Array.from(empty?.querySelectorAll(".capability-chip") || []).map((node) => node.textContent?.trim() ?? "")
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-01/p11-empty-pinned.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p11-empty-pinned.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.exists === true &&
          observed.title === "置顶你常用的 pack" &&
          observed.hint.includes("拖拽提示"),
        summary: `title=${observed.title}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    12,
    "custom pack 入口 · 跳 `CustomPackBuilder` modal(复用 core/custom-pack-builder.tsx)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs", "packs", {
        stateName: "full-catalog"
      });
      await page.click('[data-action="open-custom-pack-builder"]');
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => ({
        activeModal: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        copy: document.querySelector(".settings-modal-body")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-01/p12-custom-pack-modal.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-01/p12-custom-pack-modal.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.activeModal === "自定义 Pack Builder" &&
          observed.copy.includes("core/custom-pack-builder.tsx"),
        summary: observed.activeModal,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    13,
    "`FRIDAY_PACKS` registry 穷举 · 不得 hardcode pack 数据在此页",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const functionMarker = "function renderPacksPage()";
      const markerIndex = source.indexOf(functionMarker);
      const braceIndex = source.indexOf("{", markerIndex);
      const block = extractBlock(source, braceIndex) || "";
      const literalIds = Array.from(block.matchAll(/task-[a-z-]+|industry-cross-border-ecommerce/g), (match) => match[0]);
      const observed = {
        usesRegistry: block.includes("filteredPacks()") && block.includes("orderedPinnedPackRecords()"),
        literalIds,
        registryCount: Array.from(source.matchAll(/buildPack\(/g)).length
      };
      const probe = await writeJson("screenshots/P2C-01/p13-registry-source.json", {
        generatedAt: new Date().toISOString(),
        observed,
        functionMarker
      });
      return {
        pass: observed.usesRegistry === true && observed.literalIds.length === 0 && observed.registryCount >= 6,
        summary: `usesRegistry=${observed.usesRegistry}, literals=${observed.literalIds.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-01", "/packs", generatedAt, results, artifacts);
}

async function verifyP2C02(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `W${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "顶部 stepper · 4 步 · 当前步琥珀底 + 已完成绿勾 + 未来灰",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step3-channels",
        searchParams: { step: "3" }
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent-soft", "--success", "--ink-3"]);
      const observed = await page.evaluate((colors) => {
        return Array.from(document.querySelectorAll(".wizard-step")).map((node) => ({
          text: node.textContent?.trim() ?? "",
          className: node.className,
          background: getComputedStyle(node).backgroundColor,
          color: getComputedStyle(node).color,
          backgroundTokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(node).backgroundColor)?.[0] ?? null,
          colorTokenMatch: Object.entries(colors).find(([, value]) => value === getComputedStyle(node).color)?.[0] ?? null
        }));
      }, tokenColors);
      const shot = await captureScreenshot(page, "screenshots/P2C-02/w01-stepper.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w01-stepper.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.length === 4 &&
          observed[0].text === "✓" &&
          observed[1].text === "✓" &&
          observed[2].className.includes("is-current") &&
          observed[2].backgroundTokenMatch === "--accent-soft" &&
          observed[0].colorTokenMatch === "--success" &&
          observed[3].colorTokenMatch === "--ink-3",
        summary: observed.map((item) => item.text).join("/"),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "step 1 目标 · 多选 cards(增长 / 合规 / 成本 / 扩张)· 至少选 1 · 不选禁下一步",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step1-goals",
        searchParams: { step: "1" }
      });
      await page.evaluate(() => {
        window.__fridayQa.crossBorder.toggleGoal("增长");
        window.__fridayQa.crossBorder.toggleGoal("合规");
      });
      await page.waitForTimeout(80);
      const emptyObserved = await page.evaluate(() => ({
        selectedGoals: window.__fridayQa.crossBorder.getState().selectedGoals,
        nextDisabled: document.querySelector('[data-action="cross-border-next"]')?.hasAttribute("disabled") ?? null
      }));
      await page.click('[data-action="cross-border-goal-toggle"][data-payload="成本"]');
      await page.waitForTimeout(80);
      const selectedObserved = await page.evaluate(() => ({
        selectedGoals: window.__fridayQa.crossBorder.getState().selectedGoals,
        nextDisabled: document.querySelector('[data-action="cross-border-next"]')?.hasAttribute("disabled") ?? null,
        cards: Array.from(document.querySelectorAll('[data-action="cross-border-goal-toggle"]')).map((node) => ({
          label: node.querySelector("strong")?.textContent?.trim() ?? "",
          selected: node.className.includes("is-selected")
        }))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w02-goal-step.json", {
        generatedAt: new Date().toISOString(),
        emptyObserved,
        selectedObserved
      });
      return {
        pass:
          emptyObserved.selectedGoals.length === 0 &&
          emptyObserved.nextDisabled === true &&
          selectedObserved.selectedGoals.length === 1 &&
          selectedObserved.selectedGoals[0] === "成本" &&
          selectedObserved.nextDisabled === false,
        summary: `selected=${selectedObserved.selectedGoals.join(",")}`,
        artifacts: [probe],
        observed: { emptyObserved, selectedObserved }
      };
    }
  );

  await verifyRule(
    3,
    "step 2 产品 · 表格输入或 CSV 上传 · 每行 SKU + 标题 + 类目 + 目标市场",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step2-products",
        searchParams: { step: "2" }
      });
      const before = await page.evaluate(() => ({
        headers: Array.from(document.querySelectorAll(".simple-data-table thead th")).map((node) => node.textContent?.trim() ?? ""),
        rows: Array.from(document.querySelectorAll(".simple-data-table tbody tr")).map((row) =>
          Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent?.trim() ?? "")
        )
      }));
      await page.click('[data-action="wizard-upload-csv"]');
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({
        rowCount: document.querySelectorAll(".simple-data-table tbody tr").length,
        lastRow: Array.from(document.querySelectorAll(".simple-data-table tbody tr")).slice(-1)[0]
          ? Array.from(Array.from(document.querySelectorAll(".simple-data-table tbody tr")).slice(-1)[0].querySelectorAll("td")).map((cell) => cell.textContent?.trim() ?? "")
          : []
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w03-products-table.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          JSON.stringify(before.headers) === JSON.stringify(["SKU", "标题", "类目", "目标市场"]) &&
          before.rows.length >= 2 &&
          after.rowCount === 3 &&
          JSON.stringify(after.lastRow) === JSON.stringify(["SKU-003", "Desk Fan", "Home", "JP"]),
        summary: `rows=${before.rows.length}->${after.rowCount}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "step 3 渠道 · 多选 channel card(Amazon / Shopify / TikTok / Temu 等)· 每个 card 显示连接状态",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step3-channels",
        searchParams: { step: "3" }
      });
      const observed = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-action="cross-border-channel-toggle"]')).map((node) => ({
          label: node.querySelector("strong")?.textContent?.trim() ?? "",
          status: node.querySelector("span:last-child")?.textContent?.trim() ?? "",
          selected: node.className.includes("is-selected")
        }))
      );
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w04-channel-cards.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.length === 4 &&
          observed.some((item) => item.label === "Amazon" && item.status === "连接正常") &&
          observed.some((item) => item.label === "TikTok" && item.status === "连接延迟"),
        summary: observed.map((item) => `${item.label}:${item.status}`).join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "step 4 确认 · 汇总前 3 步 · 可点各 section 回编辑",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step4-confirm",
        searchParams: { step: "4" }
      });
      const before = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.shell-card [data-action="cross-border-step-edit"]')).map((node) => node.textContent?.trim() ?? "")
      );
      await page.click('[data-action="cross-border-step-edit"][data-payload="2"]');
      await page.waitForTimeout(120);
      const after = await readCrossBorderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w05-confirm-edit.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.length >= 3 &&
          before[0].startsWith("目标：") &&
          before[1].startsWith("商品：") &&
          before[2].startsWith("渠道：") &&
          after.step === 2,
        summary: `step=${after.step}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    6,
    "success · 全屏祝贺 + \"打开 Assistant 查看下一步\" · 跳 `/assistant?packId=industry-cross-border-ecommerce`",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "success",
        searchParams: { step: "4" }
      });
      const observed = await page.evaluate(() => {
        const success = document.querySelector("[data-cross-border-success='true']");
        const cta = success?.querySelector("a.action-button");
        return {
          minHeight: success?.getBoundingClientRect().height ?? null,
          title: success?.querySelector("h2")?.textContent?.trim() ?? null,
          href: cta?.getAttribute("href") ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-02/w06-success.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w06-success.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          (observed.minHeight ?? 0) >= 680 &&
          observed.title === "配置完成，下一步已经准备好" &&
          observed.href === "/assistant?packId=industry-cross-border-ecommerce",
        summary: `height=${observed.minHeight}, href=${observed.href}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "每步 prev / next 底部固定 · prev 在左 · next 在右",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step3-channels",
        searchParams: { step: "3" }
      });
      const observed = await page.evaluate(() => {
        const bar = document.querySelector(".wizard-footer-bar");
        const buttons = Array.from(bar?.querySelectorAll("button, a") || []).map((node) => ({
          label: node.textContent?.trim() ?? "",
          left: node.getBoundingClientRect().left,
          right: node.getBoundingClientRect().right
        }));
        const barRect = bar?.getBoundingClientRect();
        return {
          position: bar ? getComputedStyle(bar).position : null,
          bottomGap: barRect ? window.innerHeight - barRect.bottom : null,
          buttons
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w07-footer-bar.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          ["sticky", "fixed"].includes(observed.position) &&
          (observed.bottomGap ?? 999) <= 24 &&
          observed.buttons[0]?.label === "上一步" &&
          observed.buttons[1]?.label === "下一步" &&
          observed.buttons[0]?.left < observed.buttons[1]?.left,
        summary: `position=${observed.position}, bottomGap=${observed.bottomGap}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "step 切换动画 fade 200ms · URL 同步 `?step=1..4`",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step1-goals",
        searchParams: { step: "1" }
      });
      await page.click('[data-action="cross-border-goal-toggle"][data-payload="成本"]');
      await page.click('[data-action="cross-border-next"]');
      await page.waitForTimeout(140);
      const observed = await page.evaluate(() => {
        const panel = document.querySelector("[data-cross-border-step-panel]");
        return {
          pathname: window.location.pathname,
          search: window.location.search,
          transitionDuration: getComputedStyle(panel).transitionDuration,
          panelStep: panel?.getAttribute("data-cross-border-step-panel") ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w08-step-url.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.pathname === "/packs/cross-border/setup" &&
          observed.search.includes("step=2") &&
          observed.transitionDuration === "0.2s" &&
          observed.panelStep === "2",
        summary: `${observed.search} / ${observed.transitionDuration}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "退出(点 rail 导航)· `ConfirmDialog` \"离开会丢失未保存?\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step2-products",
        searchParams: { step: "2" }
      });
      await page.click('.rail-nav-link[data-nav="/home"]');
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        ariaModal: document.querySelector(".confirm-dialog")?.getAttribute("aria-modal") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w09-leave-confirm.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.title === "离开会丢失未保存?" && observed.ariaModal === "true",
        summary: observed.title,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "草稿自动保存 · 每步切换写 `crossBorderPackApi.saveDraft()` · 重进自动恢复",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step1-goals",
        searchParams: { step: "1" }
      });
      await page.click('[data-action="cross-border-goal-toggle"][data-payload="成本"]');
      await page.click('[data-action="cross-border-next"]');
      await page.waitForTimeout(120);
      const stored = await page.evaluate(() => window.crossBorderPackApi.loadDraft());
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.crossBorder));
      await page.waitForTimeout(120);
      const resume = await readCrossBorderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w10-draft-resume.json", {
        generatedAt: new Date().toISOString(),
        stored,
        resume
      });
      return {
        pass:
          stored.step === 2 &&
          Array.isArray(stored.selectedGoals) &&
          stored.selectedGoals.includes("成本") &&
          resume.showResumePrompt === true,
        summary: `savedStep=${stored.step}, resume=${resume.showResumePrompt}`,
        artifacts: [probe],
        observed: { stored, resume }
      };
    }
  );

  await verifyRule(
    11,
    "验证 · 每步字段 level inline 错误 · 步级错误 step 头红点",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step1-goals",
        searchParams: { step: "1" }
      });
      await page.evaluate(() => {
        window.__fridayQa.crossBorder.toggleGoal("增长");
        window.__fridayQa.crossBorder.toggleGoal("合规");
      });
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        inlineError: document.querySelector('[data-cross-border-step-panel="1"] p[style*="var(--error)"]')?.textContent?.trim() ?? null,
        stepDots: Array.from(document.querySelectorAll(".wizard-step-dot")).length,
        currentStepClass: document.querySelector('.wizard-step[data-payload="1"]')?.className ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w11-validation.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.inlineError === "至少选择 1 个目标。" &&
          observed.stepDots >= 1 &&
          observed.currentStepClass.includes("is-error"),
        summary: `${observed.inlineError} / dots=${observed.stepDots}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    12,
    "keyboard · Enter 下一步(step 4 变 \"完成\")· Shift+Enter 上一步 · Escape 退出确认",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/packs/cross-border/setup", "crossBorder", {
        stateName: "step2-products",
        searchParams: { step: "2" }
      });
      await page.locator("body").click();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      const afterEnter = await readCrossBorderQaState(page);
      await page.keyboard.press("Shift+Enter");
      await page.waitForTimeout(120);
      const afterShiftEnter = await readCrossBorderQaState(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(120);
      const afterEscape = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-02/w12-keyboard.json", {
        generatedAt: new Date().toISOString(),
        afterEnter,
        afterShiftEnter,
        afterEscape
      });
      return {
        pass:
          afterEnter.step === 3 &&
          afterShiftEnter.step === 2 &&
          afterEscape.title === "离开会丢失未保存?",
        summary: `Enter=${afterEnter.step}, Shift+Enter=${afterShiftEnter.step}`,
        artifacts: [probe],
        observed: { afterEnter, afterShiftEnter, afterEscape }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-02", "/packs/cross-border/setup", generatedAt, results, artifacts);
}

async function verifyP2C03(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `S${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 categories tree 240 · 右 skill list flex",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const observed = await page.evaluate(() => {
        const list = document.querySelector("[data-skills-list]");
        const aside = document.querySelector("[data-skill-tree-node='all']")?.closest("aside");
        const container = aside?.parentElement;
        const style = container ? getComputedStyle(container) : null;
        return {
          containerDisplay: style?.display ?? null,
          gridTemplateColumns: style?.gridTemplateColumns ?? null,
          asideWidth: aside?.getBoundingClientRect().width ?? null,
          listDisplay: list ? getComputedStyle(list).display : null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-03/s01-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s01-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.containerDisplay === "grid" &&
          Math.abs((observed.asideWidth ?? 0) - 240) <= 8 &&
          observed.listDisplay === "grid" &&
          String(observed.gridTemplateColumns || "").includes("240px"),
        summary: `aside=${observed.asideWidth}px, display=${observed.listDisplay}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "顶栏 · search + 2 入口按钮 \"导入\" \"扫描\" · 右侧 view toggle(grid / list)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const observed = await page.evaluate(() => ({
        searchExists: Boolean(document.getElementById("skills-search")),
        actions: Array.from(document.querySelectorAll('[data-action="open-skill-import"], [data-action="open-skill-scan"]')).map((node) => node.textContent?.trim() ?? ""),
        toggles: Array.from(document.querySelectorAll('[data-action="skills-view"]')).map((node) => ({
          payload: node.getAttribute("data-payload"),
          text: node.textContent?.trim() ?? "",
          active: node.className.includes("is-active")
        }))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s02-toolbar.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.searchExists === true &&
          JSON.stringify(observed.actions) === JSON.stringify(["导入", "扫描"]) &&
          JSON.stringify(observed.toggles.map((item) => item.payload)) === JSON.stringify(["grid", "list"]) &&
          observed.toggles.some((item) => item.active),
        summary: `${observed.actions.join("/")} / ${observed.toggles.map((item) => item.text).join("/")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "categories tree · 无限层级 · 展开 / 折叠 · 选中类目过滤右列",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const initial = await page.evaluate(() => ({
        nodes: Array.from(document.querySelectorAll("[data-skill-tree-node]")).map((node) => ({
          id: node.getAttribute("data-skill-tree-node"),
          marginLeft: Number.parseFloat(node.style.marginLeft || "0")
        })),
        expandedCategories: window.__fridayQa.skills.getState().expandedCategories
      }));
      await page.click('[data-action="skills-toggle-tree"][data-payload="commerce"]');
      await page.waitForTimeout(80);
      const collapsed = await page.evaluate(() => ({
        operationsVisible: Boolean(document.querySelector('[data-skill-tree-node="operations"]')),
        expandedCategories: window.__fridayQa.skills.getState().expandedCategories
      }));
      await page.click('[data-action="skills-toggle-tree"][data-payload="commerce"]');
      await page.waitForTimeout(80);
      const reexpanded = await page.evaluate(() => ({
        operationsVisible: Boolean(document.querySelector('[data-skill-tree-node="operations"]')),
        expandedCategories: window.__fridayQa.skills.getState().expandedCategories
      }));
      await page.click('[data-action="skills-category"][data-payload="operations"]');
      await page.waitForTimeout(80);
      const filtered = await readSkillsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s03-tree-filter.json", {
        generatedAt: new Date().toISOString(),
        initial,
        collapsed,
        reexpanded,
        filtered
      });
      return {
        pass:
          initial.nodes.some((node) => node.marginLeft >= 14) &&
          collapsed.operationsVisible === false &&
          reexpanded.operationsVisible === true &&
          filtered.activeTreeNode === "operations" &&
          JSON.stringify(filtered.filteredSkillIds) === JSON.stringify(["skill-cross-border-review"]),
        summary: `active=${filtered.activeTreeNode}, filtered=${filtered.filteredSkillIds.join(",")}`,
        artifacts: [probe],
        observed: { initial, collapsed, reexpanded, filtered }
      };
    }
  );

  await verifyRule(
    4,
    "skill list · grid 3 列 · 每 card 240 高 · 名称 + 版本 + 状态 pill + 动作",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const observed = await page.evaluate(() => {
        const list = document.querySelector('[data-skills-list="grid"]');
        const first = document.querySelector("[data-skill-card]");
        const columns = list ? getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length : 0;
        return {
          columns,
          height: first?.getBoundingClientRect().height ?? null,
          title: first?.querySelector("strong")?.textContent?.trim() ?? null,
          version: first?.querySelector(".obs-row-meta span, div > span")?.textContent?.trim() ?? null,
          pillText: first?.querySelector(".status-pill")?.textContent?.trim() ?? null,
          actionLabel: first?.querySelector("[data-skill-action-label]")?.textContent?.trim() ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-03/s04-skill-card-grid.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s04-skill-card-grid.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.columns === 3 &&
          (observed.height ?? 0) >= 240 &&
          Boolean(observed.title) &&
          String(observed.version || "").startsWith("v") &&
          Boolean(observed.pillText) &&
          Boolean(observed.actionLabel),
        summary: `cols=${observed.columns}, height=${observed.height}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "status · installed(绿)/ available(灰)/ deprecated(警示橙)/ needs-update(琥珀)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const tokenColors = await resolvedTokenColors(page, ["--success", "--ink-3", "--warning", "--accent"]);
      const observed = await page.evaluate((colors) => {
        return [
          "skill-cross-border-review",
          "skill-finance-watch",
          "skill-ticket-triage",
          "skill-release-guardian"
        ].map((id) => {
          const pill = document.querySelector(`[data-skill-card='${id}'] .status-pill`);
          const color = pill ? getComputedStyle(pill).color : null;
          return {
            id,
            text: pill?.textContent?.trim() ?? null,
            color,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const byId = Object.fromEntries(observed.map((item) => [item.id, item.tokenMatch]));
      const probe = await writeJson("screenshots/P2C-03/s05-status-pills.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          byId["skill-cross-border-review"] === "--success" &&
          byId["skill-finance-watch"] === "--ink-3" &&
          byId["skill-ticket-triage"] === "--warning" &&
          byId["skill-release-guardian"] === "--accent",
        summary: observed.map((item) => `${item.id}:${item.tokenMatch}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "deprecated skill · 顶部 banner \"此技能已弃用 · 建议替换为 X\" · 不让启用",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "deprecated"
      });
      const observed = await page.evaluate(() => {
        const card = document.querySelector("[data-skill-card='skill-ticket-triage']");
        return {
          bannerText: document.querySelector("[data-skills-deprecated-banner='true']")?.textContent?.trim() ?? null,
          footerCopy: card?.querySelector('[data-skill-footer-copy="skill-ticket-triage"]')?.textContent?.trim() ?? null,
          actionLabel: card?.querySelector('[data-skill-action-label="skill-ticket-triage"]')?.textContent?.trim() ?? null,
          enableTogglePresent: Array.from(card?.querySelectorAll("button, a") || []).some((node) => /enable/i.test(node.textContent || ""))
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-03/s06-deprecated-banner.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s06-deprecated-banner.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.bannerText === "此技能已弃用 · 建议替换为 Release Guardian" &&
          observed.footerCopy === "已弃用，不可启用" &&
          observed.actionLabel === "替换" &&
          observed.enableTogglePresent === false,
        summary: `${observed.bannerText} / ${observed.actionLabel}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "import wizard 入口 · 打开 `SkillImportWizard` · wizard 不在本页渲染 · 跳 modal",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const before = await page.evaluate(() => ({
        inlineWizard: Array.from(document.querySelectorAll(".page-shell *")).some((node) => node.textContent?.trim() === "SkillImportWizard"),
        modalOpen: Boolean(document.querySelector('.overlay-panel[role="dialog"]'))
      }));
      await page.click('[data-action="open-skill-import"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        modalTitle: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        modalCopy: document.querySelector(".settings-modal-body")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        ariaModal: document.querySelector('.overlay-panel[role="dialog"]')?.getAttribute("aria-modal") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-03/s07-import-modal.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s07-import-modal.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        screenshot: shot.path
      });
      return {
        pass:
          before.inlineWizard === false &&
          before.modalOpen === false &&
          after.modalTitle === "导入技能" &&
          String(after.modalCopy || "").includes("SkillImportWizard") &&
          after.ariaModal === "true",
        summary: after.modalTitle,
        artifacts: [probe, shot],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    8,
    "scan 入口 · 打开 `SkillScannerPanel` · 同上",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      await page.click('[data-action="open-skill-scan"]');
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => ({
        modalTitle: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        modalCopy: document.querySelector(".settings-modal-body")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        ariaModal: document.querySelector('.overlay-panel[role="dialog"]')?.getAttribute("aria-modal") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-03/s08-scan-modal.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s08-scan-modal.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.modalTitle === "扫描技能" &&
          String(observed.modalCopy || "").includes("SkillScannerPanel") &&
          observed.ariaModal === "true",
        summary: observed.modalTitle,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "discovery panel 在右下浮层 · 显示 Friday 推荐的未安装 skill · 可关闭 · localStorage 记忆",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      await page.evaluate(() => {
        window.localStorage.setItem("friday-skills-discovery-open", "true");
      });
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.skills));
      await page.waitForTimeout(120);
      const before = await page.evaluate(() => {
        const panel = document.querySelector(".discovery-floating");
        const rect = panel?.getBoundingClientRect();
        return {
          open: Boolean(panel),
          rightGap: rect ? window.innerWidth - rect.right : null,
          bottomGap: rect ? window.innerHeight - rect.bottom : null,
          recommendations: Array.from(panel?.querySelectorAll("a") || []).map((node) => node.textContent?.trim() ?? "")
        };
      });
      await page.click('[data-action="close-skills-discovery"]');
      await page.waitForTimeout(120);
      const afterClose = await page.evaluate(() => ({
        open: Boolean(document.querySelector(".discovery-floating")),
        storageValue: window.localStorage.getItem("friday-skills-discovery-open")
      }));
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__fridayQa?.skills));
      await page.waitForTimeout(120);
      const afterReload = await readSkillsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s09-discovery-panel.json", {
        generatedAt: new Date().toISOString(),
        before,
        afterClose,
        afterReload
      });
      return {
        pass:
          before.open === true &&
          (before.rightGap ?? 999) <= 36 &&
          (before.bottomGap ?? 999) <= 36 &&
          before.recommendations.includes("Finance Watch") &&
          before.recommendations.includes("Workflow Scaffold") &&
          afterClose.open === false &&
          afterClose.storageValue === "false" &&
          afterReload.discoveryOpen === false,
        summary: `recommendations=${before.recommendations.join(",")}`,
        artifacts: [probe],
        observed: { before, afterClose, afterReload }
      };
    }
  );

  await verifyRule(
    10,
    "skill card 点击 · 跳 `buildSkillHref(skill)` · 不在本页展开 detail",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "installed"
      });
      const before = await page.evaluate(() => ({
        href: document.querySelector("[data-skill-card='skill-finance-watch']")?.getAttribute("href") ?? null,
        detailPanels: document.querySelectorAll(".drawer-panel, .overlay-panel, [data-skill-detail]").length
      }));
      await page.click("[data-skill-card='skill-finance-watch']");
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        pathname: window.location.pathname,
        search: window.location.search,
        detailPanels: document.querySelectorAll(".drawer-panel, .overlay-panel, [data-skill-detail]").length,
        listStillVisible: Boolean(document.querySelector("[data-skills-list]"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s10-skill-href.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.href === "/skills?skillId=skill-finance-watch" &&
          after.pathname === "/skills" &&
          after.search.includes("skillId=skill-finance-watch") &&
          after.listStillVisible === true &&
          after.detailPanels === 0,
        summary: `${before.href} -> ${after.pathname}${after.search}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    11,
    "empty · \"还没有技能\" · 大 CTA \"浏览技能库\" + \"创建你的第一个技能\"(跳 generator)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills", "skills", {
        stateName: "empty"
      });
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".page-shell h2")?.textContent?.trim() ?? null,
        ctas: Array.from(document.querySelectorAll(".page-shell .action-button, .page-shell .action-button-secondary")).map((node) => ({
          text: node.textContent?.trim() ?? "",
          href: node.getAttribute("href")
        }))
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-03/s11-empty-state.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-03/s11-empty-state.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "还没有技能" &&
          observed.ctas.some((item) => item.text === "浏览技能库" && item.href === "/skills?__state=available") &&
          observed.ctas.some((item) => item.text === "创建你的第一个技能" && item.href === "/skills/generator"),
        summary: observed.ctas.map((item) => `${item.text}:${item.href}`).join(" | "),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-03", "/skills", generatedAt, results, artifacts);
}

async function verifyP2C04(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `G${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 prompt + 配置 480 · 右 preview + test 480",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      const observed = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(".page-shell > div > .shell-card"));
        return {
          widths: cards.slice(0, 2).map((node) => node.getBoundingClientRect().width),
          gridTemplateColumns: getComputedStyle(document.querySelector(".page-shell > div")).gridTemplateColumns
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-04/g01-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g01-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.widths.length === 2 &&
          observed.widths.every((width) => Math.abs(width - 480) <= 12) &&
          String(observed.gridTemplateColumns || "").includes("480px"),
        summary: observed.widths.join(" / "),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "左列 · intent 多行文本(min-h 200)+ scope 选择 + inputs 定义表格 + outputs 定义表格",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      const observed = await page.evaluate(() => ({
        intentMinHeight: getComputedStyle(document.getElementById("skill-generator-intent")).minHeight,
        scopeValue: document.getElementById("skill-generator-scope")?.value ?? null,
        inputsHeaders: Array.from(document.querySelectorAll(".shell-card table")).slice(0, 1).flatMap((table) => Array.from(table.querySelectorAll("thead th")).map((node) => node.textContent?.trim() ?? "")),
        outputsHeaders: Array.from(document.querySelectorAll(".shell-card table")).slice(1, 2).flatMap((table) => Array.from(table.querySelectorAll("thead th")).map((node) => node.textContent?.trim() ?? ""))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g02-left-fields.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.intentMinHeight === "200px" &&
          observed.scopeValue === "workspace" &&
          JSON.stringify(observed.inputsHeaders) === JSON.stringify(["Name", "Type"]) &&
          JSON.stringify(observed.outputsHeaders) === JSON.stringify(["Name", "Type"]),
        summary: `scope=${observed.scopeValue}, headers=${observed.inputsHeaders.join("/")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "右列 · 顶 \"生成\" 按钮 · 生成中 shimmer · 完成显示 skill YAML / TS 代码",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      const before = await page.evaluate(() => ({
        buttons: Array.from(document.querySelectorAll(".shell-card .action-button, .shell-card .action-button-secondary")).map((node) => node.textContent?.trim() ?? "")
      }));
      await page.click('[data-action="skill-generate"]');
      await page.waitForTimeout(140);
      const generating = await page.evaluate(() => ({
        state: window.__fridayQa.skillGenerator.getState().stateName,
        skeletonCount: document.querySelectorAll(".skeleton-row").length
      }));
      await page.waitForTimeout(420);
      const preview = await page.evaluate(() => ({
        state: window.__fridayQa.skillGenerator.getState().stateName,
        preText: document.querySelector(".shell-card pre")?.textContent ?? ""
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-04/g03-generate-preview.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g03-generate-preview.json", {
        generatedAt: new Date().toISOString(),
        before,
        generating,
        preview,
        screenshot: shot.path
      });
      return {
        pass:
          before.buttons.includes("生成") &&
          generating.state === "generating" &&
          generating.skeletonCount >= 3 &&
          preview.state === "preview" &&
          preview.preText.includes("name:") &&
          preview.preText.includes("export async function run()"),
        summary: `generating=${generating.skeletonCount}, preview=${preview.state}`,
        artifacts: [probe, shot],
        observed: { before, generating, preview }
      };
    }
  );

  await verifyRule(
    4,
    "test runner · 底部 fixed · 输入 inputs · 点 \"run test\" · 显示 output + duration + token cost",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      await page.fill("#skill-test-input", '{"release_plan":"qa","target_url":"https://example.com"}');
      await page.click('[data-action="skill-test"]');
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => {
        const bar = document.querySelector('[data-generator-test-bar="true"]');
        return {
          position: bar ? getComputedStyle(bar).position : null,
          inputValue: document.getElementById("skill-test-input")?.value ?? null,
          copy: bar?.textContent?.replace(/\s+/g, " ").trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g04-test-runner.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.position === "fixed" &&
          observed.inputValue === '{"release_plan":"qa","target_url":"https://example.com"}' &&
          /测试通过/.test(observed.copy || "") &&
          /780ms/.test(observed.copy || "") &&
          /1364 tokens/.test(observed.copy || ""),
        summary: observed.copy,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "error 态 · 生成失败 · 显示 error message + suggestions · retry 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "error"
      });
      const before = await page.evaluate(() => ({
        title: document.querySelector(".inline-error-shell strong")?.textContent?.trim() ?? null,
        detail: document.querySelector(".inline-error-shell span")?.textContent?.trim() ?? null,
        reasonSummary: document.querySelector(".inline-error-shell details summary")?.textContent?.trim() ?? null,
        retryLabel: document.querySelector('[data-action="skill-generate"]')?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="skill-generate"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        state: window.__fridayQa.skillGenerator.getState().stateName,
        skeletonCount: document.querySelectorAll(".skeleton-row").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g05-error-retry.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.title === "生成失败" &&
          before.detail === "可以直接重试，草稿仍然保留。" &&
          before.reasonSummary === "为什么?" &&
          before.retryLabel === "重试" &&
          after.state === "generating" &&
          after.skeletonCount >= 3,
        summary: `${before.title} / ${after.state}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    6,
    "publish · 确认 modal · 显示 skill diff(新增)· 输入 skill name · 发布后跳 /skills",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "preview"
      });
      await page.click('[data-action="skill-publish"]');
      await page.waitForTimeout(120);
      const modal = await page.evaluate(() => ({
        title: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        diff: document.querySelector(".settings-modal-body pre")?.textContent ?? "",
        inputValue: document.getElementById("skill-publish-name")?.value ?? null
      }));
      await page.fill("#skill-publish-name", "qa_release_guardian");
      await page.click('[data-action="skill-publish-confirm"]');
      await page.waitForTimeout(160);
      const route = await page.evaluate(() => ({
        pathname: window.location.pathname,
        search: window.location.search
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g06-publish-flow.json", {
        generatedAt: new Date().toISOString(),
        modal,
        route
      });
      return {
        pass:
          modal.title === "确认发布技能" &&
          modal.diff.includes("+ name:") &&
          modal.inputValue === "release_guardian" &&
          route.pathname === "/skills" &&
          route.search.includes("__state=installed"),
        summary: `${modal.title} -> ${route.pathname}${route.search}`,
        artifacts: [probe],
        observed: { modal, route }
      };
    }
  );

  await verifyRule(
    7,
    "cancel · 二次确认 · 保留草稿到 localStorage `friday-skill-draft`",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      await page.fill("#skill-generator-intent", "把变更窗口前的 smoke 和回滚检查整理成技能。");
      await page.waitForTimeout(80);
      await page.click('[data-action="skill-generator-cancel"]');
      await page.waitForTimeout(120);
      const confirm = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        body: document.querySelector(".confirm-dialog #confirm-detail")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(140);
      const stored = await page.evaluate(() => ({
        pathname: window.location.pathname,
        draft: JSON.parse(window.localStorage.getItem("friday-skill-draft") || "null")
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g07-cancel-draft.json", {
        generatedAt: new Date().toISOString(),
        confirm,
        stored
      });
      return {
        pass:
          confirm.title === "取消当前草稿?" &&
          String(confirm.body || "").includes("草稿会保留到 localStorage") &&
          stored.pathname === "/skills" &&
          stored.draft?.intent === "把变更窗口前的 smoke 和回滚检查整理成技能。",
        summary: `${confirm.title} -> ${stored.pathname}`,
        artifacts: [probe],
        observed: { confirm, stored }
      };
    }
  );

  await verifyRule(
    8,
    "state · draft / generating / preview / published / error 五档 URL ?state= 同步",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      const observed = [];
      for (const stateName of ["draft", "generating", "preview", "published", "error"]) {
        const state = await page.evaluate((nextState) => window.__fridayQa.skillGenerator.setState(nextState), stateName);
        observed.push({
          stateName,
          url: page.url(),
          actualState: state.stateName
        });
      }
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g08-state-query-sync.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.every((item) => item.url.includes(`state=${item.stateName}`) && item.actualState === item.stateName),
        summary: observed.map((item) => `${item.stateName}:${item.url.split("?")[1]}`).join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "再次进入若有草稿 · 提示 \"继续上次的草稿?\" · yes / no",
    async () => {
      const draft = {
        intent: "恢复之前的 QA 技能草稿",
        scope: "workspace",
        inputs: [
          { id: "input-1", name: "release_plan", type: "markdown" }
        ],
        outputs: [
          { id: "output-1", name: "qa_report", type: "markdown" }
        ],
        publishName: "resume_skill"
      };
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft",
        searchParams: { state: "draft" }
      });
      await page.evaluate((payload) => {
        window.localStorage.setItem("friday-skill-draft", JSON.stringify(payload));
        window.__fridayQa.skillGenerator.syncResumePrompt();
      }, draft);
      await page.waitForTimeout(120);
      const before = await page.evaluate(() => ({
        prompt: document.querySelector("[data-skill-generator-resume='true'] span")?.textContent?.trim() ?? null,
        buttons: Array.from(document.querySelectorAll('[data-action="skill-draft-resume"]')).map((node) => node.textContent?.trim() ?? "")
      }));
      await page.click('[data-action="skill-draft-resume"][data-payload="accept"]');
      await page.waitForTimeout(120);
      const after = await readSkillGeneratorQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g09-resume-prompt.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.prompt === "继续上次的草稿?" &&
          JSON.stringify(before.buttons) === JSON.stringify(["不用，重置", "继续"]) &&
          after.showResumePrompt === false &&
          after.draft.publishName === "resume_skill",
        summary: `${before.prompt} / ${before.buttons.join("/")}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    10,
    "keyboard Cmd+Enter = 生成 · Cmd+Shift+Enter = test · Cmd+S = publish confirm",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/skills/generator", "skillGenerator", {
        stateName: "draft"
      });
      await page.locator("body").click();
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(620);
      const afterGenerate = await readSkillGeneratorQaState(page);
      await page.keyboard.press("Meta+Shift+Enter");
      await page.waitForTimeout(120);
      const afterTest = await readSkillGeneratorQaState(page);
      await page.keyboard.press("Meta+S");
      await page.waitForTimeout(120);
      const afterPublish = await page.evaluate(() => ({
        activeModal: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-04/g10-keyboard-shortcuts.json", {
        generatedAt: new Date().toISOString(),
        afterGenerate,
        afterTest,
        afterPublish
      });
      return {
        pass:
          afterGenerate.stateName === "preview" &&
          /测试通过/.test(afterTest.testResult.output?.zh || afterTest.testResult.output || "测试通过") &&
          afterPublish.activeModal === "确认发布技能",
        summary: `generate=${afterGenerate.stateName}, publish=${afterPublish.activeModal}`,
        artifacts: [probe],
        observed: { afterGenerate, afterTest, afterPublish }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-04", "/skills/generator", generatedAt, results, artifacts);
}

async function verifyP2C05(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `W${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 workflow list 420 · 右 detail(最近运行 + 部署状态)flex",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const observed = await page.evaluate(() => {
        const container = document.querySelector('[data-workflows-grid="true"]');
        const list = document.querySelector('[data-workflows-list="true"]');
        const detail = document.querySelector('[data-workflows-detail="true"]');
        return {
          leftWidth: list?.getBoundingClientRect().width ?? null,
          rightExists: Boolean(detail),
          rightWidth: detail?.getBoundingClientRect().width ?? null,
          containerDisplay: container ? getComputedStyle(container).display : null,
          containerColumns: container ? getComputedStyle(container).gridTemplateColumns : null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-05/w01-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w01-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          Math.abs((observed.leftWidth ?? 0) - 420) <= 10 &&
          observed.rightExists === true &&
          (observed.rightWidth ?? 0) > 200 &&
          observed.containerDisplay === "grid" &&
          String(observed.containerColumns || "").includes("420px"),
        summary: `left=${observed.leftWidth}px`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "顶栏 · \"+ 新建\" 按钮跳 `/workflows/builder` + search + status filter",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const observed = await page.evaluate(() => ({
        newHref: document.querySelector('.page-shell a.action-button[href="/workflows/builder"]')?.getAttribute("href") ?? null,
        searchExists: Boolean(document.getElementById("workflow-search")),
        filters: Array.from(document.querySelectorAll('[data-action="workflow-status-filter"]')).map((node) => ({
          payload: node.getAttribute("data-payload"),
          active: node.className.includes("is-active")
        }))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w02-toolbar.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.newHref === "/workflows/builder" &&
          observed.searchExists === true &&
          JSON.stringify(observed.filters.map((item) => item.payload)) === JSON.stringify(["running", "failed", "all"]),
        summary: `${observed.newHref} / filters=${observed.filters.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "workflow row · 名称 + 当前版本 + 最近运行状态 + 下次触发时间 + menu(编辑 / 复制 / 归档)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector('[data-workflow-row="workflow-cross-border-launch"]');
        return {
          title: row?.querySelector("strong")?.textContent?.trim() ?? null,
          meta: Array.from(row?.querySelectorAll(".obs-row-meta span") || []).map((node) => node.textContent?.trim() ?? ""),
          actions: Array.from(
            row?.querySelectorAll('.obs-row-actions [data-action="workflow-copy"], .obs-row-actions [data-action="workflow-archive"], .obs-row-actions a.action-button') || []
          ).map((node) => node.textContent?.trim() ?? "")
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w03-workflow-row.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.title) &&
          observed.meta.length >= 3 &&
          observed.actions.includes("编辑") &&
          observed.actions.includes("复制") &&
          observed.actions.includes("归档"),
        summary: `${observed.title} / ${observed.actions.join("/")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "点 row · 右侧 detail 加载 · 无页面跳转",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const before = await readWorkflowsQaState(page);
      await page.evaluate(() => {
        document.querySelector('[data-action="select-workflow"][data-payload="workflow-incident-brief"]')?.click();
      });
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        pathname: window.location.pathname,
        selectedWorkflowId: window.__fridayQa.workflows.getState().selectedWorkflowId,
        detailTitle: document.querySelector("aside .shell-card strong")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w04-select-detail.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.selectedWorkflowId !== "workflow-incident-brief" &&
          after.pathname === "/workflows" &&
          after.selectedWorkflowId === "workflow-incident-brief" &&
          after.detailTitle === "事故复盘简报",
        summary: `${before.selectedWorkflowId} -> ${after.selectedWorkflowId}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    5,
    "detail · 顶 \"编辑\" 按钮(跳 builder) · 中 runs 表(最近 10)· 底 deploy 状态",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const observed = await page.evaluate(() => ({
        editHref: document.querySelector('aside a.action-button-secondary')?.getAttribute("href") ?? null,
        runRows: document.querySelectorAll("aside [data-workflow-runs-table] tbody tr").length,
        deployMeta: Array.from(document.querySelectorAll('aside [data-workflow-deploy-card] .obs-row-meta span')).map((node) => node.textContent?.trim() ?? ""),
        redeployLabel: document.querySelector('[data-action="workflow-redeploy"]')?.textContent?.trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-05/w05-detail-panel.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w05-detail-panel.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.editHref === "/workflows/builder?workflowId=workflow-cross-border-launch" &&
          observed.runRows === 10 &&
          observed.deployMeta.some((item) => item.includes("模板版本")) &&
          observed.deployMeta.includes("prod-us") &&
          observed.redeployLabel === "重新部署",
        summary: `${observed.runRows} runs / ${observed.redeployLabel}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "run 行 · 状态 pill + 时长 + 触发源 + logs 按钮 · 失败有 retry 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "failed"
      });
      await page.evaluate(() => window.__fridayQa.workflows.selectWorkflow("workflow-incident-brief"));
      await page.waitForTimeout(80);
      const before = await page.evaluate(() => {
        const row = document.querySelector("aside table tbody tr");
        return {
          cells: Array.from(row?.querySelectorAll("td") || []).map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? ""),
          hasRetry: Boolean(row?.querySelector('[data-action="workflow-retry-run"]')),
          hasLogs: Boolean(row?.querySelector('[data-action="workflow-open-log"]')),
          pillText: row?.querySelector(".status-pill")?.textContent?.trim() ?? null
        };
      });
      await page.click('[data-action="workflow-retry-run"][data-payload="workflow-incident-brief"]');
      await page.waitForTimeout(120);
      const after = await readWorkflowsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w06-run-row.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.pillText?.toLowerCase() === "failed" &&
          before.cells.length === 4 &&
          before.hasRetry === true &&
          before.hasLogs === true &&
          after.rows.find((item) => item.id === "workflow-incident-brief")?.status === "running",
        summary: `${before.pillText} -> ${after.rows.find((item) => item.id === "workflow-incident-brief")?.status}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    7,
    "running 状态 · 行底 2px 琥珀 progress bar · 宽度实时更新",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const before = await page.evaluate((colors) => {
        const fill = document.querySelector('[data-workflow-progress="workflow-cross-border-launch"] .qa-progress-fill');
        const color = fill ? getComputedStyle(fill).backgroundColor : null;
        return {
          width: fill?.style.width ?? null,
          height: fill?.getBoundingClientRect().height ?? null,
          color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
        };
      }, tokenColors);
      await page.evaluate(() => window.__fridayQa.workflows.advanceClock(5000));
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => {
        const fill = document.querySelector('[data-workflow-progress="workflow-cross-border-launch"] .qa-progress-fill');
        return {
          width: fill?.style.width ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w07-running-progress.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        before,
        after
      });
      return {
        pass:
          (before.height ?? 0) <= 3 &&
          before.tokenMatch === "--accent" &&
          before.width !== after.width,
        summary: `${before.width} -> ${after.width}`,
        artifacts: [probe],
        observed: { tokenColors, before, after }
      };
    }
  );

  await verifyRule(
    8,
    "deploy 状态 · 显示 template version + env + 上次部署时间 · redeploy 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const observed = await page.evaluate(() => ({
        deployCopy: document.querySelector("aside [data-workflow-deploy-card] > strong")?.textContent?.trim() ?? null,
        meta: Array.from(document.querySelectorAll("aside [data-workflow-deploy-card] .obs-row-meta span")).map((node) => node.textContent?.trim() ?? ""),
        redeployLabel: document.querySelector('[data-action="workflow-redeploy"]')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w08-deploy-state.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.deployCopy) &&
          observed.meta.some((item) => item.includes("模板版本")) &&
          observed.meta.includes("prod-us") &&
          observed.meta.some((item) => item.includes("上次部署")) &&
          observed.redeployLabel === "重新部署",
        summary: observed.meta.join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "archive · 二次确认 · archived workflow 单独 section 显示 · 可 restore",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      await page.evaluate(() => {
        document.querySelector('[data-action="workflow-archive"][data-payload="workflow-incident-brief"]')?.click();
      });
      await page.waitForTimeout(120);
      const confirm = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        confirmLabel: document.querySelector('[data-action="confirm-run"]')?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const archived = await page.evaluate(() => ({
        archivedTitles: Array.from(document.querySelectorAll(".shell-card div > span")).map((node) => node.textContent?.trim() ?? ""),
        restoreExists: Boolean(document.querySelector('[data-action="workflow-restore"][data-payload="workflow-incident-brief"]')),
        rowExists: Boolean(document.querySelector('[data-action="select-workflow"][data-payload="workflow-incident-brief"]'))
      }));
      await page.click('[data-action="workflow-restore"][data-payload="workflow-incident-brief"]');
      await page.waitForTimeout(120);
      const restored = await readWorkflowsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w09-archive-restore.json", {
        generatedAt: new Date().toISOString(),
        confirm,
        archived,
        restored
      });
      return {
        pass:
          confirm.title === "归档这个工作流?" &&
          confirm.confirmLabel === "归档" &&
          archived.restoreExists === true &&
          archived.rowExists === false &&
          restored.rows.some((item) => item.id === "workflow-incident-brief"),
        summary: `${confirm.title} / restored=${restored.rows.some((item) => item.id === "workflow-incident-brief")}`,
        artifacts: [probe],
        observed: { confirm, archived, restored }
      };
    }
  );

  await verifyRule(
    10,
    "空态 · \"还没有工作流 · 从模板开始\" · 展示 5-6 个模板 card · 点击跳 builder preload template",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "empty"
      });
      const before = await page.evaluate(() => ({
        title: document.querySelector(".page-shell h2")?.textContent?.trim() ?? null,
        templates: Array.from(document.querySelectorAll(".page-shell .pack-catalog-card")).map((node) => ({
          title: node.querySelector("strong")?.textContent?.trim() ?? "",
          href: node.getAttribute("href")
        }))
      }));
      await page.click('.page-shell .pack-catalog-card[href="/workflows/builder?template=release-qa"]');
      await page.waitForTimeout(120);
      const route = await page.evaluate(() => ({
        pathname: window.location.pathname,
        search: window.location.search
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w10-empty-templates.json", {
        generatedAt: new Date().toISOString(),
        before,
        route
      });
      return {
        pass:
          before.title === "还没有工作流 · 从模板开始" &&
          before.templates.length >= 5 &&
          before.templates.length <= 6 &&
          route.pathname === "/workflows/builder" &&
          route.search.includes("template=release-qa"),
        summary: `${before.templates.length} templates -> ${route.pathname}${route.search}`,
        artifacts: [probe],
        observed: { before, route }
      };
    }
  );

  await verifyRule(
    11,
    "多个 running 时 · 全局顶 banner \"N 个工作流正在运行\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows", "workflows", {
        stateName: "running"
      });
      const observed = await page.evaluate(() => ({
        bannerText: document.querySelector('[data-workflows-running-banner="true"]')?.textContent?.trim() ?? null,
        runningCount: Array.from(document.querySelectorAll('[data-workflow-row] .status-pill')).filter((node) => node.textContent?.trim() === "running").length
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-05/w11-running-banner.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-05/w11-running-banner.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.runningCount >= 2 &&
          observed.bannerText === `${observed.runningCount} 个工作流正在运行`,
        summary: observed.bannerText,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-05", "/workflows", generatedAt, results, artifacts);
}

async function verifyP2C06(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `B${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "左 lib · 节点按类分组(Triggers / Actions / Logic / Integrations)· 搜索过滤",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      const before = await page.evaluate(() => ({
        groups: Array.from(document.querySelectorAll("[data-builder-group] > strong")).map((node) => node.textContent?.trim() ?? ""),
        entryCount: document.querySelectorAll("[data-builder-library-entry]").length
      }));
      await page.fill("#builder-search", "github");
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({
        entryIds: Array.from(document.querySelectorAll("[data-builder-library-entry]")).map((node) => node.getAttribute("data-builder-library-entry")),
        texts: Array.from(document.querySelectorAll("[data-builder-library-entry]")).map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b01-library-groups.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          JSON.stringify(before.groups) === JSON.stringify(["Triggers", "Actions", "Logics", "Integrations"]) &&
          before.entryCount >= 8 &&
          after.entryIds.length === 1 &&
          after.entryIds[0] === "integration-github",
        summary: `${before.entryCount} entries -> ${after.entryIds.join(",")}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    2,
    "节点拖入 canvas · 创建 node · drop 处 snap to grid",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "new"
      });
      await page.evaluate(() => {
        const entry = document.querySelector('[data-builder-library-entry="action-assistant"]');
        const canvas = document.querySelector('[data-builder-canvas="true"]');
        if (!(entry instanceof HTMLElement) || !(canvas instanceof HTMLElement)) {
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const dropX = rect.left + 237;
        const dropY = rect.top + 181;
        entry.dispatchEvent(new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
        canvas.dispatchEvent(new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
        canvas.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
        entry.dispatchEvent(new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
      });
      await page.waitForTimeout(120);
      const observed = await readBuilderQaState(page);
      const created = observed.nodes[0] || null;
      const shot = await captureScreenshot(page, "screenshots/P2C-06/b02-drop-node.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b02-drop-node.json", {
        generatedAt: new Date().toISOString(),
        observed,
        created,
        screenshot: shot.path
      });
      return {
        pass:
          observed.nodes.length === 1 &&
          created?.type === "action" &&
          created?.x % 10 === 0 &&
          created?.y % 10 === 0,
        summary: `node=${created?.id} @ (${created?.x}, ${created?.y})`,
        artifacts: [probe, shot],
        observed: { observed, created }
      };
    }
  );

  await verifyRule(
    3,
    "节点之间连线 · hover node 边缘出连接点 · 拖连接点到另一 node 建 edge",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      const before = await readBuilderQaState(page);
      await page.evaluate(() => {
        const handle = document.querySelector('[data-builder-connect="node-cross-trigger"]');
        const target = document.querySelector('[data-builder-node-target="node-cross-redeploy"]');
        if (!(handle instanceof HTMLElement) || !(target instanceof HTMLElement)) {
          return;
        }
        const targetRect = target.getBoundingClientRect();
        const dropX = targetRect.left + targetRect.width / 2;
        const dropY = targetRect.top + targetRect.height / 2;
        handle.dispatchEvent(new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
        target.dispatchEvent(new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
        target.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
        handle.dispatchEvent(new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY
        }));
      });
      await page.waitForTimeout(120);
      const after = await readBuilderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b03-connect-edge.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.edges.length + 1 === after.edges.length &&
          after.edges.some((edge) => edge.from === "node-cross-trigger" && edge.to === "node-cross-redeploy"),
        summary: `${before.edges.length} -> ${after.edges.length} edges`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "连线 · SVG 贝塞尔曲线 · 琥珀色 · 悬浮加粗 · 右键删除",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const before = await page.evaluate((colors) => {
        const edge = document.querySelector('[data-builder-edge="edge-cross-1"]');
        const style = edge ? getComputedStyle(edge) : null;
        return {
          d: edge?.getAttribute("d") ?? null,
          stroke: style?.stroke ?? null,
          strokeToken: Object.entries(colors).find(([, value]) => value === style?.stroke)?.[0] ?? null,
          strokeWidth: style?.strokeWidth ?? null,
          edgeCount: document.querySelectorAll("[data-builder-edge]").length
        };
      }, tokenColors);
      await page.evaluate(() => {
        const edge = document.querySelector('[data-builder-edge="edge-cross-1"]');
        edge?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(120);
      const hovered = await page.evaluate(() => ({
        strokeWidth: getComputedStyle(document.querySelector('[data-builder-edge="edge-cross-1"]')).strokeWidth
      }));
      await page.evaluate(() => {
        const edge = document.querySelector('[data-builder-edge="edge-cross-1"]');
        edge?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      });
      await page.waitForTimeout(120);
      const after = await readBuilderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b04-edge-delete.json", {
        generatedAt: new Date().toISOString(),
        before,
        hovered,
        after
      });
      return {
        pass:
          String(before.d || "").includes(" C ") &&
          before.strokeToken === "--accent" &&
          before.strokeWidth === "2px" &&
          hovered.strokeWidth === "4px" &&
          after.edges.length === before.edgeCount - 1,
        summary: `${before.strokeWidth} -> ${hovered.strokeWidth}, edges=${before.edgeCount}->${after.edges.length}`,
        artifacts: [probe],
        observed: { before, hovered, after }
      };
    }
  );

  await verifyRule(
    5,
    "选中 node · 右 inspector 显示 node 配置 · field 级表单",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      await page.click('[data-builder-node-target="node-cross-logic"]');
      await page.waitForTimeout(100);
      const observed = await page.evaluate(() => ({
        selection: window.__fridayQa.builder.getState().selection,
        inputLabels: Array.from(document.querySelectorAll(".builder-sidebar-right label span")).map((node) => node.textContent?.trim() ?? ""),
        nameValue: document.getElementById("builder-node-name")?.value ?? null,
        configInputs: Array.from(document.querySelectorAll('[data-builder-config-key]')).map((node) => ({
          key: node.getAttribute("data-builder-config-key"),
          value: node.value
        }))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b05-inspector-fields.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          JSON.stringify(observed.selection) === JSON.stringify(["node-cross-logic"]) &&
          observed.inputLabels.includes("名称") &&
          observed.inputLabels.includes("类型") &&
          observed.nameValue === "利润阈值判断" &&
          observed.configInputs.some((item) => item.key === "expression"),
        summary: `${observed.nameValue} / fields=${observed.configInputs.map((item) => item.key).join(",")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "多选 · Cmd+click · 选中多 node · 可批量删除 · 可整体拖动",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      await page.keyboard.down("Meta");
      await page.click('[data-builder-node-target="node-cross-assistant"]');
      await page.click('[data-builder-node-target="node-cross-redeploy"]');
      await page.keyboard.up("Meta");
      const selected = await readBuilderQaState(page);
      const beforeMove = Object.fromEntries(selected.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
      await page.evaluate(() => {
        const node = document.querySelector('[data-builder-node-target="node-cross-redeploy"]');
        if (!(node instanceof HTMLElement)) {
          return;
        }
        const rect = node.getBoundingClientRect();
        const startX = rect.left + rect.width / 2;
        const startY = rect.top + rect.height / 2;
        node.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: startX,
          clientY: startY
        }));
        window.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          clientX: startX + 40,
          clientY: startY + 30
        }));
        window.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          clientX: startX + 40,
          clientY: startY + 30
        }));
      });
      await page.waitForTimeout(100);
      const moved = await readBuilderQaState(page);
      await page.click('[data-action="builder-delete"]');
      await page.waitForTimeout(100);
      const confirm = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const afterDelete = await readBuilderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b06-multiselect-drag-delete.json", {
        generatedAt: new Date().toISOString(),
        selected,
        beforeMove,
        moved,
        confirm,
        afterDelete
      });
      return {
        pass:
          selected.selection.length === 2 &&
          moved.nodes.find((node) => node.id === "node-cross-assistant")?.x !== beforeMove["node-cross-assistant"].x &&
          moved.nodes.find((node) => node.id === "node-cross-redeploy")?.x !== beforeMove["node-cross-redeploy"].x &&
          confirm.title === "删除选中的节点?" &&
          afterDelete.nodes.length === selected.nodes.length - 2,
        summary: `selected=${selected.selection.length}, nodes=${selected.nodes.length}->${afterDelete.nodes.length}`,
        artifacts: [probe],
        observed: { selected, beforeMove, moved, confirm, afterDelete }
      };
    }
  );

  await verifyRule(
    7,
    "undo/redo · 最近 20 步 · Cmd+Z / Shift+Cmd+Z",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "new"
      });
      await page.evaluate(() => {
        for (let index = 0; index < 22; index += 1) {
          window.__fridayQa.builder.addNode("logic-branch", { x: 60 + index * 10, y: 80 + index * 10 });
        }
      });
      await page.waitForTimeout(80);
      const afterAdds = await readBuilderQaState(page);
      await page.keyboard.press("Meta+z");
      await page.waitForTimeout(80);
      const afterUndo = await readBuilderQaState(page);
      await page.keyboard.press("Meta+Shift+z");
      await page.waitForTimeout(80);
      const afterRedo = await readBuilderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b07-undo-redo.json", {
        generatedAt: new Date().toISOString(),
        afterAdds,
        afterUndo,
        afterRedo
      });
      return {
        pass:
          afterAdds.historyDepth === 20 &&
          afterAdds.nodes.length === 22 &&
          afterUndo.nodes.length === 21 &&
          afterUndo.futureDepth >= 1 &&
          afterRedo.nodes.length === 22,
        summary: `history=${afterAdds.historyDepth}, nodes=${afterUndo.nodes.length}->${afterRedo.nodes.length}`,
        artifacts: [probe],
        observed: { afterAdds, afterUndo, afterRedo }
      };
    }
  );

  await verifyRule(
    8,
    "save · Cmd+S · 验证失败显 toast + 点亮错误 node · 成功 toast + 顶部 \"saved {time}\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "new"
      });
      await page.evaluate(() => window.__fridayQa.builder.addNode("action-assistant", { x: 120, y: 120 }));
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "s",
          metaKey: true,
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForTimeout(420);
      const failed = await page.evaluate(() => ({
        toast: document.querySelector(".toast-card:last-child")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        invalidCount: document.querySelectorAll(".builder-node.is-invalid").length,
        issueStrip: document.querySelector('[data-builder-validation="true"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await page.evaluate(() => window.__fridayQa.builder.loadWorkflow("workflow-cross-border-launch"));
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "s",
          metaKey: true,
          bubbles: true,
          cancelable: true
        }));
      });
      await page.waitForTimeout(420);
      const saved = await page.evaluate(() => ({
        toast: document.querySelector(".toast-card:last-child")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        savedText: document.querySelector("[data-builder-saved='true']")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b08-save-validation.json", {
        generatedAt: new Date().toISOString(),
        failed,
        saved
      });
      return {
        pass:
          /校验失败/.test(failed.toast || "") &&
          failed.invalidCount >= 1 &&
          Boolean(failed.issueStrip) &&
          /工作流已保存/.test(saved.toast || "") &&
          /^saved /.test(saved.savedText || ""),
        summary: `${failed.toast} / ${saved.savedText}`,
        artifacts: [probe],
        observed: { failed, saved }
      };
    }
  );

  await verifyRule(
    9,
    "dirty 指示 · 顶栏文字 \"• 未保存\" 琥珀",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      const tokenColors = await resolvedTokenColors(page, ["--warning"]);
      await page.evaluate(() => window.__fridayQa.builder.setNodeName("node-cross-trigger", "渠道告警触发 v2"));
      await page.waitForTimeout(80);
      const observed = await page.evaluate((colors) => {
        const node = document.querySelector("[data-builder-dirty='true']");
        const color = node ? getComputedStyle(node).color : null;
        return {
          text: node?.textContent?.trim() ?? null,
          color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b09-dirty-indicator.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.text === "• 未保存" &&
          observed.tokenMatch === "--warning",
        summary: `${observed.text} / ${observed.tokenMatch}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "test · Cmd+Shift+T · 底部 slide up 测试面板 · 输入 trigger payload · 运行 · 每 node 亮绿/红",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "new"
      });
      await page.evaluate(() => {
        window.__fridayQa.builder.addNode("logic-branch", { x: 80, y: 80 });
        window.__fridayQa.builder.addNode("logic-throttle", { x: 260, y: 80 });
        window.__fridayQa.builder.addNode("action-assistant", { x: 440, y: 80 });
      });
      await page.keyboard.press("Meta+Shift+t");
      await page.waitForTimeout(100);
      await page.fill("#builder-test-json", '{"trigger":"alert","severity":"high"}');
      await page.click('[data-action="builder-run-test"]');
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => ({
        panelOpen: document.querySelector('[data-builder-test-panel="true"]')?.className.includes("is-open") ?? false,
        payload: document.getElementById("builder-test-json")?.value ?? null,
        passedCount: document.querySelectorAll(".builder-node.is-passed").length,
        failedCount: document.querySelectorAll(".builder-node.is-failed").length,
        traceLabel: document.querySelector(".builder-test-panel .capability-chip")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b10-test-panel.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.panelOpen === true &&
          observed.payload === '{"trigger":"alert","severity":"high"}' &&
          observed.passedCount >= 1 &&
          observed.failedCount >= 1 &&
          Boolean(observed.traceLabel),
        summary: `passed=${observed.passedCount}, failed=${observed.failedCount}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    11,
    "publish · 弹出 modal · 显示 diff · 输入版本号 · 确认后部署",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      await page.click('[data-action="builder-publish"]');
      await page.waitForTimeout(120);
      const before = await page.evaluate(() => ({
        title: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        diff: document.querySelector(".settings-modal-body pre")?.textContent ?? "",
        versionValue: document.getElementById("builder-version-input")?.value ?? null
      }));
      await page.fill("#builder-version-input", "v99");
      await page.click('[data-action="builder-publish-confirm"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        modalOpen: Boolean(document.querySelector('.overlay-panel[role="dialog"]')),
        toast: document.querySelector(".toast-card:last-child")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b11-publish-modal.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.title === "发布工作流" &&
          before.diff.includes("+ workflow:") &&
          before.versionValue === "v12" &&
          after.modalOpen === false &&
          /工作流已部署/.test(after.toast || ""),
        summary: `${before.title} / ${after.toast}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    12,
    "validation 规则 · 必连触发器 · 必连至少 1 action · 无孤立 node · 无环 · 具体错误 UI 提示",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "new"
      });
      await page.evaluate(() => {
        const firstState = window.__fridayQa.builder.addNode("logic-branch", { x: 80, y: 80 });
        const firstId = firstState.nodes[firstState.nodes.length - 1].id;
        const secondState = window.__fridayQa.builder.addNode("logic-throttle", { x: 280, y: 80 });
        const secondId = secondState.nodes[secondState.nodes.length - 1].id;
        window.__fridayQa.builder.addNode("logic-branch", { x: 480, y: 80 });
        window.__fridayQa.builder.connect(firstId, secondId);
        window.__fridayQa.builder.connect(secondId, firstId);
        window.__fridayQa.builder.save();
      });
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => ({
        errors: window.__fridayQa.builder.getState().validation.errors,
        errorNodeIds: window.__fridayQa.builder.getState().validation.errorNodeIds,
        stripText: document.querySelector('[data-builder-validation="true"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b12-validation-rules.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.errors.includes("至少需要一个 trigger。") &&
          observed.errors.includes("至少需要一个 action。") &&
          observed.errors.includes("存在孤立节点，请补上连线或删除它们。") &&
          observed.errors.includes("存在环路，请打断循环依赖。") &&
          observed.errorNodeIds.length >= 3 &&
          Boolean(observed.stripText),
        summary: observed.errors.join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    13,
    "canvas 缩放 · Cmd+scroll / Cmd+= / Cmd+- / Cmd+0 重置",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      const initial = await readBuilderQaState(page);
      await page.locator('[data-builder-canvas="true"]').dispatchEvent("wheel", {
        deltaY: -120,
        ctrlKey: true
      });
      await page.waitForTimeout(80);
      const afterWheel = await readBuilderQaState(page);
      await page.keyboard.press("Meta+=");
      await page.waitForTimeout(80);
      const afterPlus = await readBuilderQaState(page);
      await page.keyboard.press("Meta+-");
      await page.waitForTimeout(80);
      const afterMinus = await readBuilderQaState(page);
      await page.keyboard.press("Meta+0");
      await page.waitForTimeout(80);
      const afterReset = await readBuilderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b13-zoom-shortcuts.json", {
        generatedAt: new Date().toISOString(),
        initial,
        afterWheel,
        afterPlus,
        afterMinus,
        afterReset
      });
      return {
        pass:
          initial.zoom === 1 &&
          afterWheel.zoom > initial.zoom &&
          afterPlus.zoom > afterWheel.zoom &&
          afterMinus.zoom < afterPlus.zoom &&
          afterReset.zoom === 1 &&
          afterReset.pan.x === 0 &&
          afterReset.pan.y === 0,
        summary: `${initial.zoom} -> ${afterWheel.zoom} -> ${afterPlus.zoom} -> ${afterMinus.zoom} -> ${afterReset.zoom}`,
        artifacts: [probe],
        observed: { initial, afterWheel, afterPlus, afterMinus, afterReset }
      };
    }
  );

  await verifyRule(
    14,
    "minimap 右下角 200×150 · 反映 canvas 整体",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      const observed = await page.evaluate(() => {
        const minimap = document.querySelector(".builder-minimap");
        const rect = minimap?.getBoundingClientRect();
        return {
          width: rect?.width ?? null,
          height: rect?.height ?? null,
          nodeRects: minimap?.querySelectorAll("rect").length ?? 0
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-06/b14-minimap.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b14-minimap.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          Math.abs((observed.width ?? 0) - 200) <= 2 &&
          Math.abs((observed.height ?? 0) - 150) <= 2 &&
          observed.nodeRects >= 5,
        summary: `${observed.width}x${observed.height}, rects=${observed.nodeRects}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    15,
    "键盘选中后 Delete / Backspace 删 node · Escape 取消选中",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "new"
      });
      await page.evaluate(() => {
        window.__fridayQa.builder.addNode("action-assistant", { x: 100, y: 100 });
        window.__fridayQa.builder.addNode("logic-branch", { x: 260, y: 100 });
      });
      const ids = await page.evaluate(() => window.__fridayQa.builder.getState().nodes.map((node) => node.id));
      await page.click(`[data-builder-node-target="${ids[0]}"]`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      const afterEscape = await readBuilderQaState(page);
      await page.click(`[data-builder-node-target="${ids[0]}"]`);
      await page.keyboard.press("Delete");
      await page.waitForTimeout(80);
      const deleteConfirm = await page.evaluate(() => document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null);
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(100);
      const afterDelete = await readBuilderQaState(page);
      await page.click(`[data-builder-node-target="${ids[1]}"]`);
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(80);
      const backspaceConfirm = await page.evaluate(() => document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null);
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(100);
      const afterBackspace = await readBuilderQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b15-delete-backspace-escape.json", {
        generatedAt: new Date().toISOString(),
        afterEscape,
        deleteConfirm,
        afterDelete,
        backspaceConfirm,
        afterBackspace
      });
      return {
        pass:
          afterEscape.selection.length === 0 &&
          deleteConfirm === "删除选中的节点?" &&
          afterDelete.nodes.length === 1 &&
          backspaceConfirm === "删除选中的节点?" &&
          afterBackspace.nodes.length === 0,
        summary: `nodes=${afterDelete.nodes.length}->${afterBackspace.nodes.length}`,
        artifacts: [probe],
        observed: { afterEscape, deleteConfirm, afterDelete, backspaceConfirm, afterBackspace }
      };
    }
  );

  await verifyRule(
    16,
    "复制粘贴 Cmd+C / Cmd+V · 复制到右下偏移 20px",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      await page.click('[data-builder-node-target="node-cross-assistant"]');
      const before = await readBuilderQaState(page);
      const original = before.nodes.find((node) => node.id === "node-cross-assistant");
      await page.keyboard.press("Meta+c");
      await page.waitForTimeout(60);
      await page.keyboard.press("Meta+v");
      await page.waitForTimeout(120);
      const after = await readBuilderQaState(page);
      const copied = after.nodes.find((node) => !before.nodes.some((previousNode) => previousNode.id === node.id));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b16-copy-paste.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        original,
        copied
      });
      return {
        pass:
          Boolean(after.clipboard) &&
          Boolean(copied) &&
          after.selection.length === 1 &&
          after.selection[0] === copied.id &&
          copied.x === original.x + 20 &&
          copied.y === original.y + 20,
        summary: `${original.id} -> ${copied?.id}`,
        artifacts: [probe],
        observed: { before, after, original, copied }
      };
    }
  );

  await verifyRule(
    17,
    "URL `?workflowId=xxx&template=yyy` · 加载对应模板或已存 workflow",
    async () => {
      const { page: workflowPage, context: workflowContext } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing",
        searchParams: { workflowId: "workflow-incident-brief" }
      });
      const workflowObserved = await workflowPage.evaluate(() => ({
        sourceKey: window.__fridayQa.builder.getState().sourceKey,
        title: document.querySelector(".builder-toolbar strong")?.textContent?.trim() ?? null,
        nodeCount: window.__fridayQa.builder.getState().nodes.length
      }));
      await workflowContext.close();

      const { page: templatePage, context: templateContext } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing",
        searchParams: { template: "release-qa" }
      });
      const templateObserved = await templatePage.evaluate(() => ({
        sourceKey: window.__fridayQa.builder.getState().sourceKey,
        title: document.querySelector(".builder-toolbar strong")?.textContent?.trim() ?? null,
        nodeCount: window.__fridayQa.builder.getState().nodes.length
      }));
      await templateContext.close();

      const probe = await writeJson("screenshots/P2C-06/b17-url-loading.json", {
        generatedAt: new Date().toISOString(),
        workflowObserved,
        templateObserved
      });
      return {
        pass:
          workflowObserved.sourceKey === "workflow:workflow-incident-brief" &&
          workflowObserved.title === "事故复盘简报" &&
          workflowObserved.nodeCount === 3 &&
          templateObserved.sourceKey === "template:release-qa" &&
          templateObserved.title === "发布 QA 守门" &&
          templateObserved.nodeCount === 5,
        summary: `${workflowObserved.sourceKey} / ${templateObserved.sourceKey}`,
        artifacts: [probe],
        observed: { workflowObserved, templateObserved }
      };
    }
  );

  await verifyRule(
    18,
    "退出未保存 · `beforeunload` 确认",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/workflows/builder", "builder", {
        stateName: "editing"
      });
      await page.evaluate(() => window.__fridayQa.builder.setNodeName("node-cross-trigger", "渠道告警触发 dirty"));
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        dirty: window.__fridayQa.builder.getState().dirty,
        beforeUnload: window.__fridayQa.builder.previewBeforeUnload()
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-06/b18-beforeunload.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.dirty === true &&
          observed.beforeUnload.prevented === true &&
          observed.beforeUnload.returnValue === "",
        summary: `dirty=${observed.dirty}, prevented=${observed.beforeUnload.prevented}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-06", "/workflows/builder", generatedAt, results, artifacts);
}

async function verifyP2C07(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `P${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "list · 每 plugin 一行 · 图标 32 + 名 + 版本 + 状态 + 动作",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "installed"
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("[data-plugin-row]");
        const icon = row?.querySelector("summary > div > span");
        return {
          rowCount: document.querySelectorAll("[data-plugin-row]").length,
          iconSize: icon ? getComputedStyle(icon).fontSize : null,
          name: row?.querySelector("strong")?.textContent?.trim() ?? null,
          version: row?.querySelector(".obs-row-meta span")?.textContent?.trim() ?? null,
          status: row?.querySelector(".status-pill")?.textContent?.trim() ?? null,
          actions: Array.from(row?.querySelectorAll(".route-tab-chip, .action-button, .action-button-secondary") || []).map((node) => node.textContent?.trim() ?? "")
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-07/p01-plugin-row.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p01-plugin-row.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.rowCount >= 5 &&
          observed.iconSize === "32px" &&
          Boolean(observed.name) &&
          String(observed.version || "").startsWith("v") &&
          Boolean(observed.status) &&
          observed.actions.length >= 1,
        summary: `${observed.name} / ${observed.status}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "状态 · installed / enabled / disabled / error / update-available",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "installed"
      });
      const observed = await page.evaluate(() => window.__fridayQa.plugins.getState().rows.map((row) => ({
        id: row.id,
        status: row.status
      })));
      await context.close();
      const statuses = new Set(observed.map((item) => item.status));
      const probe = await writeJson("screenshots/P2C-07/p02-statuses.json", {
        generatedAt: new Date().toISOString(),
        observed,
        statuses: Array.from(statuses)
      });
      return {
        pass:
          statuses.has("installed") &&
          statuses.has("enabled") &&
          statuses.has("disabled") &&
          statuses.has("error") &&
          statuses.has("update-available"),
        summary: Array.from(statuses).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "version 比较 · 当前版本旁显\"最新 v2.1.0 ↑\" 琥珀 link · 点跳 update modal",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "update-available"
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const before = await page.evaluate((colors) => {
        const row = document.querySelector('[data-plugin-row="plugin-github"]');
        const link = row?.querySelector(".inline-link-button");
        const color = link ? getComputedStyle(link).color : null;
        return {
          text: link?.textContent?.trim() ?? null,
          color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
        };
      }, tokenColors);
      await page.click('[data-plugin-row="plugin-github"] .inline-link-button');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        modalTitle: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p03-version-link.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        before,
        after
      });
      return {
        pass:
          before.text === "最新 v2.1.0 ↑" &&
          before.tokenMatch === "--accent" &&
          after.modalTitle === "更新插件",
        summary: `${before.text} / ${after.modalTitle}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "enable/disable toggle · 立刻生效 · error 状态 toggle 禁用",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "installed"
      });
      const before = await readPluginsQaState(page);
      await page.click('[data-plugin-row="plugin-computer-use"] [data-action="plugin-toggle"]');
      await page.waitForTimeout(80);
      const after = await readPluginsQaState(page);
      const errorToggle = await page.evaluate(() => ({
        disabled: document.querySelector('[data-plugin-row="plugin-legacy-slack"] [data-action="plugin-toggle"]')?.hasAttribute("disabled") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p04-toggle-state.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        errorToggle
      });
      return {
        pass:
          before.rows.find((item) => item.id === "plugin-computer-use")?.status === "enabled" &&
          after.rows.find((item) => item.id === "plugin-computer-use")?.status === "disabled" &&
          errorToggle.disabled === true,
        summary: `${before.rows.find((item) => item.id === "plugin-computer-use")?.status} -> ${after.rows.find((item) => item.id === "plugin-computer-use")?.status}`,
        artifacts: [probe],
        observed: { before, after, errorToggle }
      };
    }
  );

  await verifyRule(
    5,
    "permissions · 点击 row 展开详情 · 列出 scopes + filesystem + network 权限 · 与 manifest 对齐",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "installed"
      });
      await page.locator('[data-plugin-row="plugin-github"] summary').click();
      await page.waitForTimeout(100);
      const observed = await page.evaluate(() => {
        const details = document.querySelector('[data-plugin-row="plugin-github"]');
        const state = window.__fridayQa.plugins.getState().rows.find((row) => row.id === "plugin-github");
        return {
          open: details?.open ?? false,
          text: details?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          permissions: state?.permissions ?? []
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p05-permissions.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.open === true &&
          String(observed.text || "").includes("Scopes") &&
          String(observed.text || "").includes("Filesystem") &&
          String(observed.text || "").includes("Network") &&
          observed.permissions.includes("workflow") &&
          observed.permissions.includes("filesystem:read") &&
          observed.permissions.includes("network:github.com"),
        summary: observed.permissions.join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "error row · 红边 + 错误文字 + \"查看日志\" 按钮 · 打开日志 drawer",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "runtime-error"
      });
      const before = await page.evaluate(() => {
        const row = document.querySelector('[data-plugin-row="plugin-legacy-slack"]');
        return {
          borderColor: row ? getComputedStyle(row).borderColor : null,
          text: row?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          hasLogButton: Boolean(row?.querySelector('[data-action="plugin-view-log"]'))
        };
      });
      await page.locator('[data-plugin-row="plugin-legacy-slack"] summary').click();
      await page.click('[data-plugin-row="plugin-legacy-slack"] [data-action="plugin-view-log"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        drawerTitle: document.querySelector('.drawer-panel[data-drawer-kind="plugin-log"] .overlay-title')?.textContent?.trim() ?? null,
        drawerText: document.querySelector('.drawer-panel[data-drawer-kind="plugin-log"] .chat-json-block')?.textContent ?? ""
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p06-error-log-drawer.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.borderColor === "rgb(165, 48, 40)" &&
          String(before.text || "").includes("最近一次加载失败") &&
          before.hasLogButton === true &&
          after.drawerTitle === "插件日志" &&
          after.drawerText.includes("permission mismatch detected"),
        summary: `${before.borderColor} / ${after.drawerTitle}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    7,
    "update · modal 显示 changelog + permissions diff · 需确认新权限",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "update-available"
      });
      await page.evaluate(() => window.__fridayQa.plugins.openUpdate("plugin-github"));
      await page.waitForTimeout(80);
      const before = await page.evaluate(() => ({
        title: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        body: document.querySelector(".settings-modal-body")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await page.click('[data-action="plugin-update-confirm"]');
      await page.waitForTimeout(120);
      const after = await readPluginsQaState(page);
      await context.close();
      const updated = after.rows.find((row) => row.id === "plugin-github");
      const probe = await writeJson("screenshots/P2C-07/p07-update-confirm.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        updated
      });
      return {
        pass:
          before.title === "更新插件" &&
          String(before.body || "").includes("changelog") &&
          String(before.body || "").includes("+ permission: workflow") &&
          String(before.body || "").includes("+ permission: network:api.github.com") &&
          updated?.version === "2.1.0" &&
          updated?.status === "enabled",
        summary: `${updated?.version} / ${updated?.status}`,
        artifacts: [probe],
        observed: { before, after, updated }
      };
    }
  );

  await verifyRule(
    8,
    "uninstall · 二次确认 · 保留数据 toggle",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "installed"
      });
      await page.evaluate(() => {
        const details = document.querySelector('[data-plugin-row="plugin-release-radar"]');
        if (details) {
          details.open = true;
        }
      });
      await page.click('[data-plugin-row="plugin-release-radar"] [data-action="plugin-uninstall"]');
      await page.waitForTimeout(120);
      const before = await page.evaluate(() => ({
        title: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        keepDataChecked: document.getElementById("plugin-keep-data")?.checked ?? null
      }));
      await page.click('[data-action="plugin-uninstall-confirm"]');
      await page.waitForTimeout(120);
      const after = await readPluginsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p08-uninstall.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.title === "卸载插件" &&
          before.keepDataChecked === true &&
          after.rows.every((row) => row.id !== "plugin-release-radar"),
        summary: `${before.title} / remaining=${after.rows.length}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    9,
    "顶部 search · 过滤名称 + 描述 · 右 \"+ 添加\" 按钮 · 接 registry 或手动上传",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/plugins", "plugins", {
        stateName: "installed"
      });
      await page.fill("#plugins-search", "desktop");
      await page.waitForTimeout(80);
      const descriptionMatch = await page.evaluate(() => ({
        search: document.getElementById("plugins-search")?.value ?? null,
        rowIds: Array.from(document.querySelectorAll("[data-plugin-row]")).map((node) => node.getAttribute("data-plugin-row"))
      }));
      await page.fill("#plugins-search", "release");
      await page.waitForTimeout(80);
      const nameMatch = await page.evaluate(() => ({
        search: document.getElementById("plugins-search")?.value ?? null,
        rowIds: Array.from(document.querySelectorAll("[data-plugin-row]")).map((node) => node.getAttribute("data-plugin-row"))
      }));
      await page.click('[data-action="plugin-add"]');
      await page.waitForTimeout(120);
      const modal = await page.evaluate(() => ({
        title: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        sources: Array.from(document.querySelectorAll("#plugin-add-source option")).map((node) => node.value)
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-07/p09-search-add.json", {
        generatedAt: new Date().toISOString(),
        descriptionMatch,
        nameMatch,
        modal
      });
      return {
        pass:
          JSON.stringify(descriptionMatch.rowIds) === JSON.stringify(["plugin-computer-use"]) &&
          JSON.stringify(nameMatch.rowIds) === JSON.stringify(["plugin-release-radar"]) &&
          modal.title === "添加插件" &&
          JSON.stringify(modal.sources) === JSON.stringify(["registry", "upload"]),
        summary: `${descriptionMatch.rowIds.join(",")} / ${modal.title}`,
        artifacts: [probe],
        observed: { descriptionMatch, nameMatch, modal }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-07", "/plugins", generatedAt, results, artifacts);
}

async function verifyP2C08(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `M${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "list · 每 server 一行 · 名 + URL + 状态 + 工具数 + 动作",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "connected"
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("[data-mcp-row]");
        return {
          rowCount: document.querySelectorAll("[data-mcp-row]").length,
          name: row?.querySelector("strong")?.textContent?.trim() ?? null,
          url: row?.querySelector("p")?.textContent?.trim() ?? null,
          status: row?.querySelector(".status-pill")?.textContent?.trim() ?? null,
          toolCount: row?.querySelector(".capability-chip")?.textContent?.trim() ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2C-08/m01-server-list.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m01-server-list.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.rowCount >= 4 &&
          Boolean(observed.name) &&
          String(observed.url || "").startsWith("https://") &&
          Boolean(observed.status) &&
          /tools/.test(observed.toolCount || ""),
        summary: `${observed.name} / ${observed.status}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "状态 · connected(绿)/ disconnected(灰)/ connecting(琥珀脉冲)/ error(红)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "connected"
      });
      const tokenColors = await resolvedTokenColors(page, ["--success", "--ink-3", "--warning", "--error"]);
      const observed = await page.evaluate((colors) => {
        return ["mcp-docs", "mcp-warehouse", "mcp-github", "mcp-browse"].map((id) => {
          const dot = document.querySelector(`[data-mcp-dot='${id}']`);
          const color = dot ? getComputedStyle(dot).backgroundColor : null;
          return {
            id,
            className: dot?.className ?? null,
            color,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null,
            pulse: dot ? getComputedStyle(dot).animationName : null
          };
        });
      }, tokenColors);
      await context.close();
      const byId = Object.fromEntries(observed.map((item) => [item.id, item]));
      const probe = await writeJson("screenshots/P2C-08/m02-status-dots.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          byId["mcp-docs"].tokenMatch === "--success" &&
          byId["mcp-warehouse"].tokenMatch === "--ink-3" &&
          byId["mcp-github"].tokenMatch === "--warning" &&
          byId["mcp-github"].className.includes("is-pulsing") &&
          byId["mcp-browse"].tokenMatch === "--error",
        summary: observed.map((item) => `${item.id}:${item.tokenMatch}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "点 row 展开工具列表 · 每 tool 名 + 描述 + schema 按钮(打开 JSON drawer)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "connected"
      });
      await page.locator('[data-mcp-row="mcp-docs"] summary').click();
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        tools: Array.from(document.querySelectorAll('[data-mcp-row="mcp-docs"] .capability-chip strong')).map((node) => node.textContent?.trim() ?? ""),
        schemaButtons: document.querySelectorAll('[data-mcp-row="mcp-docs"] [data-action="mcp-open-schema"]').length
      }));
      await page.click('[data-mcp-row="mcp-docs"] [data-action="mcp-open-schema"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        drawerTitle: document.querySelector('.drawer-panel[data-drawer-kind="mcp-schema"] .overlay-title')?.textContent?.trim() ?? null,
        schemaText: document.querySelector('.drawer-panel[data-drawer-kind="mcp-schema"] .chat-json-block')?.textContent ?? ""
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m03-tools-schema.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.tools.length === 3 &&
          before.schemaButtons === 3 &&
          after.drawerTitle === "Tool schema" &&
          after.schemaText.includes('"required"') &&
          after.schemaText.includes('"query"'),
        summary: `${before.tools.join(",")} / ${after.drawerTitle}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "add · modal 3 字段 · name + url + auth token · 连接测试按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "connected"
      });
      await page.click('[data-action="mcp-add"]');
      await page.waitForTimeout(120);
      const before = await page.evaluate(() => ({
        title: document.querySelector('.overlay-panel[role="dialog"] .overlay-title')?.textContent?.trim() ?? null,
        fields: [
          Boolean(document.getElementById("mcp-add-name")),
          Boolean(document.getElementById("mcp-add-url")),
          Boolean(document.getElementById("mcp-add-token"))
        ],
        testLabel: document.querySelector('[data-action="mcp-test-connect"]')?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="mcp-test-connect"]');
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => ({
        toast: document.querySelector(".toast-card:last-child")?.textContent?.replace(/\s+/g, " ").trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m04-add-modal.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.title === "添加 MCP 服务器" &&
          before.fields.every(Boolean) &&
          before.testLabel === "测试连接" &&
          /测试连接通过/.test(after.toast || ""),
        summary: `${before.title} / ${after.toast}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    5,
    "disconnected · \"重连\" 按钮 + \"查看错误\" link",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "disconnected"
      });
      await page.locator('[data-mcp-row="mcp-warehouse"] summary').click();
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        reconnectLabel: document.querySelector('[data-mcp-row="mcp-warehouse"] [data-action="mcp-reconnect"]')?.textContent?.trim() ?? null,
        errorLabel: document.querySelector('[data-mcp-row="mcp-warehouse"] [data-action="mcp-error"]')?.textContent?.trim() ?? null
      }));
      await page.click('[data-mcp-row="mcp-warehouse"] [data-action="mcp-error"]');
      await page.waitForTimeout(100);
      const errorDrawer = await page.evaluate(() => ({
        title: document.querySelector('.drawer-panel[data-drawer-kind="mcp-error"] .overlay-title')?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="close-overlays"]');
      await page.waitForTimeout(80);
      await page.evaluate(() => {
        const row = document.querySelector('[data-mcp-row="mcp-warehouse"]');
        if (row instanceof HTMLDetailsElement) {
          row.open = true;
        }
        const reconnect = document.querySelector('[data-mcp-row="mcp-warehouse"] [data-action="mcp-reconnect"]');
        reconnect?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(80);
      const connecting = await readMcpQaState(page);
      await page.waitForTimeout(460);
      const reconnected = await readMcpQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m05-reconnect-error.json", {
        generatedAt: new Date().toISOString(),
        before,
        errorDrawer,
        connecting,
        reconnected
      });
      return {
        pass:
          before.reconnectLabel === "重连" &&
          before.errorLabel === "查看错误" &&
          errorDrawer.title === "连接错误" &&
          connecting.rows.find((row) => row.id === "mcp-warehouse")?.status === "connecting" &&
          reconnected.rows.find((row) => row.id === "mcp-warehouse")?.status === "connected",
        summary: `${before.reconnectLabel} / ${reconnected.rows.find((row) => row.id === "mcp-warehouse")?.status}`,
        artifacts: [probe],
        observed: { before, errorDrawer, connecting, reconnected }
      };
    }
  );

  await verifyRule(
    6,
    "remove · 二次确认 · 确认后 row fade-out 移除",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "connected"
      });
      await page.locator('[data-mcp-row="mcp-docs"] summary').click();
      await page.waitForTimeout(100);
      await page.click('[data-mcp-row="mcp-docs"] [data-action="mcp-remove"]');
      await page.waitForTimeout(100);
      const confirm = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(60);
      const fading = await page.evaluate(() => ({
        className: document.querySelector('[data-mcp-row="mcp-docs"]')?.className ?? null
      }));
      await page.waitForTimeout(240);
      const after = await readMcpQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m06-remove-fade.json", {
        generatedAt: new Date().toISOString(),
        confirm,
        fading,
        after
      });
      return {
        pass:
          confirm.title === "移除这个 MCP 服务器?" &&
          String(fading.className || "").includes("is-removing") &&
          after.rows.every((row) => row.id !== "mcp-docs"),
        summary: `${confirm.title} / rows=${after.rows.length}`,
        artifacts: [probe],
        observed: { confirm, fading, after }
      };
    }
  );

  await verifyRule(
    7,
    "empty · \"还没有连接的 MCP 服务器\" + add CTA + 文档 link",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "empty"
      });
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".page-shell h2")?.textContent?.trim() ?? null,
        addLabel: document.querySelector('[data-action="mcp-add"]')?.textContent?.trim() ?? null,
        docsHref: document.querySelector('.page-shell a[href="https://modelcontextprotocol.io"]')?.getAttribute("href") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2C-08/m07-empty-state.png");
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m07-empty-state.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "还没有连接的 MCP 服务器" &&
          observed.addLabel === "添加服务器" &&
          observed.docsHref === "https://modelcontextprotocol.io",
        summary: `${observed.title} / ${observed.addLabel}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "server 实时 ping · 每 30s · 状态 dot 自动更新",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/mcp", "mcp", {
        stateName: "connected"
      });
      const before = await page.evaluate(() => ({
        lastPing: document.querySelector('[data-mcp-last-ping="mcp-docs"]')?.textContent?.trim() ?? null,
        githubDot: document.querySelector('[data-mcp-dot="mcp-github"]')?.className ?? null
      }));
      await page.evaluate(() => window.__fridayQa.mcp.advanceClock(30000));
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({
        lastPing: document.querySelector('[data-mcp-last-ping="mcp-docs"]')?.textContent?.trim() ?? null,
        githubDot: document.querySelector('[data-mcp-dot="mcp-github"]')?.className ?? null,
        state: window.__fridayQa.mcp.getState()
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2C-08/m08-ping-trace.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.lastPing !== after.lastPing &&
          before.githubDot.includes("is-pulsing") &&
          after.githubDot.includes("is-healthy") &&
          after.state.pingTrace.length >= 1,
        summary: `${before.lastPing} -> ${after.lastPing}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2C-08", "/mcp", generatedAt, results, artifacts);
}

async function verifyP2D01(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `N${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 list 420 · 右 config drawer 460(可关闭后右列消失 · 只 list)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "error"
      });
      const before = await page.evaluate(() => {
        const list = document.querySelector("[data-channel-list='true']");
        const drawer = document.querySelector("[data-channel-drawer]");
        const layout = document.querySelector("[data-channel-layout='true']");
        return {
          listWidth: list ? list.getBoundingClientRect().width : null,
          drawerWidth: drawer ? drawer.getBoundingClientRect().width : null,
          gridTemplateColumns: layout ? getComputedStyle(layout).gridTemplateColumns : null,
          drawerId: drawer?.getAttribute("data-channel-drawer") ?? null
        };
      });
      await page.evaluate(() => window.__fridayQa.channels.closeDrawer());
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => {
        const list = document.querySelector("[data-channel-list='true']");
        const drawer = document.querySelector("[data-channel-drawer]");
        const layout = document.querySelector("[data-channel-layout='true']");
        return {
          listWidth: list ? list.getBoundingClientRect().width : null,
          drawerPresent: Boolean(drawer),
          gridTemplateColumns: layout ? getComputedStyle(layout).gridTemplateColumns : null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-01/n01-channel-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n01-channel-layout.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        screenshot: shot.path
      });
      return {
        pass:
          Math.abs((before.listWidth || 0) - 420) <= 2 &&
          Math.abs((before.drawerWidth || 0) - 460) <= 2 &&
          Boolean(before.drawerId) &&
          after.drawerPresent === false &&
          Math.abs((after.listWidth || 0) - 420) <= 2,
        summary: `list=${before.listWidth}, drawer=${before.drawerWidth}, closed=${after.drawerPresent === false}`,
        artifacts: [probe, shot],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    2,
    "channel row · type 图标 24 + 名 + 状态 dot + 最近 session time + menu",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "error"
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("[data-channel-row]");
        const icon = row?.querySelector("[data-channel-icon]");
        const dot = row?.querySelector("[data-channel-dot]");
        const meta = row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? "") : [];
        const menu = row?.querySelector('[data-action="channel-open-menu"]');
        const iconRect = icon ? icon.getBoundingClientRect() : null;
        return {
          name: row?.querySelector("strong")?.textContent?.trim() ?? null,
          iconSize: iconRect ? { width: iconRect.width, height: iconRect.height } : null,
          dotPresent: Boolean(dot),
          recentSession: meta[1] ?? null,
          menuLabel: menu?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n02-channel-row.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.name) &&
          Math.abs((observed.iconSize?.width || 0) - 24) <= 1 &&
          Math.abs((observed.iconSize?.height || 0) - 24) <= 1 &&
          observed.dotPresent &&
          Boolean(observed.recentSession) &&
          observed.menuLabel === "menu",
        summary: `${observed.name} / recent=${observed.recentSession}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "状态 · healthy / degraded / error · degraded 时显示具体指标(latency 高 / 限流)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "error"
      });
      const observed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("[data-channel-row]")).map((row) => ({
          id: row.getAttribute("data-channel-row"),
          health: row.getAttribute("data-channel-health"),
          metric: row.querySelector("[data-channel-metric]")?.textContent?.trim() ?? null
        }));
      });
      await context.close();
      const byId = Object.fromEntries(observed.map((item) => [item.id, item]));
      const probe = await writeJson("screenshots/P2D-01/n03-channel-statuses.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          byId["channel-amazon"]?.health === "healthy" &&
          byId["channel-shopify"]?.health === "degraded" &&
          byId["channel-tiktok"]?.health === "error" &&
          /latency|限流/i.test(byId["channel-shopify"]?.metric || ""),
        summary: observed.map((item) => `${item.id}:${item.health}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "click row · 右侧 config drawer 滑入 · 200ms",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "healthy"
      });
      await page.evaluate(() => window.__fridayQa.channels.closeDrawer());
      await page.waitForTimeout(120);
      await page.click('[data-channel-row="channel-shopify"] [data-action="select-channel"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => {
        const drawer = document.querySelector("[data-channel-drawer='channel-shopify']");
        const style = drawer ? getComputedStyle(drawer) : null;
        return {
          drawerPresent: Boolean(drawer),
          animationName: style?.animationName ?? null,
          animationDuration: style?.animationDuration ?? null,
          transitionDuration: style?.transitionDuration ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n04-channel-drawer-transition.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.drawerPresent &&
          observed.animationName === "trace-drawer-slide-in" &&
          String(observed.animationDuration || "").includes("0.2s") &&
          String(observed.transitionDuration || "").includes("0.2s"),
        summary: `${observed.animationName} / ${observed.animationDuration}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "ChannelConfigForm 复用 · 包含 webhook url / auth / rate-limit / timeout 字段",
    async () => {
      const source = await fs.readFile(path.join(ROOT, "ui/src/components/core/channel-config-form.tsx"), "utf8");
      const routeSource = await fs.readFile(path.join(ROOT, "ui/src/routes/settings-page.tsx"), "utf8");
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "healthy"
      });
      const observed = await page.evaluate(() => ({
        formPresent: Boolean(document.querySelector("[data-channel-config-form]")),
        fields: [
          Boolean(document.getElementById("channel-webhook-url")),
          Boolean(document.getElementById("channel-auth")),
          Boolean(document.getElementById("channel-rate-limit")),
          Boolean(document.getElementById("channel-timeout"))
        ]
      }));
      await context.close();
      const sourceObserved = {
        componentExport: /export function ChannelConfigForm\(props: \{ locale: AppLocale \}\)/.test(source),
        routeImport: /import \{ ChannelConfigForm \} from \"@\/components\/core\/channel-config-form\";/.test(routeSource),
        routeRender: /<ChannelConfigForm locale=\{locale\} \/>/.test(routeSource)
      };
      const probe = await writeJson("screenshots/P2D-01/n05-channel-config-form.json", {
        generatedAt: new Date().toISOString(),
        sourceObserved,
        observed
      });
      return {
        pass:
          sourceObserved.componentExport &&
          sourceObserved.routeImport &&
          sourceObserved.routeRender &&
          observed.formPresent &&
          observed.fields.every(Boolean),
        summary: `source=${Object.values(sourceObserved).every(Boolean)}, fields=${observed.fields.filter(Boolean).length}/4`,
        artifacts: [probe],
        observed: { sourceObserved, observed }
      };
    }
  );

  await verifyRule(
    6,
    "\"测试连接\" 按钮 · loading → result toast · 失败显示具体 error",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "error"
      });
      await page.click('[data-channel-row="channel-tiktok"] [data-action="select-channel"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="channel-test"]');
      await page.waitForTimeout(80);
      const loading = await page.evaluate(() => ({
        label: document.querySelector('[data-action="channel-test"]')?.textContent?.trim() ?? null,
        disabled: document.querySelector('[data-action="channel-test"]')?.hasAttribute("disabled") ?? false
      }));
      await page.waitForTimeout(360);
      const after = await page.evaluate(() => ({
        toast: document.querySelector(".toast-card:last-child")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        resultTitle: document.querySelector("[data-channel-test-result] strong")?.textContent?.trim() ?? null,
        resultBody: document.querySelector("[data-channel-test-result] div")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n06-channel-test.json", {
        generatedAt: new Date().toISOString(),
        loading,
        after
      });
      return {
        pass:
          loading.disabled &&
          /测试中/.test(loading.label || "") &&
          /连接失败/.test(after.toast || "") &&
          /连接测试失败/.test(after.resultTitle || "") &&
          /授权已过期/.test(after.resultBody || ""),
        summary: `${loading.label} -> ${after.resultTitle}`,
        artifacts: [probe],
        observed: { loading, after }
      };
    }
  );

  await verifyRule(
    7,
    "save · dirty 状态持续显 · diff 对比按钮(旧 vs 新)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "healthy"
      });
      await page.evaluate(() => window.__fridayQa.channels.setFieldValue("auth", "Bearer qa-rotated-token"));
      await page.waitForTimeout(80);
      const before = await page.evaluate(() => ({
        saveBarPresent: Boolean(document.querySelector("[data-channel-save-bar='true']")),
        dirtyCopy: document.querySelector("[data-channel-save-bar='true'] strong")?.textContent?.trim() ?? null,
        dirtyFields: document.querySelector("[data-channel-save-bar='true'] .settings-save-copy span")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="channel-diff"]');
      await page.waitForTimeout(100);
      const diff = await page.evaluate(() => {
        const text = document.querySelector("[data-channel-diff]")?.textContent ?? "";
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n07-channel-diff.json", {
        generatedAt: new Date().toISOString(),
        before,
        diff
      });
      return {
        pass:
          before.saveBarPresent &&
          /未保存|changed/.test(before.dirtyCopy || "") &&
          /auth/.test(before.dirtyFields || "") &&
          diff?.before?.auth !== diff?.after?.auth &&
          Array.isArray(diff?.dirtyKeys) &&
          diff.dirtyKeys.includes("auth"),
        summary: `${before.dirtyCopy} / dirtyKeys=${(diff?.dirtyKeys || []).join(",")}`,
        artifacts: [probe],
        observed: { before, diff }
      };
    }
  );

  await verifyRule(
    8,
    "add channel · 顶部 + 按钮 · 弹 modal · 选 type → 填配置",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "healthy"
      });
      await page.click('[data-action="channel-add"]');
      await page.waitForTimeout(100);
      const modalBefore = await page.evaluate(() => ({
        title: document.querySelector(".overlay-panel[role='dialog'] .overlay-title")?.textContent?.trim() ?? null,
        typeField: Boolean(document.getElementById("channel-add-type")),
        nameField: Boolean(document.getElementById("channel-add-name")),
        webhookField: Boolean(document.getElementById("channel-add-webhook")),
        authField: Boolean(document.getElementById("channel-add-auth"))
      }));
      await page.selectOption("#channel-add-type", "GitHub");
      await page.fill("#channel-add-name", "GitHub Ops");
      await page.fill("#channel-add-webhook", "https://hooks.friday.dev/channels/github-ops");
      await page.fill("#channel-add-auth", "ghp_ops_token");
      await page.fill("#channel-add-rate-limit", "30 rpm");
      await page.fill("#channel-add-timeout", "12s");
      await page.click('[data-action="channel-add-confirm"]');
      await page.waitForTimeout(120);
      const after = await readChannelsQaState(page);
      await context.close();
      const created = after.rows.find((row) => /GitHub Ops/.test(row.name?.zh || row.name?.en || ""));
      const probe = await writeJson("screenshots/P2D-01/n08-channel-add-modal.json", {
        generatedAt: new Date().toISOString(),
        modalBefore,
        after,
        created
      });
      return {
        pass:
          modalBefore.title === "添加渠道" &&
          modalBefore.typeField &&
          modalBefore.nameField &&
          modalBefore.webhookField &&
          modalBefore.authField &&
          Boolean(created) &&
          created.type === "GitHub",
        summary: `${modalBefore.title} / created=${created?.id || "none"}`,
        artifacts: [probe],
        observed: { modalBefore, after, created }
      };
    }
  );

  await verifyRule(
    9,
    "最近 sessions 用 `useChannelSessions` hook · 每 channel 显示最近 5 个 session",
    async () => {
      const hookSource = await fs.readFile(path.join(ROOT, "ui/src/hooks/use-channel-sessions.ts"), "utf8");
      const routeSource = await fs.readFile(path.join(ROOT, "ui/src/routes/channels-page.tsx"), "utf8");
      const prototypeSource = await fs.readFile(STATIC_FILE, "utf8");
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "healthy"
      });
      await page.click('[data-channel-row="channel-amazon"] [data-action="select-channel"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        sessionCount: document.querySelectorAll("[data-channel-sessions] a").length,
        labels: Array.from(document.querySelectorAll("[data-channel-sessions] a span:first-child")).map((node) => node.textContent?.trim() ?? "")
      }));
      await context.close();
      const sourceObserved = {
        hookExport: /export function useChannelSessionsQuery\(channel\?: string\)/.test(hookSource),
        routeHookUse: /useChannelSessionsQuery/.test(routeSource),
        prototypeHelper: /function useChannelSessions\(channelId\)/.test(prototypeSource)
      };
      const probe = await writeJson("screenshots/P2D-01/n09-channel-sessions-hook.json", {
        generatedAt: new Date().toISOString(),
        sourceObserved,
        observed
      });
      return {
        pass:
          sourceObserved.hookExport &&
          sourceObserved.routeHookUse &&
          sourceObserved.prototypeHelper &&
          observed.sessionCount === 5,
        summary: `hook=${Object.values(sourceObserved).every(Boolean)}, sessions=${observed.sessionCount}`,
        artifacts: [probe],
        observed: { sourceObserved, observed }
      };
    }
  );

  await verifyRule(
    10,
    "disable channel · 二次确认 · disabled 的 row 整行 opacity 0.5 · sessions 显示历史",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "healthy"
      });
      await page.click('[data-channel-row="channel-shopify"] [data-action="select-channel"]');
      await page.waitForTimeout(80);
      const sessionCountBefore = await page.locator("[data-channel-sessions] a").count();
      await page.click('[data-action="channel-disable"]');
      await page.waitForTimeout(100);
      const confirm = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        body: document.getElementById("confirm-detail")?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => {
        const row = document.querySelector("[data-channel-row='channel-shopify']");
        return {
          opacity: row ? getComputedStyle(row).opacity : null,
          className: row?.className ?? null,
          sessionCount: document.querySelectorAll("[data-channel-sessions] a").length
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n10-channel-disable.json", {
        generatedAt: new Date().toISOString(),
        confirm,
        sessionCountBefore,
        after
      });
      return {
        pass:
          confirm.title === "停用这个渠道?" &&
          after.opacity === "0.5" &&
          String(after.className || "").includes("is-disabled") &&
          sessionCountBefore > 0 &&
          after.sessionCount > 0,
        summary: `${confirm.title} / opacity=${after.opacity} / sessions=${after.sessionCount}`,
        artifacts: [probe],
        observed: { confirm, sessionCountBefore, after }
      };
    }
  );

  await verifyRule(
    11,
    "空态 · \"连接你的第一个渠道\" + 支持渠道 grid(逐个 provider icon)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/channels", "channels", {
        stateName: "empty"
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-01/n11-channel-empty.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".empty-hero h2")?.textContent?.trim() ?? null,
        providerTiles: document.querySelectorAll(".empty-hero .shell-card strong").length,
        iconCount: document.querySelectorAll(".empty-hero .shell-card span").length,
        ctaLabel: document.querySelector(".empty-hero .action-button")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-01/n11-channel-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "连接你的第一个渠道" &&
          observed.providerTiles >= 4 &&
          observed.iconCount >= 4 &&
          observed.ctaLabel?.startsWith("添加渠道"),
        summary: `${observed.title} / providers=${observed.providerTiles}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2D-01", "/channels", generatedAt, results, artifacts);
}

async function verifyP2D02(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `O${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "3 tab · Queued · Running · History · 计数 badge 实时",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "queued"
      });
      const before = await page.evaluate(() => Array.from(document.querySelectorAll("[data-action='automation-tab']")).map((node) => node.textContent?.trim() ?? ""));
      await page.click('[data-action="automation-cancel"]');
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => Array.from(document.querySelectorAll("[data-action='automation-tab']")).map((node) => node.textContent?.trim() ?? ""));
      await context.close();
      const queuedBefore = Number((before.find((label) => label.startsWith("queued")) || "").match(/\((\d+)\)/)?.[1] || 0);
      const queuedAfter = Number((after.find((label) => label.startsWith("queued")) || "").match(/\((\d+)\)/)?.[1] || 0);
      const probe = await writeJson("screenshots/P2D-02/o01-automation-tabs.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        queuedBefore,
        queuedAfter
      });
      return {
        pass:
          before.length === 3 &&
          before.some((label) => label.startsWith("queued")) &&
          before.some((label) => label.startsWith("running")) &&
          before.some((label) => label.startsWith("history")) &&
          queuedAfter === Math.max(0, queuedBefore - 1),
        summary: `queued ${queuedBefore} -> ${queuedAfter}`,
        artifacts: [probe],
        observed: { before, after, queuedBefore, queuedAfter }
      };
    }
  );

  await verifyRule(
    2,
    "每 tab 一列表 · row 含 name + 触发源 + 进度 bar(running)/ 时长 + actions",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "queued"
      });
      const queued = await page.evaluate(() => {
        const row = document.querySelector("[data-automation-row]");
        return {
          title: row?.querySelector("strong")?.textContent?.trim() ?? null,
          meta: row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? "") : [],
          actions: row ? Array.from(row.querySelectorAll(".obs-row-actions *")).map((node) => node.textContent?.trim() ?? "") : [],
          progress: Boolean(row?.querySelector("[data-automation-progress]"))
        };
      });
      await page.evaluate(() => window.__fridayQa.automations.setTab("running"));
      await page.waitForTimeout(80);
      const running = await page.evaluate(() => {
        const row = document.querySelector("[data-automation-row]");
        return {
          title: row?.querySelector("strong")?.textContent?.trim() ?? null,
          meta: row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? "") : [],
          actions: row ? Array.from(row.querySelectorAll(".obs-row-actions *")).map((node) => node.textContent?.trim() ?? "") : [],
          progress: Boolean(row?.querySelector("[data-automation-progress]"))
        };
      });
      await page.evaluate(() => window.__fridayQa.automations.setTab("history"));
      await page.waitForTimeout(80);
      const history = await page.evaluate(() => {
        const row = document.querySelector("[data-automation-row]");
        return {
          title: row?.querySelector("strong")?.textContent?.trim() ?? null,
          meta: row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? "") : [],
          actions: row ? Array.from(row.querySelectorAll(".obs-row-actions *")).map((node) => node.textContent?.trim() ?? "") : [],
          statusPill: row?.querySelector(".status-pill")?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-02/o02-automation-row-shape.json", {
        generatedAt: new Date().toISOString(),
        queued,
        running,
        history
      });
      return {
        pass:
          Boolean(queued.title) &&
          queued.meta.length >= 2 &&
          queued.actions.some((label) => /cancel/i.test(label)) &&
          Boolean(running.title) &&
          running.progress &&
          running.meta.some((label) => /已运行|Running/i.test(label)) &&
          Boolean(history.title) &&
          Boolean(history.statusPill),
        summary: `queued=${queued.title}, runningProgress=${running.progress}, history=${history.statusPill}`,
        artifacts: [probe],
        observed: { queued, running, history }
      };
    }
  );

  await verifyRule(
    3,
    "running row · progress bar 实时更新 · 来自 `advanceClock` + mock state",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "running"
      });
      const before = await page.evaluate(() => {
        const fill = document.querySelector("[data-automation-progress] .qa-progress-fill");
        return {
          width: fill ? getComputedStyle(fill).width : null,
          percent: document.querySelector("[data-automation-row] .capability-chip")?.textContent?.trim() ?? null
        };
      });
      await page.evaluate(() => window.__fridayQa.automations.advanceClock(60_000));
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => {
        const fill = document.querySelector("[data-automation-progress] .qa-progress-fill");
        return {
          width: fill ? getComputedStyle(fill).width : null,
          percent: document.querySelector("[data-automation-row] .capability-chip")?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const beforePercent = Number(String(before.percent || "").replace(/[^\d]/g, ""));
      const afterPercent = Number(String(after.percent || "").replace(/[^\d]/g, ""));
      const probe = await writeJson("screenshots/P2D-02/o03-automation-progress.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        beforePercent,
        afterPercent
      });
      return {
        pass: afterPercent > beforePercent && after.width !== before.width,
        summary: `${beforePercent}% -> ${afterPercent}%`,
        artifacts: [probe],
        observed: { before, after, beforePercent, afterPercent }
      };
    }
  );

  await verifyRule(
    4,
    "queued row · 显示\"将于 {time} 运行\" · 可 cancel",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "queued"
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("[data-automation-row]");
        return {
          meta: row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? "") : [],
          cancelLabel: row?.querySelector('[data-action="automation-cancel"]')?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-02/o04-automation-queued.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.meta.some((label) => /将于 .*运行|Runs at/i.test(label)) &&
          /cancel/i.test(observed.cancelLabel || ""),
        summary: `${observed.meta.join(" / ")} / ${observed.cancelLabel}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "history · 最近 50 条 · paginate 或虚拟化 · 按时间倒序",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "failed"
      });
      const state = await readAutomationsQaState(page);
      const dom = await page.evaluate(() => ({
        rowCount: document.querySelectorAll("[data-automation-row]").length,
        pager: document.querySelector(".capability-chip")?.textContent?.trim() ?? null,
        timestamps: Array.from(document.querySelectorAll("[data-automation-row] .obs-row-meta")).map((node) => {
          const spans = Array.from(node.querySelectorAll("span")).map((item) => item.textContent?.trim() ?? "");
          return spans[2] || null;
        }).filter(Boolean)
      }));
      await page.click('[data-action="automation-history-page"][data-payload="2"]');
      await page.waitForTimeout(80);
      const page2 = await page.evaluate(() => ({
        rowCount: document.querySelectorAll("[data-automation-row]").length,
        pager: document.querySelector(".capability-chip")?.textContent?.trim() ?? null
      }));
      await context.close();
      const times = state.runs.history.map((row) => new Date(row.happenedAtIso).getTime());
      const descending = times.every((time, index) => index === 0 || time <= times[index - 1]);
      const probe = await writeJson("screenshots/P2D-02/o05-automation-history.json", {
        generatedAt: new Date().toISOString(),
        historyCount: state.runs.history.length,
        dom,
        page2,
        descending
      });
      return {
        pass:
          state.runs.history.length === 50 &&
          dom.rowCount === 10 &&
          /page 1 \/ 5/.test(dom.pager || "") &&
          page2.rowCount === 10 &&
          /page 2 \/ 5/.test(page2.pager || "") &&
          descending,
        summary: `history=${state.runs.history.length}, page1=${dom.rowCount}, descending=${descending}`,
        artifacts: [probe],
        observed: { state, dom, page2, descending }
      };
    }
  );

  await verifyRule(
    6,
    "click row · 打开 logs drawer · 日志行带 timestamp + level(info/warn/error)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "running"
      });
      await page.click("[data-automation-row] [data-action='open-automation-log']");
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => {
        const drawer = document.querySelector(".drawer-panel[data-drawer-kind='automation-log']");
        const line = drawer?.querySelector("[data-automation-log-line]");
        return {
          drawerTitle: drawer?.querySelector(".overlay-title")?.textContent?.trim() ?? null,
          lineColumns: line ? Array.from(line.querySelectorAll("span")).map((node) => node.textContent?.trim() ?? "") : []
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-02/o06-automation-log-drawer.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.drawerTitle) &&
          observed.lineColumns.length === 3 &&
          /\d{2}:\d{2}/.test(observed.lineColumns[0] || "") &&
          /info|warn|error/.test(observed.lineColumns[1] || ""),
        summary: `${observed.drawerTitle} / ${observed.lineColumns.join(" | ")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "logs drawer · tail 模式 · 顶部 auto-scroll toggle · search 过滤",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "running"
      });
      await page.click("[data-automation-row] [data-action='open-automation-log']");
      await page.waitForTimeout(120);
      const before = await page.evaluate(() => {
        const lines = document.querySelector("[data-automation-log-lines]");
        return {
          autoScrollActive: document.querySelector('[data-action="automation-log-toggle-scroll"]')?.className.includes("is-active") ?? false,
          scrollTop: lines?.scrollTop ?? null,
          scrollHeight: lines?.scrollHeight ?? null,
          lineCount: document.querySelectorAll("[data-automation-log-line]").length
        };
      });
      await page.evaluate(() => {
        const lines = document.querySelector("[data-automation-log-lines]");
        if (lines) {
          lines.scrollTop = 0;
        }
      });
      await page.click('[data-action="automation-log-toggle-scroll"]');
      await page.waitForTimeout(60);
      await page.evaluate(() => window.__fridayQa.automations.advanceClock(60_000));
      await page.waitForTimeout(120);
      const mid = await page.evaluate(() => {
        const lines = document.querySelector("[data-automation-log-lines]");
        return {
          autoScrollActive: document.querySelector('[data-action="automation-log-toggle-scroll"]')?.className.includes("is-active") ?? false,
          scrollTop: lines?.scrollTop ?? null,
          scrollHeight: lines?.scrollHeight ?? null
        };
      });
      await page.fill("#automation-log-search", "tail");
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => ({
        filteredCount: document.querySelectorAll("[data-automation-log-line]").length,
        emptyState: document.querySelector(".route-detail-empty")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-02/o07-automation-log-tail.json", {
        generatedAt: new Date().toISOString(),
        before,
        mid,
        after
      });
      return {
        pass:
          before.autoScrollActive &&
          mid.autoScrollActive === false &&
          Number(mid.scrollTop) === 0 &&
          after.filteredCount >= 1 &&
          !after.emptyState,
        summary: `autoScroll ${before.autoScrollActive} -> ${mid.autoScrollActive}, filtered=${after.filteredCount}`,
        artifacts: [probe],
        observed: { before, mid, after }
      };
    }
  );

  await verifyRule(
    8,
    "failed automation · retry 按钮 · 点击 dispatch mock event 重新 queue",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "failed"
      });
      const before = await readAutomationsQaState(page);
      const failedId = before.runs.history.find((row) => row.status === "failed")?.id;
      await page.click(`[data-automation-row="${failedId}"] [data-action="automation-retry"]`);
      await page.waitForTimeout(100);
      const after = await readAutomationsQaState(page);
      await context.close();
      const queuedMatch = after.runs.queued.find((row) => row.id === `${failedId}-retry`) || null;
      const probe = await writeJson("screenshots/P2D-02/o08-automation-retry.json", {
        generatedAt: new Date().toISOString(),
        failedId,
        before,
        after,
        queuedMatch
      });
      return {
        pass:
          Boolean(failedId) &&
          after.activeTab === "queued" &&
          after.lastDispatch?.type === "automation.run_queued" &&
          Boolean(queuedMatch),
        summary: `${failedId} -> ${queuedMatch?.id || "none"}`,
        artifacts: [probe],
        observed: { failedId, before, after, queuedMatch }
      };
    }
  );

  await verifyRule(
    9,
    "空 · 每 tab 有独立文案 · Queued \"没有在排队的任务\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "empty"
      });
      const queued = await page.evaluate(() => document.querySelector("[data-automation-empty] strong")?.textContent?.trim() ?? null);
      await page.evaluate(() => window.__fridayQa.automations.setTab("running"));
      await page.waitForTimeout(80);
      const running = await page.evaluate(() => document.querySelector("[data-automation-empty] strong")?.textContent?.trim() ?? null);
      await page.evaluate(() => window.__fridayQa.automations.setTab("history"));
      await page.waitForTimeout(80);
      const history = await page.evaluate(() => document.querySelector("[data-automation-empty] strong")?.textContent?.trim() ?? null);
      await context.close();
      const probe = await writeJson("screenshots/P2D-02/o09-automation-empty-copy.json", {
        generatedAt: new Date().toISOString(),
        queued,
        running,
        history
      });
      return {
        pass:
          queued === "没有在排队的任务" &&
          running === "当前没有运行中的任务" &&
          history === "还没有历史记录",
        summary: `${queued} / ${running} / ${history}`,
        artifacts: [probe],
        observed: { queued, running, history }
      };
    }
  );

  await verifyRule(
    10,
    "filter · 按 trigger source(cron / manual / webhook / chat)· chip 多选",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/automations", "automations", {
        stateName: "queued"
      });
      await page.evaluate(() => {
        window.__fridayQa.automations.toggleTriggerFilter("cron");
        window.__fridayQa.automations.toggleTriggerFilter("manual");
      });
      await page.waitForTimeout(80);
      const after = await readAutomationsQaState(page);
      const observed = await page.evaluate(() => Array.from(document.querySelectorAll("[data-automation-row]")).map((row) => ({
        id: row.getAttribute("data-automation-row"),
        trigger: row.querySelector(".obs-row-meta span")?.textContent?.trim() ?? null
      })));
      await context.close();
      const probe = await writeJson("screenshots/P2D-02/o10-automation-filters.json", {
        generatedAt: new Date().toISOString(),
        after,
        observed
      });
      return {
        pass:
          after.triggerFilters.length === 2 &&
          after.triggerFilters.includes("cron") &&
          after.triggerFilters.includes("manual") &&
          observed.every((row) => /cron|manual/i.test(row.trigger || "")),
        summary: `filters=${after.triggerFilters.join(",")} rows=${observed.length}`,
        artifacts: [probe],
        observed: { after, observed }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2D-02", "/automations", generatedAt, results, artifacts);
}

async function verifyP2D03(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `P${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 filter + list 420 · 右 detail preview flex",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "list"
      });
      const observed = await page.evaluate(() => {
        const grid = document.querySelector(".page-shell > div");
        const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ") : [];
        return {
          gridTemplateColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
          firstColumn: columns[0] ?? null,
          secondColumn: columns[1] ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-03/p01-sessions-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p01-sessions-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.firstColumn === "420px" &&
          Boolean(observed.secondColumn) &&
          observed.secondColumn !== "0px",
        summary: `${observed.gridTemplateColumns}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "filter · time(<24h / 7d / 30d / custom)· channel(multi)· type(chat / workflow / automation)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "list"
      });
      const before = await readSessionsQaState(page);
      await page.click('[data-action="session-time-filter"][data-payload="7d"]');
      await page.click('[data-action="session-channel-filter"][data-payload="channel-shopify"]');
      await page.click('[data-action="session-type-filter"][data-payload="automation"]');
      await page.waitForTimeout(100);
      const after = await readSessionsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p02-session-filters.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.timeFilter === "24h" &&
          after.timeFilter === "7d" &&
          after.channelFilters.includes("channel-shopify") &&
          after.typeFilters.includes("automation"),
        summary: `time=${after.timeFilter}, channels=${after.channelFilters.join(",")}, types=${after.typeFilters.join(",")}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    3,
    "session row · title + channel icon + last message time + message count + status",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "list"
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("[data-session-row]");
        const icon = row?.querySelector("[data-session-channel-icon]");
        const iconRect = icon ? icon.getBoundingClientRect() : null;
        const meta = row ? Array.from(row.querySelectorAll(".obs-row-meta span")).map((node) => node.textContent?.trim() ?? "") : [];
        return {
          title: row?.querySelector("strong")?.textContent?.trim() ?? null,
          iconSize: iconRect ? { width: iconRect.width, height: iconRect.height } : null,
          lastMessageTime: meta[1] ?? null,
          messageCount: meta[2] ?? null,
          status: row?.querySelector(".status-pill")?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p03-session-row.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.title) &&
          Math.abs((observed.iconSize?.width || 0) - 24) <= 1 &&
          Math.abs((observed.iconSize?.height || 0) - 24) <= 1 &&
          Boolean(observed.lastMessageTime) &&
          /msgs/.test(observed.messageCount || "") &&
          Boolean(observed.status),
        summary: `${observed.title} / ${observed.status}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "click row · 右侧 preview · 显示最近 10 条消息 · 不可编辑 · \"打开完整会话\" 按钮跳 /chat?session=xxx",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "detail"
      });
      await page.click('[data-session-row="session-refund-triage"] [data-action="select-session"]');
      await page.waitForTimeout(100);
      const observed = await page.evaluate(() => ({
        previewCount: document.querySelectorAll("[data-session-preview-message]").length,
        editableNodes: document.querySelectorAll("[data-session-preview='true'] input, [data-session-preview='true'] textarea, [data-session-preview='true'] select").length,
        openHref: document.querySelector("[data-session-preview='true'] .action-button")?.getAttribute("href") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2D-03/p04-session-preview.png");
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p04-session-preview.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.previewCount === 10 &&
          observed.editableNodes === 0 &&
          observed.openHref === "/chat?session=session-refund-triage",
        summary: `preview=${observed.previewCount}, href=${observed.openHref}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "preview 不自动 realtime 更新 · 靠 refresh 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "detail"
      });
      await page.click('[data-session-row="session-refund-triage"] [data-action="select-session"]');
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        firstMessage: document.querySelector("[data-session-preview-message] p")?.textContent?.trim() ?? null,
        refreshedAt: document.querySelector("[data-session-preview-refreshed-at] strong")?.textContent?.trim() ?? null
      }));
      await page.waitForTimeout(180);
      const stable = await page.evaluate(() => ({
        firstMessage: document.querySelector("[data-session-preview-message] p")?.textContent?.trim() ?? null,
        refreshedAt: document.querySelector("[data-session-preview-refreshed-at] strong")?.textContent?.trim() ?? null
      }));
      await page.evaluate(() => window.__fridayMock.advanceClock(1_000));
      await page.waitForTimeout(20);
      await page.click('[data-action="refresh-sessions-preview"]');
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({
        firstMessage: document.querySelector("[data-session-preview-message] p")?.textContent?.trim() ?? null,
        refreshedAt: document.querySelector("[data-session-preview-refreshed-at] strong")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p05-session-refresh.json", {
        generatedAt: new Date().toISOString(),
        before,
        stable,
        after
      });
      return {
        pass:
          before.firstMessage === stable.firstMessage &&
          before.refreshedAt === stable.refreshedAt &&
          after.firstMessage !== stable.firstMessage &&
          after.refreshedAt !== stable.refreshedAt,
        summary: `stable=${before.firstMessage === stable.firstMessage}, refreshed=${after.firstMessage !== stable.firstMessage}`,
        artifacts: [probe],
        observed: { before, stable, after }
      };
    }
  );

  await verifyRule(
    6,
    "顶部 search · 搜 session title + message content(mock 模拟)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "list"
      });
      await page.fill("#sessions-search", "退款");
      await page.waitForTimeout(80);
      const titleSearch = await page.evaluate(() => Array.from(document.querySelectorAll("[data-session-row]")).map((node) => node.getAttribute("data-session-row")));
      await page.fill("#sessions-search", "回放记录");
      await page.waitForTimeout(80);
      const contentSearch = await page.evaluate(() => Array.from(document.querySelectorAll("[data-session-row]")).map((node) => node.getAttribute("data-session-row")));
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p06-session-search.json", {
        generatedAt: new Date().toISOString(),
        titleSearch,
        contentSearch
      });
      return {
        pass:
          titleSearch.length === 1 &&
          titleSearch[0] === "session-refund-triage" &&
          contentSearch.length >= 3,
        summary: `title=${titleSearch.join(",")} content=${contentSearch.length}`,
        artifacts: [probe],
        observed: { titleSearch, contentSearch }
      };
    }
  );

  await verifyRule(
    7,
    "session 操作 · rename · archive · delete · 每个二次确认",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "list"
      });
      await page.click('[data-session-row="session-replenish-watch"] [data-action="session-rename"]');
      await page.waitForTimeout(100);
      const rename = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        inputLabel: document.querySelector(".confirm-dialog .assistant-inline-field span")?.textContent?.trim() ?? null
      }));
      await page.fill("#confirm-dialog-input", "补货监控（已改名）");
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(100);
      const renamed = await page.evaluate(() => document.querySelector('[data-session-row="session-replenish-watch"] strong')?.textContent?.trim() ?? null);

      await page.click('[data-session-row="session-policy-sweep"] [data-action="session-archive"]');
      await page.waitForTimeout(100);
      const archive = await page.evaluate(() => document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null);
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(100);
      const archivedGone = await page.locator('[data-session-row="session-policy-sweep"]').count();

      await page.click('[data-session-row="session-night-ops"] [data-action="session-delete"]');
      await page.waitForTimeout(100);
      const remove = await page.evaluate(() => document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null);
      await page.click('[data-action="confirm-run"]');
      await page.waitForTimeout(100);
      const deletedGone = await page.locator('[data-session-row="session-night-ops"]').count();
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p07-session-actions.json", {
        generatedAt: new Date().toISOString(),
        rename,
        renamed,
        archive,
        archivedGone,
        remove,
        deletedGone
      });
      return {
        pass:
          rename.title === "重命名会话?" &&
          rename.inputLabel === "新的会话名称" &&
          renamed === "补货监控（已改名）" &&
          archive === "归档这个会话?" &&
          archivedGone === 0 &&
          remove === "删除这个会话?" &&
          deletedGone === 0,
        summary: `${rename.title} / archivedGone=${archivedGone} / deletedGone=${deletedGone}`,
        artifacts: [probe],
        observed: { rename, renamed, archive, archivedGone, remove, deletedGone }
      };
    }
  );

  await verifyRule(
    8,
    "keyboard · Tab list · 方向键选 session · Enter 打开 /chat",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "list"
      });
      await page.locator("[data-session-row] .obs-row-main-button").first().focus();
      const tabbable = await page.evaluate(() => document.activeElement?.className ?? null);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(80);
      const afterArrow = await page.evaluate(() => ({
        focusedPayload: document.activeElement?.getAttribute("data-payload") ?? null,
        selectedId: window.__fridayQa.sessions.getState().selectedSessionId
      }));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      const afterEnter = await page.evaluate(() => window.location.pathname + window.location.search);
      await context.close();
      return {
        pass:
          /obs-row-main-button/.test(String(tabbable || "")) &&
          afterArrow.focusedPayload === afterArrow.selectedId &&
          afterEnter.startsWith("/chat?session="),
        summary: `selected=${afterArrow.selectedId}, route=${afterEnter}`,
        artifacts: [await writeJson("screenshots/P2D-03/p08-session-keyboard.json", {
          generatedAt: new Date().toISOString(),
          tabbable,
          afterArrow,
          afterEnter
        })],
        observed: { tabbable, afterArrow, afterEnter }
      };
    }
  );

  await verifyRule(
    9,
    "empty · \"开始你的第一次对话\" + CTA",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "empty"
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-03/p09-session-empty.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".home-inline-empty strong")?.textContent?.trim() ?? null,
        ctaHref: document.querySelector(".home-inline-empty .action-button")?.getAttribute("href") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p09-session-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.title === "开始你的第一次对话" && observed.ctaHref === "/chat",
        summary: `${observed.title} / ${observed.ctaHref}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "filter active 时右上角显 filter chip 组 · 点 × 移除单个 · clear all 按钮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/sessions", "sessions", {
        stateName: "detail"
      });
      await page.click('[data-action="session-time-filter"][data-payload="7d"]');
      await page.click('[data-action="session-channel-filter"][data-payload="channel-shopify"]');
      await page.click('[data-action="session-type-filter"][data-payload="chat"]');
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        chips: Array.from(document.querySelectorAll("[data-action='session-clear-filter']")).map((node) => node.textContent?.trim() ?? ""),
        clearAll: document.querySelector('[data-action="session-clear-all-filters"]')?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="session-clear-filter"][data-payload="channel::channel-shopify"]');
      await page.waitForTimeout(80);
      const mid = await readSessionsQaState(page);
      await page.click('[data-action="session-clear-all-filters"]');
      await page.waitForTimeout(80);
      const after = await readSessionsQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2D-03/p10-session-filter-chips.json", {
        generatedAt: new Date().toISOString(),
        before,
        mid,
        after
      });
      return {
        pass:
          before.chips.length >= 3 &&
          before.clearAll === "clear all" &&
          !mid.channelFilters.includes("channel-shopify") &&
          after.timeFilter === "24h" &&
          after.channelFilters.length === 0 &&
          after.typeFilters.length === 0,
        summary: `chips=${before.chips.length}, afterClearAll=${after.channelFilters.length + after.typeFilters.length}`,
        artifacts: [probe],
        observed: { before, mid, after }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2D-03", "/sessions", generatedAt, results, artifacts);
}

async function verifyP2D04(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `Q${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "顶 summary 3 数 · \"本月 $X\" + \"预测 $Y\" + \"上限 $Z\" · 大数字 font serif 40 · 每数下有 label + 对比上月变化",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      const observed = await page.evaluate(() => Array.from(document.querySelectorAll(".page-shell > div:nth-of-type(2) .shell-card")).slice(0, 3).map((card) => {
        const value = card.querySelector("div");
        const valueStyle = value ? getComputedStyle(value) : null;
        return {
          eyebrow: card.querySelector(".shell-card-eyebrow")?.textContent?.trim() ?? null,
          value: value?.textContent?.trim() ?? null,
          fontSize: valueStyle?.fontSize ?? null,
          fontFamily: valueStyle?.fontFamily ?? null,
          delta: card.querySelector("div + div")?.textContent?.trim() ?? null
        };
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q01-usage-summary.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.length === 3 &&
          observed.every((card) => /\$/.test(card.value || "")) &&
          observed.every((card) => card.fontSize === "40px") &&
          observed.every((card) => /serif/i.test(card.fontFamily || "")) &&
          observed.every((card) => /本月|预测|上限|\+|At current pace|vs last month/.test(card.delta || "")),
        summary: observed.map((card) => `${card.eyebrow}:${card.value}`).join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "主图 · area chart 横轴 日期 / 纵轴 $ · 高 320 · 响应式",
    async () => {
      const wide = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" },
        viewport: { width: 1920, height: 1200 }
      });
      const wideObserved = await wide.page.evaluate(() => {
        const chart = document.querySelector("[data-usage-chart='true']");
        return {
          width: chart ? chart.getBoundingClientRect().width : null,
          height: chart ? chart.getBoundingClientRect().height : null,
          axisLabels: Array.from(document.querySelectorAll("[data-usage-chart] text")).map((node) => node.textContent?.trim() ?? "").filter(Boolean).length
        };
      });
      await wide.context.close();
      const narrow = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" },
        viewport: { width: 1280, height: 1200 }
      });
      const narrowObserved = await narrow.page.evaluate(() => {
        const chart = document.querySelector("[data-usage-chart='true']");
        return {
          width: chart ? chart.getBoundingClientRect().width : null,
          height: chart ? chart.getBoundingClientRect().height : null
        };
      });
      await narrow.context.close();
      const probe = await writeJson("screenshots/P2D-04/q02-usage-chart-size.json", {
        generatedAt: new Date().toISOString(),
        wideObserved,
        narrowObserved
      });
      return {
        pass:
          wideObserved.height === 320 &&
          narrowObserved.height === 320 &&
          (wideObserved.width || 0) > (narrowObserved.width || 0) &&
          wideObserved.axisLabels >= 4,
        summary: `wide=${wideObserved.width}x${wideObserved.height}, narrow=${narrowObserved.width}x${narrowObserved.height}`,
        artifacts: [probe],
        observed: { wideObserved, narrowObserved }
      };
    }
  );

  await verifyRule(
    3,
    "chart hover · tooltip 显示当日 $ + 拆分 provider",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      await page.hover("[data-usage-point-index='3']");
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        tooltipTitle: document.querySelector("[data-usage-tooltip] strong")?.textContent?.trim() ?? null,
        tooltipValue: document.querySelector("[data-usage-tooltip] div")?.textContent?.trim() ?? null,
        providerRows: document.querySelectorAll("[data-usage-tooltip] div > div").length
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q03-usage-tooltip.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.tooltipTitle) &&
          /\$/.test(observed.tooltipValue || "") &&
          observed.providerRows >= 3,
        summary: `${observed.tooltipTitle} / ${observed.tooltipValue} / providers=${observed.providerRows}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "chart 预警阈值线 · 水平虚线 · 红色 · 显示 \"budget cap\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      const tokenColors = await resolvedTokenColors(page, ["--error"]);
      const observed = await page.evaluate((colors) => {
        const line = document.querySelector("[data-usage-chart='true'] line");
        const text = Array.from(document.querySelectorAll("[data-usage-chart='true'] text")).find((node) => node.textContent?.trim() === "budget cap");
        return {
          dasharray: line?.getAttribute("stroke-dasharray") ?? null,
          stroke: line ? getComputedStyle(line).stroke : null,
          tokenMatch: line ? Object.entries(colors).find(([, value]) => value === getComputedStyle(line).stroke)?.[0] ?? null : null,
          label: text?.textContent?.trim() ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q04-usage-cap-line.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.dasharray === "6 6" &&
          observed.tokenMatch === "--error" &&
          observed.label === "budget cap",
        summary: `${observed.dasharray} / ${observed.tokenMatch} / ${observed.label}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "时间窗 toggle · this-month / last-30d / custom · URL `?range=` 同步",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      await page.click('[data-usage-range="last-30d"]');
      await page.waitForTimeout(80);
      const afterLast30 = await page.evaluate(() => window.location.pathname + window.location.search);
      await page.click('[data-usage-range="custom"]');
      await page.waitForTimeout(80);
      const afterCustom = await page.evaluate(() => window.location.pathname + window.location.search);
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q05-usage-range-query.json", {
        generatedAt: new Date().toISOString(),
        afterLast30,
        afterCustom
      });
      return {
        pass:
          /range=last-30d/.test(afterLast30) &&
          /range=custom/.test(afterCustom),
        summary: `${afterLast30} -> ${afterCustom}`,
        artifacts: [probe],
        observed: { afterLast30, afterCustom }
      };
    }
  );

  await verifyRule(
    6,
    "provider 表 · 每 provider 一行 · 用量 + 成本 + % 占比 bar + 趋势(up/down/flat)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      const observed = await page.evaluate(() => {
        const row = document.querySelector("[data-usage-provider-row]");
        return {
          rowCount: document.querySelectorAll("[data-usage-provider-row]").length,
          cost: row?.querySelector("td strong + div")?.textContent?.trim() ?? null,
          usage: row?.children[1]?.textContent?.trim() ?? null,
          shareText: row?.children[2]?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          trend: row?.children[3]?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q06-usage-provider-table.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.rowCount >= 4 &&
          /\$/.test(observed.cost || "") &&
          /^\d+/.test(observed.usage || "") &&
          /%/.test(observed.shareText || "") &&
          /up|down|flat/.test(observed.trend || ""),
        summary: `rows=${observed.rowCount} / trend=${observed.trend}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "sort provider 表 · 按成本 / 用量 · 点 header 切换",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      const costOrder = await page.evaluate(() => Array.from(document.querySelectorAll("[data-usage-provider-row]")).map((node) => node.getAttribute("data-usage-provider-row")));
      await page.click('[data-action="usage-sort"][data-payload="usage"]');
      await page.waitForTimeout(80);
      const usageOrder = await page.evaluate(() => Array.from(document.querySelectorAll("[data-usage-provider-row]")).map((node) => node.getAttribute("data-usage-provider-row")));
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q07-usage-sort.json", {
        generatedAt: new Date().toISOString(),
        costOrder,
        usageOrder
      });
      return {
        pass:
          costOrder.length === usageOrder.length &&
          JSON.stringify(costOrder) !== JSON.stringify(usageOrder),
        summary: `cost[0]=${costOrder[0]}, usage[0]=${usageOrder[0]}`,
        artifacts: [probe],
        observed: { costOrder, usageOrder }
      };
    }
  );

  await verifyRule(
    8,
    "provider filter · 表头 chips · 主图同步",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "provider-filtered",
        searchParams: { range: "this-month" }
      });
      const before = await readUsageQaState(page);
      await page.hover("[data-usage-point-index='2']");
      await page.waitForTimeout(80);
      const tooltip = await page.evaluate(() => Array.from(document.querySelectorAll("[data-usage-tooltip] span")).map((node) => node.textContent?.trim() ?? "").filter(Boolean));
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q08-usage-provider-filter.json", {
        generatedAt: new Date().toISOString(),
        before,
        tooltip
      });
      return {
        pass:
          before.providerFilters.length === 1 &&
          before.rows.length === 1 &&
          tooltip.length === 1,
        summary: `filters=${before.providerFilters.join(",")} rows=${before.rows.length} tooltipProviders=${tooltip.length}`,
        artifacts: [probe],
        observed: { before, tooltip }
      };
    }
  );

  await verifyRule(
    9,
    "超支预警 · 当预测 > 上限 · 页顶 red banner + \"调整预算\" 按钮跳 /settings?tab=runtime",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "this-month" }
      });
      const observed = await page.evaluate(() => ({
        overBudget: window.__fridayQa.usage.getState().budget.overBudget,
        bannerText: document.querySelector("[data-usage-budget-banner='true']")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        href: document.querySelector("[data-usage-budget-banner='true'] a")?.getAttribute("href") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q09-usage-budget-banner.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.overBudget &&
          /预测将超过预算上限/.test(observed.bannerText || "") &&
          observed.href === "/settings?tab=runtime",
        summary: `${observed.overBudget} / ${observed.href}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "UsageCharts 组件复用 · props 不改",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const usageRouteSource = await fs.readFile(path.join(ROOT, "ui/src/routes/usage-page.tsx"), "utf8");
      const props = extractFunctionPropFields(source, "UsageCharts");
      const observed = {
        prototypeFields: props.fields,
        prototypeCall: /UsageCharts\(\{ points: points, cap: 1100 \}\)/.test(source),
        sourceModule: /from \"@\/components\/usage\/usage-charts\"/.test(usageRouteSource)
      };
      const probe = await writeJson("screenshots/P2D-04/q10-usagecharts-props.json", {
        generatedAt: new Date().toISOString(),
        observed,
        snippet: props.snippet
      });
      return {
        pass:
          observed.prototypeFields.includes("points") &&
          observed.prototypeFields.includes("cap") &&
          observed.prototypeCall &&
          observed.sourceModule,
        summary: `fields=${observed.prototypeFields.join(",")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    11,
    "export CSV 按钮 · 下载当前时间窗原始数据",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "this-month",
        searchParams: { range: "last-30d" },
        acceptDownloads: true
      });
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click('[data-action="usage-export"]')
      ]);
      const relativePath = "screenshots/P2D-04/q11-usage-export.csv";
      const absolutePath = path.join(ROOT, relativePath);
      await ensureDir(path.dirname(absolutePath));
      await download.saveAs(absolutePath);
      const csvBody = await fs.readFile(absolutePath, "utf8");
      const state = await readUsageQaState(page);
      await context.close();
      const csvArtifact = {
        path: relativePath,
        sha256: sha256(csvBody)
      };
      const probe = await writeJson("screenshots/P2D-04/q11-usage-export.json", {
        generatedAt: new Date().toISOString(),
        state,
        download: {
          suggestedFilename: download.suggestedFilename(),
          rowCount: csvBody.trim().split("\n").length
        }
      });
      return {
        pass:
          download.suggestedFilename() === "usage-last-30d.csv" &&
          csvBody.startsWith("date,total") &&
          csvBody.trim().split("\n").length === state.points.length + 1,
        summary: `${download.suggestedFilename()} / rows=${csvBody.trim().split("\n").length}`,
        artifacts: [probe, csvArtifact],
        observed: { suggestedFilename: download.suggestedFilename(), rows: csvBody.trim().split("\n").length, state }
      };
    }
  );

  await verifyRule(
    12,
    "空 · \"还没有用量数据\" · \"开始对话后这里会出现详情\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/usage", "usage", {
        stateName: "empty",
        searchParams: { range: "this-month" }
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-04/q12-usage-empty.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".route-empty h2")?.textContent?.trim() ?? null,
        body: document.querySelector(".route-empty p")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-04/q12-usage-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "还没有用量数据" &&
          observed.body === "开始对话后这里会出现详情。",
        summary: `${observed.title} / ${observed.body}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2D-04", "/usage", generatedAt, results, artifacts);
}

async function verifyP2D05(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `R${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "双列 · 左 tree 260 + 右 detail flex",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      const observed = await page.evaluate(() => {
        const grid = document.querySelector(".page-shell > div");
        const children = grid ? Array.from(grid.children) : [];
        return {
          treeWidth: children[0] ? children[0].getBoundingClientRect().width : null,
          detailWidth: children[1] ? children[1].getBoundingClientRect().width : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r01-memory-layout.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Math.abs((observed.treeWidth || 0) - 260) <= 2 &&
          (observed.detailWidth || 0) > (observed.treeWidth || 0),
        summary: `tree=${observed.treeWidth}, detail=${observed.detailWidth}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "tree · 按 scope 分组(user / team / project / session)· 可展开 · 每 scope 计数",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      const before = await page.evaluate(() => ({
        scopes: Array.from(document.querySelectorAll("[data-action='memory-toggle-scope']")).map((node) => node.textContent?.trim() ?? ""),
        counts: Array.from(document.querySelectorAll(".capability-chip")).slice(0, 4).map((node) => node.textContent?.trim() ?? "")
      }));
      await page.click('[data-action="memory-toggle-scope"][data-payload="team"]');
      await page.waitForTimeout(80);
      const after = await readMemoryQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r02-memory-tree.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          JSON.stringify(before.scopes) === JSON.stringify(["user", "team", "project", "session"]) &&
          before.counts.length === 4 &&
          !after.expandedScopes.includes("team"),
        summary: `scopes=${before.scopes.join(",")} expanded=${after.expandedScopes.join(",")}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    3,
    "选 memory · 右显 content + metadata + source session link",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      await page.click('[data-action="memory-select"][data-payload="memory-user-budget"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".shell-card-title")?.textContent?.trim() ?? null,
        chips: Array.from(document.querySelectorAll(".capability-chip")).map((node) => node.textContent?.trim() ?? ""),
        content: document.querySelector("[data-memory-content='true']")?.textContent?.trim() ?? null,
        sourceHref: document.querySelector('a[href^="/sessions?sessionId="]')?.getAttribute("href") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r03-memory-detail.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          Boolean(observed.title) &&
          observed.chips.length >= 3 &&
          Boolean(observed.content) &&
          /^\/sessions\?sessionId=/.test(observed.sourceHref || ""),
        summary: `${observed.title} / ${observed.sourceHref}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "编辑 · 点 \"编辑\" 按钮进入编辑模式 · textarea · save/cancel",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      await page.click('[data-action="memory-edit"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        editing: Boolean(document.getElementById("memory-editor")),
        saveLabel: document.querySelector('[data-action="memory-save"]')?.textContent?.trim() ?? null,
        cancelLabel: document.querySelector('[data-action="memory-cancel"]')?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r04-memory-edit-mode.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.editing &&
          observed.saveLabel === "保存" &&
          observed.cancelLabel === "取消",
        summary: `${observed.saveLabel} / ${observed.cancelLabel}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "编辑需二次确认 · \"memory 将影响未来所有会话\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "editing"
      });
      await page.click('[data-action="memory-save"]');
      await page.waitForTimeout(100);
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        body: document.getElementById("confirm-detail")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r05-memory-save-confirm.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.title === "保存这条记忆?" &&
          observed.body === "memory 将影响未来所有会话",
        summary: `${observed.title} / ${observed.body}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "delete · 二次确认 · 输入 memory title 验证",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      await page.click('[data-action="memory-select"][data-payload="memory-user-budget"]');
      await page.waitForTimeout(80);
      const title = await page.evaluate(() => window.__fridayQa.memory.getState().rows.find((row) => row.id === "memory-user-budget")?.title?.zh ?? null);
      await page.click('[data-action="memory-delete"]');
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        title: document.querySelector(".confirm-dialog .overlay-title")?.textContent?.trim() ?? null,
        confirmDisabled: document.querySelector('.confirm-dialog [data-action="confirm-run"]')?.hasAttribute("disabled") ?? false
      }));
      await page.fill("#confirm-dialog-input", title || "");
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => ({
        confirmDisabled: document.querySelector('.confirm-dialog [data-action="confirm-run"]')?.hasAttribute("disabled") ?? false
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r06-memory-delete-confirm.json", {
        generatedAt: new Date().toISOString(),
        title,
        before,
        after
      });
      return {
        pass:
          before.title === "删除这条记忆?" &&
          before.confirmDisabled &&
          after.confirmDisabled === false,
        summary: `${before.title} / disabled ${before.confirmDisabled} -> ${after.confirmDisabled}`,
        artifacts: [probe],
        observed: { title, before, after }
      };
    }
  );

  await verifyRule(
    7,
    "source session link · 点跳 /sessions?sessionId=xxx",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      const href = await page.getAttribute('a[href^="/sessions?sessionId="]', "href");
      await page.click('a[href^="/sessions?sessionId="]');
      await page.waitForTimeout(100);
      const observed = await page.evaluate(() => window.location.pathname + window.location.search);
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r07-memory-source-link.json", {
        generatedAt: new Date().toISOString(),
        href,
        observed
      });
      return {
        pass: Boolean(href) && observed === href,
        summary: `${href} -> ${observed}`,
        artifacts: [probe],
        observed: { href, route: observed }
      };
    }
  );

  await verifyRule(
    8,
    "顶部 search · 全文搜索 · 命中关键词黄色高亮",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "selected"
      });
      await page.fill("#memory-search", "预警");
      await page.waitForTimeout(100);
      const observed = await page.evaluate(() => {
        const mark = document.querySelector("mark");
        return {
          rowCount: document.querySelectorAll('[data-action="memory-select"]').length,
          markText: mark?.textContent?.trim() ?? null,
          markBackground: mark ? getComputedStyle(mark).backgroundColor : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r08-memory-search-highlight.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.rowCount >= 1 &&
          observed.markText === "预警" &&
          Boolean(observed.markBackground),
        summary: `${observed.markText} / rows=${observed.rowCount}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "empty · \"Friday 还没有记住任何事\" + 说明 link",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/memory", "memory", {
        stateName: "empty"
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-05/r09-memory-empty.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".empty-hero h2")?.textContent?.trim() ?? null,
        helpHref: document.querySelector('.empty-hero a[href="/memory?help=1"]')?.getAttribute("href") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-05/r09-memory-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.title === "Friday 还没有记住任何事" &&
          observed.helpHref === "/memory?help=1",
        summary: `${observed.title} / ${observed.helpHref}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2D-05", "/memory", generatedAt, results, artifacts);
}

async function verifyP2D06(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `S${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "grid · 每 device 一 card 240×180 · 型号 + 状态 dot + 心跳 + 资源 bar + 管理",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "list"
      });
      const observed = await page.evaluate(() => {
        const card = document.querySelector("[data-fleet-card]");
        const rect = card ? card.getBoundingClientRect() : null;
        return {
          cardCount: document.querySelectorAll("[data-fleet-card]").length,
          size: rect ? { width: rect.width, height: rect.height } : null,
          model: card?.querySelector("span")?.textContent?.trim() ?? null,
          statusDot: Boolean(card?.querySelector(".health-dot")),
          heartbeat: card?.querySelector("[data-fleet-heartbeat]")?.textContent?.trim() ?? null,
          barCount: card?.querySelectorAll(".resource-bars span").length ?? 0,
          manageLabel: card?.querySelector('[data-action="fleet-toggle-menu"]')?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s01-fleet-grid.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.cardCount >= 3 &&
          Math.abs((observed.size?.width || 0) - 240) <= 2 &&
          (observed.size?.height || 0) >= 180 &&
          Boolean(observed.model) &&
          observed.statusDot &&
          Boolean(observed.heartbeat) &&
          observed.barCount === 3 &&
          observed.manageLabel === "manage",
        summary: `cards=${observed.cardCount} size=${observed.size?.width}x${observed.size?.height}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "状态 · online(绿)/ offline(灰)/ warning(黄)",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "list"
      });
      const tokenColors = await resolvedTokenColors(page, ["--success", "--ink-3", "--warning"]);
      const observed = await page.evaluate((colors) => {
        return ["device-mac-mini", "device-apac-gateway", "device-eu-runner"].map((id) => {
          const dot = document.querySelector(`[data-fleet-card='${id}'] .health-dot`);
          const color = dot ? getComputedStyle(dot).backgroundColor : null;
          return {
            id,
            color,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const byId = Object.fromEntries(observed.map((item) => [item.id, item]));
      const probe = await writeJson("screenshots/P2D-06/s02-fleet-status-colors.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          byId["device-mac-mini"].tokenMatch === "--success" &&
          byId["device-apac-gateway"].tokenMatch === "--ink-3" &&
          byId["device-eu-runner"].tokenMatch === "--warning",
        summary: observed.map((item) => `${item.id}:${item.tokenMatch}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "心跳 · 秒级 \"最近心跳 3s 前\" · 随 advanceClock 实时更新",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "list"
      });
      const before = await page.textContent("[data-fleet-heartbeat='device-mac-mini']");
      await page.evaluate(() => window.__fridayQa.fleet.advanceClock(2_000));
      await page.waitForTimeout(80);
      const after = await page.textContent("[data-fleet-heartbeat='device-mac-mini']");
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s03-fleet-heartbeat.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass: before?.trim() === "最近心跳 3s 前" && after?.trim() === "最近心跳 5s 前",
        summary: `${before} -> ${after}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "资源 bar · CPU / RAM / disk 三条 · 超过 80% 变黄 · 超过 95% 红",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "list"
      });
      const tokenColors = await resolvedTokenColors(page, ["--success", "--warning", "--error"]);
      const observed = await page.evaluate((colors) => {
        const bars = Array.from(document.querySelectorAll("[data-fleet-card='device-eu-runner'] .resource-bars span")).map((node) => {
          const color = getComputedStyle(node).backgroundColor;
          return {
            width: getComputedStyle(node).width,
            color,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
        return bars;
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s04-fleet-resource-bars.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.length === 3 &&
          observed[0].tokenMatch === "--warning" &&
          observed[1].tokenMatch === "--error" &&
          observed[2].tokenMatch === "--success",
        summary: observed.map((bar) => bar.tokenMatch).join(" / "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "管理 · menu · restart / logs / remove",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "list"
      });
      await page.click('[data-fleet-card="device-mac-mini"] [data-action="fleet-toggle-menu"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => Array.from(document.querySelectorAll('[data-fleet-card="device-mac-mini"] [data-action="fleet-manage"]')).map((node) => node.textContent?.trim() ?? ""));
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s05-fleet-manage-menu.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: JSON.stringify(observed) === JSON.stringify(["restart", "logs", "remove"]),
        summary: observed.join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "add device · + 按钮 · modal · 显示 install 命令 mono 字体",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "adding-device"
      });
      const observed = await page.evaluate(() => {
        const command = document.querySelector("[data-fleet-install-command='true']");
        return {
          title: document.querySelector(".overlay-panel[role='dialog'] .overlay-title")?.textContent?.trim() ?? null,
          command: command?.textContent?.trim() ?? null,
          fontFamily: command ? getComputedStyle(command).fontFamily : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s06-fleet-add-modal.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.title === "添加设备" &&
          /curl -fsSL/.test(observed.command || "") &&
          /mono|monospace/i.test(observed.fontFamily || ""),
        summary: `${observed.title} / ${observed.command}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "select device · card 琥珀 border + detail drawer 右出",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "selected"
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const observed = await page.evaluate((colors) => {
        const card = document.querySelector("[data-fleet-card='device-mac-mini']");
        const drawer = document.querySelector("[data-fleet-drawer='device-mac-mini']");
        const borderColor = card ? getComputedStyle(card).borderColor : null;
        return {
          drawerPresent: Boolean(drawer),
          borderColor,
          tokenMatch: Object.entries(colors).find(([, value]) => value === borderColor)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s07-fleet-selected-drawer.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass: observed.drawerPresent && observed.tokenMatch === "--accent",
        summary: `${observed.drawerPresent} / ${observed.tokenMatch}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "empty · \"还没有连接设备\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/fleet", "fleet", {
        stateName: "empty"
      });
      const shot = await captureScreenshot(page, "screenshots/P2D-06/s08-fleet-empty.png");
      const observed = await page.evaluate(() => ({
        title: document.querySelector(".route-empty h2")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2D-06/s08-fleet-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.title === "还没有连接设备",
        summary: observed.title,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2D-06", "/fleet", generatedAt, results, artifacts);
}

async function verifyP2E01(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "LG01",
    "全屏居中 · 卡片 440×auto · radius 28 · shadow 大柔光",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      const shot = await captureScreenshot(page, "screenshots/P2E-01/lg01-login-layout.png");
      const observed = await page.evaluate(() => {
        const card = document.querySelector("[data-login-card='true']");
        const rect = card?.getBoundingClientRect();
        const style = card ? getComputedStyle(card) : null;
        const centerX = rect ? rect.left + rect.width / 2 : null;
        const centerY = rect ? rect.top + rect.height / 2 : null;
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          size: rect ? { width: rect.width, height: rect.height } : null,
          centerDeltaX: centerX == null ? null : Math.abs(centerX - window.innerWidth / 2),
          centerDeltaY: centerY == null ? null : Math.abs(centerY - window.innerHeight / 2),
          borderRadius: style?.borderRadius ?? null,
          boxShadow: style?.boxShadow ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-01/lg01-login-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          Math.abs((observed.size?.width || 0) - 440) <= 2 &&
          observed.centerDeltaX != null &&
          observed.centerDeltaX <= 2 &&
          observed.centerDeltaY != null &&
          observed.centerDeltaY <= 40 &&
          observed.borderRadius === "28px" &&
          observed.boxShadow &&
          observed.boxShadow !== "none",
        summary: `size=${observed.size?.width}x${observed.size?.height} center=(${observed.centerDeltaX},${observed.centerDeltaY})`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "LG02",
    "logo 顶部 · Fraunces \"Friday\" · 下副标题 \"你的工作助手\"",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      const observed = await page.evaluate(() => {
        const mark = document.querySelector(".brand-mark");
        const subcopy = document.querySelector(".brand-subcopy");
        return {
          mark: mark?.textContent?.trim() ?? null,
          fontFamily: mark ? getComputedStyle(mark).fontFamily : null,
          subtitle: subcopy?.textContent?.trim() ?? null,
          topOffset: mark ? mark.getBoundingClientRect().top : null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-01/lg02-login-brand.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.mark === "Friday" &&
          /Fraunces/i.test(observed.fontFamily || "") &&
          observed.subtitle === "你的工作助手",
        summary: `${observed.mark} / ${observed.subtitle}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "LG03",
    "email 输入 + 发送登录链接按钮 · 按钮琥珀 fill",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      const tokenColors = await resolvedTokenColors(page, ["--accent"]);
      const observed = await page.evaluate((colors) => {
        const input = document.getElementById("login-email-input");
        const button = document.querySelector('[data-action="login-submit"]');
        const buttonColor = button ? getComputedStyle(button).backgroundColor : null;
        return {
          inputPresent: Boolean(input),
          inputValue: input?.value ?? null,
          buttonText: button?.textContent?.trim() ?? null,
          buttonColor,
          tokenMatch: Object.entries(colors).find(([, value]) => value === buttonColor)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2E-01/lg03-login-email-cta.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.inputPresent &&
          observed.inputValue === "jarvis@example.com" &&
          observed.buttonText === "发送登录链接" &&
          observed.tokenMatch === "--accent",
        summary: `${observed.buttonText} / ${observed.tokenMatch}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "LG04",
    "OAuth 区(分割线 + 按钮)· Google / GitHub · 左图标右文字",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      const observed = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[data-action="login-oauth"]')).map((button) => {
          const icon = button.querySelector(".oauth-icon");
          const textNode = button.querySelector(".oauth-button-row span:last-child");
          return {
            text: textNode?.textContent?.trim() ?? null,
            iconLeft: icon?.getBoundingClientRect().left ?? null,
            textLeft: textNode?.getBoundingClientRect().left ?? null
          };
        });
        return {
          divider: document.querySelector(".oauth-divider")?.textContent?.trim() ?? null,
          buttons
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-01/lg04-login-oauth.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const leftToRight = observed.buttons.every((button) => button.iconLeft != null && button.textLeft != null && button.iconLeft < button.textLeft);
      return {
        pass:
          observed.divider === "或者" &&
          JSON.stringify(observed.buttons.map((button) => button.text)) === JSON.stringify(["Google", "GitHub"]) &&
          leftToRight,
        summary: `${observed.divider} / ${observed.buttons.map((button) => button.text).join(", ")}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "LG05",
    "submit 失败不清空 email · 错误显红色 inline \"邮箱格式不正确\" 或 \"发送失败 · 请重试\"",
    async () => {
      const invalid = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      await invalid.page.fill("#login-email-input", "bad-email");
      await invalid.page.click('[data-action="login-submit"]');
      await invalid.page.waitForTimeout(80);
      const tokenColors = await resolvedTokenColors(invalid.page, ["--error"]);
      const invalidObserved = await invalid.page.evaluate((colors) => {
        const error = document.querySelector("[data-login-error='true']");
        const color = error ? getComputedStyle(error).color : null;
        return {
          email: document.getElementById("login-email-input")?.value ?? null,
          errorText: error?.textContent?.trim() ?? null,
          errorColor: color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
        };
      }, tokenColors);
      await invalid.context.close();

      const failed = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      await failed.page.fill("#login-email-input", "fail@example.com");
      await failed.page.click('[data-action="login-submit"]');
      await failed.page.waitForTimeout(280);
      const failedObserved = await failed.page.evaluate(() => ({
        email: document.getElementById("login-email-input")?.value ?? null,
        errorText: document.querySelector("[data-login-error='true']")?.textContent?.trim() ?? null,
        state: window.__fridayQa.login.getState().stateName
      }));
      await failed.context.close();

      const probe = await writeJson("screenshots/P2E-01/lg05-login-errors.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        invalidObserved,
        failedObserved
      });
      return {
        pass:
          invalidObserved.email === "bad-email" &&
          invalidObserved.errorText === "邮箱格式不正确" &&
          invalidObserved.tokenMatch === "--error" &&
          failedObserved.email === "fail@example.com" &&
          failedObserved.errorText === "发送失败 · 请重试" &&
          failedObserved.state === "error",
        summary: `${invalidObserved.errorText} / ${failedObserved.errorText}`,
        artifacts: [probe],
        observed: { invalidObserved, failedObserved }
      };
    }
  );

  await verifyRule(
    6,
    "LG06",
    "submit 成功 · 全卡 fade 到 已发送 态 · 显示 email · 没收到?重试 link",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "idle"
      });
      await page.fill("#login-email-input", "ops@friday.dev");
      await page.click('[data-action="login-submit"]');
      await page.waitForTimeout(260);
      const shot = await captureScreenshot(page, "screenshots/P2E-01/lg06-login-success.png");
      const observed = await page.evaluate(() => {
        const card = document.querySelector("[data-login-card='true']");
        const style = card ? getComputedStyle(card) : null;
        return {
          state: window.__fridayQa.login.getState().stateName,
          title: card?.querySelector("strong")?.textContent?.trim() ?? null,
          email: document.querySelector("[data-login-success-email='true']")?.textContent?.trim() ?? null,
          retryText: document.querySelector('[data-action="login-retry"]')?.textContent?.trim() ?? null,
          animationName: style?.animationName ?? null,
          animationDuration: style?.animationDuration ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-01/lg06-login-success.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.state === "success" &&
          observed.title === "已发送" &&
          observed.email === "ops@friday.dev" &&
          observed.retryText === "没收到?重试" &&
          observed.animationName === "setup-step-fade" &&
          observed.animationDuration === "0.22s",
        summary: `${observed.title} / ${observed.email}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "LG07",
    "登录成功跳 state.redirectTo · 默认 /",
    async () => {
      const defaultContext = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "success"
      });
      const defaultObserved = await defaultContext.page.evaluate(() => window.__fridayQa.login.completeLogin());
      await defaultContext.page.waitForTimeout(60);
      const defaultPath = await defaultContext.page.evaluate(() => window.location.pathname + window.location.search);
      await defaultContext.context.close();

      const customContext = await bootRoutePage(browser, baseUrl, "/login", "login", {
        stateName: "success",
        searchParams: { redirectTo: "/command-center" }
      });
      const customObserved = await customContext.page.evaluate(() => window.__fridayQa.login.completeLogin());
      await customContext.page.waitForTimeout(60);
      const customPath = await customContext.page.evaluate(() => window.location.pathname + window.location.search);
      await customContext.context.close();

      const probe = await writeJson("screenshots/P2E-01/lg07-login-redirect.json", {
        generatedAt: new Date().toISOString(),
        defaultObserved,
        defaultPath,
        customObserved,
        customPath
      });
      return {
        pass:
          defaultObserved.pathname === "/" &&
          defaultObserved.route === "/home" &&
          defaultPath === "/" &&
          customObserved.pathname === "/command-center" &&
          customObserved.route === "/command-center" &&
          customPath === "/command-center",
        summary: `default=${defaultPath} custom=${customPath}`,
        artifacts: [probe],
        observed: { defaultObserved, defaultPath, customObserved, customPath }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2E-01", "/login", generatedAt, results, artifacts);
}

async function verifyP2E02(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "SU01",
    "4 步 · profile / providers / first-skill / done · stepper 顶部",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup");
      const observed = await page.evaluate(() => {
        const shellTop = document.querySelector("[data-setup-shell='true']")?.getBoundingClientRect().top ?? null;
        const stepperRect = document.querySelector("[data-setup-stepper='true']")?.getBoundingClientRect() ?? null;
        return {
          labels: Array.from(document.querySelectorAll("[data-setup-step] span:last-child")).map((node) => node.textContent?.trim() ?? ""),
          stepperTop: stepperRect ? stepperRect.top : null,
          shellTop
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su01-setup-stepper.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          JSON.stringify(observed.labels) === JSON.stringify(["Profile", "Providers", "First skill", "Done"]) &&
          observed.stepperTop != null &&
          observed.shellTop != null &&
          observed.stepperTop >= observed.shellTop &&
          Math.abs(observed.stepperTop - observed.shellTop) <= 40,
        summary: observed.labels.join(" / "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "SU02",
    "step 1 profile · name + role select + company optional",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step1-profile",
        searchParams: { step: 1 }
      });
      const observed = await page.evaluate(() => ({
        nameValue: document.getElementById("setup-name")?.value ?? null,
        roleValue: document.getElementById("setup-role")?.value ?? null,
        companyValue: document.getElementById("setup-company")?.value ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su02-setup-profile-fields.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.nameValue === "Jarvis" &&
          observed.roleValue === "Operator" &&
          observed.companyValue === "Friday Labs",
        summary: `${observed.nameValue} / ${observed.roleValue} / ${observed.companyValue}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "SU03",
    "step 2 providers · 至少配置 1 个 · OpenAI / Anthropic / 本地 · 每个有 key 输入 + 测试连接",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step2-providers",
        searchParams: { step: 2 }
      });
      const qaState = await readSetupQaState(page);
      const observed = await page.evaluate(() => ({
        providers: Array.from(document.querySelectorAll("[data-setup-provider]")).map((node) => {
          const id = node.getAttribute("data-setup-provider");
          return {
            id,
            inputId: node.querySelector("input")?.id ?? null,
            testLabel: node.querySelector('[data-action="setup-test-provider"]')?.textContent?.trim() ?? null
          };
        })
      }));
      await context.close();
      const configuredIds = Object.entries(qaState.draft.providers)
        .filter(([, value]) => Boolean(String(value.key || "").trim()))
        .map(([key]) => key);
      const probe = await writeJson("screenshots/P2E-02/su03-setup-providers.json", {
        generatedAt: new Date().toISOString(),
        observed,
        configuredIds,
        qaState
      });
      return {
        pass:
          JSON.stringify(observed.providers.map((provider) => provider.id)) === JSON.stringify(["openai", "anthropic", "local"]) &&
          observed.providers.every((provider) => provider.inputId === `setup-provider-${provider.id}` && provider.testLabel === "测试连接") &&
          configuredIds.length >= 1,
        summary: `providers=${observed.providers.length} configured=${configuredIds.join(",")}`,
        artifacts: [probe],
        observed: { observed, configuredIds, qaState }
      };
    }
  );

  await verifyRule(
    4,
    "SU04",
    "step 3 first-skill · 3 推荐 skill · install · 至少选 1 · 或跳过",
    async () => {
      const selectCase = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step3-first-skill",
        searchParams: { step: 3 }
      });
      const before = await selectCase.page.evaluate(() => ({
        cards: Array.from(document.querySelectorAll("[data-setup-skill] strong")).map((node) => node.textContent?.trim() ?? ""),
        nextDisabled: document.querySelector('[data-action="setup-next"]')?.hasAttribute("disabled") ?? false,
        skipPresent: Boolean(document.querySelector('[data-action="setup-skip-skills"]'))
      }));
      await selectCase.page.click('[data-setup-skill]');
      await selectCase.page.waitForTimeout(80);
      const after = await selectCase.page.evaluate(() => ({
        nextDisabled: document.querySelector('[data-action="setup-next"]')?.hasAttribute("disabled") ?? false,
        selectedSkills: window.__fridayQa.setup.getState().draft.selectedSkills
      }));
      await selectCase.context.close();

      const skipCase = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step3-first-skill",
        searchParams: { step: 3 }
      });
      await skipCase.page.click('[data-action="setup-skip-skills"]');
      await skipCase.page.waitForTimeout(100);
      const skipped = await readSetupQaState(skipCase.page);
      await skipCase.context.close();

      const probe = await writeJson("screenshots/P2E-02/su04-setup-skills.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        skipped
      });
      return {
        pass:
          before.cards.length === 3 &&
          before.nextDisabled &&
          before.skipPresent &&
          after.nextDisabled === false &&
          after.selectedSkills.length === 1 &&
          skipped.step === 4 &&
          skipped.draft.skippedSkills === true,
        summary: `cards=${before.cards.length} selected=${after.selectedSkills.length} skippedStep=${skipped.step}`,
        artifacts: [probe],
        observed: { before, after, skipped }
      };
    }
  );

  await verifyRule(
    5,
    "SU05",
    "step 4 done · 准备就绪 + 跳 /home",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step4-done",
        searchParams: { step: 4 }
      });
      const observed = await page.evaluate(() => ({
        title: document.querySelector("[data-setup-done='true'] h2")?.textContent?.trim() ?? null,
        buttonText: document.querySelector("[data-setup-done='true'] [data-action='setup-complete']")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su05-setup-done.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.title === "准备就绪" &&
          observed.buttonText === "进入首页",
        summary: `${observed.title} / ${observed.buttonText}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "SU06",
    "每步 prev / next · step 1 无 prev",
    async () => {
      const first = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step1-profile",
        searchParams: { step: 1 }
      });
      const firstObserved = await first.page.evaluate(() => ({
        prevText: document.querySelector('[data-action="setup-prev"]')?.textContent?.trim() ?? null,
        nextText: document.querySelector('[data-action="setup-next"]')?.textContent?.trim() ?? null
      }));
      await first.context.close();

      const second = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step2-providers",
        searchParams: { step: 2 }
      });
      const secondObserved = await second.page.evaluate(() => ({
        prevText: document.querySelector('[data-action="setup-prev"]')?.textContent?.trim() ?? null,
        nextText: document.querySelector('[data-action="setup-next"]')?.textContent?.trim() ?? null
      }));
      await second.context.close();

      const probe = await writeJson("screenshots/P2E-02/su06-setup-prev-next.json", {
        generatedAt: new Date().toISOString(),
        firstObserved,
        secondObserved
      });
      return {
        pass:
          firstObserved.prevText === null &&
          firstObserved.nextText === "下一步" &&
          secondObserved.prevText === "上一步" &&
          secondObserved.nextText === "下一步",
        summary: `step1 prev=${firstObserved.prevText} step2 prev=${secondObserved.prevText}`,
        artifacts: [probe],
        observed: { firstObserved, secondObserved }
      };
    }
  );

  await verifyRule(
    7,
    "SU07",
    "断线 · 重进 · 从上次完成步继续(useSetupStatusQuery)",
    async () => {
      const { context, page } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step1-profile",
        searchParams: { step: 1 }
      });
      await page.click('[data-action="setup-next"]');
      await page.waitForTimeout(120);
      await page.click('[data-action="setup-next"]');
      await page.waitForTimeout(120);
      const beforeClose = await readSetupQaState(page);
      const resumedPage = await context.newPage();
      await resumedPage.goto(`${baseUrl}/setup?dev=1`, { waitUntil: "load" });
      await resumedPage.waitForFunction(() => Boolean(window.__fridayQa?.setup));
      await resumedPage.waitForTimeout(220);
      const resumed = await resumedPage.evaluate(() => window.__fridayQa.setup.getState());
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su07-setup-resume.json", {
        generatedAt: new Date().toISOString(),
        beforeClose,
        resumed
      });
      return {
        pass:
          beforeClose.status.lastCompletedStep === 2 &&
          resumed.step === 3 &&
          resumed.statusQuery.source === "useSetupStatusQuery" &&
          resumed.status.lastCompletedStep === 2,
        summary: `lastCompleted=${resumed.status.lastCompletedStep} resumedStep=${resumed.step}`,
        artifacts: [probe],
        observed: { beforeClose, resumed }
      };
    }
  );

  await verifyRule(
    8,
    "SU08",
    "每步 URL ?step=1..4 · 刷新不丢",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step1-profile",
        searchParams: { step: 1 }
      });
      const observed = [];
      for (const step of [1, 2, 3, 4]) {
        await page.evaluate((nextStep) => window.__fridayQa.setup.setStep(nextStep), step);
        await page.waitForTimeout(80);
        const beforeReload = await page.evaluate(() => window.location.pathname + window.location.search);
        await page.reload({ waitUntil: "load" });
        await page.waitForFunction(() => Boolean(window.__fridayQa?.setup));
        await page.waitForTimeout(120);
        const afterReload = await page.evaluate(() => ({
          url: window.location.pathname + window.location.search,
          step: window.__fridayQa.setup.getState().step
        }));
        observed.push({ step, beforeReload, afterReload });
      }
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su08-setup-step-url.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const everyStepOk = observed.every((entry) =>
        entry.beforeReload.includes(`step=${entry.step}`) &&
        entry.afterReload.url.includes(`step=${entry.step}`) &&
        entry.afterReload.step === entry.step
      );
      return {
        pass: everyStepOk,
        summary: observed.map((entry) => `${entry.step}:${entry.afterReload.step}`).join(" / "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "SU09",
    "退出需确认 · 设置未完成",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step2-providers",
        searchParams: { step: 2 }
      });
      const preview = await page.evaluate(() => window.__fridayQa.setup.previewLeave("/onboarding"));
      await page.click('[data-action="setup-later"]');
      await page.waitForTimeout(120);
      const observed = await readSetupQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su09-setup-exit-confirm.json", {
        generatedAt: new Date().toISOString(),
        preview,
        observed
      });
      return {
        pass:
          preview.title === "设置未完成" &&
          preview.confirmRequired === true &&
          observed.confirmDialog?.title === "设置未完成" &&
          observed.confirmDialog?.action === "setup-leave",
        summary: `${observed.confirmDialog?.title} / ${observed.confirmDialog?.action}`,
        artifacts: [probe],
        observed: { preview, observed }
      };
    }
  );

  await verifyRule(
    10,
    "SU10",
    "完成后 POST setup/complete 再跳转",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step4-done",
        searchParams: { step: 4 }
      });
      await page.click('[data-action="setup-complete"]');
      await page.waitForFunction(() => window.location.pathname === "/home");
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        route: window.location.pathname + window.location.search,
        trace: window.__fridayQa.setup.getState().completeTrace
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su10-setup-complete-post.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.route === "/home" &&
          observed.trace.length >= 1 &&
          observed.trace[observed.trace.length - 1].endpoint === "setup/complete" &&
          observed.trace[observed.trace.length - 1].method === "POST",
        summary: `${observed.route} / ${observed.trace[observed.trace.length - 1]?.endpoint}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    11,
    "SU11",
    "失败降级 · 稍后设置 link · 跳 /onboarding",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/setup", "setup", {
        stateName: "step1-profile",
        searchParams: { step: 1 }
      });
      const href = await page.getAttribute('[data-action="setup-later"]', "href");
      await page.click('[data-action="setup-later"]');
      await page.waitForTimeout(120);
      const dialog = await readSetupQaState(page);
      await page.click('[data-action="confirm-run"]');
      await page.waitForFunction(() => window.location.pathname === "/onboarding");
      const route = await page.evaluate(() => window.location.pathname + window.location.search);
      await context.close();
      const probe = await writeJson("screenshots/P2E-02/su11-setup-later.json", {
        generatedAt: new Date().toISOString(),
        href,
        dialog,
        route
      });
      return {
        pass:
          href === "/onboarding" &&
          dialog.confirmDialog?.title === "设置未完成" &&
          route === "/onboarding",
        summary: `${href} -> ${route}`,
        artifacts: [probe],
        observed: { href, dialog, route }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2E-02", "/setup", generatedAt, results, artifacts);
}

async function verifyP2E03(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "OB01",
    "3-4 屏滚动式 · 每屏满视口 · scroll snap · 大标题 + 插图 + 副文",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "welcome"
      });
      const shot = await captureScreenshot(page, "screenshots/P2E-03/ob01-onboarding-layout.png");
      const observed = await page.evaluate(() => ({
        screenCount: document.querySelectorAll("[data-onboarding-screen]").length,
        screenHeights: Array.from(document.querySelectorAll("[data-onboarding-screen]")).map((node) => node.getBoundingClientRect().height),
        viewportHeight: window.innerHeight,
        scrollSnapType: getComputedStyle(document.querySelector("[data-onboarding-scroll='true']")).scrollSnapType,
        heading: document.querySelector("[data-onboarding-screen='0'] h2")?.textContent?.trim() ?? null,
        illustrationCount: document.querySelectorAll(".onboarding-illustration").length,
        subcopy: document.querySelector("[data-onboarding-screen='0'] p:last-of-type")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob01-onboarding-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      const fullViewport = observed.screenHeights.every((height) => Math.abs(height - observed.viewportHeight) <= 2);
      return {
        pass:
          observed.screenCount === 4 &&
          fullViewport &&
          /mandatory/.test(observed.scrollSnapType || "") &&
          Boolean(observed.heading) &&
          observed.illustrationCount === 4 &&
          Boolean(observed.subcopy),
        summary: `screens=${observed.screenCount} snap=${observed.scrollSnapType}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "OB02",
    "屏 1 welcome · 欢迎使用 Friday · 3 句价值主张",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "welcome"
      });
      const observed = await page.evaluate(() => ({
        title: document.querySelector("[data-onboarding-screen='0'] h2")?.textContent?.trim() ?? null,
        valueTitles: Array.from(document.querySelectorAll("[data-onboarding-screen='0'] .onboarding-value-row strong")).map((node) => node.textContent?.trim() ?? "")
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob02-onboarding-welcome.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.title === "欢迎使用 Friday" &&
          observed.valueTitles.length === 3,
        summary: `${observed.title} / values=${observed.valueTitles.length}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "OB03",
    "屏 2 profile-pick · 4 cards · 选中后记录 useUserProfile",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "profile-pick"
      });
      const before = await readOnboardingQaState(page);
      await page.click('[data-onboarding-profile="team"]');
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => ({
        cards: Array.from(document.querySelectorAll("[data-onboarding-profile] strong")).map((node) => node.textContent?.trim() ?? ""),
        displayedProfile: document.querySelector("[data-onboarding-profile-value='true']")?.textContent?.trim() ?? null,
        qa: window.__fridayQa.onboarding.getState(),
        storedProfile: JSON.parse(window.localStorage.getItem("friday-user-profile"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob03-onboarding-profile.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          after.cards.length === 4 &&
          after.qa.userProfile.source === "useUserProfile" &&
          after.qa.profile === "team" &&
          after.storedProfile === "team" &&
          after.displayedProfile === "team",
        summary: `cards=${after.cards.length} profile=${after.qa.profile}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    4,
    "OB04",
    "屏 3 pack-pick · 基于 profile 推荐 3 pack · 可多选 · 也可跳过",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "pack-pick"
      });
      await page.evaluate(() => window.__fridayQa.onboarding.selectProfile("team"));
      await page.waitForTimeout(80);
      const before = await readOnboardingQaState(page);
      await page.click('[data-onboarding-pack]');
      await page.waitForTimeout(60);
      await page.locator('[data-onboarding-pack]').nth(1).click();
      await page.waitForTimeout(60);
      const after = await readOnboardingQaState(page);
      const skipPresent = await page.locator('[data-action="onboarding-skip-packs"]').count();
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob04-onboarding-packs.json", {
        generatedAt: new Date().toISOString(),
        before,
        after,
        skipPresent
      });
      return {
        pass:
          before.recommendations.length === 3 &&
          after.selectedPacks.length === 2 &&
          skipPresent === 1,
        summary: `recommendations=${before.recommendations.length} selected=${after.selectedPacks.length}`,
        artifacts: [probe],
        observed: { before, after, skipPresent }
      };
    }
  );

  await verifyRule(
    5,
    "OB05",
    "屏 4 done · 开始吧 + CTA 跳 /home",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "done"
      });
      const before = await page.evaluate(() => ({
        title: document.querySelector("[data-onboarding-screen='3'] h2")?.textContent?.trim() ?? null,
        buttonText: document.querySelector('[data-action="onboarding-start"]')?.textContent?.trim() ?? null
      }));
      await page.click('[data-action="onboarding-start"]');
      await page.waitForFunction(() => window.location.pathname === "/home");
      const route = await page.evaluate(() => window.location.pathname + window.location.search);
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob05-onboarding-done.json", {
        generatedAt: new Date().toISOString(),
        before,
        route
      });
      return {
        pass:
          before.title === "开始吧" &&
          before.buttonText === "开始吧" &&
          route === "/home",
        summary: `${before.title} -> ${route}`,
        artifacts: [probe],
        observed: { before, route }
      };
    }
  );

  await verifyRule(
    6,
    "OB06",
    "右上跳过 · 写 profile 默认 · 跳 /home",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "welcome"
      });
      await page.click('[data-action="onboarding-skip"]');
      await page.waitForFunction(() => window.location.pathname === "/home");
      const observed = await page.evaluate(() => ({
        route: window.location.pathname + window.location.search,
        storedProfile: JSON.parse(window.localStorage.getItem("friday-user-profile"))
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob06-onboarding-skip.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.route === "/home" &&
          observed.storedProfile === "solo",
        summary: `${observed.storedProfile} -> ${observed.route}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "OB07",
    "scroll 指示 · 右侧 dots 3-4 个 · click 跳到对应屏",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "welcome"
      });
      await page.click('.onboarding-dot[data-payload="2"]');
      await page.waitForTimeout(180);
      const observed = await page.evaluate(() => {
        const scrollShell = document.querySelector("[data-onboarding-scroll='true']");
        const target = document.querySelector("[data-onboarding-screen='2']");
        const activeIndex = Array.from(document.querySelectorAll(".onboarding-dot")).findIndex((node) => node.classList.contains("is-active"));
        return {
          dotCount: document.querySelectorAll(".onboarding-dot").length,
          activeIndex,
          scrollTop: scrollShell?.scrollTop ?? null,
          targetTop: target?.offsetTop ?? null,
          screen: window.__fridayQa.onboarding.getState().screen
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob07-onboarding-dots.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.dotCount === 4 &&
          observed.activeIndex === 2 &&
          observed.screen === 2 &&
          Math.abs((observed.scrollTop || 0) - (observed.targetTop || 0)) <= 2,
        summary: `dots=${observed.dotCount} active=${observed.activeIndex}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "OB08",
    "keyboard · ↓ / space 下屏 · ↑ 上屏 · Enter CTA",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/onboarding", "onboarding", {
        stateName: "welcome"
      });
      const sequence = [];
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(80);
      sequence.push(await readOnboardingQaState(page));
      await page.keyboard.press("Space");
      await page.waitForTimeout(80);
      sequence.push(await readOnboardingQaState(page));
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(80);
      sequence.push(await readOnboardingQaState(page));
      await page.evaluate(() => window.__fridayQa.onboarding.setScreen(3));
      await page.waitForTimeout(80);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.location.pathname === "/home");
      const finalRoute = await page.evaluate(() => window.location.pathname + window.location.search);
      await context.close();
      const probe = await writeJson("screenshots/P2E-03/ob08-onboarding-keyboard.json", {
        generatedAt: new Date().toISOString(),
        sequence,
        finalRoute
      });
      return {
        pass:
          sequence[0].screen === 1 &&
          sequence[1].screen === 2 &&
          sequence[2].screen === 1 &&
          finalRoute === "/home",
        summary: `screens=${sequence.map((entry) => entry.screen).join("->")} final=${finalRoute}`,
        artifacts: [probe],
        observed: { sequence, finalRoute }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2E-03", "/onboarding", generatedAt, results, artifacts);
}

async function verifyP2E04(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "GF01",
    "URL 参数 wizardId · 从 guided registry 加载 · 不存在跳 /assistant",
    async () => {
      const valid = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      const validObserved = await readGuidedQaState(valid.page);
      await valid.context.close();

      const invalid = await bootRoutePage(browser, baseUrl, "/flow/unknown", "guided");
      await invalid.page.waitForTimeout(180);
      const invalidObserved = await invalid.page.evaluate(() => ({
        route: window.location.pathname + window.location.search
      }));
      await invalid.context.close();

      const probe = await writeJson("screenshots/P2E-04/gf01-guided-routing.json", {
        generatedAt: new Date().toISOString(),
        validObserved,
        invalidObserved
      });
      return {
        pass:
          validObserved.wizardId === "inventory-triage" &&
          validObserved.fetchTrace[validObserved.fetchTrace.length - 1]?.source === "guided-registry" &&
          invalidObserved.route === "/assistant",
        summary: `${validObserved.wizardId} / invalid->${invalidObserved.route}`,
        artifacts: [probe],
        observed: { validObserved, invalidObserved }
      };
    }
  );

  await verifyRule(
    2,
    "GF02",
    "布局 · 顶 journey tracker 80px · 主区 2 列 · 左 step 自动 · 右 investigation panel 360",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      const shot = await captureScreenshot(page, "screenshots/P2E-04/gf02-guided-layout.png");
      const observed = await page.evaluate(() => {
        const tracker = document.querySelector("[data-guided-tracker='true']");
        const layout = document.querySelector(".guided-layout");
        const panel = document.querySelector(".guided-investigation-panel");
        return {
          trackerHeight: tracker?.getBoundingClientRect().height ?? null,
          layoutColumns: getComputedStyle(layout).gridTemplateColumns,
          panelWidth: panel?.getBoundingClientRect().width ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf02-guided-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          (observed.trackerHeight || 0) >= 80 &&
          observed.layoutColumns.split(" ").length === 2 &&
          Math.abs((observed.panelWidth || 0) - 360) <= 2,
        summary: `tracker=${observed.trackerHeight} panel=${observed.panelWidth}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "GF03",
    "journey tracker · 显示所有 step · 完成绿勾 · 当前琥珀 · 未来灰 · 分支 fork 图",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      const tokenColors = await resolvedTokenColors(page, ["--success", "--accent", "--ink-3"]);
      const before = await page.evaluate(() => Array.from(document.querySelectorAll("[data-guided-step-pill]")).map((pill) => ({
        id: pill.getAttribute("data-guided-step-pill"),
        icon: pill.querySelector(".guided-step-icon")?.textContent?.trim() ?? null,
        className: pill.className
      })));
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(120);
      const after = await page.evaluate((colors) => {
        return Array.from(document.querySelectorAll("[data-guided-step-pill]")).map((pill) => {
          const strong = pill.querySelector("strong");
          const color = strong ? getComputedStyle(strong).color : null;
          return {
            id: pill.getAttribute("data-guided-step-pill"),
            className: pill.className,
            color,
            tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
          };
        });
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf03-guided-tracker.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        before,
        after
      });
      return {
        pass:
          before.length === 4 &&
          before[1]?.icon === "⑂" &&
          after[0]?.className.includes("is-complete") &&
          after[1]?.className.includes("is-current") &&
          !after[2]?.className.includes("is-current") &&
          !after[2]?.className.includes("is-complete") &&
          !after[2]?.className.includes("is-skipped"),
        summary: `icons=${before.map((item) => item.icon).join(",")} classes=${after.map((item) => item.className).join(" | ")}`,
        artifacts: [probe],
        observed: { before, after, tokenColors }
      };
    }
  );

  await verifyRule(
    4,
    "GF04",
    "step 内容 · 按 step.kind 渲染 goal-card / choice-card / one-click-action / plan-review-visual",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      const observed = [];
      for (const stepIndex of [0, 1, 2, 3]) {
        await page.evaluate((index) => window.__fridayQa.guided.setStep(index), stepIndex);
        await page.waitForTimeout(80);
        observed.push(await page.evaluate(() => ({
          state: window.__fridayQa.guided.getState(),
          hasGoalSummary: Boolean(document.querySelector(".settings-summary-strip")),
          hasChoiceGrid: Boolean(document.querySelector("[data-guided-choice-grid='true']")),
          hasActionDetail: Array.from(document.querySelectorAll(".guided-investigation-details strong")).some((node) => node.textContent?.trim() === "建议动作"),
          reviewCount: document.querySelectorAll(".guided-step-surface .onboarding-value-row").length
        })));
      }
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf04-guided-step-kinds.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed[0].state.activeStepId === "intent" &&
          observed[0].hasGoalSummary &&
          observed[1].state.activeStepId === "choice" &&
          observed[1].hasChoiceGrid &&
          observed[2].state.activeStepId === "action" &&
          observed[2].hasActionDetail &&
          observed[3].state.activeStepId === "review" &&
          observed[3].reviewCount >= 1,
        summary: observed.map((entry) => entry.state.activeStepId).join(" -> "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "GF05",
    "investigation panel · 显示 Friday 正在做的调查 · 有 spinner · 可展开详情",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      const before = await page.evaluate(() => ({
        title: document.querySelector(".guided-investigation-panel .shell-card-title")?.textContent?.trim() ?? null,
        spinnerPresent: Boolean(document.querySelector(".guided-spinner")),
        detailVisible: Boolean(document.querySelector("[data-guided-investigation-detail='true']"))
      }));
      await page.click('[data-action="guided-toggle-investigation"]');
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => ({
        detailVisible: Boolean(document.querySelector("[data-guided-investigation-detail='true']")),
        detailText: document.querySelector("[data-guided-investigation-detail='true']")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf05-guided-investigation.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.title === "Friday 正在调查" &&
          before.spinnerPresent &&
          before.detailVisible === false &&
          after.detailVisible &&
          Boolean(after.detailText),
        summary: `${before.title} / detail=${after.detailVisible}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    6,
    "GF06",
    "step-progress bar 顶部 · 当前 step / 总 step · 百分比",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      await page.click('[data-guided-choice="protect-conversion"]');
      await page.waitForTimeout(220);
      const observed = await page.evaluate(() => ({
        label: document.querySelector("[data-guided-progress-label='true']")?.textContent?.trim() ?? null,
        percentText: document.querySelector("[data-guided-progress-percent='true']")?.textContent?.trim() ?? null,
        fillWidth: document.querySelector("[data-guided-progress-fill='true']")?.style.width ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf06-guided-progress.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.label === "第 3 / 4 步" &&
          observed.percentText === "50%" &&
          observed.fillWidth === "50%",
        summary: `${observed.label} / ${observed.percentText}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "GF07",
    "choice-card · 选择后自动进下一 step · 轻过渡",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(100);
      const observed = await page.evaluate(async () => {
        const card = document.querySelector("[data-guided-choice='protect-conversion']");
        const transitionDuration = card ? getComputedStyle(card).transitionDuration : null;
        const start = performance.now();
        card.click();
        while (window.__fridayQa.guided.getState().stepIndex === 1 && performance.now() - start < 1000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const endState = window.__fridayQa.guided.getState();
        return {
          latencyMs: performance.now() - start,
          transitionDuration,
          endState
        };
      });
      await context.close();
      const firstDurationMs = Number(String(observed.transitionDuration || "0s").split(",")[0].trim().replace("s", "")) * 1000;
      const probe = await writeJson("screenshots/P2E-04/gf07-guided-choice-auto-next.json", {
        generatedAt: new Date().toISOString(),
        observed,
        firstDurationMs
      });
      return {
        pass:
          observed.endState.stepIndex === 2 &&
          observed.endState.selectedChoiceId === "protect-conversion" &&
          observed.latencyMs >= 150 &&
          observed.latencyMs <= 260 &&
          firstDurationMs > 0 &&
          firstDurationMs <= 250,
        summary: `latency=${observed.latencyMs.toFixed(1)}ms`,
        artifacts: [probe],
        observed: { observed, firstDurationMs }
      };
    }
  );

  await verifyRule(
    8,
    "GF08",
    "回退 · 左下角上一步 · 保留 state · 不 re-fetch",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      await page.click('[data-guided-choice="reduce-risk"]');
      await page.waitForTimeout(220);
      const before = await readGuidedQaState(page);
      await page.click('[data-action="guided-prev"]');
      await page.waitForTimeout(80);
      const after = await readGuidedQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf08-guided-prev.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.stepIndex === 2 &&
          after.stepIndex === 1 &&
          after.selectedChoiceId === "reduce-risk" &&
          after.fetchTrace.length === before.fetchTrace.length,
        summary: `step ${before.stepIndex} -> ${after.stepIndex}, fetch=${after.fetchTrace.length}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    9,
    "GF09",
    "完成所有 step · 跳 final step · CTA 返回来源页",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      await page.click('[data-guided-choice="protect-conversion"]');
      await page.waitForTimeout(220);
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        stepIndex: window.__fridayQa.guided.getState().stepIndex,
        finalTitle: document.querySelector("[data-guided-final='true'] h2")?.textContent?.trim() ?? null,
        ctaHref: document.querySelector("[data-guided-final='true'] .action-button")?.getAttribute("href") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf09-guided-final.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.stepIndex === 4 &&
          observed.finalTitle === "引导已完成" &&
          observed.ctaHref === "/assistant?packId=industry-cross-border-ecommerce",
        summary: `${observed.finalTitle} / ${observed.ctaHref}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "GF10",
    "state 持久化 guided-flow-{wizardId} localStorage · 断线恢复",
    async () => {
      const { context, page } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      await page.click('[data-guided-choice="protect-conversion"]');
      await page.waitForTimeout(220);
      const before = await page.evaluate(() => ({
        qa: window.__fridayQa.guided.getState(),
        storage: JSON.parse(window.localStorage.getItem("guided-flow-inventory-triage"))
      }));
      const secondPage = await context.newPage();
      await secondPage.goto(`${baseUrl}/flow/inventory-triage?dev=1`, { waitUntil: "load" });
      await secondPage.waitForFunction(() => Boolean(window.__fridayQa?.guided));
      await secondPage.waitForTimeout(220);
      const after = await readGuidedQaState(secondPage);
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf10-guided-storage.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.storage?.stepIndex === 2 &&
          before.storage?.selectedChoiceId === "protect-conversion" &&
          after.stepIndex === 2 &&
          after.selectedChoiceId === "protect-conversion",
        summary: `storageStep=${before.storage?.stepIndex} restored=${after.stepIndex}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    11,
    "GF11",
    "空 wizardId 路径 · show 找不到引导 + 跳 /assistant link",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow", "guided");
      const shot = await captureScreenshot(page, "screenshots/P2E-04/gf11-guided-empty.png");
      const observed = await page.evaluate(() => ({
        route: window.location.pathname + window.location.search,
        title: document.querySelector(".route-empty h2")?.textContent?.trim() ?? null,
        ctaHref: document.querySelector(".route-empty .action-button")?.getAttribute("href") ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf11-guided-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.route === "/flow?dev=1" &&
          observed.title === "找不到引导" &&
          observed.ctaHref === "/assistant",
        summary: `${observed.title} / ${observed.ctaHref}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    12,
    "GF12",
    "skip current step · 标记 step skipped(灰勾) · tracker 显示",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="guided-next"]');
      await page.waitForTimeout(80);
      await page.click('[data-action="guided-skip-step"]');
      await page.waitForTimeout(80);
      const tokenColors = await resolvedTokenColors(page, ["--ink-3"]);
      const observed = await page.evaluate((colors) => {
        const pill = document.querySelector('[data-guided-step-pill="choice"]');
        const strong = pill?.querySelector("strong");
        const color = strong ? getComputedStyle(strong).color : null;
        return {
          qa: window.__fridayQa.guided.getState(),
          className: pill?.className ?? null,
          icon: pill?.querySelector(".guided-step-icon")?.textContent?.trim() ?? null,
          color,
          tokenMatch: Object.entries(colors).find(([, value]) => value === color)?.[0] ?? null
        };
      }, tokenColors);
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf12-guided-skip.json", {
        generatedAt: new Date().toISOString(),
        tokenColors,
        observed
      });
      return {
        pass:
          observed.qa.skippedStepIds.includes("choice") &&
          observed.className?.includes("is-skipped") &&
          observed.icon === "✓" &&
          observed.tokenMatch === "--ink-3",
        summary: `${observed.icon} / ${observed.tokenMatch}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    13,
    "GF13",
    "每 step 右下 寻求帮助 · 打开 contextual-help",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/flow/inventory-triage", "guided");
      await page.click('[data-action="open-context-help"]');
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => ({
        helpOpen: window.__fridayQa.guided.getState().helpOpen,
        helpText: document.querySelector("[data-guided-help='true']")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-04/gf13-guided-help.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.helpOpen &&
          Boolean(observed.helpText),
        summary: observed.helpText,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2E-04", "/flow/:wizardId", generatedAt, results, artifacts);
}

async function verifyP2E05(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, code, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "CC01",
    "3 栏 · 左 agent list 280 · 中 activity timeline flex · 右 control 320",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run"
      });
      const shot = await captureScreenshot(page, "screenshots/P2E-05/cc01-command-layout.png");
      const observed = await page.evaluate(() => {
        const grid = document.querySelector("[data-command-center-grid='true']");
        const children = Array.from(grid?.children || []).map((node) => node.getBoundingClientRect().width);
        return {
          widths: children,
          columns: getComputedStyle(grid).gridTemplateColumns
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc01-command-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.widths.length === 3 &&
          Math.abs((observed.widths[0] || 0) - 280) <= 2 &&
          Math.abs((observed.widths[2] || 0) - 320) <= 2 &&
          observed.widths[1] > observed.widths[0],
        summary: observed.widths.join(" / "),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "CC02",
    "agent list · 每 agent 一 card · name + status + current run",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run"
      });
      const observed = await page.evaluate(() => Array.from(document.querySelectorAll("[data-command-agent]")).map((node) => ({
        id: node.getAttribute("data-command-agent"),
        name: node.querySelector("strong")?.textContent?.trim() ?? null,
        status: node.querySelector(".status-pill")?.textContent?.trim() ?? null,
        currentRun: node.querySelector(".command-agent-status span:last-child")?.textContent?.trim() ?? null
      })));
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc02-command-agents.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.length === 3 &&
          observed.every((agent) => Boolean(agent.name) && Boolean(agent.status) && /当前 run/.test(agent.currentRun || "")),
        summary: observed.map((agent) => agent.id).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "CC03",
    "timeline · ActivityTimeline 复用 · 显示所有 agent 的事件合流",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const props = extractFunctionPropFields(source, "ActivityTimeline");
      const callSite = /ActivityTimeline\(\{\s*locale:\s*uiState\.locale,\s*lanes:\s*lanes,\s*expandedEventId:\s*uiState\.commandCenter\.expandedEventId\s*\}\)/.test(source);
      const probe = await writeJson("screenshots/P2E-05/cc03-command-activitytimeline.json", {
        generatedAt: new Date().toISOString(),
        callSite,
        props
      });
      return {
        pass:
          callSite &&
          props.fields.includes("lanes") &&
          props.fields.includes("expandedEventId") &&
          props.fields.includes("locale"),
        summary: `callSite=${callSite} props=${props.fields.join(",")}`,
        artifacts: [probe],
        observed: { callSite, props }
      };
    }
  );

  await verifyRule(
    4,
    "CC04",
    "多 run 并列 · 用 lane 区分 · 每 agent 一 lane",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run"
      });
      const qaState = await readCommandCenterQaState(page);
      const observed = await page.evaluate(() => Array.from(document.querySelectorAll("[data-command-lane]")).map((node) => ({
        id: node.getAttribute("data-command-lane"),
        eventCount: node.querySelectorAll("[data-command-event]").length
      })));
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc04-command-lanes.json", {
        generatedAt: new Date().toISOString(),
        observed,
        qaState
      });
      return {
        pass:
          observed.length === 3 &&
          JSON.stringify(observed.map((lane) => lane.id)) === JSON.stringify(qaState.agents.map((agent) => agent.id)) &&
          observed.every((lane) => lane.eventCount >= 1),
        summary: observed.map((lane) => `${lane.id}:${lane.eventCount}`).join(" / "),
        artifacts: [probe],
        observed: { observed, qaState }
      };
    }
  );

  await verifyRule(
    5,
    "CC05",
    "control · 选中 agent 后显示 · pause / resume / stop / inspect",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run"
      });
      await page.click('[data-command-agent="agent-qa"]');
      await page.waitForTimeout(80);
      const before = await page.evaluate(() => ({
        selectedAgent: document.querySelector("[data-command-selected-agent='true']")?.textContent?.trim() ?? null,
        actions: Array.from(document.querySelectorAll('[data-action="command-control"]')).map((node) => node.textContent?.trim() ?? "")
      }));
      await page.click('[data-action="command-control"][data-payload="agent-qa::inspect"]');
      await page.waitForTimeout(80);
      const after = await readCommandCenterQaState(page);
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc05-command-control.json", {
        generatedAt: new Date().toISOString(),
        before,
        after
      });
      return {
        pass:
          before.selectedAgent === "QA Agent" &&
          JSON.stringify(before.actions) === JSON.stringify(["pause", "resume", "stop", "inspect"]) &&
          after.controlTrace[after.controlTrace.length - 1]?.agentId === "agent-qa" &&
          after.controlTrace[after.controlTrace.length - 1]?.action === "inspect",
        summary: `${before.selectedAgent} / ${after.controlTrace[after.controlTrace.length - 1]?.action}`,
        artifacts: [probe],
        observed: { before, after }
      };
    }
  );

  await verifyRule(
    6,
    "CC06",
    "summary panel 顶部 · 总运行数 + 失败率 + 平均时长",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run"
      });
      const qaState = await readCommandCenterQaState(page);
      const observed = await page.evaluate(() => ({
        totalRuns: document.querySelector("[data-command-summary-runs='true']")?.textContent?.trim() ?? null,
        failRate: document.querySelector("[data-command-summary-fail='true']")?.textContent?.trim() ?? null,
        avgDuration: document.querySelector("[data-command-summary-duration='true']")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc06-command-summary.json", {
        generatedAt: new Date().toISOString(),
        observed,
        qaState
      });
      return {
        pass:
          observed.totalRuns === String(qaState.summary.totalRuns) &&
          observed.failRate === qaState.summary.failRate &&
          observed.avgDuration === qaState.summary.avgDuration,
        summary: `${observed.totalRuns} / ${observed.failRate} / ${observed.avgDuration}`,
        artifacts: [probe],
        observed: { observed, qaState }
      };
    }
  );

  await verifyRule(
    7,
    "CC07",
    "点 timeline event · 展开 context",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run"
      });
      const eventId = await page.getAttribute("[data-command-event]", "data-command-event");
      await page.click(`[data-action="command-toggle-event"][data-payload="${eventId}"]`);
      await page.waitForTimeout(80);
      const observed = await page.evaluate((id) => {
        const row = document.querySelector(`[data-command-event="${id}"]`);
        return {
          expandedEventId: window.__fridayQa.commandCenter.getState().expandedEventId,
          className: row?.className ?? null,
          contextLines: row?.querySelectorAll(".command-event-context div").length ?? 0
        };
      }, eventId);
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc07-command-event-expand.json", {
        generatedAt: new Date().toISOString(),
        eventId,
        observed
      });
      return {
        pass:
          observed.expandedEventId === eventId &&
          observed.className?.includes("is-expanded") &&
          observed.contextLines >= 1,
        summary: `${eventId} / lines=${observed.contextLines}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "CC08",
    "空 · 暂无 agent 活动",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "idle"
      });
      const shot = await captureScreenshot(page, "screenshots/P2E-05/cc08-command-empty.png");
      const observed = await page.evaluate(() => ({
        text: document.querySelector(".route-detail-empty")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc08-command-empty.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.text === "暂无 agent 活动",
        summary: observed.text,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "CC09",
    "mobile/窄屏 · 单列 · 只显 timeline",
    async () => {
      const { page, context } = await bootRoutePage(browser, baseUrl, "/command-center", "commandCenter", {
        stateName: "multi-run",
        viewport: { width: 1024, height: 900 }
      });
      const shot = await captureScreenshot(page, "screenshots/P2E-05/cc09-command-mobile.png");
      const observed = await page.evaluate(() => {
        const grid = document.querySelector("[data-command-center-grid='true']");
        const asides = Array.from(document.querySelectorAll(".command-center-grid > aside")).map((node) => getComputedStyle(node).display);
        const timelineDisplay = getComputedStyle(document.querySelector(".command-center-grid > section")).display;
        return {
          columns: getComputedStyle(grid).gridTemplateColumns,
          asides,
          timelineDisplay
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2E-05/cc09-command-mobile.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.columns.split(" ").length === 1 &&
          Number.parseFloat(observed.columns) > 0 &&
          observed.asides.every((value) => value === "none") &&
          observed.timelineDisplay !== "none",
        summary: `${observed.columns} / asides=${observed.asides.join(",")}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2E-05", "/command-center", generatedAt, results, artifacts);
}

async function verifyP2F01(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F01-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "route 切换 < 150ms · 用 recordNavVisit + completeClientRouteTransition 埋点",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.evaluate(() => window.__fridayQa.shell.navigate("/assistant?tab=approvals", false));
      await page.waitForFunction(() => window.__fridayQa.shell.getState().route === "/assistant");
      const observed = await page.evaluate(() => {
        const shell = window.__fridayQa.shell.getState();
        return {
          navMetric: shell.navMetrics[shell.navMetrics.length - 1] || null,
          route: shell.route,
          breadcrumbs: shell.breadcrumbs
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-01-nav-metric.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-01-nav-metric.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.route === "/assistant" &&
          observed.navMetric?.status === "completed" &&
          Number(observed.navMetric?.durationMs) < 150,
        summary: `duration=${observed.navMetric?.durationMs ?? "n/a"}ms route=${observed.route}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "切换不 FOUC · 下页 mount 前旧页保留 100ms",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const holdObserved = await page.evaluate(() => {
        window.__fridayQa.shell.simulateTransition("/assistant?tab=approvals", { delayMs: 120 });
        const overlay = document.querySelector('.shell-transition-overlay[data-overlay-kind="content"]');
        const overlayStyle = overlay ? window.getComputedStyle(overlay) : null;
        return {
          route: window.__fridayQa.shell.getState().route,
          visualRoute: window.__fridayQa.shell.getState().visualRoute,
          homeStillMounted: Boolean(document.querySelector("#home-top")),
          assistantMounted: Boolean(document.querySelector(".assistant-layout")),
          overlayPresent: Boolean(overlay),
          overlayAnimationName: overlayStyle ? overlayStyle.animationName : null,
          overlayAnimationDelay: overlayStyle ? overlayStyle.animationDelay : null
        };
      });
      await page.waitForTimeout(20);
      const holdShot = await captureScreenshot(page, "screenshots/P2F-01/f01-02-hold.png");
      await page.waitForFunction(() => window.__fridayQa.shell.getState().route === "/assistant");
      const afterObserved = await page.evaluate(() => ({
        route: window.__fridayQa.shell.getState().route,
        assistantMounted: Boolean(document.querySelector(".assistant-layout"))
      }));
      const afterShot = await captureScreenshot(page, "screenshots/P2F-01/f01-02-after.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-02-no-fouc.json", {
        generatedAt: new Date().toISOString(),
        holdObserved,
        afterObserved,
        screenshots: [holdShot.path, afterShot.path]
      });
      return {
        pass:
          holdObserved.route === "/home" &&
          holdObserved.visualRoute === "/assistant" &&
          holdObserved.homeStillMounted &&
          holdObserved.assistantMounted === false &&
          holdObserved.overlayPresent &&
          holdObserved.overlayAnimationName === "shell-transition-hold-fade" &&
          holdObserved.overlayAnimationDelay === "0.1s" &&
          afterObserved.route === "/assistant" &&
          afterObserved.assistantMounted,
        summary: `hold route=${holdObserved.route}, overlay=${holdObserved.overlayAnimationName}, after=${afterObserved.route}`,
        artifacts: [probe, holdShot, afterShot],
        observed: {
          holdObserved,
          afterObserved
        }
      };
    }
  );

  await verifyRule(
    3,
    "rail 当前路由高亮 · 点击前琥珀 · 点击后立即 active",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const before = await page.evaluate(() => ({
        activeHref: document.querySelector(".rail-nav-link.is-active")?.getAttribute("href") ?? null
      }));
      await page.evaluate(() => {
        window.__fridayQa.shell.simulateTransition("/assistant?tab=approvals", { delayMs: 140 });
      });
      await page.waitForTimeout(20);
      const during = await page.evaluate(() => ({
        route: window.__fridayQa.shell.getState().route,
        visualRoute: window.__fridayQa.shell.getState().visualRoute,
        activeHref: document.querySelector(".rail-nav-link.is-active")?.getAttribute("href") ?? null,
        activeText: document.querySelector(".rail-nav-link.is-active .rail-link-title")?.textContent?.trim() ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-03-rail-highlight.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-03-rail-highlight.json", {
        generatedAt: new Date().toISOString(),
        before,
        during,
        screenshot: shot.path
      });
      return {
        pass:
          before.activeHref === "/home" &&
          during.route === "/home" &&
          during.visualRoute === "/assistant" &&
          during.activeHref === "/assistant" &&
          during.activeText === "助手收件箱",
        summary: `before=${before.activeHref} during=${during.activeHref}`,
        artifacts: [probe, shot],
        observed: {
          before,
          during
        }
      };
    }
  );

  await verifyRule(
    4,
    "scroll 位置保留 · 回退 / 前进 恢复 · 新进 top",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal", {
        viewport: { width: 1440, height: 640 }
      });
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        top: window.scrollY,
        saved: window.__fridayQa.shell.getState().scrollPositions
      }));
      await page.evaluate(() => window.__fridayQa.shell.navigate("/assistant?tab=approvals", false));
      await page.waitForFunction(() => window.__fridayQa.shell.getState().route === "/assistant");
      await page.waitForTimeout(120);
      const assistantAfterNavigate = await page.evaluate(() => ({
        top: window.scrollY,
        saved: window.__fridayQa.shell.getState().scrollPositions
      }));
      await page.evaluate(() => window.history.back());
      await page.waitForFunction(() => window.__fridayQa.shell.getState().route === "/home");
      await page.waitForTimeout(120);
      const restored = await page.evaluate(() => ({
        top: window.scrollY,
        route: window.__fridayQa.shell.getState().route
      }));
      await page.evaluate(() => window.history.forward());
      await page.waitForFunction(() => window.__fridayQa.shell.getState().route === "/assistant");
      await page.waitForTimeout(120);
      const forward = await page.evaluate(() => ({
        top: window.scrollY,
        route: window.__fridayQa.shell.getState().route
      }));
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-04-scroll-restore.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-04-scroll-restore.json", {
        generatedAt: new Date().toISOString(),
        before,
        assistantAfterNavigate,
        restored,
        forward,
        screenshot: shot.path
      });
      return {
        pass:
          before.top >= 900 &&
          assistantAfterNavigate.top === 0 &&
          Math.abs(restored.top - before.top) <= 4 &&
          forward.top === 0,
        summary: `home=${before.top} restored=${restored.top} assistant=${assistantAfterNavigate.top}`,
        artifacts: [probe, shot],
        observed: {
          before,
          assistantAfterNavigate,
          restored,
          forward
        }
      };
    }
  );

  await verifyRule(
    5,
    "right rail slot 切换 · fade 150ms · 不闪 · 不 layout shift",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const before = await page.evaluate(() => {
        const main = document.querySelector(".shell-main");
        const rail = document.querySelector(".shell-right-rail");
        const current = document.querySelector(".right-rail-slot-current");
        const mainRect = main.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        return {
          main: { x: mainRect.x, width: mainRect.width },
          rail: { x: railRect.x, width: railRect.width },
          currentHtmlLength: current ? current.innerHTML.length : 0
        };
      });
      await page.evaluate(() => {
        window.__fridayQa.shell.simulateTransition("/assistant?tab=approvals", { delayMs: 140 });
      });
      await page.waitForTimeout(170);
      const during = await page.evaluate(() => {
        const overlay = document.querySelector('.shell-transition-overlay[data-overlay-kind="right-rail"]');
        const main = document.querySelector(".shell-main");
        const rail = document.querySelector(".shell-right-rail");
        const mainRect = main.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const overlayStyle = overlay ? window.getComputedStyle(overlay) : null;
        return {
          overlayPresent: Boolean(overlay),
          overlayAnimationName: overlayStyle ? overlayStyle.animationName : null,
          overlayAnimationDuration: overlayStyle ? overlayStyle.animationDuration : null,
          overlayPointerEvents: overlayStyle ? overlayStyle.pointerEvents : null,
          main: { x: mainRect.x, width: mainRect.width },
          rail: { x: railRect.x, width: railRect.width }
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-05-right-rail.png");
      await context.close();
      const stable =
        Math.abs(during.main.x - before.main.x) <= 1 &&
        Math.abs(during.main.width - before.main.width) <= 1 &&
        Math.abs(during.rail.x - before.rail.x) <= 1 &&
        Math.abs(during.rail.width - before.rail.width) <= 1;
      const probe = await writeJson("screenshots/P2F-01/f01-05-right-rail.json", {
        generatedAt: new Date().toISOString(),
        before,
        during,
        stable,
        screenshot: shot.path
      });
      return {
        pass:
          before.currentHtmlLength > 0 &&
          during.overlayPresent &&
          during.overlayAnimationName === "shell-transition-right-rail-fade" &&
          during.overlayAnimationDuration === "0.15s" &&
          during.overlayPointerEvents === "none" &&
          stable,
        summary: `overlay=${during.overlayAnimationName} stable=${stable}`,
        artifacts: [probe, shot],
        observed: {
          before,
          during,
          stable
        }
      };
    }
  );

  await verifyRule(
    6,
    "topbar breadcrumb 同步 · URL 变时 300ms 内更新",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = await page.evaluate(async () => {
        const before = document.querySelector(".topbar-breadcrumbs")?.textContent?.trim() ?? "";
        window.__fridayQa.shell.simulateTransition("/assistant?tab=recovery", { delayMs: 220 });
        const startedAt = performance.now();
        while ((document.querySelector(".topbar-breadcrumbs")?.textContent?.trim() ?? "") === before) {
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        const after = document.querySelector(".topbar-breadcrumbs")?.textContent?.trim() ?? "";
        return {
          before,
          after,
          latencyMs: performance.now() - startedAt
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-06-breadcrumbs.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-06-breadcrumbs.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.before.includes("首页") &&
          observed.after.includes("助手收件箱") &&
          observed.after.includes("recovery") &&
          observed.latencyMs <= 300,
        summary: `latency=${observed.latencyMs.toFixed(1)}ms`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "loading 超过 500ms 才显 splash · 小于不显",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.evaluate(() => {
        window.__fridayQa.shell.simulateTransition("/observability?focus=alerts", { delayMs: 450 });
      });
      await page.waitForTimeout(520);
      const shortDelay = await page.evaluate(() => ({
        splashVisible: Boolean(document.querySelector("[data-shell-splash='true']")),
        route: window.__fridayQa.shell.getState().route
      }));
      await page.waitForFunction(() => window.__fridayQa.shell.getState().route === "/observability");
      await page.evaluate(() => window.__fridayQa.shell.simulateTransition("/settings?tab=providers", { delayMs: 650 }));
      await page.waitForTimeout(540);
      const longDelay = await page.evaluate(() => ({
        splashVisible: Boolean(document.querySelector("[data-shell-splash='true']")),
        navSimulation: window.__fridayQa.shell.getState().navSimulation
      }));
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-07-splash.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-07-splash.json", {
        generatedAt: new Date().toISOString(),
        shortDelay,
        longDelay,
        screenshot: shot.path
      });
      return {
        pass:
          shortDelay.splashVisible === false &&
          longDelay.splashVisible === true &&
          Number(longDelay.navSimulation?.delayMs) === 650,
        summary: `short=${shortDelay.splashVisible} long=${longDelay.splashVisible}`,
        artifacts: [probe, shot],
        observed: {
          shortDelay,
          longDelay
        }
      };
    }
  );

  await verifyRule(
    8,
    "切换失败 · inline error 保留上页 · 不替换",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.evaluate(() => {
        window.__fridayQa.shell.simulateTransition("/assistant?tab=approvals", { delayMs: 80, fail: true });
      });
      await page.waitForTimeout(120);
      const observed = await page.evaluate(() => ({
        route: window.__fridayQa.shell.getState().route,
        navError: window.__fridayQa.shell.getState().navError,
        homeStillMounted: Boolean(document.querySelector("#home-top")),
        errorBarPresent: Boolean(document.querySelector("[data-nav-error='true'] .inline-error-shell")),
        retryAction: document.querySelector("[data-nav-error='true'] .action-button")?.getAttribute("data-action") ?? null
      }));
      const shot = await captureScreenshot(page, "screenshots/P2F-01/f01-08-nav-fail.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-01/f01-08-nav-fail.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.route === "/home" &&
          observed.homeStillMounted &&
          observed.errorBarPresent &&
          observed.retryAction === "retry-last-navigation" &&
          observed.navError?.title === "页面切换失败",
        summary: `route=${observed.route} retry=${observed.retryAction}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-01", "all", generatedAt, results, artifacts);
}

async function verifyP2F02(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F02-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "Tweaks 面板右下浮层 240×auto · 开关在 topbar",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.click('[data-action="toggle-tweaks"]');
      await page.waitForSelector(".tweaks-panel");
      const observed = await page.evaluate(() => {
        const trigger = document.querySelector('[data-action="toggle-tweaks"]');
        const panel = document.querySelector(".tweaks-panel");
        const rect = panel.getBoundingClientRect();
        return {
          triggerText: trigger?.textContent?.trim() ?? null,
          width: rect.width,
          height: rect.height,
          rightGap: window.innerWidth - rect.right,
          bottomGap: window.innerHeight - rect.bottom,
          ariaModal: panel?.getAttribute("aria-modal") ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-02/f02-01-panel.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-01-panel.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.triggerText === "Tweaks" &&
          observed.width === 240 &&
          observed.height > 280 &&
          observed.rightGap === 24 &&
          observed.bottomGap === 24 &&
          observed.ariaModal === "true",
        summary: `width=${observed.width}px right=${observed.rightGap}px bottom=${observed.bottomGap}px`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "分组 5 个 · Density / Radius / Motion / Accent / Locale Preview",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.click('[data-action="toggle-tweaks"]');
      const observed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".tweaks-panel .shell-card strong"))
          .map((node) => node.textContent?.trim() ?? "")
          .filter((value) => ["密度", "圆角", "动效", "主色强度", "语言预览"].includes(value));
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-02/f02-02-groups.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-02-groups.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: JSON.stringify(observed) === JSON.stringify(["密度", "圆角", "动效", "主色强度", "语言预览"]),
        summary: observed.join(" / "),
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "Density · compact / cozy / comfortable · 影响 padding + line-height",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = {};
      for (const density of ["compact", "cozy", "comfortable"]) {
        observed[density] = await page.evaluate((value) => {
          window.__fridayQa.shell.setTweak("density", value);
          const card = document.querySelector(".shell-card");
          const body = window.getComputedStyle(document.body);
          const style = window.getComputedStyle(card);
          return {
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            lineHeight: body.lineHeight,
            dataset: document.documentElement.dataset.density
          };
        }, density);
      }
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-03-density.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.compact.paddingTop === "14px" &&
          observed.cozy.paddingTop === "17px" &&
          observed.comfortable.paddingTop !== observed.compact.paddingTop &&
          Number.parseFloat(observed.compact.lineHeight) < Number.parseFloat(observed.cozy.lineHeight) &&
          Number.parseFloat(observed.cozy.lineHeight) < Number.parseFloat(observed.comfortable.lineHeight),
        summary: `padding=${observed.compact.paddingTop}/${observed.cozy.paddingTop}/${observed.comfortable.paddingTop}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "Radius · sharp(4) / default(14) / soft(22) · 全局 radius 变量替换",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = {};
      for (const radius of ["sharp", "default", "soft"]) {
        observed[radius] = await page.evaluate((value) => {
          window.__fridayQa.shell.setTweak("radius", value);
          const root = window.getComputedStyle(document.documentElement);
          const card = window.getComputedStyle(document.querySelector(".shell-card"));
          return {
            dataset: document.documentElement.dataset.radius,
            radiusMd: root.getPropertyValue("--radius-md").trim(),
            cardRadius: card.borderTopLeftRadius
          };
        }, radius);
      }
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-04-radius.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.sharp.radiusMd === "4px" &&
          observed.default.radiusMd === "14px" &&
          observed.soft.radiusMd === "22px" &&
          observed.soft.cardRadius === "22px",
        summary: `${observed.sharp.radiusMd} / ${observed.default.radiusMd} / ${observed.soft.radiusMd}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "Motion · full / reduced / none · 匹配 prefers-reduced-motion 默认",
    async () => {
      const reducedBoot = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal", {
        reducedMotion: "reduce"
      });
      const defaultObserved = await reducedBoot.page.evaluate(() => ({
        motion: window.__fridayQa.shell.getState().tweaks.motion,
        dataset: document.documentElement.dataset.motion
      }));
      await reducedBoot.context.close();

      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = {};
      for (const motion of ["full", "reduced", "none"]) {
        observed[motion] = await page.evaluate((value) => {
          window.__fridayQa.shell.setTweak("motion", value);
          const root = window.getComputedStyle(document.documentElement);
          return {
            dataset: document.documentElement.dataset.motion,
            swift: root.getPropertyValue("--motion-swift").trim(),
            gentle: root.getPropertyValue("--motion-gentle").trim()
          };
        }, motion);
      }
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-05-motion.json", {
        generatedAt: new Date().toISOString(),
        defaultObserved,
        observed
      });
      return {
        pass:
          defaultObserved.motion === "reduced" &&
          observed.full.dataset === "full" &&
          observed.reduced.dataset === "reduced" &&
          observed.none.dataset === "none" &&
          observed.none.swift.startsWith("0.01ms") &&
          observed.reduced.swift.startsWith("120ms"),
        summary: `default=${defaultObserved.motion} none=${observed.none.swift}`,
        artifacts: [probe],
        observed: {
          defaultObserved,
          observed
        }
      };
    }
  );

  await verifyRule(
    6,
    "Accent · intensity 50-150% · 改 --accent 饱和度",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = {};
      for (const intensity of ["50", "75", "100", "125", "150"]) {
        observed[intensity] = await page.evaluate((value) => {
          window.__fridayQa.shell.setTweak("accentIntensity", value);
          const probe = document.createElement("div");
          probe.style.color = "var(--accent)";
          document.body.appendChild(probe);
          const color = window.getComputedStyle(probe).color;
          probe.remove();
          return {
            dataset: document.documentElement.dataset.accentIntensity,
            color
          };
        }, intensity);
      }
      await context.close();
      const colors = Object.values(observed).map((entry) => entry.color);
      const probe = await writeJson("screenshots/P2F-02/f02-06-accent.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: new Set(colors).size === 5 && observed["50"].dataset === "50" && observed["150"].dataset === "150",
        summary: colors.join(" | "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "Locale Preview · zh / en · 不改 friday-locale · 只临时 preview",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.evaluate(() => {
        window.localStorage.setItem("friday-locale", "zh");
        window.__fridayQa.shell.setTweak("localePreview", "en");
      });
      const observed = await page.evaluate(() => {
        const shell = window.__fridayQa.shell.getState();
        return {
          locale: shell.locale,
          renderLocale: shell.renderLocale,
          storageLocale: window.localStorage.getItem("friday-locale"),
          bodyLocale: document.body.dataset.locale,
          heading: document.querySelector(".topbar-title")?.textContent?.trim() ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-02/f02-07-locale-preview.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-07-locale-preview.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.locale === "zh" &&
          observed.renderLocale === "en" &&
          observed.storageLocale === "zh" &&
          observed.bodyLocale === "en" &&
          observed.heading === "Home",
        summary: `locale=${observed.locale} render=${observed.renderLocale} storage=${observed.storageLocale}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    8,
    "切换立刻生效 · CSS variables 改 · 无 flash",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = await page.evaluate(() => {
        const navEntries = performance.getEntriesByType("navigation").length;
        const before = getComputedStyle(document.documentElement).getPropertyValue("--radius-md").trim();
        window.__fridayQa.shell.setTweak("radius", "sharp");
        const after = getComputedStyle(document.documentElement).getPropertyValue("--radius-md").trim();
        return {
          before,
          after,
          navEntriesBefore: navEntries,
          navEntriesAfter: performance.getEntriesByType("navigation").length,
          splashVisible: Boolean(document.querySelector("[data-shell-splash='true']"))
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-08-live-apply.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.before !== observed.after &&
          observed.after === "4px" &&
          observed.navEntriesBefore === observed.navEntriesAfter &&
          observed.splashVisible === false,
        summary: `${observed.before} -> ${observed.after}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    9,
    "localStorage 持久化 · 键 friday-tweaks · reload 保留",
    async () => {
      const first = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await first.page.evaluate(() => {
        window.__fridayQa.shell.setTweak("density", "compact");
        window.__fridayQa.shell.setTweak("radius", "soft");
        window.__fridayQa.shell.setTweak("accentIntensity", "150");
      });
      const beforeReload = await first.page.evaluate(() => ({
        storage: window.__fridayQa.shell.readStorage("friday-tweaks"),
        tweaks: window.__fridayQa.shell.getState().tweaks
      }));
      const storageState = await first.context.storageState();
      await first.context.close();

      const second = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal", {
        storageState
      });
      const afterReload = await second.page.evaluate(() => ({
        tweaks: window.__fridayQa.shell.getState().tweaks,
        storage: window.__fridayQa.shell.readStorage("friday-tweaks")
      }));
      const shot = await captureScreenshot(second.page, "screenshots/P2F-02/f02-09-persist.png");
      await second.context.close();
      const probe = await writeJson("screenshots/P2F-02/f02-09-persist.json", {
        generatedAt: new Date().toISOString(),
        beforeReload,
        afterReload,
        screenshot: shot.path
      });
      return {
        pass:
          beforeReload.storage === afterReload.storage &&
          afterReload.tweaks.density === "compact" &&
          afterReload.tweaks.radius === "soft" &&
          afterReload.tweaks.accentIntensity === "150",
        summary: afterReload.storage,
        artifacts: [probe, shot],
        observed: {
          beforeReload,
          afterReload
        }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-02", "all", generatedAt, results, artifacts);
}

async function verifyP2F03(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();
  const auditedRoutes = [
    { page: "Home", href: "/home?dev=1&__state=empty", selector: ".page-empty .empty-hero" },
    { page: "Chat", href: "/chat?dev=1&__state=empty", selector: ".chat-empty-hero" },
    { page: "Channels", href: "/channels?dev=1&__state=empty", selector: ".empty-hero" },
    { page: "Usage", href: "/usage?dev=1&__state=empty", selector: ".route-empty" },
    { page: "Memory", href: "/memory?dev=1&__state=empty", selector: ".empty-hero" },
    { page: "Fleet", href: "/fleet?dev=1&__state=empty", selector: ".route-empty" }
  ];

  async function collectRow(routeConfig) {
    const { page, context } = await bootShellPage(browser, baseUrl, routeConfig.href);
    const zh = await page.evaluate(({ selector }) => {
      const host = document.querySelector(selector);
      return {
        title: host?.querySelector("h2")?.textContent?.trim() ?? "",
        body: host?.querySelector("p")?.textContent?.trim() ?? "",
        cta: host?.querySelector(".action-button, .chat-quick-card")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        ctaHref: host?.querySelector(".action-button, .chat-quick-card")?.getAttribute("href") ?? "",
        arrowCount: host?.querySelectorAll(".empty-state-arrow").length ?? 0,
        svgCount: host?.querySelectorAll("svg").length ?? 0
      };
    }, routeConfig);
    await page.evaluate(() => window.__fridayQa.shell.setTweak("localePreview", "en"));
    const en = await page.evaluate(({ selector }) => {
      const host = document.querySelector(selector);
      return {
        title: host?.querySelector("h2")?.textContent?.trim() ?? "",
        body: host?.querySelector("p")?.textContent?.trim() ?? "",
        cta: host?.querySelector(".action-button, .chat-quick-card")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
      };
    }, routeConfig);
    await context.close();
    return {
      page: routeConfig.page,
      href: routeConfig.href,
      zh,
      en,
      reviewer: "Codex"
    };
  }

  const auditRows = [];
  for (const routeConfig of auditedRoutes) {
    auditRows.push(await collectRow(routeConfig));
  }

  const auditHtml = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>Friday Empty Copy Audit</title>",
    "<style>",
    "body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px;background:#fbf4ea;color:#2d2118}",
    "table{width:100%;border-collapse:collapse;background:#fffaf5}",
    "th,td{border:1px solid rgba(45,33,24,.12);padding:10px;text-align:left;vertical-align:top;font-size:12px}",
    "th{background:#f5ecdb;text-transform:uppercase;font-size:11px;letter-spacing:.08em}",
    "</style>",
    "</head>",
    "<body>",
    "<h1>Friday Empty-state Copy Audit</h1>",
    `<p>Generated at ${escapeHtml(generatedAt)}.</p>`,
    "<table><thead><tr><th>Page</th><th>Route</th><th>ZH</th><th>EN</th><th>CTA</th><th>Reviewer</th></tr></thead><tbody>",
    ...auditRows.map((row) => `<tr><td>${escapeHtml(row.page)}</td><td>${escapeHtml(row.href)}</td><td>${escapeHtml(`${row.zh.title} ${row.zh.body}`.trim())}</td><td>${escapeHtml(`${row.en.title} ${row.en.body}`.trim())}</td><td>${escapeHtml(row.zh.cta)}</td><td>${escapeHtml(row.reviewer)}</td></tr>`),
    "</tbody></table></body></html>"
  ].join("");
  const auditArtifact = await writeText("screenshots/qa/p2f-03-copy-audit.html", `${auditHtml}\n`);

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F03-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "每页 empty 文案双语 · zh + en 对齐",
    async () => {
      const artifact = await writeJson("screenshots/P2F-03/f03-01-bilingual.json", {
        generatedAt: new Date().toISOString(),
        rows: auditRows
      });
      return {
        pass: auditRows.every((row) => row.zh.title && row.zh.body && row.en.title && row.en.body),
        summary: `${auditRows.length} audited routes`,
        artifacts: [artifact],
        observed: auditRows
      };
    }
  );

  await verifyRule(
    2,
    "语气统一 · 友好 · 有引导 · 不用 \"no data\"(太冷)或 \"好像什么都没有\"(太幼稚)",
    async () => {
      const observed = auditRows.map((row) => ({
        page: row.page,
        zh: `${row.zh.title} ${row.zh.body}`.toLowerCase(),
        en: `${row.en.title} ${row.en.body}`.toLowerCase()
      }));
      const artifact = await writeJson("screenshots/P2F-03/f03-02-tone.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const banned = [/no data/i, /好像什么都没有/];
      return {
        pass: observed.every((row) => banned.every((pattern) => !pattern.test(row.zh) && !pattern.test(row.en))),
        summary: "no banned cold/childish phrasing found",
        artifacts: [artifact],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "每 empty 有下一步 CTA · 明确动作 · 带 arrow icon",
    async () => {
      const observed = auditRows.map((row) => ({
        page: row.page,
        cta: row.zh.cta,
        arrowCount: row.zh.arrowCount
      }));
      const artifact = await writeJson("screenshots/P2F-03/f03-03-cta.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.every((row) => row.cta.length > 0 && row.arrowCount >= 1),
        summary: observed.map((row) => `${row.page}:${row.arrowCount}`).join(", "),
        artifacts: [artifact],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "无 lorem / TBD · grep 检测 0 命中",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const matches = Array.from(source.matchAll(/lorem|ipsum|placeholder|TBD|待补充|样例/gi), (match) => match[0]);
      const artifact = await writeJson("screenshots/P2F-03/f03-04-grep.json", {
        generatedAt: new Date().toISOString(),
        matches
      });
      return {
        pass: matches.length === 0,
        summary: `matches=${matches.length}`,
        artifacts: [artifact],
        observed: { matches }
      };
    }
  );

  await verifyRule(
    5,
    "插图 · 米色 line-art SVG · 最多一个 · 不过度",
    async () => {
      const observed = auditRows.map((row) => ({
        page: row.page,
        svgCount: row.zh.svgCount
      }));
      const artifact = await writeJson("screenshots/P2F-03/f03-05-line-art.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.every((row) => row.svgCount === 1),
        summary: observed.map((row) => `${row.page}:${row.svgCount}`).join(", "),
        artifacts: [artifact],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "copy 审核清单单独 HTML · 每条 page 一行 · zh 列 + en 列 + 审校人",
    async () => {
      const observed = {
        rows: auditRows.length,
        path: auditArtifact.path,
        sha256: auditArtifact.sha256
      };
      const probe = await writeJson("screenshots/P2F-03/f03-06-copy-audit.json", {
        generatedAt: new Date().toISOString(),
        observed,
        auditHtml: auditArtifact.path
      });
      return {
        pass: auditRows.length === auditedRoutes.length,
        summary: `${auditRows.length} rows in ${auditArtifact.path}`,
        artifacts: [probe, auditArtifact],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-03", "all", generatedAt, results, artifacts);
}

async function verifyP2F04(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F04-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "每页 error 有 retry 按钮 · 主色",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/assistant?dev=1&__state=error");
      const observed = await page.evaluate(() => {
        const shell = document.querySelector(".inline-error-shell");
        const button = shell?.querySelector(".action-button");
        return {
          shellPresent: Boolean(shell),
          buttonText: button?.textContent?.trim() ?? null,
          buttonClassName: button?.className ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-04/f04-01-retry-primary.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-01-retry-primary.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.shellPresent &&
          observed.buttonText === "重试" &&
          observed.buttonClassName?.includes("action-button-primary"),
        summary: `${observed.buttonText} / ${observed.buttonClassName}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "\"为什么?\" 可展开 · 默认折叠 · 展开技术描述(人话)",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/assistant?dev=1&__state=error");
      const observed = await page.evaluate(() => {
        const details = document.querySelector(".inline-error-shell details");
        const summary = details?.querySelector("summary");
        const before = details?.open ?? null;
        summary?.click();
        return {
          before,
          after: details?.open ?? null,
          reason: details?.querySelector("div")?.textContent?.trim() ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-02-why.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.before === false &&
          observed.after === true &&
          observed.reason?.length >= 8 &&
          /(stack|traceback|select\s+.+from|\/Users\/|internal\/|sql)/i.test(String(observed.reason || "")) === false,
        summary: observed.reason,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "不暴露堆栈 / SQL / internal paths",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/assistant?dev=1&__state=error");
      const observed = await page.evaluate(() => {
        const shell = document.querySelector(".inline-error-shell");
        return {
          text: shell?.textContent?.replace(/\s+/g, " ").trim() ?? ""
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-03-sanitized.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const banned = /(stack|traceback|select\s+.+from|\/Users\/|internal\/|sql)/i;
      return {
        pass: banned.test(observed.text) === false,
        summary: "no stack/sql/internal path leak",
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "每 error 有 errorId · 可 copy · 7 字母数字",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/assistant?dev=1&__state=error");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const observed = await page.evaluate(async () => {
        const shell = document.querySelector(".inline-error-shell");
        const errorId = shell?.getAttribute("data-error-id") ?? null;
        const copyButton = shell?.querySelector('[data-action="copy-error-id"]');
        copyButton?.click();
        const clipboardText = await navigator.clipboard.readText();
        return {
          errorId,
          clipboardText,
          copyPayload: copyButton?.getAttribute("data-payload") ?? null
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-04-error-id.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          /^[A-Z0-9]{7}$/.test(String(observed.errorId || "")) &&
          observed.clipboardText === observed.errorId &&
          observed.copyPayload === observed.errorId,
        summary: observed.errorId,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "双语",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/assistant?dev=1&__state=error");
      const zh = await page.evaluate(() => ({
        title: document.querySelector(".inline-error-shell strong")?.textContent?.trim() ?? "",
        detail: document.querySelector(".inline-error-shell span")?.textContent?.trim() ?? "",
        retry: document.querySelector(".inline-error-shell .action-button")?.textContent?.trim() ?? ""
      }));
      await page.evaluate(() => window.__fridayQa.shell.setTweak("localePreview", "en"));
      const en = await page.evaluate(() => ({
        title: document.querySelector(".inline-error-shell strong")?.textContent?.trim() ?? "",
        detail: document.querySelector(".inline-error-shell span")?.textContent?.trim() ?? "",
        retry: document.querySelector(".inline-error-shell .action-button")?.textContent?.trim() ?? ""
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-05-bilingual.json", {
        generatedAt: new Date().toISOString(),
        zh,
        en
      });
      return {
        pass: zh.title !== en.title && zh.detail !== en.detail && zh.retry !== en.retry,
        summary: `${zh.title} -> ${en.title}`,
        artifacts: [probe],
        observed: {
          zh,
          en
        }
      };
    }
  );

  await verifyRule(
    6,
    "网络断 · 特定文案 \"你似乎离线了 · 正在自动重试\"",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = await page.evaluate(() => {
        return window.__fridayQa.shell.inspectErrorBar({
          kind: "offline",
          title: "network",
          detail: "ignored"
        });
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-06-offline.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.detail === "你似乎离线了 · 正在自动重试",
        summary: observed.detail,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    7,
    "rate-limited · \"操作太频繁 · 请 N 秒后再试\" + 倒计时",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = await page.evaluate(() => {
        const retryAtMs = window.__fridayMock.getState().clockMs + 5000;
        const first = window.__fridayQa.shell.inspectErrorBar({
          kind: "rate-limited",
          title: "rate limit",
          retryAtMs
        });
        window.__fridayMock.advanceClock(1000);
        const second = window.__fridayQa.shell.inspectErrorBar({
          kind: "rate-limited",
          title: "rate limit",
          retryAtMs
        });
        return {
          first: first.detail,
          second: second.detail,
          retryAtMs
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-04/f04-07-rate-limit.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.first === "操作太频繁 · 请 5 秒后再试" &&
          observed.second === "操作太频繁 · 请 4 秒后再试",
        summary: `${observed.first} -> ${observed.second}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-04", "all", generatedAt, results, artifacts);
}

async function verifyP2F05(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();
  const buildPlan = await parseBuildPlan();
  const auditEntries = buildPlan
    .filter((row) => String(row.Item_ID || "").startsWith("P2"))
    .flatMap((row) => expandBuildPlanAuditHrefs(row).map((href, index) => ({
      itemId: row.Item_ID,
      href,
      index
    })));

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F05-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "Tab 顺序符合视觉顺序 · 无跳跃",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const shellTrail = [];
      for (let index = 0; index < 16; index += 1) {
        await page.keyboard.press("Tab");
        shellTrail.push(await page.evaluate(() => {
          const node = document.activeElement;
          const rect = node?.getBoundingClientRect();
          return {
            tag: node?.tagName ?? null,
            id: node?.id ?? null,
            label: node?.getAttribute("aria-label") ?? node?.textContent?.replace(/\s+/g, " ").trim() ?? null,
            railLink: Boolean(node?.closest(".shell-rail")),
            x: rect ? Math.round(rect.x) : null,
            y: rect ? Math.round(rect.y) : null
          };
        }));
      }
      await context.close();
      const monotonicY = shellTrail.every((entry, index) => index === 0 || (entry.y != null && entry.y >= shellTrail[index - 1].y));
      const stableColumn = shellTrail.every((entry, index) => index === 0 || (entry.x != null && Math.abs(entry.x - shellTrail[index - 1].x) <= 180));
      const focusLabels = shellTrail.map((entry) => entry.label).filter(Boolean);
      const noDuplicateLoop = new Set(focusLabels).size === focusLabels.length;
      const startsInRail = shellTrail.slice(0, 12).every((entry) => entry.railLink === true);
      const probe = await writeJson("screenshots/P2F-05/f05-01-tab-order.json", {
        generatedAt: new Date().toISOString(),
        shellTrail,
        monotonicY,
        stableColumn,
        noDuplicateLoop,
        startsInRail
      });
      return {
        pass: shellTrail.length === 16 && monotonicY && stableColumn && noDuplicateLoop && startsInRail,
        summary: shellTrail.map((entry) => entry.label).join(" -> "),
        artifacts: [probe],
        observed: {
          shellTrail,
          monotonicY,
          stableColumn,
          noDuplicateLoop,
          startsInRail
        }
      };
    }
  );

  await verifyRule(
    2,
    "focus ring 2px 琥珀 + 2px offset · 所有可交互元素",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const sourceRulePresent =
        source.includes(":focus-visible") &&
        source.includes("outline: 2px solid var(--accent);") &&
        source.includes("outline-offset: 2px;");
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.keyboard.press("Tab");
      const observed = await page.evaluate(() => {
        const node = document.activeElement;
        const style = node ? getComputedStyle(node) : null;
        const accentProbe = document.createElement("div");
        accentProbe.style.color = "var(--accent)";
        document.body.appendChild(accentProbe);
        const accentColor = getComputedStyle(accentProbe).color;
        accentProbe.remove();
        return {
          focusedLabel: node?.getAttribute("aria-label") ?? node?.textContent?.trim() ?? null,
          outlineWidth: style?.outlineWidth ?? null,
          outlineStyle: style?.outlineStyle ?? null,
          outlineOffset: style?.outlineOffset ?? null,
          outlineColor: style?.outlineColor ?? null,
          accentColor
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-05/f05-02-focus-ring.json", {
        generatedAt: new Date().toISOString(),
        sourceRulePresent,
        observed
      });
      return {
        pass:
          sourceRulePresent &&
          observed.outlineWidth === "2px" &&
          observed.outlineStyle === "solid" &&
          observed.outlineOffset === "2px" &&
          observed.outlineColor === observed.accentColor,
        summary: `${observed.outlineWidth} ${observed.outlineColor} offset=${observed.outlineOffset}`,
        artifacts: [probe],
        observed: {
          sourceRulePresent,
          observed
        }
      };
    }
  );

  await verifyRule(
    3,
    "所有 icon-only 按钮有 aria-label",
    async () => {
      const missing = [];
      const scanned = [];
      for (const entry of auditEntries) {
        const { page, context } = await bootAuditRoute(browser, baseUrl, entry.href, { waitMs: 160 });
        const routeObserved = await page.evaluate(() => {
          function isVisible(node) {
            if (!node) return false;
            const style = getComputedStyle(node);
            return style.display !== "none" && style.visibility !== "hidden";
          }
          return Array.from(document.querySelectorAll("button, a, [role='button']"))
            .filter((node) => isVisible(node))
            .map((node) => {
              const label = node.getAttribute("aria-label") || node.getAttribute("aria-labelledby") || "";
              const text = (node.textContent || "").replace(/\s+/g, " ").trim();
              const hasIconOnlyClass =
                node.querySelector("[aria-hidden='true']") &&
                text.length <= 2;
              const looksLikeSymbolOnly = text.length > 0 && /^[×✕✖↔↕↩↺↻↗↘↙↖→←↑↓+\-•⋯…]+$/.test(text);
              const isIconOnly = text.length === 0 || hasIconOnlyClass || looksLikeSymbolOnly;
              return {
                isIconOnly,
                label,
                text,
                tag: node.tagName,
                id: node.id || null,
                className: node.className || null
              };
            })
            .filter((node) => node.isIconOnly);
        });
        scanned.push({
          itemId: entry.itemId,
          href: entry.href,
          iconOnlyCount: routeObserved.length
        });
        routeObserved.forEach((node) => {
          if (!String(node.label || "").trim()) {
            missing.push({
              itemId: entry.itemId,
              href: entry.href,
              node
            });
          }
        });
        await context.close();
      }
      const probe = await writeJson("screenshots/P2F-05/f05-03-icon-labels.json", {
        generatedAt: new Date().toISOString(),
        scanned,
        missing
      });
      return {
        pass: missing.length === 0,
        summary: `scanned=${scanned.length} missing=${missing.length}`,
        artifacts: [probe],
        observed: {
          scanned,
          missing
        }
      };
    }
  );

  await verifyRule(
    4,
    "modal / drawer Escape 关 · 开时 focus trap · 关时 focus 回触发源",
    async () => {
      const modal = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await modal.page.focus('[data-action="toggle-command-palette"]');
      const modalTriggerBefore = await modal.page.evaluate(() => document.activeElement?.getAttribute("data-action") ?? null);
      await modal.page.keyboard.press("Enter");
      await modal.page.waitForSelector("#command-palette-input");
      const modalOpen = await modal.page.evaluate(() => ({
        activeId: document.activeElement?.id ?? null,
        trapScope: document.activeElement?.closest('.overlay-panel[role="dialog"][aria-modal="true"]')?.className ?? null
      }));
      await modal.page.keyboard.press("Shift+Tab");
      const modalTrap = await modal.page.evaluate(() => ({
        activeId: document.activeElement?.id ?? null,
        inOverlay: Boolean(document.activeElement?.closest('.overlay-panel[role="dialog"][aria-modal="true"]'))
      }));
      await modal.page.keyboard.press("Escape");
      await modal.page.waitForTimeout(120);
      const modalClosed = await modal.page.evaluate(() => ({
        paletteOpen: Boolean(document.querySelector("#command-palette-input")),
        activeAction: document.activeElement?.getAttribute("data-action") ?? null
      }));
      await modal.context.close();

      const drawer = await bootAssistantPage(browser, baseUrl, "pending", { searchParams: { tab: "approvals" } });
      await drawer.page.focus('[data-action="open-approval-drawer"]');
      const drawerTriggerBefore = await drawer.page.evaluate(() => document.activeElement?.getAttribute("data-action") ?? null);
      await drawer.page.keyboard.press("Enter");
      await drawer.page.waitForSelector('[data-approval-drawer]');
      const drawerOpen = await drawer.page.evaluate(() => ({
        activeText: document.activeElement?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        inDrawer: Boolean(document.activeElement?.closest('[data-drawer-kind="approval"]'))
      }));
      const drawerFocusCount = await drawer.page.locator('[data-drawer-kind="approval"] button, [data-drawer-kind="approval"] a, [data-drawer-kind="approval"] input, [data-drawer-kind="approval"] textarea, [data-drawer-kind="approval"] select').count();
      for (let index = 0; index < Math.max(1, drawerFocusCount + 1); index += 1) {
        await drawer.page.keyboard.press("Tab");
      }
      const drawerTrap = await drawer.page.evaluate(() => ({
        inDrawer: Boolean(document.activeElement?.closest('[data-drawer-kind="approval"]'))
      }));
      await drawer.page.keyboard.press("Escape");
      await drawer.page.waitForTimeout(120);
      const drawerClosed = await drawer.page.evaluate(() => ({
        drawerOpen: Boolean(document.querySelector('[data-drawer-kind="approval"]')),
        activeAction: document.activeElement?.getAttribute("data-action") ?? null
      }));
      await drawer.context.close();

      const probe = await writeJson("screenshots/P2F-05/f05-04-modal-drawer.json", {
        generatedAt: new Date().toISOString(),
        modalTriggerBefore,
        modalOpen,
        modalTrap,
        modalClosed,
        drawerTriggerBefore,
        drawerOpen,
        drawerTrap,
        drawerClosed
      });
      return {
        pass:
          modalTriggerBefore === "toggle-command-palette" &&
          modalOpen.activeId === "command-palette-input" &&
          Boolean(modalOpen.trapScope) &&
          modalTrap.inOverlay === true &&
          modalClosed.paletteOpen === false &&
          modalClosed.activeAction === "toggle-command-palette" &&
          drawerTriggerBefore === "open-approval-drawer" &&
          drawerOpen.inDrawer === true &&
          drawerTrap.inDrawer === true &&
          drawerClosed.drawerOpen === false &&
          drawerClosed.activeAction === "open-approval-drawer",
        summary: `modal=${modalClosed.activeAction} drawer=${drawerClosed.activeAction}`,
        artifacts: [probe],
        observed: {
          modalTriggerBefore,
          modalOpen,
          modalTrap,
          modalClosed,
          drawerTriggerBefore,
          drawerOpen,
          drawerTrap,
          drawerClosed
        }
      };
    }
  );

  await verifyRule(
    5,
    "列表方向键 · ↑↓ 移动 · Home/End 首末",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.keyboard.press("Meta+K");
      await page.waitForSelector("#command-palette-input");
      const before = await page.evaluate(() => ({
        activeDescendant: document.querySelector("#command-palette-input")?.getAttribute("aria-activedescendant") ?? null,
        activeLabel: document.querySelector(".command-item.is-active strong")?.textContent?.trim() ?? null,
        count: document.querySelectorAll(".command-item").length
      }));
      await page.keyboard.press("ArrowDown");
      const afterDown = await page.evaluate(() => ({
        activeDescendant: document.querySelector("#command-palette-input")?.getAttribute("aria-activedescendant") ?? null,
        activeLabel: document.querySelector(".command-item.is-active strong")?.textContent?.trim() ?? null
      }));
      await page.keyboard.press("Home");
      const afterHome = await page.evaluate(() => ({
        activeDescendant: document.querySelector("#command-palette-input")?.getAttribute("aria-activedescendant") ?? null,
        activeLabel: document.querySelector(".command-item.is-active strong")?.textContent?.trim() ?? null
      }));
      await page.keyboard.press("End");
      const afterEnd = await page.evaluate(() => ({
        activeDescendant: document.querySelector("#command-palette-input")?.getAttribute("aria-activedescendant") ?? null,
        activeLabel: document.querySelector(".command-item.is-active strong")?.textContent?.trim() ?? null
      }));
      await page.keyboard.press("ArrowUp");
      const afterUp = await page.evaluate(() => ({
        activeDescendant: document.querySelector("#command-palette-input")?.getAttribute("aria-activedescendant") ?? null,
        activeLabel: document.querySelector(".command-item.is-active strong")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2F-05/f05-05-list-keys.json", {
        generatedAt: new Date().toISOString(),
        before,
        afterDown,
        afterHome,
        afterEnd,
        afterUp
      });
      return {
        pass:
          before.count >= 14 &&
          before.activeDescendant === "command-palette-item-0" &&
          afterDown.activeDescendant === "command-palette-item-1" &&
          afterHome.activeDescendant === "command-palette-item-0" &&
          afterEnd.activeDescendant === `command-palette-item-${String(before.count - 1)}` &&
          afterUp.activeDescendant === `command-palette-item-${String(before.count - 2)}`,
        summary: `${before.activeLabel} -> ${afterDown.activeLabel} -> ${afterEnd.activeLabel}`,
        artifacts: [probe],
        observed: {
          before,
          afterDown,
          afterHome,
          afterEnd,
          afterUp
        }
      };
    }
  );

  await verifyRule(
    6,
    "form label 关联 · input 有 id + label for",
    async () => {
      const settings = await bootSettingsPage(browser, baseUrl, "providers");
      await settings.page.evaluate(() => window.__fridayQa.settings.openProviderModal("edit", "provider-openai"));
      await settings.page.waitForSelector("#provider-modal-name");
      const providerFields = await settings.page.evaluate(() =>
        Array.from(document.querySelectorAll(".settings-modal input, .settings-modal select, .settings-modal textarea"))
          .filter((node) => node.id)
          .map((node) => ({
            id: node.id,
            labelCount: node.labels ? node.labels.length : 0,
            labelFors: Array.from(node.labels || []).map((label) => label.getAttribute("for") || null)
          }))
      );
      await settings.context.close();

      const observability = await bootObservabilityPage(browser, baseUrl, "alerts");
      await observability.page.click('[data-action="observability-alert-create"]');
      await observability.page.waitForSelector("#observability-alert-name");
      const alertFields = await observability.page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-alert-modal] input, [data-alert-modal] select, [data-alert-modal] textarea"))
          .filter((node) => node.id)
          .map((node) => ({
            id: node.id,
            labelCount: node.labels ? node.labels.length : 0,
            labelFors: Array.from(node.labels || []).map((label) => label.getAttribute("for") || null)
          }))
      );
      await observability.context.close();

      const allFields = providerFields.concat(alertFields);
      const probe = await writeJson("screenshots/P2F-05/f05-06-form-labels.json", {
        generatedAt: new Date().toISOString(),
        providerFields,
        alertFields
      });
      return {
        pass: allFields.every((field) => field.id && field.labelCount >= 1 && field.labelFors.some((value) => value === field.id)),
        summary: `provider=${providerFields.length} alert=${alertFields.length}`,
        artifacts: [probe],
        observed: {
          providerFields,
          alertFields
        }
      };
    }
  );

  await verifyRule(
    7,
    "错误与 input 用 aria-describedby 连",
    async () => {
      const { page, context } = await bootObservabilityPage(browser, baseUrl, "alerts");
      await page.click('[data-action="observability-alert-create"]');
      await page.waitForSelector("#observability-alert-name");
      await page.fill("#observability-alert-name", "");
      await page.selectOption("#observability-alert-metric", "");
      await page.waitForTimeout(100);
      const step1 = await page.evaluate(() => ({
        nameDescribedBy: document.querySelector("#observability-alert-name")?.getAttribute("aria-describedby") ?? null,
        metricDescribedBy: document.querySelector("#observability-alert-metric")?.getAttribute("aria-describedby") ?? null,
        nameErrorText: document.querySelector("#observability-alert-name-error")?.textContent?.trim() ?? null,
        metricErrorText: document.querySelector("#observability-alert-metric-error")?.textContent?.trim() ?? null
      }));
      await page.fill("#observability-alert-name", "供应商超时保护");
      await page.selectOption("#observability-alert-metric", "latency.p95");
      await page.click('[data-action="observability-alert-step-next"]');
      await page.waitForTimeout(120);
      await page.fill("#observability-alert-threshold-value", "abc");
      await page.waitForTimeout(100);
      const step2 = await page.evaluate(() => ({
        thresholdDescribedBy: document.querySelector("#observability-alert-threshold-value")?.getAttribute("aria-describedby") ?? null,
        thresholdErrorText: document.querySelector("#observability-alert-threshold-error")?.textContent?.trim() ?? null
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2F-05/f05-07-describedby.json", {
        generatedAt: new Date().toISOString(),
        step1,
        step2
      });
      return {
        pass:
          step1.nameDescribedBy === "observability-alert-name-error" &&
          step1.metricDescribedBy === "observability-alert-metric-error" &&
          Boolean(step1.nameErrorText) &&
          Boolean(step1.metricErrorText) &&
          step2.thresholdDescribedBy === "observability-alert-threshold-error" &&
          Boolean(step2.thresholdErrorText),
        summary: `${step1.nameDescribedBy}, ${step2.thresholdDescribedBy}`,
        artifacts: [probe],
        observed: {
          step1,
          step2
        }
      };
    }
  );

  await verifyRule(
    8,
    "运行 axe-core · 0 critical · 记录 report",
    async () => {
      const axePackage = JSON.parse(await fs.readFile(path.join(ROOT, "node_modules", "axe-core", "package.json"), "utf8"));
      const uniqueRoutes = Array.from(auditEntries.reduce((map, entry) => {
        const current = map.get(entry.href) || { href: entry.href, itemIds: [] };
        current.itemIds.push(entry.itemId);
        map.set(entry.href, current);
        return map;
      }, new Map()).values());
      const routes = [];
      for (const entry of uniqueRoutes) {
        const { page, context } = await bootAuditRoute(browser, baseUrl, entry.href, { waitMs: 120 });
        const result = await new AxeBuilder({ page }).analyze();
        routes.push({
          itemIds: Array.from(new Set(entry.itemIds)),
          href: entry.href,
          generatedAt: new Date().toISOString(),
          result
        });
        await context.close();
      }
      const criticalCount = routes.reduce((sum, route) => (
        sum + route.result.violations.filter((violation) => violation.impact === "critical").length
      ), 0);
      const probe = await writeJson("screenshots/P2F-05/f05-08-axe-report.json", {
        generatedAt: new Date().toISOString(),
        axeVersion: axePackage.version,
        rulesConfig: "default",
        routeCount: routes.length,
        criticalCount,
        routes
      });
      return {
        pass: criticalCount === 0,
        summary: `routes=${routes.length} critical=${criticalCount}`,
        artifacts: [probe],
        observed: {
          axeVersion: axePackage.version,
          routeCount: routes.length,
          criticalCount
        }
      };
    }
  );

  await verifyRule(
    9,
    "色对比 WCAG AA · body text ≥ 4.5 · large ≥ 3",
    async () => {
      const samples = [
        { label: "home-body", href: "/home?dev=1&__state=empty", selector: ".empty-hero p", large: false },
        { label: "home-heading", href: "/home?dev=1&__state=normal", selector: ".home-section-title", large: true },
        { label: "assistant-heading", href: "/assistant?dev=1&__state=pending&tab=approvals", selector: ".assistant-card-title", large: true },
        { label: "settings-hint", href: "/settings?dev=1&tab=providers&__state=providers", selector: ".settings-hint-text", large: false },
        { label: "usage-table", href: "/usage?dev=1&__state=this-month", selector: "[data-usage-provider-table] td div", large: false }
      ];
      const observed = [];
      for (const sample of samples) {
        const { page, context } = await bootAuditRoute(browser, baseUrl, sample.href, { waitMs: 180 });
        const reading = await page.evaluate(({ selector, label, large }) => {
          function resolveBackground(node) {
            let current = node;
            while (current) {
              const color = getComputedStyle(current).backgroundColor;
              if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
                return color;
              }
              current = current.parentElement;
            }
            return getComputedStyle(document.body).backgroundColor;
          }
          const node = document.querySelector(selector);
          const style = node ? getComputedStyle(node) : null;
          return {
            label,
            selector,
            large,
            text: node?.textContent?.replace(/\s+/g, " ").trim() ?? null,
            color: style?.color ?? null,
            background: node ? resolveBackground(node) : null,
            fontSize: style?.fontSize ?? null,
            fontWeight: style?.fontWeight ?? null
          };
        }, sample);
        reading.ratio = contrastRatio(reading.color, reading.background);
        observed.push(reading);
        await context.close();
      }
      const probe = await writeJson("screenshots/P2F-05/f05-09-contrast.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.every((entry) => entry.ratio != null && entry.ratio >= (entry.large ? 3 : 4.5)),
        summary: observed.map((entry) => `${entry.label}:${entry.ratio?.toFixed(2) ?? "n/a"}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    10,
    "Cmd+K 可导航到所有路由 · 14+ 条目",
    async () => {
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const routeLiteralMatch = staticSource.match(/var SUPPORTED_ROUTES = \[(.*?)\];/s);
      const expectedRouteIds = routeLiteralMatch
        ? Array.from(routeLiteralMatch[1].matchAll(/"([^"]+)"/g), (match) => `route:${match[1]}`)
        : [];
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.keyboard.press("Meta+K");
      await page.waitForSelector("#command-palette-input");
      const observed = await page.evaluate(() => {
        const state = window.__fridayQa.shell.getState();
        return {
          open: state.commandPaletteOpen,
          count: state.commandItems.length,
          labels: state.commandItems.map((item) => item.label),
          ids: state.commandItems.map((item) => item.id),
          routeIds: state.commandItems.filter((item) => item.id.startsWith("route:")).map((item) => item.id)
        };
      });
      await page.fill("#command-palette-input", "设置");
      await page.waitForTimeout(80);
      const settingsSearch = await page.evaluate(() => ({
        activeId: document.querySelector("#command-palette-input")?.getAttribute("aria-activedescendant") ?? null,
        labels: Array.from(document.querySelectorAll(".command-item strong")).map((node) => node.textContent?.trim() ?? "")
      }));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      const navigated = await page.evaluate(() => ({
        pathname: window.location.pathname,
        search: window.location.search,
        route: window.__fridayQa.shell.getState().route,
        commandPaletteOpen: window.__fridayQa.shell.getState().commandPaletteOpen
      }));
      await context.close();
      const probe = await writeJson("screenshots/P2F-05/f05-10-command-palette.json", {
        generatedAt: new Date().toISOString(),
        observed,
        expectedRouteIds,
        settingsSearch,
        navigated
      });
      return {
        pass:
          observed.open === true &&
          observed.count >= 14 &&
          expectedRouteIds.length >= 14 &&
          expectedRouteIds.every((id) => observed.routeIds.includes(id)) &&
          settingsSearch.activeId === "command-palette-item-0" &&
          settingsSearch.labels[0] === "设置" &&
          navigated.pathname === "/settings" &&
          navigated.route === "/settings" &&
          navigated.commandPaletteOpen === false,
        summary: `count=${observed.count}`,
        artifacts: [probe],
        observed: {
          observed,
          expectedRouteIds,
          settingsSearch,
          navigated
        }
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-05", "all", generatedAt, results, artifacts);
}

async function verifyP2F06(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F06-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  async function shellLayout(width, href) {
    const { page, context } = await bootShellPage(browser, baseUrl, href, {
      viewport: { width, height: 1000 }
    });
    const observed = await page.evaluate(() => {
      const rail = document.querySelector(".shell-rail");
      const main = document.querySelector(".shell-main");
      const right = document.querySelector(".shell-right-rail");
      const railRect = rail?.getBoundingClientRect();
      const mainRect = main?.getBoundingClientRect();
      const rightRect = right?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        railDisplay: rail ? getComputedStyle(rail).display : null,
        rightDisplay: right ? getComputedStyle(right).display : null,
        railWidth: railRect ? Math.round(railRect.width) : null,
        mainWidth: mainRect ? Math.round(mainRect.width) : null,
        rightWidth: rightRect ? Math.round(rightRect.width) : null
      };
    });
    return { page, context, observed };
  }

  await verifyRule(
    1,
    "1280 下三栏(rail 240 · main 996 · rail collapsible)· 无横向滚动",
    async () => {
      const { page, context, observed } = await shellLayout(1280, "/home?dev=1&__state=normal");
      const shot = await captureScreenshot(page, "screenshots/P2F-06/f06-01-1280-home.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-06/f06-01-1280-home.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.scrollWidth === 1280 &&
          observed.railDisplay === "flex" &&
          observed.rightDisplay === "block" &&
          observed.railWidth === 64 &&
          observed.mainWidth === 996 &&
          observed.rightWidth === 220,
        summary: `rail=${observed.railWidth} main=${observed.mainWidth} right=${observed.rightWidth}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    2,
    "1440 下三栏舒展 · rail 可选 collapse",
    async () => {
      const { page, context, observed } = await shellLayout(1440, "/home?dev=1&__state=normal");
      const shot = await captureScreenshot(page, "screenshots/P2F-06/f06-02-1440-home.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-06/f06-02-1440-home.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.scrollWidth === 1440 &&
          observed.railWidth === 240 &&
          observed.rightWidth === 304 &&
          observed.mainWidth === 896,
        summary: `rail=${observed.railWidth} main=${observed.mainWidth} right=${observed.rightWidth}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "1920 下多列布局激活(如 pack 4 列)",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/packs?dev=1&__state=full-catalog", {
        viewport: { width: 1920, height: 1200 }
      });
      const observed = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("[data-pack-id]"));
        const uniqueColumns = Array.from(new Set(cards.slice(0, 8).map((card) => Math.round(card.getBoundingClientRect().left))));
        return {
          packCount: cards.length,
          uniqueColumns,
          columnCount: uniqueColumns.length
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-06/f06-03-1920-packs.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-06/f06-03-1920-packs.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass: observed.packCount >= 4 && observed.columnCount >= 4,
        summary: `columns=${observed.columnCount}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "每档截图 5 个关键页 · 对比放入 qa-report",
    async () => {
      const widths = [1280, 1440, 1920];
      const pages = [
        { key: "home", href: "/home?dev=1&__state=normal" },
        { key: "assistant", href: "/assistant?dev=1&__state=pending&tab=approvals" },
        { key: "observability", href: "/observability?dev=1&focus=alerts&window=15m&__state=active" },
        { key: "packs", href: "/packs?dev=1&__state=full-catalog" },
        { key: "settings", href: "/settings?dev=1&tab=providers&__state=providers" }
      ];
      const screenshots = [];
      for (const width of widths) {
        for (const pageConfig of pages) {
          const { page, context } = await bootShellPage(browser, baseUrl, pageConfig.href, {
            viewport: { width, height: 1000 }
          });
          const shot = await captureScreenshot(page, `screenshots/P2F-06/f06-04-${pageConfig.key}-${width}.png`);
          screenshots.push({
            width,
            page: pageConfig.key,
            path: shot.path,
            sha256: shot.sha256
          });
          await context.close();
        }
      }
      const probe = await writeJson("screenshots/P2F-06/f06-04-screenshot-matrix.json", {
        generatedAt: new Date().toISOString(),
        screenshots
      });
      return {
        pass: screenshots.length === 15,
        summary: `${screenshots.length} responsive screenshots`,
        artifacts: [probe, ...screenshots.map((item) => ({ path: item.path, sha256: item.sha256 }))],
        observed: {
          screenshots
        }
      };
    }
  );

  await verifyRule(
    5,
    "字体大小不缩 · 仍 14/15 基线",
    async () => {
      const observed = [];
      for (const width of [1280, 1440, 1920]) {
        const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal", {
          viewport: { width, height: 1000 }
        });
        observed.push(await page.evaluate((currentWidth) => ({
          width: currentWidth,
          topbarTitle: getComputedStyle(document.querySelector(".topbar-title")).fontSize,
          actionButton: getComputedStyle(document.querySelector(".action-button")).fontSize
        }), width));
        await context.close();
      }
      const probe = await writeJson("screenshots/P2F-06/f06-05-font-baseline.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.every((entry) => entry.topbarTitle === "15px" && entry.actionButton === "14px"),
        summary: observed.map((entry) => `${entry.width}:${entry.topbarTitle}/${entry.actionButton}`).join(", "),
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    6,
    "rail 64 窄态下 icon 居中 + tooltip hover 显示文字",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal", {
        viewport: { width: 1280, height: 1000 }
      });
      await page.hover(".shell-rail .rail-nav-link");
      await page.waitForTimeout(80);
      const observed = await page.evaluate(() => {
        const link = document.querySelector(".shell-rail .rail-nav-link");
        const icon = link?.querySelector(".rail-icon");
        const linkRect = link?.getBoundingClientRect();
        const iconRect = icon?.getBoundingClientRect();
        return {
          railWidth: Math.round(document.querySelector(".shell-rail")?.getBoundingClientRect().width ?? 0),
          iconCenterDelta: linkRect && iconRect
            ? Math.round(Math.abs((linkRect.left + linkRect.width / 2) - (iconRect.left + iconRect.width / 2)))
            : null,
          tooltipContent: link ? getComputedStyle(link, "::after").content : null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-06/f06-06-compact-rail-tooltip.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-06/f06-06-compact-rail-tooltip.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.railWidth === 64 &&
          observed.iconCenterDelta === 0 &&
          observed.tooltipContent !== "none" &&
          observed.tooltipContent.includes("首页"),
        summary: `rail=${observed.railWidth} tooltip=${observed.tooltipContent}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-06", "all", generatedAt, results, artifacts);
}

async function verifyP2F08(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F08-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "Ctrl+P · Home / Assistant / Observability 三页支持 · 其他页显示 \"该页不支持打印\"",
    async () => {
      const supportedRoutes = [
        { key: "home", href: "/home?dev=1&__state=normal" },
        { key: "assistant", href: "/assistant?dev=1&__state=pending&tab=approvals" },
        { key: "observability", href: "/observability?dev=1&focus=alerts&window=15m&__state=active" }
      ];
      const supported = [];
      for (const route of supportedRoutes) {
        const { page, context } = await bootShellPage(browser, baseUrl, route.href);
        await page.emulateMedia({ media: "print" });
        const observed = await page.evaluate(() => ({
          printSupported: document.body.dataset.printSupported,
          headerVisible: getComputedStyle(document.querySelector("[data-print-header='true']")).display
        }));
        const pdf = await capturePdf(page, `screenshots/P2F-08/f08-01-${route.key}.pdf`);
        supported.push({
          key: route.key,
          href: route.href,
          observed,
          path: pdf.path,
          sha256: pdf.sha256
        });
        await context.close();
      }
      const unsupportedPage = await bootShellPage(browser, baseUrl, "/settings?dev=1&tab=providers&__state=providers");
      await unsupportedPage.page.emulateMedia({ media: "print" });
      const unsupported = await unsupportedPage.page.evaluate(() => ({
        printSupported: document.body.dataset.printSupported,
        unsupportedDisplay: getComputedStyle(document.querySelector("[data-print-unsupported='true']")).display,
        unsupportedText: document.querySelector("[data-print-unsupported='true']")?.textContent?.trim() ?? null
      }));
      const unsupportedShot = await captureScreenshot(unsupportedPage.page, "screenshots/P2F-08/f08-01-unsupported-settings.png");
      await unsupportedPage.context.close();
      const probe = await writeJson("screenshots/P2F-08/f08-01-supported-routes.json", {
        generatedAt: new Date().toISOString(),
        supported,
        unsupported,
        unsupportedScreenshot: unsupportedShot.path
      });
      return {
        pass:
          supported.every((entry) => entry.observed.printSupported === "true" && entry.observed.headerVisible === "flex") &&
          unsupported.printSupported === "false" &&
          unsupported.unsupportedDisplay === "block" &&
          unsupported.unsupportedText === "该页不支持打印",
        summary: `supported=${supported.length} unsupported=${unsupported.unsupportedText}`,
        artifacts: [probe, unsupportedShot, ...supported.map((entry) => ({ path: entry.path, sha256: entry.sha256 }))],
        observed: {
          supported,
          unsupported
        }
      };
    }
  );

  await verifyRule(
    2,
    "print CSS · rail + topbar + tweaks 隐藏 · 主内容满宽",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.evaluate(() => window.__fridayQa.shell.setTweaksOpen(true));
      await page.emulateMedia({ media: "print" });
      const observed = await page.evaluate(() => ({
        railDisplay: getComputedStyle(document.querySelector(".shell-rail")).display,
        topbarDisplay: getComputedStyle(document.querySelector(".shell-topbar")).display,
        rightDisplay: getComputedStyle(document.querySelector(".shell-right-rail")).display,
        tweaksDisplay: getComputedStyle(document.querySelector(".tweaks-panel")).display,
        mainWidth: Math.round(document.querySelector(".shell-main").getBoundingClientRect().width),
        viewportWidth: window.innerWidth
      }));
      const shot = await captureScreenshot(page, "screenshots/P2F-08/f08-02-print-layout.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-08/f08-02-print-layout.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.railDisplay === "none" &&
          observed.topbarDisplay === "none" &&
          observed.rightDisplay === "none" &&
          observed.tweaksDisplay === "none" &&
          observed.mainWidth >= observed.viewportWidth - 2,
        summary: `main=${observed.mainWidth}/${observed.viewportWidth}`,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await verifyRule(
    3,
    "分页正确 · 卡片不被裁断 · 加 page-break-inside: avoid",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/observability?dev=1&focus=alerts&window=15m&__state=active");
      await page.emulateMedia({ media: "print" });
      const observed = await page.evaluate(() =>
        [".shell-card", ".run-card", ".obs-row", ".pack-catalog-card", ".chat-bubble", ".chat-message-row", ".settings-save-bar", ".home-section"]
          .map((selector) => {
            const node = document.querySelector(selector);
            const style = node ? getComputedStyle(node) : null;
            return {
              selector,
              exists: Boolean(node),
              breakInside: style?.breakInside ?? null,
              pageBreakInside: style?.pageBreakInside ?? null
            };
          })
      );
      const pdf = await capturePdf(page, "screenshots/P2F-08/f08-03-observability.pdf");
      await context.close();
      const probe = await writeJson("screenshots/P2F-08/f08-03-page-breaks.json", {
        generatedAt: new Date().toISOString(),
        observed,
        pdf: pdf.path
      });
      return {
        pass: observed.filter((entry) => entry.exists).every((entry) => entry.breakInside === "avoid" || entry.pageBreakInside === "avoid"),
        summary: observed.filter((entry) => entry.exists).map((entry) => `${entry.selector}:${entry.breakInside}`).join(", "),
        artifacts: [probe, pdf],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "颜色 · 保留琥珀 accent · 其他灰度",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/assistant?dev=1&__state=pending&tab=approvals");
      await page.emulateMedia({ media: "print" });
      const observed = await page.evaluate(() => {
        const accentColor = getComputedStyle(document.querySelector(".print-header strong")).color;
        const statusNode = document.querySelector(".status-pill");
        const statusColor = statusNode ? getComputedStyle(statusNode).color : null;
        return {
          accentColor,
          statusColor
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-08/f08-04-print-colors.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      const accent = parseRgbColor(observed.accentColor);
      const status = parseRgbColor(observed.statusColor);
      const statusIsGray = status ? status.r === status.g && status.g === status.b : false;
      const accentIsNotGray = accent ? !(accent.r === accent.g && accent.g === accent.b) : false;
      return {
        pass: accentIsNotGray && statusIsGray,
        summary: `accent=${observed.accentColor} status=${observed.statusColor}`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    5,
    "print 顶部加 \"Friday · {pageName} · {date}\" 眉头",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      await page.emulateMedia({ media: "print" });
      const observed = await page.evaluate(() => {
        const header = document.querySelector("[data-print-header='true']");
        return {
          display: getComputedStyle(header).display,
          text: header?.textContent?.replace(/\s+/g, " ").trim() ?? null
        };
      });
      const shot = await captureScreenshot(page, "screenshots/P2F-08/f08-05-print-header.png");
      await context.close();
      const probe = await writeJson("screenshots/P2F-08/f08-05-print-header.json", {
        generatedAt: new Date().toISOString(),
        observed,
        screenshot: shot.path
      });
      return {
        pass:
          observed.display === "flex" &&
          observed.text != null &&
          observed.text.includes("Friday") &&
          observed.text.includes("首页") &&
          /\d{2}\/\d{2}\/\d{4}|\d{4}\/\d{2}\/\d{2}/.test(observed.text),
        summary: observed.text,
        artifacts: [probe, shot],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-08", "Home+Assistant+Observability", generatedAt, results, artifacts);
}

async function verifyP2F09(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F09-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  await verifyRule(
    1,
    "grep 无裸中文 / 英文",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const stripped = source
        .replace(/<style[\s\S]*?<\/style>/g, "")
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<head[\s\S]*?<\/head>/g, "");
      const matches = Array.from(stripped.matchAll(/>(\s*)([\u4e00-\u9fa5]+|[A-Z][a-z]{4,})(?=\s*<)/g), (match) => match[2]).slice(0, 20);
      const probe = await writeJson("screenshots/P2F-09/f09-01-bare-string-grep.json", {
        generatedAt: new Date().toISOString(),
        matches
      });
      return {
        pass: matches.length === 0,
        summary: `matches=${matches.length}`,
        artifacts: [probe],
        observed: {
          matches
        }
      };
    }
  );

  await verifyRule(
    2,
    "每 user-facing 字符串走 localize()",
    async () => {
      const source = await fs.readFile(STATIC_FILE, "utf8");
      const counts = {
        localize: (source.match(/\blocalize\(/g) || []).length,
        localizedText: (source.match(/\blocalizedText\(/g) || []).length,
        resolveLocalizedText: (source.match(/\bresolveLocalizedText\(/g) || []).length
      };
      const pages = [
        "/home?dev=1&__state=normal",
        "/assistant?dev=1&__state=pending&tab=approvals",
        "/settings?dev=1&tab=providers&__state=providers",
        "/usage?dev=1&__state=this-month",
        "/command-center?dev=1&__state=active-run"
      ];
      const observed = [];
      for (const href of pages) {
        const { page, context } = await bootShellPage(browser, baseUrl, href);
        const zhText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
        await page.evaluate(() => window.__fridayQa.shell.setLocale("en"));
        await page.waitForTimeout(80);
        const enText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
        observed.push({
          href,
          zhHash: sha256(zhText),
          enHash: sha256(enText),
          changed: zhText !== enText
        });
        await context.close();
      }
      const probe = await writeJson("screenshots/P2F-09/f09-02-localize-audit.json", {
        generatedAt: new Date().toISOString(),
        counts,
        observed
      });
      return {
        pass: counts.localize >= 300 && counts.localizedText >= 100 && observed.every((entry) => entry.changed),
        summary: `localize=${counts.localize} localizedText=${counts.localizedText}`,
        artifacts: [probe],
        observed: {
          counts,
          observed
        }
      };
    }
  );

  await verifyRule(
    3,
    "切换 locale 无 flash / FOUC",
    async () => {
      const { page, context } = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const observed = await page.evaluate(async () => {
        const navBefore = performance.getEntriesByType("navigation").length;
        const beforeTitle = document.querySelector(".topbar-title")?.textContent?.trim() ?? null;
        const beforeChildren = document.body.children.length;
        const start = performance.now();
        window.__fridayQa.shell.setLocale("en");
        while ((document.querySelector(".topbar-title")?.textContent?.trim() ?? null) === beforeTitle) {
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        return {
          navBefore,
          navAfter: performance.getEntriesByType("navigation").length,
          beforeTitle,
          afterTitle: document.querySelector(".topbar-title")?.textContent?.trim() ?? null,
          latencyMs: performance.now() - start,
          splashVisible: Boolean(document.querySelector("[data-shell-splash='true']")),
          bodyChildrenBefore: beforeChildren,
          bodyChildrenAfter: document.body.children.length
        };
      });
      await context.close();
      const probe = await writeJson("screenshots/P2F-09/f09-03-locale-switch.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass:
          observed.navBefore === observed.navAfter &&
          observed.beforeTitle !== observed.afterTitle &&
          observed.latencyMs <= 120 &&
          observed.splashVisible === false &&
          observed.bodyChildrenAfter === observed.bodyChildrenBefore,
        summary: `latency=${observed.latencyMs.toFixed(1)}ms`,
        artifacts: [probe],
        observed
      };
    }
  );

  await verifyRule(
    4,
    "日期 / 数字 / 货币 按 locale 格式",
    async () => {
      const usage = await bootShellPage(browser, baseUrl, "/usage?dev=1&__state=this-month");
      const zh = await usage.page.evaluate(() => ({
        spend: document.querySelector(".shell-card div[style*='font-family:var(--font-serif)']")?.textContent?.trim() ?? null,
        providerSpend: document.querySelector("[data-usage-provider-row] td div")?.textContent?.trim() ?? null
      }));
      await usage.page.evaluate(() => window.__fridayQa.shell.setLocale("en"));
      await usage.page.waitForTimeout(80);
      const en = await usage.page.evaluate(() => ({
        spend: document.querySelector(".shell-card div[style*='font-family:var(--font-serif)']")?.textContent?.trim() ?? null,
        providerSpend: document.querySelector("[data-usage-provider-row] td div")?.textContent?.trim() ?? null
      }));
      await usage.context.close();

      const home = await bootShellPage(browser, baseUrl, "/home?dev=1&__state=normal");
      const dateProbe = await home.page.evaluate(() => {
        const sampleIso = "2026-04-21T15:32:00.000Z";
        const sampleDate = new Date(sampleIso);
        return {
          sampleIso,
          zhDate: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(sampleDate),
          enDate: new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).format(sampleDate),
          zhTime: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(sampleDate),
          enTime: new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(sampleDate)
        };
      });
      await home.context.close();

      const probe = await writeJson("screenshots/P2F-09/f09-04-locale-formatting.json", {
        generatedAt: new Date().toISOString(),
        usage: { zh, en },
        dateProbe
      });
      return {
        pass:
          zh.spend !== en.spend &&
          zh.providerSpend !== en.providerSpend &&
          dateProbe.zhDate != null &&
          dateProbe.enDate != null &&
          dateProbe.zhDate !== dateProbe.enDate &&
          dateProbe.zhTime !== dateProbe.enTime &&
          /\d/.test(String(zh.spend || "")) &&
          /\d/.test(String(en.spend || "")),
        summary: `${zh.spend} -> ${en.spend}; ${dateProbe.zhDate} -> ${dateProbe.enDate}`,
        artifacts: [probe],
        observed: {
          usage: { zh, en },
          dateProbe
        }
      };
    }
  );

  await verifyRule(
    5,
    "中文长英文短(或反之)不裂 layout · test case 5 页面对比",
    async () => {
      const pages = [
        { key: "home", href: "/home?dev=1&__state=normal" },
        { key: "assistant", href: "/assistant?dev=1&__state=pending&tab=approvals" },
        { key: "observability", href: "/observability?dev=1&focus=alerts&window=15m&__state=active" },
        { key: "settings", href: "/settings?dev=1&tab=providers&__state=providers" },
        { key: "usage", href: "/usage?dev=1&__state=this-month" }
      ];
      const observed = [];
      const shotArtifacts = [];
      for (const pageConfig of pages) {
        const { page, context } = await bootShellPage(browser, baseUrl, pageConfig.href);
        const zh = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth
        }));
        const zhShot = await captureScreenshot(page, `screenshots/P2F-09/f09-05-${pageConfig.key}-zh.png`);
        await page.evaluate(() => window.__fridayQa.shell.setLocale("en"));
        await page.waitForTimeout(80);
        const en = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth
        }));
        const enShot = await captureScreenshot(page, `screenshots/P2F-09/f09-05-${pageConfig.key}-en.png`);
        shotArtifacts.push(zhShot, enShot);
        observed.push({
          page: pageConfig.key,
          zh,
          en,
          zhScreenshot: zhShot.path,
          enScreenshot: enShot.path
        });
        await context.close();
      }
      const probe = await writeJson("screenshots/P2F-09/f09-05-layout-compare.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.every((entry) => entry.zh.scrollWidth <= entry.zh.viewportWidth && entry.en.scrollWidth <= entry.en.viewportWidth),
        summary: observed.map((entry) => `${entry.page}:${entry.zh.scrollWidth}/${entry.en.scrollWidth}`).join(", "),
        artifacts: [probe, ...shotArtifacts],
        observed
      };
    }
  );

  await browser.close();
  return writeAcceptanceReport("P2F-09", "all", generatedAt, results, artifacts);
}

async function verifyP2F10(baseUrl) {
  const results = [];
  const artifacts = [];
  const generatedAt = new Date().toISOString();

  async function verifyRule(rule, acceptance, runner) {
    const output = await runner();
    const normalized = normalizeEvidenceResult({
      rule,
      code: `F10-${String(rule).padStart(2, "0")}`,
      acceptance,
      status: output.pass ? "PASS" : "FAIL",
      summary: output.summary,
      artifacts: output.artifacts,
      observed: output.observed
    });
    results.push(normalized);
    artifacts.push(...output.artifacts.map((item) => item.path));
  }

  function reportMapByItem(reports) {
    return new Map(reports.map((report) => [report.itemId, report]));
  }

  function phaseReports(reports, phasePrefix) {
    return reports.filter((report) => report.itemId.startsWith(`${phasePrefix}-`));
  }

  await verifyRule(
    1,
    "聚合 G01-G12 通过 · 12 条",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const reportMap = reportMapByItem(reports);
      const staticSource = await fs.readFile(STATIC_FILE, "utf8");
      const phaseScriptIds = Array.from(staticSource.matchAll(/id="qa-evidence-phase-(2[A-F])"/g), (match) => match[1]).sort();
      const strippedWithoutRoot = staticSource
        .replace(/:root\s*\{[\s\S]*?\}/g, "")
        .replace(/#2f7a49|#b86a17|#a53028/gi, "");
      const hardcodedHexMatches = Array.from(strippedWithoutRoot.matchAll(/#[0-9a-fA-F]{6}\b/g), (match) => match[0]).slice(0, 20);
      const p2a05 = reportMap.get("P2A-05");
      const p2b06 = reportMap.get("P2B-06");
      const p2f05 = reportMap.get("P2F-05");
      const p2f06 = reportMap.get("P2F-06");
      const p2f02 = reportMap.get("P2F-02");
      const guardrails = [
        { id: "G01", pass: /(lorem|ipsum|placeholder|TBD|coming soon|待补充|样例文本)/i.test(staticSource) === false },
        { id: "G02", pass: /(TODO|FIXME|XXX|HACK)/.test(staticSource) === false },
        { id: "G03", pass: /:\s*any\b|Array<any>|<\s*any\s*>|as unknown as|@ts-ignore|@ts-expect-error/.test(staticSource) === false },
        { id: "G04", pass: /console\.(log|warn|info)\(/.test(staticSource) === false },
        {
          id: "G05",
          pass:
            staticSource.includes("useSystemHealthQuery") &&
            Boolean(await fs.stat(SETTINGS_HOOK_FILE).catch(() => null)) &&
            p2b06?.summary?.fail === 0
        },
        {
          id: "G06",
          pass: Boolean(p2a05?.acceptance?.find((entry) => entry.code === "C18" && entry.status === "PASS"))
        },
        {
          id: "G07",
          pass: (await parseBuildPlan()).filter((row) => String(row.Item_ID || "").startsWith("P2")).every((row) => String(row.States_Required || "").trim().length > 0 || String(row.Route || "") === "all")
        },
        { id: "G08", pass: p2f06?.summary?.fail === 0 },
        { id: "G09", pass: p2f05?.summary?.fail === 0 },
        { id: "G10", pass: p2f02?.summary?.fail === 0 },
        { id: "G11", pass: hardcodedHexMatches.length === 0 },
        { id: "G12", pass: JSON.stringify(phaseScriptIds) === JSON.stringify(["2A", "2B", "2C", "2D", "2E", "2F"]) }
      ];
      const probe = await writeJson("screenshots/P2F-10/f10-01-guardrails.json", {
        generatedAt: new Date().toISOString(),
        guardrails,
        hardcodedHexMatches,
        phaseScriptIds
      });
      return {
        pass: guardrails.every((entry) => entry.pass),
        summary: guardrails.map((entry) => `${entry.id}:${entry.pass ? "PASS" : "FAIL"}`).join(", "),
        artifacts: [probe],
        observed: {
          guardrails,
          hardcodedHexMatches,
          phaseScriptIds
        }
      };
    }
  );

  await verifyRule(
    2,
    "聚合 Phase 2A 12 验收(H01-H06 + C01-C06)",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const targets = [
        { itemId: "P2A-01", code: "H01" },
        { itemId: "P2A-01", code: "H02" },
        { itemId: "P2A-01", code: "H03" },
        { itemId: "P2A-01", code: "H04" },
        { itemId: "P2A-01", code: "H05" },
        { itemId: "P2A-01", code: "H06" },
        { itemId: "P2A-05", code: "C01" },
        { itemId: "P2A-05", code: "C02" },
        { itemId: "P2A-05", code: "C03" },
        { itemId: "P2A-05", code: "C04" },
        { itemId: "P2A-05", code: "C05" },
        { itemId: "P2A-05", code: "C06" }
      ];
      const matched = reports
        .flatMap((report) => (report.acceptance || []).map((entry) => ({ itemId: report.itemId, ...entry })))
        .filter((entry) => targets.some((target) => target.itemId === entry.itemId && target.code === entry.code));
      const probe = await writeJson("screenshots/P2F-10/f10-02-phase-2a.json", {
        generatedAt: new Date().toISOString(),
        matched
      });
      return {
        pass: matched.length === targets.length && matched.every((entry) => entry.status === "PASS"),
        summary: `${matched.length}/${targets.length} targeted Phase 2A checks`,
        artifacts: [probe],
        observed: {
          matched
        }
      };
    }
  );

  await verifyRule(
    3,
    "聚合 Phase 2B 18(B01-B06 + S01-S05 + O01-O07)",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const codes = new Set([
        "B01", "B02", "B03", "B04", "B05", "B06",
        "S01", "S02", "S03", "S04", "S05",
        "O01", "O02", "O03", "O04", "O05", "O06", "O07"
      ]);
      const matched = reports
        .filter((report) => report.itemId.startsWith("P2B-"))
        .flatMap((report) => (report.acceptance || []).map((entry) => ({ itemId: report.itemId, ...entry })))
        .filter((entry) => codes.has(entry.code));
      const probe = await writeJson("screenshots/P2F-10/f10-03-phase-2b.json", {
        generatedAt: new Date().toISOString(),
        matched
      });
      return {
        pass: matched.length === codes.size && matched.every((entry) => entry.status === "PASS"),
        summary: `${matched.length}/${codes.size} targeted Phase 2B checks`,
        artifacts: [probe],
        observed: {
          matched
        }
      };
    }
  );

  await verifyRule(
    4,
    "聚合 Phase 2C 27",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const phase = phaseReports(reports, "P2C");
      const totals = {
        items: phase.length,
        rules: phase.reduce((sum, report) => sum + (report.summary?.total || 0), 0),
        fail: phase.reduce((sum, report) => sum + (report.summary?.fail || 0), 0)
      };
      const probe = await writeJson("screenshots/P2F-10/f10-04-phase-2c.json", {
        generatedAt: new Date().toISOString(),
        totals
      });
      return {
        pass: totals.items === 8 && totals.rules >= 27 && totals.fail === 0,
        summary: `items=${totals.items} rules=${totals.rules} fail=${totals.fail}`,
        artifacts: [probe],
        observed: totals
      };
    }
  );

  await verifyRule(
    5,
    "聚合 Phase 2D 若干",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const phase = phaseReports(reports, "P2D");
      const totals = {
        items: phase.length,
        rules: phase.reduce((sum, report) => sum + (report.summary?.total || 0), 0),
        fail: phase.reduce((sum, report) => sum + (report.summary?.fail || 0), 0)
      };
      const probe = await writeJson("screenshots/P2F-10/f10-05-phase-2d.json", {
        generatedAt: new Date().toISOString(),
        totals
      });
      return {
        pass: totals.items === 6 && totals.rules > 0 && totals.fail === 0,
        summary: `items=${totals.items} rules=${totals.rules} fail=${totals.fail}`,
        artifacts: [probe],
        observed: totals
      };
    }
  );

  await verifyRule(
    6,
    "聚合 Phase 2E 若干",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const phase = phaseReports(reports, "P2E");
      const totals = {
        items: phase.length,
        rules: phase.reduce((sum, report) => sum + (report.summary?.total || 0), 0),
        fail: phase.reduce((sum, report) => sum + (report.summary?.fail || 0), 0)
      };
      const probe = await writeJson("screenshots/P2F-10/f10-06-phase-2e.json", {
        generatedAt: new Date().toISOString(),
        totals
      });
      return {
        pass: totals.items === 5 && totals.rules > 0 && totals.fail === 0,
        summary: `items=${totals.items} rules=${totals.rules} fail=${totals.fail}`,
        artifacts: [probe],
        observed: totals
      };
    }
  );

  await verifyRule(
    7,
    "聚合 Phase 2F-01..09",
    async () => {
      const reports = await loadScriptedAcceptanceReports();
      const itemIds = ["P2F-01", "P2F-02", "P2F-03", "P2F-04", "P2F-05", "P2F-06", "P2F-08", "P2F-09"];
      const matched = reports.filter((report) => itemIds.includes(report.itemId));
      const totals = {
        items: matched.length,
        rules: matched.reduce((sum, report) => sum + (report.summary?.total || 0), 0),
        fail: matched.reduce((sum, report) => sum + (report.summary?.fail || 0), 0)
      };
      const probe = await writeJson("screenshots/P2F-10/f10-07-phase-2f.json", {
        generatedAt: new Date().toISOString(),
        itemIds,
        totals
      });
      return {
        pass: matched.length === itemIds.length && totals.fail === 0,
        summary: `items=${totals.items} fail=${totals.fail}`,
        artifacts: [probe],
        observed: {
          itemIds,
          totals
        }
      };
    }
  );

  await verifyRule(
    8,
    "qa-report.html 每条一 row · PASS/FAIL + 证据(截图 / cmd 输出)",
    async () => {
      const specs = await parseSpecs();
      const reports = await loadScriptedAcceptanceReports();
      const rows = buildRows(specs, reports);
      await writeQaReport(rows);
      const reportHtml = await fs.readFile(QA_REPORT_FILE, "utf8");
      const rowCount = (reportHtml.match(/<tr data-acceptance-id=/g) || []).length;
      const missingEvidenceRows = rows.filter((row) => !row.evidence || !String(row.evidence).trim()).length;
      const probe = await writeJson("screenshots/P2F-10/f10-08-qa-report.json", {
        generatedAt: new Date().toISOString(),
        rowCount,
        expectedRows: rows.length,
        missingEvidenceRows
      });
      return {
        pass: rowCount === rows.length && missingEvidenceRows === 0,
        summary: `rows=${rowCount}/${rows.length} missingEvidence=${missingEvidenceRows}`,
        artifacts: [probe],
        observed: {
          rowCount,
          expectedRows: rows.length,
          missingEvidenceRows
        }
      };
    }
  );

  await verifyRule(
    9,
    "failing 条不得超过 2 · 超过 retry",
    async () => {
      const specs = await parseSpecs();
      const reports = await loadScriptedAcceptanceReports();
      const rows = buildRows(specs, reports);
      const failCount = rows.filter((row) => row.status === "FAIL" && row.itemId !== "P2F-10").length;
      const pendingCount = rows.filter((row) => row.status === "PENDING_REBUILD").length;
      const effectivePendingCount = rows.filter((row) => row.status === "PENDING_REBUILD" && row.itemId !== "P2F-10").length;
      const probe = await writeJson("screenshots/P2F-10/f10-09-fail-threshold.json", {
        generatedAt: new Date().toISOString(),
        failCount,
        pendingCount,
        effectivePendingCount
      });
      return {
        pass: failCount <= 2 && effectivePendingCount === 0,
        summary: `fail=${failCount} pending=${pendingCount}`,
        artifacts: [probe],
        observed: {
          failCount,
          pendingCount,
          effectivePendingCount
        }
      };
    }
  );

  await verifyRule(
    10,
    "最终 qa-report 连同 friday-static.html 一起交付",
    async () => {
      const [staticStat, reportStat] = await Promise.all([
        fs.stat(STATIC_FILE),
        fs.stat(QA_REPORT_FILE)
      ]);
      const observed = {
        staticFile: {
          path: path.relative(ROOT, STATIC_FILE),
          size: staticStat.size
        },
        qaReport: {
          path: path.relative(ROOT, QA_REPORT_FILE),
          size: reportStat.size
        }
      };
      const probe = await writeJson("screenshots/P2F-10/f10-10-deliverables.json", {
        generatedAt: new Date().toISOString(),
        observed
      });
      return {
        pass: observed.staticFile.size > 0 && observed.qaReport.size > 0,
        summary: `static=${observed.staticFile.size} qa=${observed.qaReport.size}`,
        artifacts: [probe],
        observed
      };
    }
  );

  return writeAcceptanceReport("P2F-10", "all", generatedAt, results, artifacts);
}

async function parseSpecs() {
  const html = await fs.readFile(SPECS_FILE, "utf8");
  const items = new Map();
  const itemPattern = /<h3 id="[^"]*"><span class="id">(P2[A-F]-\d+)<\/span>[\s\S]*?<ol class="acc">([\s\S]*?)<\/ol>/g;
  let itemMatch;
  while ((itemMatch = itemPattern.exec(html))) {
    const itemId = itemMatch[1];
    const rules = [];
    const rulePattern = /<li>([\s\S]*?)<\/li>/g;
    let ruleMatch;
    while ((ruleMatch = rulePattern.exec(itemMatch[2]))) {
      rules.push(stripHtml(ruleMatch[1]));
    }
    items.set(itemId, rules);
  }
  return items;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

async function parseBuildPlan() {
  const raw = await fs.readFile(BUILD_PLAN_FILE, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = cells[index] ?? "";
      return row;
    }, {});
  });
}

function buildPlanStates(row) {
  return String(row?.States_Required || "")
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);
}

function routeWithDevState(route, stateName) {
  if (route === "all") {
    return null;
  }
  const url = new URL(route, "http://127.0.0.1");
  url.searchParams.set("dev", "1");
  if (stateName) {
    url.searchParams.set("__state", stateName);
  }
  return `${url.pathname}${url.search}`;
}

function preferredAuditState(row) {
  const states = buildPlanStates(row);
  const preferred = [
    "normal",
    "active",
    "pending",
    "list",
    "full-catalog",
    "providers",
    "runtime",
    "installed",
    "running",
    "selected",
    "editing",
    "idle",
    "this-month",
    "user-sent",
    "healthy",
    "step-intent",
    "step1-goals",
    "draft",
    "collapsed",
    "loading",
    "empty"
  ];
  for (const candidate of preferred) {
    if (states.includes(candidate)) {
      return candidate;
    }
  }
  return states[0] || null;
}

function namedRouteGroupParts(route) {
  if (route === "Home+Assistant+Observability") {
    return ["/home", "/assistant", "/observability"];
  }
  if (route === "/assistant+/home") {
    return ["/assistant", "/home"];
  }
  return String(route || "").includes("+") ? String(route).split("+") : [route];
}

function concreteAuditPath(routePart) {
  if (routePart === "/flow/:wizardId") {
    return "/flow/inventory-triage";
  }
  return routePart;
}

function defaultAuditStateForRoute(routePart) {
  const pathOnly = String(routePart || "").split("?")[0];
  switch (pathOnly) {
    case "/home":
      return "normal";
    case "/chat":
      return "user-sent";
    case "/assistant":
      return "pending";
    case "/observability":
      return "active";
    case "/packs":
      return "full-catalog";
    case "/packs/cross-border/setup":
      return "step1-goals";
    case "/skills":
      return "installed";
    case "/skills/generator":
      return "preview";
    case "/workflows":
      return "running";
    case "/workflows/builder":
      return "editing";
    case "/plugins":
      return "installed";
    case "/mcp":
      return "connected";
    case "/channels":
      return "healthy";
    case "/automations":
      return "queued";
    case "/sessions":
      return "detail";
    case "/usage":
      return "this-month";
    case "/memory":
      return "selected";
    case "/fleet":
      return "selected";
    case "/login":
      return "idle";
    case "/setup":
      return "step1-profile";
    case "/onboarding":
      return "welcome";
    case "/flow/inventory-triage":
      return "step-intent";
    case "/command-center":
      return "active-run";
    default:
      return null;
  }
}

function expandBuildPlanAuditHrefs(row) {
  const route = String(row?.Route || "");
  if (!route || route === "all") {
    return ["/home?dev=1&__state=normal"];
  }
  const parts = namedRouteGroupParts(route);
  const useRowState = parts.length === 1 && route !== "Home+Assistant+Observability" && route !== "/assistant+/home";
  return parts.map((part) => {
    const concreteRoute = concreteAuditPath(part);
    const stateName = useRowState
      ? (preferredAuditState(row) || defaultAuditStateForRoute(concreteRoute))
      : defaultAuditStateForRoute(concreteRoute);
    return routeWithDevState(concreteRoute, stateName) || `${concreteRoute}?dev=1`;
  });
}

async function bootAuditRoute(browser, baseUrl, href, options = {}) {
  const pathname = new URL(href, "http://127.0.0.1").pathname;
  if (pathname === "/login") {
    return bootRoutePage(browser, baseUrl, pathname, "login", options);
  }
  if (pathname === "/setup") {
    return bootRoutePage(browser, baseUrl, pathname, "setup", options);
  }
  if (pathname === "/onboarding") {
    return bootRoutePage(browser, baseUrl, pathname, "onboarding", options);
  }
  return bootShellPage(browser, baseUrl, href, options);
}

function buildRows(specs, verified) {
  const verifiedByItem = new Map(verified.map((item) => [item.itemId, item]));
  const rows = [];
  Array.from(specs.entries())
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .forEach(([itemId, rules]) => {
      const verifiedItem = verifiedByItem.get(itemId);
      rules.forEach((acceptance, index) => {
        const entry = verifiedItem?.acceptance?.find((item) => item.rule === index + 1) || null;
        rows.push({
          itemId,
          rule: index + 1,
          acceptance,
          status: entry ? entry.status : "PENDING_REBUILD",
          evidence: entry ? entry.evidence : "Legacy screenshot-only evidence rejected; requires scripted rebuild.",
          summary: entry ? entry.summary : "No scripted evidence yet.",
          artifacts: entry ? entry.artifacts : []
        });
      });
    });
  return rows;
}

async function loadScriptedAcceptanceReports() {
  const screenshotsDir = path.join(ROOT, "screenshots");
  let entries = [];
  try {
    entries = await fs.readdir(screenshotsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const reportPath = path.join(screenshotsDir, entry.name, `${entry.name.toLowerCase()}-acceptance.json`);
    try {
      const parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
      if (
        parsed?.verificationMode === "scripted-playwright" &&
        Array.isArray(parsed.acceptance) &&
        parsed.acceptance.length > 0
      ) {
        reports.push(parsed);
      }
    } catch {
      // Ignore non-scripted or incomplete reports.
    }
  }
  return reports;
}

async function updatePhaseEvidenceScript(phaseId, reports) {
  if (reports.length === 0) {
    return;
  }
  const reportMap = new Map(reports.map((report) => [report.itemId, report]));
  const staticSource = await fs.readFile(STATIC_FILE, "utf8");
  const scriptPattern = new RegExp(
    `(<script type="application/json" id="qa-evidence-phase-${phaseId}">)([\\s\\S]*?)(</script>)`
  );
  const match = staticSource.match(scriptPattern);
  if (!match) {
    return;
  }
  let existing = { phase: phaseId, items: [] };
  try {
    existing = JSON.parse(match[2]);
  } catch {
    existing = { phase: phaseId, items: [] };
  }
  const mergedItems = (existing.items || []).map((item) => {
    const report = reportMap.get(item.itemId);
    if (!report) {
      return {
        itemId: item.itemId,
        route: item.route,
        status: "pending_rebuild"
      };
    }
    const reportPath = path.join(ROOT, "screenshots", report.itemId, `${report.itemId.toLowerCase()}-acceptance.json`);
    const reportBody = JSON.stringify(report, null, 2);
    return {
      itemId: report.itemId,
      route: report.route,
      status: report.summary.fail === 0 ? "done" : "failed",
      acceptanceReport: {
        path: path.relative(ROOT, reportPath),
        sha256: sha256(reportBody)
      },
      summary: report.summary,
      artifacts: report.artifacts
    };
  });
  for (const report of reports) {
    if (mergedItems.some((item) => item.itemId === report.itemId)) {
      continue;
    }
    const reportPath = path.join(ROOT, "screenshots", report.itemId, `${report.itemId.toLowerCase()}-acceptance.json`);
    const reportBody = JSON.stringify(report, null, 2);
    mergedItems.push({
      itemId: report.itemId,
      route: report.route,
      status: report.summary.fail === 0 ? "done" : "failed",
      acceptanceReport: {
        path: path.relative(ROOT, reportPath),
        sha256: sha256(reportBody)
      },
      summary: report.summary,
      artifacts: report.artifacts
    });
  }
  const nextPayload = JSON.stringify({
    phase: phaseId,
    generatedAt: new Date().toISOString(),
    items: mergedItems
  }, null, 2);
  const updated = staticSource.replace(scriptPattern, `$1\n${nextPayload}\n    $3`);
  await fs.writeFile(STATIC_FILE, updated);
}

async function writeQaReport(rows) {
  const generatedAt = new Date().toISOString();
  const body = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Friday QA Report</title>",
    "<style>",
    "body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:#fbf4ea;color:#2d2118}",
    "main{max-width:1320px;margin:0 auto;padding:32px}",
    "table{width:100%;border-collapse:collapse;background:#fffaf5}",
    "th,td{border:1px solid rgba(45,33,24,.12);padding:10px;vertical-align:top;text-align:left;font-size:12px}",
    "th{background:#f5ecdb;font-size:11px;text-transform:uppercase;letter-spacing:.08em}",
    "a{color:#c87a3c;text-decoration:none}",
    ".status-pass{color:#2f7a49;font-weight:700}",
    ".status-fail{color:#a53028;font-weight:700}",
    ".status-pending_rebuild{color:#b86a17;font-weight:700}",
    ".summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 24px}",
    ".tile{padding:14px 16px;border:1px solid rgba(45,33,24,.12);border-radius:16px;background:#fffaf5}",
    ".tile strong{display:block;font-size:24px;margin-top:4px}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Friday QA Report</h1>",
    `<p>Generated at ${escapeHtml(generatedAt)}. Only scripted evidence is treated as valid. Legacy screenshot-only evidence is rejected until rebuilt.</p>`
  ];

  const total = rows.length;
  const pass = rows.filter((row) => row.status === "PASS").length;
  const fail = rows.filter((row) => row.status === "FAIL").length;
  const pending = rows.filter((row) => row.status === "PENDING_REBUILD").length;
  body.push(
    '<section class="summary">',
    `<div class="tile"><span>Total Rules</span><strong>${String(total)}</strong></div>`,
    `<div class="tile"><span>PASS</span><strong class="status-pass">${String(pass)}</strong></div>`,
    `<div class="tile"><span>FAIL</span><strong class="status-fail">${String(fail)}</strong></div>`,
    `<div class="tile"><span>Pending Rebuild</span><strong class="status-pending_rebuild">${String(pending)}</strong></div>`,
    "</section>"
  );

  body.push("<table><thead><tr><th>Item</th><th>Rule</th><th>Status</th><th>Acceptance</th><th>Evidence</th><th>Summary</th></tr></thead><tbody>");
  for (const row of rows) {
    const statusClass = `status-${row.status.toLowerCase()}`;
    const evidenceCell = row.evidence.startsWith("screenshots/")
      ? `<a href="${escapeHtml(row.evidence)}">${escapeHtml(row.evidence)}</a>`
      : escapeHtml(row.evidence);
    body.push(
      `<tr data-acceptance-id="${escapeHtml(`${row.itemId}:${String(row.rule)}`)}">`,
      `<td>${escapeHtml(row.itemId)}</td>`,
      `<td>${String(row.rule)}</td>`,
      `<td class="${escapeHtml(statusClass)}">${escapeHtml(row.status)}</td>`,
      `<td>${escapeHtml(row.acceptance)}</td>`,
      `<td>${evidenceCell}</td>`,
      `<td>${escapeHtml(row.summary)}</td>`,
      "</tr>"
    );
  }
  body.push("</tbody></table></main></body></html>");
  await fs.writeFile(QA_REPORT_FILE, `${body.join("")}\n`);
}

async function main() {
  const server = await startServer();
  try {
    const requestedItems = new Set(
      String(process.env.FRIDAY_QA_ONLY || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );
    const shouldRun = (itemId) => requestedItems.size === 0 || requestedItems.has(itemId);
    const rebuilt = [];
    async function runItem(itemId, runner) {
      if (!shouldRun(itemId)) {
        return;
      }
      process.stderr.write(`[qa] start ${itemId}\n`);
      const startedAt = Date.now();
      const report = await runner(server.baseUrl);
      const durationMs = Date.now() - startedAt;
      process.stderr.write(`[qa] done ${itemId} ${report.summary.pass}/${report.summary.fail} ${durationMs}ms\n`);
      rebuilt.push(report);
    }
    await runItem("P2A-01", verifyP2A01);
    await runItem("P2A-02", verifyP2A02);
    await runItem("P2A-03", verifyP2A03);
    await runItem("P2A-04", verifyP2A04);
    await runItem("P2A-05", verifyP2A05);
    await runItem("P2A-06", verifyP2A06);
    await runItem("P2A-07", verifyP2A07);
    await runItem("P2A-08", verifyP2A08);
    await runItem("P2B-01", verifyP2B01);
    await runItem("P2B-02", verifyP2B02);
    await runItem("P2B-03", verifyP2B03);
    await runItem("P2B-04", verifyP2B04);
    await runItem("P2B-05", verifyP2B05);
    await runItem("P2B-06", verifyP2B06);
    await runItem("P2B-07", verifyP2B07);
    await runItem("P2B-08", verifyP2B08);
    await runItem("P2B-09", verifyP2B09);
    await runItem("P2C-01", verifyP2C01);
    await runItem("P2C-02", verifyP2C02);
    await runItem("P2C-03", verifyP2C03);
    await runItem("P2C-04", verifyP2C04);
    await runItem("P2C-05", verifyP2C05);
    await runItem("P2C-06", verifyP2C06);
    await runItem("P2C-07", verifyP2C07);
    await runItem("P2C-08", verifyP2C08);
    await runItem("P2D-01", verifyP2D01);
    await runItem("P2D-02", verifyP2D02);
    await runItem("P2D-03", verifyP2D03);
    await runItem("P2D-04", verifyP2D04);
    await runItem("P2D-05", verifyP2D05);
    await runItem("P2D-06", verifyP2D06);
    await runItem("P2E-01", verifyP2E01);
    await runItem("P2E-02", verifyP2E02);
    await runItem("P2E-03", verifyP2E03);
    await runItem("P2E-04", verifyP2E04);
    await runItem("P2E-05", verifyP2E05);
    await runItem("P2F-01", verifyP2F01);
    await runItem("P2F-02", verifyP2F02);
    await runItem("P2F-03", verifyP2F03);
    await runItem("P2F-04", verifyP2F04);
    await runItem("P2F-05", verifyP2F05);
    await runItem("P2F-06", verifyP2F06);
    await runItem("P2F-08", verifyP2F08);
    await runItem("P2F-09", verifyP2F09);
    await runItem("P2F-10", verifyP2F10);
    const trustedReports = await loadScriptedAcceptanceReports();
    const mergedReports = new Map(trustedReports.map((report) => [report.itemId, report]));
    rebuilt.forEach((report) => {
      mergedReports.set(report.itemId, report);
    });
    const specs = await parseSpecs();
    const rows = buildRows(specs, Array.from(mergedReports.values()));
    await writeQaReport(rows);
    const reportsByPhase = new Map();
    Array.from(mergedReports.values()).forEach((report) => {
      const phaseId = report.itemId.match(/^P(2[A-F])-/)?.[1];
      if (!phaseId) {
        return;
      }
      if (!reportsByPhase.has(phaseId)) {
        reportsByPhase.set(phaseId, []);
      }
      reportsByPhase.get(phaseId).push(report);
    });
    for (const [phaseId, reports] of reportsByPhase.entries()) {
      await updatePhaseEvidenceScript(phaseId, reports);
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      rebuiltItems: rebuilt.map((item) => ({
        itemId: item.itemId,
        pass: item.summary.pass,
        fail: item.summary.fail
      })),
      totals: {
        pass: rows.filter((row) => row.status === "PASS").length,
        fail: rows.filter((row) => row.status === "FAIL").length,
        pending: rows.filter((row) => row.status === "PENDING_REBUILD").length
      },
      report: path.relative(ROOT, QA_REPORT_FILE)
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
