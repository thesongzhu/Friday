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

const BROWSER_E2E_TIMEOUT_MS = 180_000;

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday full onboarding flow", () => {
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

  it("navigates to /setup and verifies setup page renders", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();

    await pageHandle.page.goto("/setup");
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 50 && !bodyText.includes("Something went wrong");
    }, { timeout: 30_000 });

    const setupState = await pageHandle.page.evaluate(() => ({
      url: window.location.pathname,
      bodyLength: document.body.textContent?.trim().length ?? 0,
      hasContent: (document.body.textContent?.trim().length ?? 0) > 50,
      appCrashed: document.body.textContent?.includes("Something went wrong") ?? false,
    }));

    expect(setupState.url).toBe("/setup");
    expect(setupState.hasContent).toBe(true);
    expect(setupState.appCrashed).toBe(false);
  });

  it("navigates from setup to the default chat surface and verifies chat renders", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();

    await pageHandle.page.goto("/");
    await pageHandle.page.waitForURL("**/chat");
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 50 && !bodyText.includes("Something went wrong");
    }, { timeout: 45_000 });

    const chatState = await pageHandle.page.evaluate(() => ({
      url: window.location.pathname,
      bodyLength: document.body.textContent?.trim().length ?? 0,
      hasContent: (document.body.textContent?.trim().length ?? 0) > 50,
      appCrashed: document.body.textContent?.includes("Something went wrong") ?? false,
    }));

    expect(chatState.url).toBe("/chat");
    expect(chatState.hasContent).toBe(true);
    expect(chatState.appCrashed).toBe(false);
  });
});
