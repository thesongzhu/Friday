import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FridayApiTestEnv } from "./_helpers/friday-api-test-server.helper.js";
import {
  authHeaders,
  createFridayApiTestEnv,
  createTokenWithScopes,
  loginTestUser,
} from "./_helpers/friday-api-test-server.helper.js";

/**
 * Phase 21B ownership-boundary regression fixture.
 *
 * Phase 21A used this file as an env-gated known-vulnerability proof. Phase 21B
 * makes it a permanent denial test for identifier-based action and incident
 * routes.
 */
describe("Phase 21B cross-user self-healing route denial", () => {
  let env: FridayApiTestEnv;
  let userAToken: string;
  let userBToken: string;
  let actionId: string;
  let incidentId: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv({ enableSelfHealing: true });
    userAToken = (await loginTestUser(env.baseUrl)).accessToken;
    userBToken = createTokenWithScopes([], { userId: "phase21-user-b" });

    env.selfHealingService!.reportStructuredFailure({
      userId: "test-user",
      category: "workflow",
      severity: "high",
      message: "phase21-cross-user-proof",
    });
    env.selfHealingService!.reportStructuredFailure({
      userId: "test-user",
      category: "workflow",
      severity: "high",
      message: "phase21-cross-user-proof",
    });

    const actionsRes = await fetch(`${env.baseUrl}/v1/auto-fix/actions`, {
      headers: authHeaders(userAToken),
    });
    expect(actionsRes.status).toBe(200);
    const actions = await actionsRes.json() as {
      ok: true;
      data: { items: Array<{ summary: { actionId: string } }> };
    };
    const foundActionId = actions.data.items[0]?.summary.actionId;
    expect(foundActionId).toBeTruthy();
    actionId = foundActionId!;

    const incidentsRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents`, {
      headers: authHeaders(userAToken),
    });
    expect(incidentsRes.status).toBe(200);
    const incidents = await incidentsRes.json() as {
      ok: true;
      data: { items: Array<{ incident: { incidentId: string } }> };
    };
    const foundIncidentId = incidents.data.items[0]?.incident.incidentId;
    expect(foundIncidentId).toBeTruthy();
    incidentId = foundIncidentId!;
  });

  afterAll(async () => {
    await env.close();
  });

  it.each([
    ["GET", "/v1/auto-fix/actions/:actionId", undefined],
    ["POST", "/v1/auto-fix/actions/:actionId/approve", {}],
    ["POST", "/v1/auto-fix/actions/:actionId/deny", { reason: "not mine" }],
    ["POST", "/v1/auto-fix/actions/:actionId/execute", {}],
    ["POST", "/v1/auto-fix/actions/:actionId/rollback", { reason: "not mine" }],
  ] as const)("denies non-owner %s %s", async (method, template, body) => {
    const path = template.replace(":actionId", actionId);
    const res = await fetch(`${env.baseUrl}${path}`, {
      method,
      headers: authHeaders(userBToken),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    expect(res.status).toBe(404);
  });

  it.each([
    ["GET", "/v1/diagnosis/incidents/:incidentId", undefined],
    ["GET", "/v1/learning/incidents/:incidentId", undefined],
    ["GET", "/v1/diagnosis/incidents/:incidentId/diagnosis", undefined],
    ["GET", "/v1/learning/incidents/:incidentId/diagnosis", undefined],
    ["POST", "/v1/diagnosis/incidents/:incidentId/manual-resolve", {
      title: "Cross-user proof resolve",
      cause: "Phase 21B denial test",
      fix: "Owner-scoped incident routes deny this request.",
      verificationSummary: "A non-owner cannot resolve another user's incident.",
    }],
  ] as const)("denies non-owner %s %s", async (method, template, body) => {
    const path = template.replace(":incidentId", incidentId);
    const res = await fetch(`${env.baseUrl}${path}`, {
      method,
      headers: authHeaders(userBToken),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    expect(res.status).toBe(404);
  });
});
