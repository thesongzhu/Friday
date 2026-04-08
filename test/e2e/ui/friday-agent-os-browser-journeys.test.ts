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
  } catch {
    return false;
  }
})();

const BROWSER_E2E_TIMEOUT_MS = 120_000;
const QUICK_SHEET_CYCLE_ATTEMPTS = process.env.CI ? 1 : 3;

async function waitForTestId(pageHandle: FridayBrowserPageHandle, testId: string): Promise<void> {
  await pageHandle.page.locator(`[data-testid="${testId}"]`).first().waitFor({ state: "visible", timeout: 60_000 });
}

type SurfaceId = "home" | "packs" | "assistant" | "chat";

async function waitForSurfaceReady(pageHandle: FridayBrowserPageHandle, surface: SurfaceId): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await pageHandle.page.evaluate((targetSurface) => {
      const has = (selector: string) => Boolean(document.querySelector(selector));
      switch (targetSurface) {
        case "home":
          return has('[data-testid="home-surface-ready"]')
            && (has('[data-testid="home-start-task"]') || has('[data-testid="home-browse-library"]'));
        case "packs":
          return has('[data-testid="packs-surface-ready"]')
            && (has('[data-testid^="pack-open-"]') || has('[data-testid^="pack-card-"]'));
        case "assistant":
          return has('[data-testid="assistant-inbox"]');
        case "chat": {
          const input = document.querySelector('[data-testid="chat-task-input"]') as HTMLTextAreaElement | null;
          return Boolean(input) && !input.disabled;
        }
      }
    }, surface);
    if (ready) {
      return;
    }
    await pageHandle.page.waitForTimeout(200);
  }

  throw new Error(`surface ${surface} did not become visible within 60000ms (url=${pageHandle.page.url()})`);
}

async function clickRailLink(pageHandle: FridayBrowserPageHandle, href: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const clicked = await pageHandle.page.evaluate((targetHref) => {
      const link = document.querySelector(
        `[data-testid="app-shell-rail"] a[href="${targetHref}"], nav a[href="${targetHref}"]`,
      );
      if (!(link instanceof HTMLAnchorElement)) {
        return false;
      }
      link.click();
      return true;
    }, href);
    if (clicked) {
      return;
    }
    await pageHandle.page.waitForTimeout(200);
  }

  throw new Error(`rail link not found for ${href} within 30000ms`);
}

async function clickTestId(pageHandle: FridayBrowserPageHandle, testId: string): Promise<void> {
  await pageHandle.page.waitForFunction(
    (targetTestId) => {
      const element = document.querySelector(`[data-testid="${targetTestId}"]`);
      return element instanceof HTMLElement && element.isConnected;
    },
    testId,
  );
  await pageHandle.page.evaluate((targetTestId) => {
    const element = document.querySelector(`[data-testid="${targetTestId}"]`);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`element not found for ${targetTestId}`);
    }
    element.click();
  }, testId);
}

async function waitForAssistantInbox(pageHandle: FridayBrowserPageHandle): Promise<void> {
  await pageHandle.page.goto("/assistant");
  await waitForSurfaceReady(pageHandle, "assistant");
}

async function waitForChat(pageHandle: FridayBrowserPageHandle): Promise<void> {
  await pageHandle.page.goto("/chat");
  await waitForSurfaceReady(pageHandle, "chat");
  await pageHandle.page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="chat-task-input"]') as HTMLTextAreaElement | null;
    return Boolean(input) && !input.disabled;
  });
}

