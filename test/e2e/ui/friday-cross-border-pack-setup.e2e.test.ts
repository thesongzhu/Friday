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

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday cross-border pack setup", () => {
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

  it("saves a cross-border operating profile and shows the assistant handoff", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayBrowserE2eEnv();
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
    await pageHandle.page.locator('[data-testid="cross-border-open-managed-workflow-daily-store-health-check"]').click();
    await pageHandle.page.waitForURL(/\/workflows\/builder\?workflowId=/);
    await pageHandle.page.goBack();
    await pageHandle.page.locator('[data-testid="cross-border-action-board"]').waitFor({ state: "visible", timeout: 45_000 });
    await pageHandle.page.locator('[data-testid="cross-border-open-assistant"]').click();
    await pageHandle.page.waitForURL("**/assistant?packId=industry-cross-border-ecommerce");
    await pageHandle.page.locator('[data-testid="cross-border-assistant-handoff"]').waitFor({ state: "visible", timeout: 45_000 });
    await pageHandle.page.waitForFunction(() => (
      Boolean(document.querySelector('[data-testid="cross-border-handoff-open-managed-workflow-daily-store-health-check"]'))
      || Boolean(document.querySelector('[data-testid="cross-border-handoff-open-workflow-daily-store-health-check"]'))
    ), undefined, {
      timeout: 45_000,
    });

    const summary = await pageHandle.page.evaluate(() => ({
      pathname: window.location.pathname,
      search: window.location.search,
      hasCrash: document.body.textContent?.includes("Something went wrong") ?? false,
      handoffVisible: Boolean(document.querySelector('[data-testid="cross-border-assistant-handoff"]')),
      managedWorkflowVisible: Boolean(document.querySelector('[data-testid="cross-border-handoff-open-managed-workflow-daily-store-health-check"]')),
      templateWorkflowVisible: Boolean(document.querySelector('[data-testid="cross-border-handoff-open-workflow-daily-store-health-check"]')),
    }));

    expect(summary.pathname).toBe("/assistant");
    expect(summary.search).toContain("packId=industry-cross-border-ecommerce");
    expect(summary.hasCrash).toBe(false);
    expect(summary.handoffVisible).toBe(true);
    expect(summary.managedWorkflowVisible || summary.templateWorkflowVisible).toBe(true);
  });
});
