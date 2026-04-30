import * as fs from "node:fs";
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

const BROWSER_E2E_TIMEOUT_MS = 180_000;

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday skills page local inventory (mock hub browser E2E)", () => {
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

  it("skills page renders and contains expected elements", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    pageHandle = await env.newPage();

    await pageHandle.page.goto("/skills");
    await pageHandle.page.locator('[data-testid="skills-page"]').waitFor({ state: "visible", timeout: 45_000 });
    await pageHandle.page.waitForFunction(
      () => document.body.textContent?.includes("Current skills") ?? false,
      undefined,
      { timeout: 45_000 },
    );

    const pageState = await pageHandle.page.evaluate(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return {
        url: window.location.pathname,
        bodyLength: bodyText.length,
        hasContent: bodyText.length > 20,
        appCrashed: bodyText.includes("Something went wrong"),
        hasImportButton: Boolean(document.querySelector('[data-testid="skills-import-button"]')),
        hasCurrentSkills: bodyText.includes("Current skills"),
      };
    });

    expect(pageState.url).toBe("/skills");
    expect(pageState.hasContent).toBe(true);
    expect(pageState.appCrashed).toBe(false);
    expect(pageState.hasImportButton).toBe(false);
    expect(pageState.hasCurrentSkills).toBe(true);
  });

  it("skills page does not crash on initial load", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
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
