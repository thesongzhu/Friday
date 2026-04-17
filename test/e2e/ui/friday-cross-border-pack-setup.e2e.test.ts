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

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday cross-border pack setup (mock hub browser E2E)", () => {
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

  it("saves a cross-border operating profile and shows the assistant handoff", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    pageHandle = await env.newPage();

    await pageHandle.page.goto("/packs/cross-border/setup?packId=industry-cross-border-ecommerce");
    await pageHandle.page.locator('[data-testid="cross-border-setup-page"]').waitFor({ state: "visible", timeout: 45_000 });

    await pageHandle.page.locator('[data-testid="cross-border-category-l1"]').fill("Beauty");
    await pageHandle.page.locator('[data-testid="cross-border-category-l2"]').fill("Hair Dryers");
    await pageHandle.page.locator('[data-testid="cross-border-price-band"]').fill("US$19-29");
    await pageHandle.page.locator('[data-testid="cross-border-watch-targets"]').fill("Hair Dryers Top 10\nTravel Hair Dryer");
    await pageHandle.page.locator('[data-testid="cross-border-save-profile"]').click();

    await pageHandle.page.locator('[data-testid="cross-border-action-board"]').waitFor({ state: "visible", timeout: 45_000 });
    await pageHandle.page.locator('[data-testid="cross-border-apply-default-workflows"]').click();
    await pageHandle.page.locator('[data-testid="cross-border-open-managed-workflow-daily-store-health-check"]').waitFor({
      state: "visible",
      timeout: 45_000,
    });
    await pageHandle.page.locator('[data-testid="cross-border-open-assistant"]').click();
    await pageHandle.page.waitForURL("**/assistant?packId=industry-cross-border-ecommerce");

    const summary = await pageHandle.page.evaluate(() => ({
      pathname: window.location.pathname,
      search: window.location.search,
      hasCrash: document.body.textContent?.includes("Something went wrong") ?? false,
    }));

    expect(summary.pathname).toBe("/assistant");
    expect(summary.search).toContain("packId=industry-cross-border-ecommerce");
    expect(summary.hasCrash).toBe(false);
  });
});
