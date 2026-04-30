import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayMockBrowserE2eEnv,
  type FridayMockBrowserE2eEnv,
  type FridayBrowserPageHandle,
} from "./_helpers/browser-env-mock.js";
import { seedDefaultCustomPack } from "./_helpers/custom-pack.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch { return false; }
})();

const CLOSEOUT_TIMEOUT_MS = 300_000;

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: {
    code?: string;
    message?: string;
  };
}

async function waitForTestId(pageHandle: FridayBrowserPageHandle, testId: string): Promise<void> {
  await pageHandle.page.waitForFunction(
    (expectedTestId) => Boolean(document.querySelector(`[data-testid="${expectedTestId}"]`)),
    testId,
  );
}

function initRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Friday Test"], { cwd: root });
}

async function executeTemplate<T>(
  env: FridayMockBrowserE2eEnv,
  templateId: string,
  parameters: Record<string, unknown>,
): Promise<{ status: number; json: ApiEnvelope<T> }> {
  return env.apiFetch<T>(
    "POST",
    `/v1/uix/templates/${encodeURIComponent(templateId)}/execute`,
    { parameters },
  );
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday starter skills closeout (mock hub browser E2E)", () => {
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

  it("keeps starter templates discoverable while the new task-first entry surfaces render", { timeout: CLOSEOUT_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    const packId = await seedDefaultCustomPack(env);

    const templates = await env.apiFetch<{
      templates: Array<{ id: string }>;
    }>("GET", "/v1/uix/templates");
    expect(templates.status).toBe(200);
    expect(templates.json.ok).toBe(true);
    const templateIds = new Set(templates.json.data.templates.map((template) => template.id));
    for (const templateId of [
      "idea-clarifier",
      "implementation-plan-review",
      "browser-qa-report",
      "workspace-diff-review",
      "release-doc-sync",
      "page-benchmark-report",
      "release-canary-check",
      "engineering-retro",
      "product-scope-review",
      "design-plan-review",
      "security-review",
      "browser-qa-fix",
    ]) {
      expect(templateIds.has(templateId)).toBe(true);
    }

    const skills = await env.apiFetch<{
      items: Array<{ skillId: string; starter?: boolean }>;
    }>("GET", "/v1/skills");
    expect(skills.status).toBe(200);
    expect(skills.json.ok).toBe(true);
    const skillIds = new Set(skills.json.data.items.map((item) => item.skillId));
    for (const skillId of [
      "idea-clarifier",
      "implementation-plan-review",
      "browser-qa-report",
      "workspace-diff-review",
      "release-doc-sync",
      "page-benchmark-report",
      "release-canary-check",
      "engineering-retro",
      "product-scope-review",
      "design-plan-review",
      "security-review",
      "browser-qa-fix",
    ]) {
      expect(skillIds.has(skillId)).toBe(true);
    }

    const benchmarkIntent = await env.apiFetch<{
      suggestedTemplateIds: string[];
    }>("POST", "/v1/uix/intents/resolve", {
      text: "Benchmark this page before I ship it",
    });
    expect(benchmarkIntent.status).toBe(200);
    expect(benchmarkIntent.json.ok).toBe(true);
    expect(benchmarkIntent.json.data.suggestedTemplateIds).toEqual([
      "page-benchmark-report",
      "release-canary-check",
    ]);

    const securityIntent = await env.apiFetch<{
      suggestedTemplateIds: string[];
    }>("POST", "/v1/uix/intents/resolve", {
      text: "Run a security review on auth and token safety",
    });
    expect(securityIntent.status).toBe(200);
    expect(securityIntent.json.ok).toBe(true);
    expect(securityIntent.json.data.suggestedTemplateIds).toEqual([
      "security-review",
      "workspace-diff-review",
    ]);

    pageHandle = await env.newPage();
    await pageHandle.page.goto("/chat");
    await waitForTestId(pageHandle, "chat-task-input");
    expect(await pageHandle.page.locator('[data-testid="assistant-goal-input"]').count()).toBe(0);

    await pageHandle.page.goto("/assistant");
    await waitForTestId(pageHandle, "assistant-inbox");
    expect(await pageHandle.page.locator('[data-testid="assistant-goal-input"]').count()).toBe(0);

    await pageHandle.page.goto("/packs");
    await waitForTestId(pageHandle, `pack-card-${packId}`);
    expect(await pageHandle.page.locator('[data-testid="pack-card-industry-creator-media"]').count()).toBe(0);
    expect(await pageHandle.page.locator('[data-testid="pack-card-task-build-new"]').count()).toBe(0);

    await pageHandle.page.goto("/skills?skillId=page-benchmark-report");
    await pageHandle.page.waitForFunction(
      (expectedSkillName) => document.body.textContent?.includes(expectedSkillName) ?? false,
      "Page Benchmark Report",
    );
    const skillsText = await pageHandle.page.textContent("body");
    expect(skillsText).toContain("Current skills");
    expect(skillsText).toContain("Page Benchmark Report");
    expect(skillsText).toContain("Security Review");
  });

  it("executes representative starter templates end-to-end through the UIX API", { timeout: CLOSEOUT_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    const repoRoot = path.join(env.hubEnv.stateDir, "closeout-repo");
    const liveUrl = `${env.baseUrl}/assistant`;
    fs.mkdirSync(repoRoot, { recursive: true });
    initRepo(repoRoot);
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "docs", "reference"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Closeout Repo\n\n## Latest Updates (2026-03-24)\n");
    fs.writeFileSync(path.join(repoRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    fs.writeFileSync(path.join(repoRoot, "docs", "reference", "ARCHITECTURE.md"), "# Closeout Architecture\n");
    fs.writeFileSync(path.join(repoRoot, "index.html"), "<html><head><title>Vite App</title></head><body>Closeout</body></html>\n");
    fs.writeFileSync(
      path.join(repoRoot, "src", "security.ts"),
      [
        "const proxy = req.headers['x-forwarded-for'];",
        "const remote = req.socket.remoteAddress;",
        "const token = 'ghp_1234567890abcdef1234567890';",
        "exec('echo hi');",
      ].join("\n"),
    );
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, "src", "feature.ts"), "export const changed = true;\n");

    const idea = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: Record<string, unknown> } };
    }>(env, "idea-clarifier", {
      goal: "Clarify the first milestone for a launch review assistant.",
    });
    expect(idea.status).toBe(200);
    expect(idea.json.ok).toBe(true);
    expect(idea.json.data.result.skillId).toBe("idea-clarifier");

    const planReview = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { missingAreas?: string[] } } };
    }>(env, "implementation-plan-review", {
      goal: "Architecture: add a launch review route with tests, rollback notes, and observability coverage.",
    });
    expect(planReview.status).toBe(200);
    expect(planReview.json.ok).toBe(true);
    expect(planReview.json.data.result.skillId).toBe("implementation-plan-review");

    const diffReview = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { changedFiles?: string[] } } };
    }>(env, "workspace-diff-review", {
      workspaceRoot: repoRoot,
    });
    expect(diffReview.status).toBe(200);
    expect(diffReview.json.ok).toBe(true);
    expect(diffReview.json.data.result.skillId).toBe("workspace-diff-review");
    expect((diffReview.json.data.result.output.details?.changedFiles ?? []).length).toBeGreaterThan(0);

    const releaseDocs = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { updatedFiles?: string[] } } };
    }>(env, "release-doc-sync", {
      workspaceRoot: repoRoot,
      goal: "Document the new launch review starter flows.",
    });
    expect(releaseDocs.status).toBe(200);
    expect(releaseDocs.json.ok).toBe(true);
    expect(releaseDocs.json.data.result.skillId).toBe("release-doc-sync");
    expect(fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")).toContain("friday-release-doc-sync:start");

    const retro = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { reportPath?: string } } };
    }>(env, "engineering-retro", {
      workspaceRoot: repoRoot,
      sinceDays: "7",
    });
    expect(retro.status).toBe(200);
    expect(retro.json.ok).toBe(true);
    expect(retro.json.data.result.skillId).toBe("engineering-retro");
    expect(fs.existsSync(String(retro.json.data.result.output.details?.reportPath))).toBe(true);

    const scopeReview = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { recommendations?: string[] } } };
    }>(env, "product-scope-review", {
      goal: "Review whether this all-in-one launch review suite should be narrowed to one operator workflow first.",
    });
    expect(scopeReview.status).toBe(200);
    expect(scopeReview.json.ok).toBe(true);
    expect(scopeReview.json.data.result.skillId).toBe("product-scope-review");

    const designReview = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { recommendations?: string[] } } };
    }>(env, "design-plan-review", {
      goal: "Review this route plan for mobile and desktop, but loading and error states are still missing.",
    });
    expect(designReview.status).toBe(200);
    expect(designReview.json.ok).toBe(true);
    expect(designReview.json.data.result.skillId).toBe("design-plan-review");

    const security = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { reportPath?: string } } };
    }>(env, "security-review", {
      workspaceRoot: repoRoot,
      goal: "Audit token handling and proxy trust.",
    });
    expect(security.status).toBe(200);
    expect(security.json.ok).toBe(true);
    expect(security.json.data.result.skillId).toBe("security-review");
    expect(fs.existsSync(String(security.json.data.result.output.details?.reportPath))).toBe(true);

    const browserQa = await executeTemplate<{
      summary: string;
      result: { skillId: string; output: { details?: { screenshotPath?: string | null } } };
    }>(env, "browser-qa-report", {
      workspaceRoot: repoRoot,
      url: liveUrl,
    });
    expect(browserQa.status).toBe(200);
    expect(browserQa.json.ok).toBe(true);
    expect(browserQa.json.data.result.skillId).toBe("browser-qa-report");
    expect(typeof browserQa.json.data.result.output.details?.screenshotPath).toBe("string");

    const benchmark = await executeTemplate<{
      summary: string;
      result: {
        skillId: string;
        output: {
          details?: {
            runPath?: string;
            baselinePath?: string;
          };
        };
      };
    }>(env, "page-benchmark-report", {
      workspaceRoot: repoRoot,
      url: liveUrl,
      repeats: 2,
    });
    expect([200, 422]).toContain(benchmark.status);
    if (benchmark.status === 200) {
      expect(benchmark.json.ok).toBe(true);
      expect(benchmark.json.data.result.skillId).toBe("page-benchmark-report");
      expect(fs.existsSync(String(benchmark.json.data.result.output.details?.runPath))).toBe(true);
      expect(fs.existsSync(String(benchmark.json.data.result.output.details?.baselinePath))).toBe(true);
    } else {
      expect(benchmark.json.ok).toBe(false);
      expect((benchmark.json.error?.message ?? "").length).toBeGreaterThan(0);
    }

    const canary = await executeTemplate<{
      summary: string;
      result: {
        skillId: string;
        output: {
          details?: {
            pages?: Array<{ runPath?: string }>;
          };
        };
      };
    }>(env, "release-canary-check", {
      workspaceRoot: repoRoot,
      url: liveUrl,
      expectedText: "Friday",
    });
    expect(canary.status).toBe(200);
    expect(canary.json.ok).toBe(true);
    expect(canary.json.data.result.skillId).toBe("release-canary-check");
    expect(fs.existsSync(String(canary.json.data.result.output.details?.pages?.[0]?.runPath))).toBe(true);

    const browserFix = await executeTemplate<{
      summary: string;
      result: {
        skillId: string;
        output: {
          details?: {
            reportPath?: string;
          };
        };
      };
    }>(env, "browser-qa-fix", {
      workspaceRoot: repoRoot,
      url: liveUrl,
      targetFile: "index.html",
      apply: true,
    });
    expect(browserFix.status).toBe(200);
    expect(browserFix.json.ok).toBe(true);
    expect(browserFix.json.data.result.skillId).toBe("browser-qa-fix");
  });
});
