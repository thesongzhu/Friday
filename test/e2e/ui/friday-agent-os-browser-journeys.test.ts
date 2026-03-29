import * as fs from "node:fs";
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
  } catch { return false; }
})();

const BROWSER_E2E_TIMEOUT_MS = 120_000;

async function waitForAssistant(pageHandle: FridayBrowserPageHandle): Promise<void> {
  await pageHandle.page.goto("/assistant");
  await pageHandle.page.waitForSelector('[data-testid="assistant-goal-input"]');
}

async function waitForOutcomeAction(
  pageHandle: FridayBrowserPageHandle,
  action: "save" | "schedule" | "package" | "publish_later",
): Promise<void> {
  await pageHandle.page.waitForSelector(
    `[data-testid="assistant-outcome-receipt"][data-recommended-action="${action}"]`,
  );
}

async function startAgentRun(
  env: FridayBrowserE2eEnv,
  task: string,
): Promise<void> {
  const provider = env.hubEnv.providers.ollama;
  if (!provider) {
    throw new Error("Ollama mock provider was not installed for browser E2E");
  }
  const result = await env.apiFetch<{
    runId: string;
    status: string;
    response: string;
  }>("POST", "/v1/agent/runs", {
    task,
    providerId: provider.providerId,
    model: provider.model,
    timeoutMs: 20_000,
  });
  expect(result.status).toBe(200);
  expect(result.json.ok).toBe(true);
  expect(result.json.data.status, JSON.stringify(result.json.data, null, 2)).toBe("completed");
}

async function createAutomation(
  env: FridayBrowserE2eEnv,
  task: string,
): Promise<string> {
  const result = await env.apiFetch<{
    automation: {
      id: string;
    };
  }>("POST", "/v1/agent/automations", {
    name: task,
    taskTemplate: task,
    enabled: true,
  });
  expect(result.status).toBe(200);
  expect(result.json.ok).toBe(true);
  return result.json.data.automation.id;
}

async function runAutomationTwice(
  env: FridayBrowserE2eEnv,
  automationId: string,
): Promise<void> {
  const provider = env.hubEnv.providers.ollama;
  if (!provider) {
    throw new Error("Ollama mock provider was not installed for browser E2E");
  }
  for (let index = 0; index < 2; index += 1) {
    const result = await env.apiFetch<{
      result: {
        runId: string;
        status: string;
      };
    }>("POST", `/v1/agent/automations/${automationId}/run`, {
      providerId: provider.providerId,
      model: provider.model,
      timeoutMs: 20_000,
    });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.result.status).toBe("completed");
  }
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday Agent OS browser incentive journeys", () => {
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

  it("assistant -> outcome receipt -> save creates a leverage-scored automation", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    env.hubEnv.mockFor("ollama").setDefault({
      type: "text",
      text: "Here is a concise incident handoff note ready to reuse.",
    });

    const task = "Draft a concise incident handoff note for: API latency rose at 09:10, rollback started at 09:18, service recovered at 09:24.";
    await startAgentRun(env, task);
    await startAgentRun(env, task);

    pageHandle = await env.newPage();
    await waitForAssistant(pageHandle);
    await waitForOutcomeAction(pageHandle, "save");

    const saveButton = pageHandle.page.getByTestId("assistant-outcome-save");
    expect(await saveButton.textContent()).toContain("Save");
    await saveButton.click();

    await pageHandle.page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="assistant-outcome-save"]');
      return button?.textContent?.includes("Already saved") ?? false;
    });

    const automations = await env.apiFetch<{
      items: Array<{
        id: string;
        taskTemplate: string;
        estimatedTimeSavedMinutes: number;
        reuseCount: number;
        promotionState: string;
        lastOutcomeScore: number;
      }>;
    }>("GET", "/v1/agent/automations");
    expect(automations.status).toBe(200);
    expect(automations.json.ok).toBe(true);

    const created = automations.json.data.items.find((automation) => automation.taskTemplate === task);
    expect(created).toBeDefined();
    expect(created?.estimatedTimeSavedMinutes).toBeGreaterThan(0);
    expect(created?.reuseCount).toBe(0);
    expect(created?.promotionState).toBe("private");
    expect(created?.lastOutcomeScore).toBe(0);
  });

  it("assistant -> outcome receipt -> schedule carries the task into automations prefill", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    env.hubEnv.mockFor("ollama").setDefault({
      type: "text",
      text: "Friday ran the recurring summary successfully.",
    });

    const task = "Prepare the weekly operations summary";
    const automationId = await createAutomation(env, task);
    await runAutomationTwice(env, automationId);

    pageHandle = await env.newPage();
    await waitForAssistant(pageHandle);
    await waitForOutcomeAction(pageHandle, "schedule");

    await pageHandle.page.getByTestId("assistant-outcome-schedule").click();
    await pageHandle.page.waitForURL("**/automations?**");
    await pageHandle.page.waitForSelector('[data-testid="automations-name-input"]');

    expect(await pageHandle.page.getByTestId("automations-name-input").inputValue()).toBe(task);
    expect(await pageHandle.page.getByTestId("automations-task-input").inputValue()).toBe(task);
    expect(await pageHandle.page.getByTestId("automations-timezone-input").inputValue()).toBe("America/Los_Angeles");
  });

  it("assistant -> marketplace workflow request submits a prefilled request", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await waitForAssistant(pageHandle);

    const goal = "Prepare the weekly incident recap. Constraints: read-only, no outbound network access. Risk: avoid paging the on-call rotation. Budget: $50 tip.";
    const requestGoal = goal;
    const coreGoal = "Prepare the weekly incident recap.";
    const expectedTitle = `Need a workflow for: ${coreGoal}`;
    const expectedOutcome = `A usable workflow that solves: ${coreGoal}`;
    const encodedGoal = encodeURIComponent(goal).replace(/%20/g, "+");

    await pageHandle.page.getByTestId("assistant-goal-input").fill(goal);
    await pageHandle.page.waitForFunction((expected) => {
      const link = document.querySelector('[data-testid="assistant-marketplace-request-workflow"]');
      return link?.getAttribute("href")?.includes(expected) ?? false;
    }, encodedGoal);

    await pageHandle.page.getByTestId("assistant-marketplace-request-workflow").click();
    await pageHandle.page.waitForURL("**/marketplace?**");
    await pageHandle.page.waitForSelector('[data-testid="marketplace-request-submit"]');

    const workflowKindButton = pageHandle.page.getByTestId("marketplace-request-kind-workflow");
    expect(await workflowKindButton.getAttribute("data-active")).toBe("true");
    expect(await pageHandle.page.getByTestId("marketplace-request-goal").inputValue()).toBe(requestGoal);
    expect(await pageHandle.page.getByTestId("marketplace-request-title").inputValue()).toBe(expectedTitle);
    expect(await pageHandle.page.getByTestId("marketplace-request-outcome").inputValue()).toBe(expectedOutcome);
    expect(await pageHandle.page.getByTestId("marketplace-request-constraints").inputValue()).toBe(
      "read-only\nno outbound network access",
    );
    expect(await pageHandle.page.getByTestId("marketplace-request-budget").inputValue()).toBe("$50 tip");
    expect(await pageHandle.page.getByTestId("marketplace-request-risk-notes").inputValue()).toBe(
      "avoid paging the on-call rotation",
    );

    await pageHandle.page.getByTestId("marketplace-request-submit").click();
    await pageHandle.page.waitForFunction((title) => document.body.textContent?.includes(title) ?? false, expectedTitle);
  });
});
