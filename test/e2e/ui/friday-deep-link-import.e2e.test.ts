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

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday deep link import — skills page", () => {
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

  it("skills page renders and contains expected elements", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();

    await pageHandle.page.goto("/skills");
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 20 && !bodyText.includes("Something went wrong");
    }, { timeout: 45_000 });

    const pageState = await pageHandle.page.evaluate(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return {
        url: window.location.pathname,
        bodyLength: bodyText.length,
        hasContent: bodyText.length > 20,
        appCrashed: bodyText.includes("Something went wrong"),
        // Check for common skill-page elements
        hasButtons: document.querySelectorAll("button").length > 0,
        hasLinks: document.querySelectorAll("a").length > 0,
      };
    });

    expect(pageState.url).toBe("/skills");
    expect(pageState.hasContent).toBe(true);
    expect(pageState.appCrashed).toBe(false);
    expect(pageState.hasButtons).toBe(true);
  });

  it("skills page does not crash on initial load", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
    pageHandle = await env.newPage();

    await pageHandle.page.goto("/skills");
    await pageHandle.page.waitForFunction(() => {
      return document.readyState === "complete";
    }, { timeout: 30_000 });

    const diagnostics = await pageHandle.page.evaluate(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      const consoleErrors: string[] = [];
      return {
        readyState: document.readyState,
        bodyLength: bodyText.length,
        appCrashed: bodyText.includes("Something went wrong"),
        hasErrorBoundary: bodyText.includes("error boundary"),
      };
    });

    expect(diagnostics.readyState).toBe("complete");
    expect(diagnostics.appCrashed).toBe(false);
    expect(diagnostics.hasErrorBoundary).toBe(false);
  });
});
