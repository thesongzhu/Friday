import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  createFridayRealBrowserE2eEnv,
  type FridayBrowserPageHandle,
  type FridayRealBrowserE2eEnv,
} from "./_helpers/browser-env.js";
import {
  createFridayAutoFixActionRepository,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  type FridayAutoFixPlan,
} from "#learning";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

interface AuthMeResponse {
  user: {
    id: string;
    displayName: string;
    role: string;
  };
  scopes: string[];
}

interface SetupCompleteResponse {
  setupCompletedAt: string;
}

interface AutoFixListResponse {
  items: Array<{
    summary: {
      actionId: string;
      status: string;
      outcome?: string | null;
    };
    evidence: {
      executionResult?: {
        repairOutcome?: string;
      };
      acceptanceResult?: {
        passed?: boolean;
      };
    };
  }>;
}

interface AutoFixRunReadyResponse {
  summary: {
    inspected: number;
    executed: number;
    succeeded: number;
    failed: number;
    requiresApproval: number;
    blockedByPolicy: number;
    dataProtected: boolean;
  };
}

const NOW = "2026-05-27T13:30:00.000Z";

async function completeSetup(env: FridayRealBrowserE2eEnv): Promise<void> {
  const response = await env.apiFetch<SetupCompleteResponse>("POST", "/v1/setup/complete", {
    completedSteps: [
      "welcome",
      "security",
      "communication",
      "provider",
      "network",
      "channels",
      "skills",
      "done",
    ],
    skippedSteps: [],
  });
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
}

async function readUserId(env: FridayRealBrowserE2eEnv): Promise<string> {
  const response = await env.apiFetch<AuthMeResponse>("GET", "/v1/auth/me");
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.user.id).toBeTruthy();
  return response.json.data.user.id;
}

async function seedBrowserProfile(pageHandle: FridayBrowserPageHandle): Promise<void> {
  await pageHandle.page.addInitScript(() => {
    window.localStorage.setItem("friday.uix.user-profile", JSON.stringify({
      profileType: "developer",
      onboardedAt: new Date().toISOString(),
    }));
    window.localStorage.setItem("friday.auth.user", JSON.stringify({
      id: "admin-001",
      email: "admin@friday.local",
      displayName: "Friday Admin",
      role: "admin",
    }));
  });
}

async function listAutoFixActions(env: FridayRealBrowserE2eEnv): Promise<AutoFixListResponse["items"]> {
  const response = await env.apiFetch<AutoFixListResponse>("GET", "/v1/auto-fix/actions?limit=20");
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.items;
}

async function waitForPlannedAutoFixAction(env: FridayRealBrowserE2eEnv): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const action = (await listAutoFixActions(env)).find((item) => item.summary.status === "planned");
    if (action?.summary.actionId) {
      return action.summary.actionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for a planned auto-fix action");
}

