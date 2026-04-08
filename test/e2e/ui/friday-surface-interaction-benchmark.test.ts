import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFridayBrowserE2eEnv,
  type FridayBrowserE2eEnv,
  type FridayBrowserPageHandle,
} from "./_helpers/browser-env.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

const BROWSER_E2E_TIMEOUT_MS = 120_000;
const NAVIGATION_SAMPLES = process.env.CI ? 1 : 3;
const BUILDER_SAMPLES = process.env.CI ? 1 : 3;
const REPORT_DIR = path.resolve(process.cwd(), "artifacts/browser-benchmarks");
const REPORT_JSON = path.join(REPORT_DIR, "ui-surface-interaction-latest.json");
const REPORT_MD = path.join(REPORT_DIR, "ui-surface-interaction-latest.md");

interface NavBenchmarkResult {
  surface: "home" | "packs" | "assistant";
  samplesMs: number[];
  medianMs: number;
  maxMs: number;
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

async function waitForSurfaceReady(pageHandle: FridayBrowserPageHandle, surface: SurfaceId): Promise<void> {
  const candidates = (() => {
    switch (surface) {
      case "home":
        return [
          pageHandle.page.locator('[data-testid="home-surface-ready"]').first(),
          pageHandle.page.getByRole("button", { name: "Start A Task" }),
          pageHandle.page.getByRole("button", { name: "开始新任务" }),
        ];
      case "packs":
        return [
          pageHandle.page.locator('[data-testid="packs-surface-ready"]').first(),
          pageHandle.page.locator('[data-testid="pack-card-industry-creator-media"]').first(),
        ];
      case "assistant":
        return [
          pageHandle.page.locator('[data-testid="assistant-inbox"]').first(),
          pageHandle.page.locator('[data-testid="assistant-inbox-start-task"]').first(),
        ];
    }
  })();

  await Promise.any(
    candidates.map((locator) => locator.waitFor({ state: "visible", timeout: 60_000 })),
  );
}

async function clickRailLink(pageHandle: FridayBrowserPageHandle, href: string): Promise<void> {
  await pageHandle.page.waitForFunction(
    (targetHref) => {
      const link = document.querySelector(`[data-testid="app-shell-rail"] a[href="${targetHref}"]`);
      return link instanceof HTMLAnchorElement && link.isConnected;
    },
    href,
  );
  await pageHandle.page.evaluate((targetHref) => {
    const link = document.querySelector(`[data-testid="app-shell-rail"] a[href="${targetHref}"]`);
    if (!(link instanceof HTMLAnchorElement)) {
      throw new Error(`rail link not found for ${targetHref}`);
    }
    link.click();
  }, href);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function measureRailNavigation(input: {
  env: FridayBrowserE2eEnv;
  startPath: string;
  startReadyTestId: string;
  clickHref: string;
  expectedPath: string;
  readyTestId: string;
  samples: number;
  surface: NavBenchmarkResult["surface"];
}): Promise<NavBenchmarkResult> {
  const samplesMs: number[] = [];
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
      await waitForSurfaceReady(pageHandle, input.readyTestId as SurfaceId);
      const elapsedMs = performance.now() - startedAt;
      const navigationCountAfter = await pageHandle.page.evaluate(
        () => window.performance.getEntriesByType("navigation").length,
      );

      expect(navigationCountAfter).toBe(navigationCountBefore);
      samplesMs.push(elapsedMs);
    } finally {
      await pageHandle.close();
    }
  }

  return {
    surface: input.surface,
    samplesMs,
    medianMs: median(samplesMs),
    maxMs: Math.max(...samplesMs),
  };
}

async function createBuilderDraft(env: FridayBrowserE2eEnv) {
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
  env: FridayBrowserE2eEnv;
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
    "| Surface | Samples (ms) | Median (ms) | Max (ms) |",
    "| --- | --- | ---: | ---: |",
    `| Home | ${input.home.samplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.home.medianMs.toFixed(0)} | ${input.home.maxMs.toFixed(0)} |`,
    `| Packs | ${input.packs.samplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.packs.medianMs.toFixed(0)} | ${input.packs.maxMs.toFixed(0)} |`,
    `| Assistant | ${input.assistant.samplesMs.map((value) => value.toFixed(0)).join(", ")} | ${input.assistant.medianMs.toFixed(0)} | ${input.assistant.maxMs.toFixed(0)} |`,
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
    "- Home / Packs / Assistant are measured by actual left-rail clicks and wait for each surface's stable ready marker.",
    "- Workflow Builder keeps the old shell-ready and canvas-ready metrics, but now also records draft-data, graph-transform, React Flow mount, and first-interactive milestones.",
    "- The report is meant to be rerun so interaction drift can be compared over time.",
    "",
  ].join("\n");

  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(REPORT_MD, markdown, "utf8");
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday UI surface interaction benchmark", () => {
  let env: FridayBrowserE2eEnv | null = null;
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
    env = await createFridayBrowserE2eEnv();
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

    expect(homeResult.medianMs).toBeLessThan(1_500);
    expect(packsResult.medianMs).toBeLessThan(1_500);
    expect(assistantResult.medianMs).toBeLessThan(1_500);
    expect(builderResult.medianShellMs).toBeLessThan(2_000);
    expect(builderResult.medianCanvasMs).toBeLessThan(8_000);
  });
});
