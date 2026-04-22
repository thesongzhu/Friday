import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFridayMockBrowserE2eEnv,
  type FridayMockBrowserE2eEnv,
  type FridayBrowserPageHandle,
} from "./_helpers/browser-env-mock.js";
import {
  DEFAULT_BROWSER_CUSTOM_PACK_ID,
  seedDefaultCustomPack,
} from "./_helpers/custom-pack.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

const BROWSER_E2E_TIMEOUT_MS = 180_000;
const BLANK_DOCUMENT_EARLY_TIMEOUT_MS = 1_500;
const NAVIGATION_SAMPLES = process.env.CI ? 1 : 3;
const BUILDER_SAMPLES = process.env.CI ? 1 : 3;
const REPORT_DIR = path.resolve(process.cwd(), "artifacts/browser-benchmarks");
const REPORT_JSON = path.join(REPORT_DIR, "ui-surface-interaction-latest.json");
const REPORT_MD = path.join(REPORT_DIR, "ui-surface-interaction-latest.md");

interface NavBenchmarkResult {
  surface: "home" | "packs" | "assistant";
  samplesMs: number[];
  effectiveSamplesMs: number[];
  recoveredSamples: number;
  medianMs: number;
  medianEffectiveMs: number;
  maxMs: number;
  maxEffectiveMs: number;
}

interface BuilderBenchmarkResult {
  draftReadySamplesMs: number[];
  graphTransformedSamplesMs: number[];
  reactFlowMountedSamplesMs: number[];
  interactiveCanvasSamplesMs: number[];
  shellSamplesMs: number[];
  canvasSamplesMs: number[];
  medianDraftReadyMs: number;
  medianGraphTransformedMs: number;
  medianReactFlowMountedMs: number;
  medianInteractiveCanvasMs: number;
  medianShellMs: number;
  medianCanvasMs: number;
  maxCanvasMs: number;
}

async function waitForTestId(pageHandle: FridayBrowserPageHandle, testId: string): Promise<void> {
  await pageHandle.page.locator(`[data-testid="${testId}"]`).first().waitFor({ state: "visible", timeout: 60_000 });
}

type SurfaceId = "home" | "packs" | "assistant";

async function readSurfaceDiagnostics(pageHandle: FridayBrowserPageHandle) {
  return pageHandle.page.evaluate(() => {
    const bodyText = document.body.textContent?.trim() ?? "";
    const stored = window.sessionStorage.getItem("friday.client.stability.export.v1");
    let routeEvents: unknown[] = [];
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Array<{ type?: string; payload?: Record<string, unknown> }>;
        routeEvents = parsed
          .filter((entry) => entry.type === "route_transition_start" || entry.type === "route_transition_complete")
          .slice(-6);
      } catch {
        routeEvents = ["sessionStorage_parse_failed"];
      }
    }
    return {
      bodyLength: bodyText.length,
      appCrashed: bodyText.includes("Something went wrong"),
      routeEvents,
    };
  });
}

function isBlankDocumentDiagnostics(diagnostics: {
  bodyLength: number;
  appCrashed: boolean;
  routeEvents: unknown[];
}): boolean {
  return diagnostics.bodyLength === 0 && diagnostics.appCrashed === false && diagnostics.routeEvents.length === 0;
}