async function waitForAppliedAutoFixAction(
  env: FridayRealBrowserE2eEnv,
  actionId: string,
): Promise<AutoFixListResponse["items"][number]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const action = (await listAutoFixActions(env)).find((item) => item.summary.actionId === actionId);
    if (action?.summary.status === "applied") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for auto-fix action ${actionId} to apply`);
}

function seedReadyLowRiskAutoFixAction(input: {
  env: FridayRealBrowserE2eEnv;
  userId: string;
}): string {
  const actionId = "dp02-home-ready-action";
  const incidentId = "dp02-home-ready-incident";
  const diagnosisId = "dp02-home-ready-diagnosis";
  const fingerprint = "dp02-home-supervised-repair-proof";
  const db = new Database(path.join(input.env.stateDir, "friday.db"));
  try {
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    incidentRepo.insert(db, {
      incidentId,
      userId: input.userId,
      ts: NOW,
      category: "routing",
      severity: "medium",
      signature: fingerprint,
      context: { source: "dp02-home-supervised-repair-proof" },
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    diagnosisRepo.insert(db, {
      id: diagnosisId,
      incidentId,
      errorFingerprint: fingerprint,
      confidence: 0.92,
      diagnosis: {
        summary: "Seeded low-risk routing repair for Home supervised repair proof",
        rankedCauses: [{ cause: "Payload needed trimming", confidence: 0.92 }],
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const plan: FridayAutoFixPlan = {
      title: "Auto-fix: trim routing payload",
      summary: "Trim a routing payload in a low-risk, data-preserving repair",
      steps: [
        {
          stepId: "dp02-home-trim-step",
          kind: "trim_payload",
          target: "routing",
          payload: {
            incidentId,
            category: "routing",
            signature: fingerprint,
            message: `DP02_HOME_SUPERVISED_REPAIR_LONG_PAYLOAD:${"x".repeat(256)}`,
            maxChars: 96,
          },
          verify: { method: "error_absent", timeoutMs: 5000 },
        },
      ],
      evidence: {
        fingerprint,
        matchedLessonIds: [],
        diagnosisId,
        recurrenceCount: 2,
      },
    };
    actionRepo.insert(db, {
      actionId,
      incidentId,
      userId: input.userId,
      riskTier: 0,
      plan,
      rollbackPlan: undefined,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return actionId;
  } finally {
    db.close();
  }
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday Home supervised self-repair real-browser flow", () => {
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

  it("runs only ready low-risk repair actions from Home and denies unbound run-ready execution", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv();
    await completeSetup(env);
    const userId = await readUserId(env);
    const actionId = seedReadyLowRiskAutoFixAction({ env, userId });
    expect(await waitForPlannedAutoFixAction(env)).toBe(actionId);

    const denied = await fetch(`${env.baseUrl}/v1/auto-fix/actions/run-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxRiskTier: 1, limit: 50 }),
    });
    expect(denied.status).toBe(401);
    const deniedJson = await denied.json() as { ok: boolean; error?: { code?: string } };
    expect(deniedJson.ok).toBe(false);
    expect(deniedJson.error?.code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");

    pageHandle = await env.newPage();
    await seedBrowserProfile(pageHandle);
    await pageHandle.page.goto("/home", { waitUntil: "networkidle" });
    await pageHandle.page.locator('[data-testid="home-self-repair"]').waitFor({
      state: "visible",
      timeout: 60_000,
    });

    const runReadyResponsePromise = pageHandle.page.waitForResponse((response) =>
      response.url().includes("/v1/auto-fix/actions/run-ready")
      && response.request().method() === "POST",
    );
    await pageHandle.page.locator('[data-testid="home-self-repair"]').click();
    const runReadyResponse = await runReadyResponsePromise;
    expect(runReadyResponse.status()).toBe(200);
    const runReadyJson = await runReadyResponse.json() as { ok: boolean; data: AutoFixRunReadyResponse };
    expect(runReadyJson.ok).toBe(true);
    expect(runReadyJson.data.summary.dataProtected).toBe(true);
    expect(runReadyJson.data.summary.executed).toBe(1);
    expect(runReadyJson.data.summary.succeeded).toBe(1);
    expect(runReadyJson.data.summary.failed).toBe(0);

    await pageHandle.page.locator('[data-testid="home-self-repair-result"]').waitFor({
      state: "visible",
      timeout: 20_000,
    });
    const noticeText = await pageHandle.page.locator('[data-testid="home-self-repair-result"]').innerText();
    expect(noticeText).toMatch(/已运行 1 项修复动作|Ran 1 repair action/);
    expect(noticeText).toMatch(/用户已有数据不会被清空或重置|Existing user data is not cleared or reset/);

    const applied = await waitForAppliedAutoFixAction(env, actionId);
    expect(applied.summary.outcome).toBe("success");
    expect(applied.evidence.executionResult?.repairOutcome).toBe("verified_repair");
    expect(applied.evidence.acceptanceResult?.passed).toBe(true);
  });
});
