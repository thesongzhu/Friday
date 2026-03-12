import { describe, it, expect } from "vitest";

import type {
  FridayWorkflowGeneratorSessionStatus,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayStartWorkflowGenerationRequest,
  FridayWorkflowGenerationTurnRequest,
  FridayWorkflowGenerationTurnMode,
  FridayGeneratedWorkflowValidationStage,
  FridayGeneratedWorkflowValidationIssue,
  FridayGeneratedWorkflowValidationReport,
  FridayGeneratedWorkflowDraft,
  FridayWorkflowGenerationTurnResponse,
  FridayWorkflowGeneratorSkillContext,
  FridayWorkflowGenerationRequirements,
} from "#workflows";

// ─── Type-level structural tests ───

describe("FridayWorkflowGenerator types", () => {
  it("session status union covers all expected values", () => {
    const statuses: FridayWorkflowGeneratorSessionStatus[] = [
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

  it("turn mode union covers expected values", () => {
    const modes: FridayWorkflowGenerationTurnMode[] = [
      "clarification_required",
      "preview_ready",
      "generation_failed",
    ];
    expect(modes).toHaveLength(3);
  });

  it("validation stage union covers expected values", () => {
    const stages: FridayGeneratedWorkflowValidationStage[] = [
      "requirements",
      "spec",
      "visual",
      "tests",
      "compile",
      "graph",
      "skill_refs",
      "draft_consistency",
    ];
    expect(stages).toHaveLength(8);
  });

  it("session entity has required fields", () => {
    const session: FridayWorkflowGenerationSession = {
      sessionId: "s-1",
      userId: "u-1",
      channel: "test",
      status: "collecting_requirements",
      goal: "Build a workflow",
      requirementsSummary: "",
      openQuestions: [],
      decisions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(session.sessionId).toBe("s-1");
    expect(session.status).toBe("collecting_requirements");
  });

  it("turn entity has required fields", () => {
    const turn: FridayWorkflowGenerationTurn = {
      turnId: "t-1",
      sessionId: "s-1",
      role: "user",
      content: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(turn.role).toBe("user");
  });

  it("start request has required fields", () => {
    const req: FridayStartWorkflowGenerationRequest = {
      goal: "Build a workflow",
      userId: "u-1",
      channel: "test",
    };
    expect(req.goal).toBeTruthy();
  });

  it("turn request has required fields", () => {
    const req: FridayWorkflowGenerationTurnRequest = {
      message: "Use manual trigger",
    };
    expect(req.message).toBeTruthy();
  });

  it("validation issue has required fields", () => {
    const issue: FridayGeneratedWorkflowValidationIssue = {
      code: "SPEC_INVALID",
      stage: "spec",
      severity: "error",
      message: "Invalid spec",
    };
    expect(issue.severity).toBe("error");
  });

  it("validation report shape is correct", () => {
    const report: FridayGeneratedWorkflowValidationReport = {
      ok: true,
      issues: [],
      repaired: false,
      repairAttempts: 0,
    };
    expect(report.ok).toBe(true);
    expect(report.repairAttempts).toBe(0);
  });

  it("draft entity contains all required artifacts", () => {
    const draft: FridayGeneratedWorkflowDraft = {
      spec: {
        schemaVersion: "1.0",
        workflowId: "test-wf",
        name: "Test",
        description: "Test",
        startStepId: "s1",
        trigger: { type: "manual" },
        inputs: [],
        steps: [{ id: "s1", type: "transform" }],
        edges: [],
        outputs: [],
        errorPolicy: { onFailure: "fail_fast", notifyUser: false },
        tests: [],
      },
      visual: {
        schemaVersion: "1.0",
        workflowId: "test-wf",
        viewport: { x: 0, y: 0, zoom: 1 },
        panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
        nodes: [],
        edges: [],
      },
      tests: [],
      compiledGraph: {
        schemaVersion: "2.0",
        workflowId: "test-wf",
        workflowVersionId: "v-1",
        sourceSpecSchemaVersion: "1.0",
        graph: { nodes: [], edges: [] },
        failurePolicy: { onFailure: "fail_fast", notifyUser: false },
        tests: [],
        checksum: "abc123",
      },
      validation: {
        ok: true,
        issues: [],
        repaired: false,
        repairAttempts: 0,
      },
    };
    expect(draft.spec.schemaVersion).toBe("1.0");
    expect(draft.compiledGraph.schemaVersion).toBe("2.0");
  });

  it("turn response shape is correct", () => {
    const response: FridayWorkflowGenerationTurnResponse = {
      session: {
        sessionId: "s-1",
        userId: "u-1",
        channel: "test",
        status: "needs_clarification",
        goal: "Build a workflow",
        requirementsSummary: "",
        openQuestions: ["What trigger?"],
        decisions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      mode: "clarification_required",
      questions: ["What trigger?"],
    };
    expect(response.mode).toBe("clarification_required");
    expect(response.questions).toHaveLength(1);
  });

  it("skill context has expected shape", () => {
    const ctx: FridayWorkflowGeneratorSkillContext = {
      id: "skill-1",
      name: "My Skill",
      description: "Does stuff",
      inputs: [{ key: "query", type: "string", required: true }],
      outputs: [{ key: "result", type: "string" }],
    };
    expect(ctx.id).toBe("skill-1");
  });

  it("requirements entity has expected shape", () => {
    const reqs: FridayWorkflowGenerationRequirements = {
      goal: "Test",
      trigger: { type: "manual" },
      inputs: [],
      plannedSteps: [
        { id: "s1", intent: "do thing", nodeTypeHint: "action" },
      ],
      outputs: [],
      errorPolicy: { onFailure: "fail_fast", notifyUser: false },
      assumptions: ["User has API key"],
      testScenarios: [{ name: "happy path" }],
    };
    expect(reqs.plannedSteps).toHaveLength(1);
  });
});
