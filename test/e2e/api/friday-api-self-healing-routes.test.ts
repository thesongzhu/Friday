import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridayApiTestEnv } from "./_helpers/friday-api-test-server.helper.js";
import {
  authHeaders,
  createFridayApiTestEnv,
  loginTestUser,
} from "./_helpers/friday-api-test-server.helper.js";

const NOW = "2026-03-07T10:00:00.000Z";

function createStubSkillGeneratorService(): FridaySkillGeneratorService {
  return {
    async startSession(input) {
      return {
        session: {
          sessionId: "assistant-skill-session",
          userId: input.userId,
          channel: input.channel,
          status: "needs_clarification",
          goal: input.goal,
          specSummary: "",
          openQuestions: ["What should the output look like?"],
          decisions: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
        mode: "clarification_required",
        questions: ["What should the output look like?"],
      };
    },
    async submitTurn(sessionId) {
      return {
        session: {
          sessionId,
          userId: "test-user",
          channel: "assistant",
          status: "needs_clarification",
          goal: "Build a skill",
          specSummary: "",
          openQuestions: ["What should the output look like?"],
          decisions: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
        mode: "clarification_required",
        questions: ["What should the output look like?"],
      };
    },
    async getSession() {
      return null;
    },
    async generateDraft() {
      return {} as never;
    },
    async approveAndSave() {
      return {
        sessionId: "assistant-skill-session",
        skillId: "assistant-skill",
        skillDir: "/tmp/assistant-skill",
        savedFiles: [],
        registryRefreshed: false,
      };
    },
    async cancelSession() {
      return;
    },
  };
}

describe("API — Self-healing and assistant routes", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv({
      enableSelfHealing: true,
      skillGenerator: createStubSkillGeneratorService(),
    });
    const login = await loginTestUser(env.baseUrl);
    token = login.accessToken;

    env.selfHealingService!.reportStructuredFailure({
      userId: "test-user",
      category: "workflow",
      severity: "high",
      message: "repeated-skill-failure",
    });
    env.selfHealingService!.reportStructuredFailure({
      userId: "test-user",
      category: "workflow",
      severity: "high",
      message: "repeated-skill-failure",
    });
  });

  afterAll(async () => {
    await env.close();
  });

  it("lists diagnosis incidents and planned fixes over the real HTTP stack", async () => {
    const incidentRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents`, {
      headers: authHeaders(token),
    });
    expect(incidentRes.status).toBe(200);

    const incidents = (await incidentRes.json()) as {
      ok: true;
      data: {
        items: Array<{ incident: { incidentId: string }; summary: { autoFixEligible: boolean } }>;
      };
    };
    expect(incidents.data.items.length).toBeGreaterThan(0);
    expect(incidents.data.items.some((item) => item.summary.autoFixEligible)).toBe(true);

    const actionsRes = await fetch(`${env.baseUrl}/v1/auto-fix/actions`, {
      headers: authHeaders(token),
    });
    expect(actionsRes.status).toBe(200);

    const actions = (await actionsRes.json()) as {
      ok: true;
      data: {
        items: Array<{ summary: { incidentId: string; status: string } }>;
      };
    };
    expect(actions.data.items.length).toBeGreaterThan(0);
    expect(actions.data.items[0]?.summary.status).toBe("planned");
  });

  it("allows an operator to manually resolve an incident over the real HTTP stack", async () => {
    const incidentRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents`, {
      headers: authHeaders(token),
    });
    expect(incidentRes.status).toBe(200);
    const incidents = (await incidentRes.json()) as {
      ok: true;
      data: {
        items: Array<{ incident: { incidentId: string } }>;
      };
    };
    const incidentId = incidents.data.items[0]?.incident.incidentId;
    expect(incidentId).toBeTruthy();

    const resolveRes = await fetch(`${env.baseUrl}/v1/diagnosis/incidents/${incidentId!}/manual-resolve`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        title: "Manual stabilization",
        cause: "The config patch had to be applied by hand",
        fix: "Patched the missing config and reran the workflow",
        verificationSummary: "The next workflow run completed successfully",
      }),
    });
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as {
      ok: true;
      data: {
        incident: { status: string };
        summary: { matchedLessonIds: string[] };
      };
    };
    expect(resolved.data.incident.status).toBe("resolved");
    expect(resolved.data.summary.matchedLessonIds).toEqual([]);
    const lessonCount = env.db.withReadConnection((db) => {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM learned_lessons",
      ).get() as { count: number };
      return row.count;
    });
    expect(lessonCount).toBeGreaterThan(0);
  });

  it("serves beginner assistant intent, templates, and issue inbox routes", async () => {
    const intentRes = await fetch(`${env.baseUrl}/v1/uix/intents/resolve`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ text: "Generate a git summary skill" }),
    });
    expect(intentRes.status).toBe(200);
    const intentJson = (await intentRes.json()) as {
      ok: true;
      data: { routeTarget: string; suggestedTemplateIds: string[] };
    };
    expect(intentJson.data.routeTarget).toBe("/assistant");
    expect(intentJson.data.suggestedTemplateIds).toContain("generate-skill");

    const templatesRes = await fetch(`${env.baseUrl}/v1/uix/templates`, {
      headers: authHeaders(token),
    });
    expect(templatesRes.status).toBe(200);
    const templatesJson = (await templatesRes.json()) as {
      ok: true;
      data: { templates: Array<{ id: string }> };
    };
    expect(templatesJson.data.templates.map((item) => item.id)).toContain("generate-skill");

    const issuesRes = await fetch(`${env.baseUrl}/v1/uix/issues`, {
      headers: authHeaders(token),
    });
    expect(issuesRes.status).toBe(200);
    const issuesJson = (await issuesRes.json()) as {
      ok: true;
      data: { items: Array<{ routeTarget: string }> };
    };
    expect(issuesJson.data.items.length).toBeGreaterThan(0);
    expect(issuesJson.data.items[0]?.routeTarget).toBe("/assistant");
  });
});
