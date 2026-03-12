import { describe, it, expect } from "vitest";

import type {
  FridayGeneratedSkillDraft,
  FridayGeneratedSkillFile,
  FridayGeneratedSkillValidationIssue,
  FridayGeneratedSkillValidationReport,
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
  FridaySkillGenerationTurnMode,
  FridaySkillGenerationTurnRequest,
  FridaySkillGenerationTurnResponse,
  FridaySkillGeneratorSessionStatus,
  FridayStartSkillGenerationRequest,
} from "#skills/generator";

describe("FridaySkillGenerator types", () => {
  it("FridaySkillGeneratorSessionStatus covers all states", () => {
    const statuses: FridaySkillGeneratorSessionStatus[] = [
      "collecting_requirements",
      "needs_clarification",
      "generating",
      "ready_for_review",
      "approved",
      "saved",
      "failed",
      "cancelled",
    ];
    expect(statuses).toHaveLength(8);
  });

  it("FridaySkillGenerationSession is structurally valid", () => {
    const session: FridaySkillGenerationSession = {
      sessionId: "s-001",
      userId: "user-1",
      channel: "discord",
      status: "collecting_requirements",
      goal: "Build a timer skill",
      specSummary: "",
      openQuestions: [],
      decisions: [],
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(session.sessionId).toBe("s-001");
    expect(session.draftSkillId).toBeUndefined();
  });

  it("FridaySkillGenerationTurn is structurally valid", () => {
    const turn: FridaySkillGenerationTurn = {
      turnId: "t-001",
      sessionId: "s-001",
      role: "user",
      content: "I want a timer",
      createdAt: "2025-01-01T00:00:00Z",
    };
    expect(turn.role).toBe("user");
  });

  it("FridayStartSkillGenerationRequest is structurally valid", () => {
    const req: FridayStartSkillGenerationRequest = {
      goal: "Build a timer skill",
      userId: "user-1",
      channel: "discord",
    };
    expect(req.requestedModel).toBeUndefined();
  });

  it("FridaySkillGenerationTurnRequest is structurally valid", () => {
    const req: FridaySkillGenerationTurnRequest = {
      message: "Use 30 second intervals",
    };
    expect(req.message).toBe("Use 30 second intervals");
  });

  it("FridaySkillGenerationTurnMode covers all modes", () => {
    const modes: FridaySkillGenerationTurnMode[] = [
      "clarification_required",
      "preview_ready",
      "generation_failed",
    ];
    expect(modes).toHaveLength(3);
  });

  it("FridayGeneratedSkillFile is structurally valid", () => {
    const file: FridayGeneratedSkillFile = {
      path: "index.mjs",
      language: "javascript",
      content: "export async function execute() {}",
    };
    expect(file.executable).toBeUndefined();
  });

  it("FridayGeneratedSkillValidationIssue is structurally valid", () => {
    const issue: FridayGeneratedSkillValidationIssue = {
      code: "PATH_TRAVERSAL",
      severity: "error",
      message: "Path traversal detected",
      path: "../etc/passwd",
    };
    expect(issue.severity).toBe("error");
  });

  it("FridayGeneratedSkillValidationReport is structurally valid", () => {
    const report: FridayGeneratedSkillValidationReport = {
      ok: true,
      issues: [],
      repaired: false,
      repairAttempts: 0,
    };
    expect(report.ok).toBe(true);
  });

  it("FridayGeneratedSkillDraft references all expected fields", () => {
    const draft: FridayGeneratedSkillDraft = {
      manifest: {
        schemaVersion: "2.0",
        id: "test-skill",
        name: "Test",
        description: "A test skill",
        version: "1.0.0",
        kind: "automation",
        category: "utility",
        author: { name: "Test" },
        tags: [],
        runtime: {
          kind: "node",
          entrypoint: "index.mjs",
          minHubVersion: "0.1.0",
          apiVersion: "1",
          timeoutMsDefault: 30000,
        },
        triggers: { intents: [], phrases: [], channels: [] },
        invocation: {
          userInvocable: true,
          modelInvocable: true,
          priority: 50,
          modes: ["intent"],
        },
        requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
        inputs: [],
        outputs: [],
        permissions: { grants: [], promptOn: [] },
        executionTargets: {
          allowedSatelliteTypes: [],
          requiredCapabilities: [],
        },
      },
      files: [],
      uiSchema: {
        schemaVersion: "1.0",
        title: "Test",
        sections: [],
        fields: [],
        outputs: [],
        actions: [{ id: "run", label: "Run", style: "primary" }],
      },
      runtimeKind: "node",
      validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
    };
    expect(draft.runtimeKind).toBe("node");
  });

  it("FridaySkillGenerationTurnResponse is structurally valid", () => {
    const resp: FridaySkillGenerationTurnResponse = {
      session: {
        sessionId: "s-001",
        userId: "user-1",
        channel: "discord",
        status: "needs_clarification",
        goal: "Build a timer",
        specSummary: "",
        openQuestions: ["How long?"],
        decisions: [],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      mode: "clarification_required",
      questions: ["How long?"],
    };
    expect(resp.mode).toBe("clarification_required");
    expect(resp.draft).toBeUndefined();
  });
});
