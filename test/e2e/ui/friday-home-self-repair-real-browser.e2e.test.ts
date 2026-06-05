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
      rollbackPlanAvailable: boolean;
    };
    evidence: {
      executionResult?: {
        repairOutcome?: string;
      };
      acceptanceResult?: {
        passed?: boolean;
      };
      rollbackResult?: {
        rollbackAttempted?: boolean;
        rollbackSucceeded?: boolean;
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
  executed: Array<{
    action: {
      summary: {
        actionId: string;
        rollbackPlanAvailable: boolean;
      };
    };
    result: {
      success: boolean;
      rollbackAttempted: boolean;
      rollbackSucceeded: boolean;
    };
  }>;
}

interface AutoFixExecutionResponse {
  action: {
    summary: {
      actionId: string;
      status: string;
      rollbackPlanAvailable: boolean;
    };
  };
  result: {
    success: boolean;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean;
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

async function waitForRolledBackAutoFixAction(
  env: FridayRealBrowserE2eEnv,
  actionId: string,
): Promise<AutoFixListResponse["items"][number]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const action = (await listAutoFixActions(env)).find((item) => item.summary.actionId === actionId);
    if (action?.summary.status === "rolled_back") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for auto-fix action ${actionId} to roll back`);
}

async function waitForSelfRepairResultText(
  pageHandle: FridayBrowserPageHandle,
  pattern: RegExp,
): Promise<string> {
  const locator = pageHandle.page.locator('[data-testid="home-self-repair-result"]');
  const deadline = Date.now() + 20_000;
  let lastText = "";
  while (Date.now() < deadline) {
    lastText = await locator.innerText().catch(() => "");
    if (pattern.test(lastText)) {
      return lastText;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for self-repair result text matching ${pattern}; last text: ${lastText}`);
}

async function waitForSelfRepairResultVisible(pageHandle: FridayBrowserPageHandle): Promise<string> {
  await pageHandle.page.locator('[data-testid="home-self-repair-result"]').waitFor({
    state: "visible",
    timeout: 20_000,
  });
  return pageHandle.page.locator('[data-testid="home-self-repair-result"]').innerText();
}

function seedReadyRollbackableLowRiskAutoFixAction(input: {
  env: FridayRealBrowserE2eEnv;
  userId: string;
}): string {
  const actionId = "dp02-home-rollback-ready-action";
  const incidentId = "dp02-home-rollback-ready-incident";
  const diagnosisId = "dp02-home-rollback-ready-diagnosis";
  const fingerprint = "dp02-home-supervised-repair-rollback-proof";
  const db = new Database(path.join(input.env.stateDir, "friday.db"));
  try {
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    incidentRepo.insert(db, {
      incidentId,
      userId: input.userId,
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: fingerprint,
      context: { source: "dp02-home-supervised-repair-rollback-proof" },
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
        summary: "Seeded low-risk config repair for Home supervised repair rollback proof",
        rankedCauses: [{ cause: "Config model fallback needed a reversible patch", confidence: 0.92 }],
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const plan: FridayAutoFixPlan = {
      title: "Auto-fix: supervised config patch",
      summary: "Apply a reversible config patch in a low-risk, data-preserving repair",
      steps: [
        {
          stepId: "dp02-home-config-patch-step",
          kind: "apply_config_patch",
          target: "config",
          payload: {
            incidentId,
            patch: { provider: { defaultModel: "dp02-home-rollback-proof" } },
            reason: "Home supervised repair rollback proof",
          },
          verify: { method: "config_reload_valid", timeoutMs: 5000 },
        },
      ],
      rollbackPlan: {
        summary: "Revert Home supervised repair config patch",
        steps: [
          {
            stepId: "dp02-home-config-patch-rollback-step",
            kind: "apply_config_patch",
            target: "config",
            payload: {
              revert: true,
              incidentId,
              reason: "Home supervised repair rollback proof",
            },
          },
        ],
      },
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
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
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

  it("runs and rolls back ready low-risk repair actions from Home and denies unbound repair mutations", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv({ allowTestOnlyAutoFixExecution: true });
    await completeSetup(env);
    const userId = await readUserId(env);
    const actionId = seedReadyRollbackableLowRiskAutoFixAction({ env, userId });
    expect(await waitForPlannedAutoFixAction(env)).toBe(actionId);

    const runReadyDenied = await fetch(`${env.baseUrl}/v1/auto-fix/actions/run-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxRiskTier: 1, limit: 50 }),
    });
    expect(runReadyDenied.status).toBe(401);
    const runReadyDeniedJson = await runReadyDenied.json() as { ok: boolean; error?: { code?: string } };
    expect(runReadyDeniedJson.ok).toBe(false);
    expect(runReadyDeniedJson.error?.code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");

    const rollbackDenied = await fetch(`${env.baseUrl}/v1/auto-fix/actions/${encodeURIComponent(actionId)}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "unbound rollback should fail" }),
    });
    expect(rollbackDenied.status).toBe(401);
    const rollbackDeniedJson = await rollbackDenied.json() as { ok: boolean; error?: { code?: string } };
    expect(rollbackDeniedJson.ok).toBe(false);
    expect(rollbackDeniedJson.error?.code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");

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
    expect(runReadyJson.data.executed[0]?.action.summary.actionId).toBe(actionId);
    expect(runReadyJson.data.executed[0]?.action.summary.rollbackPlanAvailable).toBe(true);
    expect(runReadyJson.data.executed[0]?.result.success).toBe(true);

    const noticeText = await waitForSelfRepairResultVisible(pageHandle);
    expect(noticeText).toMatch(/已运行 1 项修复动作|Ran 1 repair action/);
    expect(noticeText).toMatch(/用户已有数据不会被清空或重置|Existing user data is not cleared or reset/);

    const applied = await waitForAppliedAutoFixAction(env, actionId);
    expect(applied.summary.outcome).toBe("success");
    expect(applied.summary.rollbackPlanAvailable).toBe(true);
    expect(applied.evidence.executionResult?.repairOutcome).toBe("verified_repair");
    expect(applied.evidence.acceptanceResult?.passed).toBe(true);

    await pageHandle.page.locator('[data-testid="home-self-repair-rollback"]').waitFor({
      state: "visible",
      timeout: 20_000,
    });
    const rollbackResponsePromise = pageHandle.page.waitForResponse((response) =>
      response.url().includes(`/v1/auto-fix/actions/${actionId}/rollback`)
      && response.request().method() === "POST",
    );
    await pageHandle.page.locator('[data-testid="home-self-repair-rollback"]').click();
    const rollbackResponse = await rollbackResponsePromise;
    expect(rollbackResponse.status()).toBe(200);
    const rollbackJson = await rollbackResponse.json() as { ok: boolean; data: AutoFixExecutionResponse };
    expect(rollbackJson.ok).toBe(true);
    expect(rollbackJson.data.action.summary.actionId).toBe(actionId);
    expect(rollbackJson.data.action.summary.status).toBe("rolled_back");
    expect(rollbackJson.data.action.summary.rollbackPlanAvailable).toBe(true);
    expect(rollbackJson.data.result.rollbackAttempted).toBe(true);
    expect(rollbackJson.data.result.rollbackSucceeded).toBe(true);

    await waitForSelfRepairResultText(pageHandle, /已回滚刚才的修复|Rolled back the repair/);

    const rolledBack = await waitForRolledBackAutoFixAction(env, actionId);
    expect(rolledBack.evidence.executionResult?.repairOutcome).toBe("rolled_back");
    expect(rolledBack.evidence.rollbackResult?.rollbackAttempted).toBe(true);
    expect(rolledBack.evidence.rollbackResult?.rollbackSucceeded).toBe(true);
  });
});
