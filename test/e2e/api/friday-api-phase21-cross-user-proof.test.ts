import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FridayApiTestEnv } from "./_helpers/friday-api-test-server.helper.js";
import {
  authHeaders,
  createFridayApiTestEnv,
  createTokenWithScopes,
  loginTestUser,
} from "./_helpers/friday-api-test-server.helper.js";

const runKnownVulnerabilityProof = process.env.FRIDAY_PHASE21A_ASSERT_KNOWN_VULN === "1";

/**
 * Phase 21A proof fixture.
 *
 * This intentionally asserts the current vulnerable behavior on
 * origin/main@b8b9c19 before Phase 21B fixes it. Default CI skips it so the
 * audit fixture does not lock the bug in place after 21B closes the route.
 */
describe.skipIf(!runKnownVulnerabilityProof)("Phase 21A cross-user self-healing route proof", () => {
  let env: FridayApiTestEnv;
  let userAToken: string;
  let userBToken: string;

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
  });

  afterAll(async () => {
    await env.close();
  });

  it("proves a non-owner can read another user's auto-fix action by actionId on the current baseline", async () => {
    const actionsRes = await fetch(`${env.baseUrl}/v1/auto-fix/actions`, {
      headers: authHeaders(userAToken),
    });
    expect(actionsRes.status).toBe(200);
    const actions = await actionsRes.json() as {
      ok: true;
      data: { items: Array<{ summary: { actionId: string } }> };
    };
    const actionId = actions.data.items[0]?.summary.actionId;
    expect(actionId).toBeTruthy();

    const nonOwnerRes = await fetch(`${env.baseUrl}/v1/auto-fix/actions/${actionId!}`, {
      headers: authHeaders(userBToken),
    });

    expect(nonOwnerRes.status).toBe(200);
  });

  it("proves a non-owner can read and manual-resolve another user's diagnosis incident by incidentId on the current baseline", async () => {
    const incidentsRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents`, {
      headers: authHeaders(userAToken),
    });
    expect(incidentsRes.status).toBe(200);
    const incidents = await incidentsRes.json() as {
      ok: true;
      data: { items: Array<{ incident: { incidentId: string } }> };
    };
    const incidentId = incidents.data.items[0]?.incident.incidentId;
    expect(incidentId).toBeTruthy();

    const nonOwnerReadRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents/${incidentId!}`, {
      headers: authHeaders(userBToken),
    });
    expect(nonOwnerReadRes.status).toBe(200);

    const nonOwnerResolveRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents/${incidentId!}/manual-resolve`, {
      method: "POST",
      headers: authHeaders(userBToken),
      body: JSON.stringify({
        title: "Cross-user proof resolve",
        cause: "Phase 21A proves the current route is not owner-scoped.",
        fix: "Phase 21B must bind incident lookups to the current user.",
        verificationSummary: "This request should be denied after Phase 21B.",
      }),
    });
    expect(nonOwnerResolveRes.status).toBe(200);
  });
});
