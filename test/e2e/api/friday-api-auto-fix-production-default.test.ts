import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FridayApiTestEnv } from "./_helpers/friday-api-test-server.helper.js";
import {
  authHeaders,
  createFridayApiTestEnv,
  loginTestUser,
} from "./_helpers/friday-api-test-server.helper.js";

describe("B6 auto-fix production default", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv({ enableSelfHealing: true });
    token = (await loginTestUser(env.baseUrl)).accessToken;

    env.selfHealingService!.reportStructuredFailure({
      userId: "test-user",
      category: "workflow",
      severity: "high",
      message: "b6-production-default-autofix-proof",
    });
    env.selfHealingService!.reportStructuredFailure({
      userId: "test-user",
      category: "workflow",
      severity: "high",
      message: "b6-production-default-autofix-proof",
    });
  });

  afterAll(async () => {
    await env.close();
  });

  it("keeps the auto-fix execution route fail-closed unless the test oracle explicitly opts in", async () => {
    const actionsRes = await fetch(`${env.baseUrl}/v1/auto-fix/actions`, {
      headers: authHeaders(token),
    });
    expect(actionsRes.status).toBe(200);
    const actionsJson = (await actionsRes.json()) as {
      ok: boolean;
      data: { items: Array<{ summary: { actionId: string } }> };
    };
    expect(actionsJson.ok).toBe(true);
    const actionId = actionsJson.data.items[0]?.summary.actionId;
    expect(actionId).toBeTruthy();

    const executeRes = await fetch(`${env.baseUrl}/v1/auto-fix/actions/${encodeURIComponent(actionId!)}/execute`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(executeRes.status).toBe(503);
    const executeJson = (await executeRes.json()) as {
      ok: boolean;
      error?: {
        code?: string;
        details?: { classification?: string; replacement?: string };
      };
    };
    expect(executeJson.ok).toBe(false);
    expect(executeJson.error?.code).toBe("TS_RUNTIME_AUTOFIX_EXECUTION_RETIRED");
    expect(executeJson.error?.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_autofix_execution_entrypoint_required",
    });
  });
});