async function createScheduledAutomation(
  env: FridayBrowserE2eEnv,
  task: string,
  cron: string,
): Promise<string> {
  const result = await env.apiFetch<{
    automation: {
      id: string;
    };
  }>("POST", "/v1/agent/automations", {
    name: task,
    taskTemplate: task,
    enabled: true,
    schedule: {
      type: "cron",
      cron,
      timezone: "America/Los_Angeles",
    },
  });
  expect(result.status).toBe(200);
  expect(result.json.ok).toBe(true);
  return result.json.data.automation.id;
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

  it("chat keeps the primary composer interactive on the task-first surface", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await waitForChat(pageHandle);

    await pageHandle.page.evaluate((value) => {
      const input = document.querySelector('[data-testid="chat-task-input"]') as HTMLTextAreaElement | null;
      if (!input) {
        throw new Error("chat-task-input not found");
      }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, "Plan next week's priorities");
    await pageHandle.page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="chat-send-button"]') as HTMLButtonElement | null;
      return Boolean(button) && !button.disabled;
    });

    const composerState = await pageHandle.page.evaluate(() => {
      const input = document.querySelector('[data-testid="chat-task-input"]') as HTMLTextAreaElement | null;
      const button = document.querySelector('[data-testid="chat-send-button"]') as HTMLButtonElement | null;
      return {
        value: input?.value ?? "",
        sendDisabled: button?.disabled ?? true,
      };
    });

    expect(composerState.value).toBe("Plan next week's priorities");
    expect(composerState.sendDisabled).toBe(false);
  });

  it("assistant inbox no longer behaves like the old start page and defers new tasks to chat", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await waitForAssistantInbox(pageHandle);

    expect(await pageHandle.page.locator('[data-testid="assistant-goal-input"]').count()).toBe(0);
    await waitForTestId(pageHandle, "assistant-inbox-start-task");
    await waitForChat(pageHandle);
  });

  it("assistant renders a structured pack handoff when a vertical pack is selected", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.goto("/assistant?packId=industry-creator-media");
    await waitForTestId(pageHandle, "pack-assistant-receipt-industry-creator-media");
    await waitForTestId(pageHandle, "pack-product-prompt-weekly-calendar");
  });

  it("packs open through a quick sheet and let the user adjust before starting", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.goto("/packs");
    await waitForTestId(pageHandle, "pack-card-industry-creator-media");

    await pageHandle.page.evaluate(() => {
      const button = document.querySelector('[data-testid="pack-open-industry-creator-media"]') as HTMLButtonElement | null;
      if (!button) {
        throw new Error("pack-open-industry-creator-media not found");
      }
      button.click();
    });
    await waitForTestId(pageHandle, "pack-quick-sheet");
    await waitForTestId(pageHandle, "pack-quick-start");
    await waitForTestId(pageHandle, "pack-quick-adjust");
    await waitForTestId(pageHandle, "pack-product-prompt-weekly-calendar");
    await waitForTestId(pageHandle, "pack-product-open-assistant");

    await pageHandle.page.evaluate(() => {
      const button = document.querySelector('[data-testid="pack-quick-adjust"]') as HTMLButtonElement | null;
      if (!button) {
        throw new Error("pack-quick-adjust not found");
      }
      button.click();
    });
    await pageHandle.page.waitForURL((url) =>
      url.pathname === "/flow/content-social"
      && url.searchParams.get("mode") === "adjust"
      && url.searchParams.get("packId") === "industry-creator-media",
    );
  });

  it("desktop rail stays flush-left and primary nav does not trigger a full reload", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.setViewportSize({ width: 1440, height: 980 });
    await pageHandle.page.goto("/packs");
    await waitForTestId(pageHandle, "app-shell-rail");

    const railBox = await pageHandle.page.locator('[data-testid="app-shell-rail"]').boundingBox();
    expect(railBox).not.toBeNull();
    expect(Math.round(railBox!.x)).toBe(0);

    const navigationCountBefore = await pageHandle.page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    );

    await clickRailLink(pageHandle, "/assistant");
    await waitForAssistantInbox(pageHandle);

    const navigationCountAfter = await pageHandle.page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    );
    expect(navigationCountAfter).toBe(navigationCountBefore);
  });

  it("main surfaces survive repeated navigation and quick-sheet cycles without white-screening", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.goto("/packs");
    await waitForTestId(pageHandle, "pack-card-industry-creator-media");

    const navigationCountBefore = await pageHandle.page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    );

    for (let attempt = 0; attempt < QUICK_SHEET_CYCLE_ATTEMPTS; attempt += 1) {
      await clickTestId(pageHandle, "pack-open-industry-creator-media");
      await waitForTestId(pageHandle, "pack-quick-sheet");
      await pageHandle.page.evaluate(() => {
        const button = document.querySelector('[data-testid="pack-quick-close"]') as HTMLButtonElement | null;
        if (!button) {
          throw new Error("pack-quick-close not found");
        }
        button.click();
      });
      await pageHandle.page.waitForFunction(() => !document.querySelector('[data-testid="pack-quick-sheet"]'));

      await clickRailLink(pageHandle, "/home");
      await pageHandle.page.waitForURL("**/home");
      await waitForSurfaceReady(pageHandle, "home");

      await clickRailLink(pageHandle, "/chat");
      await waitForChat(pageHandle);

      await clickRailLink(pageHandle, "/packs");
      await waitForSurfaceReady(pageHandle, "packs");
    }

    const finalState = await pageHandle.page.evaluate(() => ({
      navigationCount: performance.getEntriesByType("navigation").length,
      packsSurfaceReady: Boolean(document.querySelector('[data-testid="packs-surface-ready"]')),
      packActionVisible: Boolean(document.querySelector('[data-testid^="pack-open-"]')),
      textLength: document.body.textContent?.trim().length ?? 0,
    }));

    expect(finalState.navigationCount).toBe(navigationCountBefore);
    expect(finalState.packsSurfaceReady).toBe(true);
    expect(finalState.packActionVisible).toBe(true);
    expect(finalState.textLength).toBeGreaterThan(100);
  });

  it("smart default routes to home when an automation is scheduled soon", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    await createScheduledAutomation(env, "Prepare the hourly status recap", "*/5 * * * *");

    pageHandle = await env.newPage();
    await pageHandle.page.goto("/");
    await pageHandle.page.waitForURL("**/home");
    await pageHandle.page.waitForFunction(() =>
      document.body.textContent?.includes("Prepare the hourly status recap") ?? false
    );
  });
});
