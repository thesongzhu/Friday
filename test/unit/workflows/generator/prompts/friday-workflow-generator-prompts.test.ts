import { describe, it, expect } from "vitest";

import {
  buildWorkflowRequirementsPrompt,
  buildWorkflowSpecPrompt,
  buildWorkflowVisualLayoutPrompt,
  buildWorkflowTestsPrompt,
} from "#workflows";

import type {
  FridayWorkflowGenerationTurn,
  FridayWorkflowGeneratorSkillContext,
  FridayWorkflowGenerationRequirements,
  FridayWorkflowSpecV1,
} from "#workflows";

// ─── Fixtures ───

function makeSkills(): FridayWorkflowGeneratorSkillContext[] {
  return [
    {
      id: "send-email",
      name: "Send Email",
      description: "Sends an email",
      inputs: [
        { key: "to", type: "string", required: true },
        { key: "body", type: "string", required: true },
      ],
      outputs: [{ key: "messageId", type: "string" }],
    },
  ];
}

function makeTurns(): FridayWorkflowGenerationTurn[] {
  return [
    { turnId: "t-1", sessionId: "s-1", role: "user", content: "Build an email workflow", createdAt: "2026-01-01T00:00:00.000Z" },
    { turnId: "t-2", sessionId: "s-1", role: "assistant", content: "What trigger?", createdAt: "2026-01-01T00:00:01.000Z" },
  ];
}

function makeRequirements(): FridayWorkflowGenerationRequirements {
  return {
    goal: "Send scheduled emails",
    trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    inputs: [{ key: "recipient", type: "string", required: true }],
    plannedSteps: [
      { id: "send", intent: "Send email", nodeTypeHint: "action", preferredSkillId: "send-email" },
    ],
    outputs: [{ key: "result", fromStep: "send", path: "messageId" }],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    assumptions: ["SMTP configured"],
    testScenarios: [{ name: "happy path" }],
  };
}

function makeSpec(): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "send-scheduled-emails",
    name: "Send Scheduled Emails",
    description: "Sends emails on schedule",
    startStepId: "send",
    trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    inputs: [{ key: "recipient", type: "string", required: true }],
    steps: [
      { id: "send", type: "skill_call", ref: "send-email", args: { to: "$inputs.recipient", body: "Hello" } },
    ],
    edges: [],
    outputs: [{ key: "result", fromStep: "send", path: "messageId" }],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [],
  };
}

// ─── Tests ───

describe("buildWorkflowRequirementsPrompt", () => {
  it("returns system and user strings", () => {
    const prompt = buildWorkflowRequirementsPrompt(
      "Build an email workflow",
      "",
      [],
      makeSkills(),
      makeTurns(),
    );
    expect(prompt.system).toBeTruthy();
    expect(prompt.user).toBeTruthy();
  });

  it("system prompt instructs JSON-only response", () => {
    const prompt = buildWorkflowRequirementsPrompt("test", "", [], [], []);
    expect(prompt.system).toContain("strict JSON only");
  });

  it("user prompt includes open questions", () => {
    const prompt = buildWorkflowRequirementsPrompt(
      "test",
      "",
      ["What trigger type?", "What inputs?"],
      [],
      [],
    );
    expect(prompt.user).toContain("What trigger type?");
    expect(prompt.user).toContain("What inputs?");
  });

  it("user prompt includes conversation turns", () => {
    const turns = makeTurns();
    const prompt = buildWorkflowRequirementsPrompt("test", "", [], [], turns);
    expect(prompt.user).toContain("[user]: Build an email workflow");
    expect(prompt.user).toContain("[assistant]: What trigger?");
  });

  it("user prompt includes available skills", () => {
    const prompt = buildWorkflowRequirementsPrompt(
      "test",
      "",
      [],
      makeSkills(),
      [],
    );
    expect(prompt.user).toContain("send-email");
    expect(prompt.user).toContain("Send Email");
  });
});

describe("buildWorkflowSpecPrompt", () => {
  it("returns system and user strings", () => {
    const prompt = buildWorkflowSpecPrompt(makeRequirements(), makeSkills());
    expect(prompt.system).toBeTruthy();
    expect(prompt.user).toBeTruthy();
  });

  it("system prompt enforces allowed step types", () => {
    const prompt = buildWorkflowSpecPrompt(makeRequirements(), []);
    expect(prompt.system).toContain("skill_call");
    expect(prompt.system).toContain("tool_call");
    expect(prompt.system).toContain("condition");
    expect(prompt.system).toContain("transform");
    expect(prompt.system).toContain("human_approval");
  });

  it("system prompt mentions Friday expression syntax", () => {
    const prompt = buildWorkflowSpecPrompt(makeRequirements(), []);
    expect(prompt.system).toContain("$inputs.");
    expect(prompt.system).toContain("$steps.");
  });

  it("includes repair context when provided", () => {
    const prompt = buildWorkflowSpecPrompt(makeRequirements(), [], {
      errors: "[SPEC_INVALID] Bad step",
      attempt: 1,
    });
    expect(prompt.user).toContain("Previous attempt (1) had errors");
    expect(prompt.user).toContain("[SPEC_INVALID] Bad step");
  });
});

describe("buildWorkflowVisualLayoutPrompt", () => {
  it("returns system and user strings", () => {
    const prompt = buildWorkflowVisualLayoutPrompt(makeSpec());
    expect(prompt.system).toBeTruthy();
    expect(prompt.user).toBeTruthy();
  });

  it("system prompt contains edgeKey rule", () => {
    const prompt = buildWorkflowVisualLayoutPrompt(makeSpec());
    expect(prompt.system).toContain("edgeKey");
    expect(prompt.system).toContain("${from}:${to}:${when");
  });

  it("user prompt includes spec JSON", () => {
    const prompt = buildWorkflowVisualLayoutPrompt(makeSpec());
    expect(prompt.user).toContain("send-scheduled-emails");
  });
});

describe("buildWorkflowTestsPrompt", () => {
  it("returns system and user strings", () => {
    const prompt = buildWorkflowTestsPrompt(makeSpec());
    expect(prompt.system).toBeTruthy();
    expect(prompt.user).toBeTruthy();
  });

  it("system prompt contains operator constraints", () => {
    const prompt = buildWorkflowTestsPrompt(makeSpec());
    expect(prompt.system).toContain("==");
    expect(prompt.system).toContain("!=");
    expect(prompt.system).toContain("contains");
    expect(prompt.system).toContain("matches");
  });

  it("system prompt contains path constraints", () => {
    const prompt = buildWorkflowTestsPrompt(makeSpec());
    expect(prompt.system).toContain("inputs.<key>");
    expect(prompt.system).toContain("steps.<stepId>.output.<key>");
    expect(prompt.system).toContain("outputs.<key>");
  });

  it("user prompt includes spec JSON", () => {
    const prompt = buildWorkflowTestsPrompt(makeSpec());
    expect(prompt.user).toContain("send-scheduled-emails");
  });
});