async function detectBlankDocumentEarly(pageHandle: FridayBrowserPageHandle): Promise<boolean> {
  try {
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      const stored = window.sessionStorage.getItem("friday.client.stability.export.v1");
      let routeEventsLength = 0;
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as Array<{ type?: string }>;
          routeEventsLength = parsed.filter((entry) => entry.type === "route_transition_start" || entry.type === "route_transition_complete").length;
        } catch {
          routeEventsLength = 1;
        }
      }
      return document.readyState !== "loading" && bodyText.length === 0 && routeEventsLength === 0;
    }, { timeout: BLANK_DOCUMENT_EARLY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function waitForSurfaceReadyOnce(pageHandle: FridayBrowserPageHandle, surface: SurfaceId): Promise<void> {
  switch (surface) {
    case "home":
      try {
        await pageHandle.page.locator('[data-testid="home-surface-ready"]').waitFor({ state: "visible", timeout: 15_000 });
        await pageHandle.page
          .locator('[data-testid="home-start-task"], [data-testid="home-browse-library"]')
          .first()
          .waitFor({ state: "visible", timeout: 15_000 });
        return;
      } catch {
        await pageHandle.page
          .locator('[data-testid="app-shell-rail"] a[href="/home"][aria-current="page"]')
          .first()
          .waitFor({ state: "visible", timeout: 45_000 });
        await pageHandle.page.waitForFunction(() => {
          const activeRailLink = document.querySelector('[data-testid="app-shell-rail"] a[href="/home"][aria-current="page"]');
          const bodyText = document.body.textContent?.trim() ?? "";
          const appCrashed = bodyText.includes("Something went wrong");
          return Boolean(activeRailLink) && !appCrashed && bodyText.length > 120;
        }, { timeout: 45_000 });
        return;
      }
    case "packs":
      await pageHandle.page.locator('[data-testid="packs-surface-ready"]').waitFor({ state: "visible", timeout: 60_000 });
      await pageHandle.page
        .locator(`[data-testid="pack-card-${DEFAULT_BROWSER_CUSTOM_PACK_ID}"], [data-testid="pack-open-${DEFAULT_BROWSER_CUSTOM_PACK_ID}"]`)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
      return;
    case "assistant":
      await pageHandle.page.locator('[data-testid="assistant-inbox"]').first().waitFor({ state: "visible", timeout: 60_000 });
      return;
  }
}

async function waitForSurfaceReady(
  pageHandle: FridayBrowserPageHandle,
  surface: SurfaceId,
): Promise<{ recovered: boolean; recoveryReadyMs: number | null }> {
  const readyPromise = waitForSurfaceReadyOnce(pageHandle, surface);
  const earlyOutcome = await Promise.race([
    readyPromise.then(() => "ready" as const).catch(() => "pending-error" as const),
    detectBlankDocumentEarly(pageHandle).then((blankDetected) => (blankDetected ? "blank" as const : "continue" as const)),
  ]);

  if (earlyOutcome === "ready") {
    return { recovered: false, recoveryReadyMs: null };
  }

  if (earlyOutcome === "blank") {
    const recoveryStartedAt = performance.now();
    await pageHandle.page.reload({ waitUntil: "domcontentloaded" });
    await waitForSurfaceReadyOnce(pageHandle, surface);
    return {
      recovered: true,
      recoveryReadyMs: performance.now() - recoveryStartedAt,
    };
  }

  try {
    await readyPromise;
    return { recovered: false, recoveryReadyMs: null };
  } catch {
    const diagnostics = await readSurfaceDiagnostics(pageHandle);
    if (Array.isArray(diagnostics.routeEvents) && isBlankDocumentDiagnostics(diagnostics)) {
      const recoveryStartedAt = performance.now();
      await pageHandle.page.reload({ waitUntil: "domcontentloaded" });
      try {
        await waitForSurfaceReadyOnce(pageHandle, surface);
        return {
          recovered: true,
          recoveryReadyMs: performance.now() - recoveryStartedAt,
        };
      } catch {
        const retryDiagnostics = await readSurfaceDiagnostics(pageHandle);
        throw new Error(`surface ${surface} did not become visible within 60000ms (url=${pageHandle.page.url()}, diagnostics=${JSON.stringify(retryDiagnostics)})`);
      }
    }

    throw new Error(`surface ${surface} did not become visible within 60000ms (url=${pageHandle.page.url()}, diagnostics=${JSON.stringify(diagnostics)})`);
  }
}

async function clickRailLink(pageHandle: FridayBrowserPageHandle, href: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const locator = pageHandle.page
    .locator(`[data-testid="app-shell-rail"] a[href="${href}"], nav a[href="${href}"]`)
    .first();
  while (Date.now() < deadline) {
    try {
      await locator.waitFor({ state: "visible", timeout: 2_000 });
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 2_000 });
      return;
    } catch {
      await pageHandle.page.waitForTimeout(200);
    }
  }

  throw new Error(`rail link not found for ${href} within 30000ms`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function measureRailNavigation(input: {
  env: FridayMockBrowserE2eEnv;
  startPath: string;
  startReadyTestId: string;
  clickHref: string;
  expectedPath: string;
  readyTestId: string;
  samples: number;
  surface: NavBenchmarkResult["surface"];
}): Promise<NavBenchmarkResult> {
  const samplesMs: number[] = [];
  const effectiveSamplesMs: number[] = [];
  let recoveredSamples = 0;
  for (let index = 0; index < input.samples; index += 1) {
    const pageHandle = await input.env.newPage();
    try {
      await pageHandle.page.goto(input.startPath);
      await waitForSurfaceReady(pageHandle, input.startReadyTestId as SurfaceId);
      const navigationCountBefore = await pageHandle.page.evaluate(
        () => window.performance.getEntriesByType("navigation").length,
      );

      const startedAt = performance.now();
      await clickRailLink(pageHandle, input.clickHref);
      await pageHandle.page.waitForURL(`**${input.expectedPath}`);
      const readyOutcome = await waitForSurfaceReady(pageHandle, input.readyTestId as SurfaceId);
      const elapsedMs = performance.now() - startedAt;
      const navigationCountAfter = await pageHandle.page.evaluate(
        () => window.performance.getEntriesByType("navigation").length,
      );

      expect(navigationCountAfter).toBe(navigationCountBefore);
      samplesMs.push(elapsedMs);
      effectiveSamplesMs.push(readyOutcome.recovered ? (readyOutcome.recoveryReadyMs ?? elapsedMs) : elapsedMs);
      recoveredSamples += readyOutcome.recovered ? 1 : 0;
    } finally {
      await pageHandle.close();
    }
  }

  return {
    surface: input.surface,
    samplesMs,
    effectiveSamplesMs,
    recoveredSamples,
    medianMs: median(samplesMs),
    medianEffectiveMs: median(effectiveSamplesMs),
    maxMs: Math.max(...samplesMs),
    maxEffectiveMs: Math.max(...effectiveSamplesMs),
  };
}

async function createBuilderDraft(env: FridayMockBrowserE2eEnv) {
  const templateList = await env.apiFetch<{
    items: Array<{ id?: string; templateId?: string }>;
    stableItems: Array<{ id: string }>;
  }>("GET", "/v1/workflow-builder/templates");
  expect(templateList.status).toBe(200);
  expect(templateList.json.ok).toBe(true);
  const templateId = templateList.json.data.stableItems[0]?.id
    ?? templateList.json.data.items[0]?.id
    ?? templateList.json.data.items[0]?.templateId;
  expect(templateId).toBeTruthy();

  const instantiate = await env.apiFetch<{
    draft: {
      workflowId: string;
      draftId: string;
    };
  }>("POST", `/v1/workflow-builder/templates/${encodeURIComponent(String(templateId))}/instantiate`, {
    workflowId: `benchmark-${Date.now()}`,
    title: "Workflow Benchmark Draft",
    ownerUserId: "browser-e2e",
    taskProfileId: "planning",
  });
  expect(instantiate.status).toBe(200);
  expect(instantiate.json.ok).toBe(true);
  return instantiate.json.data.draft;
}

async function measureBuilderNavigation(input: {
  env: FridayMockBrowserE2eEnv;
  pageHandle: FridayBrowserPageHandle;
  samples: number;
}): Promise<BuilderBenchmarkResult> {
  const draft = await createBuilderDraft(input.env);
  const draftReadySamplesMs: number[] = [];
  const graphTransformedSamplesMs: number[] = [];
  const reactFlowMountedSamplesMs: number[] = [];
  const interactiveCanvasSamplesMs: number[] = [];
  const shellSamplesMs: number[] = [];
  const canvasSamplesMs: number[] = [];

  for (let index = 0; index < input.samples; index += 1) {
    await input.pageHandle.page.goto("/home");
    await waitForSurfaceReady(input.pageHandle, "home");
    await input.pageHandle.page.evaluate(() => {
      window.performance.clearMarks("friday-workflow-builder-draft-data-ready");
      window.performance.clearMarks("friday-workflow-builder-graph-transform-start");
      window.performance.clearMarks("friday-workflow-builder-graph-transformed");
      window.performance.clearMarks("friday-workflow-builder-reactflow-mounted");
      window.performance.clearMarks("friday-workflow-builder-first-interactive-canvas");
      window.performance.clearMarks("friday-workflow-builder-shell-ready");
      window.performance.clearMarks("friday-workflow-builder-canvas-ready");
    });

    const startedAt = performance.now();
    await input.pageHandle.page.goto(`/workflows/builder?workflowId=${encodeURIComponent(draft.workflowId)}&draftId=${encodeURIComponent(draft.draftId)}`);
    await input.pageHandle.page.waitForFunction(() =>
      window.performance.getEntriesByName("friday-workflow-builder-draft-data-ready").length > 0
    );
    const draftReadyMs = performance.now() - startedAt;
    await input.pageHandle.page.waitForFunction(() =>
      window.performance.getEntriesByName("friday-workflow-builder-graph-transformed").length > 0
    );
    const graphTransformedMs = performance.now() - startedAt;
    await input.pageHandle.page.waitForFunction(() =>
      window.performance.getEntriesByName("friday-workflow-builder-shell-ready").length > 0
      || Boolean(document.querySelector('[data-testid="workflow-builder-node-library"]'))
    );
    const shellReadyMs = performance.now() - startedAt;
    await input.pageHandle.page.waitForFunction(() =>
      window.performance.getEntriesByName("friday-workflow-builder-reactflow-mounted").length > 0
    );
    const reactFlowMountedMs = performance.now() - startedAt;

    await input.pageHandle.page.waitForFunction(() =>
      window.performance.getEntriesByName("friday-workflow-builder-canvas-ready").length > 0
      && Boolean(document.querySelector('[data-testid="workflow-builder-canvas"]'))
    );
    const canvasReadyMs = performance.now() - startedAt;
    await input.pageHandle.page.waitForFunction(() =>
      window.performance.getEntriesByName("friday-workflow-builder-first-interactive-canvas").length > 0
    );
    const interactiveCanvasMs = performance.now() - startedAt;

    draftReadySamplesMs.push(draftReadyMs);
    graphTransformedSamplesMs.push(graphTransformedMs);
    reactFlowMountedSamplesMs.push(reactFlowMountedMs);
    interactiveCanvasSamplesMs.push(interactiveCanvasMs);
    shellSamplesMs.push(shellReadyMs);
    canvasSamplesMs.push(canvasReadyMs);
  }

  return {
    draftReadySamplesMs,
    graphTransformedSamplesMs,
    reactFlowMountedSamplesMs,
    interactiveCanvasSamplesMs,
    shellSamplesMs,
    canvasSamplesMs,
    medianDraftReadyMs: median(draftReadySamplesMs),
    medianGraphTransformedMs: median(graphTransformedSamplesMs),
    medianReactFlowMountedMs: median(reactFlowMountedSamplesMs),
    medianInteractiveCanvasMs: median(interactiveCanvasSamplesMs),
    medianShellMs: median(shellSamplesMs),
    medianCanvasMs: median(canvasSamplesMs),
    maxCanvasMs: Math.max(...canvasSamplesMs),
  };
}

function writeBenchmarkArtifacts(input: {
  generatedAt: string;
  home: NavBenchmarkResult;
  packs: NavBenchmarkResult;
  assistant: NavBenchmarkResult;
  builder: BuilderBenchmarkResult;
}) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const payload = {
    generatedAt: input.generatedAt,
    environment: {
      browser: "chromium",
      timezone: "America/Los_Angeles",
    },
    surfaces: {
      home: input.home,
      packs: input.packs,
      assistant: input.assistant,
      builder: input.builder,
    },
  };

  const markdown = [
    "# Friday UI Surface Interaction Benchmark",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Navigation Surfaces",
    "",
    "| Surface | Total samples (ms) | Effective samples (ms) | Recovered samples | Median effective (ms) | Max total (ms) |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    `| Home | ${input.home.samplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.home.effectiveSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.home.recoveredSamples} | ${input.home.medianEffectiveMs.toFixed(0)} | ${input.home.maxMs.toFixed(0)} |`,
    `| Packs | ${input.packs.samplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.packs.effectiveSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.packs.recoveredSamples} | ${input.packs.medianEffectiveMs.toFixed(0)} | ${input.packs.maxMs.toFixed(0)} |`,
    `| Assistant | ${input.assistant.samplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.assistant.effectiveSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.assistant.recoveredSamples} | ${input.assistant.medianEffectiveMs.toFixed(0)} | ${input.assistant.maxMs.toFixed(0)} |`,
    "",
    "## Workflow Builder",
    "",
    "| Metric | Samples (ms) | Median (ms) | Max (ms) |",
    "| --- | --- | ---: | ---: |",
    `| Builder draft data ready | ${input.builder.draftReadySamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.builder.medianDraftReadyMs.toFixed(0)} | ${Math.max(...input.builder.draftReadySamplesMs).toFixed(0)} |`,
    `| Builder graph transformed | ${input.builder.graphTransformedSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.builder.medianGraphTransformedMs.toFixed(0)} | ${Math.max(...input.builder.graphTransformedSamplesMs).toFixed(0)} |`,
    `| Builder shell ready | ${input.builder.shellSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.builder.medianShellMs.toFixed(0)} | ${Math.max(...input.builder.shellSamplesMs).toFixed(0)} |`,
    `| Builder React Flow mounted | ${input.builder.reactFlowMountedSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.builder.medianReactFlowMountedMs.toFixed(0)} | ${Math.max(...input.builder.reactFlowMountedSamplesMs).toFixed(0)} |`,
    `| Builder canvas ready | ${input.builder.canvasSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.builder.medianCanvasMs.toFixed(0)} | ${input.builder.maxCanvasMs.toFixed(0)} |`,
    `| Builder first interactive canvas | ${input.builder.interactiveCanvasSamplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.builder.medianInteractiveCanvasMs.toFixed(0)} | ${Math.max(...input.builder.interactiveCanvasSamplesMs).toFixed(0)} |`,
    "",
    "## Notes",
    "",
    "- Home / Packs / Assistant report both total navigation timing and an effective timing that isolates the final successful render after any one-time blank-document recovery.",
    "- Workflow Builder keeps the old shell-ready and canvas-ready metrics, but now also records draft-data, graph-transform, React Flow mount, and first-interactive milestones.",
    "- The report is meant to be rerun so interaction drift can be compared over time.",
    "",
  ].join("\n");

  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(REPORT_MD, markdown, "utf8");
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday UI surface interaction benchmark (mock hub browser E2E)", () => {
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

  it("records repeatable navigation timings for home, packs, assistant, and workflow builder", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    await seedDefaultCustomPack(env);
    const homeResult = await measureRailNavigation({
      env,
      startPath: "/packs",
      startReadyTestId: "packs",
      clickHref: "/home",
      expectedPath: "/home",
      readyTestId: "home",
      samples: NAVIGATION_SAMPLES,
      surface: "home",
    });
    const packsResult = await measureRailNavigation({
      env,
      startPath: "/home",
      startReadyTestId: "home",
      clickHref: "/packs",
      expectedPath: "/packs",
      readyTestId: "packs",
      samples: NAVIGATION_SAMPLES,
      surface: "packs",
    });
    const assistantResult = await measureRailNavigation({
      env,
      startPath: "/home",
      startReadyTestId: "home",
      clickHref: "/assistant",
      expectedPath: "/assistant",
      readyTestId: "assistant",
      samples: NAVIGATION_SAMPLES,
      surface: "assistant",
    });
    pageHandle = await env.newPage();
    const builderResult = await measureBuilderNavigation({
      env,
      pageHandle,
      samples: BUILDER_SAMPLES,
    });

    writeBenchmarkArtifacts({
      generatedAt: new Date().toISOString(),
      home: homeResult,
      packs: packsResult,
      assistant: assistantResult,
      builder: builderResult,
    });

    expect(homeResult.medianEffectiveMs).toBeLessThan(1_500);
    expect(packsResult.medianEffectiveMs).toBeLessThan(1_500);
    expect(assistantResult.medianEffectiveMs).toBeLessThan(1_500);
    expect(builderResult.medianShellMs).toBeLessThan(2_000);
    expect(builderResult.medianCanvasMs).toBeLessThan(8_000);
  });
});
