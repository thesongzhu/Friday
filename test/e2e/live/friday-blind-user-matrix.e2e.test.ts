import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayRealBrowserE2eEnv,
  type FridayBrowserPageHandle,
  type FridayRealBrowserE2eEnv,
} from "../ui/_helpers/browser-env.js";
import { ensureAnthropicProviders } from "./_helpers/api.js";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  ANTHROPIC_BASE_URL,
  CODE_MODEL,
  FAST_MODEL,
} from "./_helpers/real-env.js";
import {
  hasLiveAnthropicApiKey,
  liveAnthropicCredentialMessage,
} from "../_helpers/live-anthropic.js";
import { runRealWorldValidation } from "../../../validation/real-world/lib/runner.mjs";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

const BLIND_USER_LOCAL_PASSPHRASE = "FridayBlindUserLocalPassphrase-2026-04-17";

function createReportRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `friday-${label}-`));
}

async function configureSetupForAuthenticatedJourneys(
  env: FridayRealBrowserE2eEnv,
  namePrefix: string,
): Promise<void> {
  if (!ANTHROPIC_API_KEY_ENV_REF) {
    throw new Error(liveAnthropicCredentialMessage());
  }

  const bootstrapStatus = await env.apiFetch<{
    bootstrapRequired: boolean;
  }>("GET", "/v1/auth/bootstrap/status");
  expect(bootstrapStatus.status).toBe(200);
  expect(bootstrapStatus.json.ok).toBe(true);
  if (bootstrapStatus.json.data.bootstrapRequired) {
    const bootstrapRes = await env.apiFetch<{ initialized: boolean }>(
      "POST",
      "/v1/auth/bootstrap/local-passphrase",
      {
        passphrase: BLIND_USER_LOCAL_PASSPHRASE,
      },
    );
    expect(bootstrapRes.status).toBe(200);
    expect(bootstrapRes.json.ok).toBe(true);
  }

  await ensureAnthropicProviders(
    env.baseUrl,
    env.accessToken,
    ANTHROPIC_BASE_URL,
    FAST_MODEL,
    CODE_MODEL,
    ANTHROPIC_API_KEY_ENV_REF,
    { namePrefix },
  );

  const networkRes = await env.apiFetch<{ host: string; port: number; mode: string }>(
    "POST",
    "/v1/setup/network",
    {
      mode: "local",
      port: 3141,
    },
  );
  expect(networkRes.status).toBe(200);
  expect(networkRes.json.ok).toBe(true);

  const completeRes = await env.apiFetch<{ setupCompletedAt: string }>(
    "POST",
    "/v1/setup/complete",
    {
      completedSteps: ["welcome", "security", "provider", "network", "done"],
      skippedSteps: ["channels", "skills"],
    },
  );
  expect(completeRes.status).toBe(200);
  expect(completeRes.json.ok).toBe(true);

  const onboardedAt = new Date().toISOString();
  const profileRes = await env.apiFetch<{ profileType: string; onboardedAt: string | null }>(
    "PUT",
    "/v1/uix/user-profile",
    {
      profileType: "developer",
      onboardedAt,
    },
  );
  expect(profileRes.status).toBe(200);
  expect(profileRes.json.ok).toBe(true);
  expect(profileRes.json.data.profileType).toBe("developer");
  expect(profileRes.json.data.onboardedAt).toBe(onboardedAt);

  const setupStatus = await env.apiFetch<{ needsSetup: boolean; setupCompletedAt: string | null }>(
    "GET",
    "/v1/setup/status",
  );
  expect(setupStatus.status).toBe(200);
  expect(setupStatus.json.ok).toBe(true);
  expect(setupStatus.json.data.needsSetup).toBe(false);
  expect(setupStatus.json.data.setupCompletedAt).not.toBeNull();
}

async function assertValidationPasses(reportRoot: string, label: string): Promise<void> {
  const summaryPath = path.join(reportRoot, "summary.json");
  const groupedPath = path.join(reportRoot, "grouped.json");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
    resultCounts?: Record<string, number>;
  };
  const grouped = JSON.parse(fs.readFileSync(groupedPath, "utf8")) as Array<{
    scenarioId: string;
    lane: string;
    worstResult: string;
    failures?: Array<{ notes?: string[]; failureClass?: string }>;
  }>;

  const nonPassing = grouped
    .filter((entry) => entry.worstResult !== "passed")
    .map((entry) => ({
      scenarioId: entry.scenarioId,
      lane: entry.lane,
      worstResult: entry.worstResult,
      failureClass: entry.failures?.[0]?.failureClass ?? null,
      note: entry.failures?.[0]?.notes?.[0] ?? null,
    }));

  expect(
    nonPassing,
    `${label} produced non-passing artifacts: ${JSON.stringify({
      resultCounts: summary.resultCounts ?? {},
      nonPassing,
      reportRoot,
    }, null, 2)}`,
  ).toEqual([]);
}

async function runBlindUserPack(input: {
  env: FridayRealBrowserE2eEnv;
  label: string;
  scenarioIds: string[];
}): Promise<string> {
  const reportRoot = createReportRoot(`blind-user-${input.label}`);
  await runRealWorldValidation({
    suite: "smoke",
    baseUrl: input.env.baseUrl,
    uiBaseUrl: input.env.baseUrl,
    accessToken: input.env.accessToken,
    localPassphrase: BLIND_USER_LOCAL_PASSPHRASE,
    scenarioIds: input.scenarioIds,
    reportRoot,
  });
  await assertValidationPasses(reportRoot, input.label);
  return reportRoot;
}

describe.skipIf(!(CHROMIUM_AVAILABLE && hasLiveAnthropicApiKey()))(
  "Friday blind-user matrix (real browser + Anthropic API key)",
  () => {
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

    it("beginner journey reaches live setup honestly and survives refresh", { timeout: 180_000 }, async () => {
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
      await pageHandle.page.reload({ waitUntil: "networkidle" });
      await pageHandle.page.waitForURL("**/setup", { timeout: 30_000 });

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

    it("regular user matrix stays green on the real Anthropic lane", { timeout: 300_000 }, async () => {
      env = await createFridayRealBrowserE2eEnv();
      await configureSetupForAuthenticatedJourneys(env, "Blind User Regular");

      await runBlindUserPack({
        env,
        label: "regular",
        scenarioIds: [
          "l1-home-ui",
          "l1-chat-ui",
          "l3-chat-direct-answer",
          "l3-long-summary-direct",
          "l3-json-extraction",
          "l3-multi-turn-memory",
          "l4-file-tool-roundtrip",
        ],
      });
    });

    it("operator matrix stays green on real UI and contract surfaces", { timeout: 300_000 }, async () => {
      env = await createFridayRealBrowserE2eEnv();
      await configureSetupForAuthenticatedJourneys(env, "Blind User Operator");

      await runBlindUserPack({
        env,
        label: "operator",
        scenarioIds: [
          "l1-settings-ui",
          "l1-observability-ui",
          "l1-sessions-ui",
          "l1-channels-ui",
          "l1-plugins-ui",
          "l1-usage-ui",
          "l2-sessions-contract",
          "l2-channels-contract",
          "l2-plugins-contract",
          "l2-uix-diagnostics-contract",
        ],
      });
    });
  },
);
