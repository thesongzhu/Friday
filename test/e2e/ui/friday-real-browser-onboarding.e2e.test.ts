import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayRealBrowserE2eEnv,
  type FridayBrowserPageHandle,
  type FridayRealBrowserE2eEnv,
} from "./_helpers/browser-env.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday real browser onboarding path", () => {
  let env: FridayRealBrowserE2eEnv | null = null;
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

  it("reaches /setup from a fresh runtime without seeded onboarding shortcuts", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv();

    const setupStatus = await env.apiFetch<{
      needsSetup: boolean;
      setupCompletedAt: string | null;
    }>("GET", "/v1/setup/status");
    expect(setupStatus.status).toBe(200);
    expect(setupStatus.json.ok).toBe(true);
    expect(setupStatus.json.data.needsSetup).toBe(true);
    expect(setupStatus.json.data.setupCompletedAt).toBeNull();

    pageHandle = await env.newPage();
    await pageHandle.page.goto("/", { waitUntil: "networkidle" });
    await pageHandle.page.waitForURL("**/setup", { timeout: 30_000 });
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 50 && !bodyText.includes("Something went wrong");
    }, { timeout: 30_000 });

    const browserState = await pageHandle.page.evaluate(() => ({
      pathname: window.location.pathname,
      onboardedProfile: window.localStorage.getItem("friday.uix.user-profile"),
      bodyLength: document.body.textContent?.trim().length ?? 0,
      appCrashed: document.body.textContent?.includes("Something went wrong") ?? false,
    }));

    expect(browserState.pathname).toBe("/setup");
    expect(browserState.onboardedProfile).toBeNull();
    expect(browserState.bodyLength).toBeGreaterThan(50);
    expect(browserState.appCrashed).toBe(false);
  });
});
