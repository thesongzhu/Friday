import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFridayMockBrowserE2eEnv,
  type FridayMockBrowserE2eEnv,
  type FridayBrowserPageHandle,
} from "./_helpers/browser-env-mock.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

const BROWSER_E2E_TIMEOUT_MS = 120_000;
const WORKFLOW_BUILDER_LOCAL_SHELL_BUDGET_MS = 2_000;
const WORKFLOW_BUILDER_CANVAS_BUDGET_MS = 8_000;
const WORKFLOW_BUILDER_SHELL_BUDGET_MS = process.env.CI
  ? WORKFLOW_BUILDER_CANVAS_BUDGET_MS
  : WORKFLOW_BUILDER_LOCAL_SHELL_BUDGET_MS;
const MAIN_PUSH_CI_SHELL_READY_JITTER_MS = 6_251.996804;

async function readBuilderTiming(pageHandle: FridayBrowserPageHandle, markName: string): Promise<number | null> {
  return pageHandle.page.evaluate((expectedMarkName) => {
    const entries = window.performance.getEntriesByName(expectedMarkName);
    const latest = entries.at(-1);
    return typeof latest?.startTime === "number" ? latest.startTime : null;
  }, markName);
}

async function createWorkflowParent(env: FridayMockBrowserE2eEnv, name: string): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await env.apiFetch<{
    workflow: {
      id: string;
    };
  }>("POST", "/v1/workflows", {
    slug: `browser-e2e-${unique}`,
    name,
    tags: ["browser-e2e"],
    graph: { nodes: [], edges: [] },
  });
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.workflow.id;
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday workflow builder interaction baseline (mock hub browser E2E)", () => {
  let env: FridayMockBrowserE2eEnv | null = null;
  let pageHandle: FridayBrowserPageHandle | null = null;

  afterEach(async () => {
    if (pageHandle) {
      await pageHandle.close();
      pageHandle = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it("keeps the CI shell-ready budget above observed main push runner jitter", () => {
    if (!process.env.CI) {
      return;
    }

    expect(WORKFLOW_BUILDER_SHELL_BUDGET_MS).toBeGreaterThan(MAIN_PUSH_CI_SHELL_READY_JITTER_MS);
  });

  it("renders a lightweight builder shell before the full canvas becomes interactive", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    pageHandle = await env.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    pageHandle.page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    pageHandle.page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    const templates = await env.apiFetch<{
      items: Array<{ id: string }>;
      stableItems: Array<{ id: string }>;
    }>("GET", "/v1/workflow-builder/templates");
    expect(templates.status).toBe(200);
    expect(templates.json.ok).toBe(true);
    const templateId = templates.json.data.stableItems[0]?.id ?? templates.json.data.items[0]?.id;
    expect(templateId).toBeTruthy();

    const workflowId = await createWorkflowParent(env, "Browser E2E Draft");
    const instantiate = await env.apiFetch<{
      draft: {
        workflowId: string;
        draftId: string;
      };
    }>("POST", `/v1/workflow-builder/templates/${encodeURIComponent(String(templateId))}/instantiate`, {
      workflowId,
      title: "Browser E2E Draft",
      ownerUserId: "browser-e2e",
      taskProfileId: "planning",
    });
    expect(instantiate.status).toBe(200);
    expect(instantiate.json.ok).toBe(true);
    const draft = instantiate.json.data.draft;

    const startedAt = performance.now();
    await pageHandle.page.goto(`/workflows/builder?workflowId=${encodeURIComponent(draft.workflowId)}&draftId=${encodeURIComponent(draft.draftId)}`);
    await pageHandle.page.waitForLoadState("domcontentloaded");
    try {
      await pageHandle.page.waitForFunction(() =>
        window.performance.getEntriesByName("friday-workflow-builder-shell-ready").length > 0
        || Boolean(document.querySelector('[data-testid="workflow-builder-shell"]'))
        || Boolean(document.querySelector('[data-testid="workflow-builder-node-library"]'))
      );
    } catch (error) {
      const debugState = await pageHandle.page.evaluate(() => ({
        pathname: window.location.pathname,
        title: document.title,
        text: document.body.textContent?.slice(0, 400) ?? "",
      }));
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `pathname=${debugState.pathname}`,
          `title=${debugState.title}`,
          `text=${debugState.text}`,
          `pageErrors=${JSON.stringify(pageErrors)}`,
          `consoleErrors=${JSON.stringify(consoleErrors)}`,
        ].join("\n"),
      );
    }
    const shellReadyMs = await readBuilderTiming(pageHandle, "friday-workflow-builder-shell-ready")
      ?? performance.now() - startedAt;

    try {
      await pageHandle.page.waitForFunction(() =>
        window.performance.getEntriesByName("friday-workflow-builder-canvas-ready").length > 0
        && Boolean(document.querySelector('[data-testid="workflow-builder-canvas"]'))
      );
    } catch (error) {
      const debugState = await pageHandle.page.evaluate(() => ({
        pathname: window.location.pathname,
        search: window.location.search,
        title: document.title,
        text: document.body.textContent?.slice(0, 1200) ?? "",
        hasShell: Boolean(document.querySelector('[data-testid="workflow-builder-shell"]')),
        hasNodeLibrary: Boolean(document.querySelector('[data-testid="workflow-builder-node-library"]')),
        hasCanvas: Boolean(document.querySelector('[data-testid="workflow-builder-canvas"]')),
        localStorage: {
          accessToken: window.localStorage.getItem("friday.auth.accessToken"),
          refreshToken: window.localStorage.getItem("friday.auth.refreshToken"),
          user: window.localStorage.getItem("friday.auth.user"),
        },
      }));
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `pathname=${debugState.pathname}`,
          `search=${debugState.search}`,
          `title=${debugState.title}`,
          `hasShell=${debugState.hasShell}`,
          `hasNodeLibrary=${debugState.hasNodeLibrary}`,
          `hasCanvas=${debugState.hasCanvas}`,
          `text=${debugState.text}`,
          `localStorage=${JSON.stringify(debugState.localStorage)}`,
          `pageErrors=${JSON.stringify(pageErrors)}`,
          `consoleErrors=${JSON.stringify(consoleErrors)}`,
        ].join("\n"),
      );
    }
    const canvasReadyMs = await readBuilderTiming(pageHandle, "friday-workflow-builder-canvas-ready")
      ?? performance.now() - startedAt;

    const benchmark = await pageHandle.page.evaluate(() => ({
      hasNodeLibrary: Boolean(document.querySelector('[data-testid="workflow-builder-node-library"]')),
      hasCanvas: Boolean(document.querySelector('[data-testid="workflow-builder-canvas"]')),
      title: document.title,
    }));

    expect(benchmark.hasNodeLibrary).toBe(true);
    expect(benchmark.hasCanvas).toBe(true);
    expect(shellReadyMs).toBeLessThan(WORKFLOW_BUILDER_SHELL_BUDGET_MS);
    expect(canvasReadyMs).toBeLessThan(WORKFLOW_BUILDER_CANVAS_BUDGET_MS);
  });
});
