import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = "http://127.0.0.1:3141";
const ROOT_DIR = "/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31";
const SCREENSHOTS_DIR = path.join(ROOT_DIR, "screenshots");
const RESPONSES_DIR = path.join(ROOT_DIR, "responses");

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(RESPONSES_DIR, { recursive: true });

function safeWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function ensureLoggedIn(page) {
  await page.goto(`${BASE_URL}/assistant`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  if ((await page.locator("text=Fast operator login").count()) > 0) {
    await page.getByRole("button", { name: "Continue locally" }).click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
  }

  const onboardingButton = page.getByRole("button", { name: "Get started" });
  if (page.url().includes("/onboarding") || (await onboardingButton.count()) > 0) {
    await onboardingButton.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /Developer/i }).click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Go to Home" }).click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.goto(`${BASE_URL}/assistant`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  }

  await page.waitForSelector('[data-testid="assistant-goal-input"]', { timeout: 20000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
    timezoneId: "America/Los_Angeles",
  });

  const result = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    steps: [],
  };

  try {
    await ensureLoggedIn(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "assistant-page.png"), fullPage: true });
    result.steps.push({
      step: "assistant-load",
      verdict: "PASS",
      note: "Assistant page loaded and local login succeeded.",
    });

    const goal = "Help me investigate why deployments keep failing and turn this into a safe plan.";
    await page.getByTestId("assistant-goal-input").fill(goal);
    await page.getByTestId("assistant-goal-submit").click();
    await page.waitForSelector("text=Recommended action path", { timeout: 20000 });
    await page.waitForSelector('[data-testid="assistant-task-story"]', { timeout: 20000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "assistant-intent-result.png"), fullPage: true });
    result.steps.push({
      step: "assistant-submit-goal",
      verdict: "PASS",
      note: "Assistant goal submission returned a recommended action path and task stories.",
    });

    await page.goto(`${BASE_URL}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=MBTI template", { timeout: 20000 });
    await page.waitForSelector("text=Current resolved persona", { timeout: 20000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "settings-persona.png"), fullPage: true });
    result.steps.push({
      step: "settings-persona-load",
      verdict: "PASS",
      note: "Settings page loaded and displayed persona configuration.",
    });
  } catch (error) {
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "ui-validation-failure.png"), fullPage: true });
    result.steps.push({
      step: "ui-validation",
      verdict: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      currentUrl: page.url(),
      bodySample: await page.locator("body").innerText().catch(() => ""),
    });
  } finally {
    result.finishedAt = new Date().toISOString();
    await browser.close();
  }

  safeWriteJson(path.join(RESPONSES_DIR, "ui-validation.json"), result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
